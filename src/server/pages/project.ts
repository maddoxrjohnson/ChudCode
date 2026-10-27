/**
 * project.ts: the project session page. The ticket on the left; the repository's
 * file tree, an editor, and the test results in the middle; the interviewer on the
 * right. In an online assessment the chat and hints stay hidden while the clock
 * runs, the way the real thing has nobody to ask.
 */

import { formatClock } from "../../format.ts";
import { escapeHtml } from "../../markdown.ts";
import type { ProjectState } from "../../project-flow.ts";
import { PROJECT_DIMENSIONS } from "../../store/projects.ts";
import { difficultyBadge, page, topbar } from "./layout.ts";

const PHASE_LABELS: Record<ProjectState["session"]["phase"], string> = {
  briefing: "Briefing",
  coding: "Working",
  review: "Debrief",
  done: "Finished",
};

export const DIMENSION_LABELS: Record<(typeof PROJECT_DIMENSIONS)[number], string> = {
  correctness: "Correctness",
  debugging: "Debugging",
  codeQuality: "Code quality",
  time: "Time",
};

export function projectPage(state: ProjectState, options: { autocomplete: boolean }): string {
  const { session } = state;
  const quiet = session.oa && session.phase !== "review" && session.phase !== "done";
  const firstFile =
    state.tree.find((f) => f.path.endsWith("/views.py"))?.path ??
    state.tree.find((f) => !f.readOnly && f.path.endsWith(".py"))?.path ??
    state.tree[0]?.path ??
    "";

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
  const hintsUsed = session.hintsUsed.length;

  const body = `${topbar({
    title: `${escapeHtml(session.projectTitle)} ${difficultyBadge(session.difficulty)}${session.oa ? ' <span class="badge">Online assessment</span>' : ""}`,
    middle: `<span class="timer" id="timer">${formatClock(state.remainingMs ?? session.timerMs)}</span>`,
    right: `<span class="phase-badge phase-${session.phase}" id="phase">${PHASE_LABELS[session.phase]}</span>
    <span class="presence ${state.listening ? "listening" : ""}" id="presence" title="Whether the interviewer is listening">${state.listening ? "Interviewer listening" : "Interviewer away"}</span>`,
  })}
<main class="panes project">
  <section class="pane pane-statement">
    ${state.statementHtml}
    <h2>Read-only files</h2>
    <p class="muted small">Changing one of these fails a submission, as it scores zero on a real assessment.</p>
    <ul class="readonly-list">${state.readOnly.map((p) => `<li><code>${escapeHtml(p)}</code></li>`).join("")}</ul>
    <h2>Working locally</h2>
    <p class="muted small">The repository is also at <code>${escapeHtml(session.workspace)}</code>. Edit it in your own editor if you prefer; the page picks up saved changes when you come back to it.</p>
  </section>

  <section class="pane pane-workspace">
    <div class="toolbar">
      <span class="language" id="file-name">${escapeHtml(firstFile)}</span>
      <span class="badge" id="file-readonly" hidden>read-only</span>
      <button type="button" class="link-button" id="reset-file" hidden>Reset file</button>
      <label class="toggle"><input type="checkbox" id="autocomplete-toggle" ${options.autocomplete ? "checked" : ""}> Autocomplete</label>
      <span class="toolbar-spacer"></span>
      <span class="save-state" id="save-state"></span>
      <button type="button" class="button" id="run-button" ${session.phase === "briefing" || session.phase === "done" ? "disabled" : ""} title="Run the tests in tests/ (Ctrl+Enter)">Run</button>
      <button type="button" class="button primary" id="submit-button" ${session.phase === "briefing" || session.phase === "done" ? "disabled" : ""} title="Run every test, hidden ones included (Ctrl+Shift+Enter)">Submit</button>
    </div>
    <div class="project-ide">
      <nav class="file-tree" id="file-tree" aria-label="Repository files"></nav>
      <div class="editor-host" id="editor"><pre class="editor-fallback">Loading ${escapeHtml(firstFile)}…</pre></div>
    </div>
    <section class="tests-panel" id="tests-panel">
      <div class="tests-header">
        <span id="tests-summary" class="tests-summary">Run tests runs tests/. Submit adds the hidden tests. A run takes a few seconds.</span>
      </div>
      <ol class="case-list" id="case-list"></ol>
    </section>
  </section>

  <aside class="pane pane-side">
    <section class="briefing" id="briefing" ${session.phase === "briefing" ? "" : "hidden"}>
      <h2>Before you start</h2>
      <p>Read the ticket and look around the repository. The clock starts when you press Start, and files can be changed from then on.</p>
      ${session.oa ? "<p><strong>Online assessment:</strong> nobody answers while the clock runs and there are no hints. The interviewer debriefs you at the end.</p>" : "<p>Ask the interviewer about the API as you would a teammate.</p>"}
      <div class="button-row"><button type="button" class="button primary" id="start-button">Start the clock</button></div>
    </section>

    <section class="chat" id="chat" ${quiet ? "hidden" : ""}>
      <h2>Interviewer</h2>
      <ul class="messages" id="messages">${messages}</ul>
      <form class="composer" id="composer">
        <textarea id="composer-text" rows="2" placeholder="Ask about the API, or explain what you found…"></textarea>
        <button type="submit" class="button">Send</button>
      </form>
    </section>

    <section class="hints" id="hints" ${session.oa ? "hidden" : ""}>
      <div class="hints-header">
        <h2>Hints</h2>
        <button type="button" class="button" id="hint-button" ${hintsUsed >= state.hintsTotal || session.phase === "done" ? "disabled" : ""}>Hint (${hintsUsed}/${state.hintsTotal} used)</button>
      </div>
      <ul class="hint-list" id="hint-list">${hints}</ul>
    </section>

    <section class="rubric" id="rubric">${session.rubric ? rubricHtml(state) : ""}</section>

    <div class="side-footer">
      <button type="button" class="button" id="done-button" ${session.phase === "review" || session.phase === "done" ? "disabled" : ""}>I'm done</button>
    </div>
  </aside>
</main>`;

  return page({
    title: session.projectTitle,
    bodyClass: "session project-session",
    body,
    config: {
      sessionId: session.id,
      phase: session.phase,
      oa: session.oa,
      timerMs: session.timerMs,
      startedAt: session.startedAt ?? null,
      endedAt: session.endedAt ?? null,
      tree: state.tree,
      firstFile,
      hintsUsed: session.hintsUsed,
      hintsTotal: state.hintsTotal,
      last: state.last,
      autocomplete: options.autocomplete,
    },
    module: "runtime/project/main.mjs",
  });
}

function rubricHtml(state: ProjectState): string {
  const { rubric, verdict } = state.session;
  if (!rubric) return "";
  const row = (label: string, score: number) =>
    `<li><span>${label}</span><span class="score">${"●".repeat(score)}${"○".repeat(4 - score)}</span></li>`;
  return `<h2>Debrief <span class="badge ${verdict?.correct ? "ok" : "warn"}">${verdict?.correct ? "Passed" : "Not yet"}</span></h2>
<p class="muted">${verdict ? `${verdict.bugsFixed.length} of ${verdict.bugsTotal} bugs fixed.` : ""}</p>
<ul class="scores">${PROJECT_DIMENSIONS.map((d) => row(DIMENSION_LABELS[d], rubric.scores[d])).join("")}</ul>
<div class="rubric-notes">${escapeHtml(rubric.notesMd)}</div>
${rubric.strengths.length ? `<h3>Strengths</h3><ul>${rubric.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}
${rubric.improvements.length ? `<h3>Work on</h3><ul>${rubric.improvements.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}`;
}
