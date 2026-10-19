/**
 * curriculum.ts: the agentic-coding track, as shipped in data/agentic/curriculum.json.
 *
 * Modules hold lessons; each lesson has goals, the facts it teaches (each with the
 * page that states it), the exercise kinds that fit it, and the rubric dimensions it
 * is scored on. A lesson with no facts yet is an outline: it shows on the dashboard
 * but cannot be taught until its facts are written and sourced.
 *
 * Modules unlock like roadmap stages: once half of the teachable lessons of every
 * module they require are passed. Standing is derived on read from scored lesson
 * sessions; nothing is stored.
 */

import * as path from "node:path";

import { allowedPattern } from "./lab.ts";
import { unlockThreshold } from "./roadmap.ts";
import { readJson } from "./store/json.ts";
import { listLessons, LESSON_DIMENSIONS, type LessonDimension } from "./store/lessons.ts";
import { dataDir, isValidSlug } from "./store/paths.ts";

/** Every exercise kind a lesson may list, including ones later phases add. */
export const CURRICULUM_EXERCISES = [
  "design-review",
  "lab",
  "mutation",
  "flaw-review",
  "cache-plan",
  "refactor",
  "transcript",
] as const;
export type CurriculumExercise = (typeof CURRICULUM_EXERCISES)[number];

export interface Fact {
  id: string;
  claim: string;
  source: string;
  /** Core facts must be taught, and cited, in every exercise for the lesson. */
  core: boolean;
  /** `YYYY-MM-DD`: when the claim was last checked against its source. */
  verifiedAt: string;
  /** The Claude Code version the claim needs, when it depends on one. */
  minVersion?: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
}

export interface Lesson {
  id: string;
  title: string;
  goals: string[];
  facts: Fact[];
  exercises: CurriculumExercise[];
  rubricFocus: LessonDimension[];
  checklist?: ChecklistItem[];
  labFiles?: string[];
}

export interface Module {
  id: string;
  name: string;
  blurb: string;
  requires: string[];
  lessons: Lesson[];
}

export interface Curriculum {
  version: number;
  factHosts: string[];
  modules: Module[];
}

/** Whether a lesson can be taught: it has sourced facts, at least one of them core. */
export function isTeachable(lesson: Lesson): boolean {
  return lesson.facts.length >= 2 && lesson.facts.some((f) => f.core);
}

// ── Loading and validation ────────────────────────────────────────────────────

let cached: Curriculum | null = null;

export function loadCurriculum(): Curriculum {
  if (cached) return cached;
  const raw = readJson<unknown>(path.join(dataDir(), "agentic", "curriculum.json"));
  const errors = validateCurriculum(raw);
  if (errors.length > 0) throw new Error(`curriculum.json is invalid:\n${errors.join("\n")}`);
  cached = raw as Curriculum;
  return cached;
}

/** Every problem with the curriculum file, or `[]` when it is sound. */
export function validateCurriculum(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(raw)) return ["the file must hold an object"];
  const hosts = Array.isArray(raw["factHosts"]) ? (raw["factHosts"] as unknown[]) : [];
  if (hosts.length === 0 || hosts.some((h) => typeof h !== "string"))
    errors.push("factHosts must be a non-empty list of host names");
  if (!Array.isArray(raw["modules"]) || raw["modules"].length === 0) {
    errors.push("modules must be a non-empty list");
    return errors;
  }

  const moduleIds = new Set<string>();
  const lessonIds = new Set<string>();
  const factIds = new Set<string>();
  for (const [m, mod] of (raw["modules"] as unknown[]).entries()) {
    const where = `modules[${m}]`;
    if (!isRecord(mod)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    const id = mod["id"];
    if (!isValidSlug(id)) errors.push(`${where}.id must be a slug`);
    else if (moduleIds.has(id)) errors.push(`${where}.id ${id} is repeated`);
    for (const key of ["name", "blurb"])
      if (typeof mod[key] !== "string" || !mod[key]) errors.push(`${where}.${key} is required`);
    const requires = Array.isArray(mod["requires"]) ? (mod["requires"] as unknown[]) : null;
    if (!requires) errors.push(`${where}.requires must be a list`);
    for (const req of requires ?? []) {
      if (typeof req !== "string" || !moduleIds.has(req))
        errors.push(`${where}.requires names ${String(req)}, which is not an earlier module`);
    }
    if (isValidSlug(id)) moduleIds.add(id);

    const lessons = Array.isArray(mod["lessons"]) ? (mod["lessons"] as unknown[]) : [];
    if (lessons.length === 0) errors.push(`${where}.lessons must be a non-empty list`);
    for (const [l, lesson] of lessons.entries()) {
      errors.push(...lessonErrors(lesson, `${where}.lessons[${l}]`, hosts, lessonIds, factIds));
    }
  }
  return errors;
}

