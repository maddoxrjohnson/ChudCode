/**
 * refactor.ts: grade a refactor done the safe way, behaviour pinned before the change.
 *
 * The learner gets a working but tangled module in a git workspace. Their agent first
 * writes characterisation tests and commits them, then refactors and commits. Grading:
 *
 *   1. Order: a commit that adds tests comes before the first commit that touches
 *      the module. Tests written after the change pin whatever the change did.
 *   2. Characterisation: the learner's tests run against the original and the
 *      author's clean refactor (both must pass) and against mutants of the original
 *      (at least `CHARACTERISATION_THRESHOLD` killed), through the mutation engine.
 *   3. Behaviour: the author's hidden suite passes on the learner's module, and so do
 *      the learner's own tests.
 *   4. Interface: the module's public names and their parameters are unchanged.
 *   5. Shape: the longest function or the deepest nesting got smaller; a "refactor"
 *      that changes neither did not restructure anything.
 */

import { execFile } from "node:child_process";
import * as os from "node:os";

import {
  MUTATION_LIMITS,
  runMutation,
  specErrors,
  validateMutationSpec,
  type Mutant,
  type MutationReport,
  type SuiteRun,
} from "./mutation.ts";

export const CHARACTERISATION_THRESHOLD = 0.6;

export interface RefactorSpec {
  module: string;
  /** The tangled original the learner starts from. */
  legacy: string;
  /** The author's own refactor: same behaviour, better shape. Hidden. */
  clean: string;
  /** Bugs planted in the legacy module, for grading the characterisation tests. */
  mutants: Mutant[];
  /** The author's behaviour suite, hidden. */
  oracleTests: string;
}

// ── Shape and interface, read from the source ────────────────────────────────

export interface ShapeMetrics {
  lines: number;
  /** Lines in the longest top-level function or method. */
  longestFunction: number;
  /** Deepest indentation inside any function, in levels of four spaces. */
  maxNesting: number;
}

/** Rough but stable metrics from indentation; good enough to see a restructure. */
export function shapeMetrics(source: string): ShapeMetrics {
  const lines = source.split("\n");
  const code = lines.filter((l) => l.trim() && !l.trim().startsWith("#"));
  let longest = 0;
  let nesting = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:async\s+)?def\s/.exec(lines[i] as string);
    if (!match) continue;
    const indent = (match[1] as string).length;
    let length = 1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] as string;
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const lead = line.length - line.trimStart().length;
      if (lead <= indent) break;
      length++;
      nesting = Math.max(nesting, Math.floor((lead - indent) / 4));
    }
    longest = Math.max(longest, length);
  }
  return { lines: code.length, longestFunction: longest, maxNesting: nesting };
}

/** Top-level public functions and classes, with their parameter lists, as `name(params)`. */
export function publicApi(source: string): string[] {
  const out: string[] = [];
  const text = source.replace(/\r\n/g, "\n");
  const re = /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?/gm;
  for (const match of text.matchAll(re)) {
    const name = match[2] as string;
    if (name.startsWith("_")) continue;
    const params = (match[4] ?? "")
      .split(",")
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(", ");
    out.push(match[1] === "class" ? `class ${name}` : `${name}(${params})`);
  }
  return out.sort();
}

// ── Git order ─────────────────────────────────────────────────────────────────

export interface CommitFiles {
  hash: string;
  files: string[];
}

/** Commits oldest first, with the files each touched. Hardened like the lab's git. */
export function gitCommits(dir: string): Promise<CommitFiles[] | null> {
  const env = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const args = [
    "-C",
    dir,
    "-c",
    "core.fsmonitor=false",
    "--no-pager",
    "log",
    "--reverse",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "--format=@%H",
  ];
  return new Promise((resolve) => {
    execFile("git", args, { env, timeout: 5_000, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const commits: CommitFiles[] = [];
      for (const line of stdout.split("\n")) {
        if (line.startsWith("@")) commits.push({ hash: line.slice(1), files: [] });
        else if (line.trim()) commits.at(-1)?.files.push(line.trim());
      }
      resolve(commits);
    });
  });
}

/**
 * Did tests land before the module changed? The first commit is the drill's own
 * starting point and is skipped.
 */
export function testsFirst(
  commits: readonly CommitFiles[],
  module: string,
): {
  ok: boolean;
  problem?: string;
} {
  const work = commits.slice(1);
  const isTest = (f: string) => /^tests\/test[^/]*\.py$/.test(f);
  const testsAt = work.findIndex((c) => c.files.some(isTest));
  const moduleAt = work.findIndex((c) => c.files.includes(`${module}.py`));
  if (testsAt < 0)
    return { ok: false, problem: "No commit adds tests: commit the characterisation tests first." };
  if (moduleAt < 0)
    return {
      ok: false,
      problem: `No commit changes ${module}.py: commit the refactor after the tests.`,
    };
  if (moduleAt <= testsAt)
    return {
      ok: false,
      problem: `${module}.py changed in the same commit as the first tests, or before them: tests written with the change pin the change, not the original.`,
    };
  return { ok: true };
}

// ── Grading ───────────────────────────────────────────────────────────────────

