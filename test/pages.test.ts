/**
 * Page builders are pure functions of their data, so they are tested as strings.
 */

import { describe, expect, it } from "vitest";

import { buildProgress } from "../src/progress.ts";
import { DAY_MS, scheduleItems, type ReviewEvent } from "../src/review.ts";
import { buildRoadmapProgress, roadmap } from "../src/roadmap.ts";
import { dashboardPage, intervalLabel } from "../src/server/pages/dashboard.ts";
import { notFoundPage, page } from "../src/server/pages/layout.ts";
import { nextUpHtml } from "../src/server/pages/next-up.ts";
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
    roadmaps: [
      buildRoadmapProgress(roadmap("neetcode150"), [
        { title: "Contains Duplicate", correct: true, at: T0, session: SOLVED },
        { title: "Two Sum", correct: false, at: T0, session: MISSED },
        { title: "Two Sum", correct: false, at: T0 + 1, session: MISSED },
      ]),
      buildRoadmapProgress(roadmap("grind75"), []),
    ],
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

  it("shows each roadmap's topics, what is open, and every problem's state", () => {
    const neet = html.slice(
      html.indexOf('id="roadmap-neetcode150"'),
      html.indexOf('id="roadmap-grind75"'),
    );
    expect(neet).toMatch(/^id="roadmap-neetcode150" open>/);
    expect(neet).toContain('<span class="badge">1/150 solved</span>');
    expect(neet).toContain("next: Valid Anagram (Arrays &amp; Hashing)");
    expect(neet).toContain('<li class="stage open" data-stage="arrays-hashing">');
    expect(neet).toContain(
      '<progress max="9" value="1"></progress> <span class="stage-count">1/9</span>',
    );
    expect(neet).toContain('<li class="stage locked" data-stage="trees">');
    expect(neet).toContain("opens at 4/7 Binary Search and 6/11 Linked List");
    expect(neet).toContain(
      `<li class="item solved"><span class="mark" aria-label="solved">✓</span> <a href="/s/${SOLVED}">Contains Duplicate</a>`,
    );
    expect(neet).toContain(`<a href="/s/${MISSED}">Two Sum</a>`);
    expect(neet).toContain("missed ×2");
    expect(neet).toContain(
      '<li class="item new"><span class="mark" aria-label="new">○</span> Valid Anagram',
    );
    const grind = html.slice(html.indexOf('id="roadmap-grind75"'));
    expect(grind).toMatch(/^id="roadmap-grind75">/);
    expect(grind).toContain('<li class="stage locked" data-stage="week-2">');
    expect(grind).toContain("opens at 6/12 Week 1");
  });

  it("puts a Next problem row under each roadmap when the button is on", () => {
    const up = (roadmap: "neetcode150" | "grind75", title: string, prepared: string | null) => ({
      roadmap,
      name: roadmap === "grind75" ? "Grind 75" : "NeetCode 150",
      title,
      difficulty: "easy" as const,
      stage: roadmap === "grind75" ? "Week 1" : "Arrays & Hashing",
      solved: 0,
      total: roadmap === "grind75" ? 75 : 150,
      prepared,
    });
    const withButtons = dashboardPage({
      sessions: [],
      problems: [],
      progress,
      roadmaps: [
        buildRoadmapProgress(roadmap("neetcode150"), []),
        buildRoadmapProgress(roadmap("grind75"), []),
      ],
      next: {
        ups: [
          up("neetcode150", "Contains Duplicate", "dup-finder"),
          up("grind75", "Two Sum", null),
        ],
        view: { connected: true, pending: null, command: "/chudcode:roadmap" },
      },
    });
    const neet = withButtons.slice(
      withButtons.indexOf('id="roadmap-neetcode150"'),
      withButtons.indexOf('id="roadmap-grind75"'),
    );
    // The row names the next problem, so the summary no longer does.
    expect(neet).not.toContain("next: Contains Duplicate");
    expect(neet).toContain(
      '<div class="next-up" data-roadmap="neetcode150" data-state="ready" data-prepared="1"',
    );
    expect(neet).toContain("Next on NeetCode 150:</span> <strong>Contains Duplicate</strong>");
    expect(neet).toContain(
      '<button type="button" class="button primary next-button">Next problem</button>',
    );
    expect(neet).toContain("Written and validated: it opens at once.");
    const grind = withButtons.slice(withButtons.indexOf('id="roadmap-grind75"'));
    expect(grind).toContain("The interviewer writes it when you press, in about a minute.");
  });

  it("shows the Next problem row as waiting or away, with the command to type", () => {
    const next = {
      roadmap: "grind75" as const,
      name: "Grind 75",
      title: "Two Sum",
      difficulty: "easy" as const,
      stage: "Week 1",
      solved: 0,
      total: 75,
      prepared: null,
    };
    const waiting = nextUpHtml(next, {
      connected: true,
      pending: { roadmap: "grind75", at: 1 },
      command: "/chudcode:roadmap",
    });
    expect(waiting).toContain('data-state="waiting"');
    expect(waiting).toContain('next-button" disabled>');
    expect(waiting).toContain("Waiting for the interviewer to open it…");
    const away = nextUpHtml(next, { connected: false, pending: null, command: "/roadmap" });
    expect(away).toContain('data-state="away"');
    expect(away).toContain('data-command="/roadmap grind75"');
    expect(away).toContain("The interviewer is away. Type /roadmap grind75 in your terminal");
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
      roadmaps: [],
      progress: buildProgress({ items: [], taxonomy: patterns(), sessionTimes: [], now: T0 }),
    });
    expect(empty).toContain("Finish an interview and its patterns start their review schedule.");
    expect(empty).toContain("No sessions yet.");
    expect(empty).toContain('id="stat-streak"><span class="stat-value">0</span>');

    const quiet = dashboardPage({
      sessions: [],
      problems: [],
      roadmaps: [],
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
