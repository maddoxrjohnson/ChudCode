/**
 * Spaced review: the Leitner schedule derived from session verdicts.
 */

import { describe, expect, it } from "vitest";

import {
  DAY_MS,
  dueText,
  makeKey,
  nextBox,
  parseKey,
  pickReviewItems,
  relativeDay,
  scheduleItems,
  streak,
  summarize,
  type ReviewEvent,
} from "../src/review.ts";

const T0 = Date.UTC(2026, 0, 1);

function event(key: string, day: number, correct: boolean, extra: Partial<ReviewEvent> = {}) {
  return {
    key,
    at: T0 + day * DAY_MS,
    correct,
    session: `20260101-0900-${key.split(":")[1]}-${day}`,
    ...extra,
  };
}

describe("keys", () => {
  it("builds and parses pattern and problem keys", () => {
    expect(makeKey("pattern", "sliding-window")).toBe("pattern:sliding-window");
    expect(parseKey("problem:window-sum")).toEqual({ kind: "problem", id: "window-sum" });
    expect(makeKey("lesson", "plan-before-code")).toBe("lesson:plan-before-code");
  });

  it("rejects malformed keys and ids", () => {
    expect(() => parseKey("topic:foo")).toThrow(/Invalid review key/);
    expect(() => parseKey("pattern:")).toThrow(/Invalid review key/);
    expect(() => makeKey("pattern", "Sliding Window")).toThrow(/Invalid review id/);
    expect(() => makeKey("problem", "../etc")).toThrow(/Invalid review id/);
  });
});

describe("nextBox", () => {
  it("moves up on a correct verdict and back to the start on a wrong one", () => {
    expect(nextBox(0, true)).toBe(1);
    expect(nextBox(3, false)).toBe(0);
    expect(nextBox(2, true)).toBe(3);
    expect(nextBox(4, true)).toBe(4);
  });

  it("caps at the last box of a custom schedule", () => {
    expect(nextBox(1, true, [1, 2])).toBe(1);
  });
});

describe("scheduleItems", () => {
  it("builds one item per key, scheduled from its last verdict", () => {
    const [item] = scheduleItems([
      event("pattern:two-pointers", 0, true),
      event("pattern:two-pointers", 3, true, { difficulty: "medium" }),
    ]);
    expect(item).toMatchObject({
      key: "pattern:two-pointers",
      kind: "pattern",
      id: "two-pointers",
      box: 2,
      attempts: 2,
      correctStreak: 2,
      lastDifficulty: "medium",
    });
    expect(item?.dueAt).toBe(T0 + 3 * DAY_MS + 7 * DAY_MS);
  });

  it("orders events by time, whatever order they arrive in", () => {
    const [item] = scheduleItems([
      event("problem:window-sum", 5, false),
      event("problem:window-sum", 0, true),
    ]);
    expect(item?.box).toBe(0);
    expect(item?.lastCorrect).toBe(false);
    expect(item?.correctStreak).toBe(0);
  });

  it("sorts items by due time", () => {
    const items = scheduleItems([
      event("pattern:graphs", 10, true),
      event("pattern:stack", 0, false),
    ]);
    expect(items.map((item) => item.id)).toEqual(["stack", "graphs"]);
  });

  it("honours a compressed interval schedule", () => {
    const [item] = scheduleItems([event("pattern:heap", 0, true)], { intervalsDays: [0.5, 1] });
    expect(item?.dueAt).toBe(T0 + DAY_MS);
  });

  it("rejects an empty or non-positive schedule", () => {
    expect(() => scheduleItems([], { intervalsDays: [] })).toThrow(/positive/);
    expect(() => scheduleItems([], { intervalsDays: [1, 0] })).toThrow(/positive/);
  });

  it("omits lastDifficulty when the last event has none", () => {
    const [item] = scheduleItems([event("pattern:heap", 0, true)]);
    expect(item).not.toHaveProperty("lastDifficulty");
  });
});

