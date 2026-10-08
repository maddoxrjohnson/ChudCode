/**
 * sanitize.ts: the view of a run result that is safe to send to the candidate.
 *
 * Visible cases are shown in full. Hidden cases show only their status and timing,
 * except that the first failing hidden case may reveal its input and outputs when the
 * problem allows it, the way LeetCode does. Hidden inputs built by a generator are
 * never revealed: they are large by design and describing them is the interviewer's
 * job.
 */

import type { CaseResult, CaseStatus, RunResult, RunStatus, TestCase } from "./types.ts";

export interface CandidateCaseView {
  id: string;
  label: string;
  visible: boolean;
  status: CaseStatus;
  timeMs: number;
  input?: Record<string, unknown>;
  expected?: unknown;
  actual?: unknown;
  stdout?: string;
  stderr?: string;
  message?: string;
  /** A hidden case whose details were revealed because it failed first. */
  revealed?: boolean;
}

export interface CandidateRunResult {
  status: RunStatus;
  passed: number;
  total: number;
  wallMs: number;
  truncated: boolean;
  /** Present for import errors and crashes, which are the candidate's own output. */
  stderrTail?: string;
  cases: CandidateCaseView[];
}

export interface SanitizeOptions {
  revealFailingInput: boolean;
}

export function sanitizeForCandidate(
  result: RunResult,
  cases: readonly TestCase[],
  options: SanitizeOptions,
): CandidateRunResult {
  const byId = new Map(cases.map((c) => [c.id, c]));
  let hiddenIndex = 0;
  let revealedOne = false;

  const views = result.cases.map((caseResult): CandidateCaseView => {
    const testCase = byId.get(caseResult.id);
    const visible = testCase?.visible ?? false;
    if (!visible) hiddenIndex += 1;
    const label =
      testCase?.label ?? (visible ? `Example ${caseResult.id}` : `Hidden ${hiddenIndex}`);

    const view: CandidateCaseView = {
      id: caseResult.id,
      label,
      visible,
      status: caseResult.status,
      timeMs: caseResult.timeMs,
    };

    if (visible) {
      fillDetails(view, caseResult, testCase);
      return view;
    }

    const failed = caseResult.status !== "pass" && caseResult.status !== "skipped";
    if (failed && caseResult.message !== undefined) view.message = caseResult.message;
    if (failed && !revealedOne && options.revealFailingInput && testCase?.gen === undefined) {
      revealedOne = true;
      view.revealed = true;
      fillDetails(view, caseResult, testCase);
    }
    return view;
  });

  const out: CandidateRunResult = {
    status: result.status,
    passed: result.passed,
    total: result.total,
    wallMs: result.wallMs,
    truncated: result.truncated,
    cases: views,
  };
  if (result.status !== "ok" && result.stderrTail) out.stderrTail = result.stderrTail;
  return out;
}

function fillDetails(
  view: CandidateCaseView,
  caseResult: CaseResult,
  testCase: TestCase | undefined,
): void {
  if (testCase?.input !== undefined) view.input = testCase.input;
  if (caseResult.expected !== undefined) view.expected = caseResult.expected;
  if (caseResult.actual !== undefined) view.actual = caseResult.actual;
  if (caseResult.stdout) view.stdout = caseResult.stdout;
  if (caseResult.stderr) view.stderr = caseResult.stderr;
  if (caseResult.message !== undefined) view.message = caseResult.message;
}
