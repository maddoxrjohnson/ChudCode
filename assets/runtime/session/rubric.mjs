/** Renders the debrief card when the interviewer records the session. */

import { el } from "../shared/dom.mjs";

export function renderRubric(payload) {
  const host = document.getElementById("rubric");
  if (!host) return;
  const { rubric, verdict, notesHtml, nextDue } = payload;
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
        verdict?.correct ? "Solved" : "Not yet",
      ),
    ),
    el(
      "ul",
      { class: "scores" },
      score("Correctness", rubric.correctness),
      score("Communication", rubric.communication),
      score("Complexity", rubric.complexity),
      score("Code quality", rubric.codeQuality),
      score("Time", rubric.time),
    ),
    el("div", { class: "rubric-notes", html: notesHtml ?? "" }),
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
