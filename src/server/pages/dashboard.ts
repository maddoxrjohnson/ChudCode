/**
 * dashboard.ts: the landing page. Where every pattern sits in the review boxes, what
 * is due, the practice streak, progress through the roadmaps, recent sessions, and
 * the problems on disk.
 *
 * Everything is rendered on the server from `Progress`, so the page reads without
 * JavaScript; its module only reloads it when a session changes.
 */

import {
  PHONE_FORMAT_NAMES,
  PHONE_FORMATS,
  type PhoneSession,
  type Story,
} from "../../store/phone.ts";
import { plural } from "../../format.ts";
import { escapeHtml } from "../../markdown.ts";
import type { NextUp } from "../../next-up.ts";
import type { PatternStanding, Progress } from "../../progress.ts";
import { dueText, MASTERED_BOX, relativeDay, type ReviewItem } from "../../review.ts";
import type { ItemStanding, RoadmapProgress, StageStanding } from "../../roadmap.ts";
import type { ProblemMeta } from "../../store/problems.ts";
import type { Session } from "../../store/sessions.ts";
import type { CurriculumProgress, LessonState } from "../../curriculum.ts";
import type { LessonSession } from "../../store/lessons.ts";
import { difficultyBadge, page, topbar } from "./layout.ts";
import { nextUpHtml, type NextButtonView } from "./next-up.ts";

export interface AgenticData {
  progress: CurriculumProgress;
  /** Recent lesson sessions, newest first. */
  lessons: LessonSession[];
  /** Lesson review items that are due now. */
  due: ReviewItem[];
  /** The Next lesson button, rendered; left out, the plain line is shown. */
  nextRow?: string;
}

export interface DashboardData {
  sessions: Session[];
  problems: ProblemMeta[];
  progress: Progress;
  roadmaps: RoadmapProgress[];
  /** The Next problem button for each roadmap; left out, the rows are not shown. */
  next?: { ups: NextUp[]; view: NextButtonView };
  /** The agentic-coding lessons; left out, the section is not shown. */
  agentic?: AgenticData;
  /** Phone screen practice; left out, the section is not shown. */
  phone?: PhoneData;
}

