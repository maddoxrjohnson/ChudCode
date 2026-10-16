/**
 * json.ts: small file helpers shared by the stores.
 *
 * Writes go to a sibling temp file and are renamed into place, so a crash mid-write
 * never leaves a half-written JSON file for the next read to choke on.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { isMissing } from "./paths.ts";

export function readJson<T>(file: string): T | null {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  try {
    return JSON.parse(source) as T;
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`, { cause: err });
  }
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** `mode` applies to the new file; pass 0o600 for anything holding a secret. */
export function writeJson(file: string, value: unknown, mode?: number): void {
  writeText(file, JSON.stringify(value, null, 2) + "\n", mode);
}

export function writeText(file: string, contents: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  fs.renameSync(tmp, file);
}

export function appendJsonl(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
}

export function readJsonl<T>(file: string): T[] {
  const source = readText(file);
  if (source === null) return [];
  const out: T[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (err) {
      throw new Error(`Invalid JSON on line ${index + 1} of ${file}`, { cause: err });
    }
  }
  return out;
}
