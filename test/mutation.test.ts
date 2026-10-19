import { describe, expect, it } from "vitest";

import {
  applyMutant,
  runMutation,
  scanTestFiles,
  specErrors,
  validateMutationSpec,
} from "../src/drill/mutation.ts";
import { pythonAdapter, pythonAvailable } from "../src/runner/adapters/python/adapter.ts";
import { processRunner } from "../src/runner/process-runner.ts";
import { ORACLE, REFERENCE, SPEC, WEAK_TESTS } from "./mutation-fixtures.ts";

const run = processRunner.runSuite.bind(processRunner);
const bin = pythonAdapter.pythonBin;

describe("mutation specs", () => {
  it("applies a mutant where its text occurs exactly once", () => {
    expect(applyMutant(REFERENCE, SPEC.mutants[0]!)).toContain("if cost < self.tokens:");
    expect(() =>
      applyMutant(REFERENCE, { id: "x", description: "", find: "self", replace: "me" }),
    ).toThrow(/exactly once/);
  });

  it("checks the shape before running anything", () => {
    expect(specErrors(SPEC)).toEqual([]);
    const errors = specErrors({
      ...SPEC,
      module: "tests",
      rewrites: [REFERENCE],
      mutants: [
        { id: "a", description: "", find: "nope", replace: "x" },
        { id: "a", description: "", find: "pass", replace: "pass" },
      ],
      oracleTests: "assert True",
    });
    expect(errors.join("\n")).toMatch(/would shadow the test runner/);
    expect(errors.join("\n")).toMatch(/at least 2 equivalent/);
    expect(errors.join("\n")).toMatch(/rewrites\[0\] is the reference/);
    expect(errors.join("\n")).toMatch(/mutants needs 4 to 15/);
    expect(errors.join("\n")).toMatch(/mutant id a is repeated/);
    expect(errors.join("\n")).toMatch(/changes nothing/);
    expect(errors.join("\n")).toMatch(/must be a unittest module/);
  });

  it("flags tests that reach for hidden files or paste in the code", () => {
    const pasted = `import unittest\n${REFERENCE}\nclass T(unittest.TestCase):\n    pass\n`;
    const flags = scanTestFiles(
      {
        "tests/test_a.py": "open('/home/me/.chudcode/exercises/x/private.json')",
        "tests/test_b.py": pasted,
        "tests/test_c.py": "import inspect\ninspect.getsource(Bucket)",
        "tests/test_d.py": ORACLE,
      },
      REFERENCE,
    );
    expect(flags.map((f) => [f.file, f.severity])).toEqual([
      ["tests/test_a.py", "hard"],
      ["tests/test_a.py", "hard"],
      ["tests/test_b.py", "hard"],
      ["tests/test_c.py", "soft"],
    ]);
  });
});

describe.skipIf(!pythonAvailable())("running the drill", () => {
  it("validates a spec whose oracle kills every mutant", async () => {
    expect(await validateMutationSpec(SPEC, run, bin)).toEqual([]);
  }, 60_000);

  it("rejects a mutant the oracle misses and a rewrite that is not equivalent", async () => {
    const errors = await validateMutationSpec(
      {
        ...SPEC,
        rewrites: [
          SPEC.rewrites[0]!,
          REFERENCE.replace("cost <= self.tokens", "cost < self.tokens"),
        ],
        mutants: [
          ...SPEC.mutants.slice(0, 3),
          {
            id: "harmless",
            description: "Renames the error message",
            find: '"capacity must be positive and rate non-negative"',
            replace: '"bad"',
          },
        ],
      },
      run,
      bin,
    );
    expect(errors.join("\n")).toMatch(/rewrites\[1\] is not equivalent/);
    expect(errors.join("\n")).toMatch(/Mutant harmless survives the oracle/);
  }, 60_000);

  it("grades a weak suite: passes the correct code, misses bugs, flags assert-free tests", async () => {
    const report = await runMutation(SPEC, { "tests/test_bucket.py": WEAK_TESTS }, run, bin);
    expect(report.tests).toBe(3);
    expect(report.reference.every((r) => r.passed)).toBe(true);
    expect(report.rewrites.every((r) => r.passed)).toBe(true);
    expect(report.assertFree).toEqual(["tests.test_bucket.T.test_runs"]);
    const survivors = report.mutants.filter((m) => !m.killed).map((m) => m.id);
    expect(survivors).toEqual(["no-cap", "backwards-clock", "zero-capacity"]);
    expect(report.killed).toBe(2);
    expect(report.passed).toBe(false);
    expect(report.problems).toEqual(["The tests caught 2 of 5 planted bugs; the bar is 80%."]);
  }, 60_000);

  it("fails a suite tied to the implementation, even when it kills everything", async () => {
    const tied = `${ORACLE.replace("if __name__", "class Tied(unittest.TestCase):\n    def test_internals(self):\n        self.assertEqual(Bucket(1, 1).last, 0.0)\n\n\nif __name__")}`;
    const report = await runMutation(SPEC, { "tests/test_tied.py": tied }, run, bin);
    expect(report.killed).toBe(5);
    expect(report.rewrites[1]!.passed).toBe(false);
    expect(report.problems[0]).toMatch(/fail on an equivalent rewrite/);
    expect(report.passed).toBe(false);
  }, 60_000);

  it("finds no tests in an empty suite", async () => {
    const report = await runMutation(SPEC, {}, run, bin);
    expect(report.problems[0]).toBe("No tests were found in tests/test_*.py.");
  }, 60_000);
});
