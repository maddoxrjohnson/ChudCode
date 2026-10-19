/**
 * commands.ts: /interview, /review, /roadmap, /research, and /dashboard for Pi.
 *
 * Each command sends one short user message that names the ChudCode tool to call
 * first. The method itself comes back from `begin_interview`, with the host section
 * for Pi, so these prompts stay small. Claude Code gets the same entry points as
 * skills; the interview, review, and roadmap skills describe listening with a wait
 * tool, which Pi does not have, so those three are written out here instead. Research is the same
 * on both hosts and reuses its skill.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { packageRoot } from "../src/store/paths.ts";

/** The slice of the Pi API the commands need. */
export interface CommandHost {
  registerCommand(
    name: string,
    spec: { description: string; handler(args: string, ctx: CommandContext): Promise<void> },
  ): void;
  sendUserMessage(text: string, options?: { deliverAs?: string }): void;
}

export interface CommandContext {
  isIdle(): boolean;
  ui?: { notify(message: string, level: "info" | "error"): void };
}

const ASKED = (args: string) =>
  args ? `The user asked for: ${args}` : "The user named no pattern, difficulty, or company.";

const SESSION_STEPS =
  "Give the user the URL in the terminal and say one sentence on the page with `say_to_candidate`. " +
  "The candidate's actions then arrive here as messages; handle each one and end your turn. " +
  "When the session is in follow-ups and you have what you need, score it with `record_session` and summarise in the terminal: the verdict, two strengths, two things to work on, and when the pattern comes back.";

export const COMMANDS = {
  interview: {
    description:
      "Run a mock coding interview. Usage: /interview [pattern, difficulty, company, or a problem it should resemble]",
    prompt: (args: string) =>
      [
        "Run a ChudCode mock interview.",
        ASKED(args),
        "Call `begin_interview` first with the pattern, difficulty, company, or title you can read from that, and follow the method it returns in full. " +
          "Pick a validated problem from `list_problems` the candidate has not seen, or write one with `lookup_seed`, `write_problem`, and `validate_problem` until it passes. Then call `start_session`.",
        SESSION_STEPS,
      ].join("\n\n"),
  },
  review: {
    description: "Review the pattern you are most overdue to see again. Usage: /review [pattern]",
    prompt: (args: string) =>
      [
        "Run a ChudCode spaced-review session.",
        args ? `The user asked to review: ${args}` : "The user did not name a pattern.",
        "Call `begin_interview` with `mode` set to `review` (and the pattern, if named) and follow the method it returns. If nothing is due, say so and offer a regular interview. " +
          "Serve a validated problem on that pattern the candidate has not seen, writing one if needed, then call `start_session` with `mode` set to `review`.",
        SESSION_STEPS,
      ].join("\n\n"),
  },
  roadmap: {
    description:
      "Take the next problem on NeetCode 150 or Grind 75. Usage: /roadmap [grind75] [topic or week]",
    prompt: (args: string) =>
      [
        "Run the next ChudCode roadmap session.",
        args
          ? `The user asked for: ${args}`
          : "The user named no list or topic, so use NeetCode 150.",
        "Call `begin_interview` with `mode` set to `roadmap`, `roadmap` set to `grind75` if the user named Grind 75 and `neetcode150` otherwise, and `stage` if they named a topic or week (`list_roadmap` lists the stage ids). Follow the method it returns. " +
          "Write an original problem in the shape of the listed one it names, with the source's mimic_of set to that title exactly, and validate it; never serve the listed problem itself. Then call `start_session` with `mode` set to `roadmap`.",
        SESSION_STEPS.replace(
          "and when the pattern comes back.",
          "when the pattern comes back, and where they stand on the roadmap.",
        ),
        "After the debrief, write and validate the next step ahead of time as `record_session` asks, without starting it, then end your turn. A press of Next problem on the page arrives as a new message; start the session then.",
      ].join("\n\n"),
  },
  learn: {
    description:
      "Take a lesson on coding with agents: planning, context, tests, subagents, cost, and more. Usage: /learn [topic or lesson]",
    prompt: (args: string) =>
      [
        "Teach a ChudCode lesson on agentic coding.",
        args
          ? `The user asked to learn about: ${args}`
          : "The user named no topic, so take the next lesson.",
        "Call `list_curriculum` if you need to match a topic to a lesson, then `begin_lesson` and follow the method it returns in full. " +
          "Serve a validated exercise the learner has not seen, or write one with `write_exercise` and `validate_exercise` until it passes. Then call `start_lesson`.",
        "Give the user the URL in the terminal and say one sentence on the page with `say_to_candidate`. " +
          "The learner's actions then arrive here as messages; handle each one and end your turn. They may spend a long time with their own agent between messages. " +
          "A lab or transcript submission is read with `inspect_lab` or `inspect_transcript`; a drill arrives already graded. " +
          "When their answer has arrived and you have asked your follow-ups, score it with `record_lesson` and summarise in the terminal: the verdict, two strengths, two things to work on, and when the lesson comes back. Then follow what it says about the Next lesson button.",
      ].join("\n\n"),
  },
  research: {
    description:
      "Find what a company has been asking in coding interviews. Usage: /research <company> [role]",
    prompt: (args: string) =>
      [
        args
          ? `Research what ${args} has been asking in coding interviews.`
          : "The user wants to research a company's coding interviews but named none.",
        skillBody("research"),
      ].join("\n\n"),
  },
  dashboard: {
    description: "Open the ChudCode dashboard: review schedule, streak, past sessions.",
    prompt: () =>
      "Call `open_dashboard` and give the user the URL it returns. If a session was in progress it is recovered, and its events arrive here as messages; handle them as the interviewer.",
  },
} satisfies Record<string, { description: string; prompt(args: string): string }>;

export function registerCommands(pi: CommandHost, onSent: () => void = () => {}): void {
  for (const [name, command] of Object.entries(COMMANDS)) {
    pi.registerCommand(name, {
      description: command.description,
      async handler(args, ctx) {
        const prompt = command.prompt((args ?? "").trim());
        pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
        onSent();
      },
    });
  }
}

/** A skill's instructions without its frontmatter. */
export function skillBody(name: string): string {
  const file = path.join(packageRoot(), "skills", name, "SKILL.md");
  return fs
    .readFileSync(file, "utf8")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .trim();
}
