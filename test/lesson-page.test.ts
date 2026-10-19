/**
 * The lesson page's pieces: sourced teaching and the debrief card.
 */

import { describe, expect, it } from "vitest";

import { lessonRubricHtml, teachingHtml } from "../src/server/pages/lesson.ts";
import type { FactFreshness } from "../src/store/fact-checks.ts";
import type { LessonSession } from "../src/store/lessons.ts";

const fact = (id: string): FactFreshness["fact"] => ({
  id,
  claim: `Claim ${id} <b>`,
  source: `https://code.claude.com/docs/en/${id}`,
  core: true,
  verifiedAt: "2026-10-18",
});

describe("teachingHtml", () => {
  it("numbers citations in order, lists their sources, and flags a changed fact", () => {
    const facts: FactFreshness[] = [
      { fact: fact("a"), confirmedAt: Date.parse("2026-10-18T00:00:00Z"), stale: false },
      {
        fact: fact("b"),
        confirmedAt: Date.parse("2026-10-01T00:00:00Z"),
        stale: true,
        problem: { lesson: "l", fact: "b", at: 0, status: "changed", note: "x" },
      },
    ];
    const html = teachingHtml(
      "First [fact:b], then [fact:a], again [fact:b]. Gone [fact:zz].",
      facts,
    );
    expect(html).toContain('<a href="#fact-b" title="Claim b &lt;b&gt;">1</a>');
    expect(html).toContain('<a href="#fact-a" title="Claim a &lt;b&gt;">2</a>');
    expect(html.match(/<li id="fact-/g)).toHaveLength(2);
    expect(html).toContain("checked 2026-10-01");
    expect(html).toContain("changed when last checked");
    expect(html).not.toContain("[fact:");
  });
});

describe("lessonRubricHtml", () => {
  it("shows scores, n/a for unscored dimensions, and which are the focus", () => {
    const session = {
      focus: ["decomposition", "verification"],
      rubric: {
        decomposition: 3,
        verification: 1,
        contextCost: null,
        safety: null,
        delegation: 2,
        notesMd: "Phase 3 **unchecked**.",
        strengths: ["Small phases"],
        improvements: ["Verify phase 3"],
      },
      verdict: { correct: false, rubricOk: false, answered: true },
    } as unknown as LessonSession;
    const html = lessonRubricHtml(session);
    expect(html).toContain('<span class="badge warn">Not yet</span>');
    expect(html).toContain('Decomposition <span class="muted small">focus</span>');
    expect(html).toContain("●●●○");
    expect(html.match(/n\/a/g)).toHaveLength(2);
    expect(html).toContain("<strong>unchecked</strong>");
    expect(html).toContain("<li>Verify phase 3</li>");
  });
});
