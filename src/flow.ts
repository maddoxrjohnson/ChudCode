/**
 * flow.ts: the operations that move a session along, shared by the browser API and
 * the interviewer's tools.
 *
 * Each operation updates the session on disk, appends to its event log, pushes the
 * change to the page over SSE, and tells the host about candidate activity. Routes
 * and tools stay thin: they validate input and call one function here.
 */

import { renderMarkdown } from "./markdown.ts";
import { makeKey, relativeDay, type ReviewEvent } from "./review.ts";
import { pythonAdapter } from "./runner/adapters/python/adapter.ts";
import type { CandidateRunResult } from "./runner/sanitize.ts";
import type { CaseResult } from "./runner/types.ts";
import { runCode, type RunOutcome, type RunScope } from "./runs.ts";
import { emitCandidateEvent } from "./server/hooks.ts";
import { DASHBOARD_CHANNEL, push, sessionChannel } from "./server/sse.ts";
import { readConfig, type Config } from "./store/config.ts";
import { publicView, readProblem, type Hint, type PublicProblem } from "./store/problems.ts";
import { appendReviewEvents, reviewItems, rewriteReviewEvents } from "./store/review-events.ts";
import { eventsFromLessons, listLessons } from "./store/lessons.ts";
import {
  appendEvent,
  listSessions,
  readDraft,
  readEvents,
  readSession,
  recordSubmission,
  updateSession,
  type Rubric,
  type Session,
  type SessionEvent,
  type Verdict,
} from "./store/sessions.ts";

export class FlowError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FlowError";
    this.status = status;
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  at: number;
  from: "interviewer" | "candidate";
  html: string;
}

export interface SessionState {
  session: Session;
  problem: PublicProblem;
  draft: string;
  messages: ChatMessage[];
  hints: Hint[];
  /** Milliseconds left on the timer, or null before it starts. */
  remainingMs: number | null;
  listening: boolean;
}

export function sessionState(id: string, listening = false, now = Date.now()): SessionState {
  const session = readSession(id);
  const bundle = readProblem(session.problem);
  const revealed = Math.max(0, ...session.hintsUsed);
  const problem = publicView(bundle, revealed);
  const draft = readDraft(id) ?? pythonAdapter.stub(bundle.meta.signature);
  const messages = readEvents(id)
    .filter((e): e is Extract<SessionEvent, { type: "message" }> => e.type === "message")
    .map((e) => ({ at: e.at, from: e.from, html: e.html }));
  return {
    session,
    problem,
    draft,
    messages,
    hints: problem.hints,
    remainingMs: remaining(session, now),
    listening,
  };
}

/** Milliseconds left on a clock, for an interview or a lesson. */
export function remaining(
  session: Pick<Session, "startedAt" | "endedAt" | "timerMs">,
  now: number,
): number | null {
  if (session.startedAt === undefined) return null;
  const end = session.endedAt ?? now;
  return Math.max(0, session.startedAt + session.timerMs - end);
}

// ── Candidate actions ─────────────────────────────────────────────────────────

export function startSession(
  id: string,
  now = Date.now(),
  by: "candidate" | "interviewer" = "candidate",
): Session {
  const session = updateSession(id, (s) => {
    if (s.phase === "done") throw new FlowError(409, "This session is finished");
    if (s.startedAt !== undefined) return;
    s.startedAt = now;
    s.phase = "coding";
  });
  if (session.startedAt === now) {
    appendEvent(id, { type: "started", at: now });
    pushPhase(session);
    notifyDashboard(id);
    // Only a candidate's own press is news to the interviewer.
    if (by === "candidate") emitCandidateEvent({ kind: "started", sessionId: id, at: now });
  }
  return session;
}

export function postApproachNote(id: string, text: string, now = Date.now()): Session {
  const trimmed = text.trim();
  if (!trimmed) throw new FlowError(400, "Write a sentence or two about your approach");
  const session = updateSession(id, (s) => {
    if (s.phase === "done") throw new FlowError(409, "This session is finished");
    s.approachNote = trimmed;
  });
  appendEvent(id, { type: "note", text: trimmed, at: now });
  push(sessionChannel(id), "note", { text: trimmed, at: now });
  emitCandidateEvent({ kind: "note", sessionId: id, text: trimmed, at: now });
  return session;
}

