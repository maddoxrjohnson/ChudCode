---
name: learn
description: Teach a lesson on coding with agents, such as planning with plan mode, CLAUDE.md and progress files, context and cost, strong tests, subagents with the right model and effort, skills, loops, refactoring, working across providers, or showing an app off with demo videos, promo images, ads, and a GitHub Pages site. The learner works a realistic scenario with their own agent and is graded on their judgement. Use when the user wants to get better at agentic coding or asks what there is to learn about it.
---

# Learn

1. If the user named a topic, match it to a lesson or module with `list_curriculum`;
   pass `module` to see a module's lessons. Otherwise take the next lesson.
2. Call `begin_lesson` from the `chudcode` MCP server with the lesson or module, and
   follow the method it returns in full. If it says the module is locked, suggest
   the lesson it builds on; if the user still wants this one, call it again with
   override_lock set to true.
3. If the brief lists facts to check and you have web tools, re-read each source
   page and record what you found with `record_fact_check`. Teach a fact that
   changed as the page says now, and tell the user the shipped one is out of date.
4. Serve a validated exercise the learner has not seen if the brief names one.
   Otherwise write a fresh one with `write_exercise`: short teaching that cites every
   core fact, a realistic scenario, and your private outline, follow-ups, and
   pitfalls. Then call `validate_exercise` until it passes.
5. Call `start_lesson` with the slug. Give the user the URL in the terminal, say one
   sentence on the page with `say_to_candidate`, then stay with the lesson:
   `wait_for_candidate`, answer questions with `say_to_candidate`, read the answer
   when it arrives, ask one or two follow-ups, and use `get_session` if you need the
   state. The learner may spend a long time in another terminal with their own
   agent; keep waiting. Do not end your turn during the lesson.
   - A lab arrives as a project folder the learner consented to on the page: read it
     with `inspect_lab`. A media lab arrives the same way: measure it with
     `inspect_media`, which also shows you up to three of its images to judge by eye.
     A transcript review arrives as one of their Claude Code sessions: read it with
     `inspect_transcript`. None of these tools takes a path.
   - A drill (mutation tests, a flaw review, a cache plan, a refactor) is graded by
     code when the learner presses its button; you get the full result, the page
     gets counts. Do not name what they missed before the debrief.
6. Score it with `record_lesson` (labs, media labs, and transcript reviews need a
   result for every checklist item), then give the user the verdict, two strengths, two things
   to work on, and when the lesson comes back for review. Then do what it says about
   the Next lesson button: write the next lesson's exercise ahead and keep waiting
   while the window is open.

If the lesson stops for reasons unrelated to the learner, end it with
`abandon_session` and reason interrupted. When the user only asks how far along
they are, answer from `list_curriculum`. The dashboard from `open_dashboard` shows
every module and lesson.
