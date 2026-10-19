/**
 * mutation.ts: grade a learner's tests by the bugs they catch, not by what they say.
 *
 * The drill hands the learner a working module and an empty `tests/`. Their agent
 * writes the tests. Grading runs that suite against:
 *
 *   1. the reference, twice: every test must pass both times, or the suite is wrong
 *      or flaky about correct code;
 *   2. equivalent rewrites the learner never sees: every test must still pass, or the
 *      suite is tied to how the code is written rather than what it does (this also
 *      defeats a suite that recognises the reference by its source);
 *   3. each mutant, the reference with one plausible bug: a mutant is killed when any
 *      test fails, errors, or times out, or the suite cannot finish.
 *
 * The gate: steps 1 and 2 hold, no test file trips the static checks, and at least
 * `KILL_THRESHOLD` of the mutants are killed. Validation runs the exercise author's
 * own oracle suite through the same steps, which proves every mutant is killable and
 * that nothing hangs, before a learner ever sees the exercise.
 */

import type { SuiteRequest, SuiteResult } from "../runner/process-runner.ts";
import type { Limits } from "../runner/types.ts";

export const KILL_THRESHOLD = 0.8;

export const MUTATION_LIMITS: Limits = {
  wallMs: 20_000,
  cpuSeconds: 10,
  memoryMb: 512,
  outputKb: 32,
  fileSizeKb: 256,
  perCaseMs: 2_000,
};

export const MUTANTS_MIN = 4;
export const MUTANTS_MAX = 15;
export const REWRITES_MIN = 2;

/** One plausible bug: `find` occurs exactly once in the reference and becomes `replace`. */
export interface Mutant {
  id: string;
  /** What the bug is, for the debrief. Never shown before it. */
  description: string;
  find: string;
  replace: string;
}

export interface MutationSpec {
  /** The module under test, without `.py`: the learner's tests import it. */
  module: string;
  reference: string;
  /** Equivalent implementations with the same public behaviour. Hidden. */
  rewrites: string[];
  mutants: Mutant[];
  /** The exercise author's own tests, which must kill every mutant. Hidden. */
  oracleTests: string;
}

export type SuiteRun = (request: SuiteRequest) => Promise<SuiteResult>;

export function applyMutant(reference: string, mutant: Mutant): string {
  const first = reference.indexOf(mutant.find);
  if (first < 0 || reference.indexOf(mutant.find, first + 1) >= 0)
    throw new Error(`mutant ${mutant.id}: find must occur exactly once in the reference`);
  return reference.slice(0, first) + mutant.replace + reference.slice(first + mutant.find.length);
}

/** Problems with a spec's shape that need no Python to find. */
export function specErrors(spec: MutationSpec, minRewrites = REWRITES_MIN): string[] {
  const errors: string[] = [];
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(spec.module))
    errors.push("module_name must be a lowercase Python module name, like ledger or rate_limit");
  if (["tests", "test", "unittest", "suite_harness"].includes(spec.module))
    errors.push(`module_name ${spec.module} would shadow the test runner`);
  if (spec.rewrites.length < minRewrites)
    errors.push(`rewrites needs at least ${minRewrites} equivalent implementations`);
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  for (const [i, rewrite] of spec.rewrites.entries()) {
    if (norm(rewrite) === norm(spec.reference))
      errors.push(`rewrites[${i}] is the reference; rewrite it differently`);
  }
  if (spec.mutants.length < MUTANTS_MIN || spec.mutants.length > MUTANTS_MAX)
    errors.push(`mutants needs ${MUTANTS_MIN} to ${MUTANTS_MAX} entries`);
  const ids = new Set<string>();
  for (const mutant of spec.mutants) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mutant.id))
      errors.push(`mutant id ${mutant.id} must be kebab-case`);
    if (ids.has(mutant.id)) errors.push(`mutant id ${mutant.id} is repeated`);
    ids.add(mutant.id);
    if (mutant.find === mutant.replace) errors.push(`mutant ${mutant.id} changes nothing`);
    try {
      applyMutant(spec.reference, mutant);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (!/\bimport unittest\b|\bfrom unittest\b/.test(spec.oracleTests))
    errors.push("oracle_tests must be a unittest module");
  return errors;
}

// ── Static checks on the learner's tests ──────────────────────────────────────

export interface TestFlag {
  file: string;
  /** hard: the suite fails the gate. soft: noted for the interviewer. */
  severity: "hard" | "soft";
  message: string;
}

/** Strings a test has no business mentioning: where the hidden variants live. */
const FORBIDDEN = [".chudcode", "private.json"];

/**
 * What the learner's test files reveal without running them: references to hidden
 * files, and a copy of the implementation pasted in to compare against.
 */
export function scanTestFiles(files: Record<string, string>, reference: string): TestFlag[] {
  const flags: TestFlag[] = [];
  const referenceLines = reference
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) => l.length >= 16 && !l.startsWith("#") && !/^(def|class|return|import|from)\b/.test(l),
    );
  for (const [file, source] of Object.entries(files)) {
    for (const word of FORBIDDEN) {
      if (source.includes(word))
        flags.push({
          file,
          severity: "hard",
          message: `mentions "${word}", where the hidden variants live; tests may only use the module's public behaviour`,
        });
    }
    if (referenceLines.length >= 4) {
      const lines = new Set(source.split("\n").map((l) => l.trim()));
      const copied = referenceLines.filter((l) => lines.has(l)).length;
      if (copied / referenceLines.length >= 0.5)
        flags.push({
          file,
          severity: "hard",
          message: `contains ${copied} of the module's ${referenceLines.length} lines: comparing against a copy of the code tests nothing`,
        });
    }
    if (/inspect\.getsource|__code__|co_code/.test(source))
      flags.push({
        file,
        severity: "soft",
        message: "reads the module's source or bytecode, which ties the test to how it is written",
      });
  }
  return flags;
}

