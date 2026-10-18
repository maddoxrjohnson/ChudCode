# Architecture

ChudCode is three things in one Node process: an MCP server the agent talks to, a
loopback HTTP server the candidate's browser talks to, and a runner that executes the
candidate's code. They share one state directory on disk. An optional Pi extension
runs in a fourth place, inside Pi, and bridges the two hosts' different abilities.

```
           Claude Code or Pi                                 Browser
        ┌──────────────────────┐                    ┌──────────────────────┐
        │ agent (interviewer)  │                    │ session page         │
        │                      │                    │ editor, timer, chat, │
        │  Pi only:            │                    │ hints, tests panel   │
        │  pi/ extension ◄─────┼── agent SSE ──┐    └─────────┬────────────┘
        └─────────┬────────────┘   + inbox     │         REST │ ▲ SSE
         MCP over │ stdio          (token)     │              ▼ │
        ┌─────────▼────────────────────────────┴──────────────────────────┐
        │ mcp/launch.mjs → src/mcp-stdio.ts                               │
        │                                                                 │
        │  McpSession ── tools/ ──┐          server/ (127.0.0.1 only)     │
        │  CandidateInbox (listen)│          routes-api, routes-pages, sse│
        │  AgentOutbox   (push)   ▼                     │                 │
        │                     flow.ts ◄─────────────────┘                 │
        │                       │  every session operation, one place     │
        │          ┌────────────┼──────────────┬──────────────┐           │
        │          ▼            ▼              ▼              ▼           │
        │       store/       runs.ts        review.ts      prompts.ts     │
        │     (~/.chudcode)    │           (Leitner)     (what the agent  │
        │                      ▼                           reads)         │
        │           ProcessRunner | DockerRunner                          │
        │                      │                                          │
        └──────────────────────┼──────────────────────────────────────────┘
                               ▼
                 python3 -s -P harness.py   (one JSON line per case)
```

## Modules

