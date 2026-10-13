/**
 * HTTP integration: boot the real server on a temp root and drive it like a browser.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pythonAvailable } from "../src/runner/adapters/python/adapter.ts";
import type { CandidateEvent } from "../src/server/hooks.ts";
import { setHooks } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { createSession, readSession } from "../src/store/sessions.ts";
import { makeFixture, openStream as openStreamAt, seedExample, type Fixture } from "./helpers.ts";

let fixture: Fixture;
let baseUrl: string;
let sessionId: string;
const events: CandidateEvent[] = [];

beforeAll(async () => {
  fixture = makeFixture();
  seedExample();
  setHooks({ onCandidateEvent: (e) => events.push(e), isListening: () => true });
  baseUrl = await server.start({ port: 0 });
  sessionId = createSession({
    problem: "window-sum",
    problemTitle: "Largest Window Sum",
    patterns: ["sliding-window"],
    difficulty: "easy",
    mode: "interview",
    timerMs: 35 * 60_000,
  }).id;
});

afterAll(async () => {
  await server.close();
  setHooks({});
  fixture.cleanup();
});

const get = (path: string) => fetch(`${baseUrl}${path}`);
const send = (method: string, path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const post = (path: string, body: unknown = {}) => send("POST", path, body);
const openStream = (path: string) => openStreamAt(baseUrl, path);

describe("pages", () => {
  it("serves the dashboard with the pattern grid, as HTML and as JSON", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("ChudCode");
    expect(html).toContain("Largest Window Sum");
    expect(html).toContain('<tr data-pattern="sliding-window" data-box=""');
    expect(html).toContain("Finish an interview and its patterns start their review schedule.");

    const api = await get("/api/dashboard");
    expect(api.status).toBe(200);
    const body = (await api.json()) as {
      sessions: unknown[];
      progress: { patterns: unknown[]; streakDays: number; problems: Record<string, unknown> };
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.progress.patterns).toHaveLength(21);
    expect(body.progress.streakDays).toBe(0);
    expect(body.progress.problems).toEqual({});
  });

  it("serves the session page without leaking the solution or hidden cases", async () => {
    const res = await get(`/s/${sessionId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Largest Window Sum");
    expect(html).toContain("def max_window_sum(nums: List[int], k: int) -&gt; int:");
    expect(html).toContain("9 hidden cases run");
    expect(html).not.toContain("window += nums[i]");
    expect(html).not.toContain("2477188");
    expect(html).not.toContain("Recomputing the sum of every window");
  });

  it("serves the problem preview and 404s for unknown ids", async () => {
    expect((await get("/p/window-sum")).status).toBe(200);
    expect((await get("/p/nope")).status).toBe(404);
    expect((await get("/s/20260101-0000-nope-0000")).status).toBe(404);
    expect((await get("/nowhere")).status).toBe(404);
  });

  it("refuses to serve files outside the assets directory", async () => {
    // Clients normalise a literal `..` before sending, so probe with encoded forms. Any
    // refusal status is fine; the file itself must never come back.
    for (const probe of [
      "/static/%2e%2e/package.json",
      "/static/..%2fpackage.json",
      "/static/%2e%2e%2fpackage.json",
    ]) {
      const res = await get(probe);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain('"name": "chudcode"');
    }
    expect((await get("/static/")).status).toBe(404);
    expect((await get("/static/does-not-exist.css")).status).toBe(404);
  });

  it("serves the runtime and the editor bundle", async () => {
    const css = await get("/static/runtime/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const bundle = await get("/static/vendor/codemirror.bundle.mjs");
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("javascript");
  });
});

describe("session API", () => {
  it("returns candidate-safe state with the editor stub as the draft", async () => {
    const res = await get(`/api/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as {
      problem: { visibleCases: unknown[] };
      draft: string;
      listening: boolean;
    };
    expect(state.problem.visibleCases).toHaveLength(3);
    expect(state.draft).toContain("def max_window_sum");
    expect(state.listening).toBe(true);
    expect(JSON.stringify(state)).not.toContain("2477188");
  });

  it("refuses to run before the clock starts, then starts it once", async () => {
    const early = await post(`/api/sessions/${sessionId}/run`, { code: "x = 1" });
    expect(early.status).toBe(409);

    const started = await post(`/api/sessions/${sessionId}/start`);
    expect(started.status).toBe(200);
    const again = await post(`/api/sessions/${sessionId}/start`);
    expect(again.status).toBe(200);
    expect(events.filter((e) => e.kind === "started")).toHaveLength(1);
    expect(readSession(sessionId).phase).toBe("coding");
  });

  it("stores notes and candidate messages and pushes them over SSE", async () => {
    const stream = await openStream(`/api/events?session=${sessionId}`);
    try {
      const note = await post(`/api/sessions/${sessionId}/note`, {
        text: "Running sum over a window.",
      });
      expect(note.status).toBe(200);
      const message = await post(`/api/sessions/${sessionId}/message`, {
        text: "Can k be **zero**?",
      });
      expect(message.status).toBe(200);

      const frame = await stream.next((f) => f.type === "message");
      expect((frame.data as { from: string; html: string }).from).toBe("candidate");
      expect((frame.data as { html: string }).html).toContain("<strong>zero</strong>");
      expect(events.some((e) => e.kind === "note" && e.text === "Running sum over a window.")).toBe(
        true,
      );
    } finally {
      stream.close();
    }
  });

  it("validates bodies and caps their size", async () => {
    expect((await post(`/api/sessions/${sessionId}/message`, { text: 5 })).status).toBe(400);
    expect((await post(`/api/sessions/${sessionId}/message`, { text: "   " })).status).toBe(400);
    expect(
      (await send("PUT", `/api/sessions/${sessionId}/draft`, { code: "x".repeat(300 * 1024) }))
        .status,
    ).toBe(413);
    expect(
      (
        await fetch(`${baseUrl}/api/sessions/${sessionId}/message`, {
          method: "POST",
          body: "{nope",
        })
      ).status,
    ).toBe(400);
  });

  it("reveals hints in order and runs out", async () => {
    const first = (await (await post(`/api/sessions/${sessionId}/hint`)).json()) as {
      hint: { level: number };
      remaining: number;
    };
    expect(first.hint.level).toBe(1);
    expect(first.remaining).toBe(2);
    const second = (await (await post(`/api/sessions/${sessionId}/hint`)).json()) as {
      hint: { level: number };
    };
    expect(second.hint.level).toBe(2);
    await post(`/api/sessions/${sessionId}/hint`);
    expect((await post(`/api/sessions/${sessionId}/hint`)).status).toBe(404);
    expect(readSession(sessionId).hintsUsed).toEqual([1, 2, 3]);
  });
});

describe.skipIf(!pythonAvailable())("running code over HTTP", () => {
  const correct =
    "def max_window_sum(nums, k):\n    if k > len(nums):\n        return 0\n    s = sum(nums[:k]); best = s\n    for i in range(k, len(nums)):\n        s += nums[i] - nums[i - k]; best = max(best, s)\n    return best\n";
  const naive = "def max_window_sum(nums, k):\n    return sum(nums[:k])\n";

  it("runs the visible examples and streams results", async () => {
    const stream = await openStream(`/api/events?session=${sessionId}`);
    try {
      const res = await post(`/api/sessions/${sessionId}/run`, { code: correct });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        candidate: {
          passed: number;
          total: number;
          cases: Array<{ visible: boolean; input?: unknown; actual?: unknown }>;
        };
      };
      expect(body.candidate.passed).toBe(3);
      expect(body.candidate.total).toBe(3);
      expect(
        body.candidate.cases.every(
          (c) => c.visible && c.input !== undefined && c.actual !== undefined,
        ),
      ).toBe(true);

      const partial = await stream.next(
        (f) => f.type === "run" && (f.data as { partial?: unknown }).partial !== undefined,
      );
      expect((partial.data as { kind: string }).kind).toBe("visible");
      const final = await stream.next(
        (f) => f.type === "run" && (f.data as { result?: unknown }).result !== undefined,
      );
      expect((final.data as { result: { passed: number } }).result.passed).toBe(3);
    } finally {
      stream.close();
    }
  });

  it("runs custom input and rejects malformed arguments", async () => {
    const res = await post(`/api/sessions/${sessionId}/run`, {
      code: correct,
      custom: [{ nums: [5, 5], k: 2 }],
    });
    const body = (await res.json()) as {
      candidate: { cases: Array<{ id: string; actual: unknown }> };
    };
    expect(body.candidate.cases[0]).toMatchObject({ id: "custom-1", actual: 10 });

    const bad = await post(`/api/sessions/${sessionId}/run`, {
      code: correct,
      custom: [{ nums: [1] }],
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/missing argument k/);
  });

  it("submits against every case, reveals one failing hidden input, and never a generated one", async () => {
    const res = await post(`/api/sessions/${sessionId}/submit`, { code: naive });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      number: number;
      candidate: {
        passed: number;
        total: number;
        cases: Array<{
          id: string;
          visible: boolean;
          revealed?: boolean;
          input?: unknown;
          expected?: unknown;
        }>;
      };
    };
    expect(body.number).toBe(1);
    expect(body.candidate.total).toBe(12);
    expect(body.candidate.passed).toBeLessThan(12);

    const hidden = body.candidate.cases.filter((c) => !c.visible);
    const revealed = hidden.filter((c) => c.revealed);
    expect(revealed).toHaveLength(1);
    expect(revealed[0]?.id).toBe("best-at-end");
    expect(revealed[0]?.input).toEqual({ nums: [1, 1, 1, 1, 9, 9], k: 2 });
    expect(hidden.filter((c) => c.input !== undefined)).toHaveLength(1);
    expect(hidden.find((c) => c.id === "large-random")?.expected).toBeUndefined();

    const submission = events.find((e) => e.kind === "submission");
    expect(submission && submission.kind === "submission" && submission.result.total).toBe(12);
    expect(readSession(sessionId).submissions).toBe(1);
  });
});

describe("the dashboard stream", () => {
  it("tells an open dashboard to reload when a session starts", async () => {
    const other = createSession({
      problem: "window-sum",
      problemTitle: "Largest Window Sum",
      patterns: ["sliding-window"],
      difficulty: "easy",
      mode: "interview",
      timerMs: 60_000,
    }).id;
    const stream = await openStream("/api/events?scope=dashboard");
    try {
      await post(`/api/sessions/${other}/start`);
      const frame = await stream.next((f) => f.type === "reload");
      expect(frame.data).toEqual({ sessionId: other });
    } finally {
      stream.close();
    }
  });
});

describe("ending a session", () => {
  it("moves to follow-ups when the candidate is done and still allows runs", async () => {
    const res = await post(`/api/sessions/${sessionId}/done`);
    expect(res.status).toBe(200);
    expect(readSession(sessionId).phase).toBe("review");
    expect(events.some((e) => e.kind === "candidate_done")).toBe(true);
    expect((await post(`/api/sessions/${sessionId}/done`)).status).toBe(200);
  });
});
