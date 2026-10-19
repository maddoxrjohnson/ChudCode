# Agentic rubric

Five dimensions, each scored 0 to 4, or null when the lesson gave no evidence for it.
A lesson's focus dimensions are always scored, and each must reach 2 for the lesson to
pass. Score what the learner showed you, in the answer and the follow-ups, not what
they might know.

## Decomposition

| Score | Looks like                                                                                  |
| ----- | ------------------------------------------------------------------------------------------- |
| 0     | No structure: one undivided request to the agent, or a list of wishes.                      |
| 1     | Steps exist but are vague ("build the backend") or in an order that cannot work.            |
| 2     | Sensible phases that each produce something concrete; some steps too large to review.       |
| 3     | Phases small enough to review, in dependency order, each naming the files it touches.       |
| 4     | Everything in 3, plus explicit choices about what to defer, and why the order reduces risk. |

## Verification

| Score | Looks like                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Trusts the agent's word that it worked.                                                                                                                                 |
| 1     | "Run the tests" with no say in what the tests check, or tests written after the fact to match the output.                                                               |
| 2     | Each phase has a check the agent can run; some checks only confirm the happy path.                                                                                      |
| 3     | Checks pin behaviour, including edge cases and failure, before or alongside the code; a bug fix starts with a failing test.                                             |
| 4     | Everything in 3, plus independent verification: a separate agent or context grades the work, or tests are written by someone other than the agent that writes the code. |

## Context and cost

| Score | Looks like                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------- |
| 0     | Pours everything into one long conversation, or nothing at all into the agent's context.                                   |
| 1     | Context files that restate the code, or run to hundreds of lines.                                                          |
| 2     | Context files hold what the code does not show; little thought for session length or cost.                                 |
| 3     | Short, durable context; clears or compacts between tasks; pushes heavy reading into subagents.                             |
| 4     | Everything in 3, plus reasons about what a change costs (cache, model, effort) and plans switches at natural break points. |

## Safety

| Score | Looks like                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------- |
| 0     | Grants broad permissions with no review, or would merge agent output unread.                                     |
| 1     | Reviews output but would miss secrets, injection, or a weakened test.                                            |
| 2     | Reviews for the obvious risks; permissions broader than the task needs.                                          |
| 3     | Least-privilege permissions and tools; reviews diffs for security and invented APIs.                             |
| 4     | Everything in 3, plus guardrails that do not depend on the model remembering: hooks, deny rules, sandboxed runs. |

## Delegation

| Score | Looks like                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| 0     | Does everything in one agent, or delegates without saying what comes back.                                                |
| 1     | Delegates, but workers overlap, share state they should not, or return unbounded output.                                  |
| 2     | Clear jobs per worker with a stated result; the same model and effort for everything.                                     |
| 3     | Model, effort, and tools chosen per worker with reasons; independent workers run in parallel.                             |
| 4     | Everything in 3, plus hand-off contracts precise enough to check, and a plan for a worker that fails or returns nonsense. |
