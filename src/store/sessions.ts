/**
 * sessions.ts: one interview session on disk.
 *
 *   sessions/<id>/
 *     session.json      state the UI and the interviewer read
 *     events.jsonl      everything that happened, in order
 *     draft.py          the editor's latest autosave
 *     submissions/NN.py and NN.result.json
 *
 * Ids are `YYYYMMDD-HHMM-<slug>-<4 hex>` so a directory listing reads as a diary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import type { RunResult, RunStatus } from "../runner/types.ts";
import { appendJsonl, readJson, readJsonl, readText, writeJson, writeText } from "./json.ts";
import type { Difficulty } from "./problems.ts";
import { isDir, isValidSessionId, sessionDir, sessionsDir } from "./paths.ts";

export type SessionMode = "interview" | "review" | "mimic" | "solo";
export type Phase = "briefing" | "coding" | "review" | "done";

export interface Rubric {
  correctness: number;
  communication: number;
  complexity: number;
  codeQuality: number;
  time: number;
  notesMd: string;
  strengths: string[];
  improvements: string[];
}

export interface Verdict {
  correct: boolean;
  allPassed: boolean;
  withinTime: boolean;
  complexityOk: boolean;
}

export interface Session {
  id: string;
  problem: string;
  problemTitle: string;
  patterns: string[];
  difficulty: Difficulty;
  mode: SessionMode;
  language: "python";
  timerMs: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  phase: Phase;
  approachNote?: string;
  hintsUsed: number[];
  submissions: number;
  lastResult?: { status: RunStatus; passed: number; total: number };
  rubric?: Rubric;
  verdict?: Verdict;
  abandonedReason?: string;
}

export type SessionEvent = { at: number } & (
  | { type: "created" }
  | { type: "started" }
  | { type: "note"; text: string }
  | { type: "message"; from: "interviewer" | "candidate"; markdown: string; html: string }
  | { type: "hint"; level: number; text: string }
  | {
      type: "run";
      kind: "visible" | "custom" | "interviewer";
      status: RunStatus;
      passed: number;
      total: number;
    }
  | { type: "submit"; number: number; status: RunStatus; passed: number; total: number }
  | { type: "timeout" }
  | { type: "done" }
  | { type: "rubric" }
  | { type: "abandoned"; reason: string }
);

export interface NewSession {
  problem: string;
  problemTitle: string;
  patterns: string[];
  difficulty: Difficulty;
  mode: SessionMode;
  timerMs: number;
}

export function generateSessionId(slug: string, now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return `${stamp}-${slug}-${randomBytes(2).toString("hex")}`;
}

export function createSession(input: NewSession, now = Date.now()): Session {
  let id = generateSessionId(input.problem, now);
  while (isDir(sessionDir(id))) id = generateSessionId(input.problem, now);
  const session: Session = {
    id,
    problem: input.problem,
    problemTitle: input.problemTitle,
    patterns: [...input.patterns],
    difficulty: input.difficulty,
    mode: input.mode,
    language: "python",
    timerMs: input.timerMs,
    createdAt: now,
    phase: "briefing",
    hintsUsed: [],
    submissions: 0,
  };
  writeSession(session);
  appendEvent(id, { type: "created", at: now });
  return session;
}

export function sessionExists(id: string): boolean {
  return isValidSessionId(id) && isDir(sessionDir(id));
}

export function readSession(id: string): Session {
  const session = readJson<Session>(path.join(sessionDir(id), "session.json"));
  if (!session) throw new Error(`No session named ${id}`);
  return session;
}

export function writeSession(session: Session): void {
  writeJson(path.join(sessionDir(session.id), "session.json"), session);
}

export function updateSession(id: string, change: (session: Session) => void): Session {
  const session = readSession(id);
  change(session);
  writeSession(session);
  return session;
}

export function appendEvent(id: string, event: SessionEvent): void {
  appendJsonl(path.join(sessionDir(id), "events.jsonl"), event);
}

export function readEvents(id: string): SessionEvent[] {
  return readJsonl<SessionEvent>(path.join(sessionDir(id), "events.jsonl"));
}

export function readDraft(id: string): string | null {
  return readText(path.join(sessionDir(id), "draft.py"));
}

export function writeDraft(id: string, code: string): void {
  writeText(path.join(sessionDir(id), "draft.py"), code);
}

/** Store a submission and its full result; returns the submission number (1-based). */
export function recordSubmission(id: string, code: string, result: RunResult): number {
  const session = readSession(id);
  const number = session.submissions + 1;
  const name = String(number).padStart(2, "0");
  const dir = path.join(sessionDir(id), "submissions");
  writeText(path.join(dir, `${name}.py`), code);
  writeJson(path.join(dir, `${name}.result.json`), result);
  session.submissions = number;
  session.lastResult = { status: result.status, passed: result.passed, total: result.total };
  writeSession(session);
  return number;
}

export function readSubmission(
  id: string,
  number: number,
): { code: string; result: RunResult } | null {
  const name = String(number).padStart(2, "0");
  const dir = path.join(sessionDir(id), "submissions");
  const code = readText(path.join(dir, `${name}.py`));
  const result = readJson<RunResult>(path.join(dir, `${name}.result.json`));
  if (code === null || result === null) return null;
  return { code, result };
}

export function listSessions(limit = 50): Session[] {
  const root = sessionsDir();
  if (!isDir(root)) return [];
  const sessions: Session[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;
    const session = readJson<Session>(path.join(root, entry.name, "session.json"));
    if (session) sessions.push(session);
  }
  return sessions.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}
