# ChudCode

A mock technical interviewer you can code against, inside Claude Code or Pi.

ChudCode generates original interview-style coding problems, serves them in a local
web page with a code editor, hidden tests, and a timer, and plays the interviewer. It
asks you to talk through your approach before you code, gives hints when you ask for
them, probes edge cases and complexity after you submit, and scores the session on a
rubric. Patterns you miss come back on a spaced-review schedule with a fresh problem,
not the one you already saw.

A second track teaches coding _with_ agents: planning with plan mode, context files,
tests an agent cannot game, subagents with the right model and effort, prompt-caching
cost, and more. Each lesson teaches a few facts sourced from Anthropic's docs, then
hands you a realistic scenario to work with your own agent, and grades your judgement.

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
`/chudcode:interview`. Your agent plays the interviewer; the page opens in your browser,
and the plugin prints the session's link in your terminal every time one starts.
`/chudcode:review` serves a fresh problem on the pattern you are most overdue to see
again. `/chudcode:roadmap` takes you through NeetCode 150 in order, or Grind 75 if you
name it: each step is an original problem in the shape of the next one on the list,
and after each debrief a Next problem button takes you straight to the one after.
`/chudcode:learn` teaches the next lesson on coding with agents, or the topic you
name. `/chudcode:phone recruiter|behavioral|fundamentals [company]` runs a mock phone
screen you answer out loud. `/chudcode:research <company>` finds what that company has
been asking lately, in coding rounds and on the phone, so a mock for it has the right
shape. `/chudcode:dashboard` opens the page with
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
are `/interview`, `/review`, `/roadmap`, `/learn`, `/phone`, `/research <company>`, and `/dashboard`. While the
interviewer is connected, Pi shows `chudcode interviewer connected on port <port>`
below the editor, and the link of the session it opened last.

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
  so a "like Two Sum" interview counts too. After a roadmap debrief the interviewer
  writes the next step ahead of time and stays for a while; the Next problem button
  on the debrief or the dashboard opens it without a trip back to the terminal.
- Agentic coding lessons: nine modules, from planning and context files through test
  strength, subagents with chosen models and effort, and prompt-caching cost, to
  working across providers. Every claim a lesson teaches about Claude Code cites a
  fact in `data/agentic/curriculum.json`, each with the page that states it; the
  interviewer re-reads sources older than two weeks before teaching, and an exercise
  that cites anything else fails validation. You get a scenario, work it with your
  own agent, submit your plan or spec, answer follow-ups, and are scored on
  decomposition, verification, context and cost, safety, and delegation. Missed
  lessons come back on the review schedule. See `docs/LEARNING.md` and
  `docs/CURRICULUM-FORMAT.md`.
- Labs on your own repository: build or tighten something real with your agent (a
  CLAUDE.md, a progress file, subagents), then name the folder on the lesson page.
  The page lists exactly which files a review would read; nothing is read until you
  tick the consent box. The interviewer gets those files read-only, with anything
  that looks like a credential redacted, plus recent git history and mechanical
  checks drawn from the sourced facts, and grades them against the lesson's
  checklist. See `docs/EXERCISE-FORMAT.md`.
- Mutation drills: your agent writes tests for a small module in a scratch
  workspace, and Grade runs them against the module, against rewrites of it that
  behave the same, and against copies with one planted bug each. Tests that fail on
  correct code or tie themselves to the implementation fail the drill; tests that
  catch at least 80% of the bugs pass it. The debrief names the bugs that got
  through.
- Flaw reviews: an agent's diff with planted flaws (a SQL injection, a committed
  key, an API that does not exist, a swallowed error) and decoys that look wrong and
  are fine. Click the lines you would block, name the problem, and submit; you pass
  by finding every critical flaw and most of the rest without crying wolf.
- Cache plans: a workload of requests over time, and your agent's plan for prompt
  order and cache breakpoints, priced by a simulator that uses only sourced prices
  and limits. Within 10% of the best plan known passes.
- Refactor drills: a tangled module in a git workspace. Your agent commits
  characterisation tests, then the refactor. Grade checks the tests landed first and
  catch bugs planted in the original, that hidden behaviour tests still pass, that
  the interface is the same, and that the structure got simpler.
