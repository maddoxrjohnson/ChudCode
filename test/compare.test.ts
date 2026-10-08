/**
 * Output comparison: one definition of "correct" shared by every language adapter.
 */

import { describe, expect, it } from "vitest";

import { canonical, compareOutputs } from "../src/runner/compare.ts";

describe("exact", () => {
  it("compares nested data structurally", () => {
    expect(compareOutputs([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(compareOutputs([1, [2, 3]], [1, [3, 2]])).toBe(false);
    expect(compareOutputs({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(compareOutputs("1", 1)).toBe(false);
    expect(compareOutputs(null, null)).toBe(true);
  });

  it("treats negative zero as zero", () => {
    expect(compareOutputs(-0, 0)).toBe(true);
    expect(canonical([-0])).toBe("[0]");
  });
});

describe("unordered", () => {
  it("compares the top level as a multiset", () => {
    expect(compareOutputs([3, 1, 2], [1, 2, 3], { mode: "unordered" })).toBe(true);
    expect(compareOutputs([1, 1, 2], [1, 2, 2], { mode: "unordered" })).toBe(false);
    expect(compareOutputs([1, 2], [1, 2, 3], { mode: "unordered" })).toBe(false);
  });

  it("keeps inner order significant", () => {
    expect(compareOutputs([[1, 2]], [[2, 1]], { mode: "unordered" })).toBe(false);
  });

  it("rejects non-lists", () => {
    expect(compareOutputs("abc", "cba", { mode: "unordered" })).toBe(false);
  });
});

describe("unordered-nested", () => {
  it("ignores order inside and between groups", () => {
    const actual = [["eat", "tea"], ["bat"]];
    const expected = [["bat"], ["tea", "eat"]];
    expect(compareOutputs(actual, expected, { mode: "unordered-nested" })).toBe(true);
    expect(compareOutputs([["eat"], ["tea", "bat"]], expected, { mode: "unordered-nested" })).toBe(
      false,
    );
  });
});

describe("float", () => {
  it("allows a relative tolerance", () => {
    expect(compareOutputs(0.1 + 0.2, 0.3, { mode: "float" })).toBe(true);
    expect(compareOutputs(1000000.5, 1000000.4, { mode: "float", tolerance: 1e-9 })).toBe(false);
    expect(compareOutputs([1.0000001, 2], [1, 2], { mode: "float" })).toBe(true);
    expect(compareOutputs({ x: 1.0000001 }, { x: 1 }, { mode: "float" })).toBe(true);
  });

  it("still requires matching shape and non-numeric values", () => {
    expect(compareOutputs([1, 2], [1], { mode: "float" })).toBe(false);
    expect(compareOutputs(["a"], ["b"], { mode: "float" })).toBe(false);
    expect(compareOutputs(NaN, NaN, { mode: "float" })).toBe(true);
  });
});

describe("any-of", () => {
  it("passes when the output matches any acceptable answer", () => {
    expect(
      compareOutputs(
        [0, 1],
        [
          [0, 1],
          [1, 0],
        ],
        { mode: "any-of" },
      ),
    ).toBe(true);
    expect(
      compareOutputs(
        [2, 0],
        [
          [0, 1],
          [1, 0],
        ],
        { mode: "any-of" },
      ),
    ).toBe(false);
  });
});

describe("checker", () => {
  it("is not decided here", () => {
    expect(() => compareOutputs(1, 1, { mode: "checker" })).toThrow(/harness/);
  });
});
