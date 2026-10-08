/** Renders run and submit results, streaming case rows in as they arrive. */

import { clip, el, formatInput, formatMs, formatValue } from "../shared/dom.mjs";

const STATUS_LABEL = {
  pass: "Passed",
  fail: "Failed",
  error: "Error",
  timeout: "Timed out",
  skipped: "Not run",
};

export function createTestsPanel({ paramOrder }) {
  const list = document.getElementById("case-list");
  const summary = document.getElementById("tests-summary");
  const rows = new Map();

  const statusPill = (status) =>
    el("span", { class: `status status-${status}` }, STATUS_LABEL[status] ?? status);

  const kv = (label, value, extraClass = "") =>
    el(
      "div",
      { class: `kv ${extraClass}` },
      el("span", { class: "kv-label" }, label),
      el("pre", { class: "kv-value" }, value),
    );

  function row(view) {
    const li = el("li", { class: `case case-${view.status}`, "data-id": view.id });
    const header = el(
      "div",
      { class: "case-header" },
      statusPill(view.status),
      el("span", { class: "case-label" }, view.label ?? view.id),
      view.visible || view.revealed ? null : el("span", { class: "muted small" }, "hidden"),
      el("span", { class: "case-time" }, view.timeMs !== undefined ? formatMs(view.timeMs) : ""),
    );
    li.append(header);

    const hasDetails =
      view.input !== undefined ||
      view.actual !== undefined ||
      view.stdout ||
      view.stderr ||
      view.message;
    if (hasDetails) {
      const details = el("div", { class: "case-details" });
      if (view.message && view.status !== "fail")
        details.append(el("div", { class: "case-message" }, view.message));
      if (view.input !== undefined)
        details.append(kv("Input", formatInput(view.input, paramOrder)));
      if (view.expected !== undefined) details.append(kv("Expected", formatValue(view.expected)));
      if (view.actual !== undefined) details.append(kv("Output", formatValue(view.actual)));
      if (view.stdout) details.append(kv("Stdout", clip(view.stdout)));
      if (view.stderr) details.append(kv("Stderr", clip(view.stderr), "stderr"));
      if (view.revealed)
        details.append(
          el(
            "div",
            { class: "muted small" },
            "Revealed because it was the first hidden case to fail.",
          ),
        );
      li.append(details);
      if (view.status === "pass" && view.visible) li.classList.add("collapsed");
      header.classList.add("clickable");
      header.addEventListener("click", () => li.classList.toggle("collapsed"));
    }
    return li;
  }

  function describe(result) {
    switch (result.status) {
      case "ok":
        return "";
      case "import-error":
        return "your code did not import";
      case "timeout":
        return "killed at the wall-clock limit";
      case "memory":
        return "out of memory";
      case "killed":
        return "the process was killed";
      default:
        return "the runner crashed";
    }
  }

  return {
    begin(kind) {
      rows.clear();
      list.textContent = "";
      summary.textContent = kind === "hidden" ? "Submitting… running every case" : "Running…";
      summary.className = "tests-summary running";
    },
    partial(update) {
      const next = row({
        id: update.id,
        label: update.id,
        status: update.status,
        timeMs: update.timeMs,
        visible: false,
      });
      const existing = rows.get(update.id);
      if (existing) existing.replaceWith(next);
      else list.append(next);
      rows.set(update.id, next);
    },
    final(result, kind) {
      list.textContent = "";
      rows.clear();
      if (result.stderrTail) {
        list.append(
          el(
            "li",
            { class: "case case-error" },
            el(
              "div",
              { class: "case-header" },
              statusPill("error"),
              el("span", { class: "case-label" }, describe(result) || "Error"),
            ),
            el("div", { class: "case-details" }, kv("Output", clip(result.stderrTail), "stderr")),
          ),
        );
      }
      for (const view of result.cases) {
        const li = row(view);
        rows.set(view.id, li);
        list.append(li);
      }
      const verb = kind === "hidden" ? "Submitted" : "Ran";
      const outcome = describe(result);
      summary.textContent = `${verb}: ${result.passed}/${result.total} passed${outcome ? ` · ${outcome}` : ""} · ${formatMs(result.wallMs)}`;
      const allPass = result.passed === result.total && result.status === "ok";
      summary.className = `tests-summary ${allPass ? "all-pass" : "has-fail"}`;
    },
    error(message) {
      summary.textContent = message;
      summary.className = "tests-summary has-fail";
    },
  };
}
