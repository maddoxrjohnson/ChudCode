/**
 * The Pi extension: the bridge against a real server and agent channel, with a stub
 * in place of Pi, plus the commands and the status line.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agentOutbox, CandidateInbox, connectOutbox, McpSession } from "../src/mcp.ts";
import { setHooks } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { serverFile } from "../src/store/paths.ts";
import { createSession } from "../src/store/sessions.ts";
import { InterviewBridge, readServerFile, sseFrames, type BridgeStatus } from "../pi/bridge.ts";
import { COMMANDS, registerCommands, type CommandContext } from "../pi/commands.ts";
import { statusLines } from "../pi/status.ts";
import { makeFixture, seedExample, type Fixture } from "./helpers.ts";

interface Sent {
  text: string;
  options: { deliverAs?: string } | undefined;
}

let fixture: Fixture;
let sent: Sent[];
let statuses: BridgeStatus[];
let bridge: InterviewBridge;

function newSession(): string {
  return createSession({
    problem: "window-sum",
    problemTitle: "Largest Window Sum",
    patterns: ["sliding-window"],
    difficulty: "easy",
    mode: "interview",
    timerMs: 30 * 60_000,
  }).id;
}

/** Boot a server the way the MCP entry point does for Pi. */
async function bootServer(): Promise<void> {
  const outbox = agentOutbox();
  new McpSession(outbox);
  connectOutbox(outbox);
  await server.start({ port: 0 });
}

const say = (sessionId: string, text: string) =>
  fetch(`${server.getBaseUrl()}/api/sessions/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const connected = () => statuses.at(-1)?.connected === true;

beforeEach(() => {
  process.env["CHUDCODE_AUTO_OPEN"] = "0";
  fixture = makeFixture();
  seedExample();
  sent = [];
  statuses = [];
  bridge = new InterviewBridge(
    { sendUserMessage: (text, options) => sent.push({ text, options }) },
    { retryMs: 30, onStatus: (s) => statuses.push(s) },
  );
});

afterEach(async () => {
  await bridge.stop();
  await server.close();
  setHooks({});
  new McpSession(new CandidateInbox());
  fixture.cleanup();
});

describe("InterviewBridge", () => {
  it("waits for the server, then wakes the agent with each candidate event once", async () => {
    bridge.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(statuses).toEqual([]);

    await bootServer();
    await until(connected, "the bridge to connect");
    expect(statuses.at(-1)).toEqual({
      connected: true,
      port: Number(new URL(server.getBaseUrl()!).port),
    });

    const id = newSession();
    await say(id, "Is the array ever empty?");
    await until(() => sent.length === 1, "the first message");
    expect(sent[0]?.text).toContain("Is the array ever empty?");
    expect(sent[0]?.text).toContain("end your turn");
    expect(sent[0]?.options).toBeUndefined();

    bridge.setIdleProbe(() => false);
    await say(id, "Can k be zero?");
    await until(() => sent.length === 2, "the second message");
    expect(sent[1]?.options).toEqual({ deliverAs: "followUp" });
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(2);
  });

  it("delivers what queued before it connected, and only what it missed after a gap", async () => {
    await bootServer();
    const id = newSession();
    await say(id, "first, before any bridge");

    bridge.start();
    await until(() => sent.length === 1, "the replayed message");
    expect(sent[0]?.text).toContain("first, before any bridge");

    await bridge.stop();
    await say(id, "second, while disconnected");
    bridge.start();
    await until(() => sent.length === 2, "the missed message");
    expect(sent[1]?.text).toContain("second, while disconnected");
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(2);
  });

  it("starts over when the server is replaced by a new process", async () => {
    await bootServer();
    const id = newSession();
    bridge.start();
    await until(connected, "the bridge to connect");
    await say(id, "to the first server");
    await until(() => sent.length === 1, "the first server's message");

    await server.close();
    await until(() => !connected(), "the bridge to notice");
    await bootServer();
    await until(connected, "the bridge to reconnect");
    await say(id, "to the second server");
    await until(() => sent.length === 2, "the second server's message");
    expect(sent[1]?.text).toContain("to the second server");
  });

  it("is refused without the token in server.json", async () => {
    await bootServer();
    const info = readServerFile();
    expect(info?.agentToken).toBeTruthy();
    const forged = new InterviewBridge(
      { sendUserMessage: (text, options) => sent.push({ text, options }) },
      {
        retryMs: 30,
        readServer: () => ({ port: info!.port, agentToken: "forged" }),
        onStatus: (s) => statuses.push(s),
      },
    );
    forged.start();
    await new Promise((r) => setTimeout(r, 200));
    await forged.stop();
    expect(statuses.some((s) => s.connected)).toBe(false);
  });
});

describe("helpers", () => {
  it("reads server.json only when it names a port and a token", () => {
    expect(readServerFile()).toBeNull();
    fs.mkdirSync(path.dirname(serverFile()), { recursive: true });
    fs.writeFileSync(serverFile(), JSON.stringify({ port: 4000 }));
    expect(readServerFile()).toBeNull();
    fs.writeFileSync(serverFile(), JSON.stringify({ port: 4000, agentToken: "t", pid: 1 }));
    expect(readServerFile()).toEqual({ port: 4000, agentToken: "t" });
    fs.writeFileSync(serverFile(), "{not json");
    expect(readServerFile()).toBeNull();
  });

  it("parses an event stream split at arbitrary points", async () => {
    const text =
      ': connected\n\nevent: candidate\ndata: {"seq":1}\n\nevent: presence\ndata: {"listening":true}\n\n';
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const frames = [];
    for await (const frame of sseFrames(body)) frames.push(frame);
    expect(frames).toEqual([
      { type: "candidate", data: { seq: 1 } },
      { type: "presence", data: { listening: true } },
    ]);
  });

  it("shows the status line only while connected", () => {
    expect(statusLines({ connected: false })).toBeUndefined();
    expect(statusLines({ connected: true, port: 4100 })).toEqual([
      "chudcode interviewer connected on port 4100",
    ]);
  });
});

describe("commands", () => {
  const pushed = new McpSession(agentOutbox()).toolNames();

  it("registers each command and sends its prompt, as a follow-up when the agent is busy", async () => {
    const registered = new Map<string, (args: string, ctx: CommandContext) => Promise<void>>();
    const messages: Sent[] = [];
    let pokes = 0;
    registerCommands(
      {
        registerCommand: (name, spec) => registered.set(name, spec.handler),
        sendUserMessage: (text, options) => messages.push({ text, options }),
      },
      () => (pokes += 1),
    );
    expect([...registered.keys()]).toEqual([
      "interview",
      "review",
      "roadmap",
      "research",
      "dashboard",
    ]);

    await registered.get("interview")!("  sliding window medium ", { isIdle: () => true });
    await registered.get("research")!("Stripe new grad", { isIdle: () => false });
    expect(messages[0]).toEqual({
      text: expect.stringContaining("The user asked for: sliding window medium\n"),
      options: undefined,
    });
    expect(messages[1]?.text).toMatch(/^Research what Stripe new grad has been asking/);
    expect(messages[1]?.options).toEqual({ deliverAs: "followUp" });
    expect(pokes).toBe(2);
  });

  it.each(Object.keys(COMMANDS))("%s names only tools the Pi host lists", (name) => {
    const prompt = COMMANDS[name as keyof typeof COMMANDS].prompt("x");
    const tools = [...prompt.matchAll(/`([a-z_]+)`/g)]
      .map((m) => m[1])
      .filter((t): t is string => !!t && t.includes("_"));
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(pushed).toContain(tool);
    expect(prompt).not.toContain("wait_for_candidate");
  });
});
