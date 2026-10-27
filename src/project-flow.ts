/**
 * project-flow.ts: the operations that move a project session along, shared by the
 * browser API and the interviewer's tools.
 *
 * The shape follows phone-flow.ts: update the session on disk, append to its event
 * log, push the change to the page, and tell the host. What differs is the work: the
 * candidate edits a repository in their workspace, Run runs its visible tests, and
 * Submit runs them with the hidden ones on a copy whose read-only files are checked
 * first. Every run reads the workspace back through project-workspace.ts's guards.
 *
 * In an online-assessment session (`oa`) nobody answers until the end, as on the
 * real thing: the page hides the chat and the hints while the clock runs.
 */

import {
  changedProtected,
  diffRepositories,
  readProjectWorkspace,
  readWorkspaceFile,
  workspaceTree,
  writeWorkspaceFile,
  type TreeEntry,
} from "./drill/project-workspace.ts";
import { WorkspaceError } from "./drill/workspace.ts";
import { FlowError, notifyDashboard, remaining, type ChatMessage } from "./flow.ts";
import { renderMarkdown } from "./markdown.ts";
import { relativeDay, type ReviewEvent } from "./review.ts";
import { ensureDjangoEnv } from "./runner/django-env.ts";
import {
  processRunner,
  type ProjectRunRequest,
  type SuiteResult,
} from "./runner/process-runner.ts";
import type { Limits, RunStatus } from "./runner/types.ts";
import { emitCandidateEvent } from "./server/hooks.ts";
import { push, sessionChannel } from "./server/sse.ts";
import type { Hint } from "./store/problems.ts";
import {
  appendProjectEvent,
  bugsFixed,
  hiddenTestFiles,
  PROJECT_DIMENSIONS,
  projectReviewEvents,
  protectedPaths,
  readProject,
  readProjectEvents,
  readProjectSession,
  readSubmission,
  startingRepository,
  updateProjectSession,
  writeSubmission,
  type ProjectBundle,
  type ProjectDimension,
  type ProjectResult,
  type ProjectRubric,
  type ProjectSession,
  type StoredSubmission,
} from "./store/projects.ts";
import { appendReviewEvents, reviewItems } from "./store/review-events.ts";

/** A Django suite with its database setup takes seconds, not milliseconds. */
export const PROJECT_RUN_LIMITS: Limits = {
  wallMs: 120_000,
  cpuSeconds: 90,
  memoryMb: 2048,
  outputKb: 512,
  fileSizeKb: 50 * 1024,
  perCaseMs: 0,
};

export type ProjectRun = (request: ProjectRunRequest) => Promise<SuiteResult>;

/** How runs happen; tests swap in a fake. Always the process runner: Docker has no Django. */
export interface ProjectRunner {
  run: ProjectRun;
  python: () => Promise<string>;
}

export const defaultProjectRunner: ProjectRunner = {
  run: (request) => processRunner.runProject(request),
  python: ensureDjangoEnv,
};

// ── State ─────────────────────────────────────────────────────────────────────

/** One test as the candidate may see it. Hidden tests carry no name or message. */
export interface CandidateTest {
  id: string;
  label: string;
  hidden: boolean;
  status: string;
  message?: string;
}

export interface CandidateProjectResult {
  kind: "visible" | "submit";
  status: ProjectResult["status"];
  passed: number;
  total: number;
  tests: CandidateTest[];
  /** Why nothing ran, when the project did not import. */
  error?: string;
  number?: number;
  protectedChanged?: string[];
}

export interface ProjectState {
  session: ProjectSession;
  statementHtml: string;
  hints: Hint[];
  hintsTotal: number;
  messages: ChatMessage[];
  tree: TreeEntry[];
  readOnly: string[];
  remainingMs: number | null;
  listening: boolean;
  /** The latest result the page should show, rebuilt from the last submission. */
  last: CandidateProjectResult | null;
}

