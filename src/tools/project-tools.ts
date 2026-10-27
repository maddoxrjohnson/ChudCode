/**
 * project-tools.ts: repository debugging sessions. Begin, list, write and validate a
 * project, start a session on one, and score it. Speaking on the page, hints,
 * waiting, the session state, and abandoning use the shared tools, which branch on
 * a project session id.
 */

import { createProjectWorkspace } from "../drill/project-workspace.ts";
import { FlowError, notifyDashboard } from "../flow.ts";
import { openUrl } from "../open-browser.ts";
import { defaultProjectRunner, recordProject, startProject } from "../project-flow.ts";
import { projectBrief, projectLine, projectValidationText } from "../project-prompts.ts";
import { validateProjectBundle } from "../project-validate.ts";
import { thenWait } from "../prompts.ts";
import { DjangoEnvError } from "../runner/django-env.ts";
import * as server from "../server/server.ts";
import { AGENT_CHANNEL, push } from "../server/sse.ts";
import { readConfig, shouldAutoOpen } from "../store/config.ts";
import { isValidSessionId, isValidSlug } from "../store/paths.ts";
import { DIFFICULTIES } from "../store/problems.ts";
import {
  createProjectSession,
  importProjectExamples,
  listProjects,
  listProjectSessions,
  newProjectSessionId,
  PROJECT_DIMENSIONS,
  projectExists,
  projectPatterns,
  projectSessionExists,
  ProjectValidationError,
  readProject,
  updateProjectMeta,
  writeProject,
  type PlantedBug,
} from "../store/projects.ts";
import { readTrends } from "../store/trends.ts";
import { reviewItems } from "../store/review-events.ts";
import {
  fail,
  ok,
  optionalBool,
  optionalEnum,
  optionalInt,
  optionalString,
  requireBool,
  requireString,
  schema,
  stringList,
  ToolArgumentError,
  type ToolDef,
} from "./index.ts";
import type { ToolHost } from "./session-tools.ts";

const fileMap = (description: string) => ({
  type: "object",
  description,
  additionalProperties: { type: "string" },
});

function requireProjectSession(args: Record<string, unknown>): string {
  const id = requireString(args, "session_id", 120);
  if (!isValidSessionId(id) || !projectSessionExists(id))
    throw new ToolArgumentError(`No project session named ${id}.`);
  return id;
}

