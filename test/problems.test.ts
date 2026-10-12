/**
 * Problem bundles: schema validation, atomic writes, and the candidate-safe view.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ProblemValidationError,
  clearValidation,
  listProblems,
  publicView,
  readProblem,
  updateMeta,
  validateBundle,
  writeProblem,
  type ProblemBundle,
} from "../src/store/problems.ts";
import { makeFixture, seedExample, type Fixture } from "./helpers.ts";

let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
});
afterEach(() => fixture.cleanup());

function clone(bundle: ProblemBundle): ProblemBundle {
  return structuredClone(bundle);
}

describe("the example bundle", () => {
  it("imports, validates, and reads back", () => {
    const bundle = seedExample();
    expect(bundle.meta.slug).toBe("window-sum");
    expect(bundle.tests).toHaveLength(12);
    expect(bundle.tests.filter((c) => c.visible)).toHaveLength(3);
    expect(bundle.generators).toContain("def large");
    expect(readProblem("window-sum").meta.title).toBe(bundle.meta.title);
  });
});

describe("publicView", () => {
  it("never leaks the reference, hidden cases, unrevealed hints, or the target complexity", () => {
    const bundle = seedExample();
    const view = publicView(bundle, 1);
    const serialised = JSON.stringify(view);

    expect(view.visibleCases.map((c) => c.id)).toEqual(["ex1", "ex2", "ex3"]);
    expect(view.hiddenCaseCount).toBe(9);
    expect(view.hints).toHaveLength(1);
    expect(view.hintsTotal).toBe(3);
    expect(view.statementHtml).toContain("<h2>Problem</h2>");

    expect(serialised).not.toContain("window += nums[i]");
    expect(serialised).not.toContain("large-random");
    expect(serialised).not.toContain("2477188");
    expect(serialised).not.toContain(bundle.hints[2]?.text);
    expect(serialised).not.toContain("O(n)");
    expect(serialised).not.toContain("complexityTarget");
  });
});

describe("validateBundle", () => {
  function expectRejects(mutate: (bundle: ProblemBundle) => void, pattern: RegExp) {
    const bundle = clone(seedExample());
    mutate(bundle);
    try {
      validateBundle(bundle);
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemValidationError);
      expect((err as ProblemValidationError).problems.join("\n")).toMatch(pattern);
      return;
    }
    throw new Error("expected validation to fail");
  }

  it("accepts the example", () => {
    expect(() => validateBundle(seedExample())).not.toThrow();
  });

  it("rejects unknown patterns", () => {
    expectRejects((b) => (b.meta.patterns = ["dynamic-sliding"]), /unknown pattern id/);
  });

  it("rejects duplicate case ids", () => {
    expectRejects((b) => (b.tests[1]!.id = b.tests[0]!.id), /duplicate id/);
  });

  it("rejects arguments that are not in the signature", () => {
    expectRejects(
      (b) => (b.tests[0]!.input = { nums: [1], k: 1, extra: 2 }),
      /not in the signature: extra/,
    );
    expectRejects((b) => (b.tests[0]!.input = { nums: [1] }), /missing argument k/);
  });

  it("rejects gen cases without generators.py and visible gen cases", () => {
    expectRejects((b) => delete b.generators, /no generators.py/);
    expectRejects((b) => (b.tests[10]!.visible = true), /visible cases need literal input/);
  });

  it("rejects hint levels that are not 1-based and sequential", () => {
    expectRejects((b) => (b.hints[1]!.level = 5), /levels are 1-based and sequential/);
  });

  it("rejects a checker case without checker.py and a bad compare mode", () => {
    expectRejects((b) => (b.tests[3]!.compare = "checker"), /no checker.py/);
    expectRejects(
      (b) => ((b.tests[3] as { compare: string }).compare = "fuzzy"),
      /compare must be one of/,
    );
  });

  it("rejects a bad signature", () => {
    expectRejects((b) => (b.meta.signature.name = "max window"), /valid identifier/);
    expectRejects((b) => (b.meta.signature.params[0]!.name = "self"), /valid identifier/);
  });

  it("collects several problems at once", () => {
    const bundle = clone(seedExample());
    bundle.meta.title = "";
    bundle.reference = "";
    try {
      validateBundle(bundle);
    } catch (err) {
      expect((err as ProblemValidationError).problems).toHaveLength(2);
      return;
    }
    throw new Error("expected validation to fail");
  });
});

describe("writeProblem and listProblems", () => {
  it("round-trips a new bundle and replaces an existing one atomically", () => {
    const bundle = clone(seedExample());
    bundle.meta.slug = "window-sum-ii";
    bundle.meta.title = "Largest Window Sum II";
    bundle.meta.difficulty = "medium";
    writeProblem(bundle);
    expect(readProblem("window-sum-ii").meta.title).toBe("Largest Window Sum II");

    bundle.meta.title = "Renamed";
    delete bundle.generators;
    bundle.tests = bundle.tests.filter((c) => c.gen === undefined);
    writeProblem(bundle);
    const reread = readProblem("window-sum-ii");
    expect(reread.meta.title).toBe("Renamed");
    expect(reread.generators).toBeUndefined();
  });

  it("filters by pattern, difficulty, and validation state", () => {
    seedExample();
    const other = clone(seedExample());
    other.meta.slug = "two-pointer-thing";
    other.meta.patterns = ["two-pointers"];
    other.meta.difficulty = "hard";
    other.meta.validatedAt = 5;
    other.meta.createdAt = Date.now() + 1000;
    writeProblem(other);

    expect(listProblems().map((m) => m.slug)).toEqual(["two-pointer-thing", "window-sum"]);
    expect(listProblems({ pattern: "sliding-window" }).map((m) => m.slug)).toEqual(["window-sum"]);
    expect(listProblems({ difficulty: "hard" }).map((m) => m.slug)).toEqual(["two-pointer-thing"]);
    expect(listProblems({ validatedOnly: true }).map((m) => m.slug)).toEqual([
      "two-pointer-thing",
      "window-sum",
    ]);
    expect(listProblems({ difficulty: "easy", validatedOnly: true }).map((m) => m.slug)).toEqual([
      "window-sum",
    ]);
  });

  it("updates meta without touching the rest of the bundle", () => {
    seedExample();
    const meta = updateMeta("window-sum", {
      timesServed: 3,
      validatedAt: 42,
      validation: { passed: 12, total: 12 },
    });
    expect(meta.timesServed).toBe(3);
    expect(readProblem("window-sum").meta.validatedAt).toBe(42);
    expect(() => updateMeta("window-sum", { slug: "other" })).toThrow(/cannot change/);
    const cleared = clearValidation("window-sum");
    expect(cleared.validatedAt).toBeUndefined();
    expect(cleared.timesServed).toBe(3);
    expect(readProblem("window-sum").meta).not.toHaveProperty("validation");
  });
});
