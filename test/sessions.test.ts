/**
 * Sessions: ids, state, events, drafts, and submissions on disk.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunResult } from "../src/runner/types.ts";
import { isValidSessionId } from "../src/store/paths.ts";
import {
  appendEvent,
  createSession,
  listSessions,
  readDraft,
  readEvents,
  readSession,
  readSubmission,
  recordSubmission,
  sessionExists,
  updateSession,
  writeDraft,
} from "../src/store/sessions.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
});
afterEach(() => fixture.cleanup());

const NEW = {
  problem: "window-sum",
  problemTitle: "Largest Window Sum",
  patterns: ["sliding-window"],
  difficulty: "easy" as const,
  mode: "interview" as const,
  timerMs: 35 * 60_000,
};

const RESULT: RunResult = {
  status: "ok",
  cases: [],
  passed: 11,
  total: 12,
  wallMs: 80,
  stderrTail: "",
  truncated: false,
};

describe("sessions", () => {
  it("creates a session with a diary-style id and a created event", () => {
    const session = createSession(NEW, Date.UTC(2026, 9, 8, 14, 5));
    expect(session.id.startsWith("20261008-1405-window-sum-")).toBe(true);
    expect(isValidSessionId(session.id)).toBe(true);
    expect(session.phase).toBe("briefing");
    expect(sessionExists(session.id)).toBe(true);
    expect(readEvents(session.id)).toEqual([{ type: "created", at: Date.UTC(2026, 9, 8, 14, 5) }]);
  });

  it("updates state and appends events in order", () => {
    const { id } = createSession(NEW);
    updateSession(id, (s) => {
      s.phase = "coding";
      s.startedAt = 1;
      s.hintsUsed.push(1);
    });
    appendEvent(id, { type: "started", at: 1 });
    appendEvent(id, { type: "hint", level: 1, text: "Think windows.", at: 2 });
    expect(readSession(id)).toMatchObject({ phase: "coding", startedAt: 1, hintsUsed: [1] });
    expect(readEvents(id).map((e) => e.type)).toEqual(["created", "started", "hint"]);
  });

  it("stores drafts and numbered submissions", () => {
    const { id } = createSession(NEW);
    expect(readDraft(id)).toBeNull();
    writeDraft(id, "def f(): pass\n");
    expect(readDraft(id)).toBe("def f(): pass\n");

    expect(recordSubmission(id, "v1", RESULT)).toBe(1);
    expect(recordSubmission(id, "v2", { ...RESULT, passed: 12 })).toBe(2);
    expect(readSession(id)).toMatchObject({
      submissions: 2,
      lastResult: { passed: 12, total: 12, status: "ok" },
    });
    expect(readSubmission(id, 1)?.code).toBe("v1");
    expect(readSubmission(id, 2)?.result.passed).toBe(12);
    expect(readSubmission(id, 3)).toBeNull();
  });

  it("lists sessions newest first", () => {
    createSession(NEW, Date.UTC(2026, 0, 1));
    const later = createSession(NEW, Date.UTC(2026, 0, 2));
    expect(listSessions().map((s) => s.id)[0]).toBe(later.id);
    expect(listSessions(1)).toHaveLength(1);
  });
});
