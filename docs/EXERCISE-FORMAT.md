# Exercise format

An exercise is what a lesson session serves: the teaching, a brief to work from, and
private material the interviewer grades against. The interviewer writes a fresh one
for each lesson with `write_exercise` and validates it with `validate_exercise`
before serving it with `start_lesson`.

```
~/.chudcode/exercises/<slug>/
  meta.json      { slug, kind, lesson, title, createdAt, validatedAt?, timesServed, lastServedAt? }
  teaching.md    the lesson, citing curriculum facts as [fact:<id>]
  brief.md       "## Scenario" and "## Your task" ("## Your task" alone for a lab,
                 a media lab, or a transcript review)
  private.json   { modelOutline, followUps[], pitfalls[], mutation?, flawReview?, cachePlan?, refactor? }
```

The page shows `teaching.md` and `brief.md` only. `private.json` never leaves the
server: the browser routes build their view through `publicExercise`, and a test
checks that the outline and follow-ups appear on no page or API response.

## Validation

`validate_exercise` checks that:

- the exercise's lesson exists and lists its kind;
- the brief is 200 to 8,000 characters with its kind's sections;
- a lab is for a lesson with a lab checklist and lab files, and a media lab or a
  transcript review for a lesson with a checklist;
- the teaching is 600 to 16,000 characters, cites every core fact of the lesson, and
  cites no fact the lesson does not have, so nothing unsourced is taught as fact;
- the outline is at least 200 characters, with at least two follow-ups and two
  pitfalls, and the outline does not appear in the brief or teaching.

Writing an exercise again clears its validation.

## Kinds

| Kind            | The learner                                                                     | Graded by                                                                          |
| --------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `design-review` | writes a plan, a context file, or a delegation spec for the scenario            | the interviewer, on the rubric                                                     |
| `mutation`      | has their agent write tests for a module, then presses Grade                    | code: the suite must pass correct variants and catch 80% of planted bugs           |
| `flaw-review`   | marks the lines of an agent's diff they would block, with a category and reason | code: every critical flaw, 70% of all, few false alarms                            |
| `cache-plan`    | has their agent plan prompt order and cache breakpoints for a workload          | code: within 10% of the best plan's simulated cost                                 |
| `refactor`      | has their agent commit characterisation tests, then refactor and commit         | code: tests first, 60% of bugs caught, behaviour and interface kept, simpler shape |
| `transcript`    | picks one of their own Claude Code sessions and consents                        | the interviewer, on the rubric and the lesson's checklist                          |
| `lab`           | builds it in their own repository and submits the folder                        | the interviewer, on the rubric and the lesson's checklist                          |
| `media-lab`     | ships a site, demo video, and images in their repository and submits the folder | code: no fail-level media check fails; then the interviewer, as for a lab          |

Every kind the curriculum lists can be served.

## Mutation drills

`private.json` holds a `mutation` object: `module` (the import name), `reference`
(the module the learner sees), `rewrites` (equivalent implementations), `mutants`
(`{ id, description, find, replace }`, where `find` occurs exactly once in the
reference), and `oracleTests` (the author's unittest module). Validation checks the
shape, then runs the oracle through `src/drill/mutation.ts`: it must pass on the
reference twice and on every rewrite, and kill every mutant, within the drill's
limits (2 seconds a test, 20 seconds a suite).

The learner's workspace is `~/chudcode-drills/<session id>/` (move it with
`CHUDCODE_WORKSPACES`), deliberately outside the state root. Grading reads only
regular files directly in `tests/`, at most 30 of them and 300 KB in all, and runs
each variant through `ProcessRunner.runSuite` with
`src/runner/adapters/python/suite_harness.py`, which discovers `tests/test*.py`,
counts each test's assertions from its syntax tree, and runs each test under its own
alarm. A test file that mentions `.chudcode` or `private.json`, or holds half the
module's lines, fails the gate outright. This is practice, not proctoring: a
determined agent could still find the hidden variants on disk, but the checks make
the usual shortcuts visible.

## Labs

A lab reads the learner's own project, so it is fenced more tightly than anything
else in ChudCode (`src/lab.ts`):

- The folder comes from the page, where the learner sees the files a review would
  read and ticks a consent box. `inspect_lab` takes only a session id; the agent
  cannot name a path.
- The folder may not be `/`, the home directory or anything above it, or anything
  inside or above `~/.chudcode`.
