import { describe, expect, it } from "vitest";

import {
  gradeRefactor,
  publicApi,
  refactorSpecErrors,
  shapeMetrics,
  testsFirst,
  validateRefactorSpec,
} from "../src/drill/refactor.ts";
import { pythonAdapter, pythonAvailable } from "../src/runner/adapters/python/adapter.ts";
import { processRunner } from "../src/runner/process-runner.ts";
import {
  BAD_REFACTOR,
  CHARACTERISATION,
  CLEAN,
  GOOD_REFACTOR,
  LEGACY,
  REFACTOR_SPEC,
} from "./refactor-fixtures.ts";

const run = processRunner.runSuite.bind(processRunner);
const bin = pythonAdapter.pythonBin;
const TESTS = { "tests/test_pricing.py": CHARACTERISATION };
const IN_ORDER = [
  { hash: "a", files: ["README.md", "pricing.py"] },
  { hash: "b", files: ["tests/test_pricing.py"] },
  { hash: "c", files: ["pricing.py"] },
];

describe("reading the source", () => {
  it("measures the longest function and the deepest nesting", () => {
    expect(shapeMetrics(LEGACY)).toMatchObject({ longestFunction: 28, maxNesting: 5 });
    expect(shapeMetrics(CLEAN)).toMatchObject({ longestFunction: 8, maxNesting: 2 });
  });

  it("lists the public functions and their parameters", () => {
    expect(publicApi(LEGACY)).toEqual(["price(items, coupon=None, member=False)"]);
    expect(publicApi(CLEAN)).toEqual(publicApi(LEGACY));
    expect(publicApi(CLEAN.replace("member=False", "member"))).not.toEqual(publicApi(LEGACY));
  });

  it("checks that tests landed before the module changed", () => {
    expect(testsFirst(IN_ORDER, "pricing")).toEqual({ ok: true });
    expect(
      testsFirst(
        [IN_ORDER[0]!, { hash: "b", files: ["tests/test_pricing.py", "pricing.py"] }],
        "pricing",
      ).problem,
    ).toMatch(/same commit as the first tests/);
    expect(testsFirst([IN_ORDER[0]!, IN_ORDER[2]!, IN_ORDER[1]!], "pricing").ok).toBe(false);
    expect(testsFirst([IN_ORDER[0]!], "pricing").problem).toMatch(/No commit adds tests/);
  });

  it("needs a clean version that is better shaped and keeps the interface", () => {
    expect(refactorSpecErrors(REFACTOR_SPEC)).toEqual([]);
    const errors = refactorSpecErrors({
      ...REFACTOR_SPEC,
      clean: LEGACY.replace("member=False", "vip=False"),
    });
    expect(errors.join("\n")).toMatch(/better shaped/);
    expect(errors.join("\n")).toMatch(/keep legacy_py's public functions/);
  });
});

describe.skipIf(!pythonAvailable())("grading a refactor", () => {
  it("validates the spec by its oracle", async () => {
    expect(await validateRefactorSpec(REFACTOR_SPEC, run, bin)).toEqual([]);
  }, 60_000);

  it("passes tests first, strong characterisation, same behaviour, and a better shape", async () => {
    const report = await gradeRefactor(REFACTOR_SPEC, GOOD_REFACTOR, TESTS, IN_ORDER, run, bin);
    expect(report.problems).toEqual([]);
    expect(report.characterisation.killed).toBe(4);
    expect(report.after.longestFunction).toBeLessThan(report.before.longestFunction);
    expect(report.passed).toBe(true);
  }, 60_000);

  it("fails a refactor that changes behaviour, and one that never changed shape", async () => {
    const changed = await gradeRefactor(REFACTOR_SPEC, BAD_REFACTOR, TESTS, IN_ORDER, run, bin);
    expect(changed.problems).toContain(
      "The refactored module changes behaviour: a hidden behaviour test fails on it.",
    );
    expect(changed.problems).toContain("Your own tests fail on the refactored module.");
    const untouched = await gradeRefactor(REFACTOR_SPEC, LEGACY, TESTS, IN_ORDER, run, bin);
    expect(untouched.problems).toEqual([
      "Neither the longest function nor the deepest nesting got smaller: the structure did not change.",
    ]);
  }, 60_000);

  it("fails weak characterisation and tests written with the change", async () => {
    const weak = {
      "tests/test_pricing.py":
        "import unittest\nfrom pricing import price\n\nclass T(unittest.TestCase):\n    def test_plain(self):\n        self.assertEqual(price([{'qty': 1, 'price': 5}]), 5)\n",
    };
    const report = await gradeRefactor(
      REFACTOR_SPEC,
      GOOD_REFACTOR,
      weak,
      [IN_ORDER[0]!, { hash: "b", files: ["tests/test_pricing.py", "pricing.py"] }],
      run,
      bin,
    );
    expect(report.problems.join("\n")).toMatch(/same commit as the first tests/);
    expect(report.problems.join("\n")).toMatch(/caught 0 of 4 planted bugs in the original/);
    expect(report.passed).toBe(false);
  }, 60_000);
});
