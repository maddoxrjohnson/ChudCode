/**
 * A design-review exercise for plan-before-code that passes validation, for tests.
 */

const PARA =
  "An agent that starts editing before it understands the codebase tends to solve the wrong problem confidently. ";

export const TEACHING = [
  "## Why plan first",
  "",
  `Anthropic's own guidance is to explore, plan, implement, then commit [fact:explore-plan-implement-commit]. ${PARA.repeat(3)}`,
  "",
  "## Plan mode",
  "",
  `In plan mode the agent reads and explores but does not edit until you approve [fact:plan-mode-behavior]. ${PARA.repeat(2)}`,
  "",
  "## When to skip it",
  "",
  `If you could describe the diff in one sentence, skip the plan [fact:plan-mode-overhead]. ${PARA}`,
].join("\n");

export const BRIEF = [
  "## Scenario",
  "",
  "You maintain a 4,000-line Python CLI that imports bank CSV exports into a SQLite ledger. Users want OFX files too. The parser module has no tests, and two banks put the date in different columns.",
  "",
  "## Your task",
  "",
  "Write the plan you would approve before letting an agent add OFX import: phases, the files each touches, and how each phase is verified.",
].join("\n");

export const OUTLINE =
  "Phase 0: characterise the CSV parser with tests on real exports from both banks before touching it. Phase 1: extract a parser interface. Phase 2: add the OFX parser behind it with fixtures. Phase 3: wire the CLI flag. Each phase ends with the suite green; risks: date columns, duplicate transactions across formats.";

export function exerciseArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "plan-ofx-import",
    lesson: "plan-before-code",
    kind: "design-review",
    title: "Plan OFX import for a ledger CLI",
    teaching_md: TEACHING,
    brief_md: BRIEF,
    model_outline: OUTLINE,
    follow_ups: [
      "How would you know the refactor in phase 1 changed nothing?",
      "Which phase would you not let the agent do unattended, and why?",
    ],
    pitfalls: ["Adding OFX before pinning CSV behaviour", "No verification step per phase"],
    ...extra,
  };
}