- Only the lesson's `labFiles` are read, and every lesson pattern must be on
  `LAB_ALLOW` (context files, `.claude/skills`, `.claude/agents`, `.claude/commands`,
  `.claude/settings.json`, `.mcp.json`). `.env*`, keys, anything named secret or
  credential, and `.git/` are never read, whatever a pattern says.
- A link is followed only when its target stays inside the folder.
- At most 40 files, 64 KB each and 256 KB in all. Anything that looks like a token,
  key, or password is redacted before the agent sees it.
- `git log --stat` for the last 12 commits runs through `execFile`, with no pager,
  no external diff or textconv, no fsmonitor, and the user's global and system git
  config ignored.

What was read is kept as `lessons/<id>/lab/NN.json`, so the debrief's evidence
survives the folder changing. Mechanical lints (an undocumented subagent field, a
CLAUDE.md past 200 lines, an AGENTS.md that a CLAUDE.md shadows) each name the
curriculum fact they rest on. `record_lesson` must give every checklist item a
status of met, partial, or missing; a lab passes when it was inspected, nothing is
missing outright, and every focus dimension scored 2 or more.

## Flaw reviews

`private.json` holds `flawReview`: the `diff` (shown on the page), `flaws`
(`{ id, file, line, endLine?, category, critical, explanation }`), and `decoys`
(`{ file, line, note }`). Validation parses the diff, checks every flaw sits on
added lines of the new file and every decoy on a real line away from the flaws, and
that no explanation appears in the brief or teaching. Grading is
`src/drill/flaw-review.ts`. The page and its API get the diff and, after each
submission, counts; the explanations and the missed lines come out in the debrief.

## Cache plans

`private.json` holds `cachePlan`: the `scenario` (shown) and the `reference` plan
(not). `data/agentic/cache-model.json` holds every price, multiplier, lifetime, and
limit the simulator uses, each listing the curriculum facts it rests on; a test
fails if one names a fact the curriculum lacks.

## Refactor drills

`private.json` holds `refactor`: `module`, `legacy` (what the learner starts from),
`clean` (the author's refactor), `mutants` of the legacy module, and `oracleTests`.
Validation requires the clean version to keep the legacy module's public functions
and parameters and to have a shorter longest function or shallower nesting, and runs
the oracle as for a mutation drill with the clean version as its one rewrite. The
workspace is a git repository whose first commit, "Start the drill", holds the
legacy module; grading reads the history through the same hardened `git` as labs.
`src/drill/refactor.ts` measures shape from indentation and the interface from
top-level `def` and `class` lines: rough, but stable enough to see a restructure.

## Transcript reviews

The learner's Claude Code session logs live in `~/.claude/projects/<project>/*.jsonl`
(`CHUDCODE_CLAUDE_PROJECTS` moves it). Nothing is listed until the learner presses
the button, the page refers to a log only by a hash of its path, and the path is
resolved again on every read. `src/transcript.ts` reads at most 32 MB, skips lines
that do not parse, counts usage once per message id, and returns counts and the
learner's first prompts (clipped and redacted), never the replies or tool output.
The format is Claude Code's own, not a published contract, so every field is
optional to the reader.

## Media labs

A media lab measures what the learner shipped to show their app off. Its brief has
only "## Your task", since the scenario is their own project, and its lesson needs a
checklist. The project comes from the page with the learner's consent, through the
lab's guards (`resolveProjectRoot`, the deny-list, no links out of the folder).
`src/media-lab.ts` then opens:

- HTML pages at the root or in `docs/`, `site/`, `public/`, or `web/` (12 at most,
  256 KB each), and the root README;
- the images and videos those reference or that sit anywhere else in the project (80
  at most), by their headers only: `src/media/probe.ts` reads PNG, JPEG, GIF, WebP,
  SVG, AVIF, MP4, and WebM in at most 1 MB of positioned reads per file, never
  decoding a frame, and a truncated or hostile file comes back with an error;
- up to three images under 1 MB (the og:image, a video poster, then a screenshot),
  which `inspect_media` returns to the interviewer as MCP image content.

The checks are in `data/agentic/media-checks.json`. Each has an id the engine knows,
a severity (`fail` or `warn`), and the curriculum facts it rests on, or a `basis`
saying when a threshold is ChudCode's own budget rather than a platform's rule; a
test keeps the file, the engine, and the curriculum in step. A check that does not
apply (captions on a silent video, root-absolute links on a site with a `CNAME`) is
`n/a`. The latest measurement decides the gate: the lesson cannot pass while a
`fail` check fails, whatever the rubric says. The page shows every check and its
findings after each measurement; nothing about it is hidden.
