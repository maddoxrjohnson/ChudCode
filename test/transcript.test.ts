/**
 * Transcript reviews: a synthetic Claude Code session log, audited; and the flow
 * from the page's list to inspect_transcript and a scored checklist.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CandidateInbox, connectInbox, McpSession, type JsonRpcResponse } from "../src/mcp.ts";
import { setHooks } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { readLesson } from "../src/store/lessons.ts";
import { auditTranscript, listTranscripts, transcriptPath } from "../src/transcript.ts";
import { makeFixture, type Fixture } from "./helpers.ts";
import { LAB_OUTLINE } from "./lesson-fixtures.ts";

const T0 = Date.parse("2026-10-19T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function assistant(id: string, model: string, minutes: number, usage: Record<string, unknown>) {
  return {
    type: "assistant",
    timestamp: at(minutes),
    effort: "high",
    message: { id, model, usage },
  };
}

/** Two requests on Sonnet 4.5, a switch to Opus 5.5 after a long gap, one compaction. */
export const LOG = [
  { type: "user", timestamp: at(0), message: { content: "<command-name>/clear</command-name>" } },
  {
    type: "user",
    timestamp: at(0),
    message: { content: "Fix the flaky test. key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz" },
  },
  assistant("m1", "claude-sonnet-4-5", 0, {
    input_tokens: 10,
    cache_creation_input_tokens: 5000,
    cache_read_input_tokens: 0,
    output_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 5000, ephemeral_1h_input_tokens: 0 },
  }),
  // The same message again, as Claude Code writes one line per content block.
  assistant("m1", "claude-sonnet-4-5", 0, {
    input_tokens: 10,
    cache_creation_input_tokens: 5000,
    cache_read_input_tokens: 0,
    output_tokens: 120,
    cache_creation: { ephemeral_5m_input_tokens: 5000, ephemeral_1h_input_tokens: 0 },
  }),
  {
    type: "user",
    timestamp: at(1),
    message: { content: [{ type: "tool_result", content: "ok" }] },
  },
  assistant("m2", "claude-sonnet-4-5", 1, {
    input_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 5000,
    output_tokens: 50,
  }),
  { type: "system", subtype: "compact_boundary", timestamp: at(2) },
  {
    type: "user",
    isCompactSummary: true,
    timestamp: at(2),
    message: { content: "Summary of the conversation" },
  },
  "not json at all",
  { type: "user", timestamp: at(20), message: { content: "Now review the diff." } },
  assistant("m3", "claude-opus-5-5", 20, {
    input_tokens: 20,
    cache_creation_input_tokens: 2000,
    cache_read_input_tokens: 0,
    output_tokens: 10,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 },
  }),
]
  .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
  .join("\n");

let fixture: Fixture;
let projects: string;