export function postMessage(
  id: string,
  from: "interviewer" | "candidate",
  markdown: string,
  now = Date.now(),
): ChatMessage {
  const trimmed = markdown.trim();
  if (!trimmed) throw new FlowError(400, "The message is empty");
  const session = readSession(id);
  if (session.phase === "done" && from === "candidate") {
    throw new FlowError(409, "This session is finished");
  }
  const html = renderMarkdown(trimmed);
  const message: ChatMessage = { at: now, from, html };
  appendEvent(id, { type: "message", from, markdown: trimmed, html, at: now });
  push(sessionChannel(id), "message", message);
  if (from === "candidate")
    emitCandidateEvent({ kind: "message", sessionId: id, text: trimmed, at: now });
  return message;
}

export interface HintReveal {
  hint: Hint;
  remaining: number;
}

/** Reveal the next hint (or a specific level) and record that it was used. */
export function revealHint(id: string, level?: number, now = Date.now()): HintReveal {
  const session = readSession(id);
  if (session.phase === "done") throw new FlowError(409, "This session is finished");
  const bundle = readProblem(session.problem);
  const used = Math.max(0, ...session.hintsUsed);
  const target = level ?? used + 1;
  const hint = bundle.hints.find((h) => h.level === target);
  if (!hint)
    throw new FlowError(
      404,
      target > bundle.hints.length ? "There are no more hints" : "No such hint",
    );

  if (!session.hintsUsed.includes(target)) {
    updateSession(id, (s) => {
      s.hintsUsed.push(target);
      s.hintsUsed.sort((a, b) => a - b);
    });
    appendEvent(id, { type: "hint", level: target, text: hint.text, at: now });
    emitCandidateEvent({ kind: "hint_used", sessionId: id, level: target, at: now });
  }
  const remainingHints = bundle.hints.length - Math.max(target, used);
  push(sessionChannel(id), "hint", { hint, remaining: remainingHints });
  return { hint, remaining: remainingHints };
}

export interface RunOutput {
  runId: string;
  candidate: CandidateRunResult;
}

export async function runVisible(
  id: string,
  code: string,
  custom?: Array<Record<string, unknown>>,
  config: Config = readConfig(),
): Promise<RunOutput> {
  const session = requireCoding(id);
  const bundle = readProblem(session.problem);
  const kind = custom ? "custom" : "visible";
  const runId = newRunId();
  const outcome = await runCode({
    bundle,
    code,
    scope: custom ? { custom } : "visible",
    limits: config.limits.run,
    revealFailingInput: true,
    onCase: (result) => pushPartial(id, runId, kind, result),
  });
  const { result, candidate } = outcome;
  appendEvent(id, {
    type: "run",
    kind,
    status: result.status,
    passed: result.passed,
    total: result.total,
    at: Date.now(),
  });
  push(sessionChannel(id), "run", { runId, kind, result: candidate });
  emitCandidateEvent({
    kind: "run",
    sessionId: id,
    scope: kind,
    status: result.status,
    passed: result.passed,
    total: result.total,
    at: Date.now(),
  });
  return { runId, candidate };
}

export async function submitCode(
  id: string,
  code: string,
  config: Config = readConfig(),
): Promise<RunOutput & { number: number }> {
  const session = requireCoding(id);
  const bundle = readProblem(session.problem);
  const runId = newRunId();
  const outcome = await runCode({
    bundle,
    code,
    scope: "all",
    limits: config.limits.submit,
    revealFailingInput: bundle.meta.revealFailingInput ?? config.revealFailingInput,
    onCase: (result) => pushPartial(id, runId, "hidden", result),
  });
  const { result, candidate } = outcome;
  const number = recordSubmission(id, code, result);
  const now = Date.now();
  appendEvent(id, {
    type: "submit",
    number,
    status: result.status,
    passed: result.passed,
    total: result.total,
    at: now,
  });
  push(sessionChannel(id), "run", { runId, kind: "hidden", number, result: candidate });
  emitCandidateEvent({ kind: "submission", sessionId: id, number, result, at: now });
  return { runId, candidate, number };
}

export function timerExpired(id: string, now = Date.now()): Session {
  let changed = false;
  const session = updateSession(id, (s) => {
    if (s.phase !== "coding") return;
    s.phase = "review";
    s.endedAt = now;
    changed = true;
  });
  if (changed) {
    appendEvent(id, { type: "timeout", at: now });
    pushPhase(session);
    emitCandidateEvent({ kind: "timer_expired", sessionId: id, at: now });
  }
  return session;
}

