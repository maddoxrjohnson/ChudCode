/**
 * The phone screen page: one call. The current question in large type, the call so
 * far, and an answer box filled by the microphone or the keyboard. The interviewer's
 * lines are read aloud by the page script when the learner leaves voice on.
 */

import { formatClock } from "../../format.ts";
import { escapeHtml, renderMarkdown } from "../../markdown.ts";
import { deliverySummary, formatDuration } from "../../phone.ts";
import type { PhoneLine, PhoneState } from "../../phone-flow.ts";
import { PHONE_DIMENSIONS, PHONE_FORMAT_NAMES, type PhoneSession } from "../../store/phone.ts";
import { page, topbar } from "./layout.ts";

const PHASE_LABELS: Record<PhoneSession["phase"], string> = {
  briefing: "Not started",
  coding: "On the call",
  review: "Wrapping up",
  done: "Call ended",
};

export function phonePage(state: PhoneState): string {
  const { session } = state;
  const title = `${PHONE_FORMAT_NAMES[session.format]}${session.company ? ` · ${session.company}` : ""}`;
  const onCall = session.phase === "coding" || session.phase === "review";
  const current = session.questions.at(-1);
  const body = `${topbar({
    title: `${escapeHtml(title)} <span class="badge">Phone screen</span>`,
    middle: `<span class="timer" id="timer">${formatClock(state.remainingMs ?? session.timerMs)}</span>`,
    right: `<span class="phase-badge phase-${session.phase}" id="phase">${PHASE_LABELS[session.phase]}</span>
    <span class="presence ${state.listening ? "listening" : ""}" id="presence" title="Whether the interviewer is listening">${state.listening ? "Interviewer listening" : "Interviewer away"}</span>`,
  })}
<main class="phone">
  <section class="phone-call">
    <section class="briefing phone-briefing" id="briefing" ${session.phase === "briefing" ? "" : "hidden"}>
      <h1>${escapeHtml(title)}</h1>
      <p>${briefingText(session)}</p>
      <div class="button-row">
        <button type="button" class="button primary" id="start-button">Start the call</button>
      </div>
      <p class="muted small" id="speech-support"></p>
    </section>

    <article class="current-question" id="current-question" ${current && session.phase !== "briefing" ? "" : "hidden"}>
      <div class="muted small" id="question-label">${current ? questionLabel(current.n, current.topic) : ""}</div>
      <div class="question-text" id="question-text">${current ? renderMarkdown(current.text) : ""}</div>
    </article>

    <form class="phone-answer" id="answer-form" ${onCall ? "" : "hidden"}>
      <div class="mic-row">
        <button type="button" class="button mic" id="mic-button" aria-pressed="false">Speak</button>
        <span class="mic-state muted small" id="mic-state">Press Speak, answer out loud, then Send. Or type.</span>
      </div>
      <textarea id="answer-text" rows="5" spellcheck="true" placeholder="Your answer appears here as you speak; you can also type."></textarea>
      <div class="button-row">
        <span class="voice-controls">
          <label class="voice-toggle"><input type="checkbox" id="voice-toggle" checked> Read the interviewer aloud</label>
          <select id="voice-select" aria-label="The interviewer's voice" hidden></select>
        </span>
        <span class="save-state" id="save-state"></span>
        <button type="submit" class="button primary" id="send-button">Send</button>
      </div>
    </form>

    <section class="phone-transcript">
      <h2>The call</h2>
      <ol class="call-lines" id="call-lines">${state.lines.map(lineHtml).join("\n")}</ol>
    </section>

    <div class="button-row phone-end" ${onCall ? "" : "hidden"} id="end-row">
      <button type="button" class="button" id="done-button">End the call</button>
    </div>

    <section class="rubric" id="rubric">${phoneRubricHtml(session)}</section>
  </section>

  <aside class="phone-side">
    ${briefsHtml(state)}
    <section class="phone-tips">
      <h2>On a real call</h2>
      <ul>
        <li>Lead with the point, then the detail.</li>
        <li>"Tell me about yourself": 60 to 90 seconds.</li>
        <li>Behavioral: one real story, situation to result, about two minutes.</li>
        <li>Pause instead of "um". A short silence sounds like thinking.</li>
      </ul>
      <p class="muted small">Speech recognition runs in your browser (Chrome and Edge send the audio to their speech service). It drops many "um"s, so the filler count is a floor.</p>
    </section>
  </aside>
</main>`;

  return page({
    title,
    bodyClass: "phone-page",
    body,
    config: {
      sessionId: session.id,
      phase: session.phase,
      timerMs: session.timerMs,
      startedAt: session.startedAt ?? null,
      endedAt: session.endedAt ?? null,
      listening: state.listening,
      format: session.format,
    },
    module: "runtime/phone/main.mjs",
  });
}

