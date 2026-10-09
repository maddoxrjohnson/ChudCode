# Attribution

ChudCode is original work by Maddox Johnson, released under the MIT License (see
`LICENSE`). The projects below shaped it, and their license notices are reproduced
here as their terms require.

## pi-teach

The architecture ChudCode uses was learned from studying pi-teach by Josh Noll
(https://github.com/joshrnoll/pi-teach) and Max Miller's fork
(https://github.com/max-miller1204/pi-teach): a stdio MCP server that drives a
loopback web UI, a long-polling "wait for the learner" tool that lets browser events
reach an agent, plain files as the only state store, and a Leitner review schedule
derived on read from an append-only event log.

pi-teach is MIT licensed. Its notice is in `docs/LICENSE.pi-teach`. No pi-teach code
is vendored; the patterns were re-implemented for a different domain. Where a module
follows pi-teach closely enough that the lineage is worth knowing, its header says so:

- `src/review.ts` re-implements pi-teach's Leitner scheduler (`src/review.ts`) with
  pattern and problem keys in place of quiz questions.
- `src/mcp.ts` follows pi-teach's `src/mcp.ts`: a hand-written JSON-RPC dispatcher
  and an inbox that holds browser events until the agent's long-polling wait tool asks
  for them. ChudCode's inbox lets a new wait supersede an abandoned one and adds an
  activity digest.
- `src/store/paths.ts` keeps the same traversal guard and strict id validation as
  pi-teach's `src/paths.ts`.
- `mcp/launch.mjs` does what pi-teach's launcher does: check the Node version, install
  runtime dependencies on first run, then import the TypeScript server.
