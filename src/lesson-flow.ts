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
import { relativeDay, type ReviewEvent } from "./review.ts";
import { emitCandidateEvent } from "./server/hooks.ts";
import { push, sessionChannel } from "./server/sse.ts";
import { publicExercise, readExercise, type PublicExercise } from "./store/exercises.ts";
import {
  appendLessonEvent,
  CHECKLIST_STATUSES,
  labSnapshotFile,
  LESSON_DIMENSIONS,
  lessonReviewEvent,
  readLesson,
  readLessonDraft,
  readLessonEvents,
  recordAnswer,
  updateLesson,
  writeLessonDraft,
  type ChecklistResult,
  type LessonEvent,
  type LessonRubric,
  type LessonScores,
  type LessonSession,
  type LessonVerdict,
} from "./store/lessons.ts";
import { writeJson } from "./store/json.ts";
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

function labLesson(session: LessonSession): Lesson {
  if (session.exerciseKind !== "lab") throw new FlowError(409, "This lesson is not a lab");
  const lesson = findLesson(session.lesson)?.lesson;
  if (!lesson?.labFiles?.length) throw new FlowError(409, "This lesson has no lab files");
  return lesson;
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
  const lesson = labLesson(readLesson(id));
  return listLabFiles(resolveRoot(projectPath), lesson.labFiles ?? []);
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
  const listing = listLabFiles(resolveRoot(projectPath), lesson.labFiles ?? []);
  if (listing.files.length === 0)
    throw new FlowError(
      400,
      `None of the files this lab reads are in ${listing.root}: ${(lesson.labFiles ?? []).join(", ")}.`,
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
  if (session.exerciseKind !== "lab") return { correct: rubricOk && answered, rubricOk, answered };
  // A lab passes on what was read, so it must have been read, and nothing on the
  // checklist may be missing outright.
  const inspected = (session.lab?.inspections ?? 0) > 0;
  const checklistOk = (checklist ?? []).every((c) => c.status !== "missing");
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
  if (before.exerciseKind === "lab") {
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
