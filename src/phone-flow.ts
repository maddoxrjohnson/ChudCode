/**
 * phone-flow.ts: the operations that move a phone screen along, shared by the
 * browser API and the interviewer's tools.
 *
 * The shape follows lesson-flow.ts: update the session on disk, append to its event
 * log, push the change to the page, and tell the host. The interviewer asks a graded
 * question with `askQuestion` and says anything else with `postPhoneMessage`; every
 * reply the learner sends after a question belongs to that question, follow-ups
 * included, so the debrief can score each question on everything said about it.
 */

import { FlowError, notifyDashboard, remaining, type ChatMessage } from "./flow.ts";
import { renderMarkdown } from "./markdown.ts";
import {
  deliveryLine,
  measureDelivery,
  phoneVerdict,
  topicIds,
  type DeliveryInput,
} from "./phone.ts";
import { relativeDay, type ReviewEvent } from "./review.ts";
import { emitCandidateEvent } from "./server/hooks.ts";
import { push, sessionChannel } from "./server/sse.ts";
import {
  appendPhoneEvent,
  briefsFor,
  PHONE_DIMENSIONS,
  PHONE_FORMAT_NAMES,
  phoneReviewEvents,
  readPhoneEvents,
  readPhoneSession,
  updatePhoneSession,
  type AnswerScore,
  type PhoneBrief,
  type PhoneQuestion,
  type PhoneRubric,
  type PhoneSession,
} from "./store/phone.ts";
import { appendReviewEvents, reviewItems } from "./store/review-events.ts";

export const MAX_REPLY_CHARS = 8_000;
export const MAX_QUESTIONS = 40;

export type PhoneLine =
  | (ChatMessage & { kind: "message" })
  | { kind: "question"; at: number; n: number; html: string; text: string; topic?: string }
  | { kind: "reply"; at: number; n: number; html: string; delivery: string };

export interface PhoneState {
  session: PhoneSession;
  /** The call in order: interviewer lines, questions, and the learner's replies. */
  lines: PhoneLine[];
  remainingMs: number | null;
  listening: boolean;
  /** What research found about this company's phone screens. */
  briefs: PhoneBrief[];
}

export function phoneState(id: string, listening = false, now = Date.now()): PhoneState {
  const session = readPhoneSession(id);
  const lines: PhoneLine[] = [];
  for (const event of readPhoneEvents(id)) {
    if (event.type === "message")
      lines.push({ kind: "message", at: event.at, from: event.from, html: event.html });
    else if (event.type === "question") {
      const q = session.questions.find((x) => x.n === event.n);
      if (q) lines.push(questionLine(q));
    }
  }
  for (const q of session.questions)
    for (const reply of q.replies)
      lines.push(replyLine(q.n, reply.at, reply.text, deliveryLine(reply.delivery)));
  lines.sort((a, b) => a.at - b.at);
  return {
    session,
    lines,
    remainingMs: remaining(session, now),
    listening,
    briefs: session.company ? briefsFor(session.company).slice(0, 6) : [],
  };
}

function questionLine(q: PhoneQuestion): PhoneLine {
  return {
    kind: "question",
    at: q.askedAt,
    n: q.n,
    text: q.text,
    html: renderMarkdown(q.text),
    ...(q.topic ? { topic: q.topic } : {}),
  };
}

function replyLine(n: number, at: number, text: string, delivery: string): PhoneLine {
  return { kind: "reply", at, n, html: renderMarkdown(text), delivery };
}

// ── The learner's actions ─────────────────────────────────────────────────────

export function startPhone(id: string, now = Date.now()): PhoneSession {
  const session = updatePhoneSession(id, (s) => {
    if (s.phase === "done") throw new FlowError(409, "This call is over");
    if (s.startedAt !== undefined) return;
    s.startedAt = now;
    s.phase = "coding";
  });
  if (session.startedAt === now) {
    appendPhoneEvent(id, { type: "started", at: now });
    pushPhase(session);
    notifyDashboard(id);
    emitCandidateEvent({ kind: "started", sessionId: id, at: now });
  }
  return session;
}

/**
 * What the learner said. After a question it is a reply to that question, measured
 * for delivery; before the first question it is small talk, passed on as a message.
 */