export function candidateDone(id: string, now = Date.now()): Session {
  let changed = false;
  const session = updateSession(id, (s) => {
    if (s.phase === "done") throw new FlowError(409, "This session is finished");
    if (s.phase === "review") return;
    if (s.startedAt === undefined) s.startedAt = now;
    s.phase = "review";
    s.endedAt = now;
    changed = true;
  });
  if (changed) {
    appendEvent(id, { type: "done", at: now });
    pushPhase(session);
    emitCandidateEvent({ kind: "candidate_done", sessionId: id, at: now });
  }
  return session;
}

// ── Interviewer actions ───────────────────────────────────────────────────────

/** Run the candidate's current draft on the interviewer's behalf. */
export async function interviewerRun(
  id: string,
  scope: RunScope,
  showCandidate: boolean,
  config: Config = readConfig(),
): Promise<RunOutcome & { code: string }> {
  const session = readSession(id);
  if (session.phase === "done") throw new FlowError(409, "This session is finished");
  const bundle = readProblem(session.problem);
  const code = readDraft(id) ?? pythonAdapter.stub(bundle.meta.signature);
  const outcome = await runCode({
    bundle,
    code,
    scope,
    limits: scope === "all" ? config.limits.submit : config.limits.run,
    revealFailingInput: bundle.meta.revealFailingInput ?? config.revealFailingInput,
  });
  const { result } = outcome;
  appendEvent(id, {
    type: "run",
    kind: "interviewer",
    status: result.status,
    passed: result.passed,
    total: result.total,
    at: Date.now(),
  });
  if (showCandidate)
    push(sessionChannel(id), "run", {
      runId: newRunId(),
      kind: "interviewer",
      result: outcome.candidate,
    });
  return { ...outcome, code };
}

export interface RubricScores {
  correctness: number;
  communication: number;
  complexity: number;
  codeQuality: number;
  time: number;
}

export interface RecordInput {
  rubric: RubricScores;
  complexityOk: boolean;
  notesMd: string;
  strengths: string[];
  improvements: string[];
}

export interface RecordOutcome {
  session: Session;
  reviewEvents: ReviewEvent[];
  /** One line per pattern saying when it comes back for review. */
  nextDue: string[];
}

/**
 * Score the session, decide the verdict, and schedule its patterns for review.
 *
 * The verdict is mechanical where it can be: all hidden tests passed on the last
 * submission, and the clock had not run out when the candidate finished. Whether the
 * complexity met the target is the interviewer's call.
 */
export function recordSession(id: string, input: RecordInput, now = Date.now()): RecordOutcome {
  const before = readSession(id);
  if (before.phase === "done") throw new FlowError(409, "This session is already recorded");
  for (const [key, value] of Object.entries(input.rubric)) {
    if (!Number.isInteger(value) || value < 0 || value > 4) {
      throw new FlowError(400, `rubric.${key} must be an integer from 0 to 4`);
    }
  }

  const endedAt = before.endedAt ?? now;
  const last = before.lastResult;
  const allPassed =
    last !== undefined && last.status === "ok" && last.passed === last.total && last.total > 0;
  const withinTime = before.startedAt !== undefined && endedAt - before.startedAt <= before.timerMs;
  const verdict: Verdict = {
    correct: allPassed && withinTime && input.complexityOk,
    allPassed,
    withinTime,
    complexityOk: input.complexityOk,
  };
  const rubric: Rubric = {
    ...input.rubric,
    notesMd: input.notesMd,
    strengths: input.strengths,
    improvements: input.improvements,
  };

  const session = updateSession(id, (s) => {
    s.phase = "done";
    s.endedAt = endedAt;
    s.rubric = rubric;
    s.verdict = verdict;
  });
  appendEvent(id, { type: "rubric", at: now });

  const reviewEvents = reviewEventsFor(session, verdict.correct, now);
  appendReviewEvents(reviewEvents);
  const nextDue = nextDueLines(session, now);

  push(sessionChannel(id), "rubric", {
    rubric,
    verdict,
    notesHtml: renderMarkdown(input.notesMd),
    nextDue: nextDue.join(" "),
  });
  pushPhase(session);
  notifyDashboard(id);
  return { session, reviewEvents, nextDue };
}

/**
 * End a session without a debrief. Counts as a miss for its patterns unless the
 * reason is `interrupted`, which means the session did not reflect the candidate.
 */
