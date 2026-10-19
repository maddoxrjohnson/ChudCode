/**
 * fact-checks.ts: when the interviewer last checked a curriculum fact against its source.
 *
 * Claude Code changes faster than a curriculum file, so before teaching a lesson the
 * interviewer re-reads the pages behind its facts. Each check is one line here. A fact
 * checked within the last two weeks is not checked again, which keeps lessons cheap.
 * A fact found changed is taught as the live page says, and stays flagged until the
 * curriculum file is updated.
 */

import type { Fact } from "../curriculum.ts";
import { DAY_MS } from "../review.ts";
import { appendJsonl, readJsonl } from "./json.ts";
import { factChecksFile } from "./paths.ts";

export const FACT_CHECK_STATUSES = ["confirmed", "changed", "unreachable"] as const;
export type FactCheckStatus = (typeof FACT_CHECK_STATUSES)[number];

/** A fact checked this recently is fresh. */
export const FACT_FRESH_DAYS = 14;

export interface FactCheck {
  lesson: string;
  fact: string;
  at: number;
  status: FactCheckStatus;
  /** What the page says now, when it changed or could not be read. */
  note?: string;
  url?: string;
}

export function appendFactCheck(check: FactCheck): void {
  appendJsonl(factChecksFile(), check);
}

export function readFactChecks(): FactCheck[] {
  return readJsonl<FactCheck>(factChecksFile());
}

/** The newest check of each fact, by fact id. */
export function latestChecks(checks: readonly FactCheck[] = readFactChecks()) {
  const latest = new Map<string, FactCheck>();
  for (const check of checks) {
    const before = latest.get(check.fact);
    if (!before || check.at >= before.at) latest.set(check.fact, check);
  }
  return latest;
}

export interface FactFreshness {
  fact: Fact;
  /** When it was last confirmed: the newest confirmed check, else the file's date. */
  confirmedAt: number;
  /** The newest check, when it found the fact changed or could not read the page. */
  problem?: FactCheck;
  stale: boolean;
}

/** How fresh each fact is. Stale facts are due a check before they are taught. */
export function factFreshness(
  facts: readonly Fact[],
  checks: readonly FactCheck[],
  now: number,
): FactFreshness[] {
  const latest = latestChecks(checks);
  return facts.map((fact) => {
    const confirmed = checks
      .filter((c) => c.fact === fact.id && c.status === "confirmed")
      .reduce((at, c) => Math.max(at, c.at), Date.parse(`${fact.verifiedAt}T00:00:00Z`));
    const newest = latest.get(fact.id);
    const problem = newest && newest.status !== "confirmed" ? newest : undefined;
    return {
      fact,
      confirmedAt: confirmed,
      ...(problem ? { problem } : {}),
      stale: problem !== undefined || now - confirmed > FACT_FRESH_DAYS * DAY_MS,
    };
  });
}
