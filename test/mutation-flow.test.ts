/**
 * A mutation drill through the tools: write it, validate it by running the oracle,
 * and refuse one whose mutants the oracle cannot kill.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CandidateInbox, connectInbox, McpSession, type JsonRpcResponse } from "../src/mcp.ts";
import { pythonAvailable } from "../src/runner/adapters/python/adapter.ts";
import { setHooks } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { readExercise } from "../src/store/exercises.ts";
import { readLesson } from "../src/store/lessons.ts";
import { makeFixture, type Fixture } from "./helpers.ts";
import { drillArgs, ORACLE, SPEC, WEAK_TESTS } from "./mutation-fixtures.ts";

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

describe.skipIf(!pythonAvailable())("writing a mutation drill", () => {
  it("validates a drill by running its oracle against every variant", async () => {
    expect((await call("write_exercise", drillArgs())).isError).toBe(false);
    const stored = readExercise("test-the-token-bucket");
    expect(stored.private.mutation?.mutants).toHaveLength(5);
    const validated = await call("validate_exercise", { slug: "test-the-token-bucket" });
    expect(validated.text).toContain("passed");
    expect(readExercise("test-the-token-bucket").meta.validatedAt).toBeDefined();
  }, 60_000);

  it("refuses a drill with a mutant the oracle cannot kill", async () => {
    const mutants = [
      ...SPEC.mutants.slice(0, 4),
      { id: "harmless", description: "x", find: "return False", replace: "return 0" },
    ];
    await call("write_exercise", drillArgs({ mutants }));
    const report = await call("validate_exercise", { slug: "test-the-token-bucket" });
    expect(report.isError).toBe(true);
    expect(report.text).toContain("Mutant harmless survives the oracle");
  }, 60_000);

  it("checks a drill's shape before running it, and needs the drill fields", async () => {
    await call("write_exercise", drillArgs({ rewrites_py: [SPEC.reference] }));
    const report = await call("validate_exercise", { slug: "test-the-token-bucket" });
    expect(report.text).toContain("rewrites[0] is the reference");
    const missing = await call("write_exercise", drillArgs({ mutants: undefined }));
    expect(missing.text).toContain("mutants must be a list");
  }, 60_000);
});

const browser = (url: string, body: unknown = {}) =>
  fetch(`${server.getBaseUrl()}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe.skipIf(!pythonAvailable())("a drill session", () => {
  async function startDrill(): Promise<string> {
    await call("write_exercise", drillArgs());
    expect((await call("validate_exercise", { slug: "test-the-token-bucket" })).isError).toBe(
      false,
    );
    const started = await call("start_lesson", { slug: "test-the-token-bucket" });
    expect(started.text).toContain("Their workspace is");
    const id = /Session (\S+) is ready/.exec(started.text)?.[1];
    if (!id) throw new Error(started.text);
    return id;
  }

  it("lays out a workspace with only the public files", async () => {
    const id = await startDrill();
    const dir = readLesson(id).drill?.workspace ?? "";
    expect(dir).toBe(path.join(process.env["CHUDCODE_WORKSPACES"]!, id));
    expect(fs.readFileSync(path.join(dir, "limiter.py"), "utf8")).toBe(SPEC.reference);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain(
      "python3 -m unittest discover tests",
    );
    expect(fs.readdirSync(path.join(dir, "tests"))).toEqual(["__init__.py"]);
    // Nothing hidden is in the workspace.
    const everything = fs
      .readdirSync(dir, { recursive: true })
      .filter((f) => !String(f).startsWith(".git"))
      .map((f) =>
        fs.statSync(path.join(dir, String(f))).isFile()
          ? fs.readFileSync(path.join(dir, String(f)), "utf8")
          : "",
      )
      .join("\n");
    expect(everything).not.toContain("strict-cost");
    expect(everything).not.toContain("test_clock_going_backwards");
  }, 60_000);

  it("grades the workspace's tests, tells the interviewer which bugs survived, and reveals them only in the debrief", async () => {
    const id = await startDrill();
    const dir = readLesson(id).drill!.workspace;
    expect((await browser(`/api/sessions/${id}/grade`)).status).toBe(409);
    await browser(`/api/sessions/${id}/start`);
    await call("wait_for_candidate", { timeout_seconds: 1 });
    const empty = await browser(`/api/sessions/${id}/grade`);
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toContain("no tests/test_*.py");

    fs.writeFileSync(path.join(dir, "tests", "test_bucket.py"), WEAK_TESTS);
    const graded = await browser(`/api/sessions/${id}/grade`);
    const { grade } = await graded.json();
    expect(grade).toMatchObject({ number: 1, tests: 3, killed: 2, mutants: 5, passed: false });
    expect(JSON.stringify(grade)).not.toContain("no-cap");

    const prompt = (await call("wait_for_candidate", { timeout_seconds: 2 })).text;
    expect(prompt).toContain("caught 2 of 5 planted bugs");
    expect(prompt).toContain("`no-cap` Refill is not capped at capacity");
    expect(prompt).toContain("Tests that assert nothing: test_runs.");
    expect(prompt).toContain("Do not name a surviving bug");

    const page = await (await fetch(`${server.getBaseUrl()}/s/${id}`)).text();
    expect(page).toContain(`cd ${dir}`);
    expect(page).toContain("caught <strong>2 of 5</strong>");
    expect(page).not.toContain("Refill is not capped");

    // The stronger suite clears the gate; the verdict follows the latest grade.
    fs.writeFileSync(path.join(dir, "tests", "test_bucket.py"), ORACLE);
    expect((await (await browser(`/api/sessions/${id}/grade`)).json()).grade.passed).toBe(true);
    await call("wait_for_candidate", { timeout_seconds: 2 });
    const recorded = await call("record_lesson", {
      session_id: id,
      scores: {
        decomposition: null,
        verification: 3,
        contextCost: null,
        safety: null,
        delegation: null,
      },
      notes_md: "Boundaries covered on the second try.",
      strengths: ["Exact-cost boundary"],
      improvements: ["Think about time running backwards first"],
    });
    expect(recorded.text).toContain("Passed");
    expect(readLesson(id).verdict).toMatchObject({ correct: true, gatePassed: true });
    const done = await (await fetch(`${server.getBaseUrl()}/s/${id}`)).text();
    expect(done).toContain("Your tests caught every one.");
  }, 120_000);

  it("does not pass a drill whose latest grade missed the gate", async () => {
    const id = await startDrill();
    await browser(`/api/sessions/${id}/start`);
    fs.writeFileSync(
      path.join(readLesson(id).drill!.workspace, "tests", "test_bucket.py"),
      WEAK_TESTS,
    );
    await browser(`/api/sessions/${id}/grade`);
    await call("record_lesson", {
      session_id: id,
      scores: {
        decomposition: null,
        verification: 3,
        contextCost: null,
        safety: null,
        delegation: null,
      },
      notes_md: "x",
    });
    expect(readLesson(id).verdict).toMatchObject({ correct: false, gatePassed: false });
    const done = await (await fetch(`${server.getBaseUrl()}/s/${id}`)).text();
    expect(done).toContain("Bugs your tests missed");
    expect(done).toContain("Refill is not capped at capacity");
  }, 120_000);
});