export function submitReply(
  id: string,
  text: string,
  input: DeliveryInput = {},
  now = Date.now(),
): { n: number | null } {
  const trimmed = text.trim();
  if (!trimmed) throw new FlowError(400, "Say or type something first");
  if (trimmed.length > MAX_REPLY_CHARS)
    throw new FlowError(400, `A reply is capped at ${MAX_REPLY_CHARS} characters`);
  const before = readPhoneSession(id);
  if (before.phase === "briefing") throw new FlowError(409, "Start the call first");
  if (before.phase === "done") throw new FlowError(409, "This call is over");
  const current = before.questions.at(-1);
  if (!current) {
    postPhoneMessage(id, "candidate", trimmed, now);
    return { n: null };
  }
  const delivery = measureDelivery(trimmed, input);
  updatePhoneSession(id, (s) => {
    s.questions.find((q) => q.n === current.n)?.replies.push({ at: now, text: trimmed, delivery });
  });
  appendPhoneEvent(id, {
    type: "reply",
    n: current.n,
    chars: trimmed.length,
    spoken: delivery.spoken,
    at: now,
  });
  push(sessionChannel(id), "reply", replyLine(current.n, now, trimmed, deliveryLine(delivery)));
  emitCandidateEvent({ kind: "answer", sessionId: id, number: current.n, at: now });
  return { n: current.n };
}

export function phoneTimerExpired(id: string, now = Date.now()): PhoneSession {
  let changed = false;
  const session = updatePhoneSession(id, (s) => {
    if (s.phase !== "coding") return;
    s.phase = "review";
    s.endedAt = now;
    changed = true;
  });
  if (changed) {
    appendPhoneEvent(id, { type: "timeout", at: now });
    pushPhase(session);
    emitCandidateEvent({ kind: "timer_expired", sessionId: id, at: now });
  }
  return session;
}

/** The learner hung up. The interviewer wraps up and scores. */
export function phoneDone(id: string, now = Date.now()): PhoneSession {
  let changed = false;
  const session = updatePhoneSession(id, (s) => {
    if (s.phase === "done") throw new FlowError(409, "This call is over");
    if (s.phase === "review") return;
    if (s.startedAt === undefined) s.startedAt = now;
    s.phase = "review";
    s.endedAt = now;
    changed = true;
  });
  if (changed) {
    appendPhoneEvent(id, { type: "done", at: now });
    pushPhase(session);
    emitCandidateEvent({ kind: "candidate_done", sessionId: id, at: now });
  }
  return session;
}

// ── Both sides ────────────────────────────────────────────────────────────────

export function postPhoneMessage(
  id: string,
  from: "interviewer" | "candidate",
  markdown: string,
  now = Date.now(),
): ChatMessage {
  const trimmed = markdown.trim();
  if (!trimmed) throw new FlowError(400, "The message is empty");
  const session = readPhoneSession(id);
  if (session.phase === "done" && from === "candidate")
    throw new FlowError(409, "This call is over");
  const html = renderMarkdown(trimmed);
  const message: ChatMessage = { at: now, from, html };
  appendPhoneEvent(id, { type: "message", from, markdown: trimmed, html, at: now });
  push(sessionChannel(id), "message", { ...message, text: trimmed });
  if (from === "candidate")
    emitCandidateEvent({ kind: "message", sessionId: id, text: trimmed, at: now });
  return message;
}

// ── The interviewer's actions ─────────────────────────────────────────────────

/** Ask a graded question. Replies from now on belong to it. */
export function askQuestion(
  id: string,
  text: string,
  topic?: string,
  now = Date.now(),
): PhoneQuestion {
  const trimmed = text.trim();
  if (!trimmed) throw new FlowError(400, "The question is empty");
  if (trimmed.length > 1_000) throw new FlowError(400, "Keep a question under 1,000 characters");
  const before = readPhoneSession(id);
  if (before.phase === "done") throw new FlowError(409, "This call is over");
  if (before.questions.length >= MAX_QUESTIONS)
    throw new FlowError(409, `A call holds at most ${MAX_QUESTIONS} questions`);
  if (topic !== undefined) {
    if (before.format !== "fundamentals")
      throw new FlowError(400, "Only fundamentals questions take a topic");
    if (!topicIds().has(topic))
      throw new FlowError(400, `topic must be one of ${[...topicIds()].join(", ")}`);
  }
  const question: PhoneQuestion = {
    n: before.questions.length + 1,
    text: trimmed,
    ...(topic ? { topic } : {}),
    askedAt: now,
    replies: [],
  };
  updatePhoneSession(id, (s) => {
    s.questions.push(question);
  });
  appendPhoneEvent(id, { type: "question", n: question.n, ...(topic ? { topic } : {}), at: now });
  push(sessionChannel(id), "question", questionLine(question));
  return question;
}

export interface PhoneRecordInput {
  scores: Record<string, number>;
  answers: AnswerScore[];
  notesMd: string;
  strengths: string[];
  improvements: string[];
}