function lessonErrors(
  lesson: unknown,
  where: string,
  hosts: unknown[],
  lessonIds: Set<string>,
  factIds: Set<string>,
): string[] {
  const errors: string[] = [];
  if (!isRecord(lesson)) return [`${where} must be an object`];
  const id = lesson["id"];
  if (!isValidSlug(id)) errors.push(`${where}.id must be a slug`);
  else if (lessonIds.has(id)) errors.push(`${where}.id ${id} is repeated`);
  else lessonIds.add(id);
  if (typeof lesson["title"] !== "string" || !lesson["title"]) errors.push(`${where}.title`);
  if (!isStringList(lesson["goals"]) || lesson["goals"].length === 0)
    errors.push(`${where}.goals must be a non-empty list of strings`);

  const exercises = lesson["exercises"];
  if (
    !Array.isArray(exercises) ||
    exercises.length === 0 ||
    exercises.some((e) => !(CURRICULUM_EXERCISES as readonly unknown[]).includes(e))
  )
    errors.push(`${where}.exercises must list kinds from ${CURRICULUM_EXERCISES.join(", ")}`);
  const focus = lesson["rubricFocus"];
  if (
    !Array.isArray(focus) ||
    focus.length === 0 ||
    focus.some((d) => !(LESSON_DIMENSIONS as readonly unknown[]).includes(d))
  )
    errors.push(`${where}.rubricFocus must list dimensions from ${LESSON_DIMENSIONS.join(", ")}`);

  const facts = Array.isArray(lesson["facts"]) ? (lesson["facts"] as unknown[]) : null;
  if (!facts) errors.push(`${where}.facts must be a list (empty for an outline)`);
  for (const [f, fact] of (facts ?? []).entries()) {
    const at = `${where}.facts[${f}]`;
    if (!isRecord(fact)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const factId = fact["id"];
    if (!isValidSlug(factId)) errors.push(`${at}.id must be a slug`);
    else if (factIds.has(factId)) errors.push(`${at}.id ${factId} is repeated`);
    else factIds.add(factId);
    if (typeof fact["claim"] !== "string" || fact["claim"].length < 20)
      errors.push(`${at}.claim must be a sentence`);
    if (typeof fact["core"] !== "boolean") errors.push(`${at}.core must be true or false`);
    if (typeof fact["verifiedAt"] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fact["verifiedAt"]))
      errors.push(`${at}.verifiedAt must be YYYY-MM-DD`);
    if (fact["minVersion"] !== undefined && typeof fact["minVersion"] !== "string")
      errors.push(`${at}.minVersion must be a version string`);
    const source = sourceHost(fact["source"]);
    if (!source) errors.push(`${at}.source must be an https URL`);
    else if (!hosts.includes(source)) errors.push(`${at}.source is on ${source}, not a factHost`);
  }
  if (facts && facts.length > 0) {
    if (facts.length < 2) errors.push(`${where} needs at least two facts, or none for an outline`);
    if (!facts.some((f) => isRecord(f) && f["core"] === true))
      errors.push(`${where} needs at least one core fact`);
  }

  const checklist = lesson["checklist"];
  if (checklist !== undefined) {
    if (
      !Array.isArray(checklist) ||
      checklist.some((c) => !isRecord(c) || !isValidSlug(c["id"]) || typeof c["text"] !== "string")
    )
      errors.push(`${where}.checklist must be a list of { id, text }`);
  }
  // An outline gets its lab checklist when its facts are written.
  if (Array.isArray(exercises) && exercises.includes("transcript") && facts && facts.length > 0)
    if (!Array.isArray(checklist) || checklist.length === 0)
      errors.push(`${where} lists a transcript review, so it needs a checklist`);
  if (Array.isArray(exercises) && exercises.includes("lab") && facts && facts.length > 0) {
    if (!Array.isArray(checklist) || checklist.length === 0)
      errors.push(`${where} lists a lab, so it needs a checklist`);
    if (!isStringList(lesson["labFiles"]) || lesson["labFiles"].length === 0)
      errors.push(`${where} lists a lab, so it needs labFiles`);
  }
  if (isStringList(lesson["labFiles"])) {
    for (const pattern of lesson["labFiles"])
      if (!allowedPattern(pattern))
        errors.push(`${where}.labFiles names ${pattern}, which is not on the lab allow-list`);
  }
  return errors;
}

function sourceHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// ── Lookups ───────────────────────────────────────────────────────────────────

