/**
 * workspace.ts: the folder a drill's learner works in with their own agent.
 *
 *   ~/chudcode-drills/<session id>/
 *     README.md       the brief, and how to run the tests
 *     <module>.py     the module under test, as the exercise wrote it
 *     tests/          empty: the learner's agent writes test_*.py here
 *
 * It lives outside ~/.chudcode so that nothing an agent explores from here leads to
 * the exercise's hidden variants. Grading reads only `tests/*.py` back, as text, and
 * never follows a link.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { MutationSpec } from "./mutation.ts";
import { workspaceDir, workspacesDir } from "../store/paths.ts";
import { FACT_REF } from "../validate-exercise.ts";

export const TEST_LIMITS = { files: 30, fileBytes: 100 * 1024, totalBytes: 300 * 1024 };

export function workspaceReadme(brief: string, spec: MutationSpec): string {
  return [
    brief.replace(FACT_REF, "").trim(),
    "",
    "## Running the tests",
    "",
    `The module is \`${spec.module}.py\`. Put unittest files in \`tests/\`, named \`test_*.py\`, importing from \`${spec.module}\`. Standard library only.`,
    "",
    "```sh",
    "python3 -m unittest discover tests",
    "```",
    "",
    "Press **Grade my tests** on the lesson page when you are ready. Only `tests/*.py` is read back.",
    "",
  ].join("\n");
}

/** Lay out a fresh workspace and make it a git repository, so the learner can diff. */
export async function createWorkspace(
  id: string,
  brief: string,
  spec: MutationSpec,
): Promise<string> {
  const dir = workspaceDir(id);
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), workspaceReadme(brief, spec));
  fs.writeFileSync(path.join(dir, `${spec.module}.py`), spec.reference);
  fs.writeFileSync(path.join(dir, "tests", "__init__.py"), "");
  await gitInit(dir);
  return dir;
}

const GIT_ENV = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: "0",
};

function git(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", args, { env: GIT_ENV, timeout: 5_000 }, (err) => resolve(!err));
  });
}

function gitInit(dir: string): Promise<boolean> {
  // A missing git only costs a mutation drill `git diff`; a refactor drill needs it.
  return git(["init", "-q", dir]);
}

export function refactorReadme(brief: string, module: string): string {
  return [
    brief.replace(FACT_REF, "").trim(),
    "",
    "## How this drill is graded",
    "",
    `1. Pin what \`${module}.py\` does now with characterisation tests in \`tests/test_*.py\` (unittest, standard library only), and **commit them**.`,
    `2. Refactor \`${module}.py\`, keeping its public functions and their parameters, and commit again.`,
    "",
    "Grade checks that the tests were committed before the module changed, that they catch bugs planted in the original, that hidden behaviour tests still pass, that the public interface is the same, and that the structure got simpler.",
    "",
    "```sh",
    "python3 -m unittest discover tests",
    "```",
    "",
  ].join("\n");
}

/** A refactor drill's workspace: the legacy module, committed, so history shows the order. */
export async function createRefactorWorkspace(
  id: string,
  brief: string,
  module: string,
  legacy: string,
): Promise<string> {
  const dir = workspaceDir(id);
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), refactorReadme(brief, module));
  fs.writeFileSync(path.join(dir, `${module}.py`), legacy);
  fs.writeFileSync(path.join(dir, "tests", "__init__.py"), "");
  if (!(await gitInit(dir)))
    throw new WorkspaceError("A refactor drill needs git, and git is not installed.");
  const identity = ["-c", "user.name=ChudCode", "-c", "user.email=drills@chudcode.invalid"];
  await git(["-C", dir, "add", "-A"]);
  await git(["-C", dir, ...identity, "commit", "-q", "-m", "Start the drill"]);
  return dir;
}

/** Make `dir` a git repository holding one commit, so the learner can diff. Best effort. */
export async function commitWorkspace(dir: string, message: string): Promise<boolean> {
  if (!(await gitInit(dir))) return false;
  const identity = ["-c", "user.name=ChudCode", "-c", "user.email=drills@chudcode.invalid"];
  await git(["-C", dir, "add", "-A"]);
  return git(["-C", dir, ...identity, "commit", "-q", "-m", message]);
}

/** The module file the learner changed, read back as text; never through a link. */
export function readWorkspaceModule(dir: string, module: string): string {
  const file = path.join(dir, `${module}.py`);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new WorkspaceError(`${module}.py is gone from the workspace.`);
  }
  if (!stat.isFile()) throw new WorkspaceError(`${module}.py must be a regular file.`);
  if (stat.size > TEST_LIMITS.fileBytes)
    throw new WorkspaceError(`${module}.py is over ${TEST_LIMITS.fileBytes / 1024} KB.`);
  return fs.readFileSync(file, "utf8");
}

export class WorkspaceError extends Error {}

/**
 * The learner's test files, as `tests/<name>.py` to contents. Only regular files
 * directly in `tests/`, within the size caps; a link is never followed.
 */
export function readWorkspaceTests(dir: string): Record<string, string> {
  let root: string;
  let real: string;
  try {
    root = fs.realpathSync(workspacesDir());
    real = fs.realpathSync(dir);
  } catch {
    throw new WorkspaceError(`The workspace ${dir} is gone.`);
  }
  if (!real.startsWith(root + path.sep)) throw new WorkspaceError("The workspace has moved.");
  const testsDir = path.join(real, "tests");
  if (!fs.existsSync(testsDir)) throw new WorkspaceError("The workspace has no tests/ folder.");
  const out: Record<string, string> = {};
  let total = 0;
  for (const entry of fs
    .readdirSync(testsDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/^[A-Za-z0-9_]+\.py$/.test(entry.name)) continue;
    if (Object.keys(out).length >= TEST_LIMITS.files)
      throw new WorkspaceError(`tests/ holds more than ${TEST_LIMITS.files} Python files.`);
    const file = path.join(testsDir, entry.name);
    const size = fs.statSync(file).size;
    if (size > TEST_LIMITS.fileBytes)
      throw new WorkspaceError(`tests/${entry.name} is over ${TEST_LIMITS.fileBytes / 1024} KB.`);
    total += size;
    if (total > TEST_LIMITS.totalBytes)
      throw new WorkspaceError(`tests/ is over ${TEST_LIMITS.totalBytes / 1024} KB in all.`);
    out[`tests/${entry.name}`] = fs.readFileSync(file, "utf8");
  }
  if (!Object.keys(out).some((name) => /^tests\/test[^/]*\.py$/.test(name)))
    throw new WorkspaceError("There are no tests/test_*.py files yet.");
  return out;
}
