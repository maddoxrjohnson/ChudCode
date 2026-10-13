/**
 * The trends store: entries are checked before they are written, the same post
 * recorded twice counts once, ids are stable, and a shape note cannot carry a
 * statement or a link.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeJson } from "../src/store/json.ts";
import { trendsFile } from "../src/store/paths.ts";
import {
  addTrends,
  listTrends,
  MAX_SHAPE_NOTE,
  normalizeSourceUrl,
  readTrends,
  tallyCompanies,
  tallyPatterns,
  trendById,
  trendId,
  TrendValidationError,
  validateTrendInput,
} from "../src/store/trends.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
});
afterEach(() => fixture.cleanup());

const NOW = Date.UTC(2026, 9, 13, 12);

const GRAPHS = {
  pattern: "graphs",
  company: "Stripe",
  role: "new grad SWE",
  difficulty: "medium",
  seenAt: "2026-09-14",
  sourceUrl: "https://example.com/posts/stripe-ng-2026",
  shapeNote:
    "Grid of cells with blocked squares; count regions reachable from a start, then asked to handle updates that unblock cells.",
};

const WINDOW = {
  pattern: "sliding-window",
  company: "Stripe",
  seenAt: "2026-08-02",
  sourceUrl: "https://example.com/posts/stripe-phone-screen",
  shapeNote: "Longest stretch of a string with at most k distinct characters, n up to 10^5.",
};

function problemsOf(input: unknown): string[] {
  const problems: string[] = [];
  validateTrendInput(input, "e", problems, NOW);
  return problems;
}

describe("validateTrendInput", () => {
  it("accepts a full entry and normalises its text and URL", () => {
    const problems: string[] = [];
    const input = validateTrendInput(
      {
        ...GRAPHS,
        company: "  Stripe ",
        shapeNote: "Grid of\n  cells,\tcount regions.",
        sourceUrl: "HTTPS://Example.com/posts/stripe-ng-2026/#comments",
      },
      "e",
      problems,
      NOW,
    );
    expect(problems).toEqual([]);
    expect(input).toEqual({
      pattern: "graphs",
      company: "Stripe",
      role: "new grad SWE",
      difficulty: "medium",
      seenAt: "2026-09-14",
      sourceUrl: "https://example.com/posts/stripe-ng-2026",
      shapeNote: "Grid of cells, count regions.",
    });
  });

  it("names every field that is wrong", () => {
    expect(
      problemsOf({
        pattern: "hashing",
        company: "",
        role: 3,
        difficulty: "brutal",
        seenAt: "2026-02-30",
        sourceUrl: "ftp://example.com/x",
        shapeNote: " ",
      }),
    ).toEqual([
      "e.pattern must be a pattern id from the taxonomy",
      "e.company must be a non-empty string",
      "e.role must be a non-empty string",
      "e.difficulty must be one of easy, medium, hard",
      "e.seenAt must be a date written YYYY-MM-DD",
      "e.sourceUrl must be an http or https URL of at most 500 characters",
      "e.shapeNote must be a non-empty string",
    ]);
    expect(problemsOf("nope")).toEqual(["e must be an object"]);
  });

  it("rejects dates in the future or before interview posts existed", () => {
    expect(problemsOf({ ...GRAPHS, seenAt: "2026-10-15" })).toEqual([
      "e.seenAt must be a date from 2000-01-01 to today",
    ]);
    expect(problemsOf({ ...GRAPHS, seenAt: "1999-12-31" })).toEqual([
      "e.seenAt must be a date from 2000-01-01 to today",
    ]);
    // Today, and yesterday in a timezone ahead of UTC, are fine.
    expect(problemsOf({ ...GRAPHS, seenAt: "2026-10-13" })).toEqual([]);
    expect(problemsOf({ ...GRAPHS, seenAt: "2026-10-14" })).toEqual([]);
  });

  it("caps the shape note so a statement cannot fit, and keeps links out of it", () => {
    const long = "x".repeat(MAX_SHAPE_NOTE + 1);
    expect(problemsOf({ ...GRAPHS, shapeNote: long })).toEqual([
      `e.shapeNote must be at most ${MAX_SHAPE_NOTE} characters (got ${MAX_SHAPE_NOTE + 1})`,
    ]);
    expect(problemsOf({ ...GRAPHS, shapeNote: "x".repeat(MAX_SHAPE_NOTE) })).toEqual([]);
    expect(problemsOf({ ...GRAPHS, shapeNote: "See https://example.com/the-problem" })).toEqual([
      "e.shapeNote must be prose with no link; the link goes in sourceUrl",
    ]);
    expect(problemsOf({ ...GRAPHS, shapeNote: "Posted on www.example.com" })).toHaveLength(1);
  });
});

describe("normalizeSourceUrl", () => {
  it("drops the fragment and trailing slash and lower-cases the host", () => {
    expect(normalizeSourceUrl(" https://Example.com/a/b/#top ")).toBe("https://example.com/a/b");
    expect(normalizeSourceUrl("https://example.com/")).toBe("https://example.com/");
    expect(normalizeSourceUrl("https://example.com/a/?page=2")).toBe(
      "https://example.com/a?page=2",
    );
    expect(normalizeSourceUrl("example.com/a")).toBeUndefined();
    expect(normalizeSourceUrl("javascript:alert(1)")).toBeUndefined();
  });
});

describe("addTrends", () => {
  it("writes entries with derived ids and timestamps, and reads them back", () => {
    expect(readTrends()).toEqual([]);
    const result = addTrends([GRAPHS, WINDOW], NOW);
    expect(result.skipped).toEqual([]);
    expect(result.added.map((e) => e.id)).toEqual([trendId(GRAPHS), trendId(WINDOW)]);
    expect(result.added[0]).toMatchObject({ ...GRAPHS, recordedAt: NOW });
    expect(result.added[0]?.id).toMatch(/^t-[0-9a-f]{10}$/);
    expect(readTrends()).toEqual(result.added);
    expect(trendById(trendId(WINDOW))?.pattern).toBe("sliding-window");
  });

  it("counts the same pattern, company, and post once, however they are spelled", () => {
    addTrends([GRAPHS], NOW);
    const again = addTrends(
      [
        {
          ...GRAPHS,
          company: "stripe",
          sourceUrl: "https://EXAMPLE.com/posts/stripe-ng-2026/#x",
          shapeNote: "A different paraphrase of the same post.",
        },
        { ...GRAPHS, pattern: "union-find" },
        { ...GRAPHS, pattern: "union-find", role: "same post, same pattern, listed twice" },
      ],
      NOW + 1,
    );
    expect(again.skipped.map((e) => [e.id, e.pattern])).toEqual([
      [trendId(GRAPHS), "graphs"],
      [trendId({ ...GRAPHS, pattern: "union-find" }), "union-find"],
    ]);
    expect(again.added.map((e) => e.pattern)).toEqual(["union-find"]);
    expect(readTrends()).toHaveLength(2);
    // The first paraphrase stays: a duplicate never overwrites.
    expect(readTrends()[0]?.shapeNote).toBe(GRAPHS.shapeNote);
  });

  it("ids depend only on the pattern, company, and source", () => {
    const reworded = { ...GRAPHS, shapeNote: "other", seenAt: "2020-01-01" };
    expect(trendId(GRAPHS)).toBe(trendId(reworded));
    expect(trendId(GRAPHS)).toBe(trendId({ ...GRAPHS, company: " STRIPE " }));
    expect(trendId(GRAPHS)).not.toBe(trendId({ ...GRAPHS, company: "Stripe Inc" }));
    expect(trendId(GRAPHS)).not.toBe(trendId(WINDOW));
  });

  it("writes nothing when any entry in the batch is invalid", () => {
    expect(() => addTrends([GRAPHS, { ...WINDOW, pattern: "windows" }], NOW)).toThrow(
      TrendValidationError,
    );
    try {
      addTrends([GRAPHS, { ...WINDOW, pattern: "windows" }], NOW);
    } catch (err) {
      expect((err as TrendValidationError).problems).toEqual([
        "entries[1].pattern must be a pattern id from the taxonomy",
      ]);
    }
    expect(readTrends()).toEqual([]);
  });
});

describe("readTrends", () => {
  it("refuses a malformed file rather than guessing", () => {
    writeJson(trendsFile(), { entries: [{ ...GRAPHS, id: "t-1", recordedAt: "soon" }] });
    expect(() => readTrends()).toThrow(/entries\[0\]\.id must look like t-0123456789/);
    expect(() => readTrends()).toThrow(/entries\[0\]\.recordedAt must be a number/);
    writeJson(trendsFile(), { trends: [] });
    expect(() => readTrends()).toThrow(/must hold/);
  });

  it("accepts a hand-edited entry whose id no longer matches its fields", () => {
    addTrends([GRAPHS], NOW);
    const [entry] = readTrends();
    writeJson(trendsFile(), { entries: [{ ...entry, company: "Stripe (London)" }] });
    expect(readTrends()[0]).toMatchObject({ id: entry?.id, company: "Stripe (London)" });
  });
});

describe("listTrends and tallies", () => {
  const DATABRICKS = {
    pattern: "graphs",
    company: "Databricks",
    seenAt: "2026-09-30",
    sourceUrl: "https://example.com/posts/databricks-onsite",
    shapeNote: "Dependency graph of jobs; find an order or report the cycle.",
  };

  beforeEach(() => {
    addTrends([WINDOW, GRAPHS, DATABRICKS], NOW);
  });

  it("filters by company ignoring case and by pattern, most recent first", () => {
    expect(listTrends().map((e) => e.seenAt)).toEqual(["2026-09-30", "2026-09-14", "2026-08-02"]);
    expect(listTrends({ company: " stripe" }).map((e) => e.pattern)).toEqual([
      "graphs",
      "sliding-window",
    ]);
    expect(listTrends({ pattern: "graphs" }).map((e) => e.company)).toEqual([
      "Databricks",
      "Stripe",
    ]);
    expect(listTrends({ company: "Stripe", pattern: "sliding-window" })).toHaveLength(1);
    expect(listTrends({ company: "Nobody" })).toEqual([]);
  });

  it("tallies patterns and companies", () => {
    expect(tallyPatterns(readTrends())).toEqual([
      { pattern: "graphs", count: 2, latest: "2026-09-30", companies: ["Databricks", "Stripe"] },
      { pattern: "sliding-window", count: 1, latest: "2026-08-02", companies: ["Stripe"] },
    ]);
    expect(tallyCompanies(readTrends())).toEqual([
      { company: "Stripe", count: 2, latest: "2026-09-14" },
      { company: "Databricks", count: 1, latest: "2026-09-30" },
    ]);
    expect(tallyPatterns([])).toEqual([]);
  });
});
