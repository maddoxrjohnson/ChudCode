/**
 * adapter.ts: the Python language adapter.
 *
 * Lays out `solution.py` plus the harness files, spawns `python3 -s -P harness.py`,
 * and reads the harness's JSON-lines protocol back. `-s` drops the user's
 * site-packages and `-P` keeps the working directory off `sys.path`, so a candidate's
 * solution sees only the standard library and the files in its workdir. The runner
 * builds the child's environment from scratch, so nothing from the user's shell
 * reaches it either.
 *
 * Not `-I`: isolated mode also ignores every `PYTHON*` variable, and the runner needs
 * `PYTHONHASHSEED=0` to hold. Without it, string hashing changes from process to
 * process, so a generator that walks a set of strings builds a different input on
 * every run than the one its expected output came from.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { pythonAdapterDir } from "../../../store/paths.ts";
import type {
  Command,
  HarnessLine,
  LanguageAdapter,
  RawCaseResult,
  Signature,
} from "../../types.ts";

/** Interpreter flags for every run; see the header for why these and not `-I`. */
export const PYTHON_FLAGS = ["-s", "-P"] as const;

const TYPING_NAMES = ["List", "Optional", "Dict", "Tuple", "Set"] as const;
const CHUD_TYPES = ["ListNode", "TreeNode"] as const;

export class PythonAdapter implements LanguageAdapter {
  readonly id = "python";
  readonly displayName = "Python 3";
  readonly sourceFileName = "solution.py";

  readonly pythonBin: string;

  private files: Array<{ name: string; contents: string }> | null = null;

  constructor(pythonBin: string = process.env["CHUDCODE_PYTHON"] ?? "python3") {
    this.pythonBin = pythonBin;
  }

  stub(signature: Signature): string {
    const mentioned = [signature.returns, ...signature.params.map((p) => p.type)].join(" ");
    const typing = TYPING_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(mentioned));
    const chud = CHUD_TYPES.filter((name) => new RegExp(`\\b${name}\\b`).test(mentioned));

    const imports: string[] = [];
    if (typing.length > 0) imports.push(`from typing import ${typing.join(", ")}`);
    if (chud.length > 0) imports.push(`from chud_types import ${chud.join(", ")}`);

    const params = signature.params.map((p) => `${p.name}: ${p.type}`);
    const lines: string[] = [];
    if (imports.length > 0) lines.push(...imports, "", "");
    if (signature.style === "method") {
      lines.push(
        "class Solution:",
        `    def ${signature.name}(${["self", ...params].join(", ")}) -> ${signature.returns}:`,
        "        pass",
      );
    } else {
      lines.push(
        `def ${signature.name}(${params.join(", ")}) -> ${signature.returns}:`,
        "    pass",
      );
    }
    return lines.join("\n") + "\n";
  }

  runCommand(): Command {
    return { cmd: this.pythonBin, args: [...PYTHON_FLAGS, "harness.py"] };
  }

  harnessFiles(): Array<{ name: string; contents: string }> {
    if (!this.files) {
      const dir = pythonAdapterDir();
      this.files = ["harness.py", "chud_types.py"].map((name) => ({
        name,
        contents: fs.readFileSync(path.join(dir, name), "utf8"),
      }));
    }
    return this.files;
  }

  parseLine(line: string): HarnessLine | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    switch (record["event"]) {
      case "case": {
        const result = record["result"];
        if (!result || typeof result !== "object") return null;
        return { event: "case", result: result as RawCaseResult };
      }
      case "done":
        return { event: "done", maxRssKb: Number(record["maxRssKb"]) || 0 };
      case "fatal": {
        const kind = record["kind"];
        if (kind !== "import-error" && kind !== "runtime-error" && kind !== "memory") return null;
        return { event: "fatal", kind, message: String(record["message"] ?? "") };
      }
      default:
        return null;
    }
  }
}

export const pythonAdapter = new PythonAdapter();

/** Whether the configured interpreter exists and is Python 3.11 or later, which `-P` needs. */
export function pythonAvailable(bin = pythonAdapter.pythonBin): boolean {
  try {
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5_000 });
    const minor = /Python 3\.(\d+)/.exec(probe.stdout + probe.stderr)?.[1];
    return probe.status === 0 && minor !== undefined && Number(minor) >= 11;
  } catch {
    return false;
  }
}
