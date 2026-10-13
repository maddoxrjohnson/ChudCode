---
name: review
description: Run a spaced-review session: a fresh problem on the pattern the user is most overdue to see again, scored like an interview so the schedule moves. Use when the user asks to review, asks what is due or what to work on, or wants to drill the patterns they keep missing.
---

# Review

1. Call `begin_interview` from the `chudcode` MCP server with `mode` set to `review`,
   and `pattern` if the user named one. Follow the method it returns in full. It
   names the most overdue pattern and lists everything that is due.
2. If nothing is due, say so in one sentence and offer a regular interview on the
   pattern that comes due soonest, or on whatever they prefer. Stop there unless
   they take the offer.
3. Get a problem on that pattern that the candidate has not seen. Call
   `list_problems` filtered to the pattern and to validated problems; one served 0
   times will do. Otherwise write one: `lookup_seed` for the shape, `write_problem`
   with `source.kind` set to `review`, then `validate_problem` until it passes. Never
   serve a problem they have seen. A review tests the pattern, not their memory of a
   problem.
4. Call `start_session` with the slug and `mode` set to `review`. Give the user the
   URL in the terminal, say one sentence on the page with `say_to_candidate`, then
   run it exactly like an interview: `wait_for_candidate`, `say_to_candidate`,
   `reveal_hint`, `run_tests`, `get_session`, follow-ups on the page, then
   `record_session`. Do not end your turn during the session.
5. In the terminal, give the verdict, two strengths, two things to work on, and when
   the pattern comes back. If other patterns are still due, name them and offer
   another round.

When the user only asks what to work on, call `list_due` and answer from it: the
patterns due now, what comes soon, and their streak. The dashboard from
`open_dashboard` shows the same schedule as a grid.
