/**
 * The agentic-coding curriculum: the shipped file is sound, modules unlock in order,
 * and fact checks decide what needs re-reading before a lesson.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCurriculumProgress,
  findLesson,
  isTeachable,
  loadCurriculum,
  loadCurriculumProgress,
  validateCurriculum,
  type Curriculum,
  type Lesson,
} from "../src/curriculum.ts";
import { curriculumText, factLines } from "../src/lesson-prompts.ts";
import { DAY_MS } from "../src/review.ts";
import { factFreshness, readFactChecks } from "../src/store/fact-checks.ts";
import { createLesson, updateLesson } from "../src/store/lessons.ts";
import { McpSession, CandidateInbox } from "../src/mcp.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

const T0 = Date.UTC(2026, 9, 18, 12);

function fact(id: string, core = true) {
  return {
    id,
    claim: `A claim about ${id} that is long enough.`,
    source: "https://code.claude.com/docs/en/x",
    core,
    verifiedAt: "2026-10-18",
  };
}

function lesson(id: string, teachable = true): Lesson {
  return {
    id,
    title: id,
    goals: ["g"],
    facts: teachable ? [fact(`${id}-a`), fact(`${id}-b`, false)] : [],
    exercises: ["design-review"],
    rubricFocus: ["verification"],
  };
}

const SMALL: Curriculum = {
  version: 1,
  factHosts: ["code.claude.com"],
  modules: [
    { id: "a", name: "A", blurb: "a", requires: [], lessons: [lesson("a1"), lesson("a2")] },
    {
      id: "b",
      name: "B",
      blurb: "b",
      requires: ["a"],
      lessons: [lesson("b1"), lesson("b2", false)],
    },
    { id: "c", name: "C", blurb: "c", requires: ["b"], lessons: [lesson("c1")] },
  ],
};

describe("the shipped curriculum", () => {
  it("validates, and the first two modules are fully teachable", () => {
    const curriculum = loadCurriculum();
    expect(validateCurriculum(curriculum)).toEqual([]);
    const [planning, tests] = curriculum.modules;
    expect(planning?.id).toBe("planning");
    expect(tests?.id).toBe("test-strength");
    for (const l of [...(planning?.lessons ?? []), ...(tests?.lessons ?? [])])
      expect(isTeachable(l), l.id).toBe(true);
    expect(curriculum.modules.map((m) => m.id)).toContain("cross-provider");
  });

  it("covers every topic the track promises", () => {
    const ids = loadCurriculum().modules.map((m) => m.id);
    expect(ids).toEqual([
      "planning",
      "test-strength",
      "review-accuracy-security",
      "skills",
      "loops-automation",
      "orchestration",
      "cost-context",
      "refactoring",
      "cross-provider",
    ]);
  });
});

describe("validateCurriculum", () => {
  it("accepts a sound file", () => {
    expect(validateCurriculum(SMALL)).toEqual([]);
  });

  it("rejects a requirement on a later module, repeated ids, and off-list sources", () => {
    const bad = structuredClone(SMALL) as Curriculum;
    bad.modules[0]!.requires = ["b"];
    bad.modules[1]!.lessons[0]!.id = "a1";
    bad.modules[2]!.lessons[0]!.facts[0]!.source = "https://example.com/blog";
    bad.modules[2]!.lessons[0]!.facts[1]!.source = "http://code.claude.com/docs";
    const errors = validateCurriculum(bad).join("\n");
    expect(errors).toMatch(/requires names b, which is not an earlier module/);
    expect(errors).toMatch(/id a1 is repeated/);
    expect(errors).toMatch(/on example\.com, not a factHost/);
    expect(errors).toMatch(/must be an https URL/);
  });

  it("needs a core fact, two facts or none, and a checklist for a lab", () => {
    const bad = structuredClone(SMALL) as Curriculum;
    bad.modules[0]!.lessons[0]!.facts = [fact("only", false)];
    bad.modules[0]!.lessons[1]!.exercises = ["lab"];
    bad.modules[0]!.lessons[1]!.rubricFocus = ["vibes" as never];
    const errors = validateCurriculum(bad).join("\n");
    expect(errors).toMatch(/at least two facts/);
    expect(errors).toMatch(/at least one core fact/);
    expect(errors).toMatch(/lists a lab, so it needs a checklist/);
    expect(errors).toMatch(/lists a lab, so it needs labFiles/);
    expect(errors).toMatch(/rubricFocus must list dimensions/);
  });

  it("keeps lab files to the lab allow-list", () => {
    const bad = structuredClone(SMALL) as Curriculum;
    bad.modules[0]!.lessons[0]!.labFiles = ["CLAUDE.md", ".env", "src/**/*.ts"];
    const errors = validateCurriculum(bad).join("\n");
    expect(errors).toMatch(/labFiles names \.env, which is not on the lab allow-list/);
    expect(errors).toMatch(/labFiles names src\/\*\*\/\*\.ts/);
    expect(errors).not.toMatch(/names CLAUDE\.md/);
  });
});