export interface RefactorReport {
  order: { ok: boolean; problem?: string };
  /** The learner's tests against the original, the clean refactor, and mutants. */
  characterisation: MutationReport;
  /** The hidden suite on the learner's module. */
  behaviour: { passed: boolean; failing: string[] };
  /** The learner's own tests on their module. */
  ownTests: { passed: boolean; failing: string[] };
  api: { same: boolean; before: string[]; after: string[] };
  before: ShapeMetrics;
  after: ShapeMetrics;
  problems: string[];
  passed: boolean;
}

export async function gradeRefactor(
  spec: RefactorSpec,
  current: string,
  tests: Record<string, string>,
  commits: readonly CommitFiles[] | null,
  run: SuiteRun,
  pythonBin: string,
): Promise<RefactorReport> {
  const order = commits
    ? testsFirst(commits, spec.module)
    : { ok: false, problem: "The workspace is no longer a git repository." };
  const characterisation = await runMutation(
    {
      module: spec.module,
      reference: spec.legacy,
      rewrites: [spec.clean],
      mutants: spec.mutants,
      oracleTests: spec.oracleTests,
    },
    tests,
    run,
    pythonBin,
  );
  const suite = async (files: Record<string, string>) => {
    const result = await run({
      files: { [`${spec.module}.py`]: current, ...files },
      limits: MUTATION_LIMITS,
      pythonBin,
    });
    const failing = result.tests
      .filter((t) => t.status !== "pass" && t.status !== "skip")
      .map((t) => t.id);
    return {
      passed: result.status === "ok" && result.tests.length > 0 && failing.length === 0,
      failing,
    };
  };
  const behaviour = await suite({ "tests/test_hidden_behaviour.py": spec.oracleTests });
  const ownTests = await suite(tests);
  const before = shapeMetrics(spec.legacy);
  const after = shapeMetrics(current);
  const api = { before: publicApi(spec.legacy), after: publicApi(current), same: false };
  api.same = JSON.stringify(api.before) === JSON.stringify(api.after);

  const problems: string[] = [];
  if (!order.ok && order.problem) problems.push(order.problem);
  const killed = characterisation.killed / Math.max(1, characterisation.mutants.length);
  if (characterisation.tests === 0)
    problems.push("No characterisation tests were found in tests/test_*.py.");
  else {
    if (!characterisation.reference.every((r) => r.passed))
      problems.push(
        "The characterisation tests fail on the original module: they must describe what it does now.",
      );
    if (!characterisation.rewrites.every((r) => r.passed))
      problems.push(
        "The characterisation tests fail on a clean refactor of the original: they pin how it is written.",
      );
    if (killed < CHARACTERISATION_THRESHOLD)
      problems.push(
        `The characterisation tests caught ${characterisation.killed} of ${characterisation.mutants.length} planted bugs in the original; the bar is ${Math.round(CHARACTERISATION_THRESHOLD * 100)}%.`,
      );
  }
  if (!behaviour.passed)
    problems.push("The refactored module changes behaviour: a hidden behaviour test fails on it.");
  if (!ownTests.passed) problems.push("Your own tests fail on the refactored module.");
  if (!api.same) problems.push("The module's public functions or their parameters changed.");
  if (after.longestFunction >= before.longestFunction && after.maxNesting >= before.maxNesting)
    problems.push(
      "Neither the longest function nor the deepest nesting got smaller: the structure did not change.",
    );
  return {
    order,
    characterisation,
    behaviour,
    ownTests,
    api,
    before,
    after,
    problems,
    passed: problems.length === 0,
  };
}

/** Problems with a refactor spec's shape, before running anything. */
export function refactorSpecErrors(spec: RefactorSpec): string[] {
  const errors = specErrors(
    {
      module: spec.module,
      reference: spec.legacy,
      rewrites: [spec.clean],
      mutants: spec.mutants,
      oracleTests: spec.oracleTests,
    },
    1,
  );
  const before = shapeMetrics(spec.legacy);
  const after = shapeMetrics(spec.clean);
  if (after.longestFunction >= before.longestFunction && after.maxNesting >= before.maxNesting)
    errors.push(
      "clean_py must be better shaped than legacy_py: a shorter longest function or shallower nesting.",
    );
  if (JSON.stringify(publicApi(spec.legacy)) !== JSON.stringify(publicApi(spec.clean)))
    errors.push("clean_py must keep legacy_py's public functions and parameters.");
  if (before.longestFunction < 25)
    errors.push("legacy_py needs something worth refactoring: a function of 25 lines or more.");
  return errors;
}

/** Validation: the oracle passes on the legacy and clean modules and kills every mutant. */
export async function validateRefactorSpec(
  spec: RefactorSpec,
  run: SuiteRun,
  pythonBin: string,
): Promise<string[]> {
  const shape = refactorSpecErrors(spec);
  if (shape.length > 0) return shape;
  return (
    await validateMutationSpec(
      {
        module: spec.module,
        reference: spec.legacy,
        rewrites: [spec.clean],
        mutants: spec.mutants,
        oracleTests: spec.oracleTests,
      },
      run,
      pythonBin,
      1,
    )
  ).map((e) => e.replace("rewrites[0]", "clean_py").replace("the reference", "legacy_py"));
}
