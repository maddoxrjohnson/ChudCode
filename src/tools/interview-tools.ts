/**
 * interview-tools.ts: what the interviewer does during a session.
 */

import { interviewerRun, postMessage, recordSession, revealHint } from "../flow.ts";
import { resultText, sessionLine, thenWait } from "../prompts.ts";
import type { RunScope } from "../runs.ts";
import { isValidSessionId } from "../store/paths.ts";
import { readProblem } from "../store/problems.ts";
import { readSession, sessionExists } from "../store/sessions.ts";
import {
  ok,
  optionalBool,
  optionalInt,
  requireBool,
  requireInt,
  requireString,
  schema,
  stringList,
  ToolArgumentError,
  type ToolDef,
} from "./index.ts";

function requireSession(args: Record<string, unknown>): string {
  const id = requireString(args, "session_id", 120);
  if (!isValidSessionId(id) || !sessionExists(id))
    throw new ToolArgumentError(`No session named ${id}.`);
  return id;
}

export function interviewTools(): ToolDef[] {
  return [
    {
      name: "say_to_candidate",
      title: "Say To Candidate",
      description:
        "Speak to the candidate on the page, as the interviewer. Markdown. This is the only way your words reach the candidate.",
      inputSchema: schema.obj({
        session_id: schema.str("The session id."),
        markdown: schema.str("What to say. Keep it short; this is a conversation, not a lecture."),
      }),
      async execute(args) {
        const id = requireSession(args);
        const message = postMessage(id, "interviewer", requireString(args, "markdown", 8_000));
        return ok(`Sent. ${thenWait()}`, { at: message.at });
      },
    },
    {
      name: "reveal_hint",
      title: "Reveal Hint",
      description:
        "Give the candidate the next hint from the problem's ladder, or a specific level. The hint appears on the page and is recorded for the debrief.",
      inputSchema: schema.obj(
        {
          session_id: schema.str("The session id."),
          level: schema.int("A specific hint level. Defaults to the next unrevealed one.", 1, 10),
        },
        ["level"],
      ),
      async execute(args) {
        const id = requireSession(args);
        const level = optionalInt(args, "level", 1, 10);
        const reveal = revealHint(id, level);
        return ok(
          `Revealed hint ${reveal.hint.level}: "${reveal.hint.text}"\n${reveal.remaining} hint${reveal.remaining === 1 ? "" : "s"} left. ${thenWait()}`,
          { level: reveal.hint.level, remaining: reveal.remaining },
        );
      },
    },
    {
      name: "run_tests",
      title: "Run Tests",
      description:
        "Run the candidate's current draft yourself: against the visible examples, every case including hidden ones, or custom inputs you supply. " +
        "Returns the full result. Set show_candidate to put the result in their tests panel too.",
      inputSchema: schema.obj(
        {
          session_id: schema.str("The session id."),
          cases: schema.oneOf(
            ["visible", "all"],
            'Which cases to run. Default "visible". Ignored when custom is given.',
          ),
          custom: schema.list(
            { type: "object", description: "Arguments by parameter name." },
            'Up to 10 custom inputs, each an object of arguments by name, e.g. [{"nums": [1, 2], "k": 1}].',
          ),
          show_candidate: schema.bool(
            "Also show the result in the candidate's tests panel. Default false.",
          ),
        },
        ["cases", "custom", "show_candidate"],
      ),
      async execute(args) {
        const id = requireSession(args);
        let scope: RunScope = "visible";
        const custom = args["custom"];
        if (custom !== undefined) {
          if (!Array.isArray(custom))
            throw new ToolArgumentError("custom must be a list of argument objects");
          scope = { custom: custom as Array<Record<string, unknown>> };
        } else if (args["cases"] === "all") {
          scope = "all";
        } else if (args["cases"] !== undefined && args["cases"] !== "visible") {
          throw new ToolArgumentError('cases must be "visible" or "all"');
        }
        const outcome = await interviewerRun(
          id,
          scope,
          optionalBool(args, "show_candidate") ?? false,
        );
        const session = readSession(id);
        const bundle = readProblem(session.problem);
        return ok(
          resultText(
            outcome.result,
            outcome.cases,
            bundle.meta.signature.params.map((p) => p.name),
          ),
          {
            passed: outcome.result.passed,
            total: outcome.result.total,
            status: outcome.result.status,
          },
        );
      },
    },
    {
      name: "record_session",
      title: "Record Session",
      description:
        "Score the session with the rubric, decide the verdict, mark it finished, and schedule its patterns for spaced review. " +
        "The debrief card appears on the page. Call this once, at the end.",
      inputSchema: schema.obj(
        {
          session_id: schema.str("The session id."),
          rubric: schema.obj({
            correctness: schema.int("0 to 4, from RUBRIC.md.", 0, 4),
            communication: schema.int("0 to 4.", 0, 4),
            complexity: schema.int("0 to 4.", 0, 4),
            code_quality: schema.int("0 to 4.", 0, 4),
            time: schema.int("0 to 4.", 0, 4),
          }),
          complexity_ok: schema.bool(
            "Whether the submitted solution actually meets the problem's complexity target.",
          ),
          notes_md: schema.str(
            "A short paragraph for the candidate about how the session went. Markdown.",
          ),
          strengths: schema.list(
            schema.str("One specific strength."),
            "Exactly two, each one sentence.",
          ),
          improvements: schema.list(
            schema.str("One specific improvement."),
            "Exactly two, each one sentence.",
          ),
        },
        [],
      ),
      async execute(args) {
        const id = requireSession(args);
        const rubricArgs = args["rubric"];
        if (!rubricArgs || typeof rubricArgs !== "object" || Array.isArray(rubricArgs)) {
          throw new ToolArgumentError("rubric must be an object of scores");
        }
        const r = rubricArgs as Record<string, unknown>;
        const outcome = recordSession(id, {
          rubric: {
            correctness: requireInt(r, "correctness", 0, 4),
            communication: requireInt(r, "communication", 0, 4),
            complexity: requireInt(r, "complexity", 0, 4),
            codeQuality: requireInt(r, "code_quality", 0, 4),
            time: requireInt(r, "time", 0, 4),
          },
          complexityOk: requireBool(args, "complexity_ok"),
          notesMd: requireString(args, "notes_md", 4_000),
          strengths: stringList(args, "strengths", 5),
          improvements: stringList(args, "improvements", 5),
        });
        const v = outcome.session.verdict;
        const why = v
          ? [
              v.allPassed ? "all cases passed" : "not all cases passed",
              v.withinTime ? "within time" : "out of time",
              v.complexityOk ? "complexity met the target" : "complexity below target",
            ].join(", ")
          : "";
        return ok(
          [
            `Recorded. Verdict: ${v?.correct ? "solved" : "not solved"} (${why}).`,
            ...outcome.nextDue,
            sessionLine(outcome.session),
            "Summarise for the user in the terminal: verdict, two strengths, two improvements, next review.",
          ].join("\n"),
          { correct: v?.correct ?? false },
        );
      },
    },
  ];
}