describe("buildCurriculumProgress", () => {
  const attempt = (l: string, correct: boolean, day: number) => ({
    lesson: l,
    correct,
    at: T0 + day * DAY_MS,
    session: `s-${l}-${day}`,
  });

  it("opens only modules with no requirements at first", () => {
    const progress = buildCurriculumProgress(SMALL, []);
    expect(progress.modules.map((m) => m.unlocked)).toEqual([true, false, false]);
    expect(progress.modules[1]?.waitingOn).toEqual(["a"]);
    expect(progress.next?.lesson.id).toBe("a1");
    expect(progress.total).toBe(4);
  });

  it("opens the next module at half, and outlines do not count toward it", () => {
    const progress = buildCurriculumProgress(SMALL, [
      attempt("a1", false, 0),
      attempt("a1", true, 1),
    ]);
    expect(progress.modules[0]).toMatchObject({ passed: 1, total: 2, unlockAt: 1 });
    expect(progress.modules[0]?.lessons[0]).toMatchObject({ state: "passed", attempts: 2 });
    expect(progress.modules[1]).toMatchObject({ unlocked: true, total: 1, unlockAt: 1 });
    expect(progress.modules[1]?.lessons[1]?.state).toBe("outline");
    expect(progress.modules[2]?.unlocked).toBe(false);
    expect(progress.next?.lesson.id).toBe("a2");
  });

  it("falls back to a lesson not yet passed once every open one is tried", () => {
    const progress = buildCurriculumProgress(SMALL, [
      attempt("a1", true, 0),
      attempt("a2", false, 1),
      attempt("b1", false, 2),
    ]);
    expect(progress.next?.lesson.id).toBe("a2");
  });
});

describe("fact freshness", () => {
  const facts = [fact("x"), fact("y"), fact("z")];

  it("is stale after two weeks, or when the newest check found a problem", () => {
    const now = Date.parse("2026-10-25T00:00:00Z");
    const checks = [
      {
        lesson: "l",
        fact: "y",
        at: now - DAY_MS,
        status: "changed" as const,
        note: "now 300 lines",
      },
      { lesson: "l", fact: "z", at: now - 2 * DAY_MS, status: "unreachable" as const, note: "404" },
      { lesson: "l", fact: "z", at: now - DAY_MS, status: "confirmed" as const },
    ];
    expect(factFreshness(facts, checks, now).map((f) => f.stale)).toEqual([false, true, false]);
    expect(factFreshness(facts, [], now + 14 * DAY_MS).map((f) => f.stale)).toEqual([
      true,
      true,
      true,
    ]);
    const lines = factLines(factFreshness(facts, checks, now), now).join("\n");
    expect(lines).toMatch(/`y` \(core\).*\*\*changed\*\* when last checked: now 300 lines/);
    expect(lines).toMatch(/`x` \(core\).*confirmed 7 days ago/);
  });
});

describe("the tools", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = makeFixture();
  });
  afterEach(() => fixture.cleanup());

  async function call(mcp: McpSession, name: string, args: Record<string, unknown> = {}) {
    const response = (await mcp.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    })) as { result: { content: Array<{ text: string }>; isError: boolean } };
    return { text: response.result.content[0]!.text, isError: response.result.isError };
  }

  it("list_curriculum shows standing from scored lessons", async () => {
    const mcp = new McpSession(new CandidateInbox());
    const before = await call(mcp, "list_curriculum");
    expect(before.text).toMatch(/Next: `plan-before-code`/);
    expect(before.text).toMatch(/`test-strength` .* locked: needs `planning` half passed/);

    updateLesson(
      createLesson({
        lesson: "plan-before-code",
        lessonTitle: "x",
        module: "planning",
        exercise: "e",
        exerciseKind: "design-review",
        focus: ["decomposition"],
        timerMs: 1,
      }).id,
      (s) => {
        s.phase = "done";
        s.verdict = { correct: true, rubricOk: true, answered: true };
      },
    );
    expect(loadCurriculumProgress().modules[0]?.passed).toBe(1);
    // A module of outlines behind a locked one stays locked.
    expect(
      loadCurriculumProgress().modules.find((m) => m.id === "loops-automation")?.unlocked,
    ).toBe(false);
    const planning = await call(mcp, "list_curriculum", { module: "planning" });
    expect(planning.text).toMatch(/- passed: `plan-before-code`/);
    expect((await call(mcp, "list_curriculum", { module: "nope" })).isError).toBe(true);
    expect(curriculumText(loadCurriculumProgress())).toMatch(/`test-strength` .* locked/);
  });

  it("record_fact_check logs checks and needs a note for a problem", async () => {
    const mcp = new McpSession(new CandidateInbox());
    const place = findLesson("plan-before-code");
    const factId = place!.lesson.facts[0]!.id;
    expect(
      (
        await call(mcp, "record_fact_check", {
          lesson: "plan-before-code",
          fact: factId,
          status: "confirmed",
        })
      ).isError,
    ).toBe(false);
    const missing = await call(mcp, "record_fact_check", {
      lesson: "plan-before-code",
      fact: factId,
      status: "changed",
    });
    expect(missing.text).toMatch(/note is required/);
    expect(
      (
        await call(mcp, "record_fact_check", {
          lesson: "plan-before-code",
          fact: "nope",
          status: "confirmed",
        })
      ).text,
    ).toMatch(/has no fact nope/);
    expect(readFactChecks()).toHaveLength(1);
    expect(readFactChecks()[0]).toMatchObject({
      lesson: "plan-before-code",
      fact: factId,
      status: "confirmed",
    });
  });
});
