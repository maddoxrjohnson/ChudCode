/**
 * The project session page: a file tree and editor over the candidate's workspace,
 * Run and Submit, the clock, resizable panels, and the interviewer's chat and hints.
 *
 * Every file is saved to the workspace as it is edited, so the candidate can switch
 * between this editor and their own. When the window regains focus, the open file is
 * read back from disk and replaced if it changed there and has no unsaved edits here.
 */

import { getJson, postJson, putJson } from "../shared/api.mjs";
import { clip, el, readConfig } from "../shared/dom.mjs";
import { connectEvents } from "../shared/events.mjs";
import { initTheme } from "../shared/theme.mjs";
import { createChat } from "../session/chat.mjs";
import { mountEditor } from "../session/editor.mjs";
import { createHints } from "../session/hints.mjs";
import { createTimer } from "../session/timer.mjs";

const config = readConfig();
const { sessionId } = config;
const api = (action) => `/api/sessions/${sessionId}/${action}`;
const PHASE_LABELS = {
  briefing: "Briefing",
  coding: "Working",
  review: "Debrief",
  done: "Finished",
};
const DIMENSION_LABELS = {
  correctness: "Correctness",
  debugging: "Debugging",
  codeQuality: "Code quality",
  time: "Time",
};

// ── Notices ──────────────────────────────────────────────────────────────────

const saveState = document.getElementById("save-state");
let noticeTimer = null;
function notify(message, level = "info") {
  saveState.textContent = message;
  saveState.className = `save-state ${level}`;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    saveState.textContent = "";
    saveState.className = "save-state";
  }, 4000);
}

// ── Phase ────────────────────────────────────────────────────────────────────

let phase = config.phase;
const canEdit = () => phase === "coding" || phase === "review";

function applyPhase(next) {
  phase = next;
  const badge = document.getElementById("phase");
  badge.textContent = PHASE_LABELS[phase] ?? phase;
  badge.className = `phase-badge phase-${phase}`;
  const over = phase === "review" || phase === "done";
  document.getElementById("briefing").hidden = phase !== "briefing";
  document.getElementById("start-button").hidden = phase !== "briefing";
  document.getElementById("run-button").disabled = !canEdit();
  document.getElementById("submit-button").disabled = !canEdit();
  const done = document.getElementById("done-button");
  done.hidden = phase === "briefing";
  done.disabled = over;
  // An online assessment opens the chat, and the side panel with it, only once the
  // clock stops.
  const quiet = config.oa && !over;
  document.getElementById("chat").hidden = quiet;
  document.getElementById("presence").hidden = quiet;
  document.getElementById("side-pane").hidden =
    quiet && !document.getElementById("rubric").hasChildNodes();
  if (phase === "done") hints.lock();
  syncReadOnly();
}

document.getElementById("start-button")?.addEventListener("click", async () => {
  try {
    const { session } = await postJson(api("start"));
    timer.update(session);
    applyPhase(session.phase);
    editor.focus();
  } catch (err) {
    notify(err.message, "error");
  }
});

document.getElementById("done-button")?.addEventListener("click", async () => {
  const prompt = config.oa
    ? "Finish the assessment? The clock stops and your last submission is what counts."
    : "Tell the interviewer you're done? You can still talk and run tests.";
  if (!window.confirm(prompt)) return;
  await flush();
  try {
    const { session } = await postJson(api("done"));
    timer.update(session);
    applyPhase(session.phase);
  } catch (err) {
    notify(err.message, "error");
  }
});

// ── Files ────────────────────────────────────────────────────────────────────

let tree = config.tree ?? [];
let current = null; // { path, readOnly, saved }
let saveHandle = null;
let switching = false;

const theme = initTheme((next) => editor?.setDark(next === "dark"));
const editor = mountEditor({
  host: document.getElementById("editor"),
  doc: "",
  autocomplete: config.autocomplete ?? false,
  dark: theme === "dark",
  onChange() {
    if (switching || !current || current.readOnly || !canEdit()) return;
    if (saveHandle) clearTimeout(saveHandle);
    saveHandle = setTimeout(() => void save(), 800);
  },
});

