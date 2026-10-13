/**
 * The candidate's standing: every pattern's box, what is due, the streak.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProgress, loadProgress } from "../src/progress.ts";
import { DAY_MS, scheduleItems, type ReviewEvent } from "../src/review.ts";
import { writeJson } from "../src/store/json.ts";
import { configFile } from "../src/store/paths.ts";
import { patterns } from "../src/store/problems.ts";
import { appendReviewEvents } from "../src/store/review-events.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

const T0 = Date.UTC(2026, 9, 10, 12);

function event(key: string, day: number, correct: boolean, extra: Partial<ReviewEvent> = {}) {
  return { key, at: T0 + day * DAY_MS, correct, session: `20261010-1200-s-${day}`, ...extra };
}

const TAXONOMY = [
  { id: "stack", name: "Stack", blurb: "", typicalComplexity: "" },
  { id: "heap", name: "Heap", blurb: "", typicalComplexity: "" },
  { id: "graphs", name: "Graphs", blurb: "", typicalComplexity: "" },
  { id: "tries", name: "Tries", blurb: "", typicalComplexity: "" },
];

describe("buildProgress", () => {
  const events = [
    event("pattern:stack", -5, false, { difficulty: "medium" }),
    event("problem:bracket-run", -5, false),
    ...[-40, -30, -20, -6].map((day) => event("pattern:heap", day, true)),
    event("pattern:graphs", -1, true),
    event("problem:island-count", -1, true),
  ];
  const progress = buildProgress({
    items: scheduleItems(events),
    taxonomy: TAXONOMY,
    sessionTimes: events.map((e) => e.at),
    now: T0,
  });

  it("places every pattern in the taxonomy, exercised or not, in taxonomy order", () => {
    expect(progress.patterns.map((p) => [p.id, p.box, p.due, p.mastered])).toEqual([
      ["stack", 0, true, false],
      ["heap", 4, false, true],
      ["graphs", 1, false, false],
      ["tries", null, false, false],
    ]);
    expect(progress.patterns[0]).toMatchObject({
      name: "Stack",
      attempts: 1,
      correctStreak: 0,
      lastCorrect: false,
      lastAt: T0 - 5 * DAY_MS,
      lastSession: "20261010-1200-s--5",
    });
    expect(progress.patterns[3]).toMatchObject({ attempts: 0, lastCorrect: null, lastAt: null });
  });

  it("lists what is due, most overdue first, and what comes soon", () => {
    expect(progress.due.map((item) => item.id)).toEqual(["stack"]);
    expect(progress.dueSoon.map((item) => item.id)).toEqual(["graphs"]);
    expect(progress.summary).toEqual({
      total: 3,
      due: 1,
      dueSoon: 1,
      mastered: 1,
      nextDueAt: T0 + 2 * DAY_MS,
    });
  });

  it("keeps problems apart from patterns", () => {
    expect([...progress.problems.keys()].sort()).toEqual(["bracket-run", "island-count"]);
    expect(progress.problems.get("island-count")?.lastCorrect).toBe(true);
    expect(progress.due.every((item) => item.kind === "pattern")).toBe(true);
  });

  it("counts the streak from the session days, in the given time zone", () => {
    // Sessions on days -6, -5, -1 relative to T0 (noon UTC): yesterday only, so 1.
    expect(progress.streakDays).toBe(1);
    const dense = buildProgress({
      items: [],
      taxonomy: TAXONOMY,
      sessionTimes: [T0 - 2 * DAY_MS, T0 - DAY_MS, T0],
      now: T0,
      tzOffsetMinutes: 600,
    });
    expect(dense.streakDays).toBe(3);
    expect(dense.intervalsDays).toEqual([1, 3, 7, 21, 60]);
  });
});

describe("loadProgress", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = makeFixture();
  });
  afterEach(() => fixture.cleanup());

  it("reads the log, the taxonomy, and the configured intervals", () => {
    appendReviewEvents([event("pattern:sliding-window", -2, true)]);
    const standard = loadProgress(T0);
    expect(standard.patterns).toHaveLength(patterns().length);
    expect(standard.patterns.find((p) => p.id === "sliding-window")).toMatchObject({
      box: 1,
      due: false,
      dueAt: T0 + DAY_MS,
    });
    expect(standard.due).toEqual([]);
    expect(standard.dueSoon.map((item) => item.id)).toEqual(["sliding-window"]);

    writeJson(configFile(), { reviewIntervalsDays: [1, 1] });
    const compressed = loadProgress(T0);
    expect(compressed.intervalsDays).toEqual([1, 1]);
    expect(compressed.due.map((item) => item.id)).toEqual(["sliding-window"]);
  });
});
