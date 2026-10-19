/**
 * lesson.ts: the agentic-coding lesson page. The teaching on the left with its
 * sources, the brief and the answer box in the middle, the interviewer on the right.
 *
 * As with the interview page, everything known at request time is rendered here so
 * the page reads without JavaScript. There is no code editor: the learner works the
 * exercise with their own agent and writes their answer in Markdown.
 */

import type { LessonState } from "../../lesson-flow.ts";
import { LESSON_DIMENSION_NAMES } from "../../lesson-prompts.ts";
import { formatClock } from "../../format.ts";
import { escapeHtml, renderMarkdown } from "../../markdown.ts";
import type { FactFreshness } from "../../store/fact-checks.ts";
import type { LessonSession } from "../../store/lessons.ts";
import { FACT_REF } from "../../validate-exercise.ts";
import { page, topbar } from "./layout.ts";

export interface LessonPageOptions {
  moduleName: string;
  /** The lesson's facts with when each was last confirmed, for the sources list. */
  facts: FactFreshness[];
  answers: string[];
}

const PHASE_LABELS: Record<LessonSession["phase"], string> = {
  briefing: "Reading",
  coding: "Working",
  review: "Follow-ups",
  done: "Finished",
};

export function lessonPage(state: LessonState, options: LessonPageOptions): string {
  const { session, exercise } = state;
  const messages = state.messages
    .map(
      (m) =>
        `<li class="message from-${m.from}"><div class="message-from">${m.from === "interviewer" ? "Interviewer" : "You"}</div><div class="message-body">${m.html}</div></li>`,
    )
    .join("\n");
  const working = session.phase === "coding" || session.phase === "review";

  const body = `${topbar({
    title: `${escapeHtml(session.lessonTitle)} <span class="badge">${escapeHtml(options.moduleName)}</span>`,
    middle: `<span class="timer" id="timer" data-remaining="${state.remainingMs ?? ""}">${formatClock(state.remainingMs ?? session.timerMs)}</span>`,
    right: `<span class="phase-badge phase-${session.phase}" id="phase">${PHASE_LABELS[session.phase]}</span>
    <span class="presence ${state.listening ? "listening" : ""}" id="presence" title="Whether the interviewer is listening">${state.listening ? "Interviewer listening" : "Interviewer away"}</span>`,
  })}
<main class="panes lesson-panes">
  <section class="pane pane-statement lesson-teaching" id="teaching">
    ${teachingHtml(exercise.teaching, options.facts)}
  </section>

  <section class="pane lesson-work">
    <article class="lesson-brief" id="brief">
      <h1>${escapeHtml(exercise.title)}</h1>
      ${renderMarkdown(stripRefs(exercise.brief))}
    </article>
    <form class="answer-form" id="answer-form">
      <label for="answer-text"><strong>Your answer</strong> <span class="muted small">Markdown. Draft it with your own agent if you like; what is graded is the judgement in it.</span></label>
      <textarea id="answer-text" rows="16" spellcheck="true" ${working ? "" : "disabled"}>${escapeHtml(state.draft)}</textarea>
      <div class="button-row">
        <span class="save-state" id="save-state"></span>
        <button type="submit" class="button primary" id="answer-button" ${working ? "" : "disabled"}>Submit answer</button>
      </div>
    </form>
    <section class="answers" id="answers">${answersHtml(options.answers)}</section>
  </section>

  <aside class="pane pane-side">
    <section class="briefing" id="briefing" ${session.phase === "briefing" ? "" : "hidden"}>
      <h2>When you are ready</h2>
      <p>Read the lesson and the brief, then start the clock. Ask the interviewer anything along the way.</p>
      <div class="button-row">
        <button type="button" class="button primary" id="start-button">Start the clock</button>
      </div>
    </section>

    <section class="chat" id="chat">
      <h2>Interviewer</h2>
      <ul class="messages" id="messages">${messages}</ul>
      <form class="composer" id="composer">
        <textarea id="composer-text" rows="2" placeholder="Ask about the scenario, or explain a choice…"></textarea>
        <button type="submit" class="button">Send</button>
      </form>
    </section>

    <section class="rubric" id="rubric">${session.rubric ? lessonRubricHtml(session) : ""}</section>

    <div class="side-footer">
      <button type="button" class="button" id="done-button" ${session.phase === "review" || session.phase === "done" ? "disabled" : ""}>I'm done</button>
    </div>
  </aside>
</main>`;

  return page({
    title: session.lessonTitle,
    bodyClass: "session lesson",
    body,
    config: {
      sessionId: session.id,
      phase: session.phase,
      timerMs: session.timerMs,
      startedAt: session.startedAt ?? null,
      endedAt: session.endedAt ?? null,
      remainingMs: state.remainingMs,
      draft: state.draft,
      listening: state.listening,
      focus: session.focus,
    },
    module: "runtime/lesson/main.mjs",
  });
}