export function projectState(id: string, listening = false, now = Date.now()): ProjectState {
  const session = readProjectSession(id);
  const bundle = readProject(session.project);
  const start = startingRepository(bundle);
  const locked = protectedPaths(bundle);
  let tree: TreeEntry[] = [];
  try {
    tree = workspaceTree(readProjectWorkspace(session.workspace), start, locked);
  } catch {
    /* the workspace is gone; the page says so when a file is opened */
  }
  const revealed = Math.max(0, ...session.hintsUsed);
  const latest = session.submissions > 0 ? readSubmission(id, session.submissions) : null;
  return {
    session,
    statementHtml: renderMarkdown(bundle.statement),
    hints: bundle.hints.filter((h) => h.level <= revealed),
    hintsTotal: bundle.hints.length,
    messages: readProjectEvents(id)
      .filter((e): e is Extract<typeof e, { type: "message" }> => e.type === "message")
      .map((e) => ({ at: e.at, from: e.from, html: e.html })),
    tree,
    readOnly: locked,
    remainingMs: remaining(session, now),
    listening,
    last: latest ? candidateView(latest.result, latest.tests, "", latest.number) : null,
  };
}

// ── The candidate's actions ───────────────────────────────────────────────────

export function startProject(
  id: string,
  now = Date.now(),
  by: "candidate" | "interviewer" = "candidate",
): ProjectSession {
  const session = updateProjectSession(id, (s) => {
    if (s.phase === "done") throw new FlowError(409, "This session is finished");
    if (s.startedAt !== undefined) return;
    s.startedAt = now;
    s.phase = "coding";
  });
  if (session.startedAt === now) {
    appendProjectEvent(id, { type: "started", at: now });
    pushPhase(session);
    notifyDashboard(id);
    if (by === "candidate") emitCandidateEvent({ kind: "started", sessionId: id, at: now });
  }
  return session;
}

function requireWorking(id: string): ProjectSession {
  const session = readProjectSession(id);
  if (session.phase === "briefing")
    throw new FlowError(409, "Press Start before you change or run anything");
  if (session.phase === "done") throw new FlowError(409, "This session is finished");
  return session;
}

/** Translate a workspace guard's refusal into a page error. */
function guard<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof WorkspaceError) throw new FlowError(400, err.message);
    throw err;
  }
}

export function openProjectFile(
  id: string,
  rel: string,
): { path: string; text: string; readOnly: boolean } {
  const session = readProjectSession(id);
  const bundle = readProject(session.project);
  const text = guard(() => readWorkspaceFile(session.workspace, rel));
  return { path: rel, text, readOnly: protectedPaths(bundle).includes(rel) };
}

export function saveProjectFile(
  id: string,
  rel: string,
  text: string,
  now = Date.now(),
): TreeEntry[] {
  const session = requireWorking(id);
  const bundle = readProject(session.project);
  if (protectedPaths(bundle).includes(rel))
    throw new FlowError(403, `${rel} is read-only. Changing it fails a submission.`);
  guard(() => writeWorkspaceFile(session.workspace, rel, text));
  appendProjectEvent(id, { type: "save", path: rel, at: now });
  return guard(() =>
    workspaceTree(
      readProjectWorkspace(session.workspace),
      startingRepository(bundle),
      protectedPaths(bundle),
    ),
  );
}

/** Put one file back the way the project started. */
export function resetProjectFile(id: string, rel: string, now = Date.now()): string {
  const session = requireWorking(id);
  const start = startingRepository(readProject(session.project));
  const original = start[rel];
  if (original === undefined)
    throw new FlowError(404, `${rel} is not part of the starting repository`);
  guard(() => writeWorkspaceFile(session.workspace, rel, original));
  appendProjectEvent(id, { type: "save", path: rel, at: now });
  return original;
}

/** The candidate's Run: the visible tests against the workspace as it is. */
export async function runProjectTests(
  id: string,
  runner: ProjectRunner = defaultProjectRunner,
  by: "candidate" | "interviewer" = "candidate",
  now = Date.now(),
): Promise<{ candidate: CandidateProjectResult; suite: SuiteResult }> {
  const session = by === "candidate" ? requireWorking(id) : readProjectSession(id);
  const files = guard(() => readProjectWorkspace(session.workspace));
  const suite = await runner.run({
    files,
    labels: ["tests"],
    limits: PROJECT_RUN_LIMITS,
    pythonBin: await pythonFor(runner),
  });
  const result = summarise("visible", suite, [], Date.now());
  updateProjectSession(id, (s) => {
    s.runs += 1;
  });
  appendProjectEvent(id, {
    type: "run",
    status: result.status,
    passed: result.passed,
    total: result.total,
    ...(by === "interviewer" ? { by } : {}),
    at: now,
  });
  const candidate = candidateView(result, suite.tests, suite.stderrTail);
  push(sessionChannel(id), "result", candidate);
  if (by === "candidate")
    emitCandidateEvent({
      kind: "run",
      sessionId: id,
      scope: "visible",
      status: runStatus(result.status),
      passed: result.passed,
      total: result.total,
      at: now,
    });
  return { candidate, suite };
}

