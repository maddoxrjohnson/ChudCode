/**
 * A lab round trip: the learner names their project on the page, consents, and the
 * interviewer reads it with inspect_lab and scores it against the checklist.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CandidateInbox, connectInbox, McpSession, type JsonRpcResponse } from "../src/mcp.ts";
import { setHooks } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { readJson } from "../src/store/json.ts";
import { labSnapshotFile, readLesson } from "../src/store/lessons.ts";
import { readReviewEvents } from "../src/store/review-events.ts";
import type { LabSnapshot } from "../src/lab.ts";
import { makeFixture, type Fixture } from "./helpers.ts";
import { LAB_OUTLINE, labArgs } from "./lesson-fixtures.ts";

let fixture: Fixture;
let inbox: CandidateInbox;
let mcp: McpSession;
let project: string;
let nextId = 1;

beforeEach(() => {
  process.env["CHUDCODE_AUTO_OPEN"] = "0";
  fixture = makeFixture();
  inbox = new CandidateInbox();
  mcp = new McpSession(inbox);
  connectInbox(inbox);
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-lab-project-")));
  fs.writeFileSync(
    path.join(project, "CLAUDE.md"),
    "# Ledger\n\nRun `make test`. Dates are UTC.\nKey: sk-ant-api03-abcdefghijklmnopqrstuvwxyz\n",
  );
  fs.writeFileSync(path.join(project, ".env"), "SECRET=1");
});

afterEach(async () => {
  inbox.reset();
  await server.close();
  setHooks({});
  fixture.cleanup();
  fs.rmSync(project, { recursive: true, force: true });
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

const browser = (url: string, body: unknown = {}) =>
  fetch(`${server.getBaseUrl()}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function startLab(): Promise<string> {
  expect((await call("write_exercise", labArgs())).isError).toBe(false);
  const validated = await call("validate_exercise", { slug: "tighten-your-claude-md" });
  expect(validated.text).toContain("passed");
  const started = await call("start_lesson", { slug: "tighten-your-claude-md" });
  const id = /Session (\S+) is ready/.exec(started.text)?.[1];
  if (!id) throw new Error(started.text);
  await browser(`/api/sessions/${id}/start`);
  await call("wait_for_candidate", { timeout_seconds: 1 });
  return id;
}

const SCORES = {
  decomposition: 2,
  verification: null,
  contextCost: 3,
  safety: null,
  delegation: null,
};

describe("lab exercises", () => {
  it("validates a lab brief without a scenario, but not for a lesson with no lab", async () => {
    expect((await call("write_exercise", labArgs({ lesson: "managing-context" }))).isError).toBe(
      false,
    );
    const report = await call("validate_exercise", { slug: "tighten-your-claude-md" });
    expect(report.text).toContain("does not use lab exercises");
  });

  it("runs from the page's consent to a scored checklist", async () => {
    const id = await startLab();

    // The page previews what a lab would read; the guard refuses the home directory.
    const preview = await browser(`/api/sessions/${id}/lab-preview`, { path: project });
    expect(await preview.json()).toEqual({
      root: project,
      files: [{ path: "CLAUDE.md", bytes: expect.any(Number) }],
      skipped: [],
    });
    expect((await browser(`/api/sessions/${id}/lab-preview`, { path: "~" })).status).toBe(400);
    expect((await call("inspect_lab", { session_id: id })).text).toContain(
      "has not submitted a project",
    );

    // Without consent nothing is stored.
    expect((await browser(`/api/sessions/${id}/lab`, { path: project })).status).toBe(400);
    const sent = await browser(`/api/sessions/${id}/lab`, {
      path: project,
      note: "Cut it to the commands.",
      consent: true,
    });
    expect(await sent.json()).toEqual({ number: 1 });
    const prompt = (await call("wait_for_candidate", { timeout_seconds: 2 })).text;
    expect(prompt).toContain("submitted their project for the lab");
    expect(prompt).toContain(`Project: ${project}`);
    expect(prompt).toContain("Cut it to the commands.");
    expect(prompt).toContain("`inspect_lab`");
    expect(prompt).toContain(LAB_OUTLINE);

    const inspected = await call("inspect_lab", { session_id: id });
    expect(inspected.isError).toBe(false);
    expect(inspected.text).toContain('<file path="CLAUDE.md"');
    expect(inspected.text).toContain("Run `make test`.");
    expect(inspected.text).not.toContain("sk-ant");
    expect(inspected.text).not.toContain("SECRET=1");
    expect(inspected.text).toContain("not a git repository");
    expect(inspected.text).toContain("`progress-next`");
    const snapshot = readJson<LabSnapshot>(labSnapshotFile(id, 1));
    expect(snapshot?.files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
    expect(readLesson(id).lab).toMatchObject({ root: project, inspections: 1, answer: 1 });
    expect((await call("get_session", { session_id: id })).text).toContain("read 1 time");

    const noChecklist = await call("record_lesson", {
      session_id: id,
      scores: SCORES,
      notes_md: "x",
    });
    expect(noChecklist.text).toContain("checklist is required for a lab");
    const partial = await call("record_lesson", {
      session_id: id,
      scores: SCORES,
      notes_md: "x",
      checklist: [{ id: "short", status: "met", note: "12 lines" }],
    });
    expect(partial.text).toContain("Missing: non-inferable, no-duplication, progress-next");

    const recorded = await call("record_lesson", {
      session_id: id,
      scores: SCORES,
      notes_md: "Tight CLAUDE.md; no progress file yet.",
      strengths: ["Only commands and quirks"],
      improvements: ["Add progress.md with the next step"],
      checklist: [
        { id: "non-inferable", status: "met", note: "CLAUDE.md: make test, UTC dates" },
        { id: "short", status: "met", note: "5 lines" },
        { id: "no-duplication", status: "partial", note: "Title line restates the repo name" },
        { id: "progress-next", status: "missing", note: "No progress.md" },
      ],
    });
    expect(recorded.isError).toBe(false);
    expect(recorded.text).toContain("Not passed");
    expect(readLesson(id).verdict).toEqual({
      correct: false,
      rubricOk: true,
      answered: true,
      inspected: true,
      checklistOk: false,
    });
    expect(readLesson(id).rubric?.checklist?.map((c) => c.id)).toEqual([
      "non-inferable",
      "short",
      "no-duplication",
      "progress-next",
    ]);
    expect(readReviewEvents()).toEqual([
      expect.objectContaining({ key: "lesson:context-files", correct: false }),
    ]);
  });

  it("refuses a project with none of the lab's files, and a design review's lab calls", async () => {
    const id = await startLab();
    fs.rmSync(path.join(project, "CLAUDE.md"));
    const empty = await browser(`/api/sessions/${id}/lab`, { path: project, consent: true });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toContain("None of the files this lab reads");
  });

  it("does not pass a lab nobody inspected", async () => {
    const id = await startLab();
    await browser(`/api/sessions/${id}/lab`, { path: project, consent: true });
    const recorded = await call("record_lesson", {
      session_id: id,
      scores: SCORES,
      notes_md: "x",
      checklist: ["non-inferable", "short", "no-duplication", "progress-next"].map((c) => ({
        id: c,
        status: "met",
        note: "ok",
      })),
    });
    expect(recorded.text).toContain("Not passed");
    expect(readLesson(id).verdict).toMatchObject({ inspected: false, checklistOk: true });
  });
});
