/**
 * The Pi host across processes, as it runs for real: the launcher spawned with
 * CHUDCODE_HOST=pi, and the extension's bridge in this process finding it through
 * server.json, the way Pi's MCP adapter and Pi itself would be split. Pi is a stub.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InterviewBridge, readServerFile } from "../pi/bridge.ts";
import { pythonAvailable } from "../src/runner/adapters/python/adapter.ts";
import { _overrideRootDir, packageRoot } from "../src/store/paths.ts";

describe.skipIf(!pythonAvailable())("the Pi extension against a spawned server", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-pi-"));
  const child = spawn(process.execPath, [path.join(packageRoot(), "mcp", "launch.mjs")], {
    cwd: packageRoot(),
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: stateDir,
      CHUDCODE_DIR: stateDir,
      CHUDCODE_AUTO_OPEN: "0",
      CHUDCODE_HOST: "pi",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, (value: unknown) => void>();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id: number };
    pending.get(message.id)?.(message);
  });
  let nextId = 1;
  const rpc = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const sent: string[] = [];
  const bridge = new InterviewBridge(
    { sendUserMessage: (text) => sent.push(text) },
    { retryMs: 50 },
  );

  beforeAll(() => _overrideRootDir(stateDir));
  afterAll(async () => {
    await bridge.stop();
    child.stdin.end();
    await new Promise((r) => child.on("close", r));
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("wakes Pi with the candidate's message, with no wait tool involved", async () => {
    bridge.start();
    await rpc("initialize", { protocolVersion: "2025-06-18" });
    await rpc("tools/call", { name: "begin_interview", arguments: {} });
    const started = (await rpc("tools/call", {
      name: "start_session",
      arguments: { slug: "window-sum", timer_minutes: 20, start_now: true },
    })) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(started.result.isError).toBe(false);
    const text = started.result.content[0]?.text ?? "";
    const id = /Session (\S+) is ready/.exec(text)?.[1];
    expect(text).toContain("## Constraints");

    const info = readServerFile();
    expect(info).not.toBeNull();
    const res = await fetch(`http://127.0.0.1:${info!.port}/api/sessions/${id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Can nums be empty?" }),
    });
    expect(res.status).toBe(200);

    const deadline = Date.now() + 10_000;
    while (sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Can nums be empty?");
    expect(sent[0]).toContain("0 <= len(nums) <= 10^5");
    expect(sent[0]).toContain("end your turn");
  }, 30_000);
});
