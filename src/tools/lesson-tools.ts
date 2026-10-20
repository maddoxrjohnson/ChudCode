/**
 * lesson-tools.ts: the agentic-coding curriculum, its exercises, and lesson sessions.
 */

import { findLesson, loadCurriculumProgress, type LessonPlace } from "../curriculum.ts";
import { notifyDashboard } from "../flow.ts";
import {
  inspectLab,
  inspectMediaLab,
  inspectTranscript,
  recordLesson,
  startLesson,
} from "../lesson-flow.ts";
import { readVisual } from "../media-lab.ts";
import {
  curriculumText,
  labSnapshotText,
  transcriptAuditText,
  mediaSnapshotText,
  lessonBrief,
  lessonLine,
  LESSON_DIMENSION_NAMES,
  SERVABLE_EXERCISES,
} from "../lesson-prompts.ts";
import { openUrl } from "../open-browser.ts";
import { thenWait } from "../prompts.ts";
import * as server from "../server/server.ts";
import { AGENT_CHANNEL, push } from "../server/sse.ts";
import { readConfig, shouldAutoOpen } from "../store/config.ts";
import {
  exerciseExists,
  listExercises,
  readExercise,
  updateExerciseMeta,
  writeExercise,
  type ExerciseBundle,
} from "../store/exercises.ts";
import {
  appendFactCheck,
  FACT_CHECK_STATUSES,
  factFreshness,
  readFactChecks,
  type FactCheck,
} from "../store/fact-checks.ts";
import {
  CHECKLIST_STATUSES,
  createLesson,
  EXERCISE_KINDS,
  LESSON_DIMENSIONS,
  lessonExists,
  listLessons,
  updateLesson,
  readLesson,
  type ChecklistResult,
  type ExerciseKind,
  type LessonScores,
} from "../store/lessons.ts";
import { isValidSessionId, isValidSlug } from "../store/paths.ts";
import { reviewItems } from "../store/review-events.ts";
import { validateExercise } from "../validate-exercise.ts";
import {
  MUTANTS_MAX,
  MUTANTS_MIN,
  validateMutationSpec,
  type MutationSpec,
} from "../drill/mutation.ts";
import { pythonAdapter } from "../runner/adapters/python/adapter.ts";
import { suiteRunner } from "../runs.ts";
import { createRefactorWorkspace, createWorkspace } from "../drill/workspace.ts";
import { nextLesson, resolveNextLesson, type NextLesson } from "../next-lesson.ts";
import { validateRefactorSpec, type RefactorSpec } from "../drill/refactor.ts";
import {
  loadCacheModel,
  type CachePlan,
  type CacheScenario,
  type Level,
  type Ttl,
} from "../drill/cache-sim.ts";
import {
  DECOYS_MIN,
  FLAW_CATEGORIES,
  FLAWS_MAX,
  FLAWS_MIN,
  type FlawCategory,
  type FlawSpec,
} from "../drill/flaw-review.ts";
import {
  fail,
  ok,
  optionalBool,
  optionalInt,
  optionalString,
  requireString,
  schema,
  stringList,
  ToolArgumentError,
  type ToolDef,
} from "./index.ts";
import type { ToolHost } from "./session-tools.ts";

/** Lessons run longer than interviews: the learner works with their own agent. */
export const DEFAULT_LESSON_MINUTES = 45;

function requireLesson(args: Record<string, unknown>): LessonPlace {
  const id = requireString(args, "lesson", 64);
  const place = findLesson(id);
  if (!place) throw new ToolArgumentError(`No lesson ${id}. Call list_curriculum.`);
  return place;
}

function readRefactorArgs(args: Record<string, unknown>): RefactorSpec {
  requireString(args, "legacy_py", 20_000);
  const mutation = readMutationArgs({ ...args, module_py: args["legacy_py"], rewrites_py: [] });
  return {
    module: mutation.module,
    legacy: mutation.reference,
    clean: requireString(args, "clean_py", 20_000),
    mutants: mutation.mutants,
    oracleTests: mutation.oracleTests,
  };
}