function syncReadOnly() {
  const locked = !current || current.readOnly || !canEdit();
  editor.setReadOnly(locked);
  document.getElementById("file-readonly").hidden = !current?.readOnly;
  document.getElementById("reset-file").hidden = !current || !canEdit() || !isChanged(current.path);
}

function isChanged(path) {
  return tree.find((f) => f.path === path)?.changed ?? false;
}

async function save() {
  if (!current || current.readOnly) return;
  const text = editor.getValue();
  if (text === current.saved) return;
  try {
    const { tree: next } = await putJson(api("file"), { path: current.path, text });
    current.saved = text;
    tree = next;
    renderTree();
    syncReadOnly();
    notify("Saved");
  } catch (err) {
    notify(`Not saved: ${err.message}`, "error");
  }
}

async function flush() {
  if (saveHandle) clearTimeout(saveHandle);
  saveHandle = null;
  await save();
}

async function open(path) {
  await flush();
  try {
    const file = await getJson(`${api("file")}?path=${encodeURIComponent(path)}`);
    switching = true;
    editor.setValue(file.text);
    switching = false;
    current = { path: file.path, readOnly: file.readOnly, saved: file.text };
    document.getElementById("file-name").textContent = file.path;
    renderTree();
    syncReadOnly();
  } catch (err) {
    switching = false;
    notify(err.message, "error");
  }
}

/** Pick up a change made in another editor, unless this one has unsaved edits. */
async function refreshFromDisk() {
  if (!current) return;
  try {
    const file = await getJson(`${api("file")}?path=${encodeURIComponent(current.path)}`);
    if (file.text !== current.saved && editor.getValue() === current.saved) {
      switching = true;
      editor.setValue(file.text);
      switching = false;
      current.saved = file.text;
      notify("Reloaded from disk");
    }
    const state = await getJson(`/api/sessions/${sessionId}`);
    tree = state.tree;
    renderTree();
  } catch {
    /* the next save reports any problem */
  }
}
window.addEventListener("focus", () => void refreshFromDisk());

document.getElementById("reset-file").addEventListener("click", async () => {
  if (
    !current ||
    !window.confirm(`Put ${current.path} back the way it started? Your changes to it are lost.`)
  )
    return;
  try {
    const { text } = await postJson(api("reset"), { path: current.path });
    switching = true;
    editor.setValue(text);
    switching = false;
    current.saved = text;
    await refreshFromDisk();
    syncReadOnly();
    notify("Reset");
  } catch (err) {
    notify(err.message, "error");
  }
});

function renderTree() {
  const host = document.getElementById("file-tree");
  host.textContent = "";
  const list = el("ul", {});
  let folder = "";
  for (const file of tree) {
    const parts = file.path.split("/");
    const dir = parts.slice(0, -1).join("/");
    if (dir && dir !== folder) list.append(el("li", { class: "tree-folder" }, `${dir}/`));
    folder = dir;
    const classes = ["tree-file"];
    if (current?.path === file.path) classes.push("active");
    if (file.changed) classes.push("changed");
    if (file.readOnly) classes.push("readonly");
    list.append(
      el(
        "li",
        { class: classes.join(" ") },
        el(
          "button",
          {
            type: "button",
            style: `padding-left: ${0.5 + (parts.length - 1) * 0.75}rem`,
            title: file.readOnly ? `${file.path} (read-only)` : file.path,
            onclick: () => void open(file.path),
          },
          parts.at(-1),
          file.changed ? el("span", { class: "tree-mark" }, " ●") : null,
        ),
      ),
    );
  }
  host.append(list);
}

// ── Results ──────────────────────────────────────────────────────────────────

