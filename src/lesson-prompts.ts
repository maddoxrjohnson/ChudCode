/**
 * lesson-prompts.ts: the text the interviewer reads for agentic-coding lessons.
 *
 * Kept apart from prompts.ts, which is about interviews, so each track's wording can
 * be reviewed on its own. The same rule holds: event prompts are self-contained,
 * because they arrive out of band and must say which session and which tool.
 */

import type { CurriculumProgress, LessonState, ModuleStanding } from "./curriculum.ts";
import type { FactFreshness } from "./store/fact-checks.ts";

const STATE_WORDS: Record<LessonState, string> = {
  passed: "passed",
  attempted: "attempted",
  new: "new",
  outline: "outline (not teachable yet)",
};

function moduleLine(module: ModuleStanding): string {
  const gate = module.unlocked
    ? "open"
    : `locked: needs ${module.waitingOn.map((id) => `\`${id}\``).join(" and ")} half passed`;
  return `\`${module.id}\` ${module.name} · ${module.passed}/${module.total} passed · ${gate}`;
}

/** The curriculum at a glance, or one module's lessons. */
export function curriculumText(progress: CurriculumProgress, moduleId?: string): string {
  const lines = [
    "## Agentic coding",
    "",
    `${progress.passed} of ${progress.total} teachable lessons passed.`,
  ];
  if (progress.next) {
    lines.push(
      `Next: \`${progress.next.lesson.id}\` ${progress.next.lesson.title} in ${progress.next.module.name}.`,
    );
  }
  const module = moduleId ? progress.modules.find((m) => m.id === moduleId) : undefined;
  if (module) {
    lines.push(
      "",
      `### ${moduleLine(module)}`,
      "",
      ...module.lessons.map((lesson) => {
        const tries = lesson.state === "attempted" ? ` ×${lesson.attempts}` : "";
        return `- ${STATE_WORDS[lesson.state]}${tries}: \`${lesson.id}\` ${lesson.title}`;
      }),
    );
    return lines.join("\n");
  }
  lines.push(
    "",
    ...progress.modules.map((m) => `- ${moduleLine(m)}`),
    "",
    "Pass `module` to see one module's lessons.",
  );
  return lines.join("\n");
}

/** One line per fact for the brief: the claim, its page, and whether to re-check it. */
export function factLines(freshness: readonly FactFreshness[], now: number): string[] {
  return freshness.map(({ fact, confirmedAt, problem, stale }) => {
    const days = Math.max(0, Math.floor((now - confirmedAt) / 86_400_000));
    const status = problem
      ? `**${problem.status}** when last checked${problem.note ? `: ${problem.note}` : ""}`
      : stale
        ? `last confirmed ${days} days ago: check it`
        : `confirmed ${days === 0 ? "today" : `${days} days ago`}`;
    const version = fact.minVersion ? ` Needs Claude Code ${fact.minVersion} or later.` : "";
    return `- \`${fact.id}\`${fact.core ? " (core)" : ""}: ${fact.claim}${version} Source: ${fact.source} · ${status}`;
  });
}
