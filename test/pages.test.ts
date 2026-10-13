/**
 * Page builders are pure functions of their data, so they are tested as strings.
 */

import { describe, expect, it } from "vitest";

import { buildProgress } from "../src/progress.ts";
import { DAY_MS, scheduleItems, type ReviewEvent } from "../src/review.ts";
import { dashboardPage, intervalLabel } from "../src/server/pages/dashboard.ts";
import { notFoundPage, page } from "../src/server/pages/layout.ts";
import { patterns, type ProblemMeta } from "../src/store/problems.ts";
import type { Session } from "../src/store/sessions.ts";

const T0 = Date.UTC(2026, 9, 10, 12);

function event(key: string, day: number, correct: boolean, session: string): ReviewEvent {
  return { key, at: T0 + day * DAY_MS, correct, session };
}

const SOLVED = "20261009-1200-window-sum-0001";
const MISSED = "20261007-1200-bracket-run-0002";

const events = [
  event("pattern:sliding-window", -1, true, SOLVED),
  event("problem:window-sum", -1, true, SOLVED),
  event("pattern:stack", -3, false, MISSED),
  event("problem:bracket-run", -3, false, MISSED),
  ...[-50, -40, -30, -10].map((day) =>
    event("pattern:heap", day, true, `2026090${-day % 10}-1200-h-000${-day % 10}`),
  ),
];

const progress = buildProgress({
  items: scheduleItems(events),
  taxonomy: patterns(),
  sessionTimes: [T0 - DAY_MS, T0 - 3 * DAY_MS, T0 - 10 * DAY_MS],
  now: T0,
});

function session(patch: Partial<Session>): Session {
  return {
    id: SOLVED,
    problem: "window-sum",
    problemTitle: "Largest Window Sum",
    patterns: ["sliding-window"],
    difficulty: "easy",
    mode: "interview",
    language: "python",
    timerMs: 60_000,
    createdAt: T0 - DAY_MS,
    phase: "done",
    hintsUsed: [],
    submissions: 1,
    ...patch,
  };
}

const problem: ProblemMeta = {
  slug: "window-sum",
  title: "Largest Window Sum",
  patterns: ["sliding-window"],
  difficulty: "easy",
  language: "python",
  signature: { style: "function", name: "f", params: [], returns: "int" },
  complexityTarget: { time: "O(n)", space: "O(1)" },
  source: { kind: "hand" },
  createdAt: T0,
  validatedAt: T0,
  timesServed: 1,
};

const unvalidated: ProblemMeta = { ...problem, slug: "bracket-run", title: "Bracket Run" };
delete unvalidated.validatedAt;

describe("dashboardPage", () => {
  const html = dashboardPage({
    sessions: [
      session({
        verdict: { correct: true, allPassed: true, withinTime: true, complexityOk: true },
      }),
      session({
        id: MISSED,
        problemTitle: "<script>alert(1)</script>",
        abandonedReason: "gave up",
      }),
    ],
    problems: [problem, unvalidated],
    progress,
  });

  it("shows the streak, what is due, and mastery in the stats row", () => {
    expect(html).toContain('id="stat-streak"><span class="stat-value">1</span>');
    expect(html).toContain(
      '<div class="stat attention" id="stat-due"><span class="stat-value">1</span>',
    );
    expect(html).toContain(`<span class="stat-value">1/${patterns().length}</span>`);
    expect(html).toContain('id="stat-sessions"><span class="stat-value">3</span>');
  });

  it("lists due patterns by name with how overdue they are and where they stand", () => {
    expect(html).toContain('<li data-pattern="stack">');
    expect(html).toContain("<strong>Stack &amp; Monotonic Stack</strong>");
    expect(html).toContain('<span class="badge warn">2 days overdue</span>');
    expect(html).toContain("missed 3 days ago · box 0");
    expect(html).not.toContain('<li data-pattern="sliding-window">');
  });

  it("draws every pattern as a row with its box marked", () => {
    for (const p of patterns()) expect(html).toContain(`<tr data-pattern="${p.id}"`);
    expect(html).toMatch(
      /<th class="box-head[^>]*>1 day<\/th><th class="box-head[^>]*>3 days<\/th>/,
    );
    expect(html).toContain(
      '<th class="box-head mastered" title="Box 3: a pattern here comes back after 21 days">3 weeks</th>',
    );

    const row = (id: string) =>
      html.slice(
        html.indexOf(`<tr data-pattern="${id}"`),
        html.indexOf("</tr>", html.indexOf(`<tr data-pattern="${id}"`)),
      );
    expect(row("sliding-window")).toContain('data-box="1"');
    expect(row("sliding-window")).toMatch(
      /<td class="box current" title="Box 1 · due in 2 days">●<\/td>/,
    );
    expect(row("sliding-window")).toContain(`href="/s/${SOLVED}">solved yesterday</a>`);
    expect(row("stack")).toContain('class="is-due"');
    expect(row("stack")).toContain(
      '<td class="box current due" title="Box 0 · 2 days overdue">●</td>',
    );
    expect(row("heap")).toContain(
      '<td class="box current mastered" title="Box 4 · due in 50 days">●</td>',
    );
    expect(row("tries")).toContain('class="inactive"');
    expect(row("tries")).toContain('<td class="box current fresh">○</td>');
    expect(row("tries")).not.toContain("●");
  });

  it("lists sessions and problems with their outcomes, escaped", () => {
    expect(html).toContain('<span class="badge ok">solved</span>');
    expect(html).toContain('<span class="muted">abandoned</span>');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("sliding-window · solved yesterday");
    expect(html).toContain("sliding-window · unvalidated");
    expect(html).toContain('src="/static/runtime/dashboard/main.mjs"');
  });

  it("explains an empty state", () => {
    const empty = dashboardPage({
      sessions: [],
      problems: [],
      progress: buildProgress({ items: [], taxonomy: patterns(), sessionTimes: [], now: T0 }),
    });
    expect(empty).toContain("Finish an interview and its patterns start their review schedule.");
    expect(empty).toContain("No sessions yet.");
    expect(empty).toContain('id="stat-streak"><span class="stat-value">0</span>');

    const quiet = dashboardPage({
      sessions: [],
      problems: [],
      progress: buildProgress({
        items: scheduleItems([event("pattern:trees", -1, true, SOLVED)]),
        taxonomy: patterns(),
        sessionTimes: [T0 - DAY_MS],
        now: T0,
      }),
    });
    expect(quiet).toContain("Nothing is due. Next up: Trees (DFS &amp; BFS) in 2 days.");
  });
});

describe("intervalLabel", () => {
  it("says days, weeks, or months", () => {
    expect([1, 3, 7, 21, 60, 14, 90].map(intervalLabel)).toEqual([
      "1 day",
      "3 days",
      "7 days",
      "3 weeks",
      "2 months",
      "2 weeks",
      "3 months",
    ]);
  });
});

describe("layout", () => {
  it("keeps page config inside its script block", () => {
    const html = page({
      title: "T",
      bodyClass: "plain",
      body: "",
      config: { draft: "</script><script>alert(1)</script>" },
    });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");
  });

  it("escapes the not-found message", () => {
    expect(notFoundPage("<b>x</b>")).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
