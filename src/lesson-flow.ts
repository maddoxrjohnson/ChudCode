/**
 * lesson-flow.ts: the operations that move a lesson session along, shared by the
 * browser API and the interviewer's tools.
 *
 * The shape follows flow.ts: update the session on disk, append to its event log,
 * push the change to the page, and tell the host. A lesson has no code to run: the
 * learner reads the teaching, works the exercise with their own agent, and submits a
 * written answer, which the interviewer probes with follow-ups and then scores.
 */

import { findLesson, type Lesson } from "./curriculum.ts";
import { FlowError, notifyDashboard, remaining, type ChatMessage } from "./flow.ts";
import {
  inspectProject,
  LabError,
  listLabFiles,
  resolveProjectRoot,
  type LabListing,
  type LabSnapshot,
} from "./lab.ts";
import { renderMarkdown } from "./markdown.ts";
import {
  inspectMedia,
  listMediaFiles,
  type MediaListing,
  type MediaSnapshot,
} from "./media-lab.ts";
import { relativeDay, type ReviewEvent } from "./review.ts";
import { emitCandidateEvent } from "./server/hooks.ts";
import { push, sessionChannel } from "./server/sse.ts";
import { publicExercise, readExercise, type PublicExercise } from "./store/exercises.ts";
import {
  appendLessonEvent,
  CHECKLIST_STATUSES,
  gradeFile,
  labSnapshotFile,
  LESSON_DIMENSIONS,
  lessonReviewEvent,
  readLesson,
  readLessonDraft,
  readAnswer,
  readLessonEvents,
  recordAnswer,
  updateLesson,
  writeLessonDraft,
  type ChecklistResult,
  type CacheGrade,
  type RefactorGrade,
  type DrillGrade,
  type ReviewGrade,
  type LessonEvent,
  type LessonRubric,
  type LessonScores,
  type LessonSession,
  type LessonVerdict,
} from "./store/lessons.ts";
import { readJson, writeJson } from "./store/json.ts";
import { plural } from "./format.ts";
import { runMutation, type MutationReport, type SuiteRun } from "./drill/mutation.ts";
import { readWorkspaceModule, readWorkspaceTests, WorkspaceError } from "./drill/workspace.ts";
import {
  auditTranscript,
  listTranscripts,
  transcriptPath,
  type TranscriptAudit,
  type TranscriptEntry,
} from "./transcript.ts";
import { gitCommits, gradeRefactor, type RefactorReport } from "./drill/refactor.ts";
import {
  COST_SLACK,
  dollars,
  gradePlan,
  parsePlan,
  planErrors,
  simulate,
  type CachePlan,
} from "./drill/cache-sim.ts";
import {
  FLAW_CATEGORIES,
  gradeReview,
  MAX_MARKS,
  parseDiff,
  type FlawCategory,
  type FlawGrade,
  type ReviewMark,
} from "./drill/flaw-review.ts";
import { appendReviewEvents, reviewItems } from "./store/review-events.ts";

export const MAX_ANSWER_CHARS = 20_000;

export interface LessonState {
  session: LessonSession;
  exercise: PublicExercise;
  draft: string;
  messages: ChatMessage[];
  remainingMs: number | null;
  listening: boolean;
}

export function lessonState(id: string, listening = false, now = Date.now()): LessonState {
  const session = readLesson(id);
  const exercise = publicExercise(readExercise(session.exercise));
  const messages = readLessonEvents(id)
    .filter((e): e is Extract<LessonEvent, { type: "message" }> => e.type === "message")
    .map((e) => ({ at: e.at, from: e.from, html: e.html }));
  return {
    session,
    exercise,
    draft: readLessonDraft(id) ?? "",
    messages,
    remainingMs: remaining(session, now),
    listening,
  };
}

// ── Learner actions ───────────────────────────────────────────────────────────

export function startLesson(
  id: string,
  now = Date.now(),
  by: "candidate" | "interviewer" = "candidate",
): LessonSession {
  const session = updateLesson(id, (s) => {
    if (s.phase === "done") throw new FlowError(409, "This lesson is finished");
    if (s.startedAt !== undefined) return;
    s.startedAt = now;
    s.phase = "coding";
  });
  if (session.startedAt === now) {
    appendLessonEvent(id, { type: "started", at: now });
    pushPhase(session);
    notifyDashboard(id);
    if (by === "candidate") emitCandidateEvent({ kind: "started", sessionId: id, at: now });
  }
  return session;
}

export function postLessonMessage(
  id: string,
  from: "interviewer" | "candidate",
  markdown: string,
  now = Date.now(),
): ChatMessage {
  const trimmed = markdown.trim();
  if (!trimmed) throw new FlowError(400, "The message is empty");
  const session = readLesson(id);
  if (session.phase === "done" && from === "candidate")
    throw new FlowError(409, "This lesson is finished");
  const html = renderMarkdown(trimmed);
  const message: ChatMessage = { at: now, from, html };
  appendLessonEvent(id, { type: "message", from, markdown: trimmed, html, at: now });
  push(sessionChannel(id), "message", message);
  if (from === "candidate")
    emitCandidateEvent({ kind: "message", sessionId: id, text: trimmed, at: now });
  return message;
}

