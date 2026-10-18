/**
 * dashboard.ts: the landing page. Where every pattern sits in the review boxes, what
 * is due, the practice streak, progress through the roadmaps, recent sessions, and
 * the problems on disk.
 *
 * Everything is rendered on the server from `Progress`, so the page reads without
 * JavaScript; its module only reloads it when a session changes.
 */

import { plural } from "../../format.ts";
import { escapeHtml } from "../../markdown.ts";
import type { NextUp } from "../../next-up.ts";
import type { PatternStanding, Progress } from "../../progress.ts";
import { dueText, MASTERED_BOX, relativeDay, type ReviewItem } from "../../review.ts";
import type { ItemStanding, RoadmapProgress, StageStanding } from "../../roadmap.ts";
import type { ProblemMeta } from "../../store/problems.ts";
import type { Session } from "../../store/sessions.ts";
import { difficultyBadge, page, topbar } from "./layout.ts";
import { nextUpHtml, type NextButtonView } from "./next-up.ts";

export interface DashboardData {
  sessions: Session[];
  problems: ProblemMeta[];
  progress: Progress;
  roadmaps: RoadmapProgress[];
  /** The Next problem button for each roadmap; left out, the rows are not shown. */
  next?: { ups: NextUp[]; view: NextButtonView };
}

export function dashboardPage(data: DashboardData): string {
  const { progress } = data;
  return page({
    title: "Dashboard",
    bodyClass: "plain dashboard",
    body: `${topbar({ title: "Dashboard" })}
<main class="narrow">
  ${statsHtml(progress)}
  <section id="due">
    <h2>Due for review</h2>
    ${dueHtml(progress)}
  </section>
  <section id="patterns">
    <h2>Patterns</h2>
    ${gridHtml(progress)}
  </section>
  <section id="roadmaps">
    <h2>Roadmaps</h2>
    ${data.roadmaps.map((r, i) => roadmapHtml(r, i === 0, data.next)).join("\n")}
    <p class="muted small">Press Next problem, or ask your agent for the next roadmap problem. You get an original problem in the shape of the listed one, and solving it checks the listed one off. A topic opens once half of every topic before it is solved.</p>
  </section>
  <section id="sessions">
    <h2>Recent sessions</h2>
    ${sessionsHtml(data.sessions)}
  </section>
  <section id="problems">
    <h2>Problems</h2>
    ${problemsHtml(data.problems, progress)}
  </section>
</main>`,
    module: "runtime/dashboard/main.mjs",
  });
}

// ── Sections ──────────────────────────────────────────────────────────────────

function statsHtml(progress: Progress): string {
  const stat = (id: string, value: string, label: string, cls = "") =>
    `<div class="stat ${cls}" id="stat-${id}"><span class="stat-value">${escapeHtml(value)}</span><span class="stat-label">${escapeHtml(label)}</span></div>`;
  const due = progress.due.length;
  return `<section class="stats">
  ${stat("streak", String(progress.streakDays), "day streak")}
  ${stat("due", String(due), "due for review", due > 0 ? "attention" : "")}
  ${stat("mastered", `${progress.summary.mastered}/${progress.patterns.length}`, "patterns mastered")}
  ${stat("sessions", String(progress.sessionsScored), progress.sessionsScored === 1 ? "session scored" : "sessions scored")}
</section>`;
}

function dueHtml(progress: Progress): string {
  const { now } = progress;
  const names = new Map(progress.patterns.map((p) => [p.id, p.name]));
  if (progress.due.length === 0) {
    const next =
      progress.summary.total === 0
        ? "Finish an interview and its patterns start their review schedule."
        : progress.summary.nextDueAt === null
          ? "Nothing is due."
          : `Nothing is due. Next up: ${names.get(nextDueItem(progress)?.id ?? "") ?? ""} ${relativeDay(progress.summary.nextDueAt, now)}.`;
    return `<p class="muted" id="due-empty">${escapeHtml(next)}</p>`;
  }
  const items = progress.due
    .map(
      (item) => `<li data-pattern="${escapeHtml(item.id)}">
  <strong>${escapeHtml(names.get(item.id) ?? item.id)}</strong>
  <span class="badge warn">${escapeHtml(dueText(item.dueAt, now))}</span>
  <span class="muted">${escapeHtml(lastWords(item, now))} · box ${item.box}</span>
</li>`,
    )
    .join("\n");
  return `<ul class="due-list">${items}</ul>
<p class="muted small">Ask your agent for a review session. It writes a fresh problem on the pattern; you never see the same one twice.</p>`;
}

