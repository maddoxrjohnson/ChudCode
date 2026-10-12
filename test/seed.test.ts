/**
 * The seed lists: both load, every entry maps onto the pattern taxonomy, and title
 * lookups behave the way an interviewer asking "something like X" needs.
 */

import { describe, expect, it } from "vitest";

import { lookupSeed, matchSeedTitle, seedEntries, titleScore } from "../src/seed.ts";
import { patternById } from "../src/store/problems.ts";

describe("seedEntries", () => {
  const entries = seedEntries();

  it("merges Grind 75 and NeetCode 150 into one list without duplicate titles", () => {
    const grind = entries.filter((e) => e.lists.includes("grind75"));
    const neet = entries.filter((e) => e.lists.includes("neetcode150"));
    expect(grind).toHaveLength(75);
    expect(neet).toHaveLength(150);
    expect(new Set(entries.map((e) => e.title.toLowerCase())).size).toBe(entries.length);
    expect(entries.length).toBeLessThan(225);
  });

  it("gives every entry a known pattern and difficulty", () => {
    for (const entry of entries) {
      expect(entry.patterns.length, entry.title).toBeGreaterThan(0);
      for (const id of entry.patterns)
        expect(patternById(id), `${entry.title}: ${id}`).toBeDefined();
      expect(["easy", "medium", "hard"]).toContain(entry.difficulty);
      expect(entry.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("keeps the Grind 75 week and the NeetCode category", () => {
    const twoSum = entries.find((e) => e.title === "Two Sum");
    expect(twoSum).toMatchObject({
      lists: ["grind75", "neetcode150"],
      week: 1,
      category: "Arrays & Hashing",
      difficulty: "easy",
      patterns: ["arrays-hashing"],
    });
  });

  it("prefers NeetCode's pattern over the Grind 75 topic, and overrides lossy topics", () => {
    const byTitle = (title: string) => entries.find((e) => e.title === title)?.patterns;
    // Grind 75 files Word Break under "trie"; it drills 1-D DP.
    expect(byTitle("Word Break")).toEqual(["dp-1d"]);
    // Grind-only problems whose topic ("string", "array", "graph") would mislead.
    expect(byTitle("Find All Anagrams in a String")).toEqual(["sliding-window"]);
    expect(byTitle("Sort Colors")).toEqual(["two-pointers"]);
    expect(byTitle("Accounts Merge")).toEqual(["union-find", "graphs"]);
  });
});

describe("lookupSeed", () => {
  it("filters by pattern, difficulty, and list", () => {
    const windows = lookupSeed({ pattern: "sliding-window" }).map((e) => e.title);
    expect(windows).toContain("Minimum Window Substring");
    expect(windows).toContain("Find All Anagrams in a String");
    expect(windows).not.toContain("Two Sum");

    const hardGrind = lookupSeed({ difficulty: "hard", list: "grind75" });
    expect(hardGrind).toHaveLength(9);
    expect(hardGrind.every((e) => e.difficulty === "hard" && (e.week ?? 0) >= 7)).toBe(true);
  });

  it("orders unfiltered results easy to hard, then by title", () => {
    const all = lookupSeed({ pattern: "stack" });
    const ranks = all.map((e) => ["easy", "medium", "hard"].indexOf(e.difficulty));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(all.slice(0, 2).map((e) => e.title)).toEqual([
      "Implement Queue using Stacks",
      "Valid Parentheses",
    ]);
  });

  it("ranks title matches, exact first", () => {
    expect(lookupSeed({ title: "house robber" }).map((e) => e.title)).toEqual([
      "House Robber",
      "House Robber II",
    ]);
    expect(lookupSeed({ title: "largest kth" }).map((e) => e.title)).toEqual([
      "Kth Largest Element in a Stream",
      "Kth Largest Element in an Array",
    ]);
    expect(lookupSeed({ title: "no such problem anywhere" })).toEqual([]);
  });
});

describe("matchSeedTitle", () => {
  it("finds the one problem a user means, ignoring case and punctuation", () => {
    expect(matchSeedTitle("two sum")?.title).toBe("Two Sum");
    expect(matchSeedTitle("3sum")?.title).toBe("3Sum");
    expect(matchSeedTitle("Pow(x, n)")?.title).toBe("Pow(x, n)");
    expect(matchSeedTitle("LRU cache")?.title).toBe("LRU Cache");
  });

  it("refuses to guess when the words fit several problems or none", () => {
    expect(matchSeedTitle("sum")).toBeUndefined();
    expect(matchSeedTitle("kth largest")).toBeUndefined();
    expect(matchSeedTitle("largest kth")).toBeUndefined();
    expect(matchSeedTitle("the frobnicator")).toBeUndefined();
    expect(matchSeedTitle("")).toBeUndefined();
  });

  it("scores titles 3, 2, 1, 0", () => {
    expect(titleScore("Two Sum", "Two Sum")).toBe(3);
    expect(titleScore("two sum", "Two Sum II Input Array Is Sorted")).toBe(2);
    expect(titleScore("sum two", "Two Sum")).toBe(1);
    expect(titleScore("three sum", "Two Sum")).toBe(0);
  });
});