/** The teaching with each `[fact:<id>]` as a numbered link to its source below. */
export function teachingHtml(markdown: string, facts: readonly FactFreshness[]): string {
  const order: FactFreshness[] = [];
  const withRefs = markdown.replace(FACT_REF, (whole, id: string) => {
    const entry = facts.find((f) => f.fact.id === id);
    if (!entry) return "";
    if (!order.includes(entry)) order.push(entry);
    const n = order.indexOf(entry) + 1;
    return `<sup class="fact-ref"><a href="#fact-${id}" title="${escapeHtml(entry.fact.claim)}">${n}</a></sup>`;
  });
  const sources = order
    .map((entry) => {
      const checked = new Date(entry.confirmedAt).toISOString().slice(0, 10);
      const flag = entry.problem
        ? ` <span class="badge warn">${escapeHtml(entry.problem.status)} when last checked</span>`
        : "";
      return `<li id="fact-${escapeHtml(entry.fact.id)}">${escapeHtml(entry.fact.claim)} <a href="${escapeHtml(entry.fact.source)}" target="_blank" rel="noopener noreferrer">Source</a> <span class="muted small">checked ${checked}</span>${flag}</li>`;
    })
    .join("\n");
  return `${renderMarkdown(withRefs)}
${sources ? `<h2>Sources</h2>\n<ol class="fact-sources">\n${sources}\n</ol>` : ""}`;
}

function stripRefs(markdown: string): string {
  return markdown.replace(FACT_REF, "");
}

function answersHtml(answers: readonly string[]): string {
  if (answers.length === 0) return "";
  return `<h2>Submitted</h2>
${answers
  .map(
    (text, i) =>
      `<details class="answer"${i === answers.length - 1 ? " open" : ""}><summary>Answer ${i + 1}</summary><div class="answer-body">${renderMarkdown(text)}</div></details>`,
  )
  .join("\n")}`;
}

export function lessonRubricHtml(session: LessonSession): string {
  const r = session.rubric;
  if (!r) return "";
  const rows = LESSON_DIMENSION_NAMES.map(([key, label]) => {
    const score = r[key];
    const focus = session.focus.includes(key) ? ` <span class="muted small">focus</span>` : "";
    const value =
      score === null
        ? `<span class="muted">n/a</span>`
        : `${"●".repeat(score)}${"○".repeat(4 - score)}`;
    return `<li><span>${label}${focus}</span><span class="score">${value}</span></li>`;
  }).join("\n  ");
  const passed = session.verdict?.correct;
  return `<h2>Debrief <span class="badge ${passed ? "ok" : "warn"}">${passed ? "Passed" : "Not yet"}</span></h2>
<ul class="scores">
  ${rows}
</ul>
<div class="rubric-notes">${renderMarkdown(r.notesMd)}</div>
${r.strengths.length ? `<h3>Strengths</h3><ul>${r.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}
${r.improvements.length ? `<h3>Work on</h3><ul>${r.improvements.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}`;
}
