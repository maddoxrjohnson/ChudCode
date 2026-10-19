/**
 * Lesson sessions: their own directory, answers on disk, and the review events they imply.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eventsFromDisk } from "../src/flow.ts";
import { loadProgress } from "../src/progress.ts";
import { DAY_MS } from "../src/review.ts";
import {
  createLesson,
  eventsFromLessons,
  lessonExists,
  listLessons,
  readAnswer,
  readLesson,
  readLessonDraft,
  readLessonEvents,
  recordAnswer,
  updateLesson,
  writeLessonDraft,
  type NewLesson,
} from "../src/store/lessons.ts";
import { appendReviewEvents } from "../src/store/review-events.ts";
import { listSessions, sessionExists } from "../src/store/sessions.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
});
afterEach(() => fixture.cleanup());

const T0 = Date.UTC(2026, 9, 18, 12);

const NEW: NewLesson = {
  lesson: "plan-before-code",
  lessonTitle: "Plan before the agent writes code",
  module: "planning",
  exercise: "plan-a-cli-tool",
  exerciseKind: "design-review",
  focus: ["decomposition", "verification"],
  timerMs: 30 * 60_000,
};

describe("lesson sessions on disk", () => {
  it("live apart from interview sessions", () => {
    const lesson = createLesson(NEW, T0);
    expect(lesson.id).toMatch(/^20261018-1200-plan-a-cli-tool-[0-9a-f]{4}$/);
    expect(lessonExists(lesson.id)).toBe(true);
    expect(sessionExists(lesson.id)).toBe(false);
    expect(listSessions()).toEqual([]);
    expect(listLessons().map((l) => l.id)).toEqual([lesson.id]);
    expect(readLesson(lesson.id)).toMatchObject({
      kind: "lesson",
      phase: "briefing",
      answers: 0,
      focus: ["decomposition", "verification"],
    });
    expect(readLessonEvents(lesson.id)).toEqual([{ type: "created", at: T0 }]);
  });

  it("keeps a draft and numbers each answer", () => {
    const { id } = createLesson(NEW, T0);
    expect(readLessonDraft(id)).toBeNull();
    writeLessonDraft(id, "## Plan\n- one");
    expect(readLessonDraft(id)).toBe("## Plan\n- one");
    expect(recordAnswer(id, "first")).toBe(1);
    expect(recordAnswer(id, "second")).toBe(2);
    expect(readAnswer(id, 1)).toBe("first");
    expect(readAnswer(id, 3)).toBeNull();
    expect(readLesson(id).answers).toBe(2);
  });

  it("rejects ids that are not session ids", () => {
    expect(lessonExists("../sessions")).toBe(false);
    expect(() => readLesson("nope")).toThrow();
  });
});

describe("lesson review events", () => {
  it("are one lesson key per finished lesson; interrupted ones and open ones imply nothing", () => {
    const scored = updateLesson(createLesson(NEW, T0).id, (s) => {
      s.phase = "done";
      s.startedAt = T0;
      s.endedAt = T0 + 20 * 60_000;
      s.verdict = { correct: true, rubricOk: true, answered: true };
    });
    const quit = updateLesson(createLesson(NEW, T0 + 1).id, (s) => {
      s.phase = "done";
      s.endedAt = T0 + DAY_MS;
      s.abandonedReason = "gave up";
    });
    updateLesson(createLesson(NEW, T0 + 2).id, (s) => {
      s.phase = "done";
      s.abandonedReason = "interrupted";
    });
    createLesson(NEW, T0 + 3);

    expect(eventsFromLessons(listLessons())).toEqual([
      {
        key: "lesson:plan-before-code",
        at: T0 + 20 * 60_000,
        correct: true,
        session: scored.id,
        timeMs: 20 * 60_000,
      },
      { key: "lesson:plan-before-code", at: T0 + DAY_MS, correct: false, session: quit.id },
    ]);
    expect(eventsFromDisk()).toHaveLength(2);
  });

  it("leave interview standing alone", () => {
    appendReviewEvents([
      { key: "lesson:plan-before-code", at: T0, correct: true, session: "20261018-1200-x-0001" },
    ]);
    const progress = loadProgress(T0 + 60_000);
    expect(progress.sessionsScored).toBe(0);
    expect(progress.summary.total).toBe(0);
    expect(progress.streakDays).toBe(0);
  });
});