/**
 * The candidate's Submit: refuse if a read-only file changed, otherwise run the
 * visible and hidden tests on the workspace and record which planted bugs are fixed.
 */
export async function submitProject(
  id: string,
  runner: ProjectRunner = defaultProjectRunner,
  now = Date.now(),
): Promise<CandidateProjectResult> {
  const session = requireWorking(id);
  const bundle = readProject(session.project);
  const start = startingRepository(bundle);
  const files = guard(() => readProjectWorkspace(session.workspace));
  const touched = changedProtected(files, start, protectedPaths(bundle));
  if (touched.length > 0) {
    const refused: CandidateProjectResult = {
      kind: "submit",
      status: "protected",
      passed: 0,
      total: 0,
      tests: [],
      protectedChanged: touched,
      error: `You changed read-only ${touched.length === 1 ? "file" : "files"} ${touched.join(", ")}. On a real assessment that scores zero. Use Reset on ${touched.length === 1 ? "it" : "each"}, then submit again.`,
    };
    push(sessionChannel(id), "result", refused);
    return refused;
  }
  const suite = await runner.run({
    files: { ...files, ...hiddenTestFiles(bundle) },
    labels: ["tests", "hidden_tests"],
    limits: PROJECT_RUN_LIMITS,
    pythonBin: await pythonFor(runner),
  });
  const fixed = suite.status === "ok" ? bugsFixed(bundle.meta.bugs, suite.tests) : [];
  const result = summarise("submit", suite, fixed, now);
  const number = session.submissions + 1;
  const stored: StoredSubmission = {
    number,
    result,
    tests: suite.tests,
    diff: diffRepositories(start, files),
    stderrTail: suite.stderrTail,
  };
  writeSubmission(id, stored);
  updateProjectSession(id, (s) => {
    s.submissions = number;
    s.lastResult = result;
  });
  appendProjectEvent(id, {
    type: "submit",
    number,
    status: result.status,
    passed: result.passed,
    total: result.total,
    bugsFixed: fixed,
    at: now,
  });
  const candidate = candidateView(result, suite.tests, suite.stderrTail, number);
  push(sessionChannel(id), "result", candidate);
  emitCandidateEvent({ kind: "answer", sessionId: id, number, at: now });
  return candidate;
}

export function projectTimerExpired(id: string, now = Date.now()): ProjectSession {
  let changed = false;
  const session = updateProjectSession(id, (s) => {
    if (s.phase !== "coding") return;
    s.phase = "review";
    s.endedAt = now;
    changed = true;
  });
  if (changed) {
    appendProjectEvent(id, { type: "timeout", at: now });
    pushPhase(session);
    emitCandidateEvent({ kind: "timer_expired", sessionId: id, at: now });
  }
  return session;
}

export function projectDone(id: string, now = Date.now()): ProjectSession {
  let changed = false;
  const session = updateProjectSession(id, (s) => {
    if (s.phase === "done") throw new FlowError(409, "This session is finished");
    if (s.phase === "review") return;
    if (s.startedAt === undefined) s.startedAt = now;
    s.phase = "review";
    s.endedAt = now;
    changed = true;
  });
  if (changed) {
    appendProjectEvent(id, { type: "done", at: now });
    pushPhase(session);
    emitCandidateEvent({ kind: "candidate_done", sessionId: id, at: now });
  }
  return session;
}

// ── Both sides ────────────────────────────────────────────────────────────────

export function postProjectMessage(
  id: string,
  from: "interviewer" | "candidate",
  markdown: string,
  now = Date.now(),
): ChatMessage {
  const trimmed = markdown.trim();
  if (!trimmed) throw new FlowError(400, "The message is empty");
  const session = readProjectSession(id);
  if (from === "candidate") {
    if (session.phase === "done") throw new FlowError(409, "This session is finished");
    if (session.oa && session.phase === "coding")
      throw new FlowError(
        409,
        "Nobody answers during an online assessment; the chat opens when you finish",
      );
  }
  const html = renderMarkdown(trimmed);
  const message: ChatMessage = { at: now, from, html };
  appendProjectEvent(id, { type: "message", from, markdown: trimmed, html, at: now });
  push(sessionChannel(id), "message", message);
  if (from === "candidate")
    emitCandidateEvent({ kind: "message", sessionId: id, text: trimmed, at: now });
  return message;
}