function nextDueItem(progress: Progress): ReviewItem | undefined {
  return progress.dueSoon[0];
}

function gridHtml(progress: Progress): string {
  const { now } = progress;
  const heads = progress.intervalsDays
    .map(
      (days, box) =>
        `<th class="box-head ${box >= MASTERED_BOX ? "mastered" : ""}" title="Box ${box}: a pattern here comes back after ${plural(days, "day")}">${escapeHtml(intervalLabel(days))}</th>`,
    )
    .join("");
  const rows = progress.patterns
    .map((p) => rowHtml(p, progress.intervalsDays.length, now))
    .join("\n");
  return `<div class="table-scroll">
<table class="table grid" id="pattern-grid">
<thead><tr><th>Pattern</th><th class="box-head" title="Not exercised yet">New</th>${heads}<th>Last</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
<p class="muted small">A solved session moves a pattern one box to the right; a miss sends it back to the first box. Boxes shaded green count as mastered.</p>`;
}

function rowHtml(p: PatternStanding, boxes: number, now: number): string {
  const cell = (classes: string[], content: string, title?: string) =>
    `<td class="${["box", ...classes].join(" ")}"${title ? ` title="${escapeHtml(title)}"` : ""}>${content}</td>`;
  const cells = [p.box === null ? cell(["current", "fresh"], "○") : cell([], "")];
  for (let box = 0; box < boxes; box += 1) {
    if (p.box !== box) {
      cells.push(cell([], ""));
      continue;
    }
    const classes = ["current"];
    if (p.due) classes.push("due");
    if (p.mastered) classes.push("mastered");
    const title = p.dueAt === null ? undefined : `Box ${box} · ${dueText(p.dueAt, now)}`;
    cells.push(cell(classes, "●", title));
  }
  const last =
    p.lastAt === null || p.lastSession === null
      ? `<span class="muted">—</span>`
      : `<a class="last-link" href="/s/${escapeHtml(p.lastSession)}">${escapeHtml(`${p.lastCorrect ? "solved" : "missed"} ${relativeDay(p.lastAt, now)}`)}</a>`;
  const rowClasses = [p.box === null ? "inactive" : "", p.due ? "is-due" : ""].filter(Boolean);
  return `<tr data-pattern="${escapeHtml(p.id)}" data-box="${p.box ?? ""}"${rowClasses.length ? ` class="${rowClasses.join(" ")}"` : ""}>
  <th scope="row">${escapeHtml(p.name)}</th>
  ${cells.join("")}
  <td>${last}</td>
</tr>`;
}

function roadmapHtml(
  roadmap: RoadmapProgress,
  open: boolean,
  buttons: DashboardData["next"],
): string {
  const up = buttons?.ups.find((u) => u.roadmap === roadmap.id);
  // With a button row the row names the next problem, so the summary does not.
  const next = !roadmap.next
    ? "every problem solved"
    : up
      ? ""
      : `next: ${roadmap.next.item.title} (${roadmap.next.stage.name})`;
  const stages = roadmap.stages.map((s) => stageHtml(s, roadmap.stages)).join("\n");
  return `<div class="roadmap-card">
<details class="roadmap" id="roadmap-${escapeHtml(roadmap.id)}"${open ? " open" : ""}>
<summary><strong>${escapeHtml(roadmap.name)}</strong> <span class="badge">${roadmap.solved}/${roadmap.total} solved</span>${next ? ` <span class="muted">${escapeHtml(next)}</span>` : ""}</summary>
<ul class="stage-list">
${stages}
</ul>
</details>
${up && buttons ? nextUpHtml(up, buttons.view) : ""}
</div>`;
}

