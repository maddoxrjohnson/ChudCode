# ChudCode

A mock technical interviewer you can code against, inside Claude Code.

ChudCode generates original interview-style coding problems, serves them in a local
web page with a code editor, hidden tests, and a timer, and plays the interviewer. It
asks you to talk through your approach before you code, gives hints when you ask for
them, probes edge cases and complexity after you submit, and scores the session on a
rubric. Patterns you miss come back on a spaced-review schedule with a fresh problem,
not the one you already saw.

**Status:** early development. Mock interviews work; the interviewer writes its own
problems, validated against a reference solution before they are served; and the
patterns you miss come back on a Leitner schedule with a problem you have not seen.

## Install

ChudCode is a Claude Code plugin. It needs Node 22.18 or later and Python 3.12 or
later on your PATH.

```sh
claude plugin marketplace add maddoxrjohnson/ChudCode
claude plugin install chudcode@chudcode
```

Then, in Claude Code, say "give me a mock interview on sliding windows" or run
`/chudcode:interview`. Your agent plays the interviewer; the page opens in your browser.
`/chudcode:review` serves a fresh problem on the pattern you are most overdue to see
again. `/chudcode:dashboard` opens the page with your review schedule, streak, and past
sessions.

To try a checkout without installing it: `claude --plugin-dir /path/to/ChudCode`.

## Why

Live coding interviews test a narrow skill: solving a medium-difficulty problem in
about thirty-five minutes while explaining yourself to another person. Grinding a
problem list trains the first half. ChudCode is built to train the whole thing, and to
make sure the patterns you keep missing are the ones you see again.

## What works

- In-browser editor with Run (visible examples) and Submit (hidden tests), autocomplete
  off by default to match real interview pads.
- Interview flow: clarifying questions, approach note, timer, hint ladder, follow-up
  questions, and a five-dimension rubric.
- Problems written per pattern and difficulty, or modelled on the shape of a real
  problem you name, and validated against a reference solution before you ever see
  them. The Grind 75 and NeetCode 150 lists are vendored as titles and patterns only;
  no problem statements are stored. See `docs/PROBLEM-FORMAT.md`.
- Spaced review: every scored session moves the problem's patterns between Leitner
  boxes (1, 3, 7, 21, 60 days). A review session serves a problem you have not seen
  on the most overdue pattern. The dashboard shows every pattern's box, what is due,
  and your streak. Boxes and due dates are derived on every read from an append-only
  log of verdicts, so changing the schedule or the verdict rule re-scores history.

## Planned

- Interview trend research per company, feeding problem selection.
- Pi support through the same MCP server.

## Development

Requires Node 22.18 or later and Python 3.12 or later.

```sh
npm install
npm run serve            # open the example problem in your browser, no agent needed
npm run validate -- window-sum   # lint a problem bundle and run its reference against every case
npm test
npm run check            # typecheck
npm run lint
npm run format
npm run bundle:editor    # rebuild assets/vendor after editing assets/editor/entry.mjs
```

The runner executes solutions in a separate process with memory, CPU, and wall-clock
limits. It is not a security sandbox: code runs as you, with your filesystem and
network. Treat it the way you would treat running a script you wrote yourself.

## License

MIT © Maddox Johnson. See `docs/ATTRIBUTION.md` for the projects ChudCode learned from.
