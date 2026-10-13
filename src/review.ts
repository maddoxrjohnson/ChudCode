/**
 * review.ts: spaced review over patterns and problems, derived from session verdicts.
 *
 * Every recorded session appends one ReviewEvent per key it exercised: `pattern:<id>`
 * for each pattern the problem is tagged with and `problem:<slug>` for the problem
 * itself. The schedule is a Leitner system computed on every read from those events.
 * A correct verdict moves a key up one box, a wrong one sends it back to the first
 * box, and each box waits longer before the key is due again.
 *
 * Nothing here touches the filesystem or the clock, so it is tested in isolation.
 * The Leitner model and the derive-on-read approach follow pi-teach's src/review.ts
 * (Josh Noll, MIT); see docs/ATTRIBUTION.md.
 */

/** Days until the next review, for each box. Box 0 is the first box. */
export const DEFAULT_INTERVALS_DAYS: readonly number[] = [1, 3, 7, 21, 60];

/** A key in this box or higher counts as mastered on the dashboard. */
export const MASTERED_BOX = 3;

export const DAY_MS = 24 * 60 * 60 * 1000;

export type Difficulty = "easy" | "medium" | "hard";

export type ReviewKind = "pattern" | "problem";

/** One session's verdict for one key. */
export interface ReviewEvent {
  /** `pattern:<id>` or `problem:<slug>`. */
  key: string;
  /** When the session was recorded. */
  at: number;
  /** Passed all hidden tests within the timer at an acceptable complexity. */
  correct: boolean;
  /** The session that produced this verdict. */
  session: string;
  difficulty?: Difficulty;
  hintsUsed?: number;
  timeMs?: number;
}

export interface ReviewItem {
  key: string;
  kind: ReviewKind;
  /** The pattern id or problem slug. */
  id: string;
  box: number;
  dueAt: number;
  lastAt: number;
  lastCorrect: boolean;
  lastSession: string;
  lastDifficulty?: Difficulty;
  attempts: number;
  /** Consecutive correct verdicts ending at the latest event. */
  correctStreak: number;
}

export interface ScheduleOptions {
  /** Override the box intervals, for example to compress a schedule before an exam. */
  intervalsDays?: readonly number[];
}

const KEY_PATTERN = /^(pattern|problem):([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function makeKey(kind: ReviewKind, id: string): string {
  const key = `${kind}:${id}`;
  if (!KEY_PATTERN.test(key))
    throw new Error(`Invalid review id for ${kind}: ${JSON.stringify(id)}`);
  return key;
}

export function parseKey(key: string): { kind: ReviewKind; id: string } {
  const match = KEY_PATTERN.exec(key);
  if (!match) throw new Error(`Invalid review key: ${JSON.stringify(key)}`);
  return { kind: match[1] as ReviewKind, id: match[2] as string };
}

function resolveIntervals(options?: ScheduleOptions): readonly number[] {
  const intervals = options?.intervalsDays ?? DEFAULT_INTERVALS_DAYS;
  if (intervals.length === 0 || intervals.some((days) => !(days > 0) || !Number.isFinite(days))) {
    throw new Error("intervalsDays must be a non-empty list of positive numbers");
  }
  return intervals;
}

/** The box after one more verdict. */
export function nextBox(box: number, correct: boolean, intervals = DEFAULT_INTERVALS_DAYS): number {
  if (!correct) return 0;
  return Math.min(box + 1, intervals.length - 1);
}

/** Build one schedule item per key from its verdict history. */
export function scheduleItems(
  events: readonly ReviewEvent[],
  options?: ScheduleOptions,
): ReviewItem[] {
  const intervals = resolveIntervals(options);

  const byKey = new Map<string, ReviewEvent[]>();
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    const list = byKey.get(event.key);
    if (list) list.push(event);
    else byKey.set(event.key, [event]);
  }

  const items: ReviewItem[] = [];
  for (const [key, list] of byKey) {
    const { kind, id } = parseKey(key);
    let box = 0;
    let correctStreak = 0;
    for (const event of list) {
      box = nextBox(box, event.correct, intervals);
      correctStreak = event.correct ? correctStreak + 1 : 0;
    }
    const last = list[list.length - 1] as ReviewEvent;
    const item: ReviewItem = {
      key,
      kind,
      id,
      box,
      dueAt: last.at + (intervals[box] as number) * DAY_MS,
      lastAt: last.at,
      lastCorrect: last.correct,
      lastSession: last.session,
      attempts: list.length,
      correctStreak,
    };
    if (last.difficulty !== undefined) item.lastDifficulty = last.difficulty;
    items.push(item);
  }
  return items.sort((a, b) => a.dueAt - b.dueAt);
}

export function isDue(item: ReviewItem, now: number): boolean {
  return item.dueAt <= now;
}

/**
 * Choose the items for one review session: due items only, the most overdue first,
 * optionally restricted to one kind. Review sessions work on patterns, so a caller
 * usually passes `"pattern"`.
 */
export function pickReviewItems(
  items: readonly ReviewItem[],
  now: number,
  limit: number,
  kind?: ReviewKind,
): ReviewItem[] {
  return items
    .filter((item) => isDue(item, now) && (kind === undefined || item.kind === kind))
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, Math.max(0, limit));
}

export interface ReviewSummary {
  total: number;
  due: number;
  /** Items that become due within the next three days, not counting those due now. */
  dueSoon: number;
  mastered: number;
  /** The earliest due time among items that are not due yet. */
  nextDueAt: number | null;
}

export function summarize(items: readonly ReviewItem[], now: number): ReviewSummary {
  const upcoming = items.filter((item) => !isDue(item, now));
  return {
    total: items.length,
    due: items.length - upcoming.length,
    dueSoon: upcoming.filter((item) => item.dueAt <= now + 3 * DAY_MS).length,
    mastered: items.filter((item) => item.box >= MASTERED_BOX).length,
    nextDueAt: upcoming.length > 0 ? Math.min(...upcoming.map((item) => item.dueAt)) : null,
  };
}

/** "today", "tomorrow", "in 5 days", or "3 days ago", relative to `now`. */
export function relativeDay(at: number, now: number): string {
  const days = Math.round((at - now) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** "due today", "due tomorrow", "due in 5 days", "1 day overdue", "3 days overdue". */
export function dueText(dueAt: number, now: number): string {
  const overdue = Math.round((now - dueAt) / DAY_MS);
  if (overdue <= 0) return `due ${relativeDay(dueAt, now)}`;
  return overdue === 1 ? "1 day overdue" : `${overdue} days overdue`;
}

/**
 * Consecutive calendar days with at least one session, counting back from today.
 * A day that has not had a session yet does not break the streak until it is over,
 * so a streak that ended yesterday still counts. `tzOffsetMinutes` shifts the day
 * boundary to the learner's local midnight; the default is UTC.
 */
export function streak(sessionTimes: readonly number[], now: number, tzOffsetMinutes = 0): number {
  const dayOf = (at: number) => Math.floor((at + tzOffsetMinutes * 60 * 1000) / DAY_MS);
  const days = new Set(sessionTimes.map(dayOf));
  const today = dayOf(now);

  let day = days.has(today) ? today : today - 1;
  let count = 0;
  while (days.has(day)) {
    count += 1;
    day -= 1;
  }
  return count;
}
