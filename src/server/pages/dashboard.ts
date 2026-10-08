/**
 * dashboard.ts: the landing page. Recent sessions and available problems now; the
 * pattern mastery grid and due-for-review list arrive with spaced review.
 */

import { escapeHtml } from "../../markdown.ts";
import type { ProblemMeta } from "../../store/problems.ts";
import type { Session } from "../../store/sessions.ts";
import { difficultyBadge, page, topbar } from "./layout.ts";

export interface DashboardData {
  sessions: Session[];
  problems: ProblemMeta[];
}

export function dashboardPage(data: DashboardData): string {
  const sessions = data.sessions.length
    ? `<table class="table">
<thead><tr><th>When</th><th>Problem</th><th>Mode</th><th>Result</th><th>Hints</th></tr></thead>
<tbody>${data.sessions
        .map(
          (s) => `<tr>
  <td><a href="/s/${escapeHtml(s.id)}">${escapeHtml(formatDate(s.createdAt))}</a></td>
  <td>${escapeHtml(s.problemTitle)} ${difficultyBadge(s.difficulty)}</td>
  <td>${escapeHtml(s.mode)}</td>
  <td>${sessionResult(s)}</td>
  <td>${s.hintsUsed.length}</td>
</tr>`,
        )
        .join("\n")}</tbody>
</table>`
    : `<p class="muted">No sessions yet. Ask your agent to start an interview.</p>`;

  const problems = data.problems.length
    ? `<ul class="problem-list">${data.problems
        .map(
          (
            p,
          ) => `<li><a href="/p/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a> ${difficultyBadge(p.difficulty)}
  <span class="muted">${p.patterns.map(escapeHtml).join(", ")}${p.validatedAt ? "" : " · unvalidated"}</span></li>`,
        )
        .join("\n")}</ul>`
    : `<p class="muted">No problems yet.</p>`;

  return page({
    title: "Dashboard",
    bodyClass: "plain dashboard",
    body: `${topbar({ title: "Dashboard" })}
<main class="narrow">
  <section>
    <h2>Recent sessions</h2>
    ${sessions}
  </section>
  <section>
    <h2>Problems</h2>
    ${problems}
  </section>
</main>`,
    module: "runtime/plain/main.mjs",
  });
}

function sessionResult(session: Session): string {
  if (session.verdict)
    return session.verdict.correct
      ? `<span class="badge ok">solved</span>`
      : `<span class="badge warn">not solved</span>`;
  if (session.lastResult) return `${session.lastResult.passed}/${session.lastResult.total} passed`;
  return `<span class="muted">${escapeHtml(session.phase)}</span>`;
}

function formatDate(at: number): string {
  return new Date(at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
