/**
 * review-events.ts: the append-only log that the Leitner schedule is derived from.
 *
 * One line per (session, key). Boxes and due dates are never stored; `review.ts`
 * recomputes them from this log on every read.
 */

import type { ReviewEvent } from "../review.ts";
import { appendJsonl, readJsonl } from "./json.ts";
import { reviewEventsFile } from "./paths.ts";

export function appendReviewEvents(events: readonly ReviewEvent[]): void {
  for (const event of events) appendJsonl(reviewEventsFile(), event);
}

export function readReviewEvents(): ReviewEvent[] {
  return readJsonl<ReviewEvent>(reviewEventsFile());
}