export function saveLessonDraft(id: string, text: string): void {
  if (readLesson(id).phase === "done") throw new FlowError(409, "This lesson is finished");
  writeLessonDraft(id, text);
}

/** Submit the answer box. The interviewer reads it and asks follow-ups. */
export function submitAnswer(id: string, text: string, now = Date.now()): number {
  const trimmed = text.trim();
  if (!trimmed) throw new FlowError(400, "Write your answer before submitting it");
  if (trimmed.length > MAX_ANSWER_CHARS)
    throw new FlowError(400, `Answers are capped at ${MAX_ANSWER_CHARS} characters`);
  const session = readLesson(id);
  if (session.phase === "briefing") throw new FlowError(409, "Press Start before submitting");
  if (session.phase === "done") throw new FlowError(409, "This lesson is finished");
  writeLessonDraft(id, text);
  const number = recordAnswer(id, trimmed);
  appendLessonEvent(id, { type: "answer", number, chars: trimmed.length, at: now });
  push(sessionChannel(id), "answer", { number, at: now, html: renderMarkdown(trimmed) });
  emitCandidateEvent({ kind: "answer", sessionId: id, number, at: now });
  return number;
}

export function lessonTimerExpired(id: string, now = Date.now()): LessonSession {
  let changed = false;
  const session = updateLesson(id, (s) => {
    if (s.phase !== "coding") return;
    s.phase = "review";
    s.endedAt = now;
    changed = true;
  });
  if (changed) {
    appendLessonEvent(id, { type: "timeout", at: now });
    pushPhase(session);
    emitCandidateEvent({ kind: "timer_expired", sessionId: id, at: now });
  }
  return session;
}

export function lessonDone(id: string, now = Date.now()): LessonSession {
  let changed = false;
  const session = updateLesson(id, (s) => {
    if (s.phase === "done") throw new FlowError(409, "This lesson is finished");
    if (s.phase === "review") return;
    if (s.startedAt === undefined) s.startedAt = now;
    s.phase = "review";
    s.endedAt = now;
    changed = true;
  });
  if (changed) {
    appendLessonEvent(id, { type: "done", at: now });
    pushPhase(session);
    emitCandidateEvent({ kind: "candidate_done", sessionId: id, at: now });
  }
  return session;
}

// ── Labs ──────────────────────────────────────────────────────────────────────

/** A lab or a media lab: both read a project the learner names on the page. */
function labLesson(session: LessonSession): Lesson {
  if (session.exerciseKind !== "lab" && session.exerciseKind !== "media-lab")
    throw new FlowError(409, "This lesson is not a lab");
  const lesson = findLesson(session.lesson)?.lesson;
  if (!lesson) throw new FlowError(409, `Lesson ${session.lesson} is no longer in the curriculum`);
  if (session.exerciseKind === "lab" && !lesson.labFiles?.length)
    throw new FlowError(409, "This lesson has no lab files");
  return lesson;
}

/** A media lab's listing in the lab's shape, so the page lists it the same way. */
export function mediaListingAsLab(listing: MediaListing): LabListing {
  return {
    root: listing.root,
    files: [...listing.pages, ...(listing.readme ? [listing.readme] : []), ...listing.media],
    skipped: listing.skipped,
  };
}

function listProject(session: LessonSession, lesson: Lesson, root: string): LabListing {
  return session.exerciseKind === "media-lab"
    ? mediaListingAsLab(listMediaFiles(root))
    : listLabFiles(root, lesson.labFiles ?? []);
}

function resolveRoot(input: string): string {
  try {
    return resolveProjectRoot(input);
  } catch (err) {
    if (err instanceof LabError) throw new FlowError(400, err.message);
    throw err;
  }
}

/** What a lab would read in this project, for the page to show before consent. */
export function previewLab(id: string, projectPath: string): LabListing {
  const session = readLesson(id);
  return listProject(session, labLesson(session), resolveRoot(projectPath));
}

/**
 * The learner consented to a project being read. It is stored as an answer (the path,
 * the files, and their note) and the interviewer is told to call inspect_lab.
 */