export interface LessonPlace {
  module: Module;
  lesson: Lesson;
}

export function findLesson(id: string, curriculum = loadCurriculum()): LessonPlace | undefined {
  for (const module of curriculum.modules) {
    const lesson = module.lessons.find((l) => l.id === id);
    if (lesson) return { module, lesson };
  }
  return undefined;
}

export function findModule(id: string, curriculum = loadCurriculum()): Module | undefined {
  return curriculum.modules.find((m) => m.id === id);
}

// ── Standing ──────────────────────────────────────────────────────────────────

/** One scored lesson session. */
export interface LessonAttempt {
  lesson: string;
  correct: boolean;
  at: number;
  session: string;
}

export type LessonState = "passed" | "attempted" | "new" | "outline";

export interface LessonStanding {
  id: string;
  title: string;
  state: LessonState;
  attempts: number;
  lastAt: number | null;
  lastSession: string | null;
}

export interface ModuleStanding {
  id: string;
  name: string;
  blurb: string;
  requires: string[];
  unlocked: boolean;
  /** Required modules that are not yet half passed. */
  waitingOn: string[];
  passed: number;
  /** Teachable lessons; outlines do not count. */
  total: number;
  unlockAt: number;
  lessons: LessonStanding[];
}

export interface CurriculumProgress {
  modules: ModuleStanding[];
  passed: number;
  total: number;
  /** The first new lesson in the earliest open module, else the first not yet passed. */
  next: { module: ModuleStanding; lesson: LessonStanding } | null;
}

export function buildCurriculumProgress(
  curriculum: Curriculum,
  attempts: readonly LessonAttempt[],
): CurriculumProgress {
  const byLesson = new Map<string, LessonAttempt[]>();
  for (const attempt of [...attempts].sort((a, b) => a.at - b.at)) {
    const list = byLesson.get(attempt.lesson);
    if (list) list.push(attempt);
    else byLesson.set(attempt.lesson, [attempt]);
  }

  const standings = new Map<string, ModuleStanding>();
  const modules: ModuleStanding[] = curriculum.modules.map((module) => {
    const lessons = module.lessons.map((lesson): LessonStanding => {
      const list = byLesson.get(lesson.id) ?? [];
      const state: LessonState = !isTeachable(lesson)
        ? "outline"
        : list.some((a) => a.correct)
          ? "passed"
          : list.length > 0
            ? "attempted"
            : "new";
      return {
        id: lesson.id,
        title: lesson.title,
        state,
        attempts: list.length,
        lastAt: list.length > 0 ? (list[list.length - 1] as LessonAttempt).at : null,
        lastSession: list.length > 0 ? (list[list.length - 1] as LessonAttempt).session : null,
      };
    });
    const total = lessons.filter((l) => l.state !== "outline").length;
    const passed = lessons.filter((l) => l.state === "passed").length;
    const waitingOn = module.requires.filter((req) => {
      const before = standings.get(req);
      // A locked requirement blocks even when it has nothing teachable yet.
      return before !== undefined && (!before.unlocked || before.passed < before.unlockAt);
    });
    const standing: ModuleStanding = {
      id: module.id,
      name: module.name,
      blurb: module.blurb,
      requires: module.requires,
      unlocked: waitingOn.length === 0,
      waitingOn,
      passed,
      total,
      unlockAt: unlockThreshold(total),
      lessons,
    };
    standings.set(module.id, standing);
    return standing;
  });

  const open = modules.filter((m) => m.unlocked);
  const pick = (state: LessonState) => {
    for (const module of open) {
      const lesson = module.lessons.find((l) => l.state === state);
      if (lesson) return { module, lesson };
    }
    return null;
  };
  return {
    modules,
    passed: modules.reduce((n, m) => n + m.passed, 0),
    total: modules.reduce((n, m) => n + m.total, 0),
    next: pick("new") ?? pick("attempted"),
  };
}

/** Scored lessons on disk, as attempts. Abandoned ones that count are misses. */
export function lessonAttempts(): LessonAttempt[] {
  return listLessons(Number.MAX_SAFE_INTEGER).flatMap((s) => {
    if (s.verdict)
      return [
        {
          lesson: s.lesson,
          correct: s.verdict.correct,
          at: s.endedAt ?? s.createdAt,
          session: s.id,
        },
      ];
    if (s.abandonedReason !== undefined && s.abandonedReason !== "interrupted")
      return [{ lesson: s.lesson, correct: false, at: s.endedAt ?? s.createdAt, session: s.id }];
    return [];
  });
}

export function loadCurriculumProgress(): CurriculumProgress {
  return buildCurriculumProgress(loadCurriculum(), lessonAttempts());
}
