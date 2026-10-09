/**
 * Shared fixtures: a throwaway state root on disk so store and server tests exercise
 * the real file layout.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { _overrideRootDir } from "../src/store/paths.ts";
import { importExample, type ProblemBundle } from "../src/store/problems.ts";

export interface Fixture {
  root: string;
  cleanup(): void;
}

export function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-test-"));
  _overrideRootDir(root);
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Copy the bundled example problem into the fixture root. */
export function seedExample(): ProblemBundle {
  return importExample("window-sum");
}

export interface Frame {
  type: string;
  data: unknown;
}

/** An open SSE connection that resolves frames on demand. */
export async function openStream(baseUrl: string, path: string) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: Frame[] = [];

  async function pump(): Promise<boolean> {
    const { value, done } = await reader.read();
    if (done) return false;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let type = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) type = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) queue.push({ type, data: JSON.parse(data) });
    }
    return true;
  }

  return {
    status: res.status,
    async next(predicate: (frame: Frame) => boolean, timeoutMs = 5_000): Promise<Frame> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const index = queue.findIndex(predicate);
        if (index !== -1) return queue.splice(index, 1)[0] as Frame;
        const more = await Promise.race([
          pump(),
          new Promise<boolean>((r) => setTimeout(() => r(true), 200)),
        ]);
        if (!more) break;
      }
      throw new Error("timed out waiting for an SSE frame");
    },
    close() {
      controller.abort();
    },
  };
}
