/**
 * The Next lesson button: after a debrief the interviewer stays, a press reaches it,
 * and the lesson it starts sends the waiting pages there.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CandidateInbox, connectInbox, McpSession, type JsonRpcResponse } from "../src/mcp.ts";
import { clearNextLesson, nextLesson, pendingNextLesson } from "../src/next-lesson.ts";
import { setHooks } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { makeFixture, openStream, type Fixture } from "./helpers.ts";
import { exerciseArgs } from "./lesson-fixtures.ts";

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
  clearNextLesson();
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

describe("Next lesson", () => {
  it("names the next lesson and a prepared exercise", async () => {
    expect(nextLesson()).toMatchObject({ lesson: "plan-before-code", prepared: null });
    await call("write_exercise", exerciseArgs());
    await call("validate_exercise", { slug: "plan-ofx-import" });
    expect(nextLesson()?.prepared).toBe("plan-ofx-import");
  });

  it("asks the interviewer to write the next lesson ahead, stays, and follows a press", async () => {
    await call("write_exercise", exerciseArgs());
    await call("validate_exercise", { slug: "plan-ofx-import" });
    const started = await call("start_lesson", { slug: "plan-ofx-import" });
    const id = /Session (\S+) is ready/.exec(started.text)![1]!;
    await post(`/api/sessions/${id}/start`);
    await post(`/api/sessions/${id}/answer`, { text: "Pin CSV parsing first, then OFX." });
    const recorded = await call("record_lesson", {
      session_id: id,
      scores: {
        decomposition: 3,
        verification: 3,
        contextCost: null,
        safety: null,
        delegation: null,
      },
      notes_md: "Good.",
    });
    expect(recorded.text).toContain("**Next lesson** button");
    expect(recorded.text).toContain("CLAUDE.md, AGENTS.md, and progress files");

    // The page shows the row under the debrief; an empty wait keeps the interviewer.
    const page = await (await fetch(`${server.getBaseUrl()}/s/${id}`)).text();
    expect(page).toContain('data-url="/api/curriculum/next"');
    expect(page).toContain(
      "Next lesson: <strong>CLAUDE.md, AGENTS.md, and progress files</strong>",
    );
    expect((await call("wait_for_candidate", { timeout_seconds: 1 })).text).toContain(
      "a press of **Next lesson** reaches you",
    );

    const stream = await openStream(server.getBaseUrl()!, `/api/events?session=${id}`);
    try {
      const pressed = await (await post("/api/curriculum/next", { from: id })).json();
      expect(pressed.next.lesson).toBe("context-files");
      expect(pendingNextLesson()).not.toBeNull();
      const prompt = (await call("wait_for_candidate", { timeout_seconds: 2 })).text;
      expect(prompt).toContain("pressed **Next lesson**");
      expect(prompt).toContain("`begin_lesson` with lesson `context-files`");

      // Starting any lesson answers the press and sends the page there.
      await call("write_exercise", exerciseArgs({ slug: "plan-a-second-thing" }));
      await call("validate_exercise", { slug: "plan-a-second-thing" });
      const second = await call("start_lesson", { slug: "plan-a-second-thing" });
      const secondId = /Session (\S+) is ready/.exec(second.text)![1]!;
      const frame = await stream.next((f) => f.type === "next_session");
      expect(frame.data).toEqual({ sessionId: secondId, url: `/s/${secondId}` });
      expect(pendingNextLesson()).toBeNull();
    } finally {
      stream.close();
    }
  });

  it("refuses a press from a session that is not a lesson", async () => {
    await server.start();
    expect((await post("/api/curriculum/next", { from: "nope" })).status).toBe(400);
  });
});
