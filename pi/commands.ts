/**
 * commands.ts: /interview, /review, /research, and /dashboard for Pi.
 *
 * Each command sends one short user message that names the ChudCode tool to call
 * first. The method itself comes back from `begin_interview`, with the host section
 * for Pi, so these prompts stay small. Claude Code gets the same entry points as
 * skills; the interview and review skills describe listening with a wait tool, which
 * Pi does not have, so those two are written out here instead. Research is the same
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
