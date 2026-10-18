# ChudCode

A mock technical interviewer you can code against, inside Claude Code or Pi.

ChudCode generates original interview-style coding problems, serves them in a local
web page with a code editor, hidden tests, and a timer, and plays the interviewer. It
asks you to talk through your approach before you code, gives hints when you ask for
them, probes edge cases and complexity after you submit, and scores the session on a
rubric. Patterns you miss come back on a spaced-review schedule with a fresh problem,
not the one you already saw.

**Status:** early development. Mock interviews work; the interviewer writes its own
problems, validated against a reference solution before they are served; the
patterns you miss come back on a Leitner schedule with a problem you have not seen;
and research into what a company has been asking shapes the problems you get for it.

![The interview page: the statement on the left, the editor with three passing examples in the middle, the interviewer's chat on the right](docs/screenshots/session-ran.png)

## Install

ChudCode needs Node 22.18 or later and Python 3.12 or later on your PATH. It runs
TypeScript directly, with no build step.

### Claude Code

```sh
claude plugin marketplace add maddoxrjohnson/ChudCode
claude plugin install chudcode@chudcode
```

Then, in Claude Code, say "give me a mock interview on sliding windows" or run
`/chudcode:interview`. Your agent plays the interviewer; the page opens in your browser.
`/chudcode:review` serves a fresh problem on the pattern you are most overdue to see
again. `/chudcode:roadmap` takes you through NeetCode 150 in order, or Grind 75 if you
name it: each step is an original problem in the shape of the next one on the list.
`/chudcode:research <company>` finds what that company has been asking lately,
so an interview for it has the right shape. `/chudcode:dashboard` opens the page with
your review schedule, streak, and past sessions.

To try a checkout without installing it: `claude --plugin-dir /path/to/ChudCode`.

### Pi

Pi gets the same tools from the same MCP server, through Pi's MCP adapter, plus an
extension for the slash commands and the bridge that pushes the candidate's actions
into the conversation. Clone the repository somewhere stable and install both:

```sh
git clone https://github.com/maddoxrjohnson/ChudCode ~/ChudCode
(cd ~/ChudCode && npm ci --omit=dev)
pi install ~/ChudCode
```

Then add the server to `~/.pi/agent/mcp.json`, with the absolute path to your clone:

```json
{
  "mcpServers": {
    "chudcode": {
      "command": "node",
      "args": ["/home/you/ChudCode/mcp/launch.mjs"],
      "env": { "CHUDCODE_HOST": "pi" },
      "exposure": "direct"
    }
  }
}
```

`CHUDCODE_HOST=pi` is what switches the server from waiting to pushing. The commands
are `/interview`, `/review`, `/roadmap`, `/research <company>`, and `/dashboard`. While the
interviewer is connected, Pi shows `chudcode interviewer connected on port <port>`
below the editor.

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
- Roadmaps: work through NeetCode 150 topic by topic along NeetCode's tree, or Grind
  75 week by week. A topic or week opens once half of every one before it is solved.
  You never see the listed problem: each step is an original problem in its shape,
  and solving it checks the listed one off. Progress is derived from your sessions,
  so a "like Two Sum" interview counts too.
- Company trends: the research skill reads recent interview-experience posts with
  the host's web tools and records each problem as a pattern, a role, a date, a
  source, and a short paraphrase of its shape, never a statement. Name the company
  when you ask for an interview and the problem is written in the shape that company
  has been asking, citing the entries it came from. See `docs/TRENDS-FORMAT.md`.

## What it looks like

After a passing submission and the follow-ups, the interviewer scores the session.
The debrief lands on the page: five rubric scores, strengths, things to work on, and
when the pattern comes back.

![The page after the debrief: 12 of 12 cases passed, the rubric card with scores, strengths, and things to work on](docs/screenshots/session-debrief.png)

The dashboard shows every pattern's place in the review schedule, what is due, the
streak, and past sessions.

![The dashboard: streak and due counts, the pattern grid with Sliding Window in the three-day box, and recent sessions](docs/screenshots/dashboard.png)

The screenshots come from `npm run e2e:browser -- <dir>`, which drives the real page.
How the pieces fit is in `docs/ARCHITECTURE.md`.

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
npm run e2e:browser      # drive the interview page in headless Chromium (npx playwright install chromium first)
npm run e2e:claude       # a real `claude -p` session interviews a scripted candidate (signed-in claude; costs tokens)
```

The runner executes solutions in a separate process with memory, CPU, and wall-clock
limits. It is not a security sandbox: code runs as you, with your filesystem and
network. Treat it the way you would treat running a script you wrote yourself. To run
it in a container with no network and a read-only filesystem instead, set
`CHUDCODE_RUNNER=docker`; see `docs/RUNNER.md`.

## License

MIT © Maddox Johnson. See `docs/ATTRIBUTION.md` for the projects ChudCode learned from.