function briefingText(session: PhoneSession): string {
  const minutes = Math.round(session.timerMs / 60_000);
  const what =
    session.format === "recruiter"
      ? "a recruiter asks about you, why this company, a project you are proud of, and logistics"
      : session.format === "behavioral"
        ? 'four or five "tell me about a time" questions; answer each with one real story'
        : "short spoken questions on CS fundamentals; answer each in under a minute";
  return `A ${minutes}-minute call: ${what}. Answer out loud with Speak, or type. The interviewer's lines are read aloud; turn that off below if you are somewhere quiet.`;
}

export function questionLabel(n: number, topic?: string): string {
  return `Question ${n}${topic ? ` · ${escapeHtml(topic)}` : ""}`;
}

/** One line of the call; the page script renders the same markup live. */
export function lineHtml(line: PhoneLine): string {
  if (line.kind === "question")
    return `<li class="line line-question" data-n="${line.n}"><div class="line-from">${questionLabel(line.n, line.topic)}</div><div class="line-body">${line.html}</div></li>`;
  if (line.kind === "reply")
    return `<li class="line line-reply" data-n="${line.n}"><div class="line-from">You</div><div class="line-body">${line.html}</div><div class="delivery muted small">${escapeHtml(line.delivery)}</div></li>`;
  return `<li class="line line-${line.from}"><div class="line-from">${line.from === "interviewer" ? "Interviewer" : "You"}</div><div class="line-body">${line.html}</div></li>`;
}

function briefsHtml(state: PhoneState): string {
  if (!state.session.company) return "";
  const company = escapeHtml(state.session.company);
  if (state.briefs.length === 0)
    return `<section class="phone-brief"><h2>${company}'s phone screens</h2><p class="muted small">Nothing on file yet. Ask your agent to research ${company}'s phone screens.</p></section>`;
  return `<section class="phone-brief"><h2>${company}'s phone screens</h2><ul>${state.briefs
    .map(
      (b) =>
        `<li><span class="badge">${escapeHtml(b.format)}</span>${b.minutes ? ` ${b.minutes} min ·` : ""} ${escapeHtml(b.note)} <span class="muted small">${escapeHtml(b.seenAt)} · <a href="${escapeHtml(b.sourceUrl)}" target="_blank" rel="noopener noreferrer">source</a></span></li>`,
    )
    .join("")}</ul></section>`;
}

export function phoneRubricHtml(session: PhoneSession): string {
  const r = session.rubric;
  if (!r) return "";
  const rows = PHONE_DIMENSIONS[session.format]
    .map((dim) => {
      const score = r.scores[dim] ?? 0;
      return `<li><span>${escapeHtml(dim[0]?.toUpperCase() + dim.slice(1))}</span><span class="score">${"●".repeat(score)}${"○".repeat(4 - score)}</span></li>`;
    })
    .join("\n  ");
  const d = deliverySummary(session);
  const delivery = d.spokenReplies
    ? `<p class="muted small">Delivery: ${d.averageWpm ?? "?"} words a minute, ${d.fillersPerMinute ?? "?"} fillers a minute heard, ${d.longPauses} long pause${d.longPauses === 1 ? "" : "s"}, longest answer ${formatDuration(d.longestMs)}.</p>`
    : "";
  const answers = r.answers
    .map((a) => {
      const q = session.questions.find((x) => x.n === a.n);
      return `<li><span class="score">${"●".repeat(a.score)}${"○".repeat(4 - a.score)}</span> <strong>${escapeHtml(q?.text ?? `Question ${a.n}`)}</strong><div class="muted small">${escapeHtml(a.note)}</div></li>`;
    })
    .join("");
  const passed = session.verdict?.correct;
  return `<h2>Debrief <span class="badge ${passed ? "ok" : "warn"}">${passed ? "Passed" : "Not yet"}</span></h2>
<ul class="scores">
  ${rows}
</ul>
${delivery}
<div class="rubric-notes">${renderMarkdown(r.notesMd)}</div>
${answers ? `<h3>Each answer</h3><ul class="answer-scores">${answers}</ul>` : ""}
${r.strengths.length ? `<h3>Strengths</h3><ul>${r.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}
${r.improvements.length ? `<h3>Work on</h3><ul>${r.improvements.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}`;
}
