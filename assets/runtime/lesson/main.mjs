/** The lesson page: wires the answer box, timer, phase, and chat together. */

import { getJson, postJson, putJson } from "../shared/api.mjs";
import { el, readConfig } from "../shared/dom.mjs";
import { connectEvents } from "../shared/events.mjs";
import { initTheme } from "../shared/theme.mjs";
import { createChat } from "../session/chat.mjs";
import { createTimer } from "../session/timer.mjs";
import { createNextUp } from "../shared/next-up.mjs";

const config = readConfig();
const { sessionId } = config;
const api = (action) => `/api/sessions/${sessionId}/${action}`;

initTheme();

/** Append children, skipping the nulls that conditional parts leave (append prints them). */
function appendAll(node, ...children) {
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
}

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
const isMedia = answerForm?.dataset.media === "true";
const isTranscript = answerForm?.dataset.transcript === "true";

answerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isLab) return submitLab();
  if (isTranscript) return submitTranscript();
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
  if (isTranscript) return Boolean(chosenTranscript && labConsent?.checked);
  return Boolean(previewed && previewed.files.length > 0 && labConsent?.checked);
}

function syncLabButton() {
  if (!(isLab || isTranscript) || !answerButton) return;
  const working = phase === "coding" || phase === "review";
  answerButton.disabled = !(working && labReady());
}