| Path                    | Job                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp/launch.mjs`        | Entry point both hosts run. Checks Node can run TypeScript, installs runtime deps on first launch, warns if Python is missing.                                                         |
| `src/mcp.ts`            | Hand-written JSON-RPC dispatch, the tool table, the listening inbox, and routing of candidate events to prompts.                                                                       |
| `src/next-up.ts`        | The Next problem button: one pending press, handed to the host and answered by the next roadmap session `start_session` creates.                                                       |
| `hooks/session-link.ts` | Claude Code hook on `start_session`: prints the session's link in the terminal, so it never depends on the model's reply. Pi's extension shows the same link under the editor.         |
| `src/outbox.ts`         | The pushing host's numbered prompt log, replayable with `GET /api/inbox?since`.                                                                                                        |
| `src/tools/`            | One file per tool group. Tools validate arguments and call `flow.ts` or a store.                                                                                                       |
| `src/flow.ts`           | Every operation that moves a session along: start, note, message, run, submit, hint, timeout, done, record. Writes disk, appends the event log, pushes SSE, emits the candidate event. |
| `src/prompts.ts`        | Everything the agent reads: the brief, event prompts, result text. One place to tune the interviewer.                                                                                  |
| `src/server/`           | Loopback HTTP: pages, the JSON API, SSE channels, the agent token.                                                                                                                     |
| `src/runner/`           | `Runner` and `LanguageAdapter` interfaces, the process and Docker runners, comparators, and the candidate-safe view of a result.                                                       |
| `src/store/`            | On-disk formats: config, problems, sessions, review events, trends. Atomic JSON writes, strict id validation.                                                                          |
| `src/review.ts`         | Leitner scheduling over pattern and problem keys, derived from the review log on every read.                                                                                           |
| `src/roadmap.ts`        | NeetCode 150's topic tree and Grind 75's weeks as stages, and each title's state, derived from sessions whose problem mimics it.                                                       |
| `assets/runtime/`       | The browser code, plain ES modules served as-is. `assets/vendor/` holds the one bundled dependency, CodeMirror.                                                                        |
| `pi/`                   | The Pi extension: slash commands, the bridge, the status line.                                                                                                                         |

## One interview, end to end

1. The agent calls `begin_interview`. It returns the method (`docs/INTERVIEWING.md`),
   the rubric, the candidate's history, what is due for review, company trends, and a
   host section saying how events will arrive.
2. The agent picks or writes a problem. A written one goes through `write_problem`
   (schema) and `validate_problem` (the reference must pass every case under strict
   limits, and the bundle must have enough visible, hidden, and max-size cases).
   Only validated problems can be served.
3. `start_session` creates `sessions/<id>/`, starts the HTTP server if it is not
   running, and returns the URL.
4. The candidate acts on the page. Each action is a REST call that goes through
   `flow.ts`, which writes the change, pushes it to the page over SSE, and emits a
   candidate event. Runs are informational; everything else becomes a prompt.
5. The prompt reaches the agent in one of two ways (next section). It quotes the
   event in full, including hidden-case results for a submission, and names the
   tool that handles it.
6. The agent replies with `say_to_candidate`, which goes through `flow.ts` to the
   page like any other message.
7. `record_session` writes the rubric and verdict, appends review events for the
   problem and its patterns, and pushes the debrief card to the page and a reload
   to the dashboard.

## Two hosts, one server

An MCP server cannot start a turn in its client. The two hosts handle that
differently, and `CHUDCODE_HOST` picks the mode when the process starts.

**Claude Code (listen).** The agent calls `wait_for_candidate`, which blocks on a
`CandidateInbox` until an event arrives or 60 seconds pass. Sixty seconds, because
Claude Code moves any tool call past two minutes into the background. A new wait
supersedes an old one, because Esc can abandon a call without a
`notifications/cancelled`, and a stale waiter must not swallow an event. Events that
arrive while the agent is talking are queued and returned by the next wait, with a
digest of silent Run presses.

**Pi (push).** Pi extensions can call `sendUserMessage`, so waiting is unnecessary.
With `CHUDCODE_HOST=pi` the wait tool is not listed, prompts say "end your turn"
instead of "call `wait_for_candidate`", and events go to an `AgentOutbox`. Each
prompt gets a stream id (random per process) and a sequence number, and is
published on the agent SSE channel. The extension in `pi/` runs in Pi's process, not
the server's, so it finds the server through `server.json`, subscribes, and delivers
each sequence number exactly once, as a follow-up when the agent is mid-turn. After
a reconnect, or on a gap in the numbers, it asks `/api/inbox?since=<last>`. A new
stream id means the server restarted and everything it has is new.

The page shows "Interviewer listening" in both hosts: while a wait is open in
Claude Code, while the extension is subscribed in Pi.

## Trust boundaries

- **The browser never sees what the interviewer sees.** `publicView()` is the only
  serializer for problems on browser routes: no reference solution, no hidden
  inputs or expected values, no unrevealed hints, no checker or generators. Run
  results pass through `sanitizeForCandidate()`. Both are tested against the real
  server.
- **The agent channel is not a browser route.** Prompts quote hidden cases, and the
  candidate's page shares the same loopback origin. So the agent SSE channel and
  `/api/inbox` require a bearer token minted on every server start and written only
  to `server.json` (mode 0600). No route returns it.
- **Every path from a URL or a tool argument is validated.** Slugs and session ids
  match strict patterns before they are joined to a path, and the join is checked to
  stay under the state root.
- **Candidate code is contained, not sandboxed, by default.** `ProcessRunner` gives
  it rlimits, a wall clock, a process group, output caps, and a clean environment,
  but it runs as the user. `DockerRunner` adds no network, a read-only filesystem,
  no capabilities, and cgroup limits. See `docs/RUNNER.md`.
- **Model-written problems are checked before they are served.** The reference
  must pass every case, so an agent cannot serve a problem whose expected outputs it
  guessed. Trend entries store a 280-character shape note with no links, so a
  scraped statement has nowhere to go.

## Decisions worth defending

- **Function-signature JSON cases, not stdin/stdout.** That is what interview pads
  show. Comparators can be semantic (unordered, float tolerance, a checker), the
  reference doubles as an oracle for generated large cases, and the typed signature
  produces the editor stub.
- **Comparison in Node, not in the harness.** Comparators are written and tested
  once and every future language adapter shares them. The harness only normalizes
  return values (tuples, sets, linked lists, trees) to JSON.
- **An append-only review log, with boxes derived on read.** The verdict rule and
  the intervals are policy that will change. Storing verdicts instead of boxes means
  a change re-scores history instead of stranding it. `scripts/rebuild-review.ts`
  regenerates the log from sessions.
- **No build step.** Node 22.18 runs the TypeScript directly (`erasableSyntaxOnly`
  keeps that safe), so the plugin and the Pi package are the repository as cloned.
  CodeMirror is the one thing bundled, because its packages must share one
  `@codemirror/state` instance, and it is committed so the editor works offline.
- **One HTTP server per agent session, on loopback.** Nothing listens when no
  interview is running, nothing is reachable from the network, and the page's
  lifetime is tied to the interviewer that can answer it.
- **A hand-written MCP server.** The protocol surface used here is four methods.
  Owning the dispatcher made the long-poll, cancellation, and supersede behaviour
  straightforward to test in-process, with no SDK version to track.

## Tests

- Unit and integration (vitest, `npm test`): stores, scheduler, comparators,
  sanitizer, prompts, pages, the MCP dispatcher in-process, the stdio launcher
  spawned for both hosts, the runner against real Python, the HTTP server and SSE,
  the outbox and agent token, and the Pi bridge against a real server with a stub
  Pi. DockerRunner's container tests run when the image is present (CI pulls it).
- Browser (`npm run e2e:browser`): headless Chromium drives the page with a
  scripted interviewer. Runs in CI.
- Host (`npm run e2e:claude`): a real `claude -p` session interviews a scripted
  candidate through the plugin. Run by hand before a release; it needs a signed-in
  `claude` and costs tokens.
