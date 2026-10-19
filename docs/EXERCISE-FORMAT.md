# Exercise format

An exercise is what a lesson session serves: the teaching, a brief to work from, and
private material the interviewer grades against. The interviewer writes a fresh one
for each lesson with `write_exercise` and validates it with `validate_exercise`
before serving it with `start_lesson`.

```
~/.chudcode/exercises/<slug>/
  meta.json      { slug, kind, lesson, title, createdAt, validatedAt?, timesServed, lastServedAt? }
  teaching.md    the lesson, citing curriculum facts as [fact:<id>]
  brief.md       "## Scenario" and "## Your task" ("## Your task" alone for a lab)
  private.json   { modelOutline, followUps[], pitfalls[] }
```

The page shows `teaching.md` and `brief.md` only. `private.json` never leaves the
server: the browser routes build their view through `publicExercise`, and a test
checks that the outline and follow-ups appear on no page or API response.

## Validation

`validate_exercise` checks that:

- the exercise's lesson exists and lists its kind;
- the brief is 200 to 8,000 characters with its kind's sections;
- a lab is for a lesson with a lab checklist and lab files;
- the teaching is 600 to 16,000 characters, cites every core fact of the lesson, and
  cites no fact the lesson does not have, so nothing unsourced is taught as fact;
- the outline is at least 200 characters, with at least two follow-ups and two
  pitfalls, and the outline does not appear in the brief or teaching.

Writing an exercise again clears its validation.

## Kinds

| Kind            | The learner                                                          | Graded by                                                 |
| --------------- | -------------------------------------------------------------------- | --------------------------------------------------------- |
| `design-review` | writes a plan, a context file, or a delegation spec for the scenario | the interviewer, on the rubric                            |
| `lab`           | builds it in their own repository and submits the folder             | the interviewer, on the rubric and the lesson's checklist |

Drills graded by code (mutation testing of agent-written tests, finding planted
flaws in an agent's diff, cache planning) are listed in the curriculum and come in
later versions.

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
