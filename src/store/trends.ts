/**
 * trends.ts: what companies have been asking in interviews, as the agent found it.
 *
 *   trends.json   { "entries": [TrendEntry, ...] }
 *
 * One entry per pattern per company per source post: which pattern the problem
 * drilled, the company and role, when the interview happened, where the post is, and a
 * paraphrase of the problem's shape. The interviewer reads these before authoring a
 * problem for a company the user named, and a problem shaped by an entry cites it in
 * `meta.source.trendIds`.
 *
 * The shape note is the only free text. It is capped and may not hold a link, so the
 * store can carry the pattern and the constraints of a problem but never its
 * statement. Ids are a hash of (pattern, company, source), so recording the same post
 * twice is a no-op and a problem's citation survives the file being rebuilt.
 */

import { createHash } from "node:crypto";

import { readJson, writeJson } from "./json.ts";
import { trendsFile } from "./paths.ts";
import { DIFFICULTIES, patternById, type Difficulty } from "./problems.ts";

export interface TrendEntry {
  /** `t-` and ten hex digits derived from the pattern, company, and source. */
  id: string;
  /** A pattern id from data/patterns.json. */
  pattern: string;
  company: string;
  /** The role the post was about, when it says: "new grad SWE", "L4 backend". */
  role?: string;
  difficulty?: Difficulty;
  /** When the interview happened, as the post gives it: YYYY-MM-DD. */
  seenAt: string;
  /** The post the entry comes from, normalised. */
  sourceUrl: string;
  /** The pattern and the constraints in a sentence or two. Never the statement. */
  shapeNote: string;
  recordedAt: number;
}

/** What a caller supplies. The store derives the id and the timestamp. */
export type TrendInput = Omit<TrendEntry, "id" | "recordedAt">;

export const MAX_SHAPE_NOTE = 280;
export const MAX_COMPANY = 80;
export const MAX_ROLE = 80;
export const MAX_SOURCE_URL = 500;
/** No interview post predates this; anything earlier is a typo. */
export const EARLIEST_SEEN_AT = "2000-01-01";

