/**
 * seed.ts: the two public problem lists ChudCode knows about, as facts.
 *
 * Grind 75 ships verbatim from yangshun/tech-interview-handbook (MIT, see
 * data/seed/LICENSE.tech-interview-handbook). NeetCode 150 is hand-entered from the
 * public list. Both hold titles, difficulty, and the pattern each problem drills, and
 * never a statement. The interviewer uses them to learn what shape a pattern takes in
 * real interviews, and to find the pattern behind a title the user names, before
 * authoring an original problem of its own.
 */

import * as path from "node:path";

import { readJson } from "./store/json.ts";
import { dataDir } from "./store/paths.ts";
import { DIFFICULTIES, patternById, type Difficulty } from "./store/problems.ts";

export type SeedList = "grind75" | "neetcode150";

export interface SeedEntry {
  title: string;
  slug: string;
  difficulty: Difficulty;
  /** Pattern ids from data/patterns.json; the first is the one the problem is filed under. */
  patterns: string[];
  lists: SeedList[];
  /** Grind 75 only: the study week the list places it in. */
  week?: number;
  /** NeetCode 150 only: the category heading. */
  category?: string;
}

export interface SeedQuery {
  pattern?: string;
  difficulty?: Difficulty;
  /** Free text matched against titles; see `titleScore`. */
  title?: string;
  list?: SeedList;
}

interface Grind75Entry {
  slug: string;
  title: string;
  difficulty: string;
  topic: string;
}

interface NeetCodeEntry {
  title: string;
  difficulty: string;
  category: string;
  patterns: string[];
}

/** Grind 75 tags problems by topic; these are the patterns each topic drills by default. */
const TOPIC_PATTERNS: Record<string, string[]> = {
  array: ["arrays-hashing"],
  "hash-table": ["arrays-hashing"],
  string: ["arrays-hashing"],
  stack: ["stack"],
  "linked-list": ["linked-list"],
  "binary-tree": ["trees"],
  "binary-search-tree": ["trees"],
  "binary-search": ["binary-search"],
  graph: ["graphs"],
  "dynamic-programming": ["dp-1d"],
  binary: ["bit-manipulation"],
  heap: ["heap"],
  trie: ["tries"],
  recursion: ["backtracking"],
  matrix: ["math-geometry"],
};

/**
 * Grind 75 problems that NeetCode 150 does not list, where the topic alone would
 * mislead: a "string" problem that is really a sliding window, a "graph" problem that
 * is really union-find.
 */
const TITLE_PATTERNS: Record<string, string[]> = {
  "flood-fill": ["graphs"],
  "implement-queue-using-stacks": ["stack", "design"],
  "first-bad-version": ["binary-search"],
  "ransom-note": ["arrays-hashing"],
  "longest-palindrome": ["arrays-hashing"],
  "majority-element": ["arrays-hashing"],
  "add-binary": ["bit-manipulation", "math-geometry"],
  "middle-of-the-linked-list": ["linked-list"],
  "01-matrix": ["graphs"],
  "lowest-common-ancestor-of-a-binary-tree": ["trees"],
  "accounts-merge": ["union-find", "graphs"],
  "sort-colors": ["two-pointers"],
  "string-to-integer-atoi": ["math-geometry"],
  "find-all-anagrams-in-a-string": ["sliding-window"],
  "minimum-height-trees": ["topological-sort", "graphs"],
  "basic-calculator": ["stack"],
  "maximum-profit-in-job-scheduling": ["dp-1d", "binary-search"],
};

const LIST_NAMES: Record<SeedList, string> = { grind75: "Grind 75", neetcode150: "NeetCode 150" };

let cache: SeedEntry[] | null = null;

