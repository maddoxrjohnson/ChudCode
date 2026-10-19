/**
 * lessons.ts: one agentic-coding lesson session on disk.
 *
 *   lessons/<id>/
 *     session.json      state the page and the interviewer read
 *     events.jsonl      everything that happened, in order
 *     draft.md          the answer box's latest autosave
 *     answers/NN.md     each submitted answer
 *     lab/NN.json       for a lab, what inspect_lab read for answer NN
 *     grades/NN.json    for a drill, the full grading report of answer NN
 *
 * Lesson sessions live beside interview sessions, not among them, so nothing that
 * lists, scores, or recovers interviews can pick one up by accident. They share the
 * session id format, the phases, and the chat event shape.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { makeKey, type ReviewEvent } from "../review.ts";
import { appendJsonl, readJson, readJsonl, readText, writeJson, writeText } from "./json.ts";
import { isDir, isValidSessionId, lessonDir, lessonsDir, sessionDir } from "./paths.ts";
import { generateSessionId, type Phase, type SessionEvent } from "./sessions.ts";

export const EXERCISE_KINDS = [
  "design-review",
  "lab",
  "mutation",
  "flaw-review",
  "cache-plan",
  "refactor",
  "transcript",
] as const;
export type ExerciseKind = (typeof EXERCISE_KINDS)[number];

/** The five lesson dimensions; `null` means the lesson does not exercise it. */
export const LESSON_DIMENSIONS = [
  "decomposition",
  "verification",
  "contextCost",
  "safety",
  "delegation",
] as const;
export type LessonDimension = (typeof LESSON_DIMENSIONS)[number];

export type LessonScores = Record<LessonDimension, number | null>;

export const CHECKLIST_STATUSES = ["met", "partial", "missing"] as const;
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];

/** The interviewer's verdict on one lab checklist item. */
export interface ChecklistResult {
  id: string;
  status: ChecklistStatus;
  note: string;
}

export interface LessonRubric extends LessonScores {
  notesMd: string;
  strengths: string[];
  improvements: string[];
  /** For a lab: one result per checklist item of the lesson. */
  checklist?: ChecklistResult[];
}

export interface LessonVerdict {
  correct: boolean;
  /** Every dimension the lesson focuses on scored 2 or more. */
  rubricOk: boolean;
  /** At least one answer was submitted before the debrief. */
  answered: boolean;
  /** For a lab: the project was read with inspect_lab, and no checklist item is missing. */
  inspected?: boolean;
  checklistOk?: boolean;
  /** For a drill: the latest grading passed its gate. */
  gatePassed?: boolean;
}

/** What the page may see of a drill's grading: counts, never which bugs survived. */
export interface DrillGrade {
  /** The answer number the grade was stored as. */
  number: number;
  at: number;
  tests: number;
  killed: number;
  mutants: number;
  /** Test functions that assert nothing. */
  assertFree: number;
  problems: string[];
  passed: boolean;
}

/** What the page may see of a flaw review's grading: counts, not which flaws. */
export interface ReviewGrade {
  number: number;
  at: number;
  marks: number;
  found: number;
  flaws: number;
  criticalMissed: number;
  falseAlarms: number;
  problems: string[];
  passed: boolean;
}

/** A cache plan's simulated cost against the best plan the exercise knows. */
export interface CacheGrade {
  number: number;
  at: number;
  /** Dollars. */
  cost: number;
  referenceCost: number;
  naiveCost: number;
  uncachedCost: number;
  ratio: number;
  hits: number;
  requests: number;
  readTokens: number;
  writeTokens: number;
  uncachedTokens: number;
  passed: boolean;
}

/** What the page may see of a refactor's grading. */
export interface RefactorGrade {
  number: number;
  at: number;
  testsFirst: boolean;
  killed: number;
  mutants: number;
  behaviourKept: boolean;
  ownTestsPass: boolean;
  apiSame: boolean;
  before: { lines: number; longestFunction: number; maxNesting: number };
  after: { lines: number; longestFunction: number; maxNesting: number };
  problems: string[];
  passed: boolean;
}

export interface TranscriptSubmission {
  /** The listing's token for the file; the path is resolved again on every read. */
  id: string;
  project: string;
  submittedAt: number;
  answer: number;
  inspections: number;
}

/** A graded attempt counter with the latest public grade. */
export interface Attempts<G> {
  grades: number;
  latest?: G;
}

export interface DrillState {
  workspace: string;
  module: string;
  grades: number;
  latest?: DrillGrade;
}

/** The project a lab submission points at, as the learner consented to it. */
export interface LabSubmission {
  root: string;
  /** The files the page listed when the learner consented. */
  files: string[];
  submittedAt: number;
  /** The answer number this submission was stored as. */
  answer: number;
  /** How many times inspect_lab has read it. */
  inspections: number;
}

export interface LessonSession {
  id: string;
  kind: "lesson";
  lesson: string;
  lessonTitle: string;
  module: string;
  exercise: string;
  exerciseKind: ExerciseKind;
  /** The lesson's rubric focus when the session was created, for the verdict. */
  focus: LessonDimension[];
  timerMs: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  phase: Phase;
  answers: number;
  /** For a lab: the latest project submission. */
  lab?: LabSubmission;
  /** For a drill: its workspace and latest grade. */
  drill?: DrillState;
  /** For a flaw review: its graded reviews. */
  review?: Attempts<ReviewGrade>;
  /** For a cache plan: its simulated plans. */
  cachePlan?: Attempts<CacheGrade>;
  /** For a transcript review: the session log the learner chose and consented to. */
  transcript?: TranscriptSubmission;
  /** For a refactor drill: its graded attempts (the workspace is in `drill`). */
  refactor?: Attempts<RefactorGrade>;
  rubric?: LessonRubric;
  verdict?: LessonVerdict;
  abandonedReason?: string;
}

