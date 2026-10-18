/**
 * Problem validation: the shape lint, and the reference run with a real interpreter.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pythonAvailable } from "../src/runner/adapters/python/adapter.ts";
import type { Limits } from "../src/runner/types.ts";
import { DEFAULT_CONFIG } from "../src/store/config.ts";
import { readProblem, writeProblem, type ProblemBundle } from "../src/store/problems.ts";
import {
  isLargeCase,
  LARGE_INPUT_SIZE,
  lintBundle,
  MIN_HIDDEN_CASES,
  validateProblem,
} from "../src/validate.ts";
import { validationReportText } from "../src/prompts.ts";
import { makeFixture, seedExample, type Fixture } from "./helpers.ts";

let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
});
afterEach(() => fixture.cleanup());

const LIMITS: Limits = { ...DEFAULT_CONFIG.limits.validate, perCaseMs: 300, wallMs: 15_000 };

/** A copy of the example under a new slug, changed by `mutate`, written to disk. */
function variant(slug: string, mutate: (bundle: ProblemBundle) => void): ProblemBundle {
  const bundle = structuredClone(seedExample());
  bundle.meta.slug = slug;
  delete bundle.meta.validatedAt;
  delete bundle.meta.validation;
  mutate(bundle);
  return writeProblem(bundle);
}

const WRONG_REFERENCE = "def max_window_sum(nums, k):\n    return sum(nums[:k])\n";
const SLOW_REFERENCE = [
  "def max_window_sum(nums, k):",
  "    if k > len(nums):",
  "        return 0",
  "    return max(sum(nums[i:i + k]) for i in range(len(nums) - k + 1))",
  "",
].join("\n");

describe("lintBundle", () => {
  it("accepts the example", () => {
    expect(lintBundle(seedExample())).toEqual([]);
  });

  function lintOf(mutate: (bundle: ProblemBundle) => void): string {
    const bundle = structuredClone(seedExample());
    mutate(bundle);
    return lintBundle(bundle).join("\n");
  }

  it("wants enough visible and hidden cases and a max-size case", () => {
    expect(
      lintOf((b) => (b.tests = b.tests.filter((c) => c.id !== "ex1" && c.id !== "ex2"))),
    ).toMatch(/at least 2 visible cases \(found 1\)/);
    expect(lintOf((b) => (b.tests = b.tests.slice(0, 5)))).toMatch(
      new RegExp(`at least ${MIN_HIDDEN_CASES} hidden cases \\(found 2\\)`),
    );
    expect(lintOf((b) => (b.tests = b.tests.filter((c) => c.gen === undefined)))).toMatch(
      /at least one max-size case/,
    );
  });

  it("counts a literal input of a thousand elements as max-size", () => {
    expect(isLargeCase({ id: "g", visible: false, gen: "big()" })).toBe(true);
    expect(isLargeCase({ id: "s", visible: false, input: { nums: [1, 2, 3], k: 1 } })).toBe(false);
    expect(
      isLargeCase({
        id: "l",
        visible: false,
        input: { nums: Array.from({ length: LARGE_INPUT_SIZE }, (_, i) => i), k: 1 },
      }),
    ).toBe(true);
    expect(
      isLargeCase({
        id: "grid",
        visible: false,
        input: { grid: Array.from({ length: 40 }, () => Array.from({ length: 25 }, () => 0)) },
      }),
    ).toBe(true);
    expect(isLargeCase({ id: "str", visible: false, input: { s: "x".repeat(1_000) } })).toBe(true);
  });

  it("rejects duplicate inputs and duplicate hints", () => {
    expect(lintOf((b) => (b.tests[4]!.input = { ...b.tests[3]!.input! }))).toMatch(
      /cases empty and single have the same input/,
    );
    expect(lintOf((b) => (b.hints[1]!.text = b.hints[0]!.text))).toMatch(
      /hints must all be different/,
    );
  });

  it("wants a hint ladder of two to four", () => {
    expect(lintOf((b) => (b.hints = b.hints.slice(0, 1)))).toMatch(
      /between 2 and 4 hints \(found 1\)/,
    );
    expect(
      lintOf((b) => (b.hints = [1, 2, 3, 4, 5].map((level) => ({ level, text: `hint ${level}` })))),
    ).toMatch(/between 2 and 4 hints \(found 5\)/);
  });

  it("wants complexity bounds, a constraints section, and no source site", () => {
    expect(lintOf((b) => (b.meta.complexityTarget.time = "linear"))).toMatch(
      /complexityTarget\.time must be written as a bound/,
    );
    expect(
      lintOf((b) => (b.statement = b.statement.replace("## Constraints", "## Limits"))),
    ).toMatch(/"## Constraints" section/);
    expect(lintOf((b) => (b.statement += "\n\nSee https://leetcode.com/problems/x/"))).toMatch(
      /must not mention LeetCode/,
    );
  });

  it("wants a mimic to name what it follows", () => {
    expect(lintOf((b) => (b.meta.source = { kind: "mimic" }))).toMatch(/source\.mimicOf must name/);
    expect(lintOf((b) => (b.meta.source = { kind: "mimic", mimicOf: "Two Sum" }))).toBe("");
  });
});