function stageHtml(stage: StageStanding, all: readonly StageStanding[]): string {
  const state = !stage.unlocked ? "locked" : stage.solved === stage.total ? "done" : "open";
  const note = stage.unlocked ? "" : `opens at ${lockWords(stage, all)}`;
  const items = stage.items.map(itemHtml).join("\n");
  return `<li class="stage ${state}" data-stage="${escapeHtml(stage.id)}">
<details>
<summary><span class="stage-name">${escapeHtml(stage.name)}</span> <progress max="${stage.total}" value="${stage.solved}"></progress> <span class="stage-count">${stage.solved}/${stage.total}</span>${note ? ` <span class="muted small">${escapeHtml(note)}</span>` : ""}</summary>
<ul class="item-list">
${items}
</ul>
</details>
</li>`;
}

/** "5/9 Arrays & Hashing", or "4/7 Binary Search and 6/11 Linked List". */
function lockWords(stage: StageStanding, all: readonly StageStanding[]): string {
  return stage.requires
    .map((id) => all.find((s) => s.id === id) as StageStanding)
    .filter((s) => s.solved < s.unlockAt)
    .map((s) => `${s.unlockAt}/${s.total} ${s.name}`)
    .join(" and ");
}

const ITEM_MARKS: Record<ItemStanding["state"], string> = { solved: "✓", missed: "✗", new: "○" };

function itemHtml(item: ItemStanding): string {
  const title = item.lastSession
    ? `<a href="/s/${escapeHtml(item.lastSession)}">${escapeHtml(item.title)}</a>`
    : escapeHtml(item.title);
  const tries =
    item.state === "missed" ? ` <span class="muted small">missed ×${item.attempts}</span>` : "";
  return `<li class="item ${item.state}"><span class="mark" aria-label="${item.state}">${ITEM_MARKS[item.state]}</span> ${title} ${difficultyBadge(item.difficulty)}${tries}</li>`;
}

function sessionsHtml(sessions: Session[]): string {
  if (sessions.length === 0)
    return `<p class="muted">No sessions yet. Ask your agent to start an interview.</p>`;
  return `<table class="table">
<thead><tr><th>When</th><th>Problem</th><th>Mode</th><th>Result</th><th>Hints</th></tr></thead>
<tbody>${sessions
    .map(
      (s) => `<tr>
  <td><a href="/s/${escapeHtml(s.id)}">${escapeHtml(formatDate(s.createdAt))}</a></td>
  <td>${escapeHtml(s.problemTitle)} ${difficultyBadge(s.difficulty)}</td>
  <td>${escapeHtml(s.mode)}</td>
  <td>${sessionResult(s)}</td>
  <td>${s.hintsUsed.length}</td>
</tr>`,
    )
    .join("\n")}</tbody>
</table>`;
}

function problemsHtml(problems: ProblemMeta[], progress: Progress): string {
  if (problems.length === 0) return `<p class="muted">No problems yet.</p>`;
  const items = problems
    .map((p) => {
      const item = progress.problems[p.slug];
      const notes = [
        p.patterns.join(", "),
        p.validatedAt ? "" : "unvalidated",
        item ? lastWords(item, progress.now) : "",
      ].filter(Boolean);
      return `<li><a href="/p/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a> ${difficultyBadge(p.difficulty)}
  <span class="muted">${escapeHtml(notes.join(" · "))}</span></li>`;
    })
    .join("\n");
  return `<ul class="problem-list">${items}</ul>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lastWords(item: ReviewItem, now: number): string {
  return `${item.lastCorrect ? "solved" : "missed"} ${relativeDay(item.lastAt, now)}`;
}

/** "1 day", "3 days", "3 weeks", "2 months". */
export function intervalLabel(days: number): string {
  if (days >= 56 && days % 30 < 3) return plural(Math.round(days / 30), "month");
  if (days >= 14 && days % 7 === 0) return plural(days / 7, "week");
  return plural(days, "day");
}

function sessionResult(session: Session): string {
  if (session.verdict)
    return session.verdict.correct
      ? `<span class="badge ok">solved</span>`
      : `<span class="badge warn">not solved</span>`;
  if (session.abandonedReason) return `<span class="muted">abandoned</span>`;
  if (session.lastResult) return `${session.lastResult.passed}/${session.lastResult.total} passed`;
  return `<span class="muted">${escapeHtml(session.phase)}</span>`;
}

function formatDate(at: number): string {
  return new Date(at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
