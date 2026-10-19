/**
 * lesson-tools.ts: the agentic-coding curriculum, its exercises, and lesson sessions.
 */

import { findLesson, loadCurriculumProgress, type LessonPlace } from "../curriculum.ts";
import { notifyDashboard } from "../flow.ts";
import { recordLesson, startLesson } from "../lesson-flow.ts";
import {
  curriculumText,
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
  createLesson,
  EXERCISE_KINDS,
  LESSON_DIMENSIONS,
  lessonExists,
  listLessons,
  type ExerciseKind,
  type LessonScores,
} from "../store/lessons.ts";
import { isValidSessionId, isValidSlug } from "../store/paths.ts";
import { reviewItems } from "../store/review-events.ts";
import { validateExercise } from "../validate-exercise.ts";
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
      inputSchema: schema.obj({
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
      }),
      async execute(args) {
        const slug = requireString(args, "slug", 64);
        if (!isValidSlug(slug))
          return fail("slug must be lowercase kebab-case, at most 64 characters.");
        const place = requireLesson(args);
        const kind = args["kind"];
        if (!(EXERCISE_KINDS as readonly unknown[]).includes(kind))
          throw new ToolArgumentError(`kind must be one of ${EXERCISE_KINDS.join(", ")}`);
        const before = exerciseExists(slug) ? readExercise(slug).meta : undefined;
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
        host.created(session.id);
        notifyDashboard(session.id);
        if (optionalBool(args, "start_now")) startLesson(session.id, Date.now(), "interviewer");

        const url = server.urlForSession(session.id) ?? base;
        if (shouldAutoOpen(readConfig())) openUrl(url);
        // Pi's extension shows the link under the editor, whatever the model says.
        push(AGENT_CHANNEL, "session", { sessionId: session.id, title: place.lesson.title, url });
        return ok(
          [
            `Session ${session.id} is ready: ${url}`,
            `The learner sees the teaching for ${place.lesson.title}, the brief "${bundle.meta.title}", an answer box, and a ${minutes}-minute clock.`,
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
        "Every focus dimension needs a score; pass null for a dimension the lesson gave no evidence on. The lesson passes when an answer was submitted and every focus dimension is 2 or more.",
      inputSchema: schema.obj(
        {
          session_id: schema.str("The lesson session id."),
          scores: {
            type: "object",
            description: "0 to 4 for each dimension, or null when the lesson gave no evidence.",
            properties: Object.fromEntries(
              LESSON_DIMENSIONS.map((d) => [
                d,
                { type: ["integer", "null"], minimum: 0, maximum: 4 },
              ]),
            ),
            required: [...LESSON_DIMENSIONS],
          },
          notes_md: schema.str(
            "The debrief, in Markdown: what went well and what a stronger answer does.",
          ),
          strengths: schema.list(schema.str("A strength"), "Two or three strengths."),
          improvements: schema.list(
            schema.str("Something to work on"),
            "Two or three things to work on.",
          ),
        },
        ["strengths", "improvements"],
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
          if (value === undefined)
            throw new ToolArgumentError(`scores.${dim} is required (a number, or null)`);
          scores[dim] = value as number | null;
        }
        const outcome = recordLesson(id, {
          scores,
          notesMd: requireString(args, "notes_md", 10_000),
          strengths: stringList(args, "strengths", 6),
          improvements: stringList(args, "improvements", 6),
        });
        const scored = LESSON_DIMENSION_NAMES.map(
          ([k, name]) => `${name} ${scores[k] ?? "n/a"}`,
        ).join(", ");
        return ok(
          [
            `Recorded. ${lessonLine(outcome.session)}`,
            `${outcome.session.verdict?.correct ? "Passed" : "Not passed"}: ${scored}.`,
            ...(outcome.nextDue ? [outcome.nextDue] : []),
            "The debrief is on the page. Give the user a two-line summary in the terminal, and end your turn.",
          ].join("\n"),
          { verdict: outcome.session.verdict },
        );
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
