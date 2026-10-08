/**
 * runs.ts: run a candidate's code against a problem's cases and produce both the full
 * result (for the interviewer and the session record) and the candidate-safe view.
 */

import { pythonAdapter } from "./runner/adapters/python/adapter.ts";
import { processRunner } from "./runner/process-runner.ts";
import { sanitizeForCandidate, type CandidateRunResult } from "./runner/sanitize.ts";
import type { CaseResult, Limits, RunResult, TestCase } from "./runner/types.ts";
import type { ProblemBundle } from "./store/problems.ts";

export type RunScope = "visible" | "all" | { custom: Array<Record<string, unknown>> };

export interface RunOptions {
  bundle: ProblemBundle;
  code: string;
  scope: RunScope;
  limits: Limits;
  revealFailingInput: boolean;
  onCase?: (result: CaseResult, testCase: TestCase) => void;
}

export interface RunOutcome {
  cases: TestCase[];
  result: RunResult;
  candidate: CandidateRunResult;
}

export class InvalidCustomInput extends Error {}

export async function runCode(options: RunOptions): Promise<RunOutcome> {
  const { bundle } = options;
  const cases = selectCases(bundle, options.scope);
  const byId = new Map(cases.map((c) => [c.id, c]));

  const request: Parameters<typeof processRunner.run>[0] = {
    adapter: pythonAdapter,
    source: options.code,
    signature: bundle.meta.signature,
    cases,
    limits: options.limits,
  };
  const extraFiles: Record<string, string> = {};
  if (bundle.generators !== undefined) extraFiles["generators.py"] = bundle.generators;
  if (bundle.checker !== undefined) extraFiles["checker.py"] = bundle.checker;
  if (Object.keys(extraFiles).length > 0) request.extraFiles = extraFiles;
  if (options.onCase) {
    const onCase = options.onCase;
    request.onCase = (result) => {
      const testCase = byId.get(result.id);
      if (testCase) onCase(result, testCase);
    };
  }

  const result = await processRunner.run(request);
  const candidate = sanitizeForCandidate(result, cases, {
    revealFailingInput: options.revealFailingInput,
  });
  return { cases, result, candidate };
}

function selectCases(bundle: ProblemBundle, scope: RunScope): TestCase[] {
  if (scope === "all") return bundle.tests;
  if (scope === "visible") return bundle.tests.filter((c) => c.visible);

  const params = bundle.meta.signature.params.map((p) => p.name);
  if (scope.custom.length === 0 || scope.custom.length > 10) {
    throw new InvalidCustomInput("Provide between 1 and 10 custom inputs");
  }
  return scope.custom.map((input, i) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new InvalidCustomInput(`Custom input ${i + 1} must be an object of arguments by name`);
    }
    for (const key of Object.keys(input)) {
      if (!params.includes(key))
        throw new InvalidCustomInput(`Custom input ${i + 1} has an unknown argument: ${key}`);
    }
    for (const name of params) {
      if (!(name in input))
        throw new InvalidCustomInput(`Custom input ${i + 1} is missing argument ${name}`);
    }
    return { id: `custom-${i + 1}`, label: `Custom ${i + 1}`, visible: true, input };
  });
}
