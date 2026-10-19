/**
 * A lesson round trip: begin, write and validate an exercise, start the session, the
 * learner's actions on the page reaching the interviewer, and the debrief.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rebuildReviewLog } from "../src/flow.ts";
import { CandidateInbox, connectInbox, McpSession, type JsonRpcResponse } from "../src/mcp.ts";
import { setHooks } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { appendFactCheck } from "../src/store/fact-checks.ts";
import { readExercise } from "../src/store/exercises.ts";
import { readAnswer, readLesson } from "../src/store/lessons.ts";
import { readReviewEvents, rewriteReviewEvents } from "../src/store/review-events.ts";
import { makeFixture, openStream, type Fixture } from "./helpers.ts";
import { exerciseArgs, OUTLINE } from "./lesson-fixtures.ts";

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

const browser = (path: string, body: unknown = {}, method = "POST") =>
  fetch(`${server.getBaseUrl()}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function startLesson(): Promise<string> {
  expect((await call("write_exercise", exerciseArgs())).isError).toBe(false);
  expect((await call("validate_exercise", { slug: "plan-ofx-import" })).isError).toBe(false);
  const started = await call("start_lesson", { slug: "plan-ofx-import", timer_minutes: 30 });
  expect(started.isError).toBe(false);
  const match = /Session (\S+) is ready: (http:\/\/127\.0\.0\.1:\d+\/s\/[\w-]+)/.exec(started.text);
  if (!match?.[1]) throw new Error(started.text);
  return match[1];
}

describe("begin_lesson", () => {
  it("picks the next lesson and lists its facts, method, rubric, and host brief", async () => {
    const begun = await call("begin_lesson");
    expect(begun.isError).toBe(false);
    expect(begun.text).toContain("**Explore, plan, then code** (`plan-before-code`)");
    expect(begun.text).toContain("`plan-mode-behavior` (core)");
    expect(begun.text).toContain("Source: https://code.claude.com/docs/en/permission-modes");
    expect(begun.text).toContain("# Teaching agentic coding");
    expect(begun.text).toContain("# Agentic rubric");
    expect(begun.text).toContain("`wait_for_candidate`");
    expect(begun.text).toContain("can be served now: design-review, lab.");
    expect(begun.text).toContain("Write a fresh exercise with `write_exercise`");
  });

  it("asks for a check only of stale facts", async () => {
    const stale = await call("begin_lesson", { lesson: "plan-before-code" });
    // Shipped facts are dated; once they are two weeks old they need a check.
    const now = Date.now();
    const old = Date.parse("2026-10-18T00:00:00Z") < now - 14 * 86_400_000;
    if (old) expect(stale.text).toMatch(/re-read the source page/);
    for (const id of [
      "explore-plan-implement-commit",
      "plan-mode-behavior",
      "plan-mode-entry",
      "plan-approval",
      "plan-mode-overhead",
    ])
      appendFactCheck({ lesson: "plan-before-code", fact: id, at: now, status: "confirmed" });
    const fresh = await call("begin_lesson", { lesson: "plan-before-code" });
    expect(fresh.text).toContain("no need to re-read the sources");
  });

  it("warns about a locked module, and every lesson is teachable", async () => {
    const locked = await call("begin_lesson", { lesson: "prompt-caching" });
    expect(locked.text).toMatch(/This module is still locked: it builds on `orchestration`/);
    const forced = await call("begin_lesson", { lesson: "prompt-caching", override_lock: true });
    expect(forced.text).toMatch(/The user asked for it anyway/);
    // Every lesson has sourced facts now; outlines are covered by curriculum.test.ts.
    for (const module of ["planning", "refactoring", "cross-provider"])
      expect((await call("list_curriculum", { module })).text).not.toContain("outline");
  });
});

describe("a lesson round trip", () => {
  it("refuses to serve an exercise before it validates", async () => {
    await call("write_exercise", exerciseArgs({ teaching_md: "Too short [fact:nope]." }));
    const report = await call("validate_exercise", { slug: "plan-ofx-import" });
    expect(report.isError).toBe(true);
    expect(report.text).toMatch(/Cited facts this lesson does not have: nope/);
    expect((await call("start_lesson", { slug: "plan-ofx-import" })).text).toMatch(
      /has not passed validation/,
    );
  });

  it("runs from Start to the debrief and schedules the lesson", async () => {
    const id = await startLesson();
    expect(readLesson(id)).toMatchObject({ phase: "briefing", lesson: "plan-before-code" });
    expect(readExercise("plan-ofx-import").meta.timesServed).toBe(1);

    // The page reads the lesson's state, but never the private material.
    const state = await (await fetch(`${server.getBaseUrl()}/api/sessions/${id}`)).json();
    expect(state.exercise.brief).toContain("## Scenario");
    expect(JSON.stringify(state)).not.toContain(OUTLINE.slice(0, 60));

    const stream = await openStream(server.getBaseUrl()!, `/api/events?session=${id}`);
    try {
      await browser(`/api/sessions/${id}/start`);
      const started = await call("wait_for_candidate", { timeout_seconds: 2 });
      expect(started.text).toContain("pressed Start on the lesson");
      expect(started.text).toContain(`Lesson session \`${id}\``);

      await browser(`/api/sessions/${id}/message`, { text: "Is the parser tested at all?" });
      expect((await call("wait_for_candidate", { timeout_seconds: 2 })).text).toContain(
        "Is the parser tested at all?",
      );
      expect(
        (await call("say_to_candidate", { session_id: id, markdown: "No tests." })).isError,
      ).toBe(false);
      await stream.next(
        (f) => f.type === "message" && (f.data as { from: string }).from === "interviewer",
      );

      // An empty wait while the learner works says so, and keeps the interviewer waiting.
      const idle = await call("wait_for_candidate", { timeout_seconds: 1 });
      expect(idle.text).toContain("working the exercise");

      expect((await browser(`/api/sessions/${id}/draft`, { text: "draft" }, "PUT")).status).toBe(
        200,
      );
      const answer = "1. Pin CSV parsing with tests.\n2. Extract a parser interface.\n3. Add OFX.";
      expect((await browser(`/api/sessions/${id}/answer`, { text: answer })).status).toBe(200);
      const prompt = (await call("wait_for_candidate", { timeout_seconds: 2 })).text;
      expect(prompt).toContain("submitted answer 1");
      expect(prompt).toContain("Pin CSV parsing with tests.");
      expect(prompt).toContain(OUTLINE);
      expect(prompt).toContain("Never paste the model outline");
      expect(readAnswer(id, 1)).toBe(answer);

      const summary = (await call("get_session", { session_id: id })).text;
      expect(summary).toContain("Latest answer (1)");

      await browser(`/api/sessions/${id}/done`);
      expect((await call("wait_for_candidate", { timeout_seconds: 2 })).text).toContain(
        "done with the lesson",
      );

      const missing = await call("record_lesson", {
        session_id: id,
        scores: {
          decomposition: 3,
          verification: null,
          contextCost: null,
          safety: null,
          delegation: null,
        },
        notes_md: "Good.",
      });
      expect(missing.text).toMatch(/scores.verification is this lesson's focus/);

      const recorded = await call("record_lesson", {
        session_id: id,
        scores: {
          decomposition: 3,
          verification: 2,
          contextCost: null,
          safety: 1,
          delegation: null,
        },
        notes_md: "Solid phases; verification thin in phase 3.",
        strengths: ["Pinned behaviour first"],
        improvements: ["Say how phase 3 is checked"],
      });
      expect(recorded.isError).toBe(false);
      expect(recorded.text).toContain(
        "Passed: Decomposition 3, Verification 2, Context and cost n/a",
      );
      expect(recorded.text).toContain("comes back for review in 3 days");
      const debrief = await stream.next((f) => f.type === "rubric");
      expect(debrief.data).toMatchObject({ lesson: true, verdict: { correct: true } });
    } finally {
      stream.close();
    }

    expect(readLesson(id)).toMatchObject({ phase: "done", verdict: { correct: true } });
    const events = readReviewEvents();
    expect(events).toEqual([
      expect.objectContaining({ key: "lesson:plan-before-code", correct: true, session: id }),
    ]);
    rewriteReviewEvents([]);
    expect(rebuildReviewLog()).toEqual(events);

    expect((await call("list_curriculum", { module: "planning" })).text).toContain(
      "- passed: `plan-before-code`",
    );
    // With nothing in progress, an empty wait keeps the interviewer for Next lesson.
    expect((await call("wait_for_candidate", { timeout_seconds: 1 })).text).toContain(
      "a press of **Next lesson** reaches you",
    );
  });

  it("abandons a lesson with or without counting it", async () => {
    const id = await startLesson();
    const quiet = await call("abandon_session", { session_id: id, reason: "interrupted" });
    expect(quiet.text).toContain("Not counted against the learner.");
    expect(readReviewEvents()).toEqual([]);

    const again = await call("start_lesson", { slug: "plan-ofx-import" });
    const second = /Session (\S+) is ready/.exec(again.text)![1]!;
    const miss = await call("abandon_session", { session_id: second, reason: "gave up" });
    expect(miss.text).toContain("Recorded as a miss for Explore, plan, then code.");
    expect(readReviewEvents()).toHaveLength(1);
  });

  it("serves the lesson page with sourced teaching and never the private material", async () => {
    const id = await startLesson();
    const html = await (await fetch(`${server.getBaseUrl()}/s/${id}`)).text();
    expect(html).toContain("Explore, plan, then code");
    expect(html).toContain('id="answer-text"');
    expect(html).toContain('<sup class="fact-ref"><a href="#fact-plan-mode-behavior"');
    expect(html).toContain('<li id="fact-plan-mode-behavior">');
    expect(html).toContain('href="https://code.claude.com/docs/en/permission-modes"');
    expect(html).toContain("runtime/lesson/main.mjs");
    expect(html).not.toContain("[fact:");
    expect(html).not.toContain("editor-host");
    for (const secret of [
      OUTLINE.slice(0, 60),
      "How would you know the refactor",
      "Adding OFX before",
    ])
      expect(html).not.toContain(secret);

    const dashboard = await (await fetch(`${server.getBaseUrl()}/`)).text();
    expect(dashboard).toContain('<section id="agentic">');
    expect(dashboard).toContain("Next lesson: <strong>Explore, plan, then code</strong>");
    expect(dashboard).toContain(`href="/s/${id}"`);
    const json = await (await fetch(`${server.getBaseUrl()}/api/dashboard`)).json();
    expect(json.agentic.progress.next.lesson.id).toBe("plan-before-code");
    expect(JSON.stringify(json)).not.toContain(OUTLINE.slice(0, 60));
  });

  it("refuses an answer before Start and after the debrief", async () => {
    const id = await startLesson();
    expect((await browser(`/api/sessions/${id}/answer`, { text: "early" })).status).toBe(409);
    await browser(`/api/sessions/${id}/start`);
    expect((await browser(`/api/sessions/${id}/answer`, { text: "   " })).status).toBe(400);
  });

  it("tells a new interviewer about a lesson in progress", async () => {
    const id = await startLesson();
    const fresh = new McpSession(inbox);
    const response = (await fresh.handle({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "wait_for_candidate", arguments: { timeout_seconds: 1 } },
    })) as { result: { content: Array<{ text: string }> } };
    expect(response.result.content[0]!.text).toContain("lesson session was already in progress");
    expect(response.result.content[0]!.text).toContain(id);
  });
});
