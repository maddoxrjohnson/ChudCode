/**
 * The review log: append-only on disk, scheduled with the configured intervals, and
 * reproducible from the sessions that produced it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  eventsFromSessions,
  rebuildReviewLog,
  recordSession,
  abandonSession,
} from "../src/flow.ts";
import { DAY_MS, type ReviewEvent } from "../src/review.ts";
import { writeJson } from "../src/store/json.ts";
import { configFile } from "../src/store/paths.ts";
import {
  appendReviewEvents,
  readReviewEvents,
  reviewItems,
  rewriteReviewEvents,
} from "../src/store/review-events.ts";
import { createSession, readSession, updateSession, type Session } from "../src/store/sessions.ts";
import { makeFixture, seedExample, type Fixture } from "./helpers.ts";

let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
});
afterEach(() => fixture.cleanup());

const T0 = Date.UTC(2026, 9, 1, 12);

function event(key: string, day: number, correct: boolean): ReviewEvent {
  return { key, at: T0 + day * DAY_MS, correct, session: `20261001-1200-x-${day}` };
}

describe("the log on disk", () => {
  it("starts empty, appends in order, and can be rewritten", () => {
    expect(readReviewEvents()).toEqual([]);
    appendReviewEvents([event("pattern:stack", 0, false)]);
    appendReviewEvents([event("pattern:stack", 1, true), event("problem:a-b", 1, true)]);
    expect(readReviewEvents().map((e) => [e.key, e.correct])).toEqual([
      ["pattern:stack", false],
      ["pattern:stack", true],
      ["problem:a-b", true],
    ]);
    rewriteReviewEvents([event("pattern:heap", 2, true)]);
    expect(readReviewEvents().map((e) => e.key)).toEqual(["pattern:heap"]);
  });

  it("schedules with the default intervals unless config overrides them", () => {
    appendReviewEvents([event("pattern:stack", 0, true)]);
    expect(reviewItems()[0]?.dueAt).toBe(T0 + 3 * DAY_MS);
    writeJson(configFile(), { reviewIntervalsDays: [0.5, 1] });
    expect(reviewItems()[0]?.dueAt).toBe(T0 + DAY_MS);
  });
});

describe("rebuilding from sessions", () => {
  function session(id: string, patch: Partial<Session>): Session {
    return {
      id,
      problem: "window-sum",
      problemTitle: "Largest Window Sum",
      patterns: ["sliding-window", "arrays-hashing"],
      difficulty: "easy",
      mode: "interview",
      language: "python",
      timerMs: 60_000,
      createdAt: T0,
      phase: "done",
      hintsUsed: [1],
      submissions: 1,
      ...patch,
    };
  }

  it("derives one event per key from recorded and abandoned sessions only", () => {
    const events = eventsFromSessions([
      session("20261001-1200-window-sum-0001", {
        startedAt: T0,
        endedAt: T0 + 5 * 60_000,
        verdict: { correct: true, allPassed: true, withinTime: true, complexityOk: true },
      }),
      session("20261001-1200-window-sum-0002", {
        createdAt: T0 - DAY_MS,
        abandonedReason: "gave up",
      }),
      session("20261001-1200-window-sum-0003", { abandonedReason: "interrupted" }),
      session("20261001-1200-window-sum-0004", { phase: "coding", startedAt: T0 }),
    ]);
    expect(events.map((e) => `${e.session.slice(-4)} ${e.key} ${e.correct}`)).toEqual([
      "0002 pattern:sliding-window false",
      "0002 pattern:arrays-hashing false",
      "0002 problem:window-sum false",
      "0001 pattern:sliding-window true",
      "0001 pattern:arrays-hashing true",
      "0001 problem:window-sum true",
    ]);
    expect(events[0]?.at).toBe(T0 - DAY_MS);
    expect(events[3]).toMatchObject({ at: T0 + 5 * 60_000, hintsUsed: 1, timeMs: 5 * 60_000 });
  });

  it("reproduces the log that recording wrote, stamped with the sessions' end times", () => {
    seedExample();
    const make = () =>
      createSession({
        problem: "window-sum",
        problemTitle: "Largest Window Sum",
        patterns: ["sliding-window"],
        difficulty: "easy",
        mode: "interview",
        timerMs: 60_000,
      }).id;
    const solved = make();
    updateSession(solved, (s) => {
      s.startedAt = T0;
      s.lastResult = { status: "ok", passed: 12, total: 12 };
      s.submissions = 1;
    });
    recordSession(
      solved,
      {
        rubric: { correctness: 4, communication: 3, complexity: 3, codeQuality: 3, time: 4 },
        complexityOk: true,
        notesMd: "Fine.",
        strengths: [],
        improvements: [],
      },
      T0 + 10 * 60_000,
    );
    const quit = make();
    abandonSession(quit, "gave up", T0 + 20 * 60_000);
    abandonSession(make(), "interrupted", T0 + 30 * 60_000);

    const original = readReviewEvents();
    expect(original).toHaveLength(4);
    rewriteReviewEvents([]);
    const rebuilt = rebuildReviewLog();
    expect(readReviewEvents()).toEqual(rebuilt);
    expect(rebuilt).toEqual([...original].sort((a, b) => a.at - b.at));
    expect(readSession(quit).endedAt).toBe(T0 + 20 * 60_000);
  });
});