/** Every seed problem once, Grind 75 order first, then the NeetCode-only problems. */
export function seedEntries(): SeedEntry[] {
  if (cache) return cache;
  const seedDir = path.join(dataDir(), "seed");
  const grind = readJson<Record<string, Grind75Entry[]>>(path.join(seedDir, "grind75.json"));
  const neet = readJson<{ entries: NeetCodeEntry[] }>(path.join(seedDir, "neetcode150.json"));
  if (!grind || !neet) throw new Error(`Missing seed lists under ${seedDir}`);

  const neetByKey = new Map(neet.entries.map((e) => [titleKey(e.title), e]));
  const entries = new Map<string, SeedEntry>();

  for (const [week, items] of Object.entries(grind)) {
    const weekNumber = Number(/\d+/.exec(week)?.[0]);
    for (const item of items) {
      const key = titleKey(item.title);
      const neetEntry = neetByKey.get(key);
      const patterns =
        neetEntry?.patterns ?? TITLE_PATTERNS[item.slug] ?? TOPIC_PATTERNS[item.topic] ?? [];
      const entry: SeedEntry = {
        title: item.title,
        slug: item.slug,
        difficulty: parseDifficulty(item.difficulty, item.title),
        patterns: checkPatterns(patterns, item.title),
        lists: neetEntry ? ["grind75", "neetcode150"] : ["grind75"],
      };
      if (Number.isFinite(weekNumber)) entry.week = weekNumber;
      if (neetEntry) entry.category = neetEntry.category;
      entries.set(key, entry);
    }
  }

  for (const item of neet.entries) {
    const key = titleKey(item.title);
    if (entries.has(key)) continue;
    entries.set(key, {
      title: item.title,
      slug: slugOf(item.title),
      difficulty: parseDifficulty(item.difficulty, item.title),
      patterns: checkPatterns(item.patterns, item.title),
      lists: ["neetcode150"],
      category: item.category,
    });
  }

  cache = [...entries.values()];
  return cache;
}

/** Entries matching every given field, best title match first, then easy to hard. */
export function lookupSeed(query: SeedQuery): SeedEntry[] {
  const title = query.title?.trim();
  const scored = seedEntries()
    .map((entry) => ({ entry, score: title ? titleScore(title, entry.title) : 1 }))
    .filter(
      ({ entry, score }) =>
        score > 0 &&
        (!query.pattern || entry.patterns.includes(query.pattern)) &&
        (!query.difficulty || entry.difficulty === query.difficulty) &&
        (!query.list || entry.lists.includes(query.list)),
    );
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      DIFFICULTIES.indexOf(a.entry.difficulty) - DIFFICULTIES.indexOf(b.entry.difficulty) ||
      a.entry.title.localeCompare(b.entry.title),
  );
  return scored.map((s) => s.entry);
}

/**
 * The one seed problem a user most likely means by `text`, or undefined when no title
 * matches closely or several match equally well ("kth largest" names two problems).
 */
export function matchSeedTitle(text: string): SeedEntry | undefined {
  const [best, second] = lookupSeed({ title: text });
  if (!best) return undefined;
  const bestScore = titleScore(text, best.title);
  if (bestScore < 2) return undefined;
  if (second && titleScore(text, second.title) === bestScore) return undefined;
  return best;
}

/**
 * 3 for the same title ignoring case and punctuation, 2 when one contains the other,
 * 1 when every word of the query appears in the title, else 0.
 */
export function titleScore(query: string, title: string): number {
  const q = titleKey(query);
  const t = titleKey(title);
  if (!q) return 0;
  if (q === t) return 3;
  if (t.includes(q) || q.includes(t)) return 2;
  const titleWords = new Set(words(title));
  const queryWords = words(query);
  return queryWords.length > 0 && queryWords.every((w) => titleWords.has(w)) ? 1 : 0;
}

/** "Grind 75 (week 2) and NeetCode 150", for prose. */
export function describeLists(entry: SeedEntry): string {
  return entry.lists
    .map((list) =>
      list === "grind75" && entry.week !== undefined
        ? `${LIST_NAMES[list]} (week ${entry.week})`
        : LIST_NAMES[list],
    )
    .join(" and ");
}

export function seedListName(list: SeedList): string {
  return LIST_NAMES[list];
}

function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function slugOf(title: string): string {
  return words(title).join("-");
}

function parseDifficulty(value: string, title: string): Difficulty {
  const lowered = value.toLowerCase();
  if (!DIFFICULTIES.includes(lowered as Difficulty)) {
    throw new Error(`Seed entry "${title}" has an unknown difficulty: ${value}`);
  }
  return lowered as Difficulty;
}

function checkPatterns(patterns: string[], title: string): string[] {
  if (patterns.length === 0) throw new Error(`Seed entry "${title}" has no pattern`);
  for (const id of patterns) {
    if (!patternById(id)) throw new Error(`Seed entry "${title}" names an unknown pattern: ${id}`);
  }
  return [...patterns];
}