function writeLog(project: string, name: string, content: string, mtime: number): string {
  const dir = path.join(projects, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

beforeEach(() => {
  process.env["CHUDCODE_AUTO_OPEN"] = "0";
  fixture = makeFixture();
  projects = path.join(fixture.root, "claude-projects");
  process.env["CHUDCODE_CLAUDE_PROJECTS"] = projects;
});

afterEach(() => {
  delete process.env["CHUDCODE_CLAUDE_PROJECTS"];
  fixture.cleanup();
});

describe("auditTranscript", () => {
  it("counts each message once, finds switches, gaps, and compactions, and prices known models", () => {
    const file = writeLog("-home-me-app", "a.jsonl", LOG, T0);
    const audit = auditTranscript(file, "-home-me-app");
    expect(audit.requests).toBe(3);
    expect(audit.skipped).toBe(1);
    expect(audit.models).toEqual([
      { model: "claude-sonnet-4-5", requests: 2 },
      { model: "claude-opus-5-5", requests: 1 },
    ]);
    expect(audit.modelSwitches).toBe(1);
    expect(audit.longGaps).toBe(1);
    expect(audit.compactions).toBe(1);
    expect(audit.commands).toEqual({ "/clear": 1 });
    expect(audit.tokens).toEqual({
      input: 35,
      cacheWrite5m: 5000,
      cacheWrite1h: 2000,
      cacheRead: 5000,
      output: 180,
    });
    expect(audit.prompts).toEqual(["Fix the flaky test. key=[redacted]", "Now review the diff."]);
    // Sonnet 4.5 at $3: 10 + 5000*1.25, then 5 + 5000*0.1; Opus 5.5 at $4: 20 + 2000*2.
    const expected = (3 * (10 + 6250 + 5 + 500) + 4 * (20 + 4000)) / 1_000_000;
    expect(audit.estimatedInputCost).toBeCloseTo(expected, 9);
  });

  it("lists recent logs newest first by a token, never a path", () => {
    writeLog("-home-me-old", "old.jsonl", LOG, T0);
    writeLog("-home-me-new", "new.jsonl", LOG, T0 + 60_000);
    fs.symlinkSync("/etc/hostname", path.join(projects, "-home-me-new", "link.jsonl"));
    const list = listTranscripts();
    expect(list.map((t) => t.project)).toEqual(["-home-me-new", "-home-me-old"]);
    expect(list[0]?.firstPrompt).toBe("Fix the flaky test. key=[redacted]");
    expect(list[0]?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(transcriptPath(list[0]!.id)).toBe(path.join(projects, "-home-me-new", "new.jsonl"));
    expect(transcriptPath("../../etc/passwd")).toBeNull();
  });
});

describe("a transcript review", () => {
  let inbox: CandidateInbox;
  let mcp: McpSession;
  let nextId = 1;

  beforeEach(() => {
    inbox = new CandidateInbox();
    mcp = new McpSession(inbox);
    connectInbox(inbox);
  });

  afterEach(async () => {
    inbox.reset();
    await server.close();
    setHooks({});
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

  it("lists sessions on request, reads the one the learner consents to, and needs the checklist", async () => {
    writeLog("-home-me-app", "a.jsonl", LOG, T0);
    const teaching = [
      "## Clear between tasks",
      "",
      `/clear resets the context window [fact:context-clear]. ${"A context that carries an old task pays for it on every request. ".repeat(3)}`,
      "",
      "## Compact with a focus",
      "",
      `/compact takes focus instructions [fact:compact-command]; after it, CLAUDE.md is re-read [fact:compaction-survival]. ${"Durable rules belong on disk. ".repeat(4)}`,
      "",
      "## Push exploration out",
      "",
      `Subagents read in their own window and return a summary [fact:subagent-context]. ${"Exploration fills the main window fast. ".repeat(3)}`,
    ].join("\n");
    const written = await call("write_exercise", {
      slug: "audit-a-session",
      lesson: "managing-context",
      kind: "transcript",
      title: "Audit one of your sessions",
      teaching_md: teaching,
      brief_md:
        "## Your task\n\nPick a recent Claude Code session where you did real work. The review looks at how the context was managed: clears, compactions, delegation to subagents, and how your prompts set up the work.",
      model_outline: LAB_OUTLINE,
      follow_ups: ["What would you have cleared?", "Which prompt cost the most?"],
      pitfalls: ["Never clearing", "Compacting with no focus"],
    });
    expect(written.isError).toBe(false);
    expect((await call("validate_exercise", { slug: "audit-a-session" })).text).toContain("passed");
    const started = await call("start_lesson", { slug: "audit-a-session" });
    const id = /Session (\S+) is ready/.exec(started.text)![1]!;
    await post(`/api/sessions/${id}/start`);
    await call("wait_for_candidate", { timeout_seconds: 1 });

    const { transcripts } = await (await post(`/api/sessions/${id}/transcripts`)).json();
    expect(transcripts).toHaveLength(1);
    expect((await post(`/api/sessions/${id}/transcript`, { id: transcripts[0].id })).status).toBe(
      400,
    );
    expect(
      (await post(`/api/sessions/${id}/transcript`, { id: "0".repeat(16), consent: true })).status,
    ).toBe(400);
    const sent = await post(`/api/sessions/${id}/transcript`, {
      id: transcripts[0].id,
      note: "The flaky-test hunt.",
      consent: true,
    });
    expect(await sent.json()).toEqual({ number: 1 });
    const prompt = (await call("wait_for_candidate", { timeout_seconds: 2 })).text;
    expect(prompt).toContain("chose one of their Claude Code sessions");
    expect(prompt).toContain("`inspect_transcript`");

    const audit = await call("inspect_transcript", { session_id: id });
    expect(audit.text).toContain(
      "3 model requests: claude-sonnet-4-5 ×2, claude-opus-5-5 ×1; 1 model switch.",
    );
    expect(audit.text).toContain("1 gap of more than five minutes between requests; 1 compaction.");
    expect(audit.text).toContain("1. Fix the flaky test. key=[redacted]");
    expect(audit.text).not.toContain("sk-ant");
    expect(audit.text).toContain("`delegates`");

    const recorded = await call("record_lesson", {
      session_id: id,
      scores: {
        decomposition: null,
        verification: null,
        contextCost: 2,
        safety: null,
        delegation: null,
      },
      notes_md: "Cleared and compacted, never delegated.",
      checklist: [
        { id: "clears", status: "met", note: "/clear at the start" },
        { id: "compacts", status: "partial", note: "One compaction, no focus shown" },
        { id: "delegates", status: "missing", note: "No subagents" },
        { id: "prompts", status: "partial", note: "The first prompt names the test but not done" },
      ],
    });
    expect(recorded.text).toContain("Not passed");
    expect(readLesson(id).verdict).toMatchObject({ inspected: true, checklistOk: false });
  });
});
