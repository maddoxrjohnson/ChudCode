/**
 * Run a solution file against a problem from the command line.
 *
 *   node scripts/run.ts <slug> <solution.py> [--all]
 *
 * Runs the visible cases by default, every case with --all. Uses the same runner and
 * limits as the Submit button. Handy for iterating on the harness or a reference.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { runCode } from "../src/runs.ts";
import { readConfig } from "../src/store/config.ts";
import { _overrideRootDir, packageRoot } from "../src/store/paths.ts";
import { importExample, problemExists, readProblem } from "../src/store/problems.ts";

if (!process.env["CHUDCODE_DIR"]) _overrideRootDir(path.join(packageRoot(), ".chudcode"));

const [slug, file, ...flags] = process.argv.slice(2);
if (!slug || !file) {
  console.error("usage: node scripts/run.ts <slug> <solution.py> [--all]");
  process.exit(2);
}

const bundle = problemExists(slug) ? readProblem(slug) : importExample(slug);
const code = fs.readFileSync(file, "utf8");
const all = flags.includes("--all");
const config = readConfig();

const { result } = await runCode({
  bundle,
  code,
  scope: all ? "all" : "visible",
  limits: all ? config.limits.submit : config.limits.run,
  revealFailingInput: true,
});

for (const c of result.cases) {
  const detail =
    c.status === "pass"
      ? ""
      : (c.message ??
        (c.actual !== undefined
          ? `got ${JSON.stringify(c.actual)}, expected ${JSON.stringify(c.expected)}`
          : ""));
  console.log(
    `${c.status.padEnd(8)} ${c.id.padEnd(18)} ${String(c.timeMs).padStart(8)} ms  ${detail}`,
  );
}
console.log(`\n${result.status}: ${result.passed}/${result.total} passed in ${result.wallMs} ms`);
if (result.stderrTail) console.log(`\n${result.stderrTail}`);
process.exit(result.status === "ok" && result.passed === result.total ? 0 : 1);
