/**
 * A phone screen round trip: the interviewer begins and starts a call, asks graded
 * questions, the learner answers by voice and by typing on the page, and the call is
 * scored per dimension and per answer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CandidateInbox, connectInbox, McpSession, type JsonRpcResponse } from "../src/mcp.ts";
import { setHooks } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { readPhoneSession, readStories, recordBriefs } from "../src/store/phone.ts";
import { readReviewEvents } from "../src/store/review-events.ts";
import { makeFixture, openStream, type Fixture } from "./helpers.ts";

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

const post = (url: string, body: unknown = {}) =>
  fetch(`${server.getBaseUrl()}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("phone screens", () => {
  it("briefs a fundamentals call with topics weakest first and the company's screens", async () => {
    recordBriefs([
      {
        company: "Stripe",
        format: "fundamentals",
        minutes: 20,
        seenAt: "2026-07-01",
        sourceUrl: "https://example.com/a",
        note: "Rapid questions on HTTP, databases, and concurrency.",
        topics: ["networking", "databases"],
      },
    ]);
    const brief = (await call("begin_phone_screen", { format: "fundamentals", company: "stripe" }))
      .text;
    expect(brief).toContain("# CS fundamentals for stripe");
    expect(brief).toContain(
      "Rapid questions on HTTP, databases, and concurrency. (topics: networking, databases)",
    );
    expect(brief).toContain("`networking` Networking and the web");
    expect(brief).toContain("# Running a phone screen");
    expect(brief).toContain("# Phone screen rubric");
    const none = (await call("begin_phone_screen", { format: "behavioral", company: "Acme" })).text;
    expect(none).toContain("Nothing on file.");
    expect(none).toContain("Empty. Save the stories they tell well");
    expect(none).toContain("No story yet for: conflict, failure");
  });

  it("runs a call from Start to a scored debrief", async () => {
    const started = await call("start_phone_screen", { format: "behavioral", company: "Stripe" });
    const id = /Session (\S+) is ready: (\S+)/.exec(started.text)?.[1];
    if (!id) throw new Error(started.text);
    expect((await fetch(`${server.getBaseUrl()}/s/${id}`)).status).toBe(200);
    expect((await post(`/api/sessions/${id}/reply`, { text: "hi" })).status).toBe(409);

    await post(`/api/sessions/${id}/start`);
    const startPrompt = (await call("wait_for_candidate", { timeout_seconds: 2 })).text;
    expect(startPrompt).toContain("pressed Start the call");
    expect(startPrompt).toContain("`ask_question`");

    // Small talk before any question is a message, not an answer.
    expect(
      await (await post(`/api/sessions/${id}/reply`, { text: "Hi, thanks for having me." })).json(),
    ).toEqual({ n: null });
    expect((await call("wait_for_candidate", { timeout_seconds: 2 })).text).toContain(
      "before any question",
    );

    const stream = await openStream(server.getBaseUrl()!, `/api/events?session=${id}`);
    try {
      expect(
        (
          await call("ask_question", {
            session_id: id,
            question: "Tell me about a time you missed a deadline.",
            topic: "x",
          })
        ).text,
      ).toContain("Only fundamentals questions take a topic");
      await call("ask_question", {
        session_id: id,
        question: "Tell me about a time you missed a deadline.",
      });
      const asked = await stream.next((f) => f.type === "question");
      expect(asked.data).toMatchObject({
        n: 1,
        text: "Tell me about a time you missed a deadline.",
      });

      const spoken =
        "Um, at my internship we, uh, shipped late because I underestimated the migration. I told my lead early and we cut scope.";
      expect(
        await (
          await post(`/api/sessions/${id}/reply`, {
            text: spoken,
            spoken: true,
            durationMs: 15_000,
            longPauses: 1,
          })
        ).json(),
      ).toEqual({ n: 1 });
      const replied = await stream.next((f) => f.type === "reply");
      expect(replied.data).toMatchObject({
        n: 1,
        delivery: expect.stringContaining("spoken for 15 s"),
      });
      const replyPrompt = (await call("wait_for_candidate", { timeout_seconds: 2 })).text;
      expect(replyPrompt).toContain("Question 1: Tell me about a time you missed a deadline.");
      expect(replyPrompt).toContain("fillers: uh ×1, um ×1");
      expect(replyPrompt).toContain("1 pause over 3 s");

      // A follow-up's answer belongs to the same question.
      await call("say_to_candidate", { session_id: id, markdown: "What was the **result**?" });
      const said = await stream.next((f) => f.type === "message");
      expect(said.data).toMatchObject({ from: "interviewer", text: "What was the **result**?" });
      await post(`/api/sessions/${id}/reply`, {
        text: "We shipped a week late but kept the customer.",
      });
      expect((await call("wait_for_candidate", { timeout_seconds: 2 })).text).toContain(
        '<reply n="2" delivery="typed, 9 words">',
      );
    } finally {
      stream.close();
    }

    const saved = await call("save_story", {
      session_id: id,
      title: "The late migration",
      situation: "Internship, data migration.",
      task: "Ship the migration by the release.",
      action: "I flagged the slip early and proposed cutting scope.",
      result: "Shipped a week late; kept the customer.",
      tags: ["deadline", "ownership"],
    });
    expect(saved.text).toContain("Saved story");
    expect(readStories()[0]?.sessions).toEqual([id]);

    await post(`/api/sessions/${id}/done`);
    expect((await call("wait_for_candidate", { timeout_seconds: 2 })).text).toContain(
      "The learner ended the call.",
    );
    expect((await call("get_session", { session_id: id })).text).toContain(
      "Q1: Tell me about a time you missed a deadline.",
    );

    const missing = await call("record_phone_screen", {
      session_id: id,
      scores: { structure: 3, specificity: 2, ownership: 3 },
      answers: [],
      notes_md: "Lead with the result.",
      strengths: ["Owned the slip"],
      improvements: ["Give a number"],
    });
    expect(missing.text).toContain("scores.impact is required");
    const recorded = await call("record_phone_screen", {
      session_id: id,
      scores: { structure: 3, specificity: 2, ownership: 3, impact: 2 },
      answers: [
        { question: 1, score: 3, note: "Clear STAR; the result came only on a follow-up." },
      ],
      notes_md: "Lead with the result.",
      strengths: ["Owned the slip"],
      improvements: ["Give a number"],
    });
    expect(recorded.text).toContain("Passed: structure 3, specificity 2, ownership 3, impact 2.");
    expect(readPhoneSession(id)).toMatchObject({ phase: "done", verdict: { correct: true } });
    expect(readReviewEvents().map((e) => e.key)).toEqual(["phone:behavioral"]);

    const page = await (await fetch(`${server.getBaseUrl()}/s/${id}`)).text();
    expect(page).toContain("Debrief");
    expect(page).toContain("Clear STAR; the result came only on a follow-up.");
    const dashboard = await (await fetch(`${server.getBaseUrl()}/`)).text();
    expect(dashboard).toContain('id="phone"');
    expect(dashboard).toContain("Story bank (1):</span> The late migration");
  });

  it("records company briefs, checking every entry first", async () => {
    const bad = await call("record_phone_briefs", {
      entries: [
        {
          company: "Acme",
          format: "recruiter",
          seen_at: "2026-01-01",
          source_url: "https://example.com/p",
          note: "see www.acme.com",
        },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("entries[0].note may not hold a link");
    const good = await call("record_phone_briefs", {
      entries: [
        {
          company: "Acme",
          format: "recruiter",
          minutes: 25,
          seen_at: "2026-01-01",
          source_url: "https://example.com/p",
          note: "Background, why Acme, start date.",
        },
      ],
    });
    expect(good.text).toContain("Recorded 1 phone brief; 0 already on file.");
    expect((await call("list_phone_briefs", { company: "ACME" })).text).toContain(
      "2026-01-01 · recruiter · 25 min: Background, why Acme, start date.",
    );
  });

  it("abandons a call, counting it unless interrupted", async () => {
    const started = await call("start_phone_screen", { format: "recruiter" });
    const id = /Session (\S+) is ready/.exec(started.text)![1]!;
    expect(
      (await call("abandon_session", { session_id: id, reason: "interrupted" })).text,
    ).toContain("Not counted");
    expect(readReviewEvents()).toEqual([]);
  });
});
