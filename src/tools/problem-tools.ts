/**
 * problem-tools.ts: how the interviewer gets a problem that does not exist yet.
 *
 * `lookup_seed` says what shape a pattern takes in real interviews. `write_problem`
 * stores an original bundle. `validate_problem` runs its reference against its own
 * cases and stamps it as servable. The loop is write, validate, read the report, fix,
 * validate again; `start_session` refuses anything that has not passed.
 */

import { plural } from "../format.ts";
import { readConfig } from "../store/config.ts";
import { isValidSlug } from "../store/paths.ts";
import {
  DIFFICULTIES,
  patternById,
  ProblemValidationError,
  problemExists,
  readProblem,
  writeProblem,
} from "../store/problems.ts";
import { lookupSeed, type SeedList, type SeedQuery } from "../seed.ts";
import { patternListText, seedLine, validationReportText, writtenProblemText } from "../prompts.ts";
import { trendById } from "../store/trends.ts";
import { lintBundle, validateProblem } from "../validate.ts";
import {
  fail,
  ok,
  optionalBool,
  optionalEnum,
  optionalString,
  requireString,
  schema,
  ToolArgumentError,
  type ToolDef,
} from "./index.ts";

const SOURCE_KINDS = ["generated", "mimic", "review"] as const;
const SEED_LISTS: readonly SeedList[] = ["grind75", "neetcode150"];
const COMPARE_MODES = ["exact", "unordered", "unordered-nested", "float", "any-of", "checker"];
const MAX_SEED_LINES = 60;

const CASE_SCHEMA = schema.obj(
  {
    id: schema.str("Unique within the problem: 1-32 letters, digits, - or _. Name what it tests."),
    label: schema.str('Shown to the candidate for visible cases, e.g. "Example 1".'),
    visible: schema.bool(
      "true for the worked examples in the statement, which the candidate sees and runs; false for hidden cases, which only Submit runs.",
    ),
    input: {
      type: "object",
      description:
        "Arguments by parameter name, as JSON. Linked lists and trees are written as arrays, LeetCode style. Omit when gen builds the input.",
    },
    gen: schema.str(
      'A Python expression evaluated in generators_py that returns the argument dict, e.g. "large(100000, 7)". Hidden cases only.',
    ),
    expected: {
      description:
        "The expected output. Omit it to have validate_problem fill it from the reference (oracle case). An explicit null expects None.",
    },
    compare: schema.oneOf(
      COMPARE_MODES,
      'How to compare: "exact" (default), "unordered" (list as a multiset), "unordered-nested" (list of lists, both levels unordered), "float" (within tolerance), "any-of" (expected lists every acceptable output), "checker" (checker_py decides).',
    ),
    tolerance: { type: "number", description: "For float compare. Default 1e-6, relative." },
    output_from: schema.str(
      "For in-place problems: the parameter whose value after the call is the output.",
    ),
  },
  ["label", "input", "gen", "expected", "compare", "tolerance", "output_from"],
);

