---
name: dashboard
description: Open the ChudCode dashboard in the browser, or report the user's progress in the terminal: what is due for review, their streak, past sessions, and available problems. Use when the user asks to see their progress, what is due, past sessions, or available problems.
---

# Dashboard

- To open the dashboard in a browser, call `open_dashboard` from the `chudcode` MCP
  server and give the user the URL it returns. The page shows every pattern's place
  in the review schedule, what is due, their streak, recent sessions, and problems.
  The tool also recovers any session that was in progress.
- To report progress in the terminal, call `list_due`: the patterns due for review,
  what comes due soon, and the streak. If something is due, offer a review session.
- To report progress through NeetCode 150 or Grind 75, call `list_roadmap`, with
  `roadmap` set to `grind75` for Grind 75. Offer the next problem it names.
- To list problems in the terminal, call `list_problems`. Pass `pattern` or
  `difficulty` to filter.
- To see one session in detail, call `get_session` with its id.
- To report what a company has been asking in interviews, call `list_trends` with
  the company. If nothing is on file, offer to research it.

The server runs inside this session and stops when the session ends. Every session,
submission, result, and review event stays on disk under `~/.chudcode/`.

If a session is in progress and the user wants to continue it, call
`wait_for_candidate` so their actions reach you.
