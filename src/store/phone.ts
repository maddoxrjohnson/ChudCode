/**
 * phone.ts: phone screen sessions, the learner's story bank, and company phone briefs.
 *
 *   phone/sessions/<id>/
 *     session.json      state the page and the interviewer read
 *     events.jsonl      everything that happened, in order
 *   phone/stories.json  { "stories": [Story, ...] }
 *   phone/briefs.json   { "entries": [PhoneBrief, ...] }
 *
 * A phone screen is a call, not a coding session: the interviewer asks questions out
 * loud, the learner answers by voice or by typing, and each answer is kept with how it
 * was delivered (how long, how fast, how many filler words). Phone sessions live
 * apart from interviews and lessons, share their id format, phases, and chat event
 * shape, and append `phone:<id>` keys to the review log.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { makeKey, type ReviewEvent } from "../review.ts";
import { appendJsonl, readJson, readJsonl, writeJson } from "./json.ts";
import {
  isDir,
  isValidSessionId,
  isValidSlug,
  lessonDir,
  phoneDir,
  phoneSessionDir,
  sessionDir,
  slugify,
} from "./paths.ts";
import { generateSessionId, type Phase, type SessionEvent } from "./sessions.ts";

export const PHONE_FORMATS = ["recruiter", "behavioral", "fundamentals"] as const;
export type PhoneFormat = (typeof PHONE_FORMATS)[number];

/** What each format is scored on, 0 to 4; docs/PHONE-RUBRIC.md describes each level. */
export const PHONE_DIMENSIONS: Record<PhoneFormat, readonly string[]> = {
  recruiter: ["clarity", "concision", "specificity", "motivation"],
  behavioral: ["structure", "specificity", "ownership", "impact"],
  fundamentals: ["accuracy", "depth", "clarity"],
};

export const PHONE_FORMAT_NAMES: Record<PhoneFormat, string> = {
  recruiter: "Recruiter screen",
  behavioral: "Behavioral screen",
  fundamentals: "CS fundamentals",
};

/** How one reply was delivered. Typed replies have no pace. */
export interface Delivery {
  spoken: boolean;
  durationMs: number;
  words: number;
  /** Words per minute while speaking, or null for a typed reply. */
  wpm: number | null;
  fillers: number;
  /** The filler words found, most frequent first, e.g. ["um ×3", "you know ×1"]. */
  fillerWords: string[];
  /** Silences over three seconds while the microphone was on. */
  longPauses: number;
}

export interface PhoneReply {
  at: number;
  text: string;
  delivery: Delivery;
}

export interface PhoneQuestion {
  /** 1-based, in the order asked. */
  n: number;
  text: string;
  /** For fundamentals, the topic id from data/phone/fundamentals.json. */
  topic?: string;
  askedAt: number;
  replies: PhoneReply[];
}

export interface AnswerScore {
  n: number;
  score: number;
  note: string;
}

export interface PhoneRubric {
  /** One score per dimension of the session's format. */
  scores: Record<string, number>;
  answers: AnswerScore[];
  notesMd: string;
  strengths: string[];
  improvements: string[];
}

export interface PhoneVerdict {
  correct: boolean;
  /** Every dimension of the format scored 2 or more. */
  rubricOk: boolean;
  /** At least one question was answered. */
  answered: boolean;
}

export interface PhoneSession {
  id: string;
  kind: "phone";
  format: PhoneFormat;
  company?: string;
  role?: string;
  timerMs: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  phase: Phase;
  questions: PhoneQuestion[];
  rubric?: PhoneRubric;
  verdict?: PhoneVerdict;
  abandonedReason?: string;
}

export type PhoneEvent =
  | Extract<
      SessionEvent,
      { type: "created" | "started" | "message" | "timeout" | "done" | "rubric" | "abandoned" }
    >
  | { at: number; type: "question"; n: number; topic?: string }
  | { at: number; type: "reply"; n: number; chars: number; spoken: boolean };

export interface NewPhoneSession {
  format: PhoneFormat;
  company?: string;
  role?: string;
  timerMs: number;
}

export function createPhoneSession(input: NewPhoneSession, now = Date.now()): PhoneSession {
  const label = slugify(
    `phone-${input.format}${input.company ? `-${input.company}` : ""}`,
    "phone",
  );
  let id = generateSessionId(label, now);
  // Unique across interviews and lessons too: the page channel and URL use the id alone.
  while (isDir(phoneSessionDir(id)) || isDir(sessionDir(id)) || isDir(lessonDir(id)))
    id = generateSessionId(label, now);
  const session: PhoneSession = {
    id,
    kind: "phone",
    format: input.format,
    ...(input.company ? { company: input.company } : {}),
    ...(input.role ? { role: input.role } : {}),
    timerMs: input.timerMs,
    createdAt: now,
    phase: "briefing",
    questions: [],
  };
  writePhoneSession(session);
  appendPhoneEvent(id, { type: "created", at: now });
  return session;
}