export function submitLab(id: string, projectPath: string, note: string, now = Date.now()): number {
  const session = readLesson(id);
  const lesson = labLesson(session);
  if (session.phase === "briefing") throw new FlowError(409, "Press Start before submitting");
  if (session.phase === "done") throw new FlowError(409, "This lesson is finished");
  if (note.length > MAX_ANSWER_CHARS)
    throw new FlowError(400, `Notes are capped at ${MAX_ANSWER_CHARS} characters`);
  const listing = listProject(session, lesson, resolveRoot(projectPath));
  if (listing.files.length === 0)
    throw new FlowError(
      400,
      session.exerciseKind === "media-lab"
        ? `There are no site pages, README, or media files in ${listing.root}.`
        : `None of the files this lab reads are in ${listing.root}: ${(lesson.labFiles ?? []).join(", ")}.`,
    );
  const files = listing.files.map((f) => f.path);
  const text = [
    `Project: ${listing.root}`,
    "",
    `Files: ${files.join(", ")}`,
    ...(note.trim() ? ["", note.trim()] : []),
  ].join("\n");
  writeLessonDraft(id, note);
  const number = recordAnswer(id, text);
  updateLesson(id, (s) => {
    s.lab = { root: listing.root, files, submittedAt: now, answer: number, inspections: 0 };
  });
  appendLessonEvent(id, { type: "lab", number, root: listing.root, files: files.length, at: now });
  push(sessionChannel(id), "answer", { number, at: now, html: renderMarkdown(text) });
  emitCandidateEvent({ kind: "answer", sessionId: id, number, at: now });
  return number;
}

/**
 * Read the submitted project now, through every guard again: the folder may have
 * changed since the learner consented. The snapshot is kept as evidence.
 */
export async function inspectLab(id: string, now = Date.now()): Promise<LabSnapshot> {
  const session = readLesson(id);
  const lesson = labLesson(session);
  if (session.exerciseKind !== "lab")
    throw new FlowError(409, "This is a media lab; call inspect_media");
  const lab = session.lab;
  if (!lab)
    throw new FlowError(409, "The learner has not submitted a project yet; it comes from the page");
  const snapshot = await inspectProject(resolveRoot(lab.root), lesson.labFiles ?? [], now);
  writeJson(labSnapshotFile(id, lab.answer), snapshot);
  updateLesson(id, (s) => {
    if (s.lab) s.lab.inspections += 1;
  });
  appendLessonEvent(id, {
    type: "inspected",
    number: lab.answer,
    files: snapshot.files.length,
    lints: snapshot.lints.length,
    at: now,
  });
  return snapshot;
}

/**
 * Measure the submitted project's site and media now, through the guards again, and
 * keep the snapshot as evidence. The page gets the check results; the latest
 * measurement decides the gate.
 */
export function inspectMediaLab(id: string, now = Date.now()): MediaSnapshot {
  const session = readLesson(id);
  labLesson(session);
  if (session.exerciseKind !== "media-lab")
    throw new FlowError(409, "This is not a media lab; call inspect_lab");
  const lab = session.lab;
  if (!lab)
    throw new FlowError(409, "The learner has not submitted a project yet; it comes from the page");
  const snapshot = inspectMedia(resolveRoot(lab.root), now);
  writeJson(labSnapshotFile(id, lab.answer), snapshot);
  const failed = snapshot.checks.filter((c) => c.status === "fail").length;
  const warned = snapshot.checks.filter((c) => c.status === "warn").length;
  updateLesson(id, (s) => {
    if (!s.lab) return;
    s.lab.inspections += 1;
    s.lab.gatePassed = snapshot.gatePassed;
    s.lab.failed = failed;
    s.lab.warned = warned;
  });
  appendLessonEvent(id, {
    type: "measured",
    number: lab.answer,
    pages: snapshot.pages.length,
    media: snapshot.media.length,
    failed,
    warned,
    at: now,
  });
  push(sessionChannel(id), "measured", {
    number: lab.answer,
    gatePassed: snapshot.gatePassed,
    checks: snapshot.checks,
  });
  return snapshot;
}

/** The latest media measurement, for the page to show after a reload. */
export function latestMediaSnapshot(session: LessonSession): MediaSnapshot | null {
  if (session.exerciseKind !== "media-lab" || !session.lab?.inspections) return null;
  return readJson<MediaSnapshot>(labSnapshotFile(session.id, session.lab.answer));
}

// ── Transcripts ───────────────────────────────────────────────────────────────

function transcriptLesson(session: LessonSession): void {
  if (session.exerciseKind !== "transcript")
    throw new FlowError(409, "This lesson does not review a transcript");
}

/** The learner's recent Claude Code sessions, listed only when they ask on the page. */
export function listLessonTranscripts(id: string): TranscriptEntry[] {
  transcriptLesson(readLesson(id));
  return listTranscripts();
}

