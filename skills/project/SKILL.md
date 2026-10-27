---
name: project
description: Run a timed repository-debugging session: a multi-file Django (or Django REST framework) project with planted bugs, visible tests, and hidden tests, worked in a browser editor or the user's own, the way backend online assessments like IBM's HackerRank task run it. Optionally silent, as an online assessment. Use when the user wants to practise debugging a Django or backend project, a project-based or repository OA, or the backend half of an online assessment.
---

# Project session

1. Read the request: a company (IBM's OA has one), a difficulty, and whether they want
   an online assessment (silent, no hints) or an interview where they can ask you
   things. Someone preparing for an OA wants OA mode.
2. If a company was named, call `list_trends` for it. If nothing is on file and this
   host has web tools, research it first as the research skill describes, and save
   what you find with `record_trends`.
3. Call `begin_project` with the company, difficulty, and `oa`, and follow the method
   it returns in full.
4. Pick a validated project they have not done whose bug categories are due or match
   the request. If none fits, write one with `write_project` and run
   `validate_project` until it passes. The first validation or start builds the Django
   environment, which needs the network once; tell the user it may take a minute.
5. Call `start_project`. Give the user the URL in the terminal and the workspace path
   for their own editor. In interview mode, say one sentence on the page with
   `say_to_candidate`. To rehearse a full 80-minute OA, suggest they do a mock
   interview problem first and give this one a 40 to 45 minute clock.
6. Stay with the session: `wait_for_candidate`. In OA mode, say nothing while the
   clock runs. In interview mode, answer like a teammate who knows the API but not
   where the bugs are. Each submission arrives with the hidden results, the bugs fixed
   so far, and the diff. Never reveal where a bug is or which hidden test failed.
7. When the clock stops or they finish, debrief: how they found the hardest bug and
   how they would keep it from coming back. Then score it with `record_project` and
   give the user the verdict, the bugs fixed and missed, two strengths, two things to
   work on, and when the categories come back.

If the session stops for reasons unrelated to the user, end it with
`abandon_session` and reason interrupted.
