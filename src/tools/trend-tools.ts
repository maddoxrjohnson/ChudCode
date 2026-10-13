/**
 * trend-tools.ts: what companies have been asking, recorded and read back.
 *
 * `record_trends` is how the research skill saves what it found on the web, as
 * pattern and constraints rather than statements. `list_trends` is how the user and
 * the interviewer see what is on file. The brief from `begin_interview` carries the
 * same entries for the company the user named.
 */

import { patternListText, recordedTrendsText, trendListText } from "../prompts.ts";
import { DIFFICULTIES, patternById } from "../store/problems.ts";
import {
  addTrends,
  listTrends,
  MAX_SHAPE_NOTE,
  TrendValidationError,
  type TrendFilter,
} from "../store/trends.ts";
import {
  fail,
  ok,
  optionalInt,
  optionalString,
  schema,
  ToolArgumentError,
  type ToolDef,
} from "./index.ts";

const MAX_ENTRIES = 50;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const ENTRY_SCHEMA = schema.obj(
  {
    pattern: schema.str(
      "The pattern id the problem drilled, from the taxonomy: graphs, sliding-window, dp-1d, and so on. One entry per pattern.",
    ),
    company: schema.str("The company, as the post names it."),
    role: schema.str(
      'The role the post was about, as it says it: "new grad SWE", "intern", "L4 backend".',
    ),
    difficulty: schema.oneOf(DIFFICULTIES, "As the post describes it, or as the shape implies."),
    seen_at: schema.str(
      "When the interview happened, YYYY-MM-DD. Use the first of the month when the post gives only a month.",
    ),
    source_url: schema.str("The post's URL."),
    shape_note: schema.str(
      `One or two sentences, at most ${MAX_SHAPE_NOTE} characters, in your own words: the pattern, the input and its size, the twist that makes the pattern necessary, the follow-up if any. Never the statement, an example, a title from another site, or a link.`,
    ),
  },
  ["role", "difficulty"],
);

/** Tool arguments are snake_case; the file and its error messages are camelCase. */
const FIELD_NAMES: Record<string, string> = {
  seenAt: "seen_at",
  sourceUrl: "source_url",
  shapeNote: "shape_note",
};

export function trendTools(): ToolDef[] {
  return [
    {
      name: "record_trends",
      title: "Record Trends",
      description:
        "Save what recent interview-experience posts say a company has been asking: one entry per pattern per post, with the role, the date, the source URL, and a short paraphrase of the problem's shape. " +
        "Entries are checked before any is written; a post already on file for the same pattern and company is skipped, not duplicated. Returns what was added and what was already there.",
      inputSchema: schema.obj({
        entries: schema.list(ENTRY_SCHEMA, `Up to ${MAX_ENTRIES} entries.`),
      }),
      async execute(args) {
        const raw = args["entries"];
        if (!Array.isArray(raw) || raw.length === 0) {
          throw new ToolArgumentError("entries must be a non-empty list");
        }
        if (raw.length > MAX_ENTRIES) {
          throw new ToolArgumentError(`entries has more than ${MAX_ENTRIES} items`);
        }
        try {
          const result = addTrends(raw.map(toInput));
          return ok(recordedTrendsText(result), {
            added: result.added.length,
            skipped: result.skipped.length,
            addedIds: result.added.map((e) => e.id),
            skippedIds: result.skipped.map((e) => e.id),
          });
        } catch (err) {
          if (err instanceof TrendValidationError) {
            const problems = err.problems.map(toolFieldNames);
            const lines = [`no entries were recorded:\n- ${problems.join("\n- ")}`];
            if (problems.some((p) => p.includes(".pattern "))) {
              lines.push(`Valid pattern ids:\n${patternListText()}`);
            }
            lines.push("Fix these and call record_trends again.");
            return fail(lines.join("\n"), { problems });
          }
          throw err;
        }
      },
    },
    {
      name: "list_trends",
      title: "List Trends",
      description:
        "The interview trends on file, most recently seen first: for each, the pattern, company, role, date, shape note, and source. " +
        "Filter by company or pattern. Call it to see what research has already found before doing more, or when the user asks what a company has been asking.",
      inputSchema: schema.obj(
        {
          company: schema.str("Only entries for this company, matched ignoring case."),
          pattern: schema.str("Only entries on this pattern id."),
          limit: schema.int(`At most this many entries. Default ${DEFAULT_LIMIT}.`, 1, MAX_LIMIT),
        },
        ["company", "pattern", "limit"],
      ),
      async execute(args) {
        const filter: TrendFilter = {};
        const company = optionalString(args, "company", 80);
        if (company !== undefined) filter.company = company;
        const pattern = optionalString(args, "pattern", 64);
        if (pattern !== undefined) {
          if (!patternById(pattern)) {
            return fail(`Unknown pattern id: ${pattern}. Valid ids:\n${patternListText()}`);
          }
          filter.pattern = pattern;
        }
        const limit = optionalInt(args, "limit", 1, MAX_LIMIT) ?? DEFAULT_LIMIT;
        const entries = listTrends(filter);
        return ok(trendListText(entries, filter, limit), {
          entries: entries.slice(0, limit),
          total: entries.length,
        });
      },
    },
  ];
}

/** Map one tool-shaped entry onto the store's field names; non-objects pass through. */
function toInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const input: Record<string, unknown> = {
    pattern: record["pattern"],
    company: record["company"],
    seenAt: record["seen_at"],
    sourceUrl: record["source_url"],
    shapeNote: record["shape_note"],
  };
  if (record["role"] !== undefined) input["role"] = record["role"];
  if (record["difficulty"] !== undefined) input["difficulty"] = record["difficulty"];
  return input;
}

function toolFieldNames(problem: string): string {
  return problem.replace(
    /\.(seenAt|sourceUrl|shapeNote)\b/g,
    (_, field: string) => `.${FIELD_NAMES[field]}`,
  );
}
