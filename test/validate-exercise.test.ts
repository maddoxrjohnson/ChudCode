/**
 * Exercise validation: the shape of the brief and teaching, and citations that trace
 * every claim to a curriculum fact.
 */

import { describe, expect, it } from "vitest";

import { findLesson } from "../src/curriculum.ts";
import type { ExerciseBundle } from "../src/store/exercises.ts";
import { citedFacts, validateExercise } from "../src/validate-exercise.ts";
import { BRIEF, OUTLINE, TEACHING } from "./lesson-fixtures.ts";

const lesson = findLesson("plan-before-code")!.lesson;

function bundle(change: Partial<ExerciseBundle> = {}): ExerciseBundle {
  return {
    meta: {
      slug: "plan-ofx-import",
      kind: "design-review",
      lesson: "plan-before-code",
      title: "Plan OFX import",
      createdAt: 0,
      timesServed: 0,
    },
    brief: BRIEF,
    teaching: TEACHING,
    private: { modelOutline: OUTLINE, followUps: ["a?", "b?"], pitfalls: ["x", "y"] },
    ...change,
  };
}

describe("validateExercise", () => {
  it("passes a sound exercise and reports what it cites", () => {
    const report = validateExercise(bundle(), lesson);
    expect(report.errors).toEqual([]);
    expect(report.cited).toEqual([
      "explore-plan-implement-commit",
      "plan-mode-behavior",
      "plan-mode-overhead",
    ]);
  });

  it("rejects an unsourced citation and a missing core fact", () => {
    const teaching =
      TEACHING.replace("[fact:plan-mode-overhead]", "") +
      "\n\nHooks always run [fact:hooks-magic].";
    const errors = validateExercise(bundle({ teaching }), lesson).errors.join("\n");
    expect(errors).toMatch(/Cited facts this lesson does not have: hooks-magic/);
    expect(errors).toMatch(/Missing: plan-mode-overhead/);
  });

  it("needs both brief sections, enough follow-ups, and a private outline", () => {
    const report = validateExercise(
      bundle({
        brief: BRIEF.replace("## Your task", "## Task"),
        private: { modelOutline: "short", followUps: ["one?"], pitfalls: [] },
      }),
      lesson,
    );
    const errors = report.errors.join("\n");
    expect(errors).toMatch(/needs a "## Your task" section/);
    expect(errors).toMatch(/model_outline must be at least/);
    expect(errors).toMatch(/follow_ups needs at least 2/);
    expect(errors).toMatch(/pitfalls needs at least 2/);
  });

  it("refuses an exercise whose answer is printed on the page", () => {
    const errors = validateExercise(bundle({ brief: `${BRIEF}\n\n${OUTLINE}` }), lesson).errors;
    expect(errors.join("\n")).toMatch(/model outline appears in the brief/);
  });

  it("refuses a kind the lesson does not use", () => {
    const other = findLesson("managing-context")!.lesson;
    const errors = validateExercise(bundle(), { ...other, exercises: ["lab"] }).errors;
    expect(errors.join("\n")).toMatch(/is for plan-before-code, not managing-context/);
    expect(errors.join("\n")).toMatch(/does not use design-review exercises/);
  });
});

describe("citedFacts", () => {
  it("lists each id once in first-cited order", () => {
    expect(citedFacts("a [fact:x-1] b [fact:y] c [fact:x-1] [fact:Bad]")).toEqual(["x-1", "y"]);
  });
});
