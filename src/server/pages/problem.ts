/**
 * problem.ts: statement and examples, shared by the session page and the preview.
 */

import { formatInput, formatValue } from "../../format.ts";
import { escapeHtml } from "../../markdown.ts";
import type { PublicCase, PublicProblem } from "../../store/problems.ts";
import { difficultyBadge, page, topbar } from "./layout.ts";

export { formatInput, formatValue };

export function examplesHtml(cases: PublicCase[], paramOrder: string[]): string {
  if (cases.length === 0) return "";
  const items = cases
    .map(
      (c, i) => `<li>
  <div class="example-label">${escapeHtml(c.label ?? `Example ${i + 1}`)}</div>
  <pre class="example"><span class="io-label">Input:</span>  ${escapeHtml(formatInput(c.input, paramOrder))}
<span class="io-label">Output:</span> ${escapeHtml(formatValue(c.expected))}</pre>
</li>`,
    )
    .join("\n");
  return `<ol class="examples">${items}</ol>`;
}

export function statementHtml(problem: PublicProblem): string {
  return `<article class="statement">
  <h1>${escapeHtml(problem.title)} ${difficultyBadge(problem.difficulty)}</h1>
  <div class="patterns">${problem.patterns.map((p) => `<span class="pattern-chip">${escapeHtml(p)}</span>`).join(" ")}</div>
  ${problem.statementHtml}
</article>`;
}

export function problemPage(problem: PublicProblem): string {
  const order = problem.signature.params.map((p) => p.name);
  return page({
    title: problem.title,
    bodyClass: "plain",
    body: `${topbar({ title: "Problem preview" })}
<main class="narrow">
  ${statementHtml(problem)}
  <h2>Examples</h2>
  ${examplesHtml(problem.visibleCases, order)}
  <p class="muted">${problem.hiddenCaseCount} hidden ${problem.hiddenCaseCount === 1 ? "case runs" : "cases run"} on Submit.</p>
</main>`,
    module: "runtime/plain/main.mjs",
  });
}
