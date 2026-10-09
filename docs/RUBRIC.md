# Rubric

Score each dimension from 0 to 4 when you call `record_session`. Anchor on the
descriptions, not on how you feel about the candidate. A 2 is a normal, passable
performance for the level the candidate is practising at.

## Correctness

| Score | Looks like                                                                            |
| ----- | ------------------------------------------------------------------------------------- |
| 0     | No submission, or nothing passes.                                                     |
| 1     | Visible examples pass; hidden cases mostly fail. The approach is wrong or incomplete. |
| 2     | Most hidden cases pass. One or two edge cases are missed (empty input, bounds).       |
| 3     | Every case passes after at least one failed submission that the candidate diagnosed.  |
| 4     | Every case passes on the first submission, or on a second one within a minute.        |

## Communication

| Score | Looks like                                                                              |
| ----- | --------------------------------------------------------------------------------------- |
| 0     | Silent start to finish. No approach note, no questions, no response to prompts.         |
| 1     | Started coding with no plan stated. Answered direct questions only.                     |
| 2     | Stated an approach before coding. Explained when asked. Some long silences unexplained. |
| 3     | Clarified constraints, stated the approach and its complexity, narrated key decisions.  |
| 4     | Everything in 3, plus named trade-offs and alternatives unprompted, and used the        |
|       | interviewer's questions to improve the solution.                                        |

## Complexity

| Score | Looks like                                                                              |
| ----- | --------------------------------------------------------------------------------------- |
| 0     | Could not state the complexity, or stated it wrongly and did not correct it.            |
| 1     | Stated it correctly only after heavy prompting. Solution is far from the target.        |
| 2     | Stated time complexity correctly. Space complexity missing or wrong, or the solution is |
|       | one factor off the target (for example O(n log n) where O(n) was expected).             |
| 3     | Time and space stated correctly and the solution meets the target.                      |
| 4     | Everything in 3, plus the candidate explained why the target is optimal or what a       |
|       | better bound would require.                                                             |

`complexity_ok` is true when the submitted solution actually meets the problem's
complexity target. It is a fact about the code, not about what the candidate said.
A slow solution with a perfect explanation gets a high Complexity score and
`complexity_ok: false`.

## Code quality

| Score | Looks like                                                                          |
| ----- | ----------------------------------------------------------------------------------- |
| 0     | Does not run, or is unreadable: single-letter names everywhere, no structure.       |
| 1     | Runs. Hard to follow. Duplicated logic, magic numbers, leftover debugging.          |
| 2     | Readable. Reasonable names. A few things you would flag in review.                  |
| 3     | Clean. Clear names, small functions where they help, handles edge cases explicitly. |
| 4     | Code you would merge. Idiomatic for the language, nothing wasted, nothing missing.  |

## Time

| Score | Looks like                                                                         |
| ----- | ---------------------------------------------------------------------------------- |
| 0     | Timer expired with no working solution.                                            |
| 1     | Timer expired, or finished with less than a minute left after heavy hints.         |
| 2     | Finished with time to spare but used two or more hints, or needed all of the time. |
| 3     | Finished with a few minutes left and at most one hint.                             |
| 4     | Finished comfortably, no hints, and used the remaining time to test or improve.    |

## The verdict

`record_session` computes `correct` for you:

- every hidden case passed on the last submission, and
- the candidate finished before the timer ran out, and
- `complexity_ok` was true.

That verdict drives spaced review. A solved problem moves its patterns up a box; a
missed one sends them back to the first box so the pattern comes around again soon.
Do not soften `complexity_ok` to make a verdict kinder. A candidate who passes with a
brute-force solution needs to see that pattern again, and the schedule is how they do.

## Notes, strengths, improvements

`notes_md` is a short paragraph in your own words about how the session went. Write it
for the candidate to read later. Then give exactly the two most useful strengths and
the two most useful improvements, each one sentence, each specific to what happened
in this session. "Communicate more" is useless; "state the complexity before you start
coding, not after you're asked" is something they can do next time.