/** The learner chose a session log and consented to it being read. */
export function submitTranscript(
  id: string,
  transcriptId: string,
  note: string,
  now = Date.now(),
): number {
  const session = readLesson(id);
  transcriptLesson(session);
  if (session.phase === "briefing") throw new FlowError(409, "Press Start before submitting");
  if (session.phase === "done") throw new FlowError(409, "This lesson is finished");
  const entry = listTranscripts().find((t) => t.id === transcriptId);
  if (!entry || !transcriptPath(transcriptId))
    throw new FlowError(400, "That session is no longer in the list; list them again");
  const text = [
    `Session log from \`${entry.project}\`, last written ${new Date(entry.modifiedAt).toISOString().slice(0, 16).replace("T", " ")}.`,
    ...(note.trim() ? ["", note.trim().slice(0, MAX_ANSWER_CHARS)] : []),
  ].join("\n");
  writeLessonDraft(id, note);
  const number = recordAnswer(id, text);
  updateLesson(id, (s) => {
    s.transcript = {
      id: transcriptId,
      project: entry.project,
      submittedAt: now,
      answer: number,
      inspections: 0,
    };
  });
  appendLessonEvent(id, { type: "answer", number, chars: text.length, at: now });
  push(sessionChannel(id), "answer", { number, at: now, html: renderMarkdown(text) });
  emitCandidateEvent({ kind: "answer", sessionId: id, number, at: now });
  return number;
}

/** Read the chosen log now, resolving its path again, and keep the summary as evidence. */
export function inspectTranscript(id: string): TranscriptAudit {
  const session = readLesson(id);
  transcriptLesson(session);
  const chosen = session.transcript;
  if (!chosen)
    throw new FlowError(409, "The learner has not chosen a session yet; it comes from the page");
  const file = transcriptPath(chosen.id);
  if (!file) throw new FlowError(409, "That session log is gone");
  const audit = auditTranscript(file, chosen.project);
  writeJson(labSnapshotFile(id, chosen.answer), audit);
  updateLesson(id, (s) => {
    if (s.transcript) s.transcript.inspections += 1;
  });
  return audit;
}

// ── Drills ────────────────────────────────────────────────────────────────────

export const MAX_GRADES = 10;

/** One line for the answers list: what a grade found, without naming any bug. */
export function gradeSummary(grade: DrillGrade): string {
  return [
    `Graded ${plural(grade.tests, "test")}: caught ${grade.killed} of ${grade.mutants} planted bugs. ${grade.passed ? "**Passed the gate.**" : "Not past the gate yet."}`,
    ...grade.problems.map((p) => `- ${p}`),
    ...(grade.assertFree > 0 ? [`- ${plural(grade.assertFree, "test")} assert nothing.`] : []),
  ].join("\n");
}

/**
 * Grade the tests in the drill's workspace against the reference, the rewrites, and
 * every mutant. The full report goes to disk and the interviewer; the page gets counts.
 */
export async function gradeDrill(
  id: string,
  run: SuiteRun,
  pythonBin: string,
  now = Date.now(),
): Promise<{ grade: DrillGrade; report: MutationReport }> {
  const session = readLesson(id);
  if (session.exerciseKind !== "mutation" || !session.drill)
    throw new FlowError(409, "This lesson is not a drill");
  if (session.phase === "briefing") throw new FlowError(409, "Press Start before grading");
  if (session.phase === "done") throw new FlowError(409, "This lesson is finished");
  if (session.drill.grades >= MAX_GRADES)
    throw new FlowError(429, `A drill can be graded ${MAX_GRADES} times`);
  const spec = readExercise(session.exercise).private.mutation;
  if (!spec) throw new FlowError(409, "This drill's exercise has no mutants");
  let tests: Record<string, string>;
  try {
    tests = readWorkspaceTests(session.drill.workspace);
  } catch (err) {
    if (err instanceof WorkspaceError) throw new FlowError(400, err.message);
    throw err;
  }
  const report = await runMutation(spec, tests, run, pythonBin);
  const draft: Omit<DrillGrade, "number"> = {
    at: now,
    tests: report.tests,
    killed: report.killed,
    mutants: report.mutants.length,
    assertFree: report.assertFree.length,
    problems: report.problems,
    passed: report.passed,
  };
  const number = recordAnswer(id, gradeSummary({ ...draft, number: 0 }));
  const grade: DrillGrade = { ...draft, number };
  writeJson(gradeFile(id, number), { ...report, files: Object.keys(tests) });
  updateLesson(id, (s) => {
    if (s.drill) {
      s.drill.grades += 1;
      s.drill.latest = grade;
    }
  });
  appendLessonEvent(id, {
    type: "graded",
    number,
    killed: grade.killed,
    mutants: grade.mutants,
    passed: grade.passed,
    at: now,
  });
  push(sessionChannel(id), "answer", {
    number,
    at: now,
    html: renderMarkdown(gradeSummary(grade)),
  });
  push(sessionChannel(id), "grade", grade);
  emitCandidateEvent({ kind: "answer", sessionId: id, number, at: now });
  return { grade, report };
}

// ── Flaw reviews and cache plans ─────────────────────────────────────────────

export const MAX_REVIEWS = 3;
export const MAX_PLANS = 10;

function attemptable(session: LessonSession, kind: LessonSession["exerciseKind"]): void {
  if (session.exerciseKind !== kind) throw new FlowError(409, `This lesson is not a ${kind}`);
  if (session.phase === "briefing") throw new FlowError(409, "Press Start first");
  if (session.phase === "done") throw new FlowError(409, "This lesson is finished");
}

