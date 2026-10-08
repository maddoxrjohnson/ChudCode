/**
 * Dev server: open the example problem in a browser with no agent attached.
 *
 *   node scripts/serve.ts [--new] [--no-open]
 *
 * State lives in <repo>/.chudcode unless CHUDCODE_DIR is set, so experiments never
 * touch your real sessions. `--new` starts a fresh session instead of resuming the
 * most recent unfinished one.
 */

import * as path from "node:path";

import { openUrl } from "../src/open-browser.ts";
import * as server from "../src/server/server.ts";
import { readConfig, shouldAutoOpen } from "../src/store/config.ts";
import { _overrideRootDir, packageRoot, rootDir } from "../src/store/paths.ts";
import { importExample } from "../src/store/problems.ts";
import { createSession, listSessions } from "../src/store/sessions.ts";

if (!process.env["CHUDCODE_DIR"]) _overrideRootDir(path.join(packageRoot(), ".chudcode"));

const args = new Set(process.argv.slice(2));
const config = readConfig();
const bundle = importExample("window-sum");

let session = args.has("--new") ? undefined : listSessions(10).find((s) => s.phase !== "done");
if (!session) {
  session = createSession({
    problem: bundle.meta.slug,
    problemTitle: bundle.meta.title,
    patterns: bundle.meta.patterns,
    difficulty: bundle.meta.difficulty,
    mode: "solo",
    timerMs: config.timerMinutes * 60_000,
  });
}

const base = await server.start();
const url = server.urlForSession(session.id) ?? base;

console.log(`ChudCode dev server
  session    ${url}
  dashboard  ${base}
  state      ${rootDir()}
Press Ctrl+C to stop.`);

if (!args.has("--no-open") && shouldAutoOpen(config)) openUrl(url);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
