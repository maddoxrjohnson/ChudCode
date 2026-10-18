/**
 * session.ts: the interview page. Statement on the left, editor and tests in the
 * middle, the interviewer on the right.
 *
 * Everything that is known at request time is rendered here so the page reads
 * without JavaScript; the runtime modules add the editor, timer, and live updates.
 */

import type { SessionState } from "../../flow.ts";
import { formatClock } from "../../format.ts";
import { escapeHtml } from "../../markdown.ts";
import { difficultyBadge, page, topbar } from "./layout.ts";
import { examplesHtml, statementHtml } from "./problem.ts";

export interface SessionPageOptions {
  autocomplete: boolean;
  /** Roadmap sessions: the list it works through, for the Next problem button. */
  roadmap?: string;
  /** The button row, once the session is scored. */
  nextHtml?: string;
  /** Whether an interviewer is around to answer the button. */
  connected?: boolean;
}

const PHASE_LABELS: Record<SessionState["session"]["phase"], string> = {
  briefing: "Briefing",
  coding: "Coding",
  review: "Follow-ups",
  done: "Finished",
};

export function sessionPage(state: SessionState, options: SessionPageOptions): string {
  const { session, problem } = state;
  const order = problem.signature.params.map((p) => p.name);
  const hintsUsed = session.hintsUsed.length;

  const messages = state.messages
    .map(
      (m) =>
        `<li class="message from-${m.from}"><div class="message-from">${m.from === "interviewer" ? "Interviewer" : "You"}</div><div class="message-body">${m.html}</div></li>`,
    )
    .join("\n");

  const hints = state.hints
    .map(
      (h) =>
        `<li class="hint"><span class="hint-level">Hint ${h.level}</span> ${escapeHtml(h.text)}</li>`,
    )
    .join("\n");

  const rubric = session.rubric ? rubricHtml(session) : "";

  const body = `${topbar({
    title: `${escapeHtml(problem.title)} ${difficultyBadge(problem.difficulty)}`,
    middle: `<span class="timer" id="timer" data-remaining="${state.remainingMs ?? ""}">${formatClock(state.remainingMs ?? session.timerMs)}</span>`,
    right: `<span class="phase-badge phase-${session.phase}" id="phase">${PHASE_LABELS[session.phase]}</span>
    <span class="presence ${state.listening ? "listening" : ""}" id="presence" title="Whether the interviewer is listening">${state.listening ? "Interviewer listening" : "Interviewer away"}</span>`,
  })}
<main class="panes">
  <section class="pane pane-statement">
    ${statementHtml(problem)}
    <h2>Examples</h2>
    ${examplesHtml(problem.visibleCases, order)}
    <p class="muted">${problem.hiddenCaseCount} hidden ${problem.hiddenCaseCount === 1 ? "case runs" : "cases run"} when you Submit.</p>
  </section>

  <section class="pane pane-workspace">
    <div class="toolbar">
      <span class="language">${escapeHtml(problem.language === "python" ? "Python 3" : problem.language)}</span>
      <label class="toggle"><input type="checkbox" id="autocomplete-toggle" ${options.autocomplete ? "checked" : ""}> Autocomplete</label>
      <span class="toolbar-spacer"></span>
      <span class="save-state" id="save-state"></span>
      <button type="button" class="button" id="run-button" ${session.phase === "briefing" ? "disabled" : ""}>Run</button>
      <button type="button" class="button primary" id="submit-button" ${session.phase === "briefing" ? "disabled" : ""}>Submit</button>
    </div>
    <div class="editor-host" id="editor"><pre class="editor-fallback">${escapeHtml(state.draft)}</pre></div>
    <section class="tests-panel" id="tests-panel">
      <div class="tests-header">
        <span id="tests-summary" class="tests-summary">Run executes the examples. Submit runs every case.</span>
        <button type="button" class="link-button" id="custom-input-toggle">Custom input</button>
      </div>
      <form class="custom-input" id="custom-input" hidden>
        <label>Arguments as JSON, by name <textarea id="custom-input-text" rows="3" spellcheck="false">${escapeHtml(JSON.stringify(problem.visibleCases[0]?.input ?? {}))}</textarea></label>
        <button type="submit" class="button">Run custom input</button>
      </form>
      <ol class="case-list" id="case-list"></ol>
    </section>
  </section>

  <aside class="pane pane-side">
    <section class="briefing" id="briefing" ${session.phase === "briefing" ? "" : "hidden"}>
      <h2>Before you code</h2>
      <p>Tell the interviewer how you plan to approach this. One or two sentences is plenty.</p>
      <form id="approach-form">
        <textarea id="approach-text" rows="4" placeholder="I'll keep a running sum over a window of size k and…"></textarea>
        <div class="button-row">
          <button type="submit" class="button primary" id="start-button">Start the clock</button>
          <button type="button" class="link-button" id="skip-note-button">Skip the note</button>
        </div>
      </form>
    </section>

    <section class="chat" id="chat">
      <h2>Interviewer</h2>
      <ul class="messages" id="messages">${messages}</ul>
      <form class="composer" id="composer">
        <textarea id="composer-text" rows="2" placeholder="Ask a clarifying question or explain your thinking…"></textarea>
        <button type="submit" class="button">Send</button>
      </form>
    </section>

    <section class="hints" id="hints">
      <div class="hints-header">
        <h2>Hints</h2>
        <button type="button" class="button" id="hint-button" data-used="${hintsUsed}" data-total="${problem.hintsTotal}" ${hintsUsed >= problem.hintsTotal || session.phase === "done" ? "disabled" : ""}>Hint (${hintsUsed}/${problem.hintsTotal} used)</button>
      </div>
      <ul class="hint-list" id="hint-list">${hints}</ul>
    </section>

    <section class="rubric" id="rubric">${rubric}</section>
    <section class="next-section" id="next-section">${options.nextHtml ?? ""}</section>

    <div class="side-footer">
      <button type="button" class="button" id="done-button" ${session.phase === "review" || session.phase === "done" ? "disabled" : ""}>I'm done</button>
    </div>
  </aside>
</main>`;

  return page({
    title: problem.title,
    bodyClass: "session",
    body,
    config: {
      sessionId: session.id,
      phase: session.phase,
      timerMs: session.timerMs,
      startedAt: session.startedAt ?? null,
      endedAt: session.endedAt ?? null,
      remainingMs: state.remainingMs,
      editor: { autocomplete: options.autocomplete, language: problem.language },
      draft: state.draft,
      hintsUsed: session.hintsUsed,
      hintsTotal: problem.hintsTotal,
      paramOrder: order,
      listening: state.listening,
      connected: options.connected ?? state.listening,
      roadmap: options.roadmap ?? null,
    },
    module: "runtime/session/main.mjs",
  });
}

function rubricHtml(session: SessionState["session"]): string {
  const r = session.rubric;
  if (!r) return "";
  const row = (label: string, score: number) =>
    `<li><span>${label}</span><span class="score">${"●".repeat(score)}${"○".repeat(4 - score)}</span></li>`;
  const verdict = session.verdict?.correct ? "Solved" : "Not yet";
  return `<h2>Debrief <span class="badge ${session.verdict?.correct ? "ok" : "warn"}">${verdict}</span></h2>
<ul class="scores">
  ${row("Correctness", r.correctness)}
  ${row("Communication", r.communication)}
  ${row("Complexity", r.complexity)}
  ${row("Code quality", r.codeQuality)}
  ${row("Time", r.time)}
</ul>
<div class="rubric-notes">${escapeHtml(r.notesMd)}</div>
${r.strengths.length ? `<h3>Strengths</h3><ul>${r.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}
${r.improvements.length ? `<h3>Work on</h3><ul>${r.improvements.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}`;
}
