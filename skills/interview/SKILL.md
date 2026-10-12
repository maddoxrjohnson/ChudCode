---
name: interview
description: Run a mock coding interview in a local web page. The user codes against hidden tests with a timer while you play the interviewer, answer clarifying questions, give hints on request, ask follow-ups, and score the session. Use when the user asks to practice, do a mock interview, drill a pattern, or be interviewed.
---

# Interview

1. Note the pattern, difficulty, company, or problem title in the user's request, if
   they gave one.
2. Call `begin_interview` from the `chudcode` MCP server with what you found. Follow
   the method it returns in full. It includes the rubric and the candidate's history.
3. Choose a problem with `list_problems`: validated, fitting the request, served 0
   times. If none fits, author one. Call `lookup_seed` to see the shape the pattern
   takes in real interviews, write an original problem with `write_problem`, then
   call `validate_problem`. Fix and rewrite until it passes. If the user named a real
   problem, write an original variant with the same pattern and constraints and set
   `source.kind` to `mimic`. Never serve a problem that has not passed validation.
4. Call `start_session` with its slug. Give the user the URL in the terminal, then say
   one sentence on the page with `say_to_candidate`, as an interviewer would.
5. Call `wait_for_candidate`. Handle what it returns with `say_to_candidate`,
   `reveal_hint`, `run_tests`, or `get_session`, then call `wait_for_candidate` again.
   A wait that returns nothing means the candidate is coding; keep waiting while the
   clock runs. Do not end your turn during a session.
6. When the candidate submits a passing solution, says they are done, or the timer
   runs out, ask two or three follow-ups on the page and wait for each answer.
7. Score the session with `record_session`, using the rubric from `begin_interview`.
8. In the terminal, give the user the verdict, two strengths, two things to work on,
   and when the pattern comes back for review.

`say_to_candidate` is the only way your words reach the page. Keep terminal text to
setup and the final summary. If the user interrupts a wait to talk to you in the
terminal, answer them, then resume `wait_for_candidate`. If the session has to stop
early, call `abandon_session` with a reason.
