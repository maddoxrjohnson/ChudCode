/**
 * lesson-tools.ts: the agentic-coding curriculum and the facts behind it.
 */

import { findLesson, loadCurriculumProgress } from "../curriculum.ts";
import { curriculumText } from "../lesson-prompts.ts";
import { appendFactCheck, FACT_CHECK_STATUSES, type FactCheck } from "../store/fact-checks.ts";
import {
  fail,
  ok,
  optionalString,
  requireString,
  schema,
  ToolArgumentError,
  type ToolDef,
} from "./index.ts";

export function lessonTools(): ToolDef[] {
  return [
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