const STATUS = {
  pass: "Passed",
  fail: "Failed",
  error: "Error",
  skip: "Skipped",
  timeout: "Timed out",
};
const runButton = document.getElementById("run-button");
const submitButton = document.getElementById("submit-button");
let busy = false;

function renderResult(result) {
  const list = document.getElementById("case-list");
  const summary = document.getElementById("tests-summary");
  list.textContent = "";
  if (result.error) {
    list.append(
      el(
        "li",
        { class: "case case-error" },
        el(
          "div",
          { class: "case-header" },
          el("span", { class: "status status-error" }, "Error"),
          el(
            "span",
            { class: "case-label" },
            result.status === "protected" ? "Read-only file changed" : "The tests did not finish",
          ),
        ),
        el(
          "div",
          { class: "case-details" },
          el("pre", { class: "kv-value" }, clip(result.error, 4000)),
        ),
      ),
    );
  }
  for (const test of result.tests) {
    const header = el(
      "div",
      { class: "case-header" },
      el("span", { class: `status status-${test.status}` }, STATUS[test.status] ?? test.status),
      el("span", { class: "case-label" }, test.label),
      test.hidden ? el("span", { class: "muted small" }, "hidden") : null,
    );
    const li = el("li", { class: `case case-${test.status}` }, header);
    if (test.message) {
      li.append(
        el(
          "div",
          { class: "case-details" },
          el("pre", { class: "kv-value" }, clip(test.message, 4000)),
        ),
      );
      header.classList.add("clickable");
      header.addEventListener("click", () => li.classList.toggle("collapsed"));
    }
    list.append(li);
  }
  const verb = result.kind === "submit" ? `Submission ${result.number ?? ""}`.trim() : "Ran tests/";
  const all = result.status === "ok" && result.total > 0 && result.passed === result.total;
  summary.textContent =
    result.status === "protected"
      ? "Submission refused"
      : `${verb}: ${result.passed}/${result.total} passed`;
  summary.className = `tests-summary ${all ? "all-pass" : "has-fail"}`;
}

async function execute(kind) {
  if (busy || !canEdit()) return;
  busy = true;
  runButton.disabled = true;
  submitButton.disabled = true;
  const summary = document.getElementById("tests-summary");
  summary.textContent = kind === "submit" ? "Submitting… running every test" : "Running tests/…";
  summary.className = "tests-summary running";
  try {
    await flush();
    renderResult(await postJson(api(kind)));
  } catch (err) {
    summary.textContent = err.message;
    summary.className = "tests-summary has-fail";
  } finally {
    busy = false;
    runButton.disabled = !canEdit();
    submitButton.disabled = !canEdit();
  }
}

runButton.addEventListener("click", () => void execute("run"));
submitButton.addEventListener("click", () => void execute("submit"));
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
    event.preventDefault();
    void flush();
    return;
  }
  if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
  if (!document.activeElement?.closest(".editor-host")) return;
  event.preventDefault();
  void execute(event.shiftKey ? "submit" : "run");
});

// ── Debrief ──────────────────────────────────────────────────────────────────

function renderRubric({ rubric, verdict, notesHtml, nextDue, dimensions, bugs }) {
  const host = document.getElementById("rubric");
  document.getElementById("side-pane").hidden = false;
  const score = (label, value) =>
    el(
      "li",
      {},
      el("span", {}, label),
      el("span", { class: "score" }, `${"●".repeat(value)}${"○".repeat(4 - value)}`),
    );
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
    el(
      "ul",
      { class: "scores" },
      ...dimensions.map((d) => score(DIMENSION_LABELS[d] ?? d, rubric.scores[d])),
    ),
    el("div", { class: "rubric-notes", html: notesHtml ?? "" }),
    bugs?.length ? el("h3", {}, "The planted bugs") : null,
    bugs?.length
      ? el(
          "ul",
          { class: "bug-list" },
          ...bugs.map((b) =>
            el(
              "li",
              { class: b.fixed ? "fixed" : "open" },
              el("strong", {}, b.fixed ? "Fixed: " : "Missed: "),
              b.summary,
            ),
          ),
        )
      : null,
    rubric.strengths?.length ? el("h3", {}, "Strengths") : null,
    rubric.strengths?.length ? el("ul", {}, ...rubric.strengths.map((s) => el("li", {}, s))) : null,
    rubric.improvements?.length ? el("h3", {}, "Work on") : null,
    rubric.improvements?.length
      ? el("ul", {}, ...rubric.improvements.map((s) => el("li", {}, s)))
      : null,
    nextDue ? el("p", { class: "muted" }, nextDue) : null,
  );
  host.scrollIntoView({ block: "nearest" });
}

