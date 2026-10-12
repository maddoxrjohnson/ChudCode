/**
 * problems.ts: problem bundles on disk, their schema, and the candidate-safe view.
 *
 *   problems/<slug>/
 *     meta.json       title, patterns, difficulty, signature, source, validation state
 *     statement.md    Problem / Examples / Constraints / Follow-up
 *     tests.json      { cases: TestCase[] } with visible and hidden cases
 *     reference.py    the author's solution, run during validation
 *     hints.json      { levels: [{ level, text }] }
 *     generators.py?  functions that build large inputs for `gen` cases
 *     checker.py?     `check(input, actual, expected) -> bool` for multi-answer problems
 *
 * `publicView` is the only path by which problem data reaches a browser route. It
 * never includes the reference, hidden cases, unrevealed hints, or the complexity
 * target.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { renderMarkdown } from "../markdown.ts";
import type { CompareMode, Signature, TestCase } from "../runner/types.ts";
import { readJson, readText, writeJson, writeText } from "./json.ts";
import { dataDir, examplesDir, isDir, isValidSlug, problemDir, problemsDir } from "./paths.ts";

export type Difficulty = "easy" | "medium" | "hard";
export const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

export interface Hint {
  level: number;
  text: string;
}

export interface ProblemSource {
  kind: "generated" | "mimic" | "review" | "hand";
  /** For mimic problems: the title of the real problem whose shape this follows. */
  mimicOf?: string;
  trendIds?: string[];
}

export interface ComplexityTarget {
  time: string;
  space: string;
}

export interface ProblemMeta {
  slug: string;
  title: string;
  patterns: string[];
  difficulty: Difficulty;
  language: "python";
  signature: Signature;
  complexityTarget: ComplexityTarget;
  source: ProblemSource;
  createdAt: number;
  validatedAt?: number;
  validation?: { passed: number; total: number };
  timesServed: number;
  lastServedAt?: number;
  revealFailingInput?: boolean;
}

export interface ProblemBundle {
  meta: ProblemMeta;
  statement: string;
  tests: TestCase[];
  reference: string;
  hints: Hint[];
  generators?: string;
  checker?: string;
}