// ── Running a suite against every variant ─────────────────────────────────────

export interface VariantOutcome {
  /** Every test passed and the suite finished. */
  passed: boolean;
  failing: Array<{ id: string; status: string; message: string }>;
  status: SuiteResult["status"];
}

export interface MutationReport {
  /** Tests discovered on the reference. */
  tests: number;
  /** Test functions that assert nothing. */
  assertFree: string[];
  reference: VariantOutcome[];
  rewrites: VariantOutcome[];
  mutants: Array<{ id: string; description: string; killed: boolean; by: string[] }>;
  killed: number;
  flags: TestFlag[];
  /** Why the gate failed, in order; empty when it passed. */
  problems: string[];
  passed: boolean;
}

function outcome(result: SuiteResult): VariantOutcome {
  const failing = result.tests
    .filter((t) => t.status !== "pass" && t.status !== "skip")
    .map((t) => ({ id: t.id, status: t.status, message: t.message.slice(-600) }));
  return {
    passed: result.status === "ok" && failing.length === 0 && result.tests.length > 0,
    failing,
    status: result.status,
  };
}

/**
 * Run `tests` (relative path to source, under `tests/`) against the reference, the
 * rewrites, and every mutant. Used for the learner's suite and for the author's oracle.
 */
export async function runMutation(
  spec: MutationSpec,
  tests: Record<string, string>,
  run: SuiteRun,
  pythonBin: string,
): Promise<MutationReport> {
  const suite = (module: string) =>
    run({
      files: { [`${spec.module}.py`]: module, ...tests },
      limits: MUTATION_LIMITS,
      pythonBin,
    });

  const first = await suite(spec.reference);
  const reference = [outcome(first), outcome(await suite(spec.reference))];
  const rewrites: VariantOutcome[] = [];
  for (const rewrite of spec.rewrites) rewrites.push(outcome(await suite(rewrite)));
  const mutants: MutationReport["mutants"] = [];
  for (const mutant of spec.mutants) {
    const result = outcome(await suite(applyMutant(spec.reference, mutant)));
    mutants.push({
      id: mutant.id,
      description: mutant.description,
      killed: !result.passed,
      by: result.failing.map((f) => f.id).slice(0, 5),
    });
  }

  const flags = scanTestFiles(tests, spec.reference);
  const assertFree = first.scan.filter((t) => t.asserts === 0).map((t) => t.id);
  const killed = mutants.filter((m) => m.killed).length;
  const problems: string[] = [];
  if (first.tests.length === 0) problems.push("No tests were found in tests/test_*.py.");
  else if (!reference.every((r) => r.passed))
    problems.push("Some tests fail on the correct code, or pass only some of the time.");
  if (first.tests.length > 0 && !rewrites.every((r) => r.passed))
    problems.push(
      "Some tests fail on an equivalent rewrite of the module: they test how it is written, not what it does.",
    );
  for (const flag of flags.filter((f) => f.severity === "hard"))
    problems.push(`${flag.file} ${flag.message}.`);
  if (mutants.length > 0 && killed / mutants.length < KILL_THRESHOLD)
    problems.push(
      `The tests caught ${killed} of ${mutants.length} planted bugs; the bar is ${Math.round(KILL_THRESHOLD * 100)}%.`,
    );
  return {
    tests: first.tests.length,
    assertFree,
    reference,
    rewrites,
    mutants,
    killed,
    flags,
    problems,
    passed: problems.length === 0,
  };
}

/** Validation: the author's oracle must pass every correct variant and kill every mutant. */
export async function validateMutationSpec(
  spec: MutationSpec,
  run: SuiteRun,
  pythonBin: string,
  minRewrites = REWRITES_MIN,
): Promise<string[]> {
  const shape = specErrors(spec, minRewrites);
  if (shape.length > 0) return shape;
  const report = await runMutation(
    spec,
    { "tests/test_oracle.py": spec.oracleTests },
    run,
    pythonBin,
  );
  const errors: string[] = [];
  if (report.tests === 0) errors.push("oracle_tests has no tests the runner can discover.");
  report.reference.forEach((r, i) => {
    if (!r.passed)
      errors.push(
        `The oracle fails on the reference (run ${i + 1}): ${describeFailing(r)}. Fix the reference or the oracle.`,
      );
  });
  report.rewrites.forEach((r, i) => {
    if (!r.passed)
      errors.push(
        `rewrites[${i}] is not equivalent: the oracle fails on it: ${describeFailing(r)}.`,
      );
  });
  for (const mutant of report.mutants) {
    if (!mutant.killed)
      errors.push(
        `Mutant ${mutant.id} survives the oracle: either it is not a bug, or the oracle misses it. Strengthen the oracle or drop the mutant.`,
      );
  }
  return errors;
}

function describeFailing(outcome: VariantOutcome): string {
  if (outcome.status !== "ok") return `the suite did not finish (${outcome.status})`;
  if (outcome.failing.length === 0) return "no tests ran";
  return outcome.failing
    .slice(0, 3)
    .map(
      (f) =>
        `${f.id.split(".").pop()} ${f.status}: ${f.message.split("\n").filter(Boolean).pop() ?? ""}`,
    )
    .join("; ");
}
