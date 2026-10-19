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

/** `[fact:<id>]` in teaching or brief Markdown. */
export const FACT_REF = /\[fact:([a-z0-9]+(?:-[a-z0-9]+)*)\]/g;

export const BRIEF_SECTIONS = ["## Scenario", "## Your task"] as const;

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
  for (const heading of BRIEF_SECTIONS) {
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

  const hidden = bundle.private;
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
