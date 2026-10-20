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

const PAGES_PARA =
  "A visitor decides in a few seconds whether the app is for them, so the first screen has to load quickly and show the app working. ";

export const MEDIA_TEACHING = [
  "## Where the site comes from",
  "",
  `Pages publishes from a branch folder such as /docs, or from an Actions workflow [fact:pages-publishing-source]; a workflow deploys with deploy-pages and needs pages and id-token write access [fact:pages-actions-deploy]. ${PAGES_PARA}`,
  "",
  "## The path it is served under",
  "",
  `A project site lives at <owner>.github.io/<repo> [fact:pages-project-url], so a link starting with / leaves it. ${PAGES_PARA.repeat(2)}`,
  "",
  "## The demo on the first screen",
  "",
  `Give the video a poster so the first screen is never blank [fact:video-poster]. ${PAGES_PARA.repeat(2)}`,
].join("\n");

export const MEDIA_BRIEF = [
  "## Your task",
  "",
  "With your own agent, publish a GitHub Pages site for an app you built, with the demo video and a screenshot on the first screen and a social preview image for shared links. Submit the repository folder when it is live and you are happy with it.",
].join("\n");

export const MEDIA_OUTLINE =
  "A strong site: published from /docs or a committed Pages workflow; relative links that work under /<repo>/; a muted, inline, faststart H.264 demo with a poster; sized screenshots with alt text; og:image at about 1200x630 that names the app and shows it.";

export function mediaLabArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "ship-your-pages-site",
    lesson: "pages-site",
    kind: "media-lab",
    title: "Ship your app's Pages site",
    teaching_md: MEDIA_TEACHING,
    brief_md: MEDIA_BRIEF,
    model_outline: MEDIA_OUTLINE,
    follow_ups: [
      "What does a visitor see before the video's first frame arrives?",
      "How would your agent re-record the demo after the next UI change?",
    ],
    pitfalls: ["A root-absolute link on a project site", "An autoplaying video that is not muted"],
    ...extra,
  };
}
