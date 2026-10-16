/**
 * The pushed host (Pi): the numbered outbox, the token-guarded agent channel and
 * `/api/inbox`, and an MCP session that has no wait tool.
 */

import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  agentOutbox,
  CandidateInbox,
  connectOutbox,
  McpSession,
  PUSH_HOST_BRIEF,
  type JsonRpcResponse,
} from "../src/mcp.ts";
import { AgentOutbox, OUTBOX_LIMIT } from "../src/outbox.ts";
import { setHooks, type InboxEntry, type InboxPage } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { serverFile } from "../src/store/paths.ts";
import { makeFixture, openStream, seedExample, type Fixture } from "./helpers.ts";

describe("AgentOutbox", () => {
  it("numbers prompts, publishes each once, and replays what came after a seq", () => {
    const published: InboxEntry[] = [];
    const box = new AgentOutbox((entry) => published.push(entry));
    box.push("one", "k1", undefined, 10);
    box.push("one again", "k1");
    box.push("two", undefined, undefined, 20);

    expect(published.map((e) => [e.seq, e.prompt])).toEqual([
      [1, "one"],
      [2, "two"],
    ]);
    expect(published.every((e) => e.stream === box.stream)).toBe(true);
    expect(box.since(0).entries.map((e) => e.prompt)).toEqual(["one", "two"]);
    expect(box.since(1)).toEqual({
      stream: box.stream,
      latest: 2,
      entries: [{ stream: box.stream, seq: 2, at: 20, prompt: "two" }],
    });
    expect(box.since(2).entries).toEqual([]);
  });

  it("drops a prompt whose session ended, at push time and at replay", () => {
    let open = true;
    const box = new AgentOutbox(() => {});
    box.push("stale", "a", () => false);
    box.push("live", "b", () => open);
    expect(box.since(0).entries.map((e) => e.prompt)).toEqual(["live"]);
    open = false;
    expect(box.since(0)).toMatchObject({ latest: 1, entries: [] });
  });

  it("keeps a bounded history", () => {
    const box = new AgentOutbox(() => {});
    for (let i = 0; i < OUTBOX_LIMIT + 5; i += 1) box.push(`p${i}`);
    const page = box.since(0);
    expect(page.entries).toHaveLength(OUTBOX_LIMIT);
    expect(page.entries[0]?.seq).toBe(6);
    expect(page.latest).toBe(OUTBOX_LIMIT + 5);
  });

  it("gives every process its own stream id", () => {
    expect(new AgentOutbox(() => {}).stream).not.toBe(new AgentOutbox(() => {}).stream);
  });
});

describe("a pushed host", () => {
  let fixture: Fixture;
  let outbox: AgentOutbox;
  let session: McpSession;
  let nextId = 1;

  beforeEach(() => {
    process.env["CHUDCODE_AUTO_OPEN"] = "0";
    fixture = makeFixture();
    seedExample();
    outbox = agentOutbox();
    session = new McpSession(outbox);
    connectOutbox(outbox);
  });

  afterEach(async () => {
    await server.close();
    setHooks({});
    // Later suites in this worker expect the default host's wording.
    new McpSession(new CandidateInbox());
    fixture.cleanup();
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const response: JsonRpcResponse | null = await session.handle({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (!response || !("result" in response)) throw new Error(JSON.stringify(response));
    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    return { isError: result.isError, text: result.content.map((c) => c.text).join("\n") };
  }

  function token(): string {
    return (JSON.parse(fs.readFileSync(serverFile(), "utf8")) as { agentToken: string }).agentToken;
  }

  const auth = () => ({ Authorization: `Bearer ${token()}` });
  const base = () => server.getBaseUrl() ?? "";

  it("does not list the wait tool and briefs the agent on pushed events", async () => {
    expect(session.toolNames()).not.toContain("wait_for_candidate");
    const listed = await session.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (listed as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (t) => t.name,
    );
    expect(names).toContain("begin_interview");
    expect(names).not.toContain("wait_for_candidate");

    const brief = await call("begin_interview", {});
    expect(brief.text).toContain(PUSH_HOST_BRIEF);
    expect(brief.text).not.toContain("Each wait lasts");
    const waited = await session.handle({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name: "wait_for_candidate", arguments: {} },
    });
    expect(waited).toMatchObject({ error: { code: -32602 } });
  });

  it("keeps the agent channel and the inbox from anyone without the token", async () => {
    await call("open_dashboard");
    expect(fs.statSync(serverFile()).mode & 0o777).toBe(0o600);
    expect(token()).toMatch(/^[\w-]{32}$/);

    for (const headers of [{}, { Authorization: "Bearer nope" }]) {
      expect((await fetch(`${base()}/api/inbox?since=0`, { headers })).status).toBe(401);
      expect((await fetch(`${base()}/api/events?scope=agent`, { headers })).status).toBe(401);
    }
    expect((await fetch(`${base()}/api/inbox?since=-1`, { headers: auth() })).status).toBe(400);

    const page = (await (
      await fetch(`${base()}/api/inbox?since=0`, { headers: auth() })
    ).json()) as InboxPage;
    expect(page).toEqual({ stream: outbox.stream, latest: 0, entries: [] });
  });

  it("pushes a candidate's message to the subscribed bridge and replays it on request", async () => {
    const started = await call("start_session", { slug: "window-sum", timer_minutes: 30 });
    expect(started.text).toContain("Then end your turn");
    const sessionId = /Session (\S+) is ready/.exec(started.text)?.[1] ?? "";

    const page = await openStream(base(), `/api/events?session=${sessionId}`);
    const agent = await openStream(base(), "/api/events?scope=agent", auth());
    expect(agent.status).toBe(200);
    await page.next((f) => f.type === "presence" && (f.data as { listening: boolean }).listening);

    const state = await fetch(`${base()}/api/sessions/${sessionId}`);
    expect(((await state.json()) as { listening: boolean }).listening).toBe(true);

    await fetch(`${base()}/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Can k be larger than the array?" }),
    });
    const frame = await agent.next((f) => f.type === "candidate");
    const entry = frame.data as InboxEntry;
    expect(entry).toMatchObject({ stream: outbox.stream, seq: 1 });
    expect(entry.prompt).toContain("Can k be larger than the array?");
    expect(entry.prompt).toContain("end your turn");
    expect(entry.prompt).toContain("pushed this from the candidate's page");
    expect(entry.prompt).not.toContain("wait_for_candidate");

    const replay = (await (
      await fetch(`${base()}/api/inbox?since=0`, { headers: auth() })
    ).json()) as InboxPage;
    expect(replay.entries).toEqual([entry]);

    const said = await call("say_to_candidate", { session_id: sessionId, markdown: "Yes." });
    expect(said.text).toBe("Sent. Then end your turn; their next action arrives as a new message.");

    agent.close();
    await page.next((f) => f.type === "presence" && !(f.data as { listening: boolean }).listening);
    page.close();
  });
});
