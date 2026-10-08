/**
 * config.ts: optional learner settings in ~/.chudcode/config.json, merged over defaults.
 *
 * Every field is optional in the file. Unknown fields are ignored so a newer config
 * still loads in an older build; wrong types are errors so a typo does not silently
 * fall back to a default.
 */

import * as fs from "node:fs";

import type { Limits } from "../runner/types.ts";
import { configFile } from "./paths.ts";

export interface EditorConfig {
  /** Off by default: real interview pads rarely offer completion. */
  autocomplete: boolean;
}

export interface LimitsConfig {
  /** The Run button: visible and custom cases. */
  run: Limits;
  /** The Submit button: every case. */
  submit: Limits;
  /** validate_problem: the reference solution against every case. */
  validate: Limits;
}

export interface Config {
  /** 0 picks an ephemeral port. */
  port: number;
  autoOpen: boolean;
  timerMinutes: number;
  editor: EditorConfig;
  limits: LimitsConfig;
  /** Show the input of the first failing hidden case after a submit. */
  revealFailingInput: boolean;
  /** Override the Leitner intervals, e.g. to compress review before an exam. */
  reviewIntervalsDays?: number[];
}

export const DEFAULT_LIMITS: Limits = {
  wallMs: 10_000,
  cpuSeconds: 5,
  memoryMb: 512,
  outputKb: 64,
  fileSizeKb: 1024,
  perCaseMs: 2_000,
};

export const DEFAULT_CONFIG: Config = {
  port: 0,
  autoOpen: true,
  timerMinutes: 35,
  editor: { autocomplete: false },
  limits: {
    run: { ...DEFAULT_LIMITS },
    submit: { ...DEFAULT_LIMITS, wallMs: 20_000 },
    // A reference solution should be fast; a slow one is a problem-authoring bug.
    validate: { ...DEFAULT_LIMITS, wallMs: 30_000, perCaseMs: 1_000 },
  },
  revealFailingInput: true,
};

export function readConfig(file = configFile()): Config {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw new Error(`Cannot read config ${file}`, { cause: err });
  }
  try {
    return mergeConfig(JSON.parse(source));
  } catch (err) {
    throw new Error(`Invalid config ${file}: ${(err as Error).message}`, { cause: err });
  }
}

/** Validate a parsed config object and merge it over the defaults. */
export function mergeConfig(parsed: unknown): Config {
  const input = expectObject(parsed, "config");
  const config = structuredClone(DEFAULT_CONFIG);

  if (input["port"] !== undefined) config.port = expectInteger(input["port"], "port", 0, 65535);
  if (input["autoOpen"] !== undefined)
    config.autoOpen = expectBoolean(input["autoOpen"], "autoOpen");
  if (input["timerMinutes"] !== undefined) {
    config.timerMinutes = expectInteger(input["timerMinutes"], "timerMinutes", 1, 240);
  }
  if (input["revealFailingInput"] !== undefined) {
    config.revealFailingInput = expectBoolean(input["revealFailingInput"], "revealFailingInput");
  }
  if (input["editor"] !== undefined) {
    const editor = expectObject(input["editor"], "editor");
    if (editor["autocomplete"] !== undefined) {
      config.editor.autocomplete = expectBoolean(editor["autocomplete"], "editor.autocomplete");
    }
  }
  if (input["limits"] !== undefined) {
    const limits = expectObject(input["limits"], "limits");
    for (const scope of ["run", "submit", "validate"] as const) {
      if (limits[scope] !== undefined) {
        config.limits[scope] = mergeLimits(limits[scope], `limits.${scope}`, config.limits[scope]);
      }
    }
  }
  if (input["reviewIntervalsDays"] !== undefined) {
    const list = input["reviewIntervalsDays"];
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.some((d) => typeof d !== "number" || !(d > 0))
    ) {
      throw new Error("reviewIntervalsDays must be a non-empty list of positive numbers.");
    }
    config.reviewIntervalsDays = [...(list as number[])];
  }
  return config;
}

function mergeLimits(value: unknown, label: string, base: Limits): Limits {
  const input = expectObject(value, label);
  const out = { ...base };
  for (const key of Object.keys(base) as Array<keyof Limits>) {
    if (input[key] !== undefined) out[key] = expectInteger(input[key], `${label}.${key}`, 1);
  }
  return out;
}

/** The environment setting wins so a host can suppress browser launches. */
export function shouldAutoOpen(config: Config): boolean {
  if (process.env["CHUDCODE_AUTO_OPEN"] === "0") return false;
  return config.autoOpen;
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function expectInteger(
  value: unknown,
  label: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}