describe.skipIf(!pythonAvailable())("validateProblem", () => {
  it("validates the bundled example and stamps its meta", async () => {
    const before = seedExample();
    expect(before.meta.validatedAt).toBeDefined();
    const report = await validateProblem("window-sum", LIMITS, 123_456);
    expect(report.passed).toBe(true);
    expect(report.lint).toEqual([]);
    expect(report.run).toMatchObject({ status: "ok", passed: 12, total: 12 });
    expect(report.filled).toEqual([]);
    expect(report.validatedAt).toBe(123_456);
    expect(readProblem("window-sum").meta).toMatchObject({
      validatedAt: 123_456,
      validation: { passed: 12, total: 12 },
    });
  });

  it("fails a planted wrong reference, names the cases, and clears a stale stamp", async () => {
    variant("window-sum-bad", (b) => {
      b.reference = WRONG_REFERENCE;
      b.meta.validatedAt = 1;
    });
    const report = await validateProblem("window-sum-bad", LIMITS);
    expect(report.passed).toBe(false);
    expect(report.lint).toEqual([]);
    expect(report.disagreements.map((d) => d.id)).toContain("ex1");
    expect(report.disagreements.find((d) => d.id === "ex1")).toEqual({
      id: "ex1",
      expected: 9,
      actual: 8,
    });
    expect(report.disagreements.map((d) => d.id)).not.toContain("ex2");
    expect(report.broken).toEqual([]);
    expect(readProblem("window-sum-bad").meta.validatedAt).toBeUndefined();

    // The same slug, fixed, passes.
    variant("window-sum-bad", () => undefined);
    const fixed = await validateProblem("window-sum-bad", LIMITS);
    expect(fixed.passed).toBe(true);
    expect(readProblem("window-sum-bad").meta.validatedAt).toBeDefined();
  });

  it("fails a reference that is too slow on the max-size case", async () => {
    variant("window-sum-slow", (b) => (b.reference = SLOW_REFERENCE));
    const report = await validateProblem("window-sum-slow", LIMITS);
    expect(report.passed).toBe(false);
    expect(report.disagreements).toEqual([]);
    expect(report.broken.map((c) => [c.id, c.status])).toEqual([["large-random", "timeout"]]);
  });

  it("fills oracle cases from the reference and writes them back only on a pass", async () => {
    variant("window-sum-oracle", (b) => {
      for (const c of b.tests)
        if (c.id === "best-at-end" || c.id === "large-random") delete c.expected;
      b.tests.push({
        id: "any",
        visible: false,
        input: { nums: [5, 5, 5, 5, 5, 1], k: 2 },
        compare: "any-of",
      });
    });
    const report = await validateProblem("window-sum-oracle", LIMITS);
    expect(report.passed).toBe(true);
    expect(report.filled).toEqual(["best-at-end", "large-random", "any"]);
    const tests = readProblem("window-sum-oracle").tests;
    expect(tests.find((c) => c.id === "best-at-end")?.expected).toBe(18);
    expect(tests.find((c) => c.id === "large-random")?.expected).toBe(2477188);
    expect(tests.find((c) => c.id === "any")?.expected).toEqual([10]);

    // A thin bundle runs clean but is not validated, and nothing is written back.
    variant("window-sum-thin", (b) => {
      b.tests = b.tests.filter((c) => c.visible || c.id === "large-random");
      delete b.tests.find((c) => c.id === "large-random")!.expected;
    });
    const thin = await validateProblem("window-sum-thin", LIMITS);
    expect(thin.passed).toBe(false);
    expect(thin.lint.join("\n")).toMatch(/hidden cases/);
    expect(thin.run.passed).toBe(thin.run.total);
    expect(thin.filled).toEqual(["large-random"]);
    expect(
      readProblem("window-sum-thin").tests.find((c) => c.id === "large-random"),
    ).not.toHaveProperty("expected");
    expect(readProblem("window-sum-thin").meta.validatedAt).toBeUndefined();
  });

  it("builds a generated input the same way on every run, even from a set's order", async () => {
    variant("window-sum-sets", (b) => {
      b.generators +=
        "\n\ndef from_set(n: int, k: int) -> dict:\n" +
        "    # The order of a set of strings follows the hash seed, so the input does too.\n" +
        '    return {"nums": [int(w[1:]) * (-1) ** int(w[1:]) for w in {f"w{i}" for i in range(n)}], "k": k}\n';
      b.tests.push({ id: "from-set", visible: false, gen: "from_set(3000, 7)" });
    });
    const report = await validateProblem("window-sum-sets", LIMITS);
    expect(report.filled).toEqual(["from-set"]);
    expect(report.unstable).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("fails a generator that builds a different input on a second run", async () => {
    variant("window-sum-noisy", (b) => {
      b.generators +=
        "\n\ndef noisy(n: int, k: int) -> dict:\n" +
        '    return {"nums": [random.randint(-100, 100) for _ in range(n)], "k": k}\n';
      b.tests.push({ id: "noisy", visible: false, gen: "noisy(3000, 7)" });
    });
    const report = await validateProblem("window-sum-noisy", LIMITS);
    expect(report.unstable).toEqual(["noisy"]);
    expect(report.passed).toBe(false);
    expect(readProblem("window-sum-noisy").meta.validatedAt).toBeUndefined();
    expect(validationReportText(report, readProblem("window-sum-noisy"))).toContain(
      "1 generated case built a different input on a second run (noisy)",
    );
  });
});
