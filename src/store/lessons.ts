/**
 * lessons.ts: one agentic-coding lesson session on disk.
 *
 *   lessons/<id>/
 *     session.json      state the page and the interviewer read
 *     events.jsonl      everything that happened, in order
 *     draft.md          the answer box's latest autosave
 *     answers/NN.md     each submitted answer
 *
 * Lesson sessions live beside interview sessions, not among them, so nothing that
 * lists, scores, or recovers interviews can pick one up by accident. They share the
 * session id format, the phases, and the chat event shape.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { makeKey, type ReviewEvent } from "../review.ts";
import { appendJsonl, readJson, readJsonl, readText, writeJson, writeText } from "./json.ts";
import { isDir, isValidSessionId, lessonDir, lessonsDir } from "./paths.ts";
import { generateSessionId, type Phase, type SessionEvent } from "./sessions.ts";

export const EXERCISE_KINDS = ["design-review"] as const;
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

export interface LessonRubric extends LessonScores {
  notesMd: string;
  strengths: string[];
  improvements: string[];
}

export interface LessonVerdict {
  correct: boolean;
  /** Every dimension the lesson focuses on scored 2 or more. */
  rubricOk: boolean;
  /** At least one answer was submitted before the debrief. */
  answered: boolean;
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
  | { at: number; type: "answer"; number: number; chars: number };

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
  while (isDir(lessonDir(id))) id = generateSessionId(input.exercise, now);
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