function readMutationArgs(args: Record<string, unknown>): MutationSpec {
  const raw = args["mutants"];
  if (!Array.isArray(raw))
    throw new ToolArgumentError("mutants must be a list for a mutation drill");
  return {
    module: requireString(args, "module_name", 41),
    reference: requireString(args, "module_py", 20_000),
    rewrites: stringList(args, "rewrites_py", 4).map((r) => {
      if (r.length > 20_000)
        throw new ToolArgumentError("each rewrite is capped at 20,000 characters");
      return r;
    }),
    mutants: raw.slice(0, MUTANTS_MAX + 1).map((item, i) => {
      if (!item || typeof item !== "object")
        throw new ToolArgumentError(`mutants[${i}] must be an object`);
      const entry = item as Record<string, unknown>;
      return {
        id: requireString(entry, "id", 64),
        description: requireString(entry, "description", 300),
        find: requireString(entry, "find", 2_000),
        replace: typeof entry["replace"] === "string" ? entry["replace"] : "",
      };
    }),
    oracleTests: requireString(args, "oracle_tests_py", 30_000),
  };
}

function objectList(
  args: Record<string, unknown>,
  key: string,
  max: number,
): Array<Record<string, unknown>> {
  const raw = args[key];
  if (!Array.isArray(raw)) throw new ToolArgumentError(`${key} must be a list`);
  if (raw.length > max) throw new ToolArgumentError(`${key} has more than ${max} items`);
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ToolArgumentError(`${key}[${i}] must be an object`);
    return item as Record<string, unknown>;
  });
}

function intField(entry: Record<string, unknown>, key: string, where: string): number {
  const value = entry[key];
  if (!Number.isInteger(value) || (value as number) < 1)
    throw new ToolArgumentError(`${where}.${key} must be a positive integer`);
  return value as number;
}

function readFlawArgs(args: Record<string, unknown>): FlawSpec {
  return {
    diff: requireString(args, "diff", 30_000),
    flaws: objectList(args, "flaws", FLAWS_MAX + 4).map((f, i) => ({
      id: requireString(f, "id", 64),
      file: requireString(f, "file", 300),
      line: intField(f, "line", `flaws[${i}]`),
      ...(f["end_line"] !== undefined ? { endLine: intField(f, "end_line", `flaws[${i}]`) } : {}),
      category: requireString(f, "category", 32) as FlawCategory,
      critical: f["critical"] === true,
      explanation: requireString(f, "explanation", 1_000),
    })),
    decoys: objectList(args, "decoys", 10).map((d, i) => ({
      file: requireString(d, "file", 300),
      line: intField(d, "line", `decoys[${i}]`),
      note: requireString(d, "note", 500),
    })),
  };
}

function readCacheArgs(args: Record<string, unknown>): {
  scenario: CacheScenario;
  reference: CachePlan;
} {
  const scenario = args["scenario"];
  const plan = args["reference_plan"];
  if (!scenario || typeof scenario !== "object")
    throw new ToolArgumentError("scenario must be an object");
  if (!plan || typeof plan !== "object")
    throw new ToolArgumentError("reference_plan must be an object");
  const s = scenario as Record<string, unknown>;
  if (typeof s["model"] !== "string")
    throw new ToolArgumentError("scenario.model must be a string");
  return {
    scenario: {
      model: s["model"],
      segments: objectList(s, "segments", 12).map((seg, i) => ({
        id: requireString(seg, "id", 64),
        level: requireString(seg, "level", 16) as Level,
        tokens: intField(seg, "tokens", `scenario.segments[${i}]`),
        label: requireString(seg, "label", 120),
        ...(Array.isArray(seg["changesAt"]) ? { changesAt: seg["changesAt"] as number[] } : {}),
      })),
      requests: objectList(s, "requests", 200).map((req, i) => {
        if (typeof req["at"] !== "number" || !Number.isFinite(req["at"]))
          throw new ToolArgumentError(`scenario.requests[${i}].at must be a number of minutes`);
        return { at: req["at"], newTokens: Number(req["newTokens"] ?? 0) };
      }),
    },
    reference: readPlan(plan as Record<string, unknown>),
  };
}

/** A cache plan from JSON that the author or the learner wrote. */
export function readPlan(p: Record<string, unknown>): CachePlan {
  const order = p["order"];
  const breakpoints = p["breakpoints"];
  if (!Array.isArray(order) || order.some((o) => typeof o !== "string"))
    throw new ToolArgumentError("order must be a list of segment ids");
  if (!Array.isArray(breakpoints)) throw new ToolArgumentError("breakpoints must be a list");
  return {
    order: order as string[],
    breakpoints: breakpoints.map((bp, i) => {
      if (!bp || typeof bp !== "object")
        throw new ToolArgumentError(`breakpoints[${i}] must be an object`);
      const b = bp as Record<string, unknown>;
      return { after: String(b["after"] ?? ""), ttl: String(b["ttl"] ?? "") as Ttl };
    }),
  };
}

