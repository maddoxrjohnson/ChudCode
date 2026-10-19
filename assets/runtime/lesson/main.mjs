/** The lesson page: wires the answer box, timer, phase, and chat together. */

import { postJson, putJson } from "../shared/api.mjs";
import { el, readConfig } from "../shared/dom.mjs";
import { connectEvents } from "../shared/events.mjs";
import { initTheme } from "../shared/theme.mjs";
import { createChat } from "../session/chat.mjs";
import { createTimer } from "../session/timer.mjs";

const config = readConfig();
const { sessionId } = config;
const api = (action) => `/api/sessions/${sessionId}/${action}`;

initTheme();

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

// ── Answer box with autosave ─────────────────────────────────────────────────

const answer = document.getElementById("answer-text");
const answerForm = document.getElementById("answer-form");
const answerButton = document.getElementById("answer-button");
let lastSaved = config.draft ?? "";
let saveHandle = null;

async function saveDraft() {
  const text = answer.value;
  if (text === lastSaved) return;
  try {
    await putJson(api("draft"), { text });
    lastSaved = text;
    notify("Saved");
  } catch (err) {
    notify(`Autosave failed: ${err.message}`, "error");
  }
}

answer?.addEventListener("input", () => {
  if (saveHandle) clearTimeout(saveHandle);
  saveHandle = setTimeout(() => void saveDraft(), 1500);
});

window.addEventListener("beforeunload", () => {
  if (answer && answer.value !== lastSaved && navigator.sendBeacon) {
    navigator.sendBeacon(
      api("draft"),
      new Blob([JSON.stringify({ text: answer.value })], { type: "application/json" }),
    );
  }
});

const isLab = answerForm?.dataset.lab === "true";

answerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isLab) return submitLab();
  if (!answer.value.trim()) {
    notify("Write your answer first.", "warn");
    answer.focus();
    return;
  }
  answerButton.disabled = true;
  try {
    const { number } = await postJson(api("answer"), { text: answer.value });
    lastSaved = answer.value;
    notify(`Answer ${number} sent to the interviewer`);
  } catch (err) {
    notify(err.message, "error");
  } finally {
    answerButton.disabled = !(phase === "coding" || phase === "review");
  }
});

// ── Lab: preview the files, consent, submit ─────────────────────────────────

const labPath = document.getElementById("lab-path");
const labFiles = document.getElementById("lab-files");
const labConsent = document.getElementById("lab-consent");
const labPreview = document.getElementById("lab-preview");
let previewed = null;

function labReady() {
  return Boolean(previewed && previewed.files.length > 0 && labConsent?.checked);
}

function syncLabButton() {
  if (!isLab || !answerButton) return;
  const working = phase === "coding" || phase === "review";
  answerButton.disabled = !(working && labReady());
}

function renderLabFiles(listing) {
  if (!labFiles) return;
  labFiles.textContent = "";
  if (listing.files.length === 0)
    labFiles.append(el("li", { class: "skipped" }, "None of the files this lab reads are there."));
  for (const file of listing.files)
    labFiles.append(el("li", {}, `${file.path} (${file.bytes.toLocaleString()} bytes)`));
  for (const skip of listing.skipped)
    labFiles.append(el("li", { class: "skipped" }, `${skip.path}: ${skip.reason}`));
}

async function previewLab() {
  previewed = null;
  if (labConsent) {
    labConsent.checked = false;
    labConsent.disabled = true;
  }
  syncLabButton();
  try {
    previewed = await postJson(api("lab-preview"), { path: labPath.value });
    labPath.value = previewed.root;
    renderLabFiles(previewed);
    if (labConsent) labConsent.disabled = previewed.files.length === 0;
  } catch (err) {
    if (labFiles) labFiles.textContent = "";
    notify(err.message, "error");
  }
  syncLabButton();
}

async function submitLab() {
  if (!labReady()) {
    notify("Show the files and tick the box first.", "warn");
    return;
  }
  answerButton.disabled = true;
  try {
    const { number } = await postJson(api("lab"), {
      path: previewed.root,
      note: answer.value,
      consent: true,
    });
    lastSaved = answer.value;
    notify(`Submission ${number} sent to the interviewer`);
  } catch (err) {
    notify(err.message, "error");
  }
  syncLabButton();
}

labPreview?.addEventListener("click", () => void previewLab());
labPath?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void previewLab();
  }
});
labPath?.addEventListener("input", () => {
  // Consent covers the files that were listed; a new path needs a new look.
  previewed = null;
  if (labConsent) {
    labConsent.checked = false;
    labConsent.disabled = true;
  }
  syncLabButton();
});
labConsent?.addEventListener("change", syncLabButton);

