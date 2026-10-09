#!/usr/bin/env node
/**
 * launch.mjs: the entry point Claude Code runs for the ChudCode MCP server.
 *
 * Claude Code copies the repository and runs this file, so before the TypeScript
 * server starts it checks that Node can run TypeScript directly (22.18 or later),
 * installs the runtime dependencies from the lockfile on first launch, and warns if
 * no Python interpreter is on the PATH. Every failure stops the server with a message
 * on stderr. stdout is the MCP transport, so nothing here may write to it.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.features.typescript) {
  throw new Error(
    `ChudCode needs Node 22.18 or later to run TypeScript without a build step. Found Node ${process.versions.node}.`,
  );
}

function hasRuntimeDependencies() {
  try {
    import.meta.resolve("marked");
    return true;
  } catch {
    return false;
  }
}

if (!hasRuntimeDependencies()) {
  console.error("[chudcode] Installing runtime dependencies in", root);
  const install = spawnSync(
    "npm",
    ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: root,
      stdio: ["ignore", 2, 2],
      shell: process.platform === "win32",
    },
  );
  if (install.error) throw install.error;
  if (install.status !== 0)
    throw new Error(`npm ci failed in ${root} with exit code ${install.status}.`);
}

const python = process.env.CHUDCODE_PYTHON ?? "python3";
const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.error(
    `[chudcode] Warning: "${python}" is not on the PATH. Running code will fail until Python 3 is installed or CHUDCODE_PYTHON points at it.`,
  );
}

await import("../src/mcp-stdio.ts");