function stringMap(args: Record<string, unknown>, key: string): Record<string, string> {
  const value = args[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new ToolArgumentError(`${key} must be an object of path to file contents`);
  for (const [k, v] of Object.entries(value))
    if (typeof v !== "string") throw new ToolArgumentError(`${key}["${k}"] must be a string`);
  return value as Record<string, string>;
}

export function projectTools(host: ToolHost): ToolDef[] {
  return [
    {
      name: "begin_project",
      title: "Begin Project",
      description:
        "Prepare a project session: a timed debugging task on a multi-file Django repository with planted bugs and hidden tests, the backend half of online assessments like IBM's. " +
        "Returns how to run it, the rubric, the projects on disk, the candidate's standing by bug category, and company trends. Call this first.",
      inputSchema: schema.obj(
        {
          company: schema.str("The company the candidate is preparing for, if they named one."),
          difficulty: schema.oneOf(DIFFICULTIES, "Requested difficulty."),
          oa: schema.bool(
            "Online-assessment mode: silent until the end, no hints. True when the user is preparing for an OA.",
          ),
        },
        ["company", "difficulty", "oa"],
      ),
      async execute(args) {
        importProjectExamples();
        const company = optionalString(args, "company", 80)?.trim();
        const difficulty = optionalEnum(args, "difficulty", DIFFICULTIES);
        const oa = optionalBool(args, "oa") ?? false;
        host.recover();
        return ok(
          projectBrief(
            {
              ...(company ? { company } : {}),
              ...(difficulty ? { difficulty } : {}),
              oa,
              projects: listProjects(),
              history: listProjectSessions(Number.MAX_SAFE_INTEGER),
              items: reviewItems(),
            },
            host.hostBrief,
          ),
          { oa },
        );
      },
    },
    {
      name: "list_projects",
      title: "List Projects",
      description:
        "List the debugging projects on disk with their bug categories, difficulty, and validation state.",
      inputSchema: schema.obj({}),
      async execute() {
        importProjectExamples();
        const projects = listProjects();
        if (projects.length === 0) return ok("No projects yet.", { projects: [] });
        return ok(
          projects
            .map(
              (p) =>
                `- \`${p.slug}\` ${p.title} (${p.difficulty}, ${p.minutes} min${p.drf ? ", DRF" : ""}): ${p.bugs.map((b) => b.pattern).join(", ")}. ${p.validatedAt ? "validated" : "NOT validated"}, served ${p.timesServed}×.`,
            )
            .join("\n"),
          {
            projects: projects.map((p) => ({
              slug: p.slug,
              validated: p.validatedAt !== undefined,
            })),
          },
        );
      },
    },
    {
      name: "write_project",
      title: "Write Project",
      description:
        "Write a debugging project: a Django app with planted bugs, its statement, hints, the reference fix, and visible and hidden tests. ChudCode writes manage.py, config/ (settings, urls including <app>.urls), the app's __init__.py and apps.py, and tests/__init__.py. " +
        "Writing clears validation; call validate_project next. See PROJECT.md (from begin_project) for what makes a good one.",
      inputSchema: schema.obj(
        {
          slug: schema.str("Lowercase kebab-case id."),
          title: schema.str("A short product name, e.g. 'Box Office API'."),
          app: schema.str("The Django app's package name, lowercase, e.g. 'boxoffice'."),
          drf: schema.bool("Whether the project uses Django REST framework."),
          difficulty: schema.oneOf(
            DIFFICULTIES,
            "easy (2-3 bugs, 30 min), medium (4-5, 45), hard.",
          ),
          minutes: schema.int("The time it should take.", 10, 120),
          statement: schema.str(
            "Markdown: the product in a paragraph, the API's correct behaviour precisely, a Reported issues list in users' words, and how to run the tests.",
          ),
          hints: schema.list(
            schema.str("A hint"),
            "Three hints, vague to specific; never quote the fix.",
          ),
          bugs: schema.list(
            schema.obj({
              id: schema.str("Kebab-case."),
              pattern: schema.oneOf(
                projectPatterns().map((p) => p.id),
                "The bug category.",
              ),
              summary: schema.str("What is wrong and where; for you, never shown."),
              files: schema.list(schema.str("A repository path"), "Files the fix touches."),
              tests: schema.list(
                schema.str("Class.test_method"),
                "Hidden tests that fail because of this bug.",
              ),
            }),
            "Three to five planted bugs.",
          ),
          files: fileMap(
            "The repository the candidate starts from, path to contents: the app's models, urls, views, and the rest.",
          ),
          fix: fileMap("The reference fix: the files it replaces or adds, path to full contents."),
          visible_tests: fileMap(
            "Shipped in tests/: file name (test_<name>.py) to contents. Django TestCase.",
          ),
          hidden_tests: fileMap(
            "Added as hidden_tests/ on submit: file name (test_<name>.py) to contents.",
          ),
          protected: schema.list(
            schema.str("A path"),
            "Extra read-only files, beyond manage.py, config/settings.py, and tests/.",
          ),
          trend_ids: schema.list(
            schema.str("A trend id"),
            "Trend entries whose shape this follows.",
          ),
        },
        ["protected", "trend_ids"],
      ),
      async execute(args) {
        const slug = requireString(args, "slug", 64);
        if (!isValidSlug(slug))
          return fail("slug must be lowercase kebab-case, at most 64 characters");
        const trendIds = stringList(args, "trend_ids", 10);
        const known = new Set(readTrends().map((t) => t.id));
        const unknown = trendIds.filter((t) => !known.has(t));
        if (unknown.length) return fail(`No trend entries named ${unknown.join(", ")}.`);
        const rawBugs = args["bugs"];
        if (!Array.isArray(rawBugs)) throw new ToolArgumentError("bugs must be a list");
        const bugs = rawBugs.map((b) => b as PlantedBug);
        const previous = projectExists(slug) ? readProject(slug).meta : undefined;
        try {
          const bundle = writeProject({
            meta: {
              slug,
              title: requireString(args, "title", 120),
              framework: "django",
              app: requireString(args, "app", 40),
              drf: requireBool(args, "drf"),
              patterns: [...new Set(bugs.map((b) => b.pattern))],
              difficulty: optionalEnum(args, "difficulty", DIFFICULTIES) ?? "medium",
              minutes: optionalInt(args, "minutes", 10, 120) ?? 45,
              source: { kind: "generated", ...(trendIds.length ? { trendIds } : {}) },
              bugs,
              ...(Array.isArray(args["protected"])
                ? { protected: stringList(args, "protected", 20) }
                : {}),
              createdAt: Date.now(),
              timesServed: previous?.timesServed ?? 0,
            },
            statement: requireString(args, "statement", 20_000),
            hints: stringList(args, "hints", 6).map((text, i) => ({ level: i + 1, text })),
            files: stringMap(args, "files"),
            fix: stringMap(args, "fix"),
            visibleTests: stringMap(args, "visible_tests"),
            hiddenTests: stringMap(args, "hidden_tests"),
          });
          return ok(
            `Wrote ${slug}: ${Object.keys(bundle.files).length} files, ${bundle.meta.bugs.length} bugs, ${Object.keys(bundle.visibleTests).length} visible and ${Object.keys(bundle.hiddenTests).length} hidden test files. Call validate_project next.`,
            { slug },
          );
        } catch (err) {
          if (err instanceof ProjectValidationError)
            return fail(`the project was not written:\n- ${err.problems.join("\n- ")}`, {
              problems: err.problems,
            });
          throw err;
        }
      },
    },
    {
      name: "validate_project",
      title: "Validate Project",
      description:
        "Run a project's whole test suite against real Django, twice: on the starting repository (each bug's tests must fail, and one visible test) and with the reference fix (everything must pass). " +
        "Only validated projects can be served. The first run builds the Django environment, which needs the network and can take a minute.",
      inputSchema: schema.obj({ slug: schema.str("The project's slug.") }),
      async execute(args) {
        const slug = requireString(args, "slug", 64);
        if (!projectExists(slug)) return fail(`No project named ${slug}. Call list_projects.`);
        const bundle = readProject(slug);
        try {
          const report = await validateProjectBundle(bundle, defaultProjectRunner);
          if (report.passed)
            updateProjectMeta(slug, {
              validatedAt: Date.now(),
              validation: {
                visibleFailing: report.visibleFailing,
                hiddenFailing: report.hiddenFailing,
                total: report.fixed.total,
              },
            });
          else updateProjectMeta(slug, { validatedAt: undefined as unknown as number });
          return ok(projectValidationText(report, bundle), { passed: report.passed });
        } catch (err) {
          if (err instanceof DjangoEnvError) return fail(err.message);
          throw err;
        }
      },
    },
    {
      name: "start_project",
      title: "Start Project",
      description:
        "Create a project session on a validated project: lay out its repository in a workspace folder, start the local server if needed, open the page, and return its link. " +
        "The candidate edits in the page's editor or their own, presses Run for the visible tests and Submit for the hidden ones. The clock starts when they press Start, unless start_now is true.",
      inputSchema: schema.obj(
        {
          slug: schema.str("The project's slug, from list_projects."),
          oa: schema.bool(
            "Online-assessment mode: you stay silent until the end, and there are no hints.",
          ),
          company: schema.str("The company it is practice for, if one was named."),
          timer_minutes: schema.int(
            "Length of the clock. Defaults to the project's minutes.",
            5,
            180,
          ),
          start_now: schema.bool("Start the clock immediately."),
        },
        ["oa", "company", "timer_minutes", "start_now"],
      ),
      async execute(args) {
        const slug = requireString(args, "slug", 64);
        if (!projectExists(slug)) return fail(`No project named ${slug}. Call list_projects.`);
        const bundle = readProject(slug);
        if (bundle.meta.validatedAt === undefined)
          return fail(`${slug} has not passed validation. Call validate_project first.`);
        try {
          // Build the environment now, not on the candidate's first Run.
          await defaultProjectRunner.python();
        } catch (err) {
          return fail(`the Django environment is not ready: ${(err as Error).message}`);
        }
        const oa = optionalBool(args, "oa") ?? false;
        const company = optionalString(args, "company", 80)?.trim();
        const minutes = optionalInt(args, "timer_minutes", 5, 180) ?? bundle.meta.minutes;
        const base = await server.start();
        const id = newProjectSessionId(slug, Date.now());
        const workspace = await createProjectWorkspace(id, bundle);
        const session = createProjectSession(id, {
          project: bundle,
          oa,
          ...(company ? { company } : {}),
          timerMs: minutes * 60_000,
          workspace,
        });
        updateProjectMeta(slug, {
          timesServed: bundle.meta.timesServed + 1,
          lastServedAt: Date.now(),
        });
        host.created(session.id);
        notifyDashboard(session.id);
        if (optionalBool(args, "start_now")) startProject(session.id, Date.now(), "interviewer");
        const url = server.urlForSession(session.id) ?? base;
        if (shouldAutoOpen(readConfig())) openUrl(url);
        push(AGENT_CHANNEL, "session", { sessionId: session.id, title: bundle.meta.title, url });
        return ok(
          [
            `Session ${session.id} is ready: ${url}`,
            `The candidate sees the ticket, the repository's file tree and an editor, a ${minutes}-minute clock${oa ? "" : `, and ${bundle.hints.length} hints`}. The repository is also at ${workspace} for their own editor.`,
            oa
              ? "Online-assessment mode: the chat and hints are hidden while the clock runs. Stay silent until it stops."
              : "Interview mode: they can ask you about the API as they would a teammate.",
            `Before any other tool call, write this link to the user in a message (they cannot see tool results): ${url}. ${oa ? "" : "Then say one sentence on the page with say_to_candidate. "}${thenWait()}`,
            "",
            "The planted bugs (private; never reveal where they are):",
            ...bundle.meta.bugs.map(
              (b) => `- ${b.id} (${b.pattern}) in ${b.files.join(", ")}: ${b.summary}`,
            ),
            "",
            "The statement as the candidate sees it:",
            "",
            bundle.statement.trim(),
          ].join("\n"),
          { sessionId: session.id, url, workspace },
        );
      },
    },
    {
      name: "record_project",
      title: "Record Project",
      description:
        "Score a project session and write the debrief to the page: correctness, debugging, code_quality, and time from 0 to 4, whether the fixes address root causes, notes, strengths, and improvements. " +
        "It passes when the last submission passed every test within the clock and root_cause_ok is true. Each bug category it planted is scheduled for review.",
      inputSchema: schema.obj({
        session_id: schema.str("The project session id."),
        scores: schema.obj({
          correctness: schema.int("0 to 4.", 0, 4),
          debugging: schema.int("0 to 4.", 0, 4),
          code_quality: schema.int("0 to 4.", 0, 4),
          time: schema.int("0 to 4.", 0, 4),
        }),
        root_cause_ok: schema.bool("True only when every fix addresses the cause, not the test."),
        notes_md: schema.str(
          "The debrief in Markdown: the one habit that most improves their next one first.",
        ),
        strengths: schema.list(schema.str("A strength"), "Two strengths."),
        improvements: schema.list(schema.str("Something to work on"), "Two things to work on."),
      }),
      async execute(args) {
        const id = requireProjectSession(args);
        const raw = args["scores"];
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new ToolArgumentError("scores must be an object of four scores");
        const r = raw as Record<string, unknown>;
        const scores = {
          correctness: r["correctness"],
          debugging: r["debugging"],
          codeQuality: r["code_quality"] ?? r["codeQuality"],
          time: r["time"],
        } as Record<string, number>;
        let outcome;
        try {
          outcome = recordProject(id, {
            scores,
            rootCauseOk: requireBool(args, "root_cause_ok"),
            notesMd: requireString(args, "notes_md", 10_000),
            strengths: stringList(args, "strengths", 5),
            improvements: stringList(args, "improvements", 5),
          });
        } catch (err) {
          if (err instanceof FlowError) throw new ToolArgumentError(err.message);
          throw err;
        }
        const v = outcome.session.verdict;
        const why = v
          ? [
              v.allPassed ? "all tests passed" : "not all tests passed",
              v.withinTime ? "within time" : "out of time",
              v.rootCauseOk ? "fixes at the root cause" : "fixes that work around the cause",
              `${v.bugsFixed.length}/${v.bugsTotal} bugs fixed`,
            ].join(", ")
          : "";
        return ok(
          [
            `Recorded. ${v?.correct ? "Passed" : "Not passed"} (${why}). Scores: ${PROJECT_DIMENSIONS.map((d) => `${d} ${outcome.session.rubric?.scores[d]}`).join(", ")}.`,
            ...outcome.nextDue,
            projectLine(outcome.session),
            "Summarise for the user in the terminal: the verdict, which bugs they fixed and missed, two strengths, two improvements, and when the categories come back.",
          ].join("\n"),
          { correct: v?.correct ?? false },
        );
      },
    },
  ];
}
