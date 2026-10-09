/**
 * session-tools.ts: tools that set a session up, inspect it, or end it early.
 */

import { abandonSession, sessionState, startSession as startClock } from "../flow.ts";
import { openUrl } from "../open-browser.ts";
import {
  interviewBrief,
  patternListText,
  problemLine,
  sessionLine,
  sessionSummaryText,
} from "../prompts.ts";
import * as server from "../server/server.ts";
import { readConfig, shouldAutoOpen } from "../store/config.ts";
import { isValidSessionId, isValidSlug } from "../store/paths.ts";
import {
  DIFFICULTIES,
  importAllExamples,
  listProblems,
  patternById,
  problemExists,
  readProblem,
  updateMeta,
  type Difficulty,
} from "../store/problems.ts";
import { createSession, sessionExists, type SessionMode } from "../store/sessions.ts";
import {
  fail,
  ok,
  optionalBool,
  optionalEnum,
  optionalInt,
  optionalString,
  requireString,
  schema,
  type ToolDef,
} from "./index.ts";

export interface ToolHost {
  /** Host-specific instructions appended to the brief. */
  hostBrief: string;
  /** Note a session this process created, so recovery does not re-announce it. */
  created(sessionId: string): void;
  /** Queue prompts for sessions already in progress. */
  recover(): void;
}

const MODES = ["interview", "review", "mimic"] as const;

