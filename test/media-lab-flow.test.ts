/**
 * A media lab round trip: the learner names the repository with their site on the
 * page, consents, and the interviewer measures it with inspect_media, sees its
 * images, and scores it; a failed check blocks the pass until a resubmission fixes it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lessonVerdict } from "../src/lesson-flow.ts";
import type { MediaSnapshot } from "../src/media-lab.ts";
import { CandidateInbox, connectInbox, McpSession, type JsonRpcResponse } from "../src/mcp.ts";
import { setHooks } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { readJson } from "../src/store/json.ts";
import { labSnapshotFile, readLesson, readLessonEvents } from "../src/store/lessons.ts";
import { makeFixture, openStream, type Fixture } from "./helpers.ts";
import { MEDIA_OUTLINE, mediaLabArgs } from "./lesson-fixtures.ts";
import { writeSite } from "./media-site.ts";

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
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-media-project-")));
});

afterEach(async () => {
  inbox.reset();
  await server.close();
  setHooks({});
  fixture.cleanup();
  fs.rmSync(project, { recursive: true, force: true });
});

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

async function call(name: string, args: Record<string, unknown> = {}) {
  const response = (await mcp.handle({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  })) as JsonRpcResponse;
  if (!("result" in response)) throw new Error(JSON.stringify(response));
  const result = response.result as { content: Content[]; isError: boolean };
  const text = result.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
  return {
    text,
    images: result.content.filter((c) => c.type === "image"),
    isError: result.isError,
  };
}

const browser = (url: string, body: unknown = {}) =>
  fetch(`${server.getBaseUrl()}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function startMediaLab(): Promise<string> {
  expect((await call("write_exercise", mediaLabArgs())).isError).toBe(false);
  const validated = await call("validate_exercise", { slug: "ship-your-pages-site" });
  expect(validated.text).toContain("passed");
  const started = await call("start_lesson", { slug: "ship-your-pages-site" });
  const id = /Session (\S+) is ready/.exec(started.text)?.[1];
  if (!id) throw new Error(started.text);
  await browser(`/api/sessions/${id}/start`);
  await call("wait_for_candidate", { timeout_seconds: 1 });
  return id;
}

const SCORES = { verification: 3, presentation: 3 };
const CHECKLIST = ["deploys", "paths", "video", "first-screen"].map((id) => ({
  id,
  status: "met",
  note: "docs/index.html",
}));

describe("media lab exercises", () => {
  it("needs a lesson with a checklist", async () => {
    await call("write_exercise", mediaLabArgs({ lesson: "honest-ads" }));
    const report = await call("validate_exercise", { slug: "ship-your-pages-site" });
    expect(report.text).toContain("does not use media-lab exercises");
  });

  it("blocks a pass on a failed check, and passes once a resubmission fixes it", async () => {
    writeSite(project, "bad");
    const id = await startMediaLab();

    // The page lists what would be measured, never the .env file.
    const preview = await (
      await browser(`/api/sessions/${id}/lab-preview`, { path: project })
    ).json();
    expect(preview.files.map((f: { path: string }) => f.path)).toEqual([
      "docs/index.html",
      "docs/guide.html",
      "README.md",
      "docs/media/demo.gif",
      "docs/media/shot.png",
      "docs/media/slow.mp4",
    ]);
    expect((await call("inspect_media", { session_id: id })).text).toContain(
      "has not submitted a project",
    );
    expect((await browser(`/api/sessions/${id}/lab`, { path: project })).status).toBe(400);

    const stream = await openStream(server.getBaseUrl()!, `/api/events?session=${id}`);
    try {
      await browser(`/api/sessions/${id}/lab`, {
        path: project,
        consent: true,
        note: "First try.",
      });
      const prompt = (await call("wait_for_candidate", { timeout_seconds: 2 })).text;
      expect(prompt).toContain("submitted their project for the media lab");
      expect(prompt).toContain("`inspect_media`");
      expect(prompt).toContain(MEDIA_OUTLINE);
      expect((await call("inspect_lab", { session_id: id })).text).toContain("call inspect_media");

      const first = await call("inspect_media", { session_id: id });
      expect(first.isError).toBe(false);
      expect(first.text).toContain("7 fail-level checks failed");
      expect(first.text).toContain("FAIL `autoplay-muted` (fail)");
      expect(first.text).toContain("facts `autoplay-muted`");
      expect(first.text).toContain("docs/media/slow.mp4: mp4, 640×360");
      expect(first.text).toContain("`first-screen`");
      expect(first.text).not.toContain("TOKEN=nope");
      expect(first.images.map((i) => i.type === "image" && i.mimeType)).toEqual([
        "image/png",
        "image/gif",
      ]);
      const frame = await stream.next((f) => f.type === "measured");
      expect(frame.data).toMatchObject({ number: 1, gatePassed: false });
    } finally {
      stream.close();
    }
    expect(readLesson(id).lab).toMatchObject({ inspections: 1, gatePassed: false, failed: 7 });
    expect(readLessonEvents(id).some((e) => e.type === "measured")).toBe(true);
    expect((await call("get_session", { session_id: id })).text).toContain("measured 1 time");
    expect(
      lessonVerdict(readLesson(id), { ...nulls(), ...SCORES }, CHECKLIST as never),
    ).toMatchObject({
      correct: false,
      gatePassed: false,
    });

    // The learner fixes the site and resubmits; the latest measurement decides.
    fs.rmSync(project, { recursive: true, force: true });
    fs.mkdirSync(project);
    writeSite(project, "good");
    await browser(`/api/sessions/${id}/lab`, { path: project, consent: true, note: "Fixed." });
    await call("wait_for_candidate", { timeout_seconds: 2 });
    const second = await call("inspect_media", { session_id: id });
    expect(second.text).toContain("Every fail-level check passed.");
    expect(second.images).toHaveLength(3);
    expect(readJson<MediaSnapshot>(labSnapshotFile(id, 2))?.gatePassed).toBe(true);

    const recorded = await call("record_lesson", {
      session_id: id,
      scores: SCORES,
      notes_md: "The site is live and the demo plays inline.",
      strengths: ["Faststart H.264 demo"],
      improvements: ["Add captions"],
      checklist: CHECKLIST,
    });
    expect(recorded.text).toContain("Passed");
    expect(readLesson(id).verdict).toMatchObject({
      correct: true,
      gatePassed: true,
      inspected: true,
    });
    expect(readLesson(id).rubric?.presentation).toBe(3);
    expect(readLesson(id).rubric?.decomposition).toBeNull();
  });
});

function nulls() {
  return {
    decomposition: null,
    verification: null,
    contextCost: null,
    safety: null,
    delegation: null,
    presentation: null,
  };
}