- Transcript reviews: pick one of your own Claude Code sessions and the interviewer
  reviews how you worked from its numbers: models and switches, cache reads and
  writes, long gaps, compactions, and your prompts. Nothing is listed or read until
  you ask on the page, and the replies and tool output are never read.
- Media labs: the Showing your work module covers demo videos recorded from code,
  screenshots and social previews, honest short ads, a GitHub Pages site, and
  generated media through MCP. Point a media lab at the repository you ship from and
  it measures your pages and media by their headers: codec and faststart, autoplay
  that is muted and inline, posters, captions, alt text, Open Graph tags, and links
  that break on a project site. The interviewer also sees your social preview and
  poster, and judges them by eye.
- After any lesson's debrief, the Next lesson button opens the next one; the
  interviewer writes it while you read the debrief.
- Phone screens: a recruiter screen, a behavioral screen, or rapid-fire CS
  fundamentals, as a call. The interviewer's questions are read aloud and you answer
  out loud (Chrome or Edge transcribe it) or by typing. Each answer is kept with how
  you delivered it: how long you spoke, words per minute, filler words heard, and long
  pauses. The debrief scores each answer and the format's dimensions (STAR structure
  and impact for behavioral, accuracy and depth for fundamentals), behavioral screens
  build a bank of your best stories, fundamentals topics you miss come back sooner,
  and research on a company's phone process shapes its mock. See `docs/PHONE.md`.
- Company trends: the research skill reads recent interview-experience posts with
  the host's web tools and records each problem as a pattern, a role, a date, a
  source, and a short paraphrase of its shape, never a statement. Name the company
  when you ask for an interview and the problem is written in the shape that company
  has been asking, citing the entries it came from. See `docs/TRENDS-FORMAT.md`.

## What it looks like

After a passing submission and the follow-ups, the interviewer scores the session.
The debrief lands on the page: five rubric scores, strengths, things to work on,
when the pattern comes back, and, on a roadmap, the button for the next problem.

![The page after the debrief: 12 of 12 cases passed, the rubric card with scores, strengths, and things to work on, and a Next problem button for Contains Duplicate on NeetCode 150](docs/screenshots/session-debrief.png)

A lesson shows its teaching with numbered sources on the left, the scenario and your
answer in the middle, and the interviewer on the right.

![A lesson page: the teaching on planning with three cited sources, the brief for planning OFX import into a ledger CLI with a submitted answer, and a debrief that passed on decomposition and verification](docs/screenshots/lesson-debrief.png)

A lab asks for your project folder instead. After the review, each checklist item
shows whether your setup met it and the file that shows it.

![A lab page: the teaching on CLAUDE.md files, what the review checks, the project folder with the two files a review would read and the consent box ticked, and a debrief with checklist results](docs/screenshots/lab-debrief.png)

A flaw review shows an agent's diff; click the lines you would block and name the
problem.

![A flaw review: an agent's diff to a Flask invoices blueprint with four lines marked, including a committed key and a SQL string built from the search term, and the mark form open on a call to an API that does not exist](docs/screenshots/flaw-review.png)

A media lab measures the site and media in your repository. After each measurement
the page lists the checks that fail first, each with the file and line to fix.

![A media lab page: the teaching on GitHub Pages with cited sources, and the measured checks for a first attempt, with failures for a missing image, an HEVC video without faststart, an autoplaying video that is not muted, an image with no alt text, no og:image, and a root-absolute link, then amber warnings](docs/screenshots/media-lab.png)

A phone screen is a call: the current question in large type, the call so far with how
each answer was delivered, and what research found about the company's phone screens.

![A recruiter phone screen for Stripe: the question "Tell me about yourself", the Speak button and answer box, the call with two typed answers and a follow-up, and Stripe's phone screens from research on the right](docs/screenshots/phone.png)

The dashboard shows every pattern's place in the review schedule, what is due, the
streak, progress through both roadmaps, the agentic-coding modules, and phone screens,
and past sessions.

![The dashboard: streak and due counts, the pattern grid with Sliding Window in the three-day box, the NeetCode 150 topics with what each needs to open, a Next problem button under each roadmap, the agentic-coding modules with the next lesson, and recent sessions](docs/screenshots/dashboard.png)

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