function renderLabFiles(listing) {
  if (!labFiles) return;
  labFiles.textContent = "";
  if (listing.files.length === 0)
    labFiles.append(
      el(
        "li",
        { class: "skipped" },
        isMedia
          ? "No site pages, README, or media files are there."
          : "None of the files this lab reads are there.",
      ),
    );
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

// ── Transcript: list recent sessions, pick one, consent ─────────────────────

const transcriptList = document.getElementById("transcripts");
let chosenTranscript = null;

async function listTranscripts() {
  try {
    const { transcripts } = await postJson(api("transcripts"));
    transcriptList.textContent = "";
    if (transcripts.length === 0)
      transcriptList.append(el("li", { class: "muted" }, "No Claude Code sessions found."));
    for (const t of transcripts) {
      const input = el("input", { type: "radio", name: "transcript", value: t.id });
      input.addEventListener("change", () => {
        chosenTranscript = t.id;
        if (labConsent) labConsent.disabled = false;
        syncLabButton();
      });
      transcriptList.append(
        el(
          "li",
          {},
          el(
            "label",
            {},
            input,
            " ",
            el("code", {}, t.project),
            ` ${new Date(t.modifiedAt).toLocaleString()} · ${(t.bytes / 1024).toFixed(0)} KB`,
            t.firstPrompt ? el("div", { class: "muted small" }, t.firstPrompt) : null,
          ),
        ),
      );
    }
  } catch (err) {
    notify(err.message, "error");
  }
}

async function submitTranscript() {
  if (!labReady()) {
    notify("Pick a session and tick the box first.", "warn");
    return;
  }
  answerButton.disabled = true;
  try {
    const { number } = await postJson(api("transcript"), {
      id: chosenTranscript,
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

document.getElementById("transcript-list")?.addEventListener("click", () => void listTranscripts());

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

// ── Drill: grade the tests in the workspace ─────────────────────────────────

const gradeButton = document.getElementById("grade-button");
const gradeResult = document.getElementById("grade-result");

function renderRefactor(grade) {
  if (!gradeResult) return;
  const row = (ok, text) =>
    el(
      "li",
      {},
      el("span", { class: `badge ${ok ? "ok" : "warn"}` }, ok ? "yes" : "no"),
      ` ${text}`,
    );
  gradeResult.textContent = "";
  gradeResult.append(
    el(
      "p",
      {},
      el(
        "span",
        { class: `badge ${grade.passed ? "ok" : "warn"}` },
        grade.passed ? "Past the gate" : "Not yet",
      ),
      ` Grade ${grade.number}`,
    ),
    el(
      "ul",
      { class: "checklist-results" },
      row(grade.testsFirst, "Tests committed before the module changed"),
      row(
        grade.mutants > 0 && grade.killed / grade.mutants >= 0.6,
        `Characterisation caught ${grade.killed} of ${grade.mutants} planted bugs in the original`,
      ),
      row(grade.behaviourKept, "Hidden behaviour tests pass on your refactor"),
      row(grade.ownTestsPass, "Your own tests pass on your refactor"),
      row(grade.apiSame, "Public functions and parameters unchanged"),
      row(
        grade.after.longestFunction < grade.before.longestFunction ||
          grade.after.maxNesting < grade.before.maxNesting,
        `Longest function ${grade.before.longestFunction} → ${grade.after.longestFunction} lines, deepest nesting ${grade.before.maxNesting} → ${grade.after.maxNesting}`,
      ),
    ),
  );
}

function renderGrade(grade) {
  if ("testsFirst" in grade) return renderRefactor(grade);
  if (!gradeResult) return;
  const pct = grade.mutants ? Math.round((grade.killed / grade.mutants) * 100) : 0;
  gradeResult.textContent = "";
  appendAll(
    gradeResult,
    el(
      "p",
      {},
      el(
        "span",
        { class: `badge ${grade.passed ? "ok" : "warn"}` },
        grade.passed ? "Past the gate" : "Not yet",
      ),
      ` Grade ${grade.number}: ${grade.tests} tests caught `,
      el("strong", {}, `${grade.killed} of ${grade.mutants}`),
      ` planted bugs (${pct}%).`,
    ),
    el("meter", {
      min: "0",
      max: String(grade.mutants),
      low: String(Math.ceil(grade.mutants * 0.8) - 0.5),
      optimum: String(grade.mutants),
      value: String(grade.killed),
    }),
    grade.problems.length ? el("ul", {}, ...grade.problems.map((p) => el("li", {}, p))) : null,
    grade.assertFree
      ? el(
          "p",
          { class: "muted small" },
          `${grade.assertFree} test${grade.assertFree === 1 ? "" : "s"} assert nothing.`,
        )
      : null,
  );
}

gradeButton?.addEventListener("click", async () => {
  gradeButton.disabled = true;
  notify("Grading: running your tests against every variant…");
  try {
    const { grade } = await postJson(api("grade"));
    renderGrade(grade);
    notify(`Grade ${grade.number} sent to the interviewer`);
  } catch (err) {
    notify(err.message, "error");
  } finally {
    gradeButton.disabled = !(phase === "coding" || phase === "review");
  }
});

// ── Flaw review: mark lines of the diff, then submit ────────────────────────

const flawReview = document.getElementById("flaw-review");
const markForm = document.getElementById("mark-form");
const markWhere = document.getElementById("mark-where");
const markCategory = document.getElementById("mark-category");
const markReason = document.getElementById("mark-reason");
const marksList = document.getElementById("marks");
const reviewButton = document.getElementById("review-button");
const reviewResult = document.getElementById("review-result");
let marks = [];
let pending = null;
if (flawReview) {
  try {
    const saved = JSON.parse(config.draft || "[]");
    if (Array.isArray(saved)) marks = saved;
  } catch {
    marks = [];
  }
}

function saveMarks() {
  void putJson(api("draft"), { text: JSON.stringify(marks) }).catch(() => undefined);
}

function renderMarks() {
  if (!marksList) return;
  marksList.textContent = "";
  for (const row of flawReview?.querySelectorAll("tr.marked") ?? []) row.classList.remove("marked");
  marks.forEach((mark, i) => {
    flawReview
      ?.querySelector(`tr[data-file="${CSS.escape(mark.file)}"][data-line="${mark.line}"]`)
      ?.classList.add("marked");
    marksList.append(
      el(
        "li",
        {},
        el("code", {}, `${mark.file}:${mark.line}`),
        ` ${mark.category}`,
        mark.reason ? el("span", { class: "muted small" }, ` ${mark.reason}`) : null,
        " ",
        el(
          "button",
          {
            type: "button",
            class: "link-button",
            onclick: () => {
              marks.splice(i, 1);
              renderMarks();
              saveMarks();
            },
          },
          "remove",
        ),
      ),
    );
  });
}

function openMark(row) {
  if (!markForm || !(phase === "coding" || phase === "review")) return;
  pending = { file: row.dataset.file, line: Number(row.dataset.line) };
  markWhere.textContent = `${pending.file}:${pending.line}`;
  markReason.value = "";
  markForm.hidden = false;
  markForm.scrollIntoView({ block: "nearest" });
  markReason.focus();
}

flawReview?.addEventListener("click", (event) => {
  const row = event.target.closest?.("tr[data-line]");
  if (row) openMark(row);
});
flawReview?.addEventListener("keydown", (event) => {
  const row = event.target.closest?.("tr[data-line]");
  if (row && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openMark(row);
  }
});
document.getElementById("mark-cancel")?.addEventListener("click", () => {
  markForm.hidden = true;
  pending = null;
});
markForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!pending) return;
  marks.push({ ...pending, category: markCategory.value, reason: markReason.value.trim() });
  marks.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  pending = null;
  markForm.hidden = true;
  renderMarks();
  saveMarks();
});

function renderReview(grade) {
  if (!reviewResult) return;
  reviewResult.textContent = "";
  appendAll(
    reviewResult,
    el(
      "p",
      {},
      el(
        "span",
        { class: `badge ${grade.passed ? "ok" : "warn"}` },
        grade.passed ? "Past the gate" : "Not yet",
      ),
      ` Review ${grade.number}: found `,
      el("strong", {}, `${grade.found} of ${grade.flaws}`),
      ` planted flaws, ${grade.falseAlarms} false alarm${grade.falseAlarms === 1 ? "" : "s"}.`,
    ),
    grade.problems.length ? el("ul", {}, ...grade.problems.map((p) => el("li", {}, p))) : null,
  );
}

reviewButton?.addEventListener("click", async () => {
  if (marks.length === 0) {
    notify("Mark at least one line first.", "warn");
    return;
  }
  if (!window.confirm(`Submit ${marks.length} mark${marks.length === 1 ? "" : "s"} for grading?`))
    return;
  reviewButton.disabled = true;
  try {
    const { grade } = await postJson(api("review"), { marks });
    renderReview(grade);
    notify(`Review ${grade.number} sent to the interviewer`);
  } catch (err) {
    notify(err.message, "error");
  } finally {
    reviewButton.disabled = !(phase === "coding" || phase === "review");
  }
});

renderMarks();

// ── Cache plan: simulate the plan in the editor ─────────────────────────────

const planButton = document.getElementById("plan-button");
const planResult = document.getElementById("plan-result");
const usd = (v) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`);

// ── Media lab: the latest measurement ───────────────────────────────────────
// Mirrors mediaResultsHtml in src/server/pages/lesson.ts.

const CHECK_ORDER = { fail: 0, warn: 1, pass: 2 };
const CHECK_LABEL = { fail: "Fails", warn: "Warning", pass: "Passes" };

function renderMeasured(payload) {
  const host = document.getElementById("media-results");
  if (!host) return;
  const shown = payload.checks
    .filter((c) => c.status !== "n/a")
    .sort((a, b) => (CHECK_ORDER[a.status] ?? 3) - (CHECK_ORDER[b.status] ?? 3));
  const failed = shown.filter((c) => c.status === "fail").length;
  const summary =
    failed === 0
      ? "Every fail-level check passed."
      : `${failed} ${failed === 1 ? "check" : "checks"} must pass before the lesson can: fix ${failed === 1 ? "it" : "them"} and submit again.`;
  const list = el("ul", { class: "media-checks" });
  for (const check of shown) {
    const item = el(
      "li",
      { class: `check check-${check.status}` },
      el(
        "span",
        { class: `badge ${check.status === "pass" ? "ok" : "warn"}` },
        CHECK_LABEL[check.status],
      ),
      ` ${check.title}`,
    );
    if (check.findings.length > 0)
      item.append(
        el(
          "ul",
          { class: "findings" },
          ...check.findings.map((f) => el("li", {}, el("code", {}, f))),
        ),
      );
    list.append(item);
  }
  host.textContent = "";
  host.append(el("h2", {}, "Measured"), el("p", {}, summary), list);
  host.hidden = false;
}

function renderPlan(grade) {
  if (!planResult) return;
  planResult.textContent = "";
  planResult.append(
    el(
      "p",
      {},
      el(
        "span",
        { class: `badge ${grade.passed ? "ok" : "warn"}` },
        grade.passed ? "Past the gate" : "Not yet",
      ),
      ` Plan ${grade.number}: `,
      el("strong", {}, usd(grade.cost)),
      `, ${(grade.ratio * 100).toFixed(0)}% of the best plan known (the bar is 110%).`,
    ),
    el(
      "p",
      { class: "muted small" },
      `Cache hits on ${grade.hits} of ${grade.requests} requests; ${grade.readTokens.toLocaleString("en-US")} tokens read, ${grade.writeTokens.toLocaleString("en-US")} written, ${grade.uncachedTokens.toLocaleString("en-US")} uncached. With no caching: ${usd(grade.uncachedCost)}.`,
    ),
  );
}

planButton?.addEventListener("click", async () => {
  let plan;
  try {
    plan = JSON.parse(answer.value);
  } catch (err) {
    notify(`That is not valid JSON: ${err.message}`, "error");
    return;
  }
  planButton.disabled = true;
  try {
    await saveDraft();
    const { grade } = await postJson(api("plan"), { plan });
    renderPlan(grade);
    notify(`Plan ${grade.number} sent to the interviewer`);
  } catch (err) {
    notify(err.message, "error");
  } finally {
    planButton.disabled = !(phase === "coding" || phase === "review");
  }
});

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
  if (gradeButton) gradeButton.disabled = !working;
  if (reviewButton) reviewButton.disabled = !working;
  if (planButton) planButton.disabled = !working;
  if (labPath) labPath.disabled = !working;
  if (labPreview) labPreview.disabled = !working;
  const listButton = document.getElementById("transcript-list");
  if (listButton) listButton.disabled = !working;
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
  ["presentation", "Presentation"],
];

function survivorsBlock(survivors) {
  if (!survivors) return [];
  if (survivors.length === 0)
    return [el("h3", {}, "Planted bugs"), el("p", {}, "Your tests caught every one.")];
  return [
    el("h3", {}, "Bugs your tests missed"),
    el("ul", { class: "survivors" }, ...survivors.map((m) => el("li", {}, m.description))),
  ];
}

function revealBlock(reveal) {
  if (!reveal) return [];
  if (reveal.kind === "cache-plan")
    return [
      el("h3", {}, "The best plan known"),
      el("p", {}, usd(reveal.referenceCost)),
      el("pre", {}, el("code", {}, JSON.stringify(reveal.reference, null, 2))),
    ];
  return [
    el("h3", {}, "The planted flaws"),
    el(
      "ul",
      { class: "checklist-results" },
      ...reveal.flaws.map((f) =>
        el(
          "li",
          {},
          el("span", { class: `badge ${f.found ? "ok" : "warn"}` }, f.found ? "found" : "missed"),
          " ",
          el("code", {}, `${f.file}:${f.line}`),
          ` ${f.category}${f.critical ? " (critical)" : ""}`,
          el("div", { class: "muted small" }, f.explanation),
        ),
      ),
    ),
    reveal.falseAlarms.length ? el("h3", {}, "False alarms") : null,
    reveal.falseAlarms.length
      ? el(
          "ul",
          {},
          ...reveal.falseAlarms.map((a) =>
            el(
              "li",
              {},
              el("code", {}, `${a.file}:${a.line}`),
              a.decoy ? el("span", { class: "muted small" }, ` ${a.decoy}`) : null,
            ),
          ),
        )
      : null,
  ];
}

function renderDebrief({ rubric, verdict, focus, notesHtml, nextDue, survivors, reveal }) {
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
        value === null || value === undefined
          ? "n/a"
          : `${"●".repeat(value)}${"○".repeat(4 - value)}`,
      ),
    );
  };
  host.textContent = "";
  appendAll(
    host,
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
    ...survivorsBlock(survivors),
    ...revealBlock(reveal),
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
const nextUp = createNextUp({ from: sessionId });

/** After a debrief, the Next lesson row arrives from the server and is wired up. */
async function showNextLesson() {
  try {
    const { html } = await getJson(api("next-up"));
    const host = document.getElementById("rubric");
    if (!html || !host || host.querySelector(".next-up")) return;
    host.insertAdjacentHTML("beforeend", html);
    nextUp.bind(host);
  } catch {
    // The row is a convenience; the terminal still works.
  }
}
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
    grade: (payload) => renderGrade(payload),
    refactor: (payload) => renderRefactor(payload),
    review: (payload) => renderReview(payload),
    plan: (payload) => renderPlan(payload),
    measured: (payload) => renderMeasured(payload),
    phase: (payload) => {
      timer.update(payload);
      applyPhase(payload.phase);
    },
    presence: (payload) => {
      setPresence(payload.listening);
      nextUp.presence(payload.connected ?? payload.listening);
    },
    rubric: (payload) => {
      renderDebrief(payload);
      void showNextLesson();
    },
    next: (payload) => nextUp.pending(payload.pending),
    next_session: (payload) => nextUp.open(payload),
    reload: () => window.location.reload(),
  },
  { onError: () => setPresence(false) },
);
