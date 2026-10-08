/**
 * Id validation and the traversal guard that every route and tool argument uses.
 */

import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isValidSessionId,
  isValidSlug,
  problemDir,
  safeJoin,
  sessionDir,
  slugify,
} from "../src/store/paths.ts";

describe("slugs", () => {
  it("accepts lowercase kebab-case up to 64 characters", () => {
    expect(isValidSlug("two-sum")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
    expect(isValidSlug("x".repeat(64))).toBe(true);
  });

  it("rejects anything that could be a path or a surprise", () => {
    for (const bad of [
      "",
      "Two-Sum",
      "two_sum",
      "-two",
      "two-",
      "two--sum",
      "../x",
      "a/b",
      "x".repeat(65),
      7,
    ]) {
      expect(isValidSlug(bad)).toBe(false);
    }
  });

  it("slugifies arbitrary titles", () => {
    expect(slugify("Longest Substring Without Repeating Characters")).toBe(
      "longest-substring-without-repeating-characters",
    );
    expect(slugify("  Café -- Déjà Vu!! ")).toBe("cafe-deja-vu");
    expect(slugify("!!!")).toBe("problem");
    expect(slugify("!!!", "x")).toBe("x");
    expect(slugify("a".repeat(100)).length).toBe(64);
  });
});

describe("session ids", () => {
  it("accepts the generated shape", () => {
    expect(isValidSessionId("20261008-0930-window-sum-a1f3")).toBe(true);
  });

  it("rejects other shapes", () => {
    expect(isValidSessionId("20261008-0930-window-sum")).toBe(false);
    expect(isValidSessionId("20261008-0930-Window-Sum-a1f3")).toBe(false);
    expect(isValidSessionId("../20261008-0930-window-sum-a1f3")).toBe(false);
    expect(isValidSessionId(42)).toBe(false);
  });
});

describe("directory helpers", () => {
  it("refuse invalid ids before touching a path", () => {
    expect(() => problemDir("../etc")).toThrow(/Invalid slug/);
    expect(() => sessionDir("nope")).toThrow(/Invalid session id/);
    expect(problemDir("two-sum").endsWith(path.join("problems", "two-sum"))).toBe(true);
  });
});

describe("safeJoin", () => {
  const root = path.resolve("/srv/assets");

  it("resolves paths inside the root", () => {
    expect(safeJoin(root, "runtime/app.css")).toBe(path.join(root, "runtime", "app.css"));
    expect(safeJoin(root, "")).toBe(root);
    expect(safeJoin(root, "./a/../b")).toBe(path.join(root, "b"));
  });

  it("returns null for anything that escapes", () => {
    expect(safeJoin(root, "../secret")).toBeNull();
    expect(safeJoin(root, "/etc/passwd")).toBeNull();
    expect(safeJoin(root, "a/../../x")).toBeNull();
    expect(safeJoin(root, "a\0b")).toBeNull();
  });

  it("does not treat a sibling with the same prefix as inside", () => {
    expect(safeJoin(root, "../assets-other/x")).toBeNull();
  });
});
