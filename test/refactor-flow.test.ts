/**
 * A refactor drill through the tools and the page: the workspace starts as a git
 * repository, the learner commits tests then the refactor, and Grade checks it all.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CandidateInbox, connectInbox, McpSession, type JsonRpcResponse } from "../src/mcp.ts";
import { pythonAvailable } from "../src/runner/adapters/python/adapter.ts";
import { setHooks } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { readLesson } from "../src/store/lessons.ts";
import { makeFixture, type Fixture } from "./helpers.ts";
import { CHARACTERISATION, CLEAN, refactorArgs } from "./refactor-fixtures.ts";

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

function commit(dir: string, message: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), content);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=L",
    "-c",
    "user.email=l@example.com",
    "commit",
    "-qm",
    message,
  ]);
}

describe.skipIf(!pythonAvailable())("a refactor drill", () => {
  it("validates, lays out a committed workspace, and grades the learner's history", async () => {
    expect((await call("write_exercise", refactorArgs())).isError).toBe(false);
    expect((await call("validate_exercise", { slug: "untangle-the-pricing" })).text).toContain(
      "passed",
    );
    const started = await call("start_lesson", { slug: "untangle-the-pricing" });
    const id = /Session (\S+) is ready/.exec(started.text)![1]!;
    const dir = readLesson(id).drill!.workspace;
    expect(execFileSync("git", ["-C", dir, "log", "--format=%s"]).toString().trim()).toBe(
      "Start the drill",
    );
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("**commit them**");
    const page = await (await fetch(`${server.getBaseUrl()}/s/${id}`)).text();
    expect(page).toContain("Grade my refactor");
    expect(page).not.toContain("_apply_coupon");

    await post(`/api/sessions/${id}/start`);
    await call("wait_for_candidate", { timeout_seconds: 1 });
    // Tests and the refactor in one commit: the order check fails.
    commit(dir, "Refactor with tests", {
      "tests/test_pricing.py": CHARACTERISATION,
      "pricing.py": CLEAN,
    });
    const first = (await (await post(`/api/sessions/${id}/grade`)).json()).grade;
    expect(first).toMatchObject({
      testsFirst: false,
      behaviourKept: true,
      apiSame: true,
      passed: false,
    });
    const prompt = (await call("wait_for_candidate", { timeout_seconds: 2 })).text;
    expect(prompt).toContain("same commit as the first tests");
    expect(prompt).toContain("Shape: longest function 28 → 8 lines");

    const recorded = await call("record_lesson", {
      session_id: id,
      scores: {
        decomposition: 3,
        verification: 1,
        contextCost: null,
        safety: null,
        delegation: null,
      },
      notes_md: "Good shape; tests came with the change.",
    });
    expect(recorded.text).toContain("Not passed");
    expect(readLesson(id).verdict).toMatchObject({ gatePassed: false });
    const done = await (await fetch(`${server.getBaseUrl()}/s/${id}`)).text();
    expect(done).toContain("Your tests caught every one.");
  }, 120_000);

  it("passes tests committed before the refactor", async () => {
    await call("write_exercise", refactorArgs());
    await call("validate_exercise", { slug: "untangle-the-pricing" });
    const started = await call("start_lesson", { slug: "untangle-the-pricing" });
    const id = /Session (\S+) is ready/.exec(started.text)![1]!;
    const dir = readLesson(id).drill!.workspace;
    await post(`/api/sessions/${id}/start`);
    commit(dir, "Pin pricing", { "tests/test_pricing.py": CHARACTERISATION });
    commit(dir, "Split pricing into helpers", { "pricing.py": CLEAN });
    const grade = (await (await post(`/api/sessions/${id}/grade`)).json()).grade;
    expect(grade).toMatchObject({ testsFirst: true, killed: 4, mutants: 4, passed: true });
  }, 120_000);
});
