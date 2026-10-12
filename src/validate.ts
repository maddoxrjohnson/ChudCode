/**
 * validate.ts: prove a problem bundle is ready to serve.
 *
 * A problem passes validation when it survives two checks. The lint says the bundle has
 * the shape an interview needs: enough visible and hidden cases, a case at the top of
 * the constraints, a hint ladder, a complexity target, a statement with constraints.
 * The run executes the reference solution against every case under the validation
 * limits: every authored `expected` must match what the reference returns, every case
 * must finish inside the per-case limit, and a case with no `expected` takes the
 * reference's output as its oracle and is written back. Only a bundle that passes both
 * gets `validatedAt`, and only a bundle with `validatedAt` can be served.
 */

import { canonical } from "./runner/compare.ts";
import type { CaseResult, Limits, RunResult, TestCase } from "./runner/types.ts";
import { runCode } from "./runs.ts";
import {
  clearValidation,
  readProblem,
  updateMeta,
  writeTests,
  type ProblemBundle,
} from "./store/problems.ts";

export const MIN_VISIBLE_CASES = 2;
export const MIN_HIDDEN_CASES = 6;
export const MIN_HINTS = 2;
export const MAX_HINTS = 4;
/** An input holding this many elements, across all its arguments, counts as max-size. */
export const LARGE_INPUT_SIZE = 1_000;

const COMPLEXITY_RE = /\bO\(.+\)/;

export interface Disagreement {
  id: string;
  expected: unknown;
  actual: unknown;
}

export interface ValidationReport {
  slug: string;
  passed: boolean;
  /** Problems with the bundle's shape, independent of the run. */
  lint: string[];
  /** The reference solution's run over every case. */
  run: RunResult;
  /** The cases that were run, with oracle outputs filled in where the run allowed it. */
  cases: TestCase[];
  /** Ids of cases whose `expected` was filled from the reference. */
  filled: string[];
  /** Cases where the reference returned something other than the authored `expected`. */
  disagreements: Disagreement[];
  /** Cases that errored, timed out, or were skipped. */
  broken: CaseResult[];
  validatedAt?: number;
}

/** What the bundle lacks to be an interview problem, as sentences. Empty means it is fine. */
export function lintBundle(bundle: ProblemBundle): string[] {
  const problems: string[] = [];
  const { meta, tests, hints, statement } = bundle;

  const visible = tests.filter((c) => c.visible).length;
  const hidden = tests.length - visible;
  if (visible < MIN_VISIBLE_CASES) {
    problems.push(
      `at least ${MIN_VISIBLE_CASES} visible cases (found ${visible}): the candidate needs worked examples to run against`,
    );
  }
  if (hidden < MIN_HIDDEN_CASES) {
    problems.push(
      `at least ${MIN_HIDDEN_CASES} hidden cases (found ${hidden}): see the hidden-test checklist`,
    );
  }
  if (!tests.some(isLargeCase)) {
    problems.push(
      `at least one max-size case: a hidden case built by a generator, or a literal input holding ${LARGE_INPUT_SIZE}+ elements, so a solution one factor too slow fails`,
    );
  }

  const seenInputs = new Map<string, string>();
  for (const testCase of tests) {
    if (testCase.input === undefined) continue;
    const key = canonical(testCase.input);
    const earlier = seenInputs.get(key);
    if (earlier !== undefined)
      problems.push(`cases ${earlier} and ${testCase.id} have the same input`);
    else seenInputs.set(key, testCase.id);
  }

  if (hints.length < MIN_HINTS || hints.length > MAX_HINTS) {
    problems.push(
      `between ${MIN_HINTS} and ${MAX_HINTS} hints (found ${hints.length}), each more specific than the last`,
    );
  }
  const hintTexts = new Set(hints.map((h) => h.text.trim().toLowerCase()));
  if (hintTexts.size !== hints.length) problems.push("hints must all be different");

  for (const key of ["time", "space"] as const) {
    if (!COMPLEXITY_RE.test(meta.complexityTarget[key])) {
      problems.push(`complexityTarget.${key} must be written as a bound like O(n log n)`);
    }
  }

  if (!/^##\s+Constraints\b/m.test(statement)) {
    problems.push('the statement needs a "## Constraints" section with the input bounds');
  }
  if (/leetcode/i.test(statement)) {
    problems.push("the statement must not mention LeetCode or link to another site's problem");
  }

  if (meta.source.kind === "mimic" && !meta.source.mimicOf) {
    problems.push("source.mimicOf must name the problem a mimic follows");
  }
  return problems;
}

/** A case built by a generator, or one whose literal input is already large. */
export function isLargeCase(testCase: TestCase): boolean {
  if (testCase.gen !== undefined) return true;
  if (testCase.input === undefined) return false;
  return (
    Object.values(testCase.input).reduce<number>((n, v) => n + sizeOf(v), 0) >= LARGE_INPUT_SIZE
  );
}

/** Elements in a JSON value: a string counts its characters, a list its items recursively. */
function sizeOf(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + sizeOf(v), 0);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (n, v) => n + sizeOf(v),
      0,
    );
  }
  return 1;
}

/**
 * Lint the bundle and run its reference against every case. On a full pass, write
 * oracle outputs back to tests.json and stamp `validatedAt`; on any failure, make
 * sure the problem is not marked validated.
 */
export async function validateProblem(
  slug: string,
  limits: Limits,
  now = Date.now(),
): Promise<ValidationReport> {
  const bundle = readProblem(slug);
  const lint = lintBundle(bundle);

  const outcome = await runCode({
    bundle,
    code: bundle.reference,
    scope: "all",
    limits,
    revealFailingInput: false,
  });
  const { result } = outcome;

  const byId = new Map(result.cases.map((c) => [c.id, c]));
  const disagreements: Disagreement[] = [];
  const broken: CaseResult[] = [];
  const filled: string[] = [];
  const cases = bundle.tests.map((testCase) => {
    const caseResult = byId.get(testCase.id);
    if (!caseResult) return testCase;
    if (caseResult.status === "fail") {
      disagreements.push({
        id: testCase.id,
        expected: testCase.expected,
        actual: caseResult.actual,
      });
      return testCase;
    }
    if (caseResult.status !== "pass") {
      broken.push(caseResult);
      return testCase;
    }
    if ("expected" in testCase) return testCase;
    filled.push(testCase.id);
    return {
      ...testCase,
      expected: testCase.compare === "any-of" ? [caseResult.actual] : caseResult.actual,
    };
  });

  const ranClean =
    result.status === "ok" &&
    result.passed === result.total &&
    disagreements.length === 0 &&
    broken.length === 0;
  const passed = lint.length === 0 && ranClean;

  const report: ValidationReport = {
    slug,
    passed,
    lint,
    run: result,
    cases,
    filled,
    disagreements,
    broken,
  };
  if (passed) {
    if (filled.length > 0) writeTests(slug, cases);
    updateMeta(slug, {
      validatedAt: now,
      validation: { passed: result.passed, total: result.total },
    });
    report.validatedAt = now;
  } else if (bundle.meta.validatedAt !== undefined) {
    clearValidation(slug);
  }
  return report;
}