export function phoneExists(id: string): boolean {
  return isValidSessionId(id) && isDir(phoneSessionDir(id));
}

export function readPhoneSession(id: string): PhoneSession {
  const session = readJson<PhoneSession>(path.join(phoneSessionDir(id), "session.json"));
  if (!session) throw new Error(`No phone session named ${id}`);
  return session;
}

export function writePhoneSession(session: PhoneSession): void {
  writeJson(path.join(phoneSessionDir(session.id), "session.json"), session);
}

export function updatePhoneSession(
  id: string,
  change: (session: PhoneSession) => void,
): PhoneSession {
  const session = readPhoneSession(id);
  change(session);
  writePhoneSession(session);
  return session;
}

export function appendPhoneEvent(id: string, event: PhoneEvent): void {
  appendJsonl(path.join(phoneSessionDir(id), "events.jsonl"), event);
}

export function readPhoneEvents(id: string): PhoneEvent[] {
  return readJsonl<PhoneEvent>(path.join(phoneSessionDir(id), "events.jsonl"));
}

export function listPhoneSessions(limit = 50): PhoneSession[] {
  const root = path.join(phoneDir(), "sessions");
  if (!isDir(root)) return [];
  const sessions: PhoneSession[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;
    const session = readJson<PhoneSession>(path.join(root, entry.name, "session.json"));
    if (session) sessions.push(session);
  }
  return sessions.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

// ── Review events ─────────────────────────────────────────────────────────────

/**
 * The review events a scored or abandoned phone screen implies: `phone:<format>` for
 * the screen, and for fundamentals `phone:topic-<id>` for each topic asked, correct
 * when its best-scored question reached 2.
 */
export function phoneReviewEvents(
  session: PhoneSession,
  correct: boolean,
  now: number,
): ReviewEvent[] {
  const base = { at: now, session: session.id };
  const timeMs =
    session.startedAt !== undefined && session.endedAt !== undefined
      ? { timeMs: session.endedAt - session.startedAt }
      : {};
  const events: ReviewEvent[] = [
    { key: makeKey("phone", session.format), correct, ...base, ...timeMs },
  ];
  if (session.format !== "fundamentals") return events;
  const best = new Map<string, number>();
  for (const q of session.questions) {
    if (!q.topic || !isValidSlug(q.topic) || q.replies.length === 0) continue;
    const score = session.rubric?.answers.find((a) => a.n === q.n)?.score ?? (correct ? 2 : 0);
    best.set(q.topic, Math.max(best.get(q.topic) ?? 0, score));
  }
  for (const [topic, score] of best)
    events.push({
      key: makeKey("phone", `topic-${topic}`),
      correct: session.verdict ? score >= 2 : false,
      ...base,
    });
  return events;
}

export function eventsFromPhone(sessions: readonly PhoneSession[]): ReviewEvent[] {
  const events: ReviewEvent[] = [];
  for (const session of sessions) {
    const at = session.endedAt ?? session.createdAt;
    if (session.verdict) events.push(...phoneReviewEvents(session, session.verdict.correct, at));
    else if (session.abandonedReason !== undefined && session.abandonedReason !== "interrupted")
      events.push(...phoneReviewEvents(session, false, at));
  }
  return events.sort((a, b) => a.at - b.at);
}

// ── The story bank ────────────────────────────────────────────────────────────

/**
 * A story the learner can tell in a behavioral answer, in STAR parts. The interviewer
 * saves one after the learner tells it well enough to reuse, and updates it when a
 * later telling is sharper; the bank shows which competencies still lack a story.
 */
export interface Story {
  /** `s-` and eight hex digits. */
  id: string;
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  /** Competencies it answers: conflict, failure, leadership, ambiguity, ... */
  tags: string[];
  /** Phone sessions it was told in. */
  sessions: string[];
  updatedAt: number;
}

export const STORY_LIMITS = { title: 120, part: 800, tags: 8, tag: 40, stories: 60 };

function storiesFile(): string {
  return path.join(phoneDir(), "stories.json");
}

export function readStories(): Story[] {
  return readJson<{ stories: Story[] }>(storiesFile())?.stories ?? [];
}

export type StoryInput = Omit<Story, "id" | "sessions" | "updatedAt"> & {
  id?: string;
  session?: string;
};

/** Add a story, or replace the one with `input.id`. Returns it. */
export function saveStory(input: StoryInput, now = Date.now()): Story {
  const stories = readStories();
  const existing = input.id ? stories.find((s) => s.id === input.id) : undefined;
  if (input.id && !existing) throw new Error(`No story ${input.id} in the bank`);
  if (!existing && stories.length >= STORY_LIMITS.stories)
    throw new Error(`The bank holds ${STORY_LIMITS.stories} stories; update one instead`);
  const id =
    existing?.id ??
    `s-${createHash("sha256").update(`${input.title}\n${now}`).digest("hex").slice(0, 8)}`;
  const sessions = [...(existing?.sessions ?? [])];
  if (input.session && !sessions.includes(input.session)) sessions.push(input.session);
  const story: Story = {
    id,
    title: input.title,
    situation: input.situation,
    task: input.task,
    action: input.action,
    result: input.result,
    tags: [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))],
    sessions,
    updatedAt: now,
  };
  const next = existing ? stories.map((s) => (s.id === id ? story : s)) : [...stories, story];
  writeJson(storiesFile(), { stories: next });
  return story;
}