const ID_RE = /^t-[0-9a-f]{10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LINK_RE = /https?:\/\/|www\./i;
const DAY_MS = 24 * 60 * 60 * 1000;

export class TrendValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid trend entries:\n- ${problems.join("\n- ")}`);
    this.name = "TrendValidationError";
    this.problems = problems;
  }
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** Every entry on file, in the order they were recorded. A malformed file is an error. */
export function readTrends(): TrendEntry[] {
  const file = trendsFile();
  const parsed = readJson<{ entries?: unknown }>(file);
  if (!parsed) return [];
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`${file} must hold { "entries": [...] }`);
  }
  const problems: string[] = [];
  const entries = parsed.entries.map((raw, i) => parseEntry(raw, `entries[${i}]`, problems));
  if (problems.length > 0) {
    throw new Error(`Invalid trend entries in ${file}:\n- ${problems.join("\n- ")}`);
  }
  return entries as TrendEntry[];
}

export interface TrendFilter {
  /** Matched ignoring case and surrounding whitespace. */
  company?: string;
  pattern?: string;
}

/** Entries matching the filter, most recently seen first. */
export function listTrends(filter: TrendFilter = {}, entries = readTrends()): TrendEntry[] {
  const company = filter.company === undefined ? undefined : companyKey(filter.company);
  return entries
    .filter(
      (entry) =>
        (company === undefined || companyKey(entry.company) === company) &&
        (filter.pattern === undefined || entry.pattern === filter.pattern),
    )
    .sort(
      (a, b) =>
        b.seenAt.localeCompare(a.seenAt) || b.recordedAt - a.recordedAt || a.id.localeCompare(b.id),
    );
}

export function trendById(id: string, entries = readTrends()): TrendEntry | undefined {
  return entries.find((entry) => entry.id === id);
}

// ── Writing ───────────────────────────────────────────────────────────────────

export interface AddResult {
  added: TrendEntry[];
  /** The entries already on file that the skipped inputs duplicated. */
  skipped: TrendEntry[];
}

/**
 * Validate every input, then append the ones that are not already on file. Nothing is
 * written when any input is invalid, so a batch is all or nothing. Two inputs for the
 * same pattern, company, and source count once.
 */
export function addTrends(inputs: readonly unknown[], now = Date.now()): AddResult {
  const problems: string[] = [];
  const parsed = inputs.map((raw, i) => validateTrendInput(raw, `entries[${i}]`, problems, now));
  if (problems.length > 0) throw new TrendValidationError(problems);

  const existing = readTrends();
  const byKey = new Map(existing.map((entry) => [dedupeKey(entry), entry]));
  const added: TrendEntry[] = [];
  const skipped: TrendEntry[] = [];
  for (const input of parsed as TrendInput[]) {
    const key = dedupeKey(input);
    const match = byKey.get(key);
    if (match) {
      skipped.push(match);
      continue;
    }
    const entry: TrendEntry = { id: trendId(input), ...input, recordedAt: now };
    byKey.set(key, entry);
    added.push(entry);
  }
  if (added.length > 0) writeJson(trendsFile(), { entries: [...existing, ...added] });
  return { added, skipped };
}

// ── Identity ──────────────────────────────────────────────────────────────────

type Identity = Pick<TrendEntry, "pattern" | "company" | "sourceUrl">;

/** Deterministic: the same pattern, company, and source always get the same id. */
export function trendId(input: Identity): string {
  return `t-${createHash("sha1").update(dedupeKey(input)).digest("hex").slice(0, 10)}`;
}

export function dedupeKey(input: Identity): string {
  return [
    input.pattern,
    companyKey(input.company),
    normalizeSourceUrl(input.sourceUrl) ?? input.sourceUrl.trim(),
  ].join("\n");
}

/** How a company name is compared: trimmed, single-spaced, lower case. */
export function companyKey(company: string): string {
  return company.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * `https://Example.com/post/#top` becomes `https://example.com/post`. Returns
 * undefined for anything that is not an http(s) URL.
 */
export function normalizeSourceUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

// ── Summaries ─────────────────────────────────────────────────────────────────

export interface PatternTally {
  pattern: string;
  count: number;
  /** The most recent seenAt among the entries. */
  latest: string;
  /** Distinct companies, most recently seen first. */
  companies: string[];
}

/** How often each pattern appears, most frequent first. Pure. */
export function tallyPatterns(entries: readonly TrendEntry[]): PatternTally[] {
  const byPattern = new Map<string, PatternTally>();
  for (const entry of listTrends({}, [...entries])) {
    const tally = byPattern.get(entry.pattern) ?? {
      pattern: entry.pattern,
      count: 0,
      latest: entry.seenAt,
      companies: [],
    };
    tally.count += 1;
    if (!tally.companies.some((c) => companyKey(c) === companyKey(entry.company))) {
      tally.companies.push(entry.company);
    }
    byPattern.set(entry.pattern, tally);
  }
  return [...byPattern.values()].sort(
    (a, b) =>
      b.count - a.count || b.latest.localeCompare(a.latest) || a.pattern.localeCompare(b.pattern),
  );
}

export interface CompanyTally {
  company: string;
  count: number;
  latest: string;
}

/** The companies on file, most entries first. Pure. */
export function tallyCompanies(entries: readonly TrendEntry[]): CompanyTally[] {
  const byCompany = new Map<string, CompanyTally>();
  for (const entry of listTrends({}, [...entries])) {
    const key = companyKey(entry.company);
    const tally = byCompany.get(key) ?? { company: entry.company, count: 0, latest: entry.seenAt };
    tally.count += 1;
    byCompany.set(key, tally);
  }
  return [...byCompany.values()].sort(
    (a, b) =>
      b.count - a.count || b.latest.localeCompare(a.latest) || a.company.localeCompare(b.company),
  );
}

// ── Schema ────────────────────────────────────────────────────────────────────

/**
 * Check one input and collect what is wrong with it under `label`. Returns the
 * normalised input, or undefined when a problem was added.
 */
export function validateTrendInput(
  raw: unknown,
  label: string,
  problems: string[],
  now = Date.now(),
): TrendInput | undefined {
  const before = problems.length;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push(`${label} must be an object`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;

  const pattern = record["pattern"];
  if (typeof pattern !== "string" || !patternById(pattern)) {
    problems.push(`${label}.pattern must be a pattern id from the taxonomy`);
  }

  const company = prose(record["company"], `${label}.company`, MAX_COMPANY, problems);
  const role =
    record["role"] === undefined
      ? undefined
      : prose(record["role"], `${label}.role`, MAX_ROLE, problems);
  const difficulty = record["difficulty"];
  if (difficulty !== undefined && !DIFFICULTIES.includes(difficulty as Difficulty)) {
    problems.push(`${label}.difficulty must be one of ${DIFFICULTIES.join(", ")}`);
  }

  const seenAt = record["seenAt"];
  const seenMs = typeof seenAt === "string" ? dateMs(seenAt) : undefined;
  if (seenMs === undefined) {
    problems.push(`${label}.seenAt must be a date written YYYY-MM-DD`);
  } else if (seenMs > now + DAY_MS || (seenAt as string) < EARLIEST_SEEN_AT) {
    problems.push(`${label}.seenAt must be a date from ${EARLIEST_SEEN_AT} to today`);
  }

  const sourceUrl = record["sourceUrl"];
  const normalizedUrl =
    typeof sourceUrl === "string" && sourceUrl.length <= MAX_SOURCE_URL
      ? normalizeSourceUrl(sourceUrl)
      : undefined;
  if (normalizedUrl === undefined) {
    problems.push(
      `${label}.sourceUrl must be an http or https URL of at most ${MAX_SOURCE_URL} characters`,
    );
  }

  const shapeNote = prose(record["shapeNote"], `${label}.shapeNote`, MAX_SHAPE_NOTE, problems);
  if (shapeNote !== undefined && LINK_RE.test(shapeNote)) {
    problems.push(`${label}.shapeNote must be prose with no link; the link goes in sourceUrl`);
  }

  if (problems.length > before) return undefined;
  const input: TrendInput = {
    pattern: pattern as string,
    company: company as string,
    seenAt: seenAt as string,
    sourceUrl: normalizedUrl as string,
    shapeNote: shapeNote as string,
  };
  if (role !== undefined) input.role = role;
  if (difficulty !== undefined) input.difficulty = difficulty as Difficulty;
  return input;
}

function parseEntry(raw: unknown, label: string, problems: string[]): TrendEntry | undefined {
  const input = validateTrendInput(raw, label, problems, Number.POSITIVE_INFINITY);
  const record = (raw ?? {}) as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || !ID_RE.test(id))
    problems.push(`${label}.id must look like t-0123456789`);
  const recordedAt = record["recordedAt"];
  if (typeof recordedAt !== "number") problems.push(`${label}.recordedAt must be a number`);
  if (!input || typeof id !== "string" || typeof recordedAt !== "number") return undefined;
  return { id, ...input, recordedAt };
}

/** A trimmed, single-spaced, non-empty string of at most `max` characters. */
function prose(value: unknown, label: string, max: number, problems: string[]): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${label} must be a non-empty string`);
    return undefined;
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > max) {
    problems.push(`${label} must be at most ${max} characters (got ${text.length})`);
    return undefined;
  }
  return text;
}

/** Midnight UTC of a YYYY-MM-DD date that exists, else undefined. */
function dateMs(value: string): number | undefined {
  if (!DATE_RE.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return undefined;
  return ms;
}
