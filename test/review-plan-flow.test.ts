/**
 * Flaw reviews and cache plans through the tools and the page API: write, validate,
 * serve, submit, grade, and the debrief that reveals what was hidden.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CandidateInbox, connectInbox, McpSession, type JsonRpcResponse } from "../src/mcp.ts";
import { setHooks } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { readLesson } from "../src/store/lessons.ts";
import { cacheArgs, REFERENCE, SCENARIO } from "./cache-fixtures.ts";
import { FLAW_SPEC, flawArgs } from "./flaw-fixtures.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

let fixture: Fixture;
let inbox: CandidateInbox;
let mcp: McpSession;
let nextId = 1;

beforeEach(() => {
  process.env["CHUDCODE_AUTO_OPEN"] = "0";
  fixture = makeFixture();
  inbox = new CandidateInbox();
  mcp = new McpSession(inbox);
  connectInbox(inbox);
});

afterEach(async () => {
  inbox.reset();
  await server.close();
  setHooks({});
  fixture.cleanup();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const response = (await mcp.handle({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  })) as JsonRpcResponse;
  if (!("result" in response)) throw new Error(JSON.stringify(response));
  const result = response.result as { content: Array<{ text: string }>; isError: boolean };
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError };
}

const post = (url: string, body: unknown = {}) =>
  fetch(`${server.getBaseUrl()}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function serve(args: Record<string, unknown>): Promise<string> {
  expect((await call("write_exercise", args)).isError).toBe(false);
  const validated = await call("validate_exercise", { slug: args["slug"] });
  expect(validated.text).toContain("passed");
  const started = await call("start_lesson", { slug: args["slug"] });
  const id = /Session (\S+) is ready/.exec(started.text)?.[1];
  if (!id) throw new Error(started.text);
  await post(`/api/sessions/${id}/start`);
  await call("wait_for_candidate", { timeout_seconds: 1 });
  return id;
}

const SCORES = {
  decomposition: null,
  verification: 3,
  contextCost: 3,
  safety: 3,
  delegation: null,
};

describe("flaw reviews", () => {
  it("rejects a flaw whose explanation is on the page, and a flaw off the diff", async () => {
    await call(
      "write_exercise",
      flawArgs({
        brief_md: `${flawArgs()["brief_md"]}\n\n${FLAW_SPEC.flaws[0]!.explanation}`,
        flaws: [{ ...(flawArgs()["flaws"] as object[])[0], line: 400 }],
      }),
    );
    const report = await call("validate_exercise", { slug: "review-the-invoices-diff" });
    expect(report.text).toContain("is not a line of the new file");
    expect(report.text).toContain("flaws needs 4 to 12 entries");
  });

  it("shows the diff, grades the marks, keeps the answers back until the debrief", async () => {
    const id = await serve(flawArgs());
    const page = await (await fetch(`${server.getBaseUrl()}/s/${id}`)).text();
    expect(page).toContain('data-file="app/routes/invoices.py" data-line="25"');
    expect(page).toContain("pk-live-0f3c9a7e51");
    for (const flaw of FLAW_SPEC.flaws) expect(page).not.toContain(flaw.explanation);
    const state = await (await fetch(`${server.getBaseUrl()}/api/sessions/${id}`)).json();
    expect(state.exercise.diff).toBe(FLAW_SPEC.diff);
    expect(JSON.stringify(state)).not.toContain("hardcoded-key");

    expect((await post(`/api/sessions/${id}/review`, { marks: [] })).status).toBe(400);
    const bad = await post(`/api/sessions/${id}/review`, {
      marks: [{ file: "nope.py", line: 1, category: "secret" }],
    });
    expect(bad.status).toBe(400);

    const marks = [
      { file: "app/routes/invoices.py", line: 6, category: "secret", reason: "key in code" },
      { file: "app/routes/invoices.py", line: 16, category: "injection", reason: "SQL?" },
    ];
    const graded = await (await post(`/api/sessions/${id}/review`, { marks })).json();
    expect(graded.grade).toMatchObject({
      number: 1,
      found: 1,
      flaws: 5,
      falseAlarms: 1,
      criticalMissed: 1,
      passed: false,
    });
    expect(JSON.stringify(graded)).not.toContain("explanation");

    const prompt = (await call("wait_for_candidate", { timeout_seconds: 2 })).text;
    expect(prompt).toContain("finding 1 of 5 planted flaws");
    expect(prompt).toContain("`sql-injection` app/routes/invoices.py:25");
    expect(prompt).toContain("(a decoy: This query passes the id as a parameter");
    expect(prompt).toContain("Do not point at a missed flaw's line");

    const better = FLAW_SPEC.flaws.slice(0, 4).map((f) => ({
      file: f.file,
      line: f.line,
      category: f.category,
      reason: "x",
    }));
    expect(
      (await (await post(`/api/sessions/${id}/review`, { marks: better })).json()).grade.passed,
    ).toBe(true);
    await call("wait_for_candidate", { timeout_seconds: 2 });
    const recorded = await call("record_lesson", { session_id: id, scores: SCORES, notes_md: "x" });
    expect(recorded.text).toContain("Passed");
    expect(readLesson(id).verdict).toMatchObject({ correct: true, gatePassed: true });
    const done = await (await fetch(`${server.getBaseUrl()}/s/${id}`)).text();
    expect(done).toContain("The planted flaws");
    expect(done).toContain(FLAW_SPEC.flaws[4]!.explanation);
    expect(done).toContain('<span class="badge warn">missed</span>');
  });

  it("allows three reviews", async () => {
    const id = await serve(flawArgs());
    const mark = { marks: [{ file: "app/routes/invoices.py", line: 6, category: "secret" }] };
    for (let i = 0; i < 3; i++)
      expect((await post(`/api/sessions/${id}/review`, mark)).status).toBe(200);
    expect((await post(`/api/sessions/${id}/review`, mark)).status).toBe(429);
  });
});

describe("cache plans", () => {
  it("rejects a scenario a naive plan already handles", async () => {
    const flat = { ...SCENARIO, segments: SCENARIO.segments.map((s) => ({ ...s, changesAt: [] })) };
    await call("write_exercise", cacheArgs({ scenario: flat }));
    const report = await call("validate_exercise", { slug: "cache-the-support-bot" });
    expect(report.text).toContain("Make the scenario reward a real plan");
  });

  it("shows the workload, simulates plans, and reveals the reference in the debrief", async () => {
    const id = await serve(cacheArgs());
    const page = await (await fetch(`${server.getBaseUrl()}/s/${id}`)).text();
    expect(page).toContain("<code>claude-sonnet-4-5</code>: $3 per million input tokens");
    expect(page).toContain("today&#39;s date and time");
    expect(page).not.toContain('"after": "instructions"');

    const invalid = await post(`/api/sessions/${id}/plan`, {
      plan: { order: ["docs", "tools"], breakpoints: [] },
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toContain("order leaves out");

    const naive = {
      order: ["tools", "date", "instructions", "docs"],
      breakpoints: [{ after: "docs", ttl: "5m" }],
    };
    const first = (await (await post(`/api/sessions/${id}/plan`, { plan: naive })).json()).grade;
    expect(first).toMatchObject({ number: 1, hits: 0, requests: 3, passed: false });
    expect(first.ratio).toBeGreaterThan(1.4);
    const prompt = (await call("wait_for_candidate", { timeout_seconds: 2 })).text;
    expect(prompt).toContain("Your reference (private until the debrief)");
    expect(prompt).toContain('"after": "instructions"');

    const second = (await (await post(`/api/sessions/${id}/plan`, { plan: REFERENCE })).json())
      .grade;
    expect(second).toMatchObject({ ratio: 1, passed: true });
    await call("wait_for_candidate", { timeout_seconds: 2 });
    await call("record_lesson", { session_id: id, scores: SCORES, notes_md: "x" });
    expect(readLesson(id).verdict).toMatchObject({ correct: true, gatePassed: true });
    const done = await (await fetch(`${server.getBaseUrl()}/s/${id}`)).text();
    expect(done).toContain("The best plan known");
    expect(done).toContain("&quot;after&quot;: &quot;instructions&quot;");
  });
});