/** What record_lesson says to do next: write the next lesson ahead, then stay for a press. */
function nextLessonText(next: NextLesson | null): string {
  if (!next)
    return "The debrief is on the page. Every teachable lesson is passed. Give the user a two-line summary in the terminal, and end your turn.";
  const write = next.prepared
    ? `The next lesson, **${next.title}**, already has an exercise written: \`${next.prepared}\`. Nothing to write.`
    : `Now write the next lesson's exercise ahead of time, so the page's **Next lesson** button opens it at once: **${next.title}** (\`${next.lesson}\`). Call \`begin_lesson\` with that lesson, then \`write_exercise\` and \`validate_exercise\` until it passes. Do not call \`start_lesson\`: a press of the button reaches you and says to.`;
  return `The debrief is on the page. Give the user a two-line summary in the terminal. ${write} Then call \`wait_for_candidate\`: a press of Next lesson arrives there for the next ten minutes, and the wait says when to end your turn.`;
}

function readChecklist(raw: unknown): ChecklistResult[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ToolArgumentError("checklist must be a list");
  return raw.map((item, i) => {
    if (!item || typeof item !== "object")
      throw new ToolArgumentError(`checklist[${i}] must be an object`);
    const entry = item as Record<string, unknown>;
    return {
      id: requireString(entry, "id", 64),
      status: requireString(entry, "status", 16) as ChecklistResult["status"],
      note: requireString(entry, "note", 1_000),
    };
  });
}

