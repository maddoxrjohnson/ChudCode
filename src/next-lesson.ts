/**
 * next-lesson.ts: the Next lesson button, under a lesson's debrief and on the dashboard.
 *
 * It works like the Next problem button (next-up.ts): lessons are written by the
 * agent, so a press becomes a pending request the listening interviewer answers by
 * starting the next lesson, which sends the waiting pages to it. After a debrief the
 * interviewer writes the next lesson's exercise ahead of time and stays a while, so
 * a press usually opens a validated exercise at once.
 */

import { loadCurriculumProgress } from "./curriculum.ts";
import { emitNextLessonRequest, type NextLessonRequest } from "./server/hooks.ts";
import { DASHBOARD_CHANNEL, push, sessionChannel } from "./server/sse.ts";
import { listExercises } from "./store/exercises.ts";
import { listLessons, readLessonEvents, type LessonSession } from "./store/lessons.ts";

/** How long a press waits for the interviewer, and how long it stays after a debrief. */
export const NEXT_LESSON_TTL_MS = 15 * 60_000;
export const LESSON_WINDOW_MS = 10 * 60_000;

/** The roadmap-style key the shared button runtime matches rows by. */
export const LESSONS_KEY = "lessons";

export interface NextLesson {
  lesson: string;
  title: string;
  module: string;
  moduleName: string;
  /** A validated exercise for it the learner has not seen, if one is written. */
  prepared: string | null;
}

let pending: NextLessonRequest | null = null;

/** The next lesson in the curriculum, or null when every teachable lesson is passed. */
export function nextLesson(): NextLesson | null {
  const progress = loadCurriculumProgress();
  if (!progress.next) return null;
  const { module, lesson } = progress.next;
  const seen = new Set(
    listLessons(Number.MAX_SAFE_INTEGER)
      .filter((s) => s.lesson === lesson.id)
      .map((s) => s.exercise),
  );
  const prepared = listExercises({ lesson: lesson.id }).find(
    (e) => e.validatedAt !== undefined && !seen.has(e.slug),
  );
  return {
    lesson: lesson.id,
    title: lesson.title,
    module: module.id,
    moduleName: module.name,
    prepared: prepared?.slug ?? null,
  };
}

/** The stretch after a lesson debrief while the interviewer keeps listening. */
export function lessonWindow(
  sessions: LessonSession[] = listLessons(1),
  now = Date.now(),
): { title: string; leftMs: number } | null {
  const latest = sessions[0];
  if (!latest || latest.phase !== "done" || !latest.rubric) return null;
  const scored = readLessonEvents(latest.id)
    .filter((e) => e.type === "rubric")
    .pop()?.at;
  if (scored === undefined) return null;
  const leftMs = scored + LESSON_WINDOW_MS - now;
  return leftMs > 0 ? { title: latest.lessonTitle, leftMs } : null;
}

export function pendingNextLesson(now = Date.now()): NextLessonRequest | null {
  if (pending && now - pending.at > NEXT_LESSON_TTL_MS) pending = null;
  return pending;
}

/** Record a press and tell the host. A second press while one is pending changes nothing. */
export function requestNextLesson(from?: string, now = Date.now()): NextLessonRequest {
  const current = pendingNextLesson(now);
  if (current) return current;
  const request: NextLessonRequest = { at: now, ...(from ? { from } : {}) };
  pending = request;
  for (const channel of channelsFor(request))
    push(channel, "next", { pending: { roadmap: LESSONS_KEY, at: now } });
  emitNextLessonRequest(request);
  return request;
}

/** A lesson session was created: send every page waiting on the press to it. */
export function resolveNextLesson(session: LessonSession, now = Date.now()): void {
  const request = pendingNextLesson(now);
  if (!request) return;
  pending = null;
  const payload = { sessionId: session.id, url: `/s/${session.id}` };
  for (const channel of channelsFor(request)) push(channel, "next_session", payload);
}

export function clearNextLesson(): void {
  pending = null;
}

function channelsFor(request: NextLessonRequest): string[] {
  return [DASHBOARD_CHANNEL, ...(request.from ? [sessionChannel(request.from)] : [])];
}
