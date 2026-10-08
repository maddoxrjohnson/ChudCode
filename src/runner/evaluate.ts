/**
 * evaluate.ts: turn a harness's raw case result into a pass/fail verdict.
 *
 * A case passes when the harness ran it cleanly and its output matches the expected
 * value under the case's compare mode. A case with no `expected` key is an oracle
 * case: it passes on a clean run, and validation records its output as the expected
 * value from then on.
 */

import { compareOutputs, type CompareOptions } from "./compare.ts";
import type { CaseResult, RawCaseResult, TestCase } from "./types.ts";

export function evaluateCase(raw: RawCaseResult, testCase: TestCase): CaseResult {
  const base: CaseResult = {
    id: raw.id,
    status: "error",
    stdout: raw.stdout ?? "",
    stderr: raw.stderr ?? "",
    timeMs: raw.timeMs ?? 0,
  };
  if (raw.message !== undefined) base.message = raw.message;
  if ("expected" in testCase) base.expected = testCase.expected;
  if (raw.actual !== undefined) base.actual = raw.actual;

  if (raw.status === "timeout") return { ...base, status: "timeout" };
  if (raw.status === "error") return base;

  if (testCase.compare === "checker") {
    if (raw.checkerPassed === undefined) {
      return { ...base, status: "error", message: "checker.py gave no verdict for this case" };
    }
    return {
      ...base,
      status: raw.checkerPassed ? "pass" : "fail",
      checkerPassed: raw.checkerPassed,
    };
  }

  if (!("expected" in testCase)) return { ...base, status: "pass" };

  const options: CompareOptions = {};
  if (testCase.compare !== undefined) options.mode = testCase.compare;
  if (testCase.tolerance !== undefined) options.tolerance = testCase.tolerance;
  const matched = compareOutputs(raw.actual, testCase.expected, options);
  return { ...base, status: matched ? "pass" : "fail" };
}

export function skippedCase(testCase: TestCase, message: string): CaseResult {
  const result: CaseResult = {
    id: testCase.id,
    status: "skipped",
    stdout: "",
    stderr: "",
    timeMs: 0,
    message,
  };
  if ("expected" in testCase) result.expected = testCase.expected;
  return result;
}

export function countPassed(cases: readonly CaseResult[]): number {
  return cases.filter((c) => c.status === "pass").length;
}
