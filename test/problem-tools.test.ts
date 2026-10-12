/**
 * The authoring tools through the MCP dispatcher: look up a seed, write a bundle,
 * validate it, and only then serve it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CandidateInbox, McpSession, type JsonRpcResponse } from "../src/mcp.ts";
import { pythonAvailable } from "../src/runner/adapters/python/adapter.ts";
import * as server from "../src/server/server.ts";
import { readProblem } from "../src/store/problems.ts";
import { makeFixture, seedExample, type Fixture } from "./helpers.ts";

let fixture: Fixture;
let session: McpSession;
let nextId = 1;

beforeEach(() => {
  process.env["CHUDCODE_AUTO_OPEN"] = "0";
  fixture = makeFixture();
  session = new McpSession(new CandidateInbox());
});

afterEach(async () => {
  await server.close();
  fixture.cleanup();
});

interface CallResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const response: JsonRpcResponse | null = await session.handle({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (!response || !("result" in response)) throw new Error(JSON.stringify(response));
  return response.result as CallResult;
}

const text = (result: CallResult) => result.content.map((c) => c.text).join("\n");

/** An original problem small enough to read: count the values whose partner x + k is present. */
const PARTNERED = {
  slug: "values-with-a-partner",
  title: "Values With a Partner",
  patterns: ["arrays-hashing"],
  difficulty: "easy",
  statement_md: [
    "## Problem",
    "",
    "Given an integer array `nums` and a positive integer `k`, return how many distinct",
    "values `x` in `nums` have `x + k` also present in `nums`.",
    "",
    "## Examples",
    "",
    "**Example 1**",
    "",
    "```",
    "Input:  nums = [1, 3, 2, 5], k = 2",
    "Output: 2",
    "```",
    "",
    "1 pairs with 3, and 3 pairs with 5.",
    "",
    "**Example 2**",
    "",
    "```",
    "Input:  nums = [4, 4, 4], k = 1",
    "Output: 0",
    "```",
    "",
    "## Constraints",
    "",
    "- `0 <= len(nums) <= 10^5`",
    "- `-10^9 <= nums[i] <= 10^9`",
    "- `1 <= k <= 10^9`",
    "",
  ].join("\n"),
  signature: {
    style: "function",
    name: "count_partnered",
    params: [
      { name: "nums", type: "List[int]" },
      { name: "k", type: "int" },
    ],
    returns: "int",
  },
  tests: [
    {
      id: "ex1",
      label: "Example 1",
      visible: true,
      input: { nums: [1, 3, 2, 5], k: 2 },
      expected: 2,
    },
    { id: "ex2", label: "Example 2", visible: true, input: { nums: [4, 4, 4], k: 1 }, expected: 0 },
    { id: "empty", visible: false, input: { nums: [], k: 1 }, expected: 0 },
    { id: "single", visible: false, input: { nums: [7], k: 3 }, expected: 0 },
    { id: "dupes", visible: false, input: { nums: [1, 1, 3, 3], k: 2 }, expected: 1 },
    { id: "negatives", visible: false, input: { nums: [-2, 0, -4], k: 2 }, expected: 2 },
    { id: "chain", visible: false, input: { nums: [1, 2, 3, 4], k: 1 }, expected: 3 },
    { id: "big-gap", visible: false, input: { nums: [1, 1000000000], k: 999999999 }, expected: 1 },
    { id: "large", visible: false, gen: "large(100000, 5)" },
  ],
  reference_py: [
    "from typing import List",
    "",
    "",
    "def count_partnered(nums: List[int], k: int) -> int:",
    "    seen = set(nums)",
    "    return sum(1 for x in seen if x + k in seen)",
    "",
  ].join("\n"),
  hints: [
    "What structure answers 'is x + k present?' in constant time?",
    "Put every value in a set, then count the distinct values whose partner is in it.",
  ],
  complexity_target: { time: "O(n)", space: "O(n)" },
  source: { kind: "generated" },
  generators_py: [
    "import random",
    "",
    "",
    "def large(n, k, seed=1):",
    "    rng = random.Random(seed)",
    '    return {"nums": [rng.randint(0, n) for _ in range(n)], "k": k}',
    "",
  ].join("\n"),
};

