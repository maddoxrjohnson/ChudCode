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

const CONTEXT_PARA =
  "Every line in a context file is read at the start of every session, so a line that restates the code is paid for again and again. ";

export const LAB_TEACHING = [
  "## What loads, and when",
  "",
  `Claude Code reads CLAUDE.md from the working directory and every directory above it [fact:claude-md-loading]. ${CONTEXT_PARA.repeat(2)}`,
  "",
  "## Keep it short",
  "",
  `The docs suggest keeping each file under 200 lines [fact:claude-md-size]. ${CONTEXT_PARA.repeat(2)}`,
  "",
  "## Only what the code cannot tell it",
  "",
  `Commands, conventions, and quirks belong there; what the agent can read in the code does not [fact:claude-md-content]. ${CONTEXT_PARA}`,
].join("\n");

export const LAB_BRIEF = [
  "## Your task",
  "",
  "With your own agent, write or tighten the CLAUDE.md of a project you work on, and add a progress.md that a fresh session could pick up from. Keep only what the code does not show. Submit the project folder when you are happy with it.",
].join("\n");

export const LAB_OUTLINE =
  "A strong setup: CLAUDE.md under 200 lines holding the test and build commands, non-default conventions, and environment quirks; nothing the code already shows; progress.md ending with the next step and what is blocked.";

export function labArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "tighten-your-claude-md",
    lesson: "context-files",
    kind: "lab",
    title: "Tighten your CLAUDE.md",
    teaching_md: LAB_TEACHING,
    brief_md: LAB_BRIEF,
    model_outline: LAB_OUTLINE,
    follow_ups: [
      "Which line would you cut first, and what would the agent lose?",
      "How does a fresh session know what to do next?",
    ],
    pitfalls: ["Restating the directory structure", "A progress file with no next step"],
    ...extra,
  };
}