export interface PhoneRecordOutcome {
  session: PhoneSession;
  reviewEvents: ReviewEvent[];
  nextDue: string;
}

export function recordPhone(
  id: string,
  input: PhoneRecordInput,
  now = Date.now(),
): PhoneRecordOutcome {
  const before = readPhoneSession(id);
  if (before.phase === "done") throw new FlowError(409, "This call is already scored");
  const dims = PHONE_DIMENSIONS[before.format];
  for (const key of Object.keys(input.scores))
    if (!dims.includes(key))
      throw new FlowError(
        400,
        `scores.${key} is not a ${before.format} dimension; they are ${dims.join(", ")}`,
      );
  for (const dim of dims) {
    const value = input.scores[dim];
    if (value === undefined) throw new FlowError(400, `scores.${dim} is required`);
    if (!Number.isInteger(value) || value < 0 || value > 4)
      throw new FlowError(400, `scores.${dim} must be an integer from 0 to 4`);
  }
  const answered = before.questions.filter((q) => q.replies.length > 0).map((q) => q.n);
  const seen = new Set<number>();
  for (const a of input.answers) {
    if (!answered.includes(a.n))
      throw new FlowError(400, `answers names question ${a.n}, which was not answered`);
    if (seen.has(a.n)) throw new FlowError(400, `answers scores question ${a.n} twice`);
    if (!Number.isInteger(a.score) || a.score < 0 || a.score > 4)
      throw new FlowError(400, `answers: question ${a.n} needs a score from 0 to 4`);
    seen.add(a.n);
  }
  const unscored = answered.filter((n) => !seen.has(n));
  if (unscored.length > 0)
    throw new FlowError(
      400,
      `answers must score every answered question. Missing: ${unscored.join(", ")}`,
    );

  const verdict = phoneVerdict(before, input.scores);
  const rubric: PhoneRubric = {
    scores: Object.fromEntries(dims.map((d) => [d, input.scores[d] as number])),
    answers: [...input.answers].sort((a, b) => a.n - b.n),
    notesMd: input.notesMd,
    strengths: input.strengths,
    improvements: input.improvements,
  };
  const session = updatePhoneSession(id, (s) => {
    s.phase = "done";
    s.endedAt = s.endedAt ?? now;
    s.rubric = rubric;
    s.verdict = verdict;
  });
  appendPhoneEvent(id, { type: "rubric", at: now });
  const reviewEvents = phoneReviewEvents(session, verdict.correct, session.endedAt ?? now);
  appendReviewEvents(reviewEvents);
  const nextDue = nextDueLine(session, now);
  push(sessionChannel(id), "rubric", {
    phone: true,
    rubric,
    verdict,
    dimensions: dims,
    notesHtml: renderMarkdown(input.notesMd),
    nextDue,
  });
  pushPhase(session);
  notifyDashboard(id);
  return { session, reviewEvents, nextDue };
}

/** End a call without a debrief; a miss unless `interrupted`. */
export function abandonPhone(id: string, reason: string, now = Date.now()): PhoneRecordOutcome {
  const before = readPhoneSession(id);
  if (before.phase === "done") throw new FlowError(409, "This call is already over");
  const trimmed = reason.trim() || "abandoned";
  const session = updatePhoneSession(id, (s) => {
    s.phase = "done";
    s.endedAt = s.endedAt ?? now;
    s.abandonedReason = trimmed;
  });
  appendPhoneEvent(id, { type: "abandoned", reason: trimmed, at: now });
  const reviewEvents =
    trimmed === "interrupted" ? [] : phoneReviewEvents(session, false, session.endedAt ?? now);
  if (reviewEvents.length) appendReviewEvents(reviewEvents);
  pushPhase(session);
  notifyDashboard(id);
  return { session, reviewEvents, nextDue: reviewEvents.length ? nextDueLine(session, now) : "" };
}

function nextDueLine(session: PhoneSession, now: number): string {
  const item = reviewItems().find((i) => i.kind === "phone" && i.id === session.format);
  return item
    ? `${PHONE_FORMAT_NAMES[session.format]} practice comes back ${relativeDay(item.dueAt, now)}.`
    : "";
}

function pushPhase(session: PhoneSession): void {
  const payload: { phase: string; startedAt?: number; endedAt?: number; timerMs: number } = {
    phase: session.phase,
    timerMs: session.timerMs,
  };
  if (session.startedAt !== undefined) payload.startedAt = session.startedAt;
  if (session.endedAt !== undefined) payload.endedAt = session.endedAt;
  push(sessionChannel(session.id), "phase", payload);
}
