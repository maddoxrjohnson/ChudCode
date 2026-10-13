/**
 * review-events.ts: the append-only log that the Leitner schedule is derived from.
 *
 * One line per (session, key). Boxes and due dates are never stored; `review.ts`
 * recomputes them from this log on every read, so a change to the intervals or the
 * verdict rule applies to history as well as to new sessions.
 */

import {
  scheduleItems,
  type ReviewEvent,
  type ReviewItem,
  type ScheduleOptions,
} from "../review.ts";
import { readConfig, type Config } from "./config.ts";
import { appendJsonl, readJsonl, writeText } from "./json.ts";
import { reviewEventsFile } from "./paths.ts";

export function appendReviewEvents(events: readonly ReviewEvent[]): void {
  for (const event of events) appendJsonl(reviewEventsFile(), event);
}

export function readReviewEvents(): ReviewEvent[] {
  return readJsonl<ReviewEvent>(reviewEventsFile());
}

/** Replace the whole log, for a rebuild from the sessions on disk. */
export function rewriteReviewEvents(events: readonly ReviewEvent[]): void {
  writeText(reviewEventsFile(), events.map((event) => JSON.stringify(event) + "\n").join(""));
}

/** The intervals the learner configured, if any. */
export function scheduleOptions(config: Config = readConfig()): ScheduleOptions | undefined {
  return config.reviewIntervalsDays ? { intervalsDays: config.reviewIntervalsDays } : undefined;
}

/** The current schedule: every key with its box and due time, derived from the log. */
export function reviewItems(config: Config = readConfig()): ReviewItem[] {
  return scheduleItems(readReviewEvents(), scheduleOptions(config));
}