export function reviewSummary(grade: ReviewGrade): string {
  return [
    `Reviewed with ${plural(grade.marks, "mark")}: found ${grade.found} of ${grade.flaws} planted flaws, ${plural(grade.falseAlarms, "false alarm")}. ${grade.passed ? "**Passed the gate.**" : "Not past the gate yet."}`,
    ...grade.problems.map((p) => `- ${p}`),
  ].join("\n");
}

/** Grade a review's marks against the planted flaws. The page sees counts only. */
export function submitFlawReview(
  id: string,
  rawMarks: unknown,
  now = Date.now(),
): { grade: ReviewGrade; full: FlawGrade } {
  const session = readLesson(id);
  attemptable(session, "flaw-review");
  const spec = readExercise(session.exercise).private.flawReview;
  if (!spec) throw new FlowError(409, "This exercise has no diff");
  if ((session.review?.grades ?? 0) >= MAX_REVIEWS)
    throw new FlowError(429, `A review can be submitted ${MAX_REVIEWS} times`);
  const files = new Set(parseDiff(spec.diff).map((f) => f.path));
  if (!Array.isArray(rawMarks) || rawMarks.length === 0)
    throw new FlowError(400, "Mark at least one line before submitting");
  if (rawMarks.length > MAX_MARKS) throw new FlowError(400, `At most ${MAX_MARKS} marks`);
  const marks: ReviewMark[] = rawMarks.map((raw, i) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    if (typeof m["file"] !== "string" || !files.has(m["file"]))
      throw new FlowError(400, `marks[${i}].file is not a file in the diff`);
    if (!Number.isInteger(m["line"]))
      throw new FlowError(400, `marks[${i}].line must be a line number`);
    if (!(FLAW_CATEGORIES as readonly unknown[]).includes(m["category"]))
      throw new FlowError(400, `marks[${i}].category must be one of ${FLAW_CATEGORIES.join(", ")}`);
    const reason = typeof m["reason"] === "string" ? m["reason"].trim().slice(0, 500) : "";
    return {
      file: m["file"],
      line: m["line"] as number,
      category: m["category"] as FlawCategory,
      reason,
    };
  });
  const full = gradeReview(spec, marks);
  const draft = {
    at: now,
    marks: marks.length,
    found: full.found.length,
    flaws: spec.flaws.length,
    criticalMissed: full.criticalMissed,
    falseAlarms: full.falseAlarms.length,
    problems: full.problems,
    passed: full.passed,
  };
  const number = recordAnswer(id, reviewSummary({ ...draft, number: 0 }));
  const grade: ReviewGrade = { ...draft, number };
  writeJson(gradeFile(id, number), { marks, grade: full });
  updateLesson(id, (s) => {
    s.review = { grades: (s.review?.grades ?? 0) + 1, latest: grade };
  });
  appendLessonEvent(id, {
    type: "reviewed",
    number,
    found: grade.found,
    flaws: grade.flaws,
    passed: grade.passed,
    at: now,
  });
  push(sessionChannel(id), "answer", {
    number,
    at: now,
    html: renderMarkdown(reviewSummary(grade)),
  });
  push(sessionChannel(id), "review", grade);
  emitCandidateEvent({ kind: "answer", sessionId: id, number, at: now });
  return { grade, full };
}

export function planSummary(grade: CacheGrade): string {
  return `Plan ${grade.number}: ${dollars(grade.cost)} for ${plural(grade.requests, "request")}, ${(grade.ratio * 100).toFixed(0)}% of the best plan known (the bar is ${Math.round(COST_SLACK * 100)}%). With no caching it would cost ${dollars(grade.uncachedCost)}. ${grade.passed ? "**Passed the gate.**" : "Not past the gate yet."}`;
}

