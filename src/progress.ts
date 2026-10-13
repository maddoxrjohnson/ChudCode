/**
 * progress.ts: the candidate's standing, derived on read from the review log and
 * the pattern taxonomy: which Leitner box every pattern sits in, what is due, and how
 * many days in a row they have practised.
 *
 * `buildProgress` is pure and takes everything it needs; `loadProgress` reads the
 * stores. The dashboard, `list_due`, and the interview brief all draw on the same
 * numbers, so they cannot disagree about what is due.
 */

import {
  DAY_MS,
  DEFAULT_INTERVALS_DAYS,
  isDue,
  MASTERED_BOX,
  scheduleItems,
  streak,
  summarize,
  type ReviewItem,
  type ReviewSummary,
} from "./review.ts";
import { readConfig } from "./store/config.ts";
import { patterns, type PatternInfo } from "./store/problems.ts";
import { readReviewEvents, scheduleOptions } from "./store/review-events.ts";

/** Items that become due within this many days count as "due soon". */
export const DUE_SOON_DAYS = 3;

export interface PatternStanding {
  id: string;
  name: string;
  /** The Leitner box, or null when the pattern has never been exercised. */
  box: number | null;
  dueAt: number | null;
  due: boolean;
  mastered: boolean;
  attempts: number;
  /** Consecutive solved sessions ending at the latest one. */
  correctStreak: number;
  lastCorrect: boolean | null;
  lastAt: number | null;
  lastSession: string | null;
}

export interface Progress {
  now: number;
  /** Days each box waits before a key is due again, box 0 first. */
  intervalsDays: readonly number[];
  /** Every pattern in the taxonomy, in taxonomy order. */
  patterns: PatternStanding[];
  /** Pattern items due now, most overdue first. */
  due: ReviewItem[];
  /** Pattern items not yet due that come due within DUE_SOON_DAYS, soonest first. */
  dueSoon: ReviewItem[];
  /** Over the patterns that have been exercised. */
  summary: ReviewSummary;
  /** Consecutive days with a recorded session, ending today or yesterday. */
  streakDays: number;
  /** Sessions that produced a verdict. */
  sessionsScored: number;
  /** The review item for each problem the candidate has been scored on, by slug. */
  problems: Record<string, ReviewItem>;
}

export interface ProgressInput {
  items: readonly ReviewItem[];
  taxonomy: readonly PatternInfo[];
  /** When each session that counts was recorded, one entry per session. */
  sessionTimes: readonly number[];
  now: number;
  intervalsDays?: readonly number[];
  /** Minutes east of UTC, so the streak turns over at the learner's midnight. */
  tzOffsetMinutes?: number;
}

export function buildProgress(input: ProgressInput): Progress {
  const { now } = input;
  const patternItems = input.items.filter((item) => item.kind === "pattern");
  const byPattern = new Map(patternItems.map((item) => [item.id, item]));

  const standings: PatternStanding[] = input.taxonomy.map((pattern) => {
    const item = byPattern.get(pattern.id);
    if (!item) {
      return {
        id: pattern.id,
        name: pattern.name,
        box: null,
        dueAt: null,
        due: false,
        mastered: false,
        attempts: 0,
        correctStreak: 0,
        lastCorrect: null,
        lastAt: null,
        lastSession: null,
      };
    }
    return {
      id: pattern.id,
      name: pattern.name,
      box: item.box,
      dueAt: item.dueAt,
      due: isDue(item, now),
      mastered: item.box >= MASTERED_BOX,
      attempts: item.attempts,
      correctStreak: item.correctStreak,
      lastCorrect: item.lastCorrect,
      lastAt: item.lastAt,
      lastSession: item.lastSession,
    };
  });

  const due = patternItems.filter((item) => isDue(item, now)).sort((a, b) => a.dueAt - b.dueAt);
  const dueSoon = patternItems
    .filter((item) => !isDue(item, now) && item.dueAt <= now + DUE_SOON_DAYS * DAY_MS)
    .sort((a, b) => a.dueAt - b.dueAt);

  return {
    now,
    intervalsDays: input.intervalsDays ?? DEFAULT_INTERVALS_DAYS,
    patterns: standings,
    due,
    dueSoon,
    summary: summarize(patternItems, now),
    streakDays: streak(input.sessionTimes, now, input.tzOffsetMinutes ?? 0),
    sessionsScored: input.sessionTimes.length,
    problems: Object.fromEntries(
      input.items.filter((item) => item.kind === "problem").map((item) => [item.id, item]),
    ),
  };
}

/** The standing right now, from the review log and the configured intervals. */
export function loadProgress(now = Date.now()): Progress {
  const config = readConfig();
  const events = readReviewEvents();
  return buildProgress({
    items: scheduleItems(events, scheduleOptions(config)),
    taxonomy: patterns(),
    // A day counts when a verdict was recorded; the log holds exactly those moments.
    sessionTimes: [...new Map(events.map((event) => [event.session, event.at])).values()],
    now,
    intervalsDays: config.reviewIntervalsDays ?? DEFAULT_INTERVALS_DAYS,
    tzOffsetMinutes: -new Date(now).getTimezoneOffset(),
  });
}
