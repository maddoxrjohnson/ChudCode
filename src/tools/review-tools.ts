/**
 * review-tools.ts: what is due for spaced review.
 */

import { loadProgress } from "../progress.ts";
import { dueListText } from "../prompts.ts";
import { ok, optionalInt, schema, type ToolDef } from "./index.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function reviewTools(): ToolDef[] {
  return [
    {
      name: "list_due",
      title: "List Due Reviews",
      description:
        "The patterns due for spaced review, most overdue first, each with its Leitner box and last result, followed by what comes due soon and the practice streak. " +
        "Call it when the user asks for a review session or asks what to work on.",
      inputSchema: schema.obj(
        {
          limit: schema.int(
            `At most this many due patterns. Default ${DEFAULT_LIMIT}.`,
            1,
            MAX_LIMIT,
          ),
        },
        ["limit"],
      ),
      async execute(args) {
        const limit = optionalInt(args, "limit", 1, MAX_LIMIT) ?? DEFAULT_LIMIT;
        const progress = loadProgress();
        const item = (i: (typeof progress.due)[number]) => ({
          pattern: i.id,
          box: i.box,
          dueAt: i.dueAt,
          lastCorrect: i.lastCorrect,
          lastAt: i.lastAt,
          attempts: i.attempts,
        });
        return ok(dueListText(progress, limit), {
          due: progress.due.slice(0, limit).map(item),
          dueSoon: progress.dueSoon.map(item),
          streakDays: progress.streakDays,
          summary: progress.summary,
        });
      },
    },
  ];
}