export interface PhoneData {
  /** Recent phone screens, newest first. */
  sessions: PhoneSession[];
  /** Phone review items: formats and fundamentals topics. */
  items: ReviewItem[];
  stories: Story[];
  topics: Array<{ id: string; name: string }>;
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
  ${data.agentic ? agenticHtml(data.agentic, progress.now) : ""}
  ${data.phone ? phoneHtml(data.phone, progress.now) : ""}
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

const LESSON_MARKS: Record<LessonState, string> = {
  passed: "✓",
  attempted: "✗",
  new: "○",
  outline: "·",
};

function agenticHtml(data: AgenticData, now: number): string {
  const { progress } = data;
  const names = new Map(progress.modules.flatMap((m) => m.lessons.map((l) => [l.id, l.title])));
  const next = data.nextRow
    ? data.nextRow
    : progress.next
      ? `<p id="agentic-next">Next lesson: <strong>${escapeHtml(progress.next.lesson.title)}</strong> <span class="muted">in ${escapeHtml(progress.next.module.name)}</span></p>`
      : "";
  const due = data.due.length
    ? `<ul class="due-list" id="agentic-due">${data.due
        .map(
          (item) =>
            `<li data-lesson="${escapeHtml(item.id)}"><strong>${escapeHtml(names.get(item.id) ?? item.id)}</strong> <span class="badge warn">${escapeHtml(dueText(item.dueAt, now))}</span></li>`,
        )
        .join("\n")}</ul>`
    : "";
  const modules = progress.modules
    .map((m) => {
      const state = !m.unlocked ? "locked" : m.total > 0 && m.passed === m.total ? "done" : "open";
      const note = m.unlocked
        ? m.total === 0
          ? "outline"
          : ""
        : `opens once ${m.waitingOn.map((id) => progress.modules.find((x) => x.id === id)?.name ?? id).join(" and ")} is half passed`;
      const lessons = m.lessons
        .map((l) => {
          const title = l.lastSession
            ? `<a href="/s/${escapeHtml(l.lastSession)}">${escapeHtml(l.title)}</a>`
            : escapeHtml(l.title);
          return `<li class="item lesson-item ${l.state}"><span class="mark" aria-label="${l.state}">${LESSON_MARKS[l.state]}</span> ${title}${l.state === "outline" ? ` <span class="muted small">coming</span>` : ""}</li>`;
        })
        .join("\n");
      return `<li class="stage ${state}" data-module="${escapeHtml(m.id)}">
<details>
<summary><span class="stage-name">${escapeHtml(m.name)}</span> <progress max="${Math.max(1, m.total)}" value="${m.passed}"></progress> <span class="stage-count">${m.passed}/${m.total}</span>${note ? ` <span class="muted small">${escapeHtml(note)}</span>` : ""}</summary>
<p class="muted small">${escapeHtml(m.blurb)}</p>
<ul class="item-list">
${lessons}
</ul>
</details>
</li>`;
    })
    .join("\n");
  const recent = data.lessons.length
    ? `<table class="table" id="lesson-sessions">
<thead><tr><th>When</th><th>Lesson</th><th>Exercise</th><th>Result</th></tr></thead>
<tbody>${data.lessons
        .map(
          (s) => `<tr>
  <td><a href="/s/${escapeHtml(s.id)}">${escapeHtml(formatDate(s.createdAt))}</a></td>
  <td>${escapeHtml(s.lessonTitle)}</td>
  <td>${escapeHtml(s.exerciseKind)}</td>
  <td>${lessonResult(s)}</td>
</tr>`,
        )
        .join("\n")}</tbody>
</table>`
    : "";
  return `<section id="agentic">
    <h2>Agentic coding</h2>
    <div class="roadmap-card">
    <p><span class="badge">${progress.passed}/${progress.total} lessons passed</span></p>
    ${next}
    ${due}
    <ul class="stage-list" id="agentic-modules">
${modules}
    </ul>
    </div>
    ${recent}
    <p class="muted small">Ask your agent for a lesson, or run /chudcode:learn. Each lesson teaches a few sourced facts about coding with agents, then gives you a scenario to work with your own agent; the interviewer grades your judgement. A module opens once half of every module before it is passed.</p>
  </section>`;
}

function phoneHtml(data: PhoneData, now: number): string {
  const formats = PHONE_FORMATS.map((format) => {
    const done = data.sessions.filter((s) => s.format === format && s.verdict);
    const passed = done.filter((s) => s.verdict?.correct).length;
    const item = data.items.find((i) => i.id === format);
    const due = item
      ? item.dueAt <= now
        ? `<span class="badge warn">${escapeHtml(dueText(item.dueAt, now))}</span>`
        : `<span class="muted small">next ${escapeHtml(dueText(item.dueAt, now))}</span>`
      : `<span class="muted small">not tried</span>`;
    return `<li data-format="${format}"><strong>${escapeHtml(PHONE_FORMAT_NAMES[format])}</strong> <span class="badge">${passed}/${done.length} passed</span> ${due}</li>`;
  }).join("\n");
  const topicItems = data.topics
    .map((t) => ({ t, item: data.items.find((i) => i.id === `topic-${t.id}`) }))
    .filter((x) => x.item);
  const topics = topicItems.length
    ? `<p class="small" id="phone-topics"><span class="muted">Fundamentals:</span> ${topicItems
        .map(
          ({ t, item }) =>
            `<span class="badge ${item?.lastCorrect ? "ok" : "warn"}" title="box ${item?.box}">${escapeHtml(t.name)}</span>`,
        )
        .join(" ")}</p>`
    : "";
  const stories = data.stories.length
    ? `<p class="small" id="phone-stories"><span class="muted">Story bank (${data.stories.length}):</span> ${data.stories.map((s) => escapeHtml(s.title)).join(" · ")}</p>`
    : `<p class="muted small" id="phone-stories">No stories saved yet. A behavioral screen saves the ones you tell well.</p>`;
  const recent = data.sessions.length
    ? `<table class="table" id="phone-sessions">
<thead><tr><th>When</th><th>Call</th><th>Company</th><th>Result</th></tr></thead>
<tbody>${data.sessions
        .slice(0, 8)
        .map(
          (s) => `<tr>
  <td><a href="/s/${escapeHtml(s.id)}">${escapeHtml(formatDate(s.createdAt))}</a></td>
  <td>${escapeHtml(PHONE_FORMAT_NAMES[s.format])}</td>
  <td>${escapeHtml(s.company ?? "")}</td>
  <td>${s.verdict ? (s.verdict.correct ? `<span class="badge ok">passed</span>` : `<span class="badge warn">not passed</span>`) : s.abandonedReason ? `<span class="muted">abandoned</span>` : `<span class="muted">in progress</span>`}</td>
</tr>`,
        )
        .join("\n")}</tbody>
</table>`
    : "";
  return `<section id="phone">
    <h2>Phone screens</h2>
    <div class="roadmap-card">
    <ul class="due-list" id="phone-formats">
${formats}
    </ul>
    ${topics}
    ${stories}
    </div>
    ${recent}
    <p class="muted small">Ask your agent for a mock recruiter, behavioral, or CS fundamentals phone screen, or run /chudcode:phone. Name a company and it plays that company's screen from what research found.</p>
  </section>`;
}

function lessonResult(session: LessonSession): string {
  if (session.verdict)
    return session.verdict.correct
      ? `<span class="badge ok">passed</span>`
      : `<span class="badge warn">not passed</span>`;
  if (session.abandonedReason) return `<span class="muted">abandoned</span>`;
  return `<span class="muted">${escapeHtml(session.phase === "coding" ? "working" : session.phase)}</span>`;
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
