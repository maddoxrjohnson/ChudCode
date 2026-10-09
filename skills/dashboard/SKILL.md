---
name: dashboard
description: Open the ChudCode dashboard in the browser, or list the user's problems and recent interview sessions in the terminal. Use when the user asks to see their progress, past sessions, or available problems.
---

# Dashboard

- To open the dashboard in a browser, call `open_dashboard` from the `chudcode` MCP
  server and give the user the URL it returns. It also recovers any session that was
  in progress.
- To list problems in the terminal, call `list_problems`. Pass `pattern` or
  `difficulty` to filter.
- To see one session in detail, call `get_session` with its id.

The server runs inside this session and stops when the session ends. Every session,
submission, and result stays on disk under `~/.chudcode/`.

If a session is in progress and the user wants to continue it, call
`wait_for_candidate` so their actions reach you.
