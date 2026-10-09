/**
 * The stdio transport, end to end: spawn the launcher the way Claude Code does and
 * speak newline-delimited JSON-RPC to it.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import { describe, expect, it } from "vitest";

import { packageRoot } from "../src/store/paths.ts";

describe("mcp/launch.mjs over stdio", () => {
  it("initialises, lists tools, calls one, and exits cleanly when stdin closes", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-stdio-"));
    const child = spawn(process.execPath, [path.join(packageRoot(), "mcp", "launch.mjs")], {
      cwd: packageRoot(),
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: stateDir,
        CHUDCODE_DIR: stateDir,
        CHUDCODE_AUTO_OPEN: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

    const responses: unknown[] = [];
    const rawLines: string[] = [];
    const reader = readline.createInterface({ input: child.stdout });
    const got = new Promise<void>((resolve) => {
      reader.on("line", (line) => {
        rawLines.push(line);
        responses.push(JSON.parse(line));
        if (responses.length === 3) resolve();
      });
    });

    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_problems", arguments: {} },
    });

    await Promise.race([
      got,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timed out; stderr: ${stderr.join("")}`)), 15_000),
      ),
    ]);

    expect(rawLines.every((line) => line.startsWith("{"))).toBe(true);
    expect(responses[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "chudcode" } } });
    const tools = (responses[1] as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (t) => t.name,
    );
    expect(tools).toContain("wait_for_candidate");
    expect(tools).toContain("start_session");
    expect(responses[2]).toMatchObject({ id: 3, result: { isError: false } });
    expect(
      (responses[2] as { result: { content: Array<{ text: string }> } }).result.content[0]?.text,
    ).toContain("`window-sum`: Largest Window Sum");

    const exit = new Promise<number | null>((resolve) =>
      child.on("close", (code) => resolve(code)),
    );
    child.stdin.end();
    expect(await exit).toBe(0);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }, 30_000);
});
