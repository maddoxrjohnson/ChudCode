/**
 * The phone screen page: start the call, hear each question, answer by voice or by
 * typing, and see how each answer was delivered. Lines arrive over the session's event
 * stream; markup mirrors src/server/pages/phone.ts.
 */

import { postJson } from "../shared/api.mjs";
import { el, readConfig } from "../shared/dom.mjs";
import { connectEvents } from "../shared/events.mjs";
import { initTheme } from "../shared/theme.mjs";
import { createTimer } from "../session/timer.mjs";
import { createRecorder, speak, speechSupport, stopSpeaking } from "./speech.mjs";

const config = readConfig();
const { sessionId } = config;
const api = (action) => `/api/sessions/${sessionId}/${action}`;
let phase = config.phase;

initTheme();

const $ = (id) => document.getElementById(id);
const answer = $("answer-text");
const sendButton = $("send-button");
const micButton = $("mic-button");
const micState = $("mic-state");
const voiceToggle = $("voice-toggle");
const saveState = $("save-state");
const lines = $("call-lines");

function notify(message, level = "info") {
  if (!saveState) return;
  saveState.textContent = message;
  saveState.className = `save-state ${level}`;
}

// ── Voice preference, kept per browser ───────────────────────────────────────

const VOICE_KEY = "chudcode-phone-voice";
try {
  if (voiceToggle && localStorage.getItem(VOICE_KEY) === "off") voiceToggle.checked = false;
} catch {
  // storage unavailable: keep the default
}
voiceToggle?.addEventListener("change", () => {
  if (!voiceToggle.checked) stopSpeaking();
  try {
    localStorage.setItem(VOICE_KEY, voiceToggle.checked ? "on" : "off");
  } catch {
    // not remembered
  }
});

/** Markdown marks are not read aloud. */
function readAloud(text) {
  if (!voiceToggle?.checked || !text) return;
  speak(text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>]/g, ""));
}

const support = speechSupport();
const supportNote = $("speech-support");
if (supportNote)
  supportNote.textContent = support.recognition
    ? "Your browser can transcribe speech. It will ask for the microphone the first time you press Speak."
    : "This browser cannot transcribe speech (Chrome and Edge can). You can still type every answer.";

// ── The answer: microphone or keyboard ───────────────────────────────────────

// Measured over every stretch the mic was on for this answer.
let measured = { spoken: false, durationMs: 0, longPauses: 0 };

const recorder = createRecorder({
  onText(finalText, interim) {
    answer.value = interim ? `${finalText} ${interim}`.trim() : finalText;
  },
  onState(state) {
    const listening = state === "listening";
    micButton.textContent = listening ? "Stop" : "Speak";
    micButton.setAttribute("aria-pressed", String(listening));
    micButton.classList.toggle("recording", listening);
    micState.textContent =
      state === "blocked"
        ? "The microphone is blocked. Allow it in the address bar, or type."
        : listening
          ? "Listening… press Stop when you finish, then Send."
          : "Press Speak, answer out loud, then Send. Or type.";
  },
});

if (!recorder && micButton) {
  micButton.disabled = true;
  micState.textContent = "Speech needs Chrome or Edge. Type your answers here.";
}

function stopRecording() {
  if (!recorder?.active) return;
  const { durationMs, longPauses } = recorder.stop();
  measured = {
    spoken: true,
    durationMs: measured.durationMs + durationMs,
    longPauses: measured.longPauses + longPauses,
  };
}

micButton?.addEventListener("click", () => {
  if (!recorder) return;
  if (recorder.active) stopRecording();
  else {
    stopSpeaking();
    recorder.start(answer.value);
  }
});

$("answer-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  stopRecording();
  const text = answer.value.trim();
  if (!text) {
    notify("Say or type something first.", "warn");
    return;
  }
  sendButton.disabled = true;
  try {
    await postJson(api("reply"), { text, ...measured });
    answer.value = "";
    measured = { spoken: false, durationMs: 0, longPauses: 0 };
    notify("Sent");
  } catch (err) {
    notify(err.message, "error");
  } finally {
    sendButton.disabled = !(phase === "coding" || phase === "review");
  }
});

// ── The call ─────────────────────────────────────────────────────────────────

function appendLine(kind, label, html, extra) {
  const item = el("li", { class: `line line-${kind}` }, el("div", { class: "line-from" }, label));
  item.append(el("div", { class: "line-body", html }));
  if (extra) item.append(el("div", { class: "delivery muted small" }, extra));
  lines.append(item);
  item.scrollIntoView({ block: "nearest" });
}

function showQuestion(payload) {
  const label = `Question ${payload.n}${payload.topic ? ` · ${payload.topic}` : ""}`;
  $("question-label").textContent = label;
  $("question-text").innerHTML = payload.html;
  $("current-question").hidden = phase === "briefing";
  appendLine("question", label, payload.html);
  readAloud(payload.text);
}

const LABELS = {
  briefing: "Not started",
  coding: "On the call",
  review: "Wrapping up",
  done: "Call ended",
};

function applyPhase(next) {
  phase = next;
  const badge = $("phase");
  badge.textContent = LABELS[phase] ?? phase;
  badge.className = `phase-badge phase-${phase}`;
  $("briefing").hidden = phase !== "briefing";
  const onCall = phase === "coding" || phase === "review";
  $("answer-form").hidden = !onCall;
  $("end-row").hidden = !onCall;
  sendButton.disabled = !onCall;
  $("done-button").disabled = phase === "review" || phase === "done";
  const question = $("current-question");
  question.hidden = phase === "briefing" || !$("question-text").innerHTML.trim();
  if (!onCall) stopRecording();
}

const timer = createTimer({
  element: $("timer"),
  timerMs: config.timerMs,
  startedAt: config.startedAt,
  endedAt: config.endedAt,
  onExpire: () => {
    postJson(api("timeout")).catch(() => {});
  },
});

$("start-button")?.addEventListener("click", async () => {
  try {
    const { session } = await postJson(api("start"));
    timer.update(session);
    applyPhase(session.phase);
    answer.focus();
  } catch (err) {
    notify(err.message, "error");
  }
});

$("done-button")?.addEventListener("click", async () => {
  stopRecording();
  try {
    const { session } = await postJson(api("done"));
    applyPhase(session.phase);
  } catch (err) {
    notify(err.message, "error");
  }
});

const presence = $("presence");
function setPresence(listening) {
  presence.textContent = listening ? "Interviewer listening" : "Interviewer away";
  presence.classList.toggle("listening", listening);
}

applyPhase(phase);

connectEvents(
  `/api/events?session=${encodeURIComponent(sessionId)}`,
  {
    message: (payload) => {
      appendLine(
        payload.from,
        payload.from === "interviewer" ? "Interviewer" : "You",
        payload.html,
      );
      if (payload.from === "interviewer") readAloud(payload.text ?? "");
    },
    question: (payload) => showQuestion(payload),
    reply: (payload) => appendLine("reply", "You", payload.html, payload.delivery),
    phase: (payload) => {
      timer.update(payload);
      applyPhase(payload.phase);
    },
    presence: (payload) => setPresence(payload.listening),
    // The debrief is rendered by the server; reload to show it.
    rubric: () => window.location.reload(),
  },
  { onError: () => setPresence(false) },
);
