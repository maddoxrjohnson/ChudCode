/**
 * Validate a problem bundle from the command line.
 *
 *   node scripts/validate.ts <slug>
 *
 * Runs the same lint and reference check as the validate_problem tool, against the
 * problem in CHUDCODE_DIR (or the repo's .chudcode/), importing a bundled example of
 * that name first if needed. Exits 0 when the problem is validated. This is how a
 * hand-written bundle under problems/examples earns the validatedAt in its meta.json.
 */

import * as path from "node:path";

import { validationReportText } from "../src/prompts.ts";
import { readConfig } from "../src/store/config.ts";
import { _overrideRootDir, packageRoot } from "../src/store/paths.ts";
import { importExample, problemExists, readProblem } from "../src/store/problems.ts";
import { validateProblem } from "../src/validate.ts";

if (!process.env["CHUDCODE_DIR"]) _overrideRootDir(path.join(packageRoot(), ".chudcode"));

const [slug] = process.argv.slice(2);
if (!slug) {
  console.error("usage: node scripts/validate.ts <slug>");
  process.exit(2);
}

if (!problemExists(slug)) importExample(slug);
const report = await validateProblem(slug, readConfig().limits.validate);
console.log(validationReportText(report, readProblem(slug)));
process.exit(report.passed ? 0 : 1);
