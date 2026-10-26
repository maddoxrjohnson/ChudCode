---
name: phone
description: Run a mock phone screen for a CS role, answered out loud in a local web page: a recruiter screen (tell me about yourself, why this company, logistics), a behavioral screen (tell me about a time, answered in STAR order, building a bank of reusable stories), or rapid-fire CS fundamentals. Each answer is scored, along with its delivery (length, pace, filler words). Use when the user wants to practise phone interviews, recruiter calls, behavioral questions, or CS fundamentals, or to prepare for a company's phone screen.
---

# Phone screen

1. Pick the format from the request: `recruiter`, `behavioral`, or `fundamentals`.
   If the user did not say, ask which one in a line and stop. Note the company and
   role if they named them.
2. If a company was named, call `list_phone_briefs` for it. If nothing is on file
   and this host has web tools, research it first as the research skill describes
   (its phone screen section) and save what you find with `record_phone_briefs`.
   If it has no web tools, say so; do not invent what the company asks.
3. Call `begin_phone_screen` with the format, company, and role, and follow the
   method it returns in full: who to play, how long, the learner's past calls, their
   story bank or weakest fundamentals topics, and the rubric.
4. Call `start_phone_screen`. Give the user the URL in the terminal, then say one
   sentence on the page with `say_to_candidate`. Stay on the call:
   `wait_for_candidate`, ask each graded question with `ask_question` (with a
   `topic` for fundamentals), follow up with `say_to_candidate`, and keep waiting.
   Your lines are read aloud, so keep them short. Do not end your turn during the
   call.
5. In a behavioral screen, save each story the learner tells well with `save_story`,
   in their words, never invented; update an existing story by id when a telling is
   sharper.
6. When the clock runs out or they end the call, score it with
   `record_phone_screen`: every dimension of the format, and every answered question
   with a one-line note. Then give the user the verdict, the one change that would
   most improve their next call, two strengths, and when this format comes back.

If the call stops for reasons unrelated to the learner, end it with
`abandon_session` and reason interrupted.
