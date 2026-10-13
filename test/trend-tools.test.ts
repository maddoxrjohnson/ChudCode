/**
 * The trend tools through the MCP dispatcher: record what research found, see it
 * again, and get told exactly what was wrong when an entry is rejected.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CandidateInbox, McpSession, type JsonRpcResponse } from "../src/mcp.ts";
import { readTrends } from "../src/store/trends.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

let fixture: Fixture;
let session: McpSession;
let nextId = 1;

beforeEach(() => {
  fixture = makeFixture();
  session = new McpSession(new CandidateInbox());
});

afterEach(() => fixture.cleanup());

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

const STRIPE_GRAPHS = {
  pattern: "graphs",
  company: "Stripe",
  role: "new grad SWE",
  difficulty: "medium",
  seen_at: "2026-09-14",
  source_url: "https://example.com/posts/stripe-ng-2026",
  shape_note:
    "Grid with blocked cells; count regions reachable from a start, then handle unblocks.",
};

const STRIPE_WINDOW = {
  pattern: "sliding-window",
  company: "stripe",
  seen_at: "2026-08-02",
  source_url: "https://example.com/posts/stripe-phone-screen/",
  shape_note: "Longest stretch with at most k distinct characters, n up to 10^5.",
};

describe("record_trends", () => {
  it("records entries and reports each with its id", async () => {
    const result = await call("record_trends", { entries: [STRIPE_GRAPHS, STRIPE_WINDOW] });
    expect(result.isError).toBe(false);
    expect(text(result)).toMatch(
      /^Recorded 2 new trend entries:\n- `t-[0-9a-f]{10}` graphs at Stripe \(new grad SWE, medium, seen 2026-09-14\): Grid with blocked cells/,
    );
    expect(text(result)).toContain("sliding-window at stripe (seen 2026-08-02)");
    expect(text(result)).not.toContain("Already on file");
    expect(text(result)).toContain("cites its id in `trend_ids` under `source`");
    expect(readTrends().map((e) => e.sourceUrl)).toEqual([
      "https://example.com/posts/stripe-ng-2026",
      "https://example.com/posts/stripe-phone-screen",
    ]);
  });

  it("skips what is already on file and says so", async () => {
    await call("record_trends", { entries: [STRIPE_GRAPHS] });
    const again = await call("record_trends", {
      entries: [
        { ...STRIPE_GRAPHS, shape_note: "Reworded." },
        { ...STRIPE_GRAPHS, pattern: "union-find" },
      ],
    });
    expect(again.isError).toBe(false);
    expect(text(again)).toContain("Recorded 1 new trend entry:");
    expect(text(again)).toMatch(/Already on file \(1\): `t-[0-9a-f]{10}` graphs at Stripe\./);
    expect(readTrends()).toHaveLength(2);

    const nothing = await call("record_trends", { entries: [STRIPE_GRAPHS] });
    expect(text(nothing)).toContain("Nothing new to record.");
  });

  it("rejects a bad batch naming the tool's field names, and lists the pattern ids", async () => {
    const result = await call("record_trends", {
      entries: [
        STRIPE_GRAPHS,
        { ...STRIPE_WINDOW, pattern: "windows", seen_at: "last week", shape_note: "" },
        "nope",
      ],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("no entries were recorded:");
    expect(text(result)).toContain("- entries[1].pattern must be a pattern id from the taxonomy");
    expect(text(result)).toContain("- entries[1].seen_at must be a date written YYYY-MM-DD");
    expect(text(result)).toContain("- entries[1].shape_note must be a non-empty string");
    expect(text(result)).toContain("- entries[2] must be an object");
    expect(text(result)).toContain("- `sliding-window`: Sliding Window.");
    expect(readTrends()).toEqual([]);

    const empty = await call("record_trends", { entries: [] });
    expect(empty.isError).toBe(true);
    expect(text(empty)).toContain("entries must be a non-empty list");
  });

  it("keeps a statement-sized note or a link out of the file", async () => {
    const long = await call("record_trends", {
      entries: [{ ...STRIPE_GRAPHS, shape_note: "Given an array ".repeat(30) }],
    });
    expect(long.isError).toBe(true);
    expect(text(long)).toContain("entries[0].shape_note must be at most 280 characters");
    const link = await call("record_trends", {
      entries: [{ ...STRIPE_GRAPHS, shape_note: "See https://example.com/problem for the task." }],
    });
    expect(text(link)).toContain("entries[0].shape_note must be prose with no link");
    expect(readTrends()).toEqual([]);
  });
});

describe("list_trends", () => {
  it("says when nothing is on file and how to change that", async () => {
    const result = await call("list_trends", { company: "Stripe" });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("No trend entries on file for Stripe.");
    expect(text(result)).toContain("`record_trends`");
    expect(text(result)).toMatch(/Pattern ids for `record_trends`: arrays-hashing, two-pointers/);
  });

  it("lists entries most recent first with a tally, filtered by company or pattern", async () => {
    await call("record_trends", {
      entries: [
        STRIPE_WINDOW,
        STRIPE_GRAPHS,
        {
          pattern: "graphs",
          company: "Databricks",
          seen_at: "2026-09-30",
          source_url: "https://example.com/posts/databricks",
          shape_note: "Job dependency graph; order the jobs or report the cycle.",
        },
      ],
    });
    const all = await call("list_trends");
    expect(text(all)).toContain(
      "3 trend entries on file, most recent first. Patterns: graphs ×2, sliding-window ×1.",
    );
    expect(
      text(all)
        .split("\n")
        .filter((l) => l.startsWith("- ")),
    ).toHaveLength(3);
    expect(text(all)).toMatch(/^- `t-[0-9a-f]{10}` graphs at Databricks/m);
    expect(text(all)).toContain("— source: https://example.com/posts/databricks");
    expect(text(all)).toContain("Companies: Stripe (2), Databricks (1).");

    const stripe = await call("list_trends", { company: " STRIPE ", limit: 1 });
    expect(text(stripe)).toContain("2 trend entries on file for  STRIPE , most recent first.");
    expect(text(stripe)).toContain("…and 1 more.");
    expect(text(stripe)).not.toContain("Companies:");

    const graphs = await call("list_trends", { pattern: "graphs" });
    expect(text(graphs)).toContain("2 trend entries on file on graphs");
    expect(text(graphs)).not.toContain("sliding-window at");

    const bad = await call("list_trends", { pattern: "graph" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("Unknown pattern id: graph");
  });
});