export function abandonSession(id: string, reason: string, now = Date.now()): RecordOutcome {
  const before = readSession(id);
  if (before.phase === "done") throw new FlowError(409, "This session is already finished");
  const trimmed = reason.trim() || "abandoned";
  const session = updateSession(id, (s) => {
    s.phase = "done";
    s.endedAt = s.endedAt ?? now;
    s.abandonedReason = trimmed;
  });
  appendEvent(id, { type: "abandoned", reason: trimmed, at: now });
  const reviewEvents = trimmed === "interrupted" ? [] : reviewEventsFor(session, false, now);
  appendReviewEvents(reviewEvents);
  pushPhase(session);
  notifyDashboard(id);
  return { session, reviewEvents, nextDue: reviewEvents.length ? nextDueLines(session, now) : [] };
}

/** One review event per key the session exercised: each of its patterns and the problem. */
export function reviewEventsFor(session: Session, correct: boolean, now: number): ReviewEvent[] {
  const keys = [
    ...session.patterns.map((p) => makeKey("pattern", p)),
    makeKey("problem", session.problem),
  ];
  return keys.map((key) => {
    const event: ReviewEvent = {
      key,
      at: now,
      correct,
      session: session.id,
      difficulty: session.difficulty,
      hintsUsed: session.hintsUsed.length,
    };
    if (session.startedAt !== undefined && session.endedAt !== undefined) {
      event.timeMs = session.endedAt - session.startedAt;
    }
    return event;
  });
}

/**
 * The review events a finished session implies: its verdict when it was recorded, a
 * miss when it was abandoned for a reason that counts. Sessions still in progress
 * and interrupted ones imply nothing. Stamped with the session's end time, so a
 * rebuilt log reproduces the schedule and the streak.
 */
export function eventsFromSessions(sessions: readonly Session[]): ReviewEvent[] {
  const events: ReviewEvent[] = [];
  for (const session of sessions) {
    const at = session.endedAt ?? session.createdAt;
    if (session.verdict) events.push(...reviewEventsFor(session, session.verdict.correct, at));
    else if (session.abandonedReason !== undefined && session.abandonedReason !== "interrupted")
      events.push(...reviewEventsFor(session, false, at));
  }
  return events.sort((a, b) => a.at - b.at);
}

/** Every review event the interviews and lessons on disk imply, oldest first. */
export function eventsFromDisk(): ReviewEvent[] {
  return [
    ...eventsFromSessions(listSessions(Number.MAX_SAFE_INTEGER)),
    ...eventsFromLessons(listLessons(Number.MAX_SAFE_INTEGER)),
  ].sort((a, b) => a.at - b.at);
}

/** Regenerate review/events.jsonl from the sessions and lessons on disk. Returns the new log. */
export function rebuildReviewLog(): ReviewEvent[] {
  const events = eventsFromDisk();
  rewriteReviewEvents(events);
  return events;
}

function nextDueLines(session: Session, now: number): string[] {
  const items = reviewItems();
  return session.patterns.flatMap((pattern) => {
    const item = items.find((i) => i.key === makeKey("pattern", pattern));
    return item
      ? [`${pattern} comes back for review ${relativeDay(item.dueAt, now)} (box ${item.box}).`]
      : [];
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireCoding(id: string): Session {
  const session = readSession(id);
  if (session.phase === "briefing") throw new FlowError(409, "Press Start before running code");
  if (session.phase === "done") throw new FlowError(409, "This session is finished");
  return session;
}

/** An open dashboard reloads when a session starts, is scored, or is created. */
export function notifyDashboard(sessionId: string): void {
  push(DASHBOARD_CHANNEL, "reload", { sessionId });
}

function pushPhase(session: Session): void {
  const payload: {
    phase: Session["phase"];
    startedAt?: number;
    endedAt?: number;
    timerMs: number;
  } = {
    phase: session.phase,
    timerMs: session.timerMs,
  };
  if (session.startedAt !== undefined) payload.startedAt = session.startedAt;
  if (session.endedAt !== undefined) payload.endedAt = session.endedAt;
  push(sessionChannel(session.id), "phase", payload);
}

function pushPartial(id: string, runId: string, kind: string, result: CaseResult): void {
  push(sessionChannel(id), "run", {
    runId,
    kind,
    partial: { id: result.id, status: result.status, timeMs: result.timeMs },
  });
}

let runCounter = 0;
function newRunId(): string {
  runCounter += 1;
  return `${Date.now().toString(36)}-${runCounter}`;
}