/** Simulate the learner's plan. Its own cost breakdown is theirs to see. */
export function submitCachePlan(id: string, raw: unknown, now = Date.now()): CacheGrade {
  const session = readLesson(id);
  attemptable(session, "cache-plan");
  const spec = readExercise(session.exercise).private.cachePlan;
  if (!spec) throw new FlowError(409, "This exercise has no scenario");
  if ((session.cachePlan?.grades ?? 0) >= MAX_PLANS)
    throw new FlowError(429, `A plan can be checked ${MAX_PLANS} times`);
  let plan: CachePlan;
  try {
    plan = parsePlan(raw);
  } catch (err) {
    throw new FlowError(400, (err as Error).message);
  }
  const problems = planErrors(spec.scenario, plan);
  if (problems.length > 0)
    throw new FlowError(400, `The plan is not valid: ${problems.join("; ")}`);
  const result = gradePlan(spec.scenario, plan, spec.reference);
  const draft = {
    at: now,
    cost: result.cost.total,
    referenceCost: result.referenceCost,
    naiveCost: result.naiveCost,
    uncachedCost: result.uncachedCost,
    ratio: result.ratio,
    hits: result.cost.hits,
    requests: spec.scenario.requests.length,
    readTokens: result.cost.readTokens,
    writeTokens: result.cost.writeTokens,
    uncachedTokens: result.cost.uncachedTokens,
    passed: result.passed,
  };
  const number = recordAnswer(
    id,
    `${planSummary({ ...draft, number: 0 })}\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``,
  );
  const grade: CacheGrade = { ...draft, number };
  writeJson(gradeFile(id, number), { plan, result });
  updateLesson(id, (s) => {
    s.cachePlan = { grades: (s.cachePlan?.grades ?? 0) + 1, latest: grade };
  });
  appendLessonEvent(id, {
    type: "planned",
    number,
    ratio: grade.ratio,
    passed: grade.passed,
    at: now,
  });
  push(sessionChannel(id), "answer", {
    number,
    at: now,
    html: renderMarkdown(readAnswer(id, number) ?? ""),
  });
  push(sessionChannel(id), "plan", grade);
  emitCandidateEvent({ kind: "answer", sessionId: id, number, at: now });
  return grade;
}

/** What a scored flaw review or cache plan reveals in the debrief. */
export function drillReveal(session: LessonSession): DrillReveal | null {
  if (session.exerciseKind === "flaw-review") {
    const latest = session.review?.latest;
    const spec = readExercise(session.exercise).private.flawReview;
    if (!spec) return null;
    const graded = latest
      ? readJson<{ grade: FlawGrade }>(gradeFile(session.id, latest.number))
      : null;
    const missedIds = new Set(
      graded ? graded.grade.missed.map((m) => m.id) : spec.flaws.map((f) => f.id),
    );
    return {
      kind: "flaw-review",
      flaws: spec.flaws.map((f) => ({
        file: f.file,
        line: f.line,
        category: f.category,
        critical: f.critical,
        explanation: f.explanation,
        found: !missedIds.has(f.id),
      })),
      falseAlarms: graded?.grade.falseAlarms ?? [],
    };
  }
  if (session.exerciseKind === "cache-plan") {
    const spec = readExercise(session.exercise).private.cachePlan;
    if (!spec) return null;
    return {
      kind: "cache-plan",
      reference: spec.reference,
      referenceCost: simulate(spec.scenario, spec.reference).total,
    };
  }
  return null;
}

export type DrillReveal =
  | {
      kind: "flaw-review";
      flaws: Array<{
        file: string;
        line: number;
        category: string;
        critical: boolean;
        explanation: string;
        found: boolean;
      }>;
      falseAlarms: FlawGrade["falseAlarms"];
    }
  | { kind: "cache-plan"; reference: CachePlan; referenceCost: number };

// ── Refactor drills ───────────────────────────────────────────────────────────

export function refactorSummary(grade: RefactorGrade): string {
  const mark = (ok: boolean) => (ok ? "yes" : "**no**");
  return [
    `Refactor graded: ${grade.passed ? "**passed the gate.**" : "not past the gate yet."}`,
    `- Tests committed before the change: ${mark(grade.testsFirst)}`,
    `- Characterisation caught ${grade.killed} of ${grade.mutants} planted bugs in the original`,
    `- Behaviour kept: ${mark(grade.behaviourKept)}; your tests pass: ${mark(grade.ownTestsPass)}; interface unchanged: ${mark(grade.apiSame)}`,
    `- Longest function ${grade.before.longestFunction} → ${grade.after.longestFunction} lines, deepest nesting ${grade.before.maxNesting} → ${grade.after.maxNesting}`,
  ].join("\n");
}

/** Grade the workspace: history, characterisation tests, behaviour, interface, shape. */
export async function gradeRefactorDrill(
  id: string,
  run: SuiteRun,
  pythonBin: string,
  now = Date.now(),
): Promise<{ grade: RefactorGrade; report: RefactorReport }> {
  const session = readLesson(id);
  attemptable(session, "refactor");
  if (!session.drill) throw new FlowError(409, "This drill has no workspace");
  if ((session.refactor?.grades ?? 0) >= MAX_GRADES)
    throw new FlowError(429, `A drill can be graded ${MAX_GRADES} times`);
  const spec = readExercise(session.exercise).private.refactor;
  if (!spec) throw new FlowError(409, "This exercise has no refactor spec");
  let tests: Record<string, string>;
  let current: string;
  try {
    tests = readWorkspaceTests(session.drill.workspace);
    current = readWorkspaceModule(session.drill.workspace, spec.module);
  } catch (err) {
    if (err instanceof WorkspaceError) throw new FlowError(400, err.message);
    throw err;
  }
  const commits = await gitCommits(session.drill.workspace);
  const report = await gradeRefactor(spec, current, tests, commits, run, pythonBin);
  const draft = {
    at: now,
    testsFirst: report.order.ok,
    killed: report.characterisation.killed,
    mutants: report.characterisation.mutants.length,
    behaviourKept: report.behaviour.passed,
    ownTestsPass: report.ownTests.passed,
    apiSame: report.api.same,
    before: report.before,
    after: report.after,
    problems: report.problems,
    passed: report.passed,
  };
  const number = recordAnswer(id, refactorSummary({ ...draft, number: 0 }));
  const grade: RefactorGrade = { ...draft, number };
  writeJson(gradeFile(id, number), { ...report, files: Object.keys(tests) });
  updateLesson(id, (s) => {
    s.refactor = { grades: (s.refactor?.grades ?? 0) + 1, latest: grade };
  });
  appendLessonEvent(id, {
    type: "graded",
    number,
    killed: grade.killed,
    mutants: grade.mutants,
    passed: grade.passed,
    at: now,
  });
  push(sessionChannel(id), "answer", {
    number,
    at: now,
    html: renderMarkdown(refactorSummary(grade)),
  });
  push(sessionChannel(id), "refactor", grade);
  emitCandidateEvent({ kind: "answer", sessionId: id, number, at: now });
  return { grade, report };
}

/** The bugs the learner's latest graded suite missed, for the debrief. */
export function drillSurvivors(session: LessonSession): Array<{ id: string; description: string }> {
  if (session.exerciseKind === "refactor") {
    const latest = session.refactor?.latest;
    if (!latest) return [];
    const report = readJson<RefactorReport>(gradeFile(session.id, latest.number));
    return (report?.characterisation.mutants ?? [])
      .filter((m) => !m.killed)
      .map((m) => ({ id: m.id, description: m.description }));
  }
  const latest = session.drill?.latest;
  if (!latest) return [];
  const report = readJson<MutationReport>(gradeFile(session.id, latest.number));
  return (report?.mutants ?? [])
    .filter((m) => !m.killed)
    .map((m) => ({ id: m.id, description: m.description }));
}

// ── Interviewer actions ───────────────────────────────────────────────────────

export interface LessonRecordInput {
  scores: LessonScores;
  notesMd: string;
  strengths: string[];
  improvements: string[];
  /** Required for a lab: one result for each checklist item. */
  checklist?: ChecklistResult[];
}

export interface LessonRecordOutcome {
  session: LessonSession;
  reviewEvent: ReviewEvent | null;
  /** When the lesson comes back for review, as a sentence. */
  nextDue: string;
}

/**
 * The verdict: the learner submitted an answer, and every dimension the lesson
 * focuses on scored 2 or more. A dimension outside the focus may be null.
 */
export function lessonVerdict(
  session: LessonSession,
  scores: LessonScores,
  checklist?: readonly ChecklistResult[],
): LessonVerdict {
  const rubricOk = session.focus.every((dim) => (scores[dim] ?? -1) >= 2);
  const answered = session.answers > 0;
  if (
    session.exerciseKind === "mutation" ||
    session.exerciseKind === "flaw-review" ||
    session.exerciseKind === "cache-plan" ||
    session.exerciseKind === "refactor"
  ) {
    // A drill passes on what was graded: the latest attempt must clear the gate.
    const gatePassed =
      (session.exerciseKind === "mutation"
        ? session.drill?.latest?.passed
        : session.exerciseKind === "flaw-review"
          ? session.review?.latest?.passed
          : session.exerciseKind === "refactor"
            ? session.refactor?.latest?.passed
            : session.cachePlan?.latest?.passed) ?? false;
    return { correct: rubricOk && answered && gatePassed, rubricOk, answered, gatePassed };
  }
  if (
    session.exerciseKind !== "lab" &&
    session.exerciseKind !== "media-lab" &&
    session.exerciseKind !== "transcript"
  )
    return { correct: rubricOk && answered, rubricOk, answered };
  // A lab or a transcript review passes on what was read, so it must have been
  // read, and nothing on the checklist may be missing outright.
  const inspected = ((session.lab ?? session.transcript)?.inspections ?? 0) > 0;
  const checklistOk = (checklist ?? []).every((c) => c.status !== "missing");
  if (session.exerciseKind === "media-lab") {
    // The latest measurement must clear every fail-severity check as well.
    const gatePassed = inspected && session.lab?.gatePassed === true;
    return {
      correct: rubricOk && answered && inspected && checklistOk && gatePassed,
      rubricOk,
      answered,
      inspected,
      checklistOk,
      gatePassed,
    };
  }
  return {
    correct: rubricOk && answered && inspected && checklistOk,
    rubricOk,
    answered,
    inspected,
    checklistOk,
  };
}

/** A lab's checklist results must cover every item of the lesson exactly once. */
export function checkChecklist(
  lesson: Lesson,
  results: readonly ChecklistResult[] | undefined,
): ChecklistResult[] {
  const items = lesson.checklist ?? [];
  if (!results)
    throw new FlowError(
      400,
      `checklist is required for a lab: answer ${items.map((i) => i.id).join(", ")}`,
    );
  const ids = items.map((i) => i.id);
  const seen = new Set<string>();
  for (const result of results) {
    if (!ids.includes(result.id))
      throw new FlowError(400, `checklist names ${result.id}; the items are ${ids.join(", ")}`);
    if (seen.has(result.id)) throw new FlowError(400, `checklist answers ${result.id} twice`);
    if (!(CHECKLIST_STATUSES as readonly string[]).includes(result.status))
      throw new FlowError(
        400,
        `checklist ${result.id}: status must be ${CHECKLIST_STATUSES.join(", ")}`,
      );
    seen.add(result.id);
  }
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length > 0)
    throw new FlowError(400, `checklist must answer every item. Missing: ${missing.join(", ")}`);
  return ids.map((id) => results.find((r) => r.id === id) as ChecklistResult);
}

export function recordLesson(
  id: string,
  input: LessonRecordInput,
  now = Date.now(),
): LessonRecordOutcome {
  const before = readLesson(id);
  if (before.phase === "done") throw new FlowError(409, "This lesson is already recorded");
  for (const dim of LESSON_DIMENSIONS) {
    const value = input.scores[dim];
    if (value === null) {
      if (before.focus.includes(dim))
        throw new FlowError(400, `scores.${dim} is this lesson's focus, so it needs a score`);
      continue;
    }
    if (!Number.isInteger(value) || value < 0 || value > 4)
      throw new FlowError(400, `scores.${dim} must be an integer from 0 to 4, or null`);
  }

  let checklist: ChecklistResult[] | undefined;
  if (
    before.exerciseKind === "lab" ||
    before.exerciseKind === "media-lab" ||
    before.exerciseKind === "transcript"
  ) {
    const lesson = findLesson(before.lesson)?.lesson;
    if (!lesson) throw new FlowError(409, `Lesson ${before.lesson} is no longer in the curriculum`);
    checklist = checkChecklist(lesson, input.checklist);
  }
  const verdict = lessonVerdict(before, input.scores, checklist);
  const rubric: LessonRubric = {
    ...input.scores,
    notesMd: input.notesMd,
    strengths: input.strengths,
    improvements: input.improvements,
    ...(checklist ? { checklist } : {}),
  };
  const session = updateLesson(id, (s) => {
    s.phase = "done";
    s.endedAt = s.endedAt ?? now;
    s.rubric = rubric;
    s.verdict = verdict;
  });
  appendLessonEvent(id, { type: "rubric", at: now });

  // Stamped with the end time, as a rebuild from disk would stamp it.
  const reviewEvent = lessonReviewEvent(session, verdict.correct, session.endedAt ?? now);
  appendReviewEvents([reviewEvent]);
  const nextDue = nextDueLine(session, now);
  push(sessionChannel(id), "rubric", {
    lesson: true,
    rubric,
    verdict,
    focus: session.focus,
    notesHtml: renderMarkdown(input.notesMd),
    nextDue,
    // What a drill kept hidden comes out now.
    ...(session.exerciseKind === "mutation" || session.exerciseKind === "refactor"
      ? { survivors: drillSurvivors(session) }
      : {}),
    ...(drillRevealOrNull(session) ?? {}),
  });
  pushPhase(session);
  notifyDashboard(id);
  return { session, reviewEvent, nextDue };
}

