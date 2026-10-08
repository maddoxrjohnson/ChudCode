/**
 * compare.ts: decide whether a candidate's output matches the expected output.
 *
 * Values arrive as JSON from the harness, so this works on plain data: numbers,
 * strings, booleans, null, arrays, and objects. Comparators live here, in
 * TypeScript, so every language adapter shares one definition of "correct".
 */

import type { CompareMode } from "./types.ts";

export const DEFAULT_TOLERANCE = 1e-6;

export interface CompareOptions {
  mode?: CompareMode;
  tolerance?: number;
}

/** True when `actual` matches `expected` under the chosen mode. */
export function compareOutputs(
  actual: unknown,
  expected: unknown,
  options: CompareOptions = {},
): boolean {
  const mode = options.mode ?? "exact";
  switch (mode) {
    case "exact":
      return canonical(actual) === canonical(expected);
    case "unordered":
      return Array.isArray(actual) && Array.isArray(expected) && multisetEqual(actual, expected);
    case "unordered-nested":
      return (
        Array.isArray(actual) &&
        Array.isArray(expected) &&
        multisetEqual(actual.map(sortIfArray), expected.map(sortIfArray))
      );
    case "float":
      return approxEqual(actual, expected, options.tolerance ?? DEFAULT_TOLERANCE);
    case "any-of":
      return Array.isArray(expected) && expected.some((option) => compareOutputs(actual, option));
    case "checker":
      throw new Error("checker comparisons are decided by the harness, not compareOutputs");
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown compare mode: ${String(exhaustive)}`);
    }
  }
}

/**
 * A stable string form: object keys sorted, so `{a:1,b:2}` and `{b:2,a:1}` agree.
 * `-0` is folded into `0` because Python's json module emits `-0.0` only for floats
 * and a candidate returning `0` should not fail on the sign of zero.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = normalise(record[key]);
    return out;
  }
  return value;
}

function sortIfArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return [...value].sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

function multisetEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const item of a) {
    const key = canonical(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const item of b) {
    const key = canonical(item);
    const left = counts.get(key);
    if (!left) return false;
    counts.set(key, left - 1);
  }
  return true;
}

function approxEqual(a: unknown, b: unknown, tolerance: number): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
    return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => approxEqual(item, b[i], tolerance));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const keys = Object.keys(ra).sort();
    if (canonical(keys) !== canonical(Object.keys(rb).sort())) return false;
    return keys.every((key) => approxEqual(ra[key], rb[key], tolerance));
  }
  return canonical(a) === canonical(b);
}