describe("lookup_seed", () => {
  it("answers a title query with facts and lists", async () => {
    const result = await call("lookup_seed", { title: "two sum" });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain(
      "- Two Sum (easy; arrays-hashing) — Grind 75 (week 1) and NeetCode 150",
    );
    expect(text(result)).toContain(
      "Two Sum II Input Array Is Sorted (medium; two-pointers) — NeetCode 150",
    );
    expect(text(result)).not.toContain("leetcode.com");
  });

  it("filters and rejects unknown patterns", async () => {
    const result = await call("lookup_seed", { pattern: "tries", difficulty: "hard" });
    expect(text(result)).toBe("- Word Search II (hard; tries, backtracking) — NeetCode 150");
    const bad = await call("lookup_seed", { pattern: "dynamic-sliding" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("`sliding-window`");
    expect(text(await call("lookup_seed", { title: "zzz" }))).toBe("No seed problem matches.");
  });
});

describe("write_problem", () => {
  it("rejects a bundle that does not fit the schema, naming every problem", async () => {
    const meta = await call("write_problem", {
      ...PARTNERED,
      patterns: ["hashing"],
      complexity_target: { time: "", space: "O(1)" },
    });
    expect(meta.isError).toBe(true);
    expect(text(meta)).toContain("unknown pattern id");
    expect(text(meta)).toContain("meta.complexityTarget.time must be a non-empty string");

    const cases = await call("write_problem", {
      ...PARTNERED,
      hints: ["one", "two", 3],
      tests: PARTNERED.tests.map((t) => ({ ...t, input: t.input && { ...t.input, extra: 1 } })),
    });
    expect(cases.isError).toBe(true);
    expect(text(cases)).toContain("not in the signature: extra");
    expect(text(cases)).toContain("hints[2].text must be a non-empty string");
    expect(() => readProblem("values-with-a-partner")).toThrow();
  });

  it("writes an unvalidated bundle and reports lint problems up front", async () => {
    const thin = await call("write_problem", { ...PARTNERED, tests: PARTNERED.tests.slice(0, 5) });
    expect(thin.isError).toBe(false);
    expect(text(thin)).toContain(
      "Wrote `values-with-a-partner`: Values With a Partner (easy; arrays-hashing) with 2 visible and 3 hidden cases, 2 hints. Not yet validated.",
    );
    expect(text(thin)).toContain("at least 6 hidden cases (found 3)");
    expect(text(thin)).toContain("at least one max-size case");
    expect(readProblem("values-with-a-partner").meta.validatedAt).toBeUndefined();

    const full = await call("write_problem", PARTNERED);
    expect(text(full)).toContain("with 2 visible and 7 hidden cases");
    expect(text(full)).toContain('Call `validate_problem` with slug "values-with-a-partner".');
    const bundle = readProblem("values-with-a-partner");
    expect(bundle.meta.source).toEqual({ kind: "generated" });
    expect(bundle.hints).toEqual([
      { level: 1, text: PARTNERED.hints[0] },
      { level: 2, text: PARTNERED.hints[1] },
    ]);
    expect(bundle.tests[8]).toEqual({ id: "large", visible: false, gen: "large(100000, 5)" });
  });

  it("maps mimic and in-place fields and refuses an unknown source kind", async () => {
    const result = await call("write_problem", {
      ...PARTNERED,
      slug: "partner-mimic",
      source: { kind: "mimic", mimic_of: "Two Sum" },
      tests: [
        ...PARTNERED.tests,
        {
          id: "inplace",
          visible: false,
          input: { nums: [1], k: 1 },
          expected: [1],
          output_from: "nums",
        },
      ],
    });
    expect(result.isError).toBe(false);
    const bundle = readProblem("partner-mimic");
    expect(bundle.meta.source).toEqual({ kind: "mimic", mimicOf: "Two Sum" });
    expect(bundle.tests.at(-1)).toMatchObject({ id: "inplace", outputFrom: "nums" });

    const hand = await call("write_problem", { ...PARTNERED, source: { kind: "hand" } });
    expect(hand.isError).toBe(true);
    expect(text(hand)).toContain("source.kind must be one of generated, mimic, review");
  });

  it("refuses to overwrite a problem that has been served", async () => {
    seedExample();
    await call("start_session", { slug: "window-sum" });
    const result = await call("write_problem", { ...PARTNERED, slug: "window-sum" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("has been served 1 time and sessions refer to it");
    expect(readProblem("window-sum").meta.title).toBe("Largest Window Sum");
  });
});

describe.skipIf(!pythonAvailable())("validate_problem and start_session", () => {
  it("serves a problem only once it has passed validation", async () => {
    await call("write_problem", PARTNERED);
    const refused = await call("start_session", { slug: "values-with-a-partner" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("has not passed validation");

    const validated = await call("validate_problem", { slug: "values-with-a-partner" });
    expect(validated.isError).toBe(false);
    expect(text(validated)).toContain("Shape: ok.");
    expect(text(validated)).toContain("9/9 passed");
    expect(text(validated)).toContain(
      "Oracle cases filled from the reference: large (written to tests.json)",
    );
    expect(text(validated)).toContain("Validated. `values-with-a-partner` can be served");
    expect(readProblem("values-with-a-partner").tests.at(-1)?.expected).toBeTypeOf("number");

    const started = await call("start_session", { slug: "values-with-a-partner" });
    expect(started.isError).toBe(false);
    expect(text(started)).toContain("The candidate sees the statement, 2 examples");
  });

  it("reports a wrong reference case by case and leaves the problem unservable", async () => {
    await call("write_problem", {
      ...PARTNERED,
      reference_py: "def count_partnered(nums, k):\n    return len(set(nums)) - 1 if nums else 0\n",
    });
    const result = await call("validate_problem", { slug: "values-with-a-partner" });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("8/9 passed");
    expect(text(result)).toMatch(
      /- Example 1 \(visible\): fail\n {2}input: nums = \[1, 3, 2, 5\], k = 2\n {2}expected: 2\n {2}got: 3/,
    );
    expect(text(result)).toContain(
      "Passed: Example 2, empty, single, dupes, negatives, chain, big-gap, large",
    );
    expect(text(result)).toContain(
      "The reference disagrees with the authored expected output on 1 case.",
    );
    expect(text(result)).toContain(
      "Not validated. Fix the bundle with `write_problem` (same slug)",
    );
    expect((await call("start_session", { slug: "values-with-a-partner" })).isError).toBe(true);
  });

  it("names a missing problem", async () => {
    const result = await call("validate_problem", { slug: "nothing-here" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("No problem named nothing-here");
  });
});

describe("begin_interview", () => {
  it("tells the interviewer what the seed lists know about a named title and a pattern", async () => {
    seedExample();
    const brief = text(
      await call("begin_interview", { mode: "mimic", title: "Two Sum", pattern: "sliding-window" }),
    );
    expect(brief).toContain(
      "**Two Sum** is on Grind 75 (week 1) and NeetCode 150: easy, arrays-hashing.",
    );
    expect(brief).toContain("set `source.kind` to `mimic`");
    expect(brief).toContain("## Seed problems for sliding-window");
    expect(brief).toContain("Minimum Window Substring (hard)");
    expect(brief).toContain("## Authoring");
    expect(brief).toContain("PROBLEM-FORMAT.md");

    const unknown = text(await call("begin_interview", { title: "The Frobnicator" }));
    expect(unknown).toContain("No seed list has a problem named **The Frobnicator**");
  });
});
