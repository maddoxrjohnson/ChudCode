---
name: roadmap
description: Work through NeetCode 150 or Grind 75 in order, one interview at a time. Each step is an original problem in the shape of the next listed one, and solving it checks that one off. Use when the user asks for the next problem on NeetCode 150, Grind 75, or "the roadmap", or asks how far along it they are.
---

# Roadmap

1. Work out which list the user means: Grind 75 if they name it, otherwise NeetCode 150. Note a topic or week if they named one ("trees", "week 3").
2. Call `begin_interview` from the `chudcode` MCP server with `mode` set to `roadmap`,
   `roadmap` set to `neetcode150` or `grind75`, and `stage` if they named a topic or
   week. Stage ids are listed by `list_roadmap`. Follow the method it returns in
   full. It names the next problem on the list, says whether the topic they asked
   for is open, and says what is due for review.
3. Never serve the listed problem itself. Write an original problem in its shape
   with `write_problem`: the same pattern, difficulty, input sizes, and twist, with a
   new story and examples. Set the source's kind to mimic and its mimic_of to the
   listed title exactly as the brief gives it, because that is what checks it off.
   Then call `validate_problem` until it passes. A validated problem on disk with that
   mimic_of that has been served 0 times is also fine.
4. Call `start_session` with the slug and `mode` set to `roadmap`. Give the user the
   URL in the terminal, say one sentence on the page with `say_to_candidate`, then
   run it exactly like an interview: `wait_for_candidate`, `say_to_candidate`,
   `reveal_hint`, `run_tests`, `get_session`, follow-ups on the page, then
   `record_session`. Do not end your turn during the session.
5. In the terminal, give the verdict, two strengths, two things to work on, and where
   they stand on the roadmap: what was checked off and what comes next.

When the user only asks how far along they are, call `list_roadmap` and answer from
it: the solved count, which topics or weeks are open, and the next problem. Pass
`stage` to list one topic's problems. The dashboard from `open_dashboard` shows both
roadmaps, topic by topic.
