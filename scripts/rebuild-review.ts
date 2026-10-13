/**
 * Rebuild the spaced-review log from the sessions on disk.
 *
 *   node scripts/rebuild-review.ts [--dry-run]
 *
 * Boxes and due dates are always derived from review/events.jsonl, and that log is
 * itself derivable from the recorded sessions. Run this if the log is lost, or after
 * changing the verdict rule in src/flow.ts so that history is scored the same way as
 * new sessions. Uses ~/.chudcode unless CHUDCODE_DIR is set.
 */

import { eventsFromSessions, rebuildReviewLog } from "../src/flow.ts";
import { readReviewEvents } from "../src/store/review-events.ts";
import { reviewEventsFile } from "../src/store/paths.ts";
import { listSessions } from "../src/store/sessions.ts";

const dryRun = process.argv.includes("--dry-run");
const before = readReviewEvents().length;
const events = dryRun
  ? eventsFromSessions(listSessions(Number.MAX_SAFE_INTEGER))
  : rebuildReviewLog();
const sessions = new Set(events.map((event) => event.session)).size;

console.log(
  `${dryRun ? "Would write" : "Wrote"} ${events.length} review events from ${sessions} sessions to ${reviewEventsFile()} (was ${before}).`,
);