export function revealProjectHint(
  id: string,
  level?: number,
  by: "candidate" | "interviewer" = "candidate",
  now = Date.now(),
): { hint: Hint; remaining: number } {
  const session = readProjectSession(id);
  if (session.phase === "done") throw new FlowError(409, "This session is finished");
  if (by === "candidate" && session.oa)
    throw new FlowError(409, "An online assessment has no hints");
  const bundle = readProject(session.project);
  const used = Math.max(0, ...session.hintsUsed);
  const target = level ?? used + 1;
  const hint = bundle.hints.find((h) => h.level === target);
  if (!hint)
    throw new FlowError(
      404,
      target > bundle.hints.length ? "There are no more hints" : "No such hint",
    );
  if (!session.hintsUsed.includes(target)) {
    updateProjectSession(id, (s) => {
      s.hintsUsed.push(target);
      s.hintsUsed.sort((a, b) => a - b);
    });
    appendProjectEvent(id, { type: "hint", level: target, text: hint.text, at: now });
    if (by === "candidate")
      emitCandidateEvent({ kind: "hint_used", sessionId: id, level: target, at: now });
  }
  const left = bundle.hints.length - Math.max(target, used);
  push(sessionChannel(id), "hint", { hint, remaining: left });
  return { hint, remaining: left };
}

// ── The interviewer's actions ─────────────────────────────────────────────────

export interface ProjectRecordInput {
  scores: Record<string, number>;
  rootCauseOk: boolean;
  notesMd: string;
  strengths: string[];
  improvements: string[];
}

export interface ProjectRecordOutcome {
  session: ProjectSession;
  reviewEvents: ReviewEvent[];
  nextDue: string[];
}

/**
 * Score the session. The verdict is mechanical where it can be: every test passed
 * on the last submission, within the clock. Whether the fixes address the causes
 * rather than the tests is the interviewer's call.
 */
export function recordProject(
  id: string,
  input: ProjectRecordInput,
  now = Date.now(),
): ProjectRecordOutcome {
  const before = readProjectSession(id);
  if (before.phase === "done") throw new FlowError(409, "This session is already recorded");
  for (const key of Object.keys(input.scores))
    if (!(PROJECT_DIMENSIONS as readonly string[]).includes(key))
      throw new FlowError(
        400,
        `scores.${key} is not a dimension; they are ${PROJECT_DIMENSIONS.join(", ")}`,
      );
  for (const dim of PROJECT_DIMENSIONS) {
    const value = input.scores[dim];
    if (value === undefined) throw new FlowError(400, `scores.${dim} is required`);
    if (!Number.isInteger(value) || value < 0 || value > 4)
      throw new FlowError(400, `scores.${dim} must be an integer from 0 to 4`);
  }
  const bundle = readProject(before.project);
  const endedAt = before.endedAt ?? now;
  const last = before.lastResult;
  const allPassed =
    last !== undefined && last.status === "ok" && last.total > 0 && last.passed === last.total;
  const withinTime = before.startedAt !== undefined && endedAt - before.startedAt <= before.timerMs;
  const fixed = last?.bugsFixed ?? [];
  const rubric: ProjectRubric = {
    scores: Object.fromEntries(
      PROJECT_DIMENSIONS.map((d) => [d, input.scores[d] as number]),
    ) as Record<ProjectDimension, number>,
    notesMd: input.notesMd,
    strengths: input.strengths,
    improvements: input.improvements,
  };
  const session = updateProjectSession(id, (s) => {
    s.phase = "done";
    s.endedAt = endedAt;
    s.rubric = rubric;
    s.verdict = {
      correct: allPassed && withinTime && input.rootCauseOk,
      allPassed,
      withinTime,
      rootCauseOk: input.rootCauseOk,
      bugsFixed: fixed,
      bugsTotal: bundle.meta.bugs.length,
    };
  });
  appendProjectEvent(id, { type: "rubric", at: now });
  const reviewEvents = projectReviewEvents(
    session,
    bundle.meta.bugs,
    session.verdict?.correct ?? false,
    endedAt,
  );
  appendReviewEvents(reviewEvents);
  const nextDue = nextDueLines(reviewEvents, now);
  push(sessionChannel(id), "rubric", {
    project: true,
    rubric,
    verdict: session.verdict,
    dimensions: PROJECT_DIMENSIONS,
    notesHtml: renderMarkdown(input.notesMd),
    nextDue: nextDue.join(" "),
    bugs: bundle.meta.bugs.map((b) => ({
      id: b.id,
      summary: b.summary,
      fixed: fixed.includes(b.id),
    })),
  });
  pushPhase(session);
  notifyDashboard(id);
  return { session, reviewEvents, nextDue };
}

