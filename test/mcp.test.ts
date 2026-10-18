/**
 * The MCP server: JSON-RPC dispatch, the candidate inbox, and the full round trip
 * from a browser action to `wait_for_candidate` and back to the page.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVE_WINDOW_MS,
  CandidateInbox,
  connectInbox,
  DEFAULT_WAIT_SECONDS,
  HOST_BRIEF,
  MAX_WAIT_SECONDS,
  McpSession,
  waitSeconds,
  type JsonRpcResponse,
} from "../src/mcp.ts";
import { clearNext, nextWindow, NEXT_WINDOW_MS } from "../src/next-up.ts";
import { setHooks } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { readProblem, updateMeta } from "../src/store/problems.ts";
import { DAY_MS } from "../src/review.ts";
import { appendReviewEvents, readReviewEvents } from "../src/store/review-events.ts";
import { readSession } from "../src/store/sessions.ts";
import { makeFixture, openStream, seedExample, type Fixture } from "./helpers.ts";

let fixture: Fixture;
let inbox: CandidateInbox;
let session: McpSession;
let nextId = 1;

beforeEach(() => {
  process.env["CHUDCODE_AUTO_OPEN"] = "0";
  fixture = makeFixture();
  seedExample();
  inbox = new CandidateInbox();
  session = new McpSession(inbox);
  connectInbox(inbox);
});

afterEach(async () => {
  inbox.reset();
  clearNext();
  await server.close();
  setHooks({});
  fixture.cleanup();
});

function request(method: string, params?: unknown): Promise<JsonRpcResponse | null> {
  return session.handle({ jsonrpc: "2.0", id: nextId++, method, params });
}

interface CallResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallResult & { details?: unknown }> {
  const response = await request("tools/call", { name, arguments: args });
  if (!response || !("result" in response)) throw new Error(JSON.stringify(response));
  return response.result as CallResult;
}

const text = (result: CallResult) => result.content.map((c) => c.text).join("\n");

const browser = (path: string, body: unknown = {}, method = "POST") =>
  fetch(`${server.getBaseUrl()}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function startSession(extra: Record<string, unknown> = {}): Promise<string> {
  const started = await call("start_session", { slug: "window-sum", timer_minutes: 30, ...extra });
  expect(started.isError).toBe(false);
  const match = /Session (\S+) is ready/.exec(text(started));
  if (!match?.[1]) throw new Error(text(started));
  return match[1];
}

const NAIVE = "def max_window_sum(nums, k):\n    return sum(nums[:k])\n";
const CORRECT =
  "def max_window_sum(nums, k):\n    if k > len(nums):\n        return 0\n    s = sum(nums[:k]); b = s\n    for i in range(k, len(nums)):\n        s += nums[i] - nums[i - k]; b = max(b, s)\n    return b\n";

// ── Inbox ─────────────────────────────────────────────────────────────────────

describe("CandidateInbox", () => {
  it("queues prompts until someone waits, then hands over everything at once", async () => {
    const box = new CandidateInbox();
    box.push("one");
    box.push("two");
    expect(box.size).toBe(2);
    expect(await box.wait(1, 100)).toEqual(["one", "two"]);
    expect(box.size).toBe(0);
  });

  it("deduplicates by key and drops prompts whose pending check fails", async () => {
    const box = new CandidateInbox();
    box.push("a", "k1");
    box.push("a again", "k1");
    let live = true;
    box.push("b", "k2", () => live);
    live = false;
    expect(await box.wait(1, 100)).toEqual(["a"]);
  });

  it("wakes the waiter when a prompt arrives and times out with nothing otherwise", async () => {
    const box = new CandidateInbox();
    const pending = box.wait(1, 2_000);
    expect(box.listening).toBe(true);
    box.push("hello");
    expect(await pending).toEqual(["hello"]);
    expect(box.listening).toBe(false);
    expect(await box.wait(2, 20)).toEqual([]);
  });

  it("counts as connected while waiting or just after a tool call, until it is released", async () => {
    const box = new CandidateInbox();
    expect(box.connected()).toBe(false);
    box.touch(1_000);
    expect(box.connected(2_000)).toBe(true);
    expect(box.connected(1_000 + ACTIVE_WINDOW_MS)).toBe(false);
    box.release();
    expect(box.connected(2_000)).toBe(false);
    const pending = box.wait(1, 2_000);
    expect(box.connected()).toBe(true);
    box.push("x");
    await pending;
    box.reset();
  });

  it("resolves a cancelled wait with null and never loses the prompt", async () => {
    const box = new CandidateInbox();
    const pending = box.wait(7, 2_000);
    box.cancel(7);
    expect(await pending).toBeNull();
    box.push("late");
    expect(await box.wait(8, 100)).toEqual(["late"]);
  });

  it("lets a new wait supersede an abandoned one", async () => {
    const box = new CandidateInbox();
    const abandoned = box.wait(1, 5_000);
    const fresh = box.wait(2, 5_000);
    expect(await abandoned).toEqual([]);
    box.push("event");
    expect(await fresh).toEqual(["event"]);
  });

  it("reports listening changes and summarises silent runs", () => {
    const box = new CandidateInbox();
    const seen: boolean[] = [];
    box.setListeningListener((listening) => seen.push(listening));
    void box.wait(1, 50);
    box.push("x");
    expect(seen).toEqual([true, false]);
    box.recordRun("s1", "visible", 1, 3);
    box.recordRun("s1", "visible", 2, 3);
    expect(box.takeDigest()).toContain("ran the examples 2 times (last 2/3 passed)");
    expect(box.takeDigest()).toBe("");
  });
});

// ── Protocol ──────────────────────────────────────────────────────────────────

describe("protocol", () => {
  it("echoes a supported protocol version and names itself", async () => {
    const response = await request("initialize", { protocolVersion: "2025-06-18" });
    const result = (response as { result: Record<string, unknown> }).result;
    expect(result["protocolVersion"]).toBe("2025-06-18");
    expect(result["capabilities"]).toEqual({ tools: {} });
    expect((result["serverInfo"] as { name: string }).name).toBe("chudcode");
    const unknown = await request("initialize", { protocolVersion: "1999-01-01" });
    expect((unknown as { result: Record<string, unknown> }).result["protocolVersion"]).toBe(
      "2025-11-25",
    );
  });

  it("lists every tool", async () => {
    const response = await request("tools/list");
    const tools = (response as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "abandon_session",
      "begin_interview",
      "get_session",
      "list_due",
      "list_problems",
      "list_roadmap",
      "list_trends",
      "lookup_seed",
      "open_dashboard",
      "record_session",
      "record_trends",
      "reveal_hint",
      "run_tests",
      "say_to_candidate",
      "start_session",
      "validate_problem",
      "wait_for_candidate",
      "write_problem",
    ]);
    expect(session.toolNames().sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it("ignores notifications and rejects unknown methods and tools", async () => {
    expect(
      await session.handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();
    expect(await request("resources/list")).toMatchObject({ error: { code: -32601 } });
    expect(await request("tools/call", { name: "nope" })).toMatchObject({
      error: { code: -32602 },
    });
  });

  it("turns bad arguments into tool errors, not protocol errors", async () => {
    const missing = await call("start_session");
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("Missing required argument: slug");
    const unknown = await call("start_session", { slug: "nope" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain("No problem named nope");
    const badMode = await call("begin_interview", { mode: "exam" });
    expect(text(badMode)).toContain("mode must be one of");
    const badPattern = await call("begin_interview", { pattern: "dynamic-sliding" });
    expect(text(badPattern)).toContain("Unknown pattern id");
  });

  it("refuses to wait before the server runs", async () => {
    const result = await call("wait_for_candidate", { timeout_seconds: 1 });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("start_session");
  });

  it("bounds the wait", () => {
    expect(waitSeconds(undefined)).toBe(DEFAULT_WAIT_SECONDS);
    expect(waitSeconds(5)).toBe(5);
    expect(() => waitSeconds(0)).toThrow(/1 to/);
    expect(() => waitSeconds(MAX_WAIT_SECONDS + 1)).toThrow(/1 to/);
    expect(() => waitSeconds("5")).toThrow(/1 to/);
  });
});

// ── Round trip ────────────────────────────────────────────────────────────────

describe("an interview round trip", () => {
  it("imports the bundled examples into an empty state directory", async () => {
    fixture.cleanup();
    fixture = makeFixture();
    const listed = text(await call("list_problems"));
    expect(listed).toContain("`window-sum`: Largest Window Sum");
    expect(readProblem("window-sum").tests).toHaveLength(12);
  });

  it("begins with the method, the rubric, and the host brief", async () => {
    const brief = text(
      await call("begin_interview", { pattern: "sliding-window", difficulty: "easy" }),
    );
    expect(brief).toContain("pattern **sliding-window**");
    expect(brief).toContain("None yet. This is the candidate's first session.");
    expect(brief).toContain(
      "`window-sum`: Largest Window Sum (easy; sliding-window) — validated, served 0 times",
    );
    expect(brief).toContain("## Due for review");
    expect(brief).toContain("Nothing is due: no session has been recorded yet.");
    expect(brief).toContain("# Interviewing");
    expect(brief).toContain("# Rubric");
    expect(brief).toContain(HOST_BRIEF);
  });

  it("lists what is due and steers a review session at the most overdue pattern", async () => {
    const now = Date.now();
    appendReviewEvents([
      {
        key: "pattern:stack",
        at: now - 9 * DAY_MS,
        correct: false,
        session: "20260101-0900-a-0001",
      },
      { key: "problem:a", at: now - 9 * DAY_MS, correct: false, session: "20260101-0900-a-0001" },
      { key: "pattern:heap", at: now - 4 * DAY_MS, correct: true, session: "20260105-0900-b-0002" },
      { key: "pattern:graphs", at: now - DAY_MS, correct: true, session: "20260108-0900-c-0003" },
    ]);
    const due = await call("list_due");
    expect(due.isError).toBe(false);
    const listed = text(due);
    expect(listed).toMatch(/^## Due for review/);
    expect(listed).toContain("- stack: box 0, 8 days overdue; missed 9 days ago, 1 attempt");
    expect(listed).toContain("- heap: box 1, 1 day overdue; solved 4 days ago, 1 attempt");
    expect(listed).not.toContain("- a:");
    expect(listed).toContain("Due soon: graphs in 2 days.");
    expect(listed).toContain("Streak: 1 day.");
    expect(listed).toContain("0 of 21 patterns mastered; 3 patterns exercised so far.");

    const limited = await call("list_due", { limit: 1 });
    expect(text(limited)).toContain("…and 1 more");

    const review = text(await call("begin_interview", { mode: "review" }));
    expect(review).toContain(
      "Serve **stack**: it is 8 days overdue in box 0, last missed 9 days ago.",
    );
    expect(review).toContain("`source.kind` set to `review`");
    const other = text(await call("begin_interview", { mode: "review", pattern: "graphs" }));
    expect(other).toContain("**graphs** is not due. stack is the most overdue pattern");
    const plain = text(await call("begin_interview"));
    expect(plain).toContain("2 patterns are due for spaced review");
  });

  it("runs a session from Start to the debrief", async () => {
    const id = await startSession();
    expect(server.isRunning()).toBe(true);
    expect(readSession(id)).toMatchObject({ phase: "briefing", timerMs: 30 * 60_000 });
    expect(readProblem("window-sum").meta.timesServed).toBe(1);

    const stream = await openStream(server.getBaseUrl()!, `/api/events?session=${id}`);
    try {
      // The candidate presses Start: the interviewer is told, and the page learns whether anyone listens.
      await browser(`/api/sessions/${id}/note`, { text: "Running sum, slide the window." });
      await browser(`/api/sessions/${id}/start`);
      const started = text(await call("wait_for_candidate", { timeout_seconds: 2 }));
      expect(started).toContain("pressed Start");
      expect(started).toContain('"Running sum, slide the window."');
      expect(started).toContain("`say_to_candidate`");
      expect(started).toContain(`Session \`${id}\``);

      // Presence: a live wait shows as "listening"; its end shows as not listening.
      const pending = call("wait_for_candidate", { timeout_seconds: 3 });
      await stream.next(
        (f) => f.type === "presence" && (f.data as { listening: boolean }).listening === true,
      );
      await browser(`/api/sessions/${id}/message`, { text: "Can k be zero?" });
      const asked = text(await pending);
      expect(asked).toContain("Can k be zero?");
      await stream.next(
        (f) => f.type === "presence" && (f.data as { listening: boolean }).listening === false,
      );

      // The interviewer replies and the page receives it.
      const said = await call("say_to_candidate", {
        session_id: id,
        markdown: "k is **at least 1**.",
      });
      expect(said.isError).toBe(false);
      const frame = await stream.next(
        (f) => f.type === "message" && (f.data as { from: string }).from === "interviewer",
      );
      expect(frame.data).toMatchObject({ from: "interviewer" });
      expect((frame.data as { html: string }).html).toContain("<strong>at least 1</strong>");

      // A failing submission: the interviewer sees the hidden case, the candidate does not.
      const submitted = await browser(`/api/sessions/${id}/submit`, { code: NAIVE });
      expect(submitted.status).toBe(200);
      const result = text(await call("wait_for_candidate", { timeout_seconds: 2 }));
      expect(result).toContain("submitted (submission 1)");
      expect(result).toContain("best-at-end (hidden): fail");
      expect(result).toContain("input: nums = [1, 1, 1, 1, 9, 9], k = 2");
      expect(result).toContain("expected: 18");
      expect(result).toContain("got: 2");
      expect(result).toContain("generated by `large(100000, 33333)`");
      expect(result).toContain("Not every case passed");

      // Hints from both sides are recorded.
      const hinted = await call("reveal_hint", { session_id: id });
      expect(text(hinted)).toContain("Revealed hint 1");
      await browser(`/api/sessions/${id}/hint`);
      expect(text(await call("wait_for_candidate", { timeout_seconds: 2 }))).toContain(
        "took hint 2",
      );
      expect(readSession(id).hintsUsed).toEqual([1, 2]);

      // The interviewer runs the draft without touching the page.
      const ran = text(await call("run_tests", { session_id: id, cases: "visible" }));
      expect(ran.startsWith("1/3 passed")).toBe(true);
      const custom = text(
        await call("run_tests", { session_id: id, custom: [{ nums: [5, 5], k: 2 }] }),
      );
      expect(custom).toContain("1/1 passed");

      // State for the interviewer, with code on request.
      const state = text(await call("get_session", { session_id: id, include_code: true }));
      expect(state).toContain("Hints revealed: 1");
      expect(state).toContain("Candidate: Can k be zero?");
      expect(state).toContain("return sum(nums[:k])");

      // The candidate finishes; the debrief lands on the page and in the review log.
      await browser(`/api/sessions/${id}/done`);
      expect(text(await call("wait_for_candidate", { timeout_seconds: 2 }))).toContain(
        "says they are done",
      );
      const recorded = await call("record_session", {
        session_id: id,
        rubric: { correctness: 1, communication: 3, complexity: 2, code_quality: 2, time: 2 },
        complexity_ok: false,
        notes_md: "A clear plan, but the window never slid.",
        strengths: ["Stated the approach before coding.", "Asked about the bounds of k."],
        improvements: [
          "Trace the second window by hand before submitting.",
          "Say the complexity unprompted.",
        ],
      });
      expect(recorded.isError).toBe(false);
      expect(text(recorded)).toContain(
        "Verdict: not solved (not all cases passed, within time, complexity below target)",
      );
      expect(text(recorded)).toContain("sliding-window comes back for review tomorrow (box 0)");

      const rubric = await stream.next((f) => f.type === "rubric");
      expect((rubric.data as { verdict: { correct: boolean } }).verdict.correct).toBe(false);
      expect((rubric.data as { notesHtml: string }).notesHtml).toContain("the window never slid");

      const after = readSession(id);
      expect(after.phase).toBe("done");
      expect(after.rubric?.strengths).toHaveLength(2);
      const events = readReviewEvents();
      expect(events.map((e) => e.key).sort()).toEqual([
        "pattern:sliding-window",
        "problem:window-sum",
      ]);
      expect(events.every((e) => e.correct === false && e.hintsUsed === 2)).toBe(true);

      const again = await call("record_session", {
        session_id: id,
        rubric: { correctness: 4, communication: 4, complexity: 4, code_quality: 4, time: 4 },
        complexity_ok: true,
        notes_md: "x",
        strengths: ["a", "b"],
        improvements: ["c", "d"],
      });
      expect(again.isError).toBe(true);
      expect(text(again)).toContain("already recorded");
    } finally {
      stream.close();
    }
  }, 30_000);

  it("serves the next roadmap problem and checks it off when it is solved", async () => {
    const brief = text(await call("begin_interview", { mode: "roadmap" }));
    expect(brief).toContain("the next problem on the NeetCode 150 roadmap");
    expect(brief).toContain("## Roadmap: NeetCode 150");
    expect(brief).toContain("Serve **Contains Duplicate** (easy; arrays-hashing)");
    expect(brief).toContain('`mimic_of` to "Contains Duplicate" exactly');
    const grind = text(await call("begin_interview", { mode: "roadmap", roadmap: "grind75" }));
    expect(grind).toContain(
      "Serve **Two Sum** (easy; arrays-hashing), the next problem in Week 1.",
    );
    const badStage = await call("begin_interview", { mode: "roadmap", stage: "week-1" });
    expect(badStage.isError).toBe(true);
    expect(text(badStage)).toContain("Stages: arrays-hashing, two-pointers");

    const unlisted = text(await call("start_session", { slug: "window-sum", mode: "roadmap" }));
    expect(unlisted).toContain("names no roadmap problem, so solving it checks nothing off");
    const stray = /Session (\S+) is ready/.exec(unlisted)?.[1];
    await call("abandon_session", { session_id: stray, reason: "interrupted" });

    updateMeta("window-sum", { source: { kind: "mimic", mimicOf: "Contains Duplicate" } });
    const id = await startSession({ start_now: true, mode: "roadmap" });
    expect(readSession(id).mode).toBe("roadmap");
    await browser(`/api/sessions/${id}/submit`, { code: CORRECT });
    expect(text(await call("wait_for_candidate", { timeout_seconds: 2 }))).toContain(
      "Every case passed",
    );
    const recorded = text(
      await call("record_session", {
        session_id: id,
        rubric: { correctness: 4, communication: 3, complexity: 3, code_quality: 3, time: 4 },
        complexity_ok: true,
        notes_md: "Clean.",
        strengths: ["a", "b"],
        improvements: ["c", "d"],
      }),
    );
    expect(recorded).toContain(
      "NeetCode 150: Contains Duplicate is checked off; 1 of 150 solved. Next: Valid Anagram (Arrays & Hashing).",
    );
    // Contains Duplicate is on Grind 75 too, so it counts there as well.
    expect(recorded).toMatch(
      /Grind 75: Contains Duplicate is checked off; 1 of 75 solved\. Next: Two Sum \(Week 1\)\./,
    );
    expect(recorded).toContain("and where they stand on the roadmap");
    expect(recorded).toContain(
      "Now write the next step ahead of time, so the candidate's **Next problem** button opens it at once: **Valid Anagram** (easy) in Arrays & Hashing.",
    );
    expect(recorded).toContain("Keep waiting until the wait says the window has closed");

    // After the debrief the interviewer stays: an empty wait keeps the window open.
    const idle = text(await call("wait_for_candidate", { timeout_seconds: 1 }));
    expect(idle).toContain("a press of **Next problem** reaches you through this wait");
    expect(idle).toContain("the window closes in 10 minutes");
    expect(inbox.connected()).toBe(true);
    const window = nextWindow();
    expect(window).toMatchObject({ roadmap: "neetcode150", name: "NeetCode 150" });
    expect(nextWindow(undefined, Date.now() + NEXT_WINDOW_MS)).toBeNull();

    const listed = await call("list_roadmap");
    expect(text(listed)).toContain("1 of 150 solved.");
    expect(text(listed)).toContain("- `arrays-hashing` open · Arrays & Hashing 1/9");
    expect(text(listed)).toContain(
      "- `two-pointers` locked · Two Pointers 0/5 (locked: needs 5/9 of Arrays & Hashing)",
    );
    const stage = text(await call("list_roadmap", { stage: "arrays-hashing" }));
    expect(stage).toContain("- solved: Contains Duplicate (easy)");
    expect(stage).toContain("- new: Valid Anagram (easy)");
    expect((await call("list_roadmap", { stage: "nope" })).isError).toBe(true);
  }, 15_000);

  it("tells an idle interviewer with nothing to answer to stop, and stops counting it connected", async () => {
    await call("open_dashboard");
    expect(inbox.connected()).toBe(true);
    const idle = text(await call("wait_for_candidate", { timeout_seconds: 1 }));
    expect(idle).toContain("nobody is waiting on the page. End your turn");
    expect(inbox.connected()).toBe(false);
  });

  it("takes a Next problem press from the page to the interviewer and the page to the new session", async () => {
    updateMeta("window-sum", { source: { kind: "mimic", mimicOf: "Contains Duplicate" } });
    await call("open_dashboard");
    const dashboard = await openStream(server.getBaseUrl()!, "/api/events?scope=dashboard");
    try {
      expect((await browser("/api/roadmaps/nope/next")).status).toBe(404);
      const pressed = await browser("/api/roadmaps/neetcode150/next");
      expect(pressed.status).toBe(200);
      const body = (await pressed.json()) as {
        request: { roadmap: string };
        next: { title: string; prepared: string | null };
        connected: boolean;
      };
      expect(body.request.roadmap).toBe("neetcode150");
      expect(body.next).toMatchObject({ title: "Contains Duplicate", prepared: "window-sum" });
      expect(body.connected).toBe(true);
      await dashboard.next((f) => f.type === "next");
      // A second press changes nothing and does not queue a second prompt.
      await browser("/api/roadmaps/neetcode150/next");

      const told = text(await call("wait_for_candidate", { timeout_seconds: 2 }));
      expect(told).toContain("pressed **Next problem** for NeetCode 150");
      expect(told).toContain("You already wrote and validated `window-sum`");
      expect(told).not.toContain("events arrived");

      const id = await startSession({ mode: "roadmap" });
      expect(readSession(id).roadmap).toBe("neetcode150");
      const sent = await dashboard.next((f) => f.type === "next_session");
      expect(sent.data).toEqual({ sessionId: id, url: `/s/${id}` });

      // Answered: a fresh press for the same step has nothing prepared any more.
      const again = (await (await browser("/api/roadmaps/neetcode150/next")).json()) as {
        next: { prepared: string | null };
      };
      expect(again.next.prepared).toBeNull();
    } finally {
      dashboard.close();
    }
  }, 15_000);

  it("marks a solved session correct and schedules its pattern further out", async () => {
    const id = await startSession({ start_now: true });
    expect(readSession(id).phase).toBe("coding");
    await browser(`/api/sessions/${id}/submit`, { code: CORRECT });
    expect(text(await call("wait_for_candidate", { timeout_seconds: 2 }))).toContain(
      "Every case passed",
    );
    const recorded = text(
      await call("record_session", {
        session_id: id,
        rubric: { correctness: 4, communication: 2, complexity: 3, code_quality: 3, time: 4 },
        complexity_ok: true,
        notes_md: "Clean.",
        strengths: ["a", "b"],
        improvements: ["c", "d"],
      }),
    );
    expect(recorded).toContain("Verdict: solved");
    expect(recorded).toContain("comes back for review in 3 days (box 1)");
    expect(readSession(id).verdict).toEqual({
      correct: true,
      allPassed: true,
      withinTime: true,
      complexityOk: true,
    });
  }, 15_000);

  it("reports silent runs in the digest and sessions in progress when nothing arrives", async () => {
    const id = await startSession({ start_now: true });
    await browser(`/api/sessions/${id}/run`, { code: NAIVE });
    await browser(`/api/sessions/${id}/run`, { code: CORRECT });
    const quiet = text(await call("wait_for_candidate", { timeout_seconds: 1 }));
    expect(quiet).toContain("Nothing from the candidate in 1 seconds");
    expect(quiet).toContain(`Session \`${id}\``);
    expect(quiet).toContain("ran the examples 2 times (last 3/3 passed)");
    expect(quiet).toContain("The candidate is working");
  }, 15_000);

  it("recovers a session in progress and its unanswered message for a new interviewer", async () => {
    const id = await startSession({ start_now: true });
    await browser(`/api/sessions/${id}/message`, { text: "Is the array sorted?" });
    inbox.reset();

    const freshInbox = new CandidateInbox();
    const fresh = new McpSession(freshInbox);
    connectInbox(freshInbox);
    const response = await fresh.handle({
      jsonrpc: "2.0",
      id: 999,
      method: "tools/call",
      params: { name: "wait_for_candidate", arguments: { timeout_seconds: 1 } },
    });
    const recovered = (response as { result: CallResult }).result.content[0]?.text ?? "";
    expect(recovered).toContain("already in progress");
    expect(recovered).toContain("Is the array sorted?");

    const second = await fresh.handle({
      jsonrpc: "2.0",
      id: 1000,
      method: "tools/call",
      params: { name: "wait_for_candidate", arguments: { timeout_seconds: 1 } },
    });
    expect((second as { result: CallResult }).result.content[0]?.text).toContain(
      "Nothing from the candidate",
    );
    freshInbox.reset();
  }, 15_000);

  it("abandons a session with or without counting it against the candidate", async () => {
    const first = await startSession();
    const interrupted = text(
      await call("abandon_session", { session_id: first, reason: "interrupted" }),
    );
    expect(interrupted).toContain("Not counted against the candidate");
    expect(readReviewEvents()).toHaveLength(0);

    const second = await startSession();
    const quit = text(await call("abandon_session", { session_id: second, reason: "gave up" }));
    expect(quit).toContain("Recorded as a miss for sliding-window");
    expect(readReviewEvents().filter((e) => e.key === "pattern:sliding-window")).toHaveLength(1);
    expect(readSession(second)).toMatchObject({ phase: "done", abandonedReason: "gave up" });
  }, 15_000);

  it("resolves a cancelled wait with no response", async () => {
    await startSession();
    const pending = request("tools/call", {
      name: "wait_for_candidate",
      arguments: { timeout_seconds: 5 },
    });
    const requestId = nextId - 1;
    await session.handle({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId },
    });
    expect(await pending).toBeNull();
  });
});
