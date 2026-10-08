# ChudCode

A mock technical interviewer you can code against, inside Claude Code.

ChudCode generates original interview-style coding problems, serves them in a local
web page with a code editor, hidden tests, and a timer, and plays the interviewer. It
asks you to talk through your approach before you code, gives hints when you ask for
them, probes edge cases and complexity after you submit, and scores the session on a
rubric. Patterns you miss come back on a spaced-review schedule with a fresh problem,
not the one you already saw.

**Status:** early development. Nothing is installable yet.

## Why

Live coding interviews test a narrow skill: solving a medium-difficulty problem in
about thirty-five minutes while explaining yourself to another person. Grinding a
problem list trains the first half. ChudCode is built to train the whole thing, and to
make sure the patterns you keep missing are the ones you see again.

## Planned

- In-browser editor with Run (visible examples) and Submit (hidden tests), autocomplete
  off by default to match real interview pads.
- Interview flow: clarifying questions, approach note, timer, hint ladder, follow-up
  questions, and a five-dimension rubric.
- Problems generated per pattern and difficulty, validated against a reference solution
  before you ever see them. No copyrighted problem statements.
- Leitner spaced review over patterns, and a dashboard of what is due.
- Claude Code plugin first; Pi support through the same MCP server later.

## Development

Requires Node 22.18 or later and Python 3.12 or later.

```sh
npm install
npm test
npm run check    # typecheck
npm run lint
npm run format
```

## License

MIT © Maddox Johnson. See `docs/ATTRIBUTION.md` for the projects ChudCode learned from.
