/**
 * flow.ts: the operations that move a session along, shared by the browser API and
 * the interviewer's tools.
 *
 * Each operation updates the session on disk, appends to its event log, pushes the
 * change to the page over SSE, and tells the host about candidate activity. Routes
 * and tools stay thin: they validate input and call one function here.
 */

import { renderMarkdown } from "./markdown.ts";
import { pythonAdapter } from "./runner/adapters/python/adapter.ts";
import type { CandidateRunResult } from "./runner/sanitize.ts";
import type { CaseResult } from "./runner/types.ts";
import { runCode } from "./runs.ts";
import { emitCandidateEvent } from "./server/hooks.ts";
import { push, sessionChannel } from "./server/sse.ts";
import { readConfig, type Config } from "./store/config.ts";
import { publicView, readProblem, type Hint, type PublicProblem } from "./store/problems.ts";
import {
  appendEvent,
  readDraft,
  readEvents,
  readSession,
  recordSubmission,
  updateSession,
  type Session,
  type SessionEvent,
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

export function remaining(session: Session, now: number): number | null {
  if (session.startedAt === undefined) return null;
  const end = session.endedAt ?? now;
  return Math.max(0, session.startedAt + session.timerMs - end);
}

// ── Candidate actions ─────────────────────────────────────────────────────────

export function startSession(id: string, now = Date.now()): Session {
  const session = updateSession(id, (s) => {
    if (s.phase === "done") throw new FlowError(409, "This session is finished");
    if (s.startedAt !== undefined) return;
    s.startedAt = now;
    s.phase = "coding";
  });
  if (session.startedAt === now) {
    appendEvent(id, { type: "started", at: now });
    pushPhase(session);
    emitCandidateEvent({ kind: "started", sessionId: id, at: now });
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireCoding(id: string): Session {
  const session = readSession(id);
  if (session.phase === "briefing") throw new FlowError(409, "Press Start before running code");
  if (session.phase === "done") throw new FlowError(409, "This session is finished");
  return session;
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
