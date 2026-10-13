/**
 * The words the interviewer receives: self-contained, naming the next tool.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProgress } from "../src/progress.ts";
import { DAY_MS, scheduleItems } from "../src/review.ts";
import { patterns } from "../src/store/problems.ts";
import {
  BRIEF_TREND_LIMIT,
  dueListText,
  interviewBrief,
  nothingYetText,
  resultText,
  sessionLine,
  submissionPrompt,
  trendsText,
} from "../src/prompts.ts";
import type { RunResult } from "../src/runner/types.ts";
import { createSession, type Session } from "../src/store/sessions.ts";
import { addTrends } from "../src/store/trends.ts";
import { makeFixture, seedExample, type Fixture } from "./helpers.ts";

let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
});
afterEach(() => fixture.cleanup());

function session(): Session {
  return createSession(
    {
      problem: "window-sum",
      problemTitle: "Largest Window Sum",
      patterns: ["sliding-window"],
      difficulty: "easy",
      mode: "interview",
      timerMs: 35 * 60_000,
    },
    Date.UTC(2026, 9, 9, 12, 0),
  );
}

describe("interviewBrief", () => {
  it("includes the request, the history, the docs, and the host brief", () => {
    seedExample();
    addTrends([
      {
        pattern: "stack",
        company: "Stripe",
        seenAt: "2026-09-14",
        sourceUrl: "https://example.com/stripe",
        shapeNote: "Evaluate a stream of bracketed operations.",
      },
    ]);
    const brief = interviewBrief(
      { mode: "review", pattern: "stack", title: "Two Sum", company: "Stripe" },
      "## HOST",
    );
    expect(brief).toContain("review session");
    expect(brief).toContain("the kind of problem **Stripe** asks");
    expect(brief).toContain("## What Stripe has been asking");
    expect(brief).toContain("stack at Stripe (seen 2026-09-14): Evaluate a stream");
    expect(brief).toContain("pattern **stack**");
    expect(brief).toContain("something like **Two Sum**");
    expect(brief).toContain("Never reproduce the named problem's statement");
    expect(brief).toContain("**Two Sum** is on Grind 75 (week 1) and NeetCode 150");
    expect(brief).toContain("## Seed problems for stack");
    expect(brief).toContain("## Authoring");
    expect(brief).toContain("## Recent sessions");
    expect(brief).toContain("## Problems on disk");
    expect(brief).toContain("# Interviewing");
    expect(brief).toContain("# Rubric");
    expect(brief.trimEnd().endsWith("## HOST")).toBe(true);
  });
});

describe("trendsText", () => {
  const entry = (pattern: string, company: string, seenAt: string, note = "A shape.") => ({
    pattern,
    company,
    seenAt,
    sourceUrl: `https://example.com/${company.toLowerCase()}/${pattern}/${seenAt}`,
    shapeNote: note,
  });

  it("is silent with no company and nothing on file, and a line when there is", () => {
    expect(trendsText(undefined)).toBe("");
    addTrends([entry("graphs", "Stripe", "2026-09-14"), entry("heap", "Databricks", "2026-09-01")]);
    const out = trendsText(undefined);
    expect(out).toContain("## Trends on file");
    expect(out).toContain(
      "2 trend entries from research into recent interviews: Stripe (1), Databricks (1).",
    );
    expect(out).toContain("The user named no company");
  });

  it("tells the interviewer when nothing is on file for the company named", () => {
    const empty = trendsText("Stripe");
    expect(empty).toContain("## What Stripe has been asking");
    expect(empty).toContain("No trend entries on file for Stripe.");
    expect(empty).toContain("`/chudcode:research Stripe`");
    expect(empty).not.toContain("other companies");
    addTrends([entry("heap", "Databricks", "2026-09-01")]);
    expect(trendsText("Stripe")).toContain("1 entry is on file for other companies: Databricks.");
  });

  it("lists the company's entries with a tally and the authoring directive", () => {
    addTrends([
      entry("sliding-window", "Stripe", "2026-08-02", "At most k distinct, n up to 10^5."),
      entry("graphs", "Stripe", "2026-09-14", "Grid regions with unblocking updates."),
      entry("graphs", "Stripe", "2026-09-20"),
      entry("heap", "Databricks", "2026-09-01"),
    ]);
    const out = trendsText("stripe");
    expect(out).toContain("## What stripe has been asking");
    expect(out).toContain(
      "3 trend entries on file for stripe, most recent first. Patterns: graphs ×2, sliding-window ×1.",
    );
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^- `t-[0-9a-f]{10}` graphs at Stripe \(seen 2026-09-20\): A shape\. — source: https:/,
    );
    expect(lines[2]).toContain("sliding-window at Stripe (seen 2026-08-02): At most k distinct");
    expect(out).not.toContain("Databricks");
    expect(out).toContain("Cite the entries you drew on in `trend_ids` under `source`");
    expect(out).toContain("never reproduce the post");
  });

  it("shows a bounded number of entries and points at list_trends for the rest", () => {
    addTrends(
      Array.from({ length: BRIEF_TREND_LIMIT + 2 }, (_, i) =>
        entry("dp-1d", "Stripe", `2026-09-${String(i + 1).padStart(2, "0")}`),
      ),
    );
    const out = trendsText("Stripe");
    expect(out.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(BRIEF_TREND_LIMIT);
    expect(out).toContain("…and 2 more via `list_trends`.");
  });
});

describe("sessionLine", () => {
  it("places the session in one line", () => {
    const s = session();
    expect(sessionLine(s, s.createdAt)).toBe(
      `Session \`${s.id}\` · Largest Window Sum (easy; sliding-window) · before Start · clock not started · 0 hints used · 0 submissions`,
    );
    s.startedAt = s.createdAt;
    s.phase = "coding";
    s.hintsUsed = [1];
    s.submissions = 2;
    s.lastResult = { status: "ok", passed: 10, total: 12 };
    expect(sessionLine(s, s.createdAt + 5 * 60_000)).toContain(
      "coding · 30:00 left · 1 hint used · 2 submissions (last 10/12)",
    );
  });
});

describe("resultText and submissionPrompt", () => {
  const result: RunResult = {
    status: "ok",
    passed: 1,
    total: 3,
    wallMs: 42,
    stderrTail: "",
    truncated: false,
    maxRssKb: 20_480,
    cases: [
      { id: "ex1", status: "pass", stdout: "", stderr: "", timeMs: 1 },
      { id: "big", status: "fail", stdout: "", stderr: "", timeMs: 3, expected: 1, actual: 2 },
      {
        id: "boom",
        status: "error",
        stdout: "",
        stderr: "Traceback\nZeroDivisionError: division by zero",
        timeMs: 2,
        message: "ZeroDivisionError: division by zero",
      },
    ],
  };
  const cases = [
    { id: "ex1", label: "Example 1", visible: true, input: { nums: [1], k: 1 }, expected: 1 },
    {
      id: "big",
      visible: false,
      input: { nums: Array.from({ length: 200 }, (_, i) => i), k: 3 },
      expected: 1,
    },
    { id: "boom", visible: false, gen: "large(5, 1)", expected: 1 },
  ];

  it("shows every failing case with a clipped input and the last stderr line", () => {
    const out = resultText(result, cases, ["nums", "k"]);
    expect(out).toContain("1/3 passed · ran to completion · 42 ms · 20 MB");
    expect(out).toContain("- big (hidden): fail");
    expect(out).toMatch(/input: nums = \[0, 1, 2.*… \(\d+ more characters\)/);
    expect(out).toContain("- boom (hidden): error — ZeroDivisionError: division by zero");
    expect(out).toContain("input: generated by `large(5, 1)`");
    expect(out).toContain("stderr: ZeroDivisionError: division by zero");
    expect(out).toContain("Passed: Example 1");
  });

  it("names the next tool depending on the outcome", () => {
    const bundle = seedExample();
    const s = session();
    const failing = submissionPrompt(s, 1, result, bundle);
    expect(failing).toContain("Not every case passed");
    expect(failing).toContain("`say_to_candidate`");
    expect(failing).toContain("Target complexity: O(n) time, O(1) space");
    expect(failing).toContain("`wait_for_candidate` call");
    const passing = submissionPrompt(
      s,
      2,
      { ...result, passed: 3, cases: result.cases.map((c) => ({ ...c, status: "pass" as const })) },
      bundle,
    );
    expect(passing).toContain("Every case passed");
    expect(passing).toContain("`record_session`");
  });
});

describe("dueListText", () => {
  const now = Date.UTC(2026, 9, 10, 12);
  const progress = (events: Parameters<typeof scheduleItems>[0]) =>
    buildProgress({
      items: scheduleItems(events),
      taxonomy: patterns(),
      sessionTimes: events.map((e) => e.at),
      now,
    });

  it("says when nothing has happened yet, and when the next review comes", () => {
    expect(dueListText(progress([]), 5)).toContain("no session has been recorded yet");
    const later = progress([
      { key: "pattern:trees", at: now - DAY_MS, correct: true, session: "20261009-1200-t-0001" },
    ]);
    expect(dueListText(later, 5)).toContain(
      "Nothing is due. The next pattern comes due in 2 days.",
    );
    expect(dueListText(later, 5)).toContain("Due soon: trees in 2 days.");
    expect(dueListText(later, 5)).toContain("Streak: 1 day.");
  });

  it("lists due patterns most overdue first with their box and last result", () => {
    const out = dueListText(
      progress([
        {
          key: "pattern:trees",
          at: now - 3 * DAY_MS,
          correct: true,
          session: "s-1",
          difficulty: "medium",
        },
        { key: "pattern:stack", at: now - 2 * DAY_MS, correct: false, session: "s-2" },
      ]),
      5,
    );
    expect(out.split("\n").slice(2, 4)).toEqual([
      "- stack: box 0, 1 day overdue; missed 2 days ago, 1 attempt",
      "- trees: box 1, due today; solved 3 days ago (medium), 1 attempt",
    ]);
  });
});

describe("nothingYetText", () => {
  it("tells the interviewer what to do with no session", () => {
    expect(nothingYetText(60, [], "")).toContain("No session is in progress");
  });
});