// ── Company phone briefs ──────────────────────────────────────────────────────

/**
 * What one public post says about a company's phone screens: which round, how long,
 * what it covered. Recorded by the research skill, read before a mock for that
 * company and shown on the page. The note is a paraphrase and may not hold a link;
 * ids are a hash of (company, round, source), so recording a post twice is a no-op.
 */
export interface PhoneBrief {
  /** `p-` and ten hex digits. */
  id: string;
  company: string;
  role?: string;
  format: PhoneFormat | "technical";
  /** How long the call was, when the post says. */
  minutes?: number;
  /** When the call happened, as the post gives it: YYYY-MM-DD. */
  seenAt: string;
  sourceUrl: string;
  /** What the call covered, in a sentence or two of your own words. */
  note: string;
  /** For fundamentals: topic ids from data/phone/fundamentals.json the call asked about. */
  topics?: string[];
  recordedAt: number;
}

export type PhoneBriefInput = Omit<PhoneBrief, "id" | "recordedAt">;

export const BRIEF_FORMATS = [...PHONE_FORMATS, "technical"] as const;
export const MAX_BRIEF_NOTE = 400;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LINK_RE = /https?:\/\/|www\./i;

function briefsFile(): string {
  return path.join(phoneDir(), "briefs.json");
}

export function readBriefs(): PhoneBrief[] {
  return readJson<{ entries: PhoneBrief[] }>(briefsFile())?.entries ?? [];
}

export function briefsFor(company: string): PhoneBrief[] {
  const want = company.trim().toLowerCase();
  return readBriefs()
    .filter((b) => b.company.toLowerCase() === want)
    .sort((a, b) => b.seenAt.localeCompare(a.seenAt));
}

/** Problems with one brief, each naming the field; empty when it can be stored. */
export function briefProblems(
  input: PhoneBriefInput,
  topicIds: ReadonlySet<string>,
  today: string,
): string[] {
  const problems: string[] = [];
  if (!input.company?.trim() || input.company.length > 80)
    problems.push("company must be 1 to 80 characters");
  if (input.role !== undefined && input.role.length > 80)
    problems.push("role is at most 80 characters");
  if (!(BRIEF_FORMATS as readonly string[]).includes(input.format))
    problems.push(`format must be one of ${BRIEF_FORMATS.join(", ")}`);
  if (
    input.minutes !== undefined &&
    !(Number.isInteger(input.minutes) && input.minutes >= 5 && input.minutes <= 180)
  )
    problems.push("minutes must be a whole number from 5 to 180");
  if (!DATE_RE.test(input.seenAt ?? "") || input.seenAt > today || input.seenAt < "2000-01-01")
    problems.push("seenAt must be a past date, YYYY-MM-DD");
  try {
    const url = new URL(input.sourceUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    problems.push("sourceUrl must be the post's http(s) URL");
  }
  if (!input.note?.trim() || input.note.length > MAX_BRIEF_NOTE)
    problems.push(`note must be 1 to ${MAX_BRIEF_NOTE} characters`);
  else if (LINK_RE.test(input.note))
    problems.push("note may not hold a link; the URL goes in sourceUrl");
  for (const topic of input.topics ?? [])
    if (!topicIds.has(topic)) problems.push(`topics: ${topic} is not a fundamentals topic`);
  return problems;
}

export function briefId(input: Pick<PhoneBriefInput, "company" | "format" | "sourceUrl">): string {
  const key = `${input.company.trim().toLowerCase()}\n${input.format}\n${input.sourceUrl.trim()}`;
  return `p-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}

/** Store briefs; ones already on file are skipped. Returns how many were added. */
export function recordBriefs(
  inputs: readonly PhoneBriefInput[],
  now = Date.now(),
): { added: number; skipped: number } {
  const entries = readBriefs();
  const ids = new Set(entries.map((e) => e.id));
  let added = 0;
  for (const input of inputs) {
    const id = briefId(input);
    if (ids.has(id)) continue;
    ids.add(id);
    entries.push({
      ...input,
      company: input.company.trim(),
      note: input.note.trim(),
      id,
      recordedAt: now,
    });
    added++;
  }
  writeJson(briefsFile(), { entries });
  return { added, skipped: inputs.length - added };
}