/** The interview session events a lesson reuses, plus a submitted answer. */
export type LessonEvent =
  | Extract<
      SessionEvent,
      { type: "created" | "started" | "message" | "timeout" | "done" | "rubric" | "abandoned" }
    >
  | { at: number; type: "answer"; number: number; chars: number }
  | { at: number; type: "lab"; number: number; root: string; files: number }
  | { at: number; type: "inspected"; number: number; files: number; lints: number }
  | {
      at: number;
      type: "graded";
      number: number;
      killed: number;
      mutants: number;
      passed: boolean;
    }
  | { at: number; type: "reviewed"; number: number; found: number; flaws: number; passed: boolean }
  | { at: number; type: "planned"; number: number; ratio: number; passed: boolean };

export interface NewLesson {
  lesson: string;
  lessonTitle: string;
  module: string;
  exercise: string;
  exerciseKind: ExerciseKind;
  focus: LessonDimension[];
  timerMs: number;
}

export function createLesson(input: NewLesson, now = Date.now()): LessonSession {
  let id = generateSessionId(input.exercise, now);
  // Unique across interviews too: the page channel and the URL are keyed by id alone.
  while (isDir(lessonDir(id)) || isDir(sessionDir(id))) id = generateSessionId(input.exercise, now);
  const session: LessonSession = {
    id,
    kind: "lesson",
    lesson: input.lesson,
    lessonTitle: input.lessonTitle,
    module: input.module,
    exercise: input.exercise,
    exerciseKind: input.exerciseKind,
    focus: [...input.focus],
    timerMs: input.timerMs,
    createdAt: now,
    phase: "briefing",
    answers: 0,
  };
  writeLesson(session);
  appendLessonEvent(id, { type: "created", at: now });
  return session;
}

export function lessonExists(id: string): boolean {
  return isValidSessionId(id) && isDir(lessonDir(id));
}

export function readLesson(id: string): LessonSession {
  const session = readJson<LessonSession>(path.join(lessonDir(id), "session.json"));
  if (!session) throw new Error(`No lesson session named ${id}`);
  return session;
}

export function writeLesson(session: LessonSession): void {
  writeJson(path.join(lessonDir(session.id), "session.json"), session);
}

export function updateLesson(id: string, change: (session: LessonSession) => void): LessonSession {
  const session = readLesson(id);
  change(session);
  writeLesson(session);
  return session;
}

export function appendLessonEvent(id: string, event: LessonEvent): void {
  appendJsonl(path.join(lessonDir(id), "events.jsonl"), event);
}

export function readLessonEvents(id: string): LessonEvent[] {
  return readJsonl<LessonEvent>(path.join(lessonDir(id), "events.jsonl"));
}

export function readLessonDraft(id: string): string | null {
  return readText(path.join(lessonDir(id), "draft.md"));
}

export function writeLessonDraft(id: string, text: string): void {
  writeText(path.join(lessonDir(id), "draft.md"), text);
}

/** Store a submitted answer; returns its number (1-based). */
export function recordAnswer(id: string, text: string): number {
  const session = readLesson(id);
  const number = session.answers + 1;
  writeText(answerFile(id, number), text);
  session.answers = number;
  writeLesson(session);
  return number;
}

export function readAnswer(id: string, number: number): string | null {
  return readText(answerFile(id, number));
}

/** Where a drill's full grading report for answer `number` is kept. */
export function gradeFile(id: string, number: number): string {
  return path.join(lessonDir(id), "grades", `${String(number).padStart(2, "0")}.json`);
}

/** Where inspect_lab's snapshot of answer `number` is kept. */
export function labSnapshotFile(id: string, number: number): string {
  return path.join(lessonDir(id), "lab", `${String(number).padStart(2, "0")}.json`);
}

function answerFile(id: string, number: number): string {
  return path.join(lessonDir(id), "answers", `${String(number).padStart(2, "0")}.md`);
}

export function listLessons(limit = 50): LessonSession[] {
  const root = lessonsDir();
  if (!isDir(root)) return [];
  const sessions: LessonSession[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;
    const session = readJson<LessonSession>(path.join(root, entry.name, "session.json"));
    if (session) sessions.push(session);
  }
  return sessions.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

// ── Review events ─────────────────────────────────────────────────────────────

/** The one review event a scored or abandoned lesson implies: its lesson key. */
export function lessonReviewEvent(
  session: LessonSession,
  correct: boolean,
  now: number,
): ReviewEvent {
  const event: ReviewEvent = {
    key: makeKey("lesson", session.lesson),
    at: now,
    correct,
    session: session.id,
  };
  if (session.startedAt !== undefined && session.endedAt !== undefined) {
    event.timeMs = session.endedAt - session.startedAt;
  }
  return event;
}

/**
 * What finished lessons imply for the review log, as `eventsFromSessions` does for
 * interviews: the verdict once scored, a miss when abandoned for a reason that counts.
 */
export function eventsFromLessons(sessions: readonly LessonSession[]): ReviewEvent[] {
  const events: ReviewEvent[] = [];
  for (const session of sessions) {
    const at = session.endedAt ?? session.createdAt;
    if (session.verdict) events.push(lessonReviewEvent(session, session.verdict.correct, at));
    else if (session.abandonedReason !== undefined && session.abandonedReason !== "interrupted")
      events.push(lessonReviewEvent(session, false, at));
  }
  return events.sort((a, b) => a.at - b.at);
}