export class ProblemValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid problem bundle:\n- ${problems.join("\n- ")}`);
    this.name = "ProblemValidationError";
    this.problems = problems;
  }
}

// ── Pattern taxonomy ──────────────────────────────────────────────────────────

export interface PatternInfo {
  id: string;
  name: string;
  blurb: string;
  typicalComplexity: string;
}

let patternCache: PatternInfo[] | null = null;

export function patterns(): PatternInfo[] {
  if (!patternCache) {
    const file = path.join(dataDir(), "patterns.json");
    const parsed = readJson<{ patterns: PatternInfo[] }>(file);
    if (!parsed) throw new Error(`Missing pattern taxonomy: ${file}`);
    patternCache = parsed.patterns;
  }
  return patternCache;
}

export function patternById(id: string): PatternInfo | undefined {
  return patterns().find((p) => p.id === id);
}

// ── Reading and listing ───────────────────────────────────────────────────────

export function problemExists(slug: string): boolean {
  return isValidSlug(slug) && isDir(problemDir(slug));
}

export function readProblem(slug: string): ProblemBundle {
  const dir = problemDir(slug);
  if (!isDir(dir)) throw new Error(`No problem named ${slug}`);
  const meta = readJson<unknown>(path.join(dir, "meta.json"));
  const tests = readJson<{ cases?: unknown }>(path.join(dir, "tests.json"));
  const hints = readJson<{ levels?: unknown }>(path.join(dir, "hints.json"));
  const bundle = validateBundle({
    meta,
    statement: readText(path.join(dir, "statement.md")),
    tests: tests?.cases,
    reference: readText(path.join(dir, "reference.py")),
    hints: hints?.levels ?? [],
    generators: readText(path.join(dir, "generators.py")) ?? undefined,
    checker: readText(path.join(dir, "checker.py")) ?? undefined,
  });
  if (bundle.meta.slug !== slug) {
    throw new Error(`Problem directory ${slug} holds meta for ${bundle.meta.slug}`);
  }
  return bundle;
}

export interface ProblemFilter {
  pattern?: string;
  difficulty?: Difficulty;
  validatedOnly?: boolean;
}

export function listProblems(filter: ProblemFilter = {}): ProblemMeta[] {
  const root = problemsDir();
  if (!isDir(root)) return [];
  const out: ProblemMeta[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
    const meta = readJson<unknown>(path.join(root, entry.name, "meta.json"));
    if (!meta) continue;
    let parsed: ProblemMeta;
    try {
      parsed = validateMeta(meta, []);
    } catch {
      continue;
    }
    if (filter.pattern && !parsed.patterns.includes(filter.pattern)) continue;
    if (filter.difficulty && parsed.difficulty !== filter.difficulty) continue;
    if (filter.validatedOnly && parsed.validatedAt === undefined) continue;
    out.push(parsed);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

// ── Writing ───────────────────────────────────────────────────────────────────

/**
 * Write a whole bundle. The files land in a temporary sibling directory first and
 * are swapped in at the end, so a reader never sees a half-written problem.
 */
export function writeProblem(input: ProblemBundle): ProblemBundle {
  const bundle = validateBundle(input);
  const target = problemDir(bundle.meta.slug);
  fs.mkdirSync(problemsDir(), { recursive: true });
  const staging = fs.mkdtempSync(path.join(problemsDir(), `.staging-${bundle.meta.slug}-`));
  try {
    writeJson(path.join(staging, "meta.json"), bundle.meta);
    writeText(path.join(staging, "statement.md"), bundle.statement);
    writeJson(path.join(staging, "tests.json"), { cases: bundle.tests });
    writeText(path.join(staging, "reference.py"), bundle.reference);
    writeJson(path.join(staging, "hints.json"), { levels: bundle.hints });
    if (bundle.generators !== undefined)
      writeText(path.join(staging, "generators.py"), bundle.generators);
    if (bundle.checker !== undefined) writeText(path.join(staging, "checker.py"), bundle.checker);

    if (isDir(target)) {
      const retired = `${target}.replaced-${Date.now()}`;
      fs.renameSync(target, retired);
      fs.renameSync(staging, target);
      fs.rmSync(retired, { recursive: true, force: true });
    } else {
      fs.renameSync(staging, target);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return bundle;
}

export function updateMeta(slug: string, patch: Partial<ProblemMeta>): ProblemMeta {
  const dir = problemDir(slug);
  const current = readJson<unknown>(path.join(dir, "meta.json"));
  if (!current) throw new Error(`No problem named ${slug}`);
  const merged = validateMeta({ ...(current as object), ...patch }, []);
  if (merged.slug !== slug) throw new Error("A problem's slug cannot change");
  writeJson(path.join(dir, "meta.json"), merged);
  return merged;
}

/** Forget a validation result, because the bundle changed or failed a re-check. */
export function clearValidation(slug: string): ProblemMeta {
  const dir = problemDir(slug);
  const current = readJson<Record<string, unknown>>(path.join(dir, "meta.json"));
  if (!current) throw new Error(`No problem named ${slug}`);
  delete current["validatedAt"];
  delete current["validation"];
  const meta = validateMeta(current, []);
  writeJson(path.join(dir, "meta.json"), meta);
  return meta;
}

/** Overwrite tests.json after validation filled in oracle outputs. */
export function writeTests(slug: string, cases: TestCase[]): void {
  writeJson(path.join(problemDir(slug), "tests.json"), { cases });
}

/**
 * Import every bundled example that is not already present. A fresh install has no
 * problems until the agent authors one, so this gives the first session something
 * to serve. Returns the slugs it imported.
 */
export function importAllExamples(): string[] {
  const source = examplesDir();
  if (!isDir(source)) return [];
  const imported: string[] = [];
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSlug(entry.name) || problemExists(entry.name)) continue;
    importExample(entry.name);
    imported.push(entry.name);
  }
  return imported;
}

/** Copy a bundled example into the learner's problems directory if it is not there. */
export function importExample(slug: string): ProblemBundle {
  if (problemExists(slug)) return readProblem(slug);
  const source = path.join(examplesDir(), slug);
  if (!isDir(source)) throw new Error(`No example problem named ${slug}`);
  fs.mkdirSync(problemsDir(), { recursive: true });
  fs.cpSync(source, problemDir(slug), { recursive: true });
  return readProblem(slug);
}

// ── Candidate view ────────────────────────────────────────────────────────────

export interface PublicCase {
  id: string;
  label?: string;
  input: Record<string, unknown>;
  expected?: unknown;
}

export interface PublicProblem {
  slug: string;
  title: string;
  patterns: string[];
  difficulty: Difficulty;
  language: "python";
  statementHtml: string;
  signature: Signature;
  visibleCases: PublicCase[];
  hiddenCaseCount: number;
  hints: Hint[];
  hintsTotal: number;
}

/** Everything a candidate may see, with hints only up to `revealedLevels`. */
export function publicView(bundle: ProblemBundle, revealedLevels = 0): PublicProblem {
  const visibleCases: PublicCase[] = [];
  for (const testCase of bundle.tests) {
    if (!testCase.visible || testCase.input === undefined) continue;
    const view: PublicCase = { id: testCase.id, input: testCase.input };
    if (testCase.label !== undefined) view.label = testCase.label;
    if ("expected" in testCase) view.expected = testCase.expected;
    visibleCases.push(view);
  }
  return {
    slug: bundle.meta.slug,
    title: bundle.meta.title,
    patterns: bundle.meta.patterns,
    difficulty: bundle.meta.difficulty,
    language: bundle.meta.language,
    statementHtml: renderMarkdown(bundle.statement),
    signature: bundle.meta.signature,
    visibleCases,
    hiddenCaseCount: bundle.tests.length - visibleCases.length,
    hints: bundle.hints.filter((h) => h.level <= revealedLevels),
    hintsTotal: bundle.hints.length,
  };
}

// ── Schema ────────────────────────────────────────────────────────────────────

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMPARE_MODES: readonly CompareMode[] = [
  "exact",
  "unordered",
  "unordered-nested",
  "float",
  "any-of",
  "checker",
];

/** Validate a bundle shaped object from disk or from a tool call. */
export function validateBundle(input: unknown): ProblemBundle {
  const problems: string[] = [];
  const record = asRecord(input, "bundle", problems) ?? {};

  const meta = validateMeta(record["meta"], problems);
  const statement = nonEmptyString(record["statement"], "statement", problems);
  const reference = nonEmptyString(record["reference"], "reference", problems);
  const tests = validateTests(record["tests"], meta?.signature, problems);
  const hints = validateHints(record["hints"], problems);
  const generators = optionalString(record["generators"], "generators", problems);
  const checker = optionalString(record["checker"], "checker", problems);

  if (tests && tests.some((c) => c.gen !== undefined) && generators === undefined) {
    problems.push("a test case uses `gen` but the bundle has no generators.py");
  }
  if (tests && tests.some((c) => c.compare === "checker") && checker === undefined) {
    problems.push("a test case uses compare `checker` but the bundle has no checker.py");
  }

  if (problems.length > 0 || !meta || !statement || !reference || !tests || !hints) {
    throw new ProblemValidationError(
      problems.length > 0 ? problems : ["unknown validation failure"],
    );
  }
  const bundle: ProblemBundle = { meta, statement, tests, reference, hints };
  if (generators !== undefined) bundle.generators = generators;
  if (checker !== undefined) bundle.checker = checker;
  return bundle;
}

export function validateMeta(input: unknown, problems: string[]): ProblemMeta {
  const own: string[] = [];
  const record = asRecord(input, "meta", own) ?? {};

  const slug = record["slug"];
  if (!isValidSlug(slug)) own.push("meta.slug must be lowercase kebab-case, at most 64 characters");
  const title = nonEmptyString(record["title"], "meta.title", own);
  if (title && title.length > 120) own.push("meta.title must be at most 120 characters");

  const patternIds = record["patterns"];
  if (!Array.isArray(patternIds) || patternIds.length === 0) {
    own.push("meta.patterns must be a non-empty list of pattern ids");
  } else {
    for (const id of patternIds) {
      if (typeof id !== "string" || !patternById(id)) {
        own.push(`meta.patterns contains an unknown pattern id: ${JSON.stringify(id)}`);
      }
    }
  }

  const difficulty = record["difficulty"];
  if (!DIFFICULTIES.includes(difficulty as Difficulty)) {
    own.push(`meta.difficulty must be one of ${DIFFICULTIES.join(", ")}`);
  }
  if (record["language"] !== undefined && record["language"] !== "python") {
    own.push('meta.language must be "python"');
  }

  const signature = validateSignature(record["signature"], own);
  const complexity = asRecord(record["complexityTarget"], "meta.complexityTarget", own) ?? {};
  const time = nonEmptyString(complexity["time"], "meta.complexityTarget.time", own);
  const space = nonEmptyString(complexity["space"], "meta.complexityTarget.space", own);

  const source = asRecord(record["source"], "meta.source", own) ?? {};
  const kind = source["kind"];
  if (!["generated", "mimic", "review", "hand"].includes(kind as string)) {
    own.push("meta.source.kind must be generated, mimic, review, or hand");
  }
  const mimicOf = optionalString(source["mimicOf"], "meta.source.mimicOf", own);
  const trendIds = source["trendIds"];
  if (
    trendIds !== undefined &&
    (!Array.isArray(trendIds) || trendIds.some((t) => typeof t !== "string"))
  ) {
    own.push("meta.source.trendIds must be a list of strings");
  }

  const createdAt = record["createdAt"] === undefined ? Date.now() : record["createdAt"];
  if (typeof createdAt !== "number") own.push("meta.createdAt must be a number");
  for (const key of ["validatedAt", "lastServedAt", "timesServed"]) {
    if (record[key] !== undefined && typeof record[key] !== "number")
      own.push(`meta.${key} must be a number`);
  }
  if (
    record["revealFailingInput"] !== undefined &&
    typeof record["revealFailingInput"] !== "boolean"
  ) {
    own.push("meta.revealFailingInput must be a boolean");
  }
  const validation = record["validation"];
  if (
    validation !== undefined &&
    (typeof (validation as { passed?: unknown }).passed !== "number" ||
      typeof (validation as { total?: unknown }).total !== "number")
  ) {
    own.push("meta.validation must have numeric passed and total");
  }

  problems.push(...own);
  if (own.length > 0 || !title || !signature || !time || !space) {
    if (problems === own) throw new ProblemValidationError(own);
    // The caller collects problems and throws once; return a placeholder it will discard.
    return undefined as unknown as ProblemMeta;
  }

  const meta: ProblemMeta = {
    slug: slug as string,
    title,
    patterns: [...(patternIds as string[])],
    difficulty: difficulty as Difficulty,
    language: "python",
    signature,
    complexityTarget: { time, space },
    source: { kind: kind as ProblemSource["kind"] },
    createdAt: createdAt as number,
    timesServed: typeof record["timesServed"] === "number" ? record["timesServed"] : 0,
  };
  if (mimicOf !== undefined) meta.source.mimicOf = mimicOf;
  if (trendIds !== undefined) meta.source.trendIds = [...(trendIds as string[])];
  if (typeof record["validatedAt"] === "number") meta.validatedAt = record["validatedAt"];
  if (validation !== undefined) meta.validation = validation as { passed: number; total: number };
  if (typeof record["lastServedAt"] === "number") meta.lastServedAt = record["lastServedAt"];
  if (typeof record["revealFailingInput"] === "boolean")
    meta.revealFailingInput = record["revealFailingInput"];
  return meta;
}

function validateSignature(input: unknown, problems: string[]): Signature | undefined {
  const record = asRecord(input, "meta.signature", problems);
  if (!record) return undefined;
  const before = problems.length;
  const style = record["style"];
  if (style !== "function" && style !== "method") {
    problems.push('meta.signature.style must be "function" or "method"');
  }
  const name = record["name"];
  if (typeof name !== "string" || !IDENTIFIER_RE.test(name)) {
    problems.push("meta.signature.name must be a valid identifier");
  }
  const returns = nonEmptyString(record["returns"], "meta.signature.returns", problems);
  const params = record["params"];
  const parsedParams: Signature["params"] = [];
  if (!Array.isArray(params)) {
    problems.push("meta.signature.params must be a list");
  } else {
    const seen = new Set<string>();
    for (const [i, param] of params.entries()) {
      const p = asRecord(param, `meta.signature.params[${i}]`, problems);
      if (!p) continue;
      const pname = p["name"];
      const ptype = p["type"];
      if (typeof pname !== "string" || !IDENTIFIER_RE.test(pname) || pname === "self") {
        problems.push(`meta.signature.params[${i}].name must be a valid identifier`);
        continue;
      }
      if (seen.has(pname)) problems.push(`meta.signature.params has a duplicate name: ${pname}`);
      seen.add(pname);
      if (typeof ptype !== "string" || ptype.trim() === "") {
        problems.push(`meta.signature.params[${i}].type must be a non-empty string`);
        continue;
      }
      parsedParams.push({ name: pname, type: ptype });
    }
  }
  if (problems.length > before || !returns) return undefined;
  return {
    style: style as Signature["style"],
    name: name as string,
    params: parsedParams,
    returns,
  };
}

function validateTests(
  input: unknown,
  signature: Signature | undefined,
  problems: string[],
): TestCase[] | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    problems.push("tests must be a non-empty list of cases");
    return undefined;
  }
  const before = problems.length;
  const ids = new Set<string>();
  const paramNames = new Set(signature?.params.map((p) => p.name) ?? []);
  const cases: TestCase[] = [];
  for (const [i, raw] of input.entries()) {
    const record = asRecord(raw, `tests[${i}]`, problems);
    if (!record) continue;
    const id = record["id"];
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      problems.push(`tests[${i}].id must be 1-32 letters, digits, - or _`);
      continue;
    }
    if (ids.has(id)) problems.push(`tests has a duplicate id: ${id}`);
    ids.add(id);
    if (typeof record["visible"] !== "boolean")
      problems.push(`tests[${i}].visible must be a boolean`);

    const testCase: TestCase = { id, visible: record["visible"] === true };
    const inputValue = record["input"];
    const gen = record["gen"];
    if (gen !== undefined) {
      if (typeof gen !== "string" || gen.trim() === "")
        problems.push(`tests[${i}].gen must be a non-empty string`);
      else testCase.gen = gen;
      if (testCase.visible)
        problems.push(
          `tests[${i}] is visible but uses a generator; visible cases need literal input`,
        );
    } else if (!inputValue || typeof inputValue !== "object" || Array.isArray(inputValue)) {
      problems.push(`tests[${i}].input must be an object of arguments by name (or set gen)`);
    } else {
      const inputRecord = inputValue as Record<string, unknown>;
      if (signature) {
        for (const key of Object.keys(inputRecord)) {
          if (!paramNames.has(key))
            problems.push(`tests[${i}].input has an argument not in the signature: ${key}`);
        }
        for (const name of paramNames) {
          if (!(name in inputRecord))
            problems.push(`tests[${i}].input is missing argument ${name}`);
        }
      }
      testCase.input = inputRecord;
    }
    if ("expected" in record) testCase.expected = record["expected"];
    const label = optionalString(record["label"], `tests[${i}].label`, problems);
    if (label !== undefined) testCase.label = label;
    const compare = record["compare"];
    if (compare !== undefined) {
      if (!COMPARE_MODES.includes(compare as CompareMode)) {
        problems.push(`tests[${i}].compare must be one of ${COMPARE_MODES.join(", ")}`);
      } else {
        testCase.compare = compare as CompareMode;
      }
    }
    if (record["tolerance"] !== undefined) {
      if (typeof record["tolerance"] !== "number" || !(record["tolerance"] >= 0)) {
        problems.push(`tests[${i}].tolerance must be a non-negative number`);
      } else {
        testCase.tolerance = record["tolerance"];
      }
    }
    const outputFrom = record["outputFrom"];
    if (outputFrom !== undefined) {
      if (typeof outputFrom !== "string" || (signature && !paramNames.has(outputFrom))) {
        problems.push(`tests[${i}].outputFrom must name a parameter of the signature`);
      } else {
        testCase.outputFrom = outputFrom;
      }
    }
    if (
      testCase.compare === "any-of" &&
      "expected" in testCase &&
      !Array.isArray(testCase.expected)
    ) {
      problems.push(`tests[${i}] uses any-of so expected must be a list of acceptable outputs`);
    }
    cases.push(testCase);
  }
  return problems.length > before ? undefined : cases;
}

function validateHints(input: unknown, problems: string[]): Hint[] | undefined {
  if (!Array.isArray(input)) {
    problems.push("hints must be a list of { level, text }");
    return undefined;
  }
  const before = problems.length;
  const hints: Hint[] = [];
  for (const [i, raw] of input.entries()) {
    const record = asRecord(raw, `hints[${i}]`, problems);
    if (!record) continue;
    const text = nonEmptyString(record["text"], `hints[${i}].text`, problems);
    if (record["level"] !== i + 1)
      problems.push(`hints[${i}].level must be ${i + 1}: levels are 1-based and sequential`);
    if (text) hints.push({ level: i + 1, text });
  }
  return problems.length > before ? undefined : hints;
}

function asRecord(
  value: unknown,
  label: string,
  problems: string[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${label} must be an object`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string, problems: string[]): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${label} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function optionalString(value: unknown, label: string, problems: string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    problems.push(`${label} must be a string`);
    return undefined;
  }
  return value;
}
