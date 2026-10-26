/**
 * phone.ts: the parts of a phone screen that are not storage: the fundamentals
 * topics, how a reply was delivered, and the verdict.
 *
 * Delivery is measured on the server from the reply's text and the two numbers the
 * page sends (how long the microphone was on, how many long silences it heard), so
 * the counting is the same for every browser and testable here. Speech recognition
 * in Chrome tends to drop "um" and "uh" from its transcript, so the filler count is a
 * floor, not a measurement; the page and the prompts say so.
 */

import * as path from "node:path";

import { readJson } from "./store/json.ts";
import { dataDir } from "./store/paths.ts";
import {
  PHONE_DIMENSIONS,
  type Delivery,
  type PhoneSession,
  type PhoneVerdict,
} from "./store/phone.ts";

export interface FundamentalsTopic {
  id: string;
  name: string;
  covers: string[];
}

let cachedTopics: FundamentalsTopic[] | null = null;

export function fundamentalsTopics(): FundamentalsTopic[] {
  cachedTopics ??=
    readJson<{ topics: FundamentalsTopic[] }>(path.join(dataDir(), "phone", "fundamentals.json"))
      ?.topics ?? null;
  if (!cachedTopics) throw new Error("data/phone/fundamentals.json is missing");
  return cachedTopics;
}

export function topicIds(): Set<string> {
  return new Set(fundamentalsTopics().map((t) => t.id));
}

/** Fillers that are fillers wherever they appear. "Like" and "so" are not counted. */
const FILLERS: ReadonlyArray<[string, RegExp]> = [
  ["um", /\bu+m+\b/gi],
  ["uh", /\bu+h+\b/gi],
  ["er", /\b(?:er+m*|e+h)\b/gi],
  ["hmm", /\bhm+\b/gi],
  ["you know", /\byou know\b(?!\s+(?:what|how|why|when|where|that|if|the|a|about))/gi],
  ["I mean", /(?<!what )\bI mean\b(?!\s+(?:it|that|to|the))/gi],
  ["kind of", /\bkind of\b/gi],
  ["sort of", /\bsort of\b/gi],
  ["basically", /\bbasically\b/gi],
];

/** The page's raw numbers, as untrusted input. */
export interface DeliveryInput {
  spoken?: unknown;
  durationMs?: unknown;
  longPauses?: unknown;
}

export const MAX_REPLY_MS = 20 * 60_000;

/** How a reply was delivered, from its text and what the page measured. */
export function measureDelivery(text: string, input: DeliveryInput = {}): Delivery {
  const spoken = input.spoken === true;
  const rawMs =
    typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
      ? input.durationMs
      : 0;
  const durationMs = Math.round(Math.min(Math.max(rawMs, 0), MAX_REPLY_MS));
  const rawPauses =
    typeof input.longPauses === "number" && Number.isFinite(input.longPauses)
      ? input.longPauses
      : 0;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const counts: Array<[string, number]> = [];
  for (const [label, re] of FILLERS) {
    const n = text.match(re)?.length ?? 0;
    if (n > 0) counts.push([label, n]);
  }
  counts.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const fillers = counts.reduce((sum, [, n]) => sum + n, 0);
  // A reply of a few seconds has no meaningful pace.
  const wpm = spoken && durationMs >= 5_000 ? Math.round(words / (durationMs / 60_000)) : null;
  return {
    spoken,
    durationMs,
    words,
    wpm,
    fillers,
    fillerWords: counts.map(([label, n]) => `${label} ×${n}`),
    longPauses: spoken ? Math.min(Math.max(Math.round(rawPauses), 0), 200) : 0,
  };
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One line on a reply's delivery, for prompts and the page. */
export function deliveryLine(d: Delivery): string {
  if (!d.spoken) return `typed, ${d.words} words`;
  return [
    `spoken for ${formatDuration(d.durationMs)}`,
    `${d.words} words`,
    d.wpm === null ? "" : `${d.wpm} wpm`,
    d.fillers ? `fillers: ${d.fillerWords.join(", ")}` : "no fillers heard",
    d.longPauses ? `${d.longPauses} pause${d.longPauses === 1 ? "" : "s"} over 3 s` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Totals over every spoken reply in a session. */
export function deliverySummary(session: PhoneSession): {
  spokenReplies: number;
  typedReplies: number;
  averageWpm: number | null;
  fillersPerMinute: number | null;
  longPauses: number;
  longestMs: number;
} {
  const replies = session.questions.flatMap((q) => q.replies);
  const spoken = replies.filter((r) => r.delivery.spoken);
  const ms = spoken.reduce((sum, r) => sum + r.delivery.durationMs, 0);
  const words = spoken.reduce((sum, r) => sum + r.delivery.words, 0);
  const fillers = spoken.reduce((sum, r) => sum + r.delivery.fillers, 0);
  return {
    spokenReplies: spoken.length,
    typedReplies: replies.length - spoken.length,
    averageWpm: ms >= 5_000 ? Math.round(words / (ms / 60_000)) : null,
    fillersPerMinute: ms >= 5_000 ? Math.round((fillers / (ms / 60_000)) * 10) / 10 : null,
    longPauses: spoken.reduce((sum, r) => sum + r.delivery.longPauses, 0),
    longestMs: Math.max(0, ...replies.map((r) => r.delivery.durationMs)),
  };
}

/** Passed: at least one question answered, and every dimension of the format at 2 or more. */
export function phoneVerdict(session: PhoneSession, scores: Record<string, number>): PhoneVerdict {
  const answered = session.questions.some((q) => q.replies.length > 0);
  const rubricOk = PHONE_DIMENSIONS[session.format].every((d) => (scores[d] ?? -1) >= 2);
  return { correct: answered && rubricOk, rubricOk, answered };
}