// ── Layout ───────────────────────────────────────────────────────────────────

// The question's width, the results panel's height, and whether the question is
// shown are remembered per browser, like an IDE's layout.
const layout = document.getElementById("project-layout");
const LAYOUT_KEY = "chudcode.projectLayout";

function loadLayout() {
  try {
    return JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

const layoutState = loadLayout();

function saveLayout() {
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutState));
  } catch {
    /* the layout simply resets next time */
  }
}

function applyLayout() {
  if (layoutState.statementWidth)
    layout.style.setProperty("--statement-width", `${layoutState.statementWidth}px`);
  else layout.style.removeProperty("--statement-width");
  if (layoutState.testsHeight)
    layout.style.setProperty("--tests-height", `${layoutState.testsHeight}px`);
  else layout.style.removeProperty("--tests-height");
  const shown = !layoutState.statementHidden;
  layout.classList.toggle("statement-hidden", !shown);
  const toggle = document.getElementById("toggle-statement");
  toggle.setAttribute("aria-pressed", String(shown));
  toggle.title = shown ? "Hide the question" : "Show the question";
}

/** Drag `handle` to resize; `measure` turns a pointer position into the new size. */
function makeSplitter(handle, key, measure, min, max) {
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    const move = (e) => {
      layoutState[key] = Math.round(Math.min(max(), Math.max(min, measure(e))));
      applyLayout();
    };
    const up = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      saveLayout();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("dblclick", () => {
    delete layoutState[key];
    applyLayout();
    saveLayout();
  });
}

makeSplitter(
  document.getElementById("statement-splitter"),
  "statementWidth",
  (e) => e.clientX - layout.getBoundingClientRect().left,
  220,
  () => layout.getBoundingClientRect().width * 0.6,
);
const editorColumn = document.getElementById("editor-column");
makeSplitter(
  document.getElementById("tests-splitter"),
  "testsHeight",
  (e) => editorColumn.getBoundingClientRect().bottom - e.clientY,
  60,
  () => editorColumn.getBoundingClientRect().height - 120,
);
document.getElementById("toggle-statement").addEventListener("click", () => {
  layoutState.statementHidden = !layoutState.statementHidden;
  applyLayout();
  saveLayout();
});
applyLayout();

// ── Panels and live updates ──────────────────────────────────────────────────

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

const presence = document.getElementById("presence");
function setPresence(listening) {
  presence.textContent = listening ? "Interviewer listening" : "Interviewer away";
  presence.classList.toggle("listening", listening);
}

connectEvents(
  `/api/events?session=${encodeURIComponent(sessionId)}`,
  {
    message: (payload) => chat.append(payload),
    hint: (payload) => hints.show(payload.hint),
    phase: (payload) => {
      timer.update(payload);
      applyPhase(payload.phase);
    },
    presence: (payload) => setPresence(payload.listening),
    result: (payload) => {
      if (!busy) renderResult(payload);
    },
    rubric: (payload) => renderRubric(payload),
    reload: () => window.location.reload(),
  },
  { onError: () => setPresence(false) },
);

renderTree();
applyPhase(phase);
if (config.last) renderResult(config.last);
if (config.firstFile) void open(config.firstFile);