function showAnswer({ number, html }) {
  const host = document.getElementById("answers");
  if (!host) return;
  if (!host.querySelector("h2")) host.append(el("h2", {}, "Submitted"));
  for (const open of host.querySelectorAll("details[open]")) open.removeAttribute("open");
  host.append(
    el(
      "details",
      { class: "answer", open: "" },
      el("summary", {}, `Answer ${number}`),
      el("div", { class: "answer-body", html }),
    ),
  );
}

// ── Phase ────────────────────────────────────────────────────────────────────

const LABELS = { briefing: "Reading", coding: "Working", review: "Follow-ups", done: "Finished" };
let phase = config.phase;
const badge = document.getElementById("phase");
const briefing = document.getElementById("briefing");
const doneButton = document.getElementById("done-button");

function applyPhase(next) {
  phase = next;
  if (badge) {
    badge.textContent = LABELS[phase] ?? phase;
    badge.className = `phase-badge phase-${phase}`;
  }
  if (briefing) briefing.hidden = phase !== "briefing";
  const working = phase === "coding" || phase === "review";
  if (answer) answer.disabled = !working;
  if (answerButton) answerButton.disabled = !working;
  if (labPath) labPath.disabled = !working;
  if (labPreview) labPreview.disabled = !working;
  syncLabButton();
  if (doneButton) doneButton.disabled = phase === "review" || phase === "done";
  if (phase === "coding") answer?.focus();
}

document.getElementById("start-button")?.addEventListener("click", async () => {
  try {
    const { session } = await postJson(api("start"));
    applyPhase(session.phase);
  } catch (err) {
    notify(err.message, "error");
  }
});

doneButton?.addEventListener("click", async () => {
  if (!window.confirm("Tell the interviewer you're done? You can still answer follow-ups.")) return;
  try {
    await saveDraft();
    const { session } = await postJson(api("done"));
    applyPhase(session.phase);
  } catch (err) {
    notify(err.message, "error");
  }
});

applyPhase(phase);

// ── Debrief ──────────────────────────────────────────────────────────────────

const DIMENSIONS = [
  ["decomposition", "Decomposition"],
  ["verification", "Verification"],
  ["contextCost", "Context and cost"],
  ["safety", "Safety"],
  ["delegation", "Delegation"],
];

function renderDebrief({ rubric, verdict, focus, notesHtml, nextDue }) {
  const host = document.getElementById("rubric");
  if (!host) return;
  const row = ([key, label]) => {
    const value = rubric[key];
    return el(
      "li",
      {},
      el(
        "span",
        {},
        label,
        focus?.includes(key) ? el("span", { class: "muted small" }, " focus") : null,
      ),
      el(
        "span",
        { class: "score" },
        value === null ? "n/a" : `${"●".repeat(value)}${"○".repeat(4 - value)}`,
      ),
    );
  };
  host.textContent = "";
  host.append(
    el(
      "h2",
      {},
      "Debrief ",
      el(
        "span",
        { class: `badge ${verdict?.correct ? "ok" : "warn"}` },
        verdict?.correct ? "Passed" : "Not yet",
      ),
    ),
    el("ul", { class: "scores" }, ...DIMENSIONS.map(row)),
    el("div", { class: "rubric-notes", html: notesHtml ?? "" }),
    rubric.strengths?.length ? el("h3", {}, "Strengths") : null,
    rubric.strengths?.length ? el("ul", {}, ...rubric.strengths.map((s) => el("li", {}, s))) : null,
    rubric.improvements?.length ? el("h3", {}, "Work on") : null,
    rubric.improvements?.length
      ? el("ul", {}, ...rubric.improvements.map((s) => el("li", {}, s)))
      : null,
    rubric.checklist?.length ? el("h3", {}, "Checklist") : null,
    rubric.checklist?.length
      ? el(
          "ul",
          { class: "checklist-results" },
          ...rubric.checklist.map((c) =>
            el(
              "li",
              { class: `check-${c.status}` },
              el("span", { class: `badge ${c.status === "met" ? "ok" : "warn"}` }, c.status),
              " ",
              config.checklist?.find((i) => i.id === c.id)?.text ?? c.id,
              el("div", { class: "muted small" }, c.note),
            ),
          ),
        )
      : null,
    nextDue ? el("p", { class: "muted" }, nextDue) : null,
  );
  host.scrollIntoView({ block: "nearest" });
}

// ── Live updates ─────────────────────────────────────────────────────────────

const chat = createChat({ sessionId, notify });
const timer = createTimer({
  element: document.getElementById("timer"),
  timerMs: config.timerMs,
  startedAt: config.startedAt,
  endedAt: config.endedAt,
  onExpire: () => void postJson(api("timeout")).catch(() => undefined),
});

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
    answer: (payload) => showAnswer(payload),
    phase: (payload) => {
      timer.update(payload);
      applyPhase(payload.phase);
    },
    presence: (payload) => setPresence(payload.listening),
    rubric: (payload) => renderDebrief(payload),
    reload: () => window.location.reload(),
  },
  { onError: () => setPresence(false) },
);
