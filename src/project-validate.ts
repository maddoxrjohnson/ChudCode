/**
 * project-validate.ts: prove a project bundle before it is served.
 *
 * Two real runs of the whole suite, visible and hidden tests together:
 *
 *   1. The starting repository. It must import and run (the bugs are wrong
 *      behaviour, not a project that cannot start), at least one visible test must
 *      fail so Run shows the candidate something, and every planted bug must have a
 *      named test that exists and fails.
 *   2. The repository with the reference fix. Every test must pass.
 *
 * The fix must not touch a read-only file, since the candidate cannot.
 */

import { PROJECT_RUN_LIMITS, type ProjectRunner } from "./project-flow.ts";
import type { SuiteResult } from "./runner/process-runner.ts";
import {
  fixedRepository,
  hiddenTestFiles,
  protectedPaths,
  startingRepository,
  type ProjectBundle,
} from "./store/projects.ts";

export interface BugCheck {
  id: string;
  /** Its tests that fail on the starting repository. */
  failing: string[];
  /** Its tests that pass on the starting repository: they do not show the bug. */
  passing: string[];
  /** Its tests that no run reported: misnamed, or never collected. */
  missing: string[];
  /** How many tests it lists. */
  tests: number;
}

export interface ProjectValidationReport {
  passed: boolean;
  problems: string[];
  start: { status: SuiteResult["status"]; failing: string[]; total: number; stderrTail: string };
  fixed: { status: SuiteResult["status"]; failing: string[]; total: number; stderrTail: string };
  bugs: BugCheck[];
  visibleFailing: number;
  hiddenFailing: number;
}

const failingOf = (suite: SuiteResult) =>
  suite.tests.filter((t) => t.status !== "pass" && t.status !== "skip").map((t) => t.id);

export async function validateProjectBundle(
  bundle: ProjectBundle,
  runner: ProjectRunner,
): Promise<ProjectValidationReport> {
  const problems: string[] = [];
  const locked = protectedPaths(bundle);
  for (const file of Object.keys(bundle.fix))
    if (locked.includes(file))
      problems.push(`fix changes ${file}, which is read-only for the candidate`);

  const pythonBin = await runner.python();
  const labels = ["tests", "hidden_tests"];
  const hidden = hiddenTestFiles(bundle);
  const start = await runner.run({
    files: { ...startingRepository(bundle), ...hidden },
    labels,
    limits: PROJECT_RUN_LIMITS,
    pythonBin,
  });
  const fixed = await runner.run({
    files: { ...fixedRepository(bundle), ...hidden },
    labels,
    limits: PROJECT_RUN_LIMITS,
    pythonBin,
  });

  const startFailing = failingOf(start);
  const fixedFailing = failingOf(fixed);
  if (start.status !== "ok")
    problems.push(
      `the starting repository did not run its tests (${start.status}); plant bugs in behaviour, not in imports:\n${start.stderrTail.slice(-1500)}`,
    );
  if (fixed.status !== "ok")
    problems.push(
      `the fixed repository did not run its tests (${fixed.status}):\n${fixed.stderrTail.slice(-1500)}`,
    );
  else if (fixedFailing.length > 0)
    problems.push(
      `with the fix applied, ${fixedFailing.length} ${fixedFailing.length === 1 ? "test fails" : "tests fail"}: ${fixedFailing.join(", ")}. ${
        fixed.tests
          .filter((t) => fixedFailing.includes(t.id))
          .slice(0, 2)
          .map((t) => `\n${t.id}:\n${t.message.slice(-800)}`)
          .join("") || ""
      }`,
    );

  const visibleFailing = startFailing.filter((id) => id.startsWith("tests.")).length;
  const hiddenFailing = startFailing.filter((id) => id.startsWith("hidden_tests.")).length;
  if (start.status === "ok" && visibleFailing === 0)
    problems.push(
      "no visible test fails on the starting repository; Run should show at least one red test",
    );

  const reported = new Set([...start.tests, ...fixed.tests].map((t) => t.id));
  const bugs: BugCheck[] = bundle.meta.bugs.map((bug) => {
    const ids = bug.tests.map((t) =>
      [...reported].find((id) => id.startsWith("hidden_tests.") && id.endsWith(`.${t}`)),
    );
    const missing = bug.tests.filter((_, i) => ids[i] === undefined);
    const found = ids.filter((id): id is string => id !== undefined);
    const failing = found.filter((id) => startFailing.includes(id));
    const passing = found.filter((id) => !startFailing.includes(id));
    return { id: bug.id, failing, passing, missing, tests: bug.tests.length };
  });
  for (const bug of bugs) {
    if (bug.missing.length)
      problems.push(`bug ${bug.id} names hidden tests that never ran: ${bug.missing.join(", ")}`);
    else if (start.status === "ok" && bug.failing.length < bug.tests)
      problems.push(
        `bug ${bug.id} lists tests that pass on the starting repository, so they prove nothing about it: ${bug.passing.join(", ")}`,
      );
  }

  return {
    passed: problems.length === 0,
    problems,
    start: {
      status: start.status,
      failing: startFailing,
      total: start.tests.length,
      stderrTail: start.stderrTail,
    },
    fixed: {
      status: fixed.status,
      failing: fixedFailing,
      total: fixed.tests.length,
      stderrTail: fixed.stderrTail,
    },
    bugs,
    visibleFailing,
    hiddenFailing,
  };
}