/** End a session without a debrief; a miss unless `interrupted`. */
export function abandonProject(id: string, reason: string, now = Date.now()): ProjectRecordOutcome {
  const before = readProjectSession(id);
  if (before.phase === "done") throw new FlowError(409, "This session is already finished");
  const trimmed = reason.trim() || "abandoned";
  const session = updateProjectSession(id, (s) => {
    s.phase = "done";
    s.endedAt = s.endedAt ?? now;
    s.abandonedReason = trimmed;
  });
  appendProjectEvent(id, { type: "abandoned", reason: trimmed, at: now });
  let bugs: ProjectBundle["meta"]["bugs"] = [];
  try {
    bugs = readProject(session.project).meta.bugs;
  } catch {
    /* scored by its patterns alone */
  }
  const reviewEvents =
    trimmed === "interrupted"
      ? []
      : projectReviewEvents(session, bugs, false, session.endedAt ?? now);
  if (reviewEvents.length) appendReviewEvents(reviewEvents);
  pushPhase(session);
  notifyDashboard(id);
  return { session, reviewEvents, nextDue: nextDueLines(reviewEvents, now) };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pythonFor(runner: ProjectRunner): Promise<string> {
  try {
    return await runner.python();
  } catch (err) {
    throw new FlowError(503, `The Django environment is not ready: ${(err as Error).message}`);
  }
}

function summarise(
  kind: ProjectResult["kind"],
  suite: SuiteResult,
  fixed: string[],
  at: number,
): ProjectResult {
  const passed = suite.tests.filter((t) => t.status === "pass").length;
  return {
    kind,
    status: suite.status,
    passed,
    total: suite.tests.length,
    ...(kind === "submit" ? { bugsFixed: fixed } : {}),
    at,
  };
}

/** What the page may see: visible tests in full, hidden ones by number and status only. */
export function candidateView(
  result: ProjectResult,
  tests: ReadonlyArray<{ id: string; status: string; message: string }>,
  stderrTail: string,
  number?: number,
): CandidateProjectResult {
  let hidden = 0;
  const view: CandidateProjectResult = {
    kind: result.kind,
    status: result.status,
    passed: result.passed,
    total: result.total,
    tests: tests.map((t) => {
      if (t.id.startsWith("hidden_tests")) {
        hidden += 1;
        return {
          id: `hidden-${hidden}`,
          label: `Hidden ${hidden}`,
          hidden: true,
          status: t.status,
        };
      }
      return {
        id: t.id,
        label: t.id.replace(/^tests\./, ""),
        hidden: false,
        status: t.status,
        ...(t.status === "pass" ? {} : { message: t.message }),
      };
    }),
    ...(number !== undefined ? { number } : {}),
  };
  if (result.status !== "ok") {
    // A traceback that runs through a hidden test would show its source.
    view.error = /hidden_tests/.test(stderrTail)
      ? "A hidden test could not import something it needs from the project. A name it uses may have been renamed or removed."
      : stderrTail.trim() ||
        (result.status === "timeout"
          ? "The tests ran out of time."
          : "The tests stopped before finishing.");
  }
  return view;
}

function runStatus(status: ProjectResult["status"]): RunStatus {
  if (status === "ok") return "ok";
  if (status === "timeout") return "timeout";
  if (status === "error") return "import-error";
  return "harness-error";
}

function nextDueLines(events: readonly ReviewEvent[], now: number): string[] {
  const items = reviewItems();
  return events.flatMap((e) => {
    const item = items.find((i) => i.key === e.key);
    return item
      ? [`${item.id} comes back for review ${relativeDay(item.dueAt, now)} (box ${item.box}).`]
      : [];
  });
}

function pushPhase(session: ProjectSession): void {
  const payload: { phase: string; startedAt?: number; endedAt?: number; timerMs: number } = {
    phase: session.phase,
    timerMs: session.timerMs,
  };
  if (session.startedAt !== undefined) payload.startedAt = session.startedAt;
  if (session.endedAt !== undefined) payload.endedAt = session.endedAt;
  push(sessionChannel(session.id), "phase", payload);
}