export function problemTools(): ToolDef[] {
  return [
    {
      name: "lookup_seed",
      title: "Look Up Seed Problems",
      description:
        "Query the Grind 75 and NeetCode 150 lists: titles, difficulty, and the pattern each problem drills. Facts only, no statements. " +
        "Use it to see what shape a pattern takes in real interviews before writing an original problem, or to find the pattern behind a title the user named.",
      inputSchema: schema.obj(
        {
          pattern: schema.str("Only problems that drill this pattern id."),
          difficulty: schema.oneOf(DIFFICULTIES, "Only problems of this difficulty."),
          title: schema.str('Words from a title, e.g. "house robber". Best matches first.'),
          list: schema.oneOf(SEED_LISTS, "Only one list."),
        },
        ["pattern", "difficulty", "title", "list"],
      ),
      async execute(args) {
        const query: SeedQuery = {};
        const pattern = optionalString(args, "pattern", 64);
        if (pattern !== undefined) {
          if (!patternById(pattern))
            return fail(`Unknown pattern id: ${pattern}. Valid ids:\n${patternListText()}`);
          query.pattern = pattern;
        }
        const difficulty = optionalEnum(args, "difficulty", DIFFICULTIES);
        if (difficulty !== undefined) query.difficulty = difficulty;
        const title = optionalString(args, "title", 200);
        if (title !== undefined) query.title = title;
        const list = optionalEnum(args, "list", SEED_LISTS);
        if (list !== undefined) query.list = list;

        const entries = lookupSeed(query);
        if (entries.length === 0) return ok("No seed problem matches.", { entries: [] });
        const lines = entries.slice(0, MAX_SEED_LINES).map(seedLine);
        if (entries.length > MAX_SEED_LINES)
          lines.push(`…and ${entries.length - MAX_SEED_LINES} more. Narrow the query.`);
        return ok(lines.join("\n"), { entries });
      },
    },
    {
      name: "write_problem",
      title: "Write Problem",
      description:
        "Store an original problem bundle on disk: statement, signature, visible and hidden cases, reference solution, hints, complexity target. " +
        "The bundle is checked for shape and written atomically, but it cannot be served until validate_problem passes. " +
        "Writing to an existing slug that has never been served replaces it; that is how you fix a bundle that failed validation.",
      inputSchema: schema.obj(
        {
          slug: schema.str("Lowercase kebab-case, at most 64 characters, e.g. warmest-week."),
          title: schema.str("The title the candidate sees."),
          patterns: schema.list(
            schema.str("A pattern id."),
            "One or more pattern ids from the taxonomy. The first is the one this problem drills.",
          ),
          difficulty: schema.oneOf(DIFFICULTIES, "easy, medium, or hard."),
          statement_md: schema.str(
            'Markdown with "## Problem", "## Examples" (one per visible case, with the output explained), "## Constraints" (input bounds), and optionally "## Follow-up". Original wording; never a site name or link.',
          ),
          signature: schema.obj({
            style: schema.oneOf(
              ["function", "method"],
              '"function" for a top-level def; "method" for a method on class Solution.',
            ),
            name: schema.str("The function or method name, snake_case."),
            params: schema.list(
              schema.obj({
                name: schema.str("Parameter name."),
                type: schema.str(
                  "A Python type: int, str, List[int], List[List[int]], Optional[ListNode], Optional[TreeNode].",
                ),
              }),
              "Parameters in order.",
            ),
            returns: schema.str("The return type in the same notation."),
          }),
          tests: schema.list(
            CASE_SCHEMA,
            "Visible cases first (at least 2), then hidden cases (at least 6) including one max-size case built by a generator.",
          ),
          reference_py: schema.str(
            "The optimal solution, complete and importable: imports, then the function or class the signature names. Import ListNode and TreeNode from chud_types if needed.",
          ),
          hints: schema.list(
            schema.str("One hint."),
            "Two to four hints, vaguest first: a question about structure, the key observation, the mechanism. Never code.",
          ),
          complexity_target: schema.obj({
            time: schema.str("The reference's time bound, e.g. O(n log n)."),
            space: schema.str("The reference's extra space bound, e.g. O(1)."),
          }),
          source: schema.obj(
            {
              kind: schema.oneOf(
                SOURCE_KINDS,
                '"generated" for a problem you invented for a pattern, "mimic" when it follows the shape of a real problem the user named, "review" for a spaced-review variant.',
              ),
              mimic_of: schema.str(
                "For mimic: the title of the real problem whose shape this follows.",
              ),
              trend_ids: schema.list(
                schema.str("A trend id, e.g. t-5c1d9a0b2e."),
                "The trend entries this problem's shape was drawn from, as listed in the brief or by list_trends. Cite them when a company's recent interviews shaped the problem.",
              ),
            },
            ["mimic_of", "trend_ids"],
          ),
          generators_py: schema.str(
            "Python defining the functions that gen expressions call. Each returns a dict of arguments by name. Use random.Random(seed) so cases are reproducible.",
          ),
          checker_py: schema.str(
            "Python defining check(input, actual, expected) -> bool, for problems with several correct outputs.",
          ),
          reveal_failing_input: schema.bool(
            "Whether a failed Submit may show the candidate the first failing hidden input. Default true.",
          ),
        },
        ["generators_py", "checker_py", "reveal_failing_input"],
      ),
      async execute(args) {
        const slug = requireString(args, "slug", 64);
        if (!isValidSlug(slug))
          throw new ToolArgumentError("slug must be lowercase kebab-case, at most 64 characters");

        let createdAt: number | undefined;
        if (problemExists(slug)) {
          const existing = readProblem(slug).meta;
          if (existing.timesServed > 0) {
            return fail(
              `${slug} has been served ${existing.timesServed} time${existing.timesServed === 1 ? "" : "s"} and sessions refer to it. Choose a new slug.`,
            );
          }
          createdAt = existing.createdAt;
        }

        const signature = args["signature"];
        const complexity = asRecord(args["complexity_target"]);
        const source = asRecord(args["source"]);
        const tests = Array.isArray(args["tests"])
          ? args["tests"].map((raw: unknown) => {
              const record = asRecord(raw);
              if (!record) return raw;
              const { output_from: outputFrom, ...rest } = record;
              return outputFrom === undefined ? rest : { ...rest, outputFrom };
            })
          : args["tests"];
        const hints = Array.isArray(args["hints"])
          ? args["hints"].map((text: unknown, i: number) => ({ level: i + 1, text }))
          : args["hints"];

        const meta: Record<string, unknown> = {
          slug,
          title: args["title"],
          patterns: args["patterns"],
          difficulty: args["difficulty"],
          language: "python",
          signature,
          complexityTarget: complexity
            ? { time: complexity["time"], space: complexity["space"] }
            : complexity,
          source: source
            ? { kind: source["kind"], mimicOf: source["mimic_of"], trendIds: source["trend_ids"] }
            : source,
          timesServed: 0,
        };
        if (createdAt !== undefined) meta["createdAt"] = createdAt;
        const reveal = optionalBool(args, "reveal_failing_input");
        if (reveal !== undefined) meta["revealFailingInput"] = reveal;
        if (source && !SOURCE_KINDS.includes(source["kind"] as (typeof SOURCE_KINDS)[number])) {
          return fail(`source.kind must be one of ${SOURCE_KINDS.join(", ")}`);
        }
        const trendIds = source?.["trend_ids"];
        if (Array.isArray(trendIds) && trendIds.every((id) => typeof id === "string")) {
          const unknown = (trendIds as string[]).filter((id) => trendById(id) === undefined);
          if (unknown.length > 0) {
            return fail(
              `source.trend_ids names ${plural(unknown.length, "entry", "entries")} not on file: ${unknown.join(", ")}. Cite ids from the brief or from list_trends, or leave trend_ids out.`,
            );
          }
        }

        const bundle = {
          meta,
          statement: requireString(args, "statement_md", 20_000),
          tests,
          reference: requireString(args, "reference_py", 50_000),
          hints,
          generators: optionalString(args, "generators_py", 50_000),
          checker: optionalString(args, "checker_py", 50_000),
        };

        try {
          const written = writeProblem(bundle as never);
          const lint = lintBundle(written);
          return ok(writtenProblemText(written, lint), { slug, lint });
        } catch (err) {
          if (err instanceof ProblemValidationError) {
            return fail(
              `the bundle was not written:\n- ${err.problems.join("\n- ")}\nFix these and call write_problem again.`,
              { problems: err.problems },
            );
          }
          throw err;
        }
      },
    },
    {
      name: "validate_problem",
      title: "Validate Problem",
      description:
        "Prove a problem is ready: lint its shape, run the reference solution against every case under strict limits, fill in the expected output of oracle cases, and mark it validated on a full pass. " +
        "Returns a report naming every case that disagrees with the reference, errors, or times out. Only validated problems can be served.",
      inputSchema: schema.obj({
        slug: schema.str("The problem's slug, from write_problem or list_problems."),
      }),
      async execute(args) {
        const slug = requireString(args, "slug", 64);
        if (!isValidSlug(slug) || !problemExists(slug))
          return fail(`No problem named ${slug}. Call list_problems.`);
        const report = await validateProblem(slug, readConfig().limits.validate);
        const bundle = readProblem(slug);
        return ok(validationReportText(report, bundle), {
          passed: report.passed,
          lint: report.lint,
          filled: report.filled,
          disagreements: report.disagreements.length,
          broken: report.broken.length,
          run: { status: report.run.status, passed: report.run.passed, total: report.run.total },
        });
      },
    },
  ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
