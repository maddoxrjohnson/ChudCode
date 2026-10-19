# Curriculum format

The agentic-coding track is one file, `data/agentic/curriculum.json`, checked by
`validateCurriculum` in `src/curriculum.ts` when it loads and by
`test/curriculum.test.ts` in CI.

```json
{
  "version": 1,
  "factHosts": ["code.claude.com", "docs.claude.com", "platform.claude.com", "www.anthropic.com"],
  "modules": [
    {
      "id": "planning",
      "name": "Planning and context files",
      "blurb": "One sentence for the dashboard.",
      "requires": [],
      "lessons": [
        {
          "id": "plan-before-code",
          "title": "Explore, plan, then code",
          "goals": ["What the learner can do afterwards"],
          "facts": [
            {
              "id": "plan-mode-behavior",
              "claim": "One or two sentences, true of Claude Code as the source states it.",
              "source": "https://code.claude.com/docs/en/permission-modes",
              "core": true,
              "verifiedAt": "2026-10-18",
              "minVersion": "2.1.0"
            }
          ],
          "exercises": ["design-review", "lab"],
          "rubricFocus": ["decomposition", "verification"],
          "checklist": [{ "id": "phases", "text": "What a lab checks for" }],
          "labFiles": ["PLAN.md", "progress.md"]
        }
      ]
    }
  ]
}
```

## Rules

- **Modules** are listed in unlock order. `requires` may name only earlier modules.
  A module opens once every module it requires has half of its teachable lessons
  passed (rounded up), and the modules it requires are open themselves.
- **Lessons** have unique ids across the file. `rubricFocus` names dimensions from
  `docs/AGENTIC-RUBRIC.md`; each must score 2 or more for the lesson to pass.
- **Facts** have unique ids across the file. Each claim is something its source page
  says, checked by a person or an agent reading that page on `verifiedAt`; never a
  claim from memory. `source` must be an `https` URL on one of `factHosts`. A fact
  that only holds from some Claude Code version carries `minVersion`. A teachable
  lesson has at least two facts, at least one of them `core`. Exercise teaching must
  cite every core fact as `[fact:<id>]`.
- **Outlines.** A lesson with `"facts": []` is an outline: it shows on the dashboard
  as coming, cannot be taught, and does not count toward unlocking. Write and source
  its facts to make it teachable.
- **Transcript reviews.** A teachable lesson that lists `transcript` needs a
  `checklist`.
- **Labs.** A teachable lesson that lists `lab` needs a `checklist` and the
  `labFiles` a lab reads. Every lab file must be a pattern on `LAB_ALLOW` in
  `src/lab.ts`, so a curriculum edit cannot widen what a lab may read.

## Keeping facts current

Claude Code changes faster than this file. Before teaching, the interviewer re-reads
the source of any fact last confirmed more than 14 days ago and records what it
found with `record_fact_check` in `~/.chudcode/curriculum/fact-checks.jsonl`. A fact
found changed is taught as the page says now, flagged on the lesson page, and
stays flagged until this file is updated and its `verifiedAt` moved forward.
