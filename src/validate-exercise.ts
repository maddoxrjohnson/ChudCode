/**
 * validate-exercise.ts: the checks an exercise must pass before it is served.
 *
 * A problem is validated by running its reference; an exercise is validated by its
 * shape and by its citations. Everything the teaching asserts about Claude Code must
 * trace to a curriculum fact, so the agent writing the lesson cannot slip in a claim
 * nobody sourced. Every core fact of the lesson must be taught.
 */

import type { Lesson } from "./curriculum.ts";
import type { ExerciseBundle } from "./store/exercises.ts";
import type { ExerciseKind } from "./store/lessons.ts";
import { cacheSpecErrors } from "./drill/cache-sim.ts";
import { flawSpecErrors } from "./drill/flaw-review.ts";
import { specErrors } from "./drill/mutation.ts";
import { refactorSpecErrors } from "./drill/refactor.ts";

/** `[fact:<id>]` in teaching or brief Markdown. */
export const FACT_REF = /\[fact:([a-z0-9]+(?:-[a-z0-9]+)*)\]/g;

/** The headings a brief needs, by kind. A lab's scenario is the learner's own project. */
export const BRIEF_SECTIONS: Record<ExerciseKind, readonly string[]> = {
  "design-review": ["## Scenario", "## Your task"],
  lab: ["## Your task"],
  mutation: ["## Scenario", "## Your task"],
  "flaw-review": ["## Scenario", "## Your task"],
  "cache-plan": ["## Scenario", "## Your task"],
  refactor: ["## Scenario", "## Your task"],
  transcript: ["## Your task"],
};

export const LIMITS = {
  briefMin: 200,
  briefMax: 8_000,
  teachingMin: 600,
  teachingMax: 16_000,
  outlineMin: 200,
  followUpsMin: 2,
  pitfallsMin: 2,
};

export interface ExerciseReport {
  ok: boolean;
  errors: string[];
  /** Fact ids the teaching cites, in first-cited order. */
  cited: string[];
}

export function citedFacts(markdown: string): string[] {
  const seen: string[] = [];
  for (const match of markdown.matchAll(FACT_REF)) {
    const id = match[1] as string;
    if (!seen.includes(id)) seen.push(id);
  }
  return seen;
}

export function validateExercise(bundle: ExerciseBundle, lesson: Lesson): ExerciseReport {
  const errors: string[] = [];
  const { brief, teaching } = bundle;
  const hidden = bundle.private;

  if (bundle.meta.lesson !== lesson.id)
    errors.push(`The exercise is for ${bundle.meta.lesson}, not ${lesson.id}.`);
  if (!lesson.exercises.includes(bundle.meta.kind))
    errors.push(
      `Lesson ${lesson.id} does not use ${bundle.meta.kind} exercises; it uses ${lesson.exercises.join(", ")}.`,
    );

  if (brief.length < LIMITS.briefMin || brief.length > LIMITS.briefMax)
    errors.push(
      `brief_md must be ${LIMITS.briefMin} to ${LIMITS.briefMax} characters (it is ${brief.length}).`,
    );
  if (bundle.meta.kind === "mutation") {
    if (!hidden.mutation)
      errors.push("A mutation drill needs its module, rewrites, mutants, and oracle.");
    else errors.push(...specErrors(hidden.mutation));
  }
  if (bundle.meta.kind === "flaw-review") {
    if (!hidden.flawReview) errors.push("A flaw review needs its diff, flaws, and decoys.");
    else {
      errors.push(...flawSpecErrors(hidden.flawReview));
      // The flaws' explanations are the answers; they must not be on the page.
      for (const flaw of hidden.flawReview.flaws)
        if (
          flaw.explanation.length >= 30 &&
          (brief.includes(flaw.explanation) || teaching.includes(flaw.explanation))
        )
          errors.push(`The explanation of flaw ${flaw.id} appears in the brief or teaching.`);
    }
  }
  if (bundle.meta.kind === "refactor") {
    if (!hidden.refactor)
      errors.push("A refactor drill needs its legacy module, clean refactor, mutants, and oracle.");
    else errors.push(...refactorSpecErrors(hidden.refactor));
  }
  if (bundle.meta.kind === "cache-plan") {
    if (!hidden.cachePlan) errors.push("A cache plan needs its scenario and reference plan.");
    else errors.push(...cacheSpecErrors(hidden.cachePlan.scenario, hidden.cachePlan.reference));
  }
  if (bundle.meta.kind === "transcript" && !lesson.checklist?.length)
    errors.push(`Lesson ${lesson.id} has no checklist, so it cannot review a transcript.`);
  if (bundle.meta.kind === "lab" && !(lesson.checklist?.length && lesson.labFiles?.length))
    errors.push(`Lesson ${lesson.id} has no lab checklist or lab files, so it cannot run a lab.`);
  for (const heading of BRIEF_SECTIONS[bundle.meta.kind]) {
    if (!new RegExp(`^${heading}\\s*$`, "m").test(brief))
      errors.push(`brief_md needs a "${heading}" section.`);
  }
  if (teaching.length < LIMITS.teachingMin || teaching.length > LIMITS.teachingMax)
    errors.push(
      `teaching_md must be ${LIMITS.teachingMin} to ${LIMITS.teachingMax} characters (it is ${teaching.length}).`,
    );

  const known = new Set(lesson.facts.map((f) => f.id));
  const cited = citedFacts(teaching);
  const unknown = [...new Set([...cited, ...citedFacts(brief)])].filter((id) => !known.has(id));
  if (unknown.length > 0)
    errors.push(
      `Cited facts this lesson does not have: ${unknown.join(", ")}. Cite only ${[...known].join(", ")}; anything else is unsourced.`,
    );
  const missing = lesson.facts.filter((f) => f.core && !cited.includes(f.id)).map((f) => f.id);
  if (missing.length > 0)
    errors.push(`teaching_md must teach and cite every core fact. Missing: ${missing.join(", ")}.`);

  if (hidden.modelOutline.trim().length < LIMITS.outlineMin)
    errors.push(`model_outline must be at least ${LIMITS.outlineMin} characters.`);
  if (hidden.followUps.length < LIMITS.followUpsMin)
    errors.push(`follow_ups needs at least ${LIMITS.followUpsMin} questions.`);
  if (hidden.pitfalls.length < LIMITS.pitfallsMin)
    errors.push(`pitfalls needs at least ${LIMITS.pitfallsMin} entries.`);
  // The page shows brief and teaching; the answer must not be in either.
  const outlineHead = hidden.modelOutline.trim().slice(0, 80);
  if (outlineHead.length >= 40 && (brief.includes(outlineHead) || teaching.includes(outlineHead)))
    errors.push("The model outline appears in the brief or the teaching; keep it private.");

  return { ok: errors.length === 0, errors, cited };
}
