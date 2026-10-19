/**
 * exercises.ts: lesson exercises on disk, the agentic-coding counterpart of problems.
 *
 *   exercises/<slug>/
 *     meta.json       kind, lesson, title, validation state, times served
 *     brief.md        the scenario and the task, as the learner sees it
 *     teaching.md     the lesson itself, citing curriculum facts as [fact:<id>]
 *     private.json    what the interviewer grades against; never served to the page
 *                     (for a mutation drill, also the module, its rewrites, the mutants,
 *                     and the oracle tests)
 *
 * The interviewer writes a fresh exercise per lesson and validates it before serving,
 * as with problems. `private.json` holds the model answer and the follow-ups, so the
 * only routes that read an exercise go through `publicExercise`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { CachePlan, CacheScenario } from "../drill/cache-sim.ts";
import type { FlawSpec } from "../drill/flaw-review.ts";
import type { MutationSpec } from "../drill/mutation.ts";
import type { RefactorSpec } from "../drill/refactor.ts";
import { readJson, readText, writeJson, writeText } from "./json.ts";
import { type ExerciseKind } from "./lessons.ts";
import { exerciseDir, exercisesDir, isDir, isValidSlug } from "./paths.ts";

export interface ExerciseMeta {
  slug: string;
  kind: ExerciseKind;
  lesson: string;
  title: string;
  createdAt: number;
  validatedAt?: number;
  timesServed: number;
  lastServedAt?: number;
}

/** What the interviewer grades against. */
export interface ExercisePrivate {
  /** A strong answer in outline, for the interviewer to compare against. */
  modelOutline: string;
  /** Questions to ask after the first answer, strongest first. */
  followUps: string[];
  /** Mistakes a weak answer makes, for the debrief. */
  pitfalls: string[];
  /** A mutation drill's module, rewrites, mutants, and oracle. */
  mutation?: MutationSpec;
  /** A flaw review's diff (shown), its planted flaws and decoys (not). */
  flawReview?: FlawSpec;
  /** A cache plan's scenario (shown) and the best plan the author knows (not). */
  cachePlan?: { scenario: CacheScenario; reference: CachePlan };
  /** A refactor drill's legacy module, clean refactor, mutants, and oracle. */
  refactor?: RefactorSpec;
}

export interface ExerciseBundle {
  meta: ExerciseMeta;
  brief: string;
  teaching: string;
  private: ExercisePrivate;
}

/** The part of an exercise the page may show. */
export interface PublicExercise {
  slug: string;
  kind: ExerciseKind;
  lesson: string;
  title: string;
  brief: string;
  teaching: string;
  /** A flaw review's diff. */
  diff?: string;
  /** A cache plan's scenario. */
  scenario?: CacheScenario;
}

export function exerciseExists(slug: string): boolean {
  return isValidSlug(slug) && isDir(exerciseDir(slug));
}

export function readExercise(slug: string): ExerciseBundle {
  const dir = exerciseDir(slug);
  const meta = readJson<ExerciseMeta>(path.join(dir, "meta.json"));
  const brief = readText(path.join(dir, "brief.md"));
  const teaching = readText(path.join(dir, "teaching.md"));
  const hidden = readJson<ExercisePrivate>(path.join(dir, "private.json"));
  if (!meta || brief === null || teaching === null || !hidden)
    throw new Error(`No exercise named ${slug}`);
  if (meta.slug !== slug) throw new Error(`Exercise directory ${slug} holds meta for ${meta.slug}`);
  return { meta, brief, teaching, private: hidden };
}

/** Write a whole exercise, replacing any with the same slug. Clears its validation. */
export function writeExercise(bundle: ExerciseBundle): void {
  const target = exerciseDir(bundle.meta.slug);
  fs.mkdirSync(exercisesDir(), { recursive: true });
  const staging = fs.mkdtempSync(path.join(exercisesDir(), `.staging-${bundle.meta.slug}-`));
  try {
    const { validatedAt: _cleared, ...meta } = bundle.meta;
    void _cleared;
    writeJson(path.join(staging, "meta.json"), meta);
    writeText(path.join(staging, "brief.md"), bundle.brief);
    writeText(path.join(staging, "teaching.md"), bundle.teaching);
    writeJson(path.join(staging, "private.json"), bundle.private);
    if (isDir(target)) {
      const retired = `${target}.replaced-${Date.now()}`;
      fs.renameSync(target, retired);
      fs.renameSync(staging, target);
      fs.rmSync(retired, { recursive: true, force: true });
    } else {
      fs.renameSync(staging, target);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function updateExerciseMeta(slug: string, change: Partial<ExerciseMeta>): ExerciseMeta {
  const file = path.join(exerciseDir(slug), "meta.json");
  const meta = readJson<ExerciseMeta>(file);
  if (!meta) throw new Error(`No exercise named ${slug}`);
  const next = { ...meta, ...change };
  writeJson(file, next);
  return next;
}

export function listExercises(filter: { lesson?: string } = {}): ExerciseMeta[] {
  const root = exercisesDir();
  if (!isDir(root)) return [];
  const out: ExerciseMeta[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
    const meta = readJson<ExerciseMeta>(path.join(root, entry.name, "meta.json"));
    if (!meta || meta.slug !== entry.name) continue;
    if (filter.lesson && meta.lesson !== filter.lesson) continue;
    out.push(meta);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function publicExercise(bundle: ExerciseBundle): PublicExercise {
  return {
    slug: bundle.meta.slug,
    kind: bundle.meta.kind,
    lesson: bundle.meta.lesson,
    title: bundle.meta.title,
    brief: bundle.brief,
    teaching: bundle.teaching,
    // Only the parts of a drill the learner works from; the answers stay private.
    ...(bundle.private.flawReview ? { diff: bundle.private.flawReview.diff } : {}),
    ...(bundle.private.cachePlan ? { scenario: bundle.private.cachePlan.scenario } : {}),
  };
}