/** End a lesson without a debrief; a miss for the lesson unless `interrupted`. */
export function abandonLesson(id: string, reason: string, now = Date.now()): LessonRecordOutcome {
  const before = readLesson(id);
  if (before.phase === "done") throw new FlowError(409, "This lesson is already finished");
  const trimmed = reason.trim() || "abandoned";
  const session = updateLesson(id, (s) => {
    s.phase = "done";
    s.endedAt = s.endedAt ?? now;
    s.abandonedReason = trimmed;
  });
  appendLessonEvent(id, { type: "abandoned", reason: trimmed, at: now });
  const reviewEvent =
    trimmed === "interrupted" ? null : lessonReviewEvent(session, false, session.endedAt ?? now);
  if (reviewEvent) appendReviewEvents([reviewEvent]);
  pushPhase(session);
  notifyDashboard(id);
  return { session, reviewEvent, nextDue: reviewEvent ? nextDueLine(session, now) : "" };
}

function nextDueLine(session: LessonSession, now: number): string {
  const item = reviewItems().find((i) => i.kind === "lesson" && i.id === session.lesson);
  const title = findLesson(session.lesson)?.lesson.title ?? session.lessonTitle;
  return item ? `${title} comes back for review ${relativeDay(item.dueAt, now)}.` : "";
}

function pushPhase(session: LessonSession): void {
  const payload: { phase: string; startedAt?: number; endedAt?: number; timerMs: number } = {
    phase: session.phase,
    timerMs: session.timerMs,
  };
  if (session.startedAt !== undefined) payload.startedAt = session.startedAt;
  if (session.endedAt !== undefined) payload.endedAt = session.endedAt;
  push(sessionChannel(session.id), "phase", payload);
}

function drillRevealOrNull(session: LessonSession): { reveal: DrillReveal } | null {
  const reveal = drillReveal(session);
  return reveal ? { reveal } : null;
}
