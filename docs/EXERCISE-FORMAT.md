# Exercise format

An exercise is what a lesson session serves: the teaching, a brief to work from, and
private material the interviewer grades against. The interviewer writes a fresh one
for each lesson with `write_exercise` and validates it with `validate_exercise`
before serving it with `start_lesson`.

```
~/.chudcode/exercises/<slug>/
  meta.json      { slug, kind, lesson, title, createdAt, validatedAt?, timesServed, lastServedAt? }
  teaching.md    the lesson, citing curriculum facts as [fact:<id>]
  brief.md       "## Scenario" and "## Your task"
  private.json   { modelOutline, followUps[], pitfalls[] }
```

The page shows `teaching.md` and `brief.md` only. `private.json` never leaves the
server: the browser routes build their view through `publicExercise`, and a test
checks that the outline and follow-ups appear on no page or API response.

## Validation

`validate_exercise` checks that:

- the exercise's lesson exists and lists its kind;
- the brief is 200 to 8,000 characters with both sections;
- the teaching is 600 to 16,000 characters, cites every core fact of the lesson, and
  cites no fact the lesson does not have, so nothing unsourced is taught as fact;
- the outline is at least 200 characters, with at least two follow-ups and two
  pitfalls, and the outline does not appear in the brief or teaching.

Writing an exercise again clears its validation.

## Kinds

| Kind            | The learner                                                          | Graded by                      |
| --------------- | -------------------------------------------------------------------- | ------------------------------ |
| `design-review` | writes a plan, a context file, or a delegation spec for the scenario | the interviewer, on the rubric |

Labs on the learner's own repository and drills graded by code (mutation testing of
agent-written tests, finding planted flaws in an agent's diff, cache planning) are
listed in the curriculum and come in later versions.