export function lessonTools(host: ToolHost): ToolDef[] {
  return [
    {
      name: "begin_lesson",
      title: "Begin Lesson",
      description:
        "Start an agentic-coding lesson. Returns the teaching method, the lesson's goals and sourced facts (with any due a re-check), the exercises on disk, the learner's history on it, and the rubric. " +
        "Call this first. With no lesson, it picks the next one in the curriculum.",
      inputSchema: schema.obj(
        {
          lesson: schema.str("A lesson id from list_curriculum. Defaults to the next lesson."),
          module: schema.str("A module id: the next lesson in that module."),
          override_lock: schema.bool(
            "Teach a lesson in a locked module because the user asked for it.",
          ),
        },
        ["lesson", "module", "override_lock"],
      ),
      async execute(args) {
        const progress = loadCurriculumProgress();
        let lessonId = optionalString(args, "lesson", 64);
        const moduleId = optionalString(args, "module", 64);
        if (lessonId === undefined && moduleId !== undefined) {
          const module = progress.modules.find((m) => m.id === moduleId);
          if (!module)
            return fail(
              `No module ${moduleId}. Modules: ${progress.modules.map((m) => m.id).join(", ")}.`,
            );
          lessonId = (
            module.lessons.find((l) => l.state === "new") ??
            module.lessons.find((l) => l.state === "attempted") ??
            module.lessons.find((l) => l.state === "passed")
          )?.id;
          if (lessonId === undefined)
            return fail(`${module.name} has no teachable lessons yet; its lessons are outlines.`);
        }
        lessonId ??= progress.next?.lesson.id;
        if (lessonId === undefined) return fail("Every teachable lesson is passed.");
        const place = findLesson(lessonId);
        if (!place) return fail(`No lesson ${lessonId}. Call list_curriculum.`);
        const standing = progress.modules.find((m) => m.id === place.module.id);
        const lessonStanding = standing?.lessons.find((l) => l.id === lessonId);
        if (!standing || lessonStanding?.state === "outline")
          return fail(
            `${place.lesson.title} is an outline: its facts are not written yet, so it cannot be taught. Pick another with list_curriculum.`,
          );
        const now = Date.now();
        const text = lessonBrief(
          {
            place,
            standing,
            freshness: factFreshness(place.lesson.facts, readFactChecks(), now),
            exercises: listExercises({ lesson: place.lesson.id }),
            history: listLessons(Number.MAX_SAFE_INTEGER).filter(
              (s) => s.lesson === place.lesson.id,
            ),
            dueLessons: reviewItems()
              .filter((i) => i.kind === "lesson" && i.dueAt <= now)
              .map((i) => i.id),
            overrideLock: optionalBool(args, "override_lock") ?? false,
          },
          host.hostBrief,
          now,
        );
        return ok(text, {
          lesson: place.lesson.id,
          module: place.module.id,
          locked: !standing.unlocked,
        });
      },
    },
    {
      name: "write_exercise",
      title: "Write Exercise",
      description:
        "Write a lesson exercise: the teaching, the brief the learner works from, and the private material you grade against. Replaces any exercise with the same slug and clears its validation. " +
        "Cite curriculum facts in the teaching as [fact:<id>]. Then call validate_exercise.",
      inputSchema: schema.obj(
        {
          slug: schema.str("Lowercase kebab-case, e.g. plan-a-csv-importer."),
          lesson: schema.str("The lesson id this exercise is for."),
          kind: schema.oneOf(EXERCISE_KINDS, "The exercise kind."),
          title: schema.str("A short title for the exercise."),
          teaching_md: schema.str(
            "The lesson, in Markdown: the few ideas that matter with concrete examples, citing facts as [fact:<id>]. 600 to 16,000 characters.",
          ),
          brief_md: schema.str(
            "What the learner works from: a '## Scenario' section and a '## Your task' section.",
          ),
          model_outline: schema.str("Private: what a strong answer contains, in outline."),
          follow_ups: schema.list(
            schema.str("A question"),
            "Private: follow-up questions, strongest first. At least two.",
          ),
          pitfalls: schema.list(
            schema.str("A mistake"),
            "Private: mistakes a weak answer makes. At least two.",
          ),
          module_name: schema.str(
            "Mutation drills: the Python module the learner's tests import, e.g. limiter.",
          ),
          module_py: schema.str(
            "Mutation drills: the correct module. The learner's agent sees it and writes tests for it. Standard library only.",
          ),
          rewrites_py: schema.list(
            schema.str("A whole module"),
            "Mutation drills, private: at least two equivalent rewrites with the same public behaviour but different internals (other helper names, other control flow, other private attributes).",
          ),
          mutants: schema.list(
            schema.obj({
              id: schema.str("kebab-case"),
              description: schema.str("The bug, in one line, for the debrief."),
              find: schema.str("Text that occurs exactly once in module_py."),
              replace: schema.str("What it becomes."),
            }),
            `Mutation drills, private: ${MUTANTS_MIN} to ${MUTANTS_MAX} plausible bugs, each one edit to module_py: off-by-one bounds, a missing guard, a dropped state update, a wrong default, an edge case.`,
          ),
          oracle_tests_py: schema.str(
            "Mutation drills, private: your own unittest module (import from module_name) that passes on module_py and every rewrite and kills every mutant.",
          ),
          diff: schema.str(
            "Flaw reviews: a unified diff (--- a/x, +++ b/x, @@ hunks) an agent plausibly wrote, 40 to 200 lines. The learner sees it.",
          ),
          flaws: schema.list(
            schema.obj(
              {
                id: schema.str("kebab-case"),
                file: schema.str("The path after +++ b/."),
                line: schema.int(
                  "The first new-file line of the flaw; it must be an added line.",
                  1,
                ),
                end_line: schema.int("The last line, if the flaw spans several.", 1),
                category: schema.oneOf(FLAW_CATEGORIES, "What kind of flaw."),
                critical: schema.bool("Must be found for the review to pass."),
                explanation: schema.str("Why it is wrong and the fix, for the debrief."),
              },
              ["end_line"],
            ),
            `Flaw reviews, private: ${FLAWS_MIN} to ${FLAWS_MAX} planted flaws, at least one critical.`,
          ),
          decoys: schema.list(
            schema.obj({
              file: schema.str("The path."),
              line: schema.int("A new-file line that looks wrong and is not.", 1),
              note: schema.str("Why it is fine."),
            }),
            `Flaw reviews, private: at least ${DECOYS_MIN} lines that look suspicious and are correct.`,
          ),
          scenario: {
            type: "object",
            description:
              "Cache plans: { model, segments: [{ id, level: tools|system|messages, tokens, label, changesAt?: [request index] }], requests: [{ at: minutes, newTokens }] }. The learner sees it. Model is one of " +
              Object.keys(loadCacheModel().models).join(", ") +
              ".",
          },
          reference_plan: {
            type: "object",
            description:
              "Cache plans, private: your best plan, { order: [segment ids], breakpoints: [{ after: segment id, ttl: 5m|1h }] }. It must beat the naive plan (listed order, one 5m breakpoint at the end) by 15%.",
          },
          legacy_py: schema.str(
            "Refactor drills: the tangled but working module the learner starts from, with at least one function of 25 lines or more. Standard library only.",
          ),
          clean_py: schema.str(
            "Refactor drills, private: your own refactor of legacy_py with the same public functions and behaviour, and a shorter longest function or shallower nesting.",
          ),
        },
        [
          "module_name",
          "module_py",
          "rewrites_py",
          "mutants",
          "oracle_tests_py",
          "diff",
          "flaws",
          "decoys",
          "scenario",
          "reference_plan",
          "legacy_py",
          "clean_py",
        ],
      ),
      async execute(args) {
        const slug = requireString(args, "slug", 64);
        if (!isValidSlug(slug))
          return fail("slug must be lowercase kebab-case, at most 64 characters.");
        const place = requireLesson(args);
        const kind = args["kind"];
        if (!(EXERCISE_KINDS as readonly unknown[]).includes(kind))
          throw new ToolArgumentError(`kind must be one of ${EXERCISE_KINDS.join(", ")}`);
        const before = exerciseExists(slug) ? readExercise(slug).meta : undefined;
        const mutation = kind === "mutation" ? readMutationArgs(args) : undefined;
        const flawReview = kind === "flaw-review" ? readFlawArgs(args) : undefined;
        const cachePlan = kind === "cache-plan" ? readCacheArgs(args) : undefined;
        const refactor = kind === "refactor" ? readRefactorArgs(args) : undefined;
        const bundle: ExerciseBundle = {
          meta: {
            slug,
            kind: kind as ExerciseKind,
            lesson: place.lesson.id,
            title: requireString(args, "title", 120),
            createdAt: before?.createdAt ?? Date.now(),
            timesServed: before?.timesServed ?? 0,
          },
          teaching: requireString(args, "teaching_md", 20_000),
          brief: requireString(args, "brief_md", 10_000),
          private: {
            modelOutline: requireString(args, "model_outline", 10_000),
            followUps: stringList(args, "follow_ups", 8),
            pitfalls: stringList(args, "pitfalls", 10),
            ...(mutation ? { mutation } : {}),
            ...(flawReview ? { flawReview } : {}),
            ...(cachePlan ? { cachePlan } : {}),
            ...(refactor ? { refactor } : {}),
          },
        };
        writeExercise(bundle);
        return ok(
          `Wrote exercise ${slug} for ${place.lesson.title}. Call validate_exercise with slug ${slug}.`,
          { slug },
        );
      },
    },
    {
      name: "validate_exercise",
      title: "Validate Exercise",
      description:
        "Check an exercise before it is served: its sections and lengths, that the teaching cites every core fact of its lesson and no fact the lesson lacks, and that the private material is complete. Marks it validated when it passes.",
      inputSchema: schema.obj({ slug: schema.str("The exercise slug.") }),
      async execute(args) {
        const slug = requireString(args, "slug", 64);
        if (!exerciseExists(slug)) return fail(`No exercise named ${slug}.`);
        const bundle = readExercise(slug);
        const place = findLesson(bundle.meta.lesson);
        if (!place)
          return fail(`Exercise ${slug} names lesson ${bundle.meta.lesson}, which does not exist.`);
        const report = validateExercise(bundle, place.lesson);
        // Only run Python once the shape is right: a drill must prove every mutant killable.
        if (report.ok && bundle.private.refactor) {
          const ran = await validateRefactorSpec(
            bundle.private.refactor,
            suiteRunner(),
            pythonAdapter.pythonBin,
          );
          report.errors.push(...ran);
          report.ok = ran.length === 0;
        }
        if (report.ok && bundle.private.mutation) {
          const ran = await validateMutationSpec(
            bundle.private.mutation,
            suiteRunner(),
            pythonAdapter.pythonBin,
          );
          report.errors.push(...ran);
          report.ok = ran.length === 0;
        }
        if (!report.ok) {
          return fail(
            [
              `${slug} did not pass:`,
              ...report.errors.map((e) => `- ${e}`),
              "",
              "Fix it with write_exercise and validate again.",
            ].join("\n"),
            { errors: report.errors },
          );
        }
        updateExerciseMeta(slug, { validatedAt: Date.now() });
        return ok(
          `${slug} passed. It cites ${report.cited.join(", ")}. Serve it with start_lesson.`,
          { cited: report.cited },
        );
      },
    },
    {
      name: "start_lesson",
      title: "Start Lesson",
      description:
        "Create a lesson session for a validated exercise and return its URL. Starts the local server if needed and opens the page. " +
        "The page shows the teaching and the brief; the clock starts when the learner presses Start, unless start_now is true.",
      inputSchema: schema.obj(
        {
          slug: schema.str("The exercise slug."),
          timer_minutes: schema.int(
            `Length of the lesson clock. Default ${DEFAULT_LESSON_MINUTES}.`,
            5,
            240,
          ),
          start_now: schema.bool("Start the clock immediately."),
        },
        ["timer_minutes", "start_now"],
      ),
      async execute(args) {
        const slug = requireString(args, "slug", 64);
        if (!exerciseExists(slug)) return fail(`No exercise named ${slug}.`);
        const bundle = readExercise(slug);
        if (bundle.meta.validatedAt === undefined)
          return fail(`${slug} has not passed validation. Call validate_exercise first.`);
        if (!SERVABLE_EXERCISES.includes(bundle.meta.kind))
          return fail(`${bundle.meta.kind} exercises cannot be served yet.`);
        const place = findLesson(bundle.meta.lesson);
        if (!place)
          return fail(`Exercise ${slug} names lesson ${bundle.meta.lesson}, which does not exist.`);
        const minutes = optionalInt(args, "timer_minutes", 5, 240) ?? DEFAULT_LESSON_MINUTES;

        const base = await server.start();
        const session = createLesson({
          lesson: place.lesson.id,
          lessonTitle: place.lesson.title,
          module: place.module.id,
          exercise: slug,
          exerciseKind: bundle.meta.kind,
          focus: place.lesson.rubricFocus,
          timerMs: minutes * 60_000,
        });
        updateExerciseMeta(slug, {
          timesServed: bundle.meta.timesServed + 1,
          lastServedAt: Date.now(),
        });
        const spec = bundle.private.mutation;
        const legacy = bundle.private.refactor;
        const workspace = spec
          ? await createWorkspace(session.id, bundle.brief, spec)
          : legacy
            ? await createRefactorWorkspace(session.id, bundle.brief, legacy.module, legacy.legacy)
            : undefined;
        const module = spec?.module ?? legacy?.module;
        if (workspace && module)
          updateLesson(session.id, (s) => {
            s.drill = { workspace, module, grades: 0 };
          });
        host.created(session.id);
        notifyDashboard(session.id);
        resolveNextLesson(readLesson(session.id));
        if (optionalBool(args, "start_now")) startLesson(session.id, Date.now(), "interviewer");

        const url = server.urlForSession(session.id) ?? base;
        if (shouldAutoOpen(readConfig())) openUrl(url);
        // Pi's extension shows the link under the editor, whatever the model says.
        push(AGENT_CHANNEL, "session", { sessionId: session.id, title: place.lesson.title, url });
        return ok(
          [
            `Session ${session.id} is ready: ${url}`,
            workspace
              ? `The learner sees the teaching for ${place.lesson.title}, the brief "${bundle.meta.title}", and a ${minutes}-minute clock. Their workspace is ${workspace}: ${module}.py and an empty tests/. They point their own agent at it, then press Grade on the page.`
              : `The learner sees the teaching for ${place.lesson.title}, the brief "${bundle.meta.title}", an answer box, and a ${minutes}-minute clock.`,
            `Your reply to the user in the terminal must include this link: ${url} — the page is where they work. Then say one sentence on the page with say_to_candidate. ${thenWait()}`,
          ].join("\n"),
          { sessionId: session.id, url },
        );
      },
    },
    {
      name: "record_lesson",
      title: "Record Lesson",
      description:
        "Score a lesson session on the agentic rubric, write the debrief to the page, and schedule the lesson for review. " +
        "Every focus dimension needs a score; pass null (or leave it out) for a dimension the lesson gave no evidence on. The lesson passes when an answer was submitted and every focus dimension is 2 or more.",
      inputSchema: schema.obj(
        {
          session_id: schema.str("The lesson session id."),
          scores: {
            type: "object",
            description:
              "0 to 4 for each dimension, or null when the lesson gave no evidence. A dimension left out counts as null.",
            properties: Object.fromEntries(
              LESSON_DIMENSIONS.map((d) => [
                d,
                { type: ["integer", "null"], minimum: 0, maximum: 4 },
              ]),
            ),
          },
          notes_md: schema.str(
            "The debrief, in Markdown: what went well and what a stronger answer does.",
          ),
          strengths: schema.list(schema.str("A strength"), "Two or three strengths."),
          improvements: schema.list(
            schema.str("Something to work on"),
            "Two or three things to work on.",
          ),
          checklist: schema.list(
            schema.obj({
              id: schema.str("The checklist item id."),
              status: schema.oneOf(CHECKLIST_STATUSES, "How far the project meets it."),
              note: schema.str("The evidence: a file and what it does or lacks."),
            }),
            "Labs, media labs, and transcript reviews only, and required for them: one result for every item of the lesson's checklist, from what was inspected.",
          ),
        },
        ["strengths", "improvements", "checklist"],
      ),
      async execute(args) {
        const id = requireString(args, "session_id", 120);
        if (!isValidSessionId(id) || !lessonExists(id))
          return fail(`No lesson session named ${id}.`);
        const raw = args["scores"];
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new ToolArgumentError("scores must be an object with a value for each dimension");
        const scores = {} as LessonScores;
        for (const dim of LESSON_DIMENSIONS) {
          const value = (raw as Record<string, unknown>)[dim];
          scores[dim] = value === undefined ? null : (value as number | null);
        }
        const checklist = readChecklist(args["checklist"]);
        const outcome = recordLesson(id, {
          scores,
          notesMd: requireString(args, "notes_md", 10_000),
          strengths: stringList(args, "strengths", 6),
          improvements: stringList(args, "improvements", 6),
          ...(checklist ? { checklist } : {}),
        });
        const scored = LESSON_DIMENSION_NAMES.map(
          ([k, name]) => `${name} ${scores[k] ?? "n/a"}`,
        ).join(", ");
        return ok(
          [
            `Recorded. ${lessonLine(outcome.session)}`,
            `${outcome.session.verdict?.correct ? "Passed" : "Not passed"}: ${scored}.`,
            ...(outcome.nextDue ? [outcome.nextDue] : []),
            nextLessonText(nextLesson()),
          ].join("\n"),
          { verdict: outcome.session.verdict },
        );
      },
    },
    {
      name: "inspect_lab",
      title: "Inspect Lab",
      description:
        "Read the project the learner submitted for a lab: the lesson's lab files from the folder they named on the page, read-only, with secrets redacted, plus recent git history and mechanical lints. " +
        "The learner chooses the folder on the page; you cannot name one. Call it after they submit, and again if they resubmit.",
      inputSchema: schema.obj({ session_id: schema.str("The lab session id.") }),
      async execute(args) {
        const id = requireString(args, "session_id", 120);
        if (!isValidSessionId(id) || !lessonExists(id))
          return fail(`No lesson session named ${id}.`);
        const session = readLesson(id);
        const place = findLesson(session.lesson);
        if (!place) return fail(`Lesson ${session.lesson} is no longer in the curriculum.`);
        const snapshot = await inspectLab(id);
        return ok(labSnapshotText(snapshot, place.lesson), {
          files: snapshot.files.map((f) => f.path),
          lints: snapshot.lints.length,
        });
      },
    },
    {
      name: "inspect_media",
      title: "Inspect Media",
      description:
        "Measure the project the learner submitted for a media lab: their site pages, README, demo video, and promo images, read-only and by headers alone. " +
        "Returns every check with the facts it rests on, and up to three of the images (the social preview, a poster, a screenshot) to judge by eye. " +
        "The learner chooses the folder on the page; you cannot name one. Call it after they submit, and again if they resubmit.",
      inputSchema: schema.obj({ session_id: schema.str("The media lab session id.") }),
      async execute(args) {
        const id = requireString(args, "session_id", 120);
        if (!isValidSessionId(id) || !lessonExists(id))
          return fail(`No lesson session named ${id}.`);
        const session = readLesson(id);
        const place = findLesson(session.lesson);
        if (!place) return fail(`Lesson ${session.lesson} is no longer in the curriculum.`);
        const snapshot = inspectMediaLab(id);
        const result = ok(mediaSnapshotText(snapshot, place.lesson), {
          gatePassed: snapshot.gatePassed,
          failed: snapshot.checks.filter((c) => c.status === "fail").map((c) => c.id),
          visuals: snapshot.visuals.map((v) => v.path),
        });
        for (const visual of snapshot.visuals) {
          const bytes = readVisual(snapshot.root, visual);
          if (bytes)
            result.content.push({
              type: "image",
              data: bytes.toString("base64"),
              mimeType: visual.mimeType,
            });
        }
        return result;
      },
    },
    {
      name: "inspect_transcript",
      title: "Inspect Transcript",
      description:
        "Summarise the Claude Code session log the learner chose on the page for a transcript review: requests, models and switches, cache reads and writes, gaps long enough to expire a five-minute cache, compactions, an input cost estimate, and their first prompts (redacted). " +
        "The learner chooses the log and consents on the page; you cannot name one.",
      inputSchema: schema.obj({ session_id: schema.str("The lesson session id.") }),
      async execute(args) {
        const id = requireString(args, "session_id", 120);
        if (!isValidSessionId(id) || !lessonExists(id))
          return fail(`No lesson session named ${id}.`);
        const session = readLesson(id);
        const place = findLesson(session.lesson);
        if (!place) return fail(`Lesson ${session.lesson} is no longer in the curriculum.`);
        const audit = inspectTranscript(id);
        return ok(transcriptAuditText(audit, place.lesson), { requests: audit.requests });
      },
    },
    {
      name: "list_curriculum",
      title: "List Curriculum",
      description:
        "Progress through the agentic-coding lessons: every module with its passed count and whether it is open, and the next lesson. " +
        "Pass module to list one module's lessons. Call it when the user asks what there is to learn about coding with agents, or how far along they are.",
      inputSchema: schema.obj(
        { module: schema.str("A module id, e.g. planning or orchestration.") },
        ["module"],
      ),
      async execute(args) {
        const progress = loadCurriculumProgress();
        const module = optionalString(args, "module", 64);
        if (module !== undefined && !progress.modules.some((m) => m.id === module)) {
          return fail(
            `No module ${module}. Modules: ${progress.modules.map((m) => m.id).join(", ")}.`,
          );
        }
        return ok(curriculumText(progress, module), {
          passed: progress.passed,
          total: progress.total,
          next: progress.next
            ? { module: progress.next.module.id, lesson: progress.next.lesson.id }
            : null,
          modules: progress.modules.map((m) => ({
            id: m.id,
            unlocked: m.unlocked,
            passed: m.passed,
            total: m.total,
          })),
        });
      },
    },
    {
      name: "record_fact_check",
      title: "Record Fact Check",
      description:
        "Record that you re-read the page behind one of a lesson's facts. confirmed: the page still says it. changed: it says something else now (put what it says in note, and teach that). unreachable: the page could not be read. " +
        "A confirmed fact is not due another check for two weeks.",
      inputSchema: schema.obj(
        {
          lesson: schema.str("The lesson id."),
          fact: schema.str("The fact id, as begin_lesson lists it."),
          status: schema.oneOf(FACT_CHECK_STATUSES, "What the page says now."),
          note: schema.str("For changed or unreachable: what the page says now, or what failed."),
          url: schema.str("The page you read, if it moved."),
        },
        ["note", "url"],
      ),
      async execute(args) {
        const lessonId = requireString(args, "lesson", 64);
        const place = findLesson(lessonId);
        if (!place) return fail(`No lesson ${lessonId}. Call list_curriculum.`);
        const factId = requireString(args, "fact", 64);
        if (!place.lesson.facts.some((f) => f.id === factId))
          return fail(
            `Lesson ${lessonId} has no fact ${factId}. Its facts: ${place.lesson.facts.map((f) => f.id).join(", ")}.`,
          );
        const status = args["status"];
        if (!(FACT_CHECK_STATUSES as readonly unknown[]).includes(status))
          throw new ToolArgumentError(`status must be one of ${FACT_CHECK_STATUSES.join(", ")}`);
        const note = optionalString(args, "note", 1_000);
        if (status !== "confirmed" && note === undefined)
          throw new ToolArgumentError(`note is required when status is ${String(status)}`);
        const url = optionalString(args, "url", 500);
        const check: FactCheck = {
          lesson: lessonId,
          fact: factId,
          at: Date.now(),
          status: status as FactCheck["status"],
          ...(note !== undefined ? { note } : {}),
          ...(url !== undefined ? { url } : {}),
        };
        appendFactCheck(check);
        return ok(
          status === "confirmed"
            ? `Recorded: ${factId} confirmed.`
            : `Recorded: ${factId} ${String(status)}. Teach what the page says now, and tell the learner the shipped fact is out of date.`,
        );
      },
    },
  ];
}