describe("pickReviewItems", () => {
  const items = scheduleItems([
    event("pattern:arrays-hashing", 0, false),
    event("pattern:sliding-window", 1, false),
    event("problem:window-sum", 1, false),
    event("pattern:graphs", 30, true),
  ]);

  it("takes due items only, most overdue first", () => {
    const picked = pickReviewItems(items, T0 + 5 * DAY_MS, 10);
    expect(picked.map((item) => item.key)).toEqual([
      "pattern:arrays-hashing",
      "pattern:sliding-window",
      "problem:window-sum",
    ]);
  });

  it("can restrict to one kind", () => {
    const picked = pickReviewItems(items, T0 + 5 * DAY_MS, 10, "pattern");
    expect(picked.map((item) => item.id)).toEqual(["arrays-hashing", "sliding-window"]);
  });

  it("respects the limit", () => {
    expect(pickReviewItems(items, T0 + 5 * DAY_MS, 1)).toHaveLength(1);
    expect(pickReviewItems(items, T0 + 5 * DAY_MS, 0)).toHaveLength(0);
  });
});

describe("summarize", () => {
  it("counts what is due, what is soon, and what is mastered", () => {
    const items = scheduleItems([
      event("pattern:stack", 0, false),
      event("pattern:trees", 0, true),
      ...[0, 2, 6, 14].map((day) => event("pattern:dp-1d", day, true)),
    ]);
    const now = T0 + 1.5 * DAY_MS;
    expect(summarize(items, now)).toEqual({
      total: 3,
      due: 1,
      dueSoon: 1,
      mastered: 1,
      nextDueAt: T0 + 3 * DAY_MS,
    });
  });

  it("reports no next due time when everything is due", () => {
    const items = scheduleItems([event("pattern:stack", 0, false)]);
    expect(summarize(items, T0 + 10 * DAY_MS).nextDueAt).toBeNull();
  });
});

describe("relativeDay", () => {
  it("says when, in words", () => {
    expect(relativeDay(T0, T0)).toBe("today");
    expect(relativeDay(T0 + DAY_MS, T0)).toBe("tomorrow");
    expect(relativeDay(T0 - DAY_MS, T0)).toBe("yesterday");
    expect(relativeDay(T0 + 5 * DAY_MS, T0)).toBe("in 5 days");
    expect(relativeDay(T0 - 3 * DAY_MS, T0)).toBe("3 days ago");
  });
});

describe("dueText", () => {
  it("says when something is due or how overdue it is", () => {
    expect(dueText(T0, T0)).toBe("due today");
    expect(dueText(T0 + DAY_MS, T0)).toBe("due tomorrow");
    expect(dueText(T0 + 4 * DAY_MS, T0)).toBe("due in 4 days");
    expect(dueText(T0 - 0.3 * DAY_MS, T0)).toBe("due today");
    expect(dueText(T0 - DAY_MS, T0)).toBe("1 day overdue");
    expect(dueText(T0 - 6 * DAY_MS, T0)).toBe("6 days overdue");
  });
});

describe("streak", () => {
  const noon = (day: number) => T0 + day * DAY_MS + 12 * 60 * 60 * 1000;

  it("counts consecutive days ending today", () => {
    expect(streak([noon(0), noon(1), noon(2)], noon(2))).toBe(3);
  });

  it("keeps a streak alive until today is over", () => {
    expect(streak([noon(0), noon(1)], noon(2))).toBe(2);
    expect(streak([noon(0), noon(1)], noon(3))).toBe(0);
  });

  it("stops at a gap and ignores order and duplicates", () => {
    expect(streak([noon(3), noon(0), noon(3), noon(2)], noon(3))).toBe(2);
  });

  it("is zero with no sessions", () => {
    expect(streak([], noon(0))).toBe(0);
  });

  it("uses the local day boundary when an offset is given", () => {
    // 23:30 UTC on day 0 is 00:30 on day 1 in UTC+1.
    const lateNight = T0 + 23.5 * 60 * 60 * 1000;
    expect(streak([lateNight], noon(1), 60)).toBe(1);
    expect(streak([lateNight], noon(1), 0)).toBe(1);
    expect(streak([lateNight], noon(2), 60)).toBe(1);
    expect(streak([lateNight], noon(2), 0)).toBe(0);
  });
});