export function sessionTools(host: ToolHost): ToolDef[] {
  return [
    {
      name: "begin_interview",
      title: "Begin Interview",
      description:
        "Start a mock interview. Returns the interviewing method, the scoring rubric, the candidate's recent sessions, and the problems on disk. " +
        "Call this first, before choosing a problem or starting a session.",
      inputSchema: schema.obj(
        {
          mode: schema.oneOf(
            MODES,
            "interview (default), review (a due pattern), or mimic (the user named a real problem).",
          ),
          pattern: schema.str("A pattern id the user asked for, e.g. sliding-window."),
          difficulty: schema.oneOf(DIFFICULTIES, "Requested difficulty."),
          company: schema.str("A company the user is preparing for, if they named one."),
          title: schema.str("A real problem title the user named, if any."),
        },
        ["mode", "pattern", "difficulty", "company", "title"],
      ),
      async execute(args) {
        const mode = optionalEnum(args, "mode", MODES) ?? "interview";
        importAllExamples();
        const pattern = optionalString(args, "pattern", 64);
        if (pattern !== undefined && !patternById(pattern)) {
          return fail(`Unknown pattern id: ${pattern}. Valid ids:\n${patternListText()}`);
        }
        const request: Parameters<typeof interviewBrief>[0] = { mode };
        if (pattern !== undefined) request.pattern = pattern;
        const difficulty = optionalEnum(args, "difficulty", DIFFICULTIES);
        if (difficulty !== undefined) request.difficulty = difficulty;
        const company = optionalString(args, "company", 120);
        if (company !== undefined) request.company = company;
        const title = optionalString(args, "title", 200);
        if (title !== undefined) request.title = title;
        return ok(interviewBrief(request, host.hostBrief), { mode });
      },
    },
    {
      name: "open_dashboard",
      title: "Open Dashboard",
      description:
        "Start the local server if it is not running, open the dashboard in the browser, recover any session in progress, and return the URL.",
      inputSchema: schema.obj({}),
      async execute() {
        const base = await server.start();
        importAllExamples();
        host.recover();
        if (shouldAutoOpen(readConfig())) openUrl(base);
        return ok(`Dashboard: ${base}`, { url: base });
      },
    },
    {
      name: "list_problems",
      title: "List Problems",
      description:
        "List the problems on disk with their patterns, difficulty, validation state, and how often each has been served.",
      inputSchema: schema.obj(
        {
          pattern: schema.str("Only problems tagged with this pattern id."),
          difficulty: schema.oneOf(DIFFICULTIES, "Only problems of this difficulty."),
          validated_only: schema.bool(
            "Only problems whose reference solution has passed validation.",
          ),
        },
        ["pattern", "difficulty", "validated_only"],
      ),
      async execute(args) {
        const filter: Parameters<typeof listProblems>[0] = {};
        importAllExamples();
        const pattern = optionalString(args, "pattern", 64);
        if (pattern !== undefined) filter.pattern = pattern;
        const difficulty = optionalEnum(args, "difficulty", DIFFICULTIES);
        if (difficulty !== undefined) filter.difficulty = difficulty;
        const validatedOnly = optionalBool(args, "validated_only");
        if (validatedOnly !== undefined) filter.validatedOnly = validatedOnly;
        const problems = listProblems(filter);
        if (problems.length === 0) return ok("No problems match.", { problems: [] });
        return ok(problems.map(problemLine).join("\n"), {
          problems: problems.map((p) => ({
            slug: p.slug,
            title: p.title,
            patterns: p.patterns,
            difficulty: p.difficulty,
            validated: p.validatedAt !== undefined,
            timesServed: p.timesServed,
          })),
        });
      },
    },
    {
      name: "start_session",
      title: "Start Session",
      description:
        "Create an interview session for a problem and return its URL. Starts the local server if needed and opens the page in the browser. " +
        "The clock starts when the candidate presses Start on the page, unless start_now is true.",
      inputSchema: schema.obj(
        {
          slug: schema.str("The problem's slug, from list_problems."),
          mode: schema.oneOf(MODES, "interview (default), review, or mimic."),
          timer_minutes: schema.int(
            "Length of the interview clock. Defaults to the configured value (35).",
            1,
            240,
          ),
          start_now: schema.bool(
            "Start the clock immediately instead of waiting for the candidate to press Start.",
          ),
        },
        ["mode", "timer_minutes", "start_now"],
      ),
      async execute(args) {
        const slug = requireString(args, "slug", 64);
        if (!isValidSlug(slug) || !problemExists(slug))
          return fail(`No problem named ${slug}. Call list_problems.`);
        const bundle = readProblem(slug);
        if (bundle.meta.validatedAt === undefined && bundle.meta.source.kind !== "hand") {
          return fail(
            `${slug} has not been validated. Only validated or hand-written problems can be served.`,
          );
        }
        const config = readConfig();
        const mode: SessionMode = optionalEnum(args, "mode", MODES) ?? "interview";
        const timerMinutes = optionalInt(args, "timer_minutes", 1, 240) ?? config.timerMinutes;

        const base = await server.start();
        const session = createSession({
          problem: slug,
          problemTitle: bundle.meta.title,
          patterns: bundle.meta.patterns,
          difficulty: bundle.meta.difficulty as Difficulty,
          mode,
          timerMs: timerMinutes * 60_000,
        });
        updateMeta(slug, { timesServed: bundle.meta.timesServed + 1, lastServedAt: Date.now() });
        host.created(session.id);
        if (optionalBool(args, "start_now")) startClock(session.id, Date.now(), "interviewer");

        const url = server.urlForSession(session.id) ?? base;
        if (shouldAutoOpen(config)) openUrl(url);
        return ok(
          [
            `Session ${session.id} is ready: ${url}`,
            `The candidate sees the statement, ${bundle.tests.filter((c) => c.visible).length} examples, a ${timerMinutes}-minute clock, and ${bundle.hints.length} hints they can take. ${bundle.tests.length - bundle.tests.filter((c) => c.visible).length} hidden cases run on Submit.`,
            `Target complexity: ${bundle.meta.complexityTarget.time} time, ${bundle.meta.complexityTarget.space} space.`,
            "Give the user the URL, say one sentence on the page with say_to_candidate, then call wait_for_candidate.",
          ].join("\n"),
          { sessionId: session.id, url },
        );
      },
    },
    {
      name: "get_session",
      title: "Get Session",
      description:
        "The state of a session for the interviewer: phase, clock, approach note, hints, submissions, the conversation on the page, and optionally the draft code.",
      inputSchema: schema.obj(
        {
          session_id: schema.str("The session id."),
          include_code: schema.bool("Include the candidate's current draft."),
        },
        ["include_code"],
      ),
      async execute(args) {
        const id = requireString(args, "session_id", 120);
        if (!isValidSessionId(id) || !sessionExists(id)) return fail(`No session named ${id}.`);
        const state = sessionState(id);
        return ok(sessionSummaryText(state, optionalBool(args, "include_code") ?? false), {
          phase: state.session.phase,
          remainingMs: state.remainingMs,
          submissions: state.session.submissions,
        });
      },
    },
    {
      name: "abandon_session",
      title: "Abandon Session",
      description:
        'End a session without a debrief. Counts as a miss for its patterns unless the reason is "interrupted", meaning the session stopped for reasons unrelated to the candidate.',
      inputSchema: schema.obj({
        session_id: schema.str("The session id."),
        reason: schema.str(
          'Why it ended early. Use "interrupted" when it should not count against the candidate.',
        ),
      }),
      async execute(args) {
        const id = requireString(args, "session_id", 120);
        if (!isValidSessionId(id) || !sessionExists(id)) return fail(`No session named ${id}.`);
        const outcome = abandonSession(id, requireString(args, "reason", 500));
        const lines = [`Abandoned. ${sessionLine(outcome.session)}`];
        lines.push(
          outcome.reviewEvents.length
            ? `Recorded as a miss for ${outcome.session.patterns.join(", ")}.`
            : "Not counted against the candidate.",
        );
        lines.push(...outcome.nextDue);
        return ok(lines.join("\n"));
      },
    },
  ];
}
