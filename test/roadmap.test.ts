/**
 * Roadmaps: the NeetCode tree and Grind 75 weeks are built from the seed lists, stages
 * unlock as their requirements are half solved, and sessions count against the title
 * their problem mimics.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildRoadmapProgress,
  loadRoadmapProgress,
  nextItem,
  preparedProblem,
  roadmap,
  roadmapFor,
  roadmapAttempts,
  unlockThreshold,
  type RoadmapAttempt,
} from "../src/roadmap.ts";
import { listProblems, updateMeta, type ProblemMeta } from "../src/store/problems.ts";
import { createSession, updateSession, type Session } from "../src/store/sessions.ts";
import { makeFixture, seedExample, type Fixture } from "./helpers.ts";

const solved = (title: string, at = 1, correct = true): RoadmapAttempt => ({
  title,
  correct,
  at,
  session: `s-${at}`,
});

describe("roadmap", () => {
  it("builds NeetCode's tree over all 150 problems, in NeetCode's order", () => {
    const map = roadmap("neetcode150");
    expect(map.name).toBe("NeetCode 150");
    expect(map.stages).toHaveLength(18);
    expect(map.stages.reduce((n, s) => n + s.items.length, 0)).toBe(150);
    expect(map.stages[0]).toMatchObject({ id: "arrays-hashing", requires: [] });
    expect(map.stages[0]?.items.slice(0, 3).map((i) => i.title)).toEqual([
      "Contains Duplicate",
      "Valid Anagram",
      "Two Sum",
    ]);
    const byId = new Map(map.stages.map((s) => [s.id, s]));
    expect(byId.get("trees")?.requires).toEqual(["binary-search", "linked-list"]);
    expect(byId.get("advanced-graphs")?.requires).toEqual(["heap", "graphs"]);
    expect(byId.get("heap")?.name).toBe("Heap / Priority Queue");
  });

  it("builds Grind 75 as eight weeks, each requiring the one before", () => {
    const map = roadmap("grind75");
    expect(map.stages.map((s) => s.id)).toEqual(
      Array.from({ length: 8 }, (_, i) => `week-${i + 1}`),
    );
    expect(map.stages.reduce((n, s) => n + s.items.length, 0)).toBe(75);
    expect(map.stages[1]?.requires).toEqual(["week-1"]);
    expect(map.stages[0]?.items[0]?.title).toBe("Two Sum");
  });
});

describe("buildRoadmapProgress", () => {
  const map = roadmap("neetcode150");
  const arrays = map.stages[0]?.items.map((i) => i.title) ?? [];

  it("opens only the root stage and points at its first problem to begin with", () => {
    const progress = buildRoadmapProgress(map, []);
    expect(progress).toMatchObject({ solved: 0, total: 150 });
    expect(progress.stages.filter((s) => s.unlocked).map((s) => s.id)).toEqual(["arrays-hashing"]);
    expect(progress.next?.item.title).toBe("Contains Duplicate");
    expect(progress.stages[0]?.unlockAt).toBe(unlockThreshold(9));
    expect(unlockThreshold(9)).toBe(5);
  });

  it("unlocks a stage once half of every stage it requires is solved", () => {
    const four = buildRoadmapProgress(
      map,
      arrays.slice(0, 4).map((t, i) => solved(t, i)),
    );
    expect(four.stages.find((s) => s.id === "two-pointers")?.unlocked).toBe(false);
    const five = buildRoadmapProgress(
      map,
      arrays.slice(0, 5).map((t, i) => solved(t, i)),
    );
    const open = five.stages.filter((s) => s.unlocked).map((s) => s.id);
    expect(open).toEqual(["arrays-hashing", "two-pointers", "stack"]);
    // Trees needs both binary search and linked list, so one is not enough.
    expect(five.stages.find((s) => s.id === "trees")?.unlocked).toBe(false);
  });

  it("marks misses, keeps the latest attempt, and serves untried problems before misses", () => {
    const progress = buildRoadmapProgress(map, [
      solved("Contains Duplicate", 1, false),
      solved("contains duplicate", 2, false),
      solved("Valid Anagram", 3, true),
    ]);
    const [first, second] = progress.stages[0]?.items ?? [];
    expect(first).toMatchObject({ state: "missed", attempts: 2, lastAt: 2, lastSession: "s-2" });
    expect(second).toMatchObject({ state: "solved", attempts: 1 });
    expect(progress.next?.item.title).toBe("Two Sum");

    const allTried = buildRoadmapProgress(map, [
      ...arrays.map((t, i) => solved(t, i, i !== 0 && i !== 3)),
    ]);
    // Every root problem is tried, so the next new one is in a stage that opened.
    expect(allTried.next?.stage.id).toBe("two-pointers");
    expect(nextItem(allTried.stages, "arrays-hashing")?.item.title).toBe("Contains Duplicate");
    expect(nextItem(allTried.stages, "trees")).toBeNull();
  });

  it("has nothing next when every problem is solved", () => {
    const all = map.stages.flatMap((s) => s.items.map((i) => solved(i.title)));
    const progress = buildRoadmapProgress(map, all);
    expect(progress.solved).toBe(150);
    expect(progress.stages.every((s) => s.unlocked)).toBe(true);
    expect(progress.next).toBeNull();
  });
});

describe("roadmapAttempts", () => {
  const meta = (slug: string, mimicOf?: string) =>
    ({ slug, source: mimicOf ? { kind: "mimic", mimicOf } : { kind: "generated" } }) as ProblemMeta;
  const session = (id: string, problem: string, extra: Partial<Session>) =>
    ({ id, problem, createdAt: 10, ...extra }) as Session;
  const verdict = (correct: boolean) => ({
    correct,
    allPassed: correct,
    withinTime: true,
    complexityOk: true,
  });

  it("counts finished sessions on mimic problems against the title they name", () => {
    const attempts = roadmapAttempts(
      [
        session("a", "dupes", { verdict: verdict(true), endedAt: 50 }),
        session("b", "pairs", { verdict: verdict(false) }),
        session("c", "pairs", { abandonedReason: "ran out of ideas", endedAt: 60 }),
        session("d", "pairs", { abandonedReason: "interrupted" }),
        session("e", "pairs", {}),
        session("f", "invented", { verdict: verdict(true) }),
        session("g", "unknown-title", { verdict: verdict(true) }),
      ],
      [
        meta("dupes", "contains duplicate"),
        meta("pairs", "Two Sum"),
        meta("invented"),
        meta("unknown-title", "A Problem Nobody Lists"),
      ],
    );
    expect(attempts).toEqual([
      { title: "Contains Duplicate", correct: true, at: 50, session: "a" },
      { title: "Two Sum", correct: false, at: 10, session: "b" },
      { title: "Two Sum", correct: false, at: 60, session: "c" },
    ]);
  });
});

describe("loadRoadmapProgress", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = makeFixture();
  });
  afterEach(() => fixture.cleanup());

  it("reads sessions and problems from disk, and one solve counts on both lists", () => {
    seedExample();
    updateMeta("window-sum", { source: { kind: "mimic", mimicOf: "Two Sum" } });
    const s = createSession({
      problem: "window-sum",
      problemTitle: "Largest Window Sum",
      patterns: ["sliding-window"],
      difficulty: "easy",
      mode: "interview",
      timerMs: 35 * 60_000,
    });
    updateSession(s.id, (x) => {
      x.verdict = { correct: true, allPassed: true, withinTime: true, complexityOk: true };
      x.endedAt = x.createdAt + 1;
    });
    const neet = loadRoadmapProgress("neetcode150");
    const grind = loadRoadmapProgress("grind75");
    expect(neet.solved).toBe(1);
    expect(grind.solved).toBe(1);
    expect(grind.stages[0]?.items[0]).toMatchObject({ title: "Two Sum", state: "solved" });
    expect(grind.next?.item.title).toBe("Valid Parentheses");
  });

  it("finds a problem written ahead of time for a step, until it has been served", () => {
    seedExample();
    expect(preparedProblem("Contains Duplicate", listProblems())).toBeUndefined();
    updateMeta("window-sum", { source: { kind: "mimic", mimicOf: "contains duplicate" } });
    expect(preparedProblem("Contains Duplicate", listProblems())?.slug).toBe("window-sum");
    updateMeta("window-sum", { timesServed: 1 });
    expect(preparedProblem("Contains Duplicate", listProblems())).toBeUndefined();
  });
});

describe("roadmapFor", () => {
  it("puts a title on NeetCode 150 when it is there, and on Grind 75 otherwise", () => {
    expect(roadmapFor("Two Sum")).toBe("neetcode150");
    expect(roadmapFor("Ransom Note")).toBe("grind75");
    expect(roadmapFor("Not A Real Problem")).toBeUndefined();
  });
});
