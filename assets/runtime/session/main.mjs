/** The session page: wires the editor, timer, phase, tests, chat, and hints together. */

import { postJson, putJson } from "../shared/api.mjs";
import { readConfig } from "../shared/dom.mjs";
import { connectEvents } from "../shared/events.mjs";
import { initTheme } from "../shared/theme.mjs";
import { createChat } from "./chat.mjs";
import { mountEditor } from "./editor.mjs";
import { createHints } from "./hints.mjs";
import { createPhase } from "./phase.mjs";
import { renderRubric } from "./rubric.mjs";
import { createTestsPanel } from "./tests-panel.mjs";
import { createTimer } from "./timer.mjs";

const config = readConfig();
const { sessionId } = config;
const api = (action) => `/api/sessions/${sessionId}/${action}`;

// ── Notices ──────────────────────────────────────────────────────────────────

const saveState = document.getElementById("save-state");
let noticeTimer = null;
function notify(message, level = "info") {
  if (!saveState) return;
  saveState.textContent = message;
  saveState.className = `save-state ${level}`;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    saveState.textContent = "";
    saveState.className = "save-state";
  }, 4000);
}

// ── Editor with autosave ─────────────────────────────────────────────────────

let editor = null;
const theme = initTheme((next) => editor?.setDark(next === "dark"));
let saveHandle = null;
let lastSaved = config.draft;

editor = mountEditor({
  host: document.getElementById("editor"),
  doc: config.draft,
  autocomplete: config.editor?.autocomplete ?? false,
  dark: theme === "dark",
  onChange(text) {
    if (saveHandle) clearTimeout(saveHandle);
    saveHandle = setTimeout(() => void saveDraft(text), 1500);
  },
});

async function saveDraft(text) {
  if (text === lastSaved) return;
  try {
    await putJson(api("draft"), { code: text });
    lastSaved = text;
    notify("Saved");
  } catch (err) {
    notify(`Autosave failed: ${err.message}`, "error");
  }
}

window.addEventListener("beforeunload", () => {
  const text = editor.getValue();
  if (text !== lastSaved && navigator.sendBeacon) {
    navigator.sendBeacon(
      api("draft"),
      new Blob([JSON.stringify({ code: text })], { type: "application/json" }),
    );
  }
});

// ── Panels ───────────────────────────────────────────────────────────────────

const tests = createTestsPanel({ paramOrder: config.paramOrder ?? [] });
const chat = createChat({ sessionId, notify });
const hints = createHints({
  sessionId,
  used: config.hintsUsed ?? [],
  total: config.hintsTotal ?? 0,
  notify,
});
const timer = createTimer({
  element: document.getElementById("timer"),
  timerMs: config.timerMs,
  startedAt: config.startedAt,
  endedAt: config.endedAt,
  onExpire: () => void postJson(api("timeout")).catch(() => undefined),
});
const phase = createPhase({
  sessionId,
  initial: config.phase,
  notify,
  onChange(next) {
    if (next === "done") hints.lock();
    if (next === "coding") editor.focus();
  },
});

// ── Run and submit ───────────────────────────────────────────────────────────

const runButton = document.getElementById("run-button");
const submitButton = document.getElementById("submit-button");
let busy = false;

async function execute(kind, body) {
  if (busy) return;
  busy = true;
  runButton.disabled = true;
  submitButton.disabled = true;
  tests.begin(kind);
  try {
    const response = await postJson(api(kind === "hidden" ? "submit" : "run"), body);
    tests.final(response.candidate, kind);
    lastSaved = body.code;
  } catch (err) {
    tests.error(err.message);
  } finally {
    busy = false;
    const canCode = phase.current === "coding" || phase.current === "review";
    runButton.disabled = !canCode;
    submitButton.disabled = !canCode;
  }
}

runButton?.addEventListener("click", () => void execute("visible", { code: editor.getValue() }));
submitButton?.addEventListener("click", () => void execute("hidden", { code: editor.getValue() }));

document.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
  if (!document.activeElement?.closest(".editor-host")) return;
  event.preventDefault();
  void execute(event.shiftKey ? "hidden" : "visible", { code: editor.getValue() });
});

const customToggle = document.getElementById("custom-input-toggle");
const customForm = document.getElementById("custom-input");
const customText = document.getElementById("custom-input-text");
customToggle?.addEventListener("click", () => {
  customForm.hidden = !customForm.hidden;
  if (!customForm.hidden) customText.focus();
});
customForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  let parsed;
  try {
    parsed = JSON.parse(customText.value);
  } catch {
    notify('Custom input must be valid JSON, e.g. {"nums": [1, 2], "k": 1}', "warn");
    return;
  }
  void execute("custom", {
    code: editor.getValue(),
    custom: Array.isArray(parsed) ? parsed : [parsed],
  });
});

// ── Live updates ─────────────────────────────────────────────────────────────

const presence = document.getElementById("presence");
function setPresence(listening) {
  if (!presence) return;
  presence.textContent = listening ? "Interviewer listening" : "Interviewer away";
  presence.classList.toggle("listening", listening);
}

connectEvents(
  `/api/events?session=${encodeURIComponent(sessionId)}`,
  {
    message: (payload) => chat.append(payload),
    note: (payload) => chat.noteAdded(payload),
    hint: (payload) => hints.show(payload.hint),
    phase: (payload) => {
      timer.update(payload);
      phase.apply(payload.phase);
    },
    presence: (payload) => setPresence(payload.listening),
    rubric: (payload) => renderRubric(payload),
    run: (payload) => {
      if (payload.partial) tests.partial(payload.partial);
      else if (payload.result && payload.kind === "interviewer")
        tests.final(payload.result, payload.kind);
    },
    reload: () => window.location.reload(),
  },
  { onError: () => setPresence(false) },
);
