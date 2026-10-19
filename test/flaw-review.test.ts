import { describe, expect, it } from "vitest";

import {
  falseAlarmLimit,
  flawSpecErrors,
  gradeReview,
  parseDiff,
  type FlawSpec,
} from "../src/drill/flaw-review.ts";
import { FLAW_SPEC } from "./flaw-fixtures.ts";

describe("parseDiff", () => {
  it("numbers added and context lines in the new file", () => {
    const [file] = parseDiff(FLAW_SPEC.diff);
    expect(file?.path).toBe("app/routes/invoices.py");
    const added = file?.lines.filter((l) => l.kind === "add") ?? [];
    expect(added[0]).toMatchObject({ newLine: 3, text: "import os" });
    expect(file?.lines.find((l) => l.text.includes("def get_invoice"))?.newLine).toBe(15);
  });

  it("explains a malformed diff", () => {
    expect(() => parseDiff("hello")).toThrow(/text outside a hunk|no files/);
    expect(() => parseDiff("+++ b/x.py\n@@ -1 +1 @@\n*bad")).toThrow(/must start with/);
  });
});

describe("flawSpecErrors", () => {
  it("accepts the fixture", () => {
    expect(flawSpecErrors(FLAW_SPEC)).toEqual([]);
  });

  it("needs flaws on added lines, a critical one, and decoys off the flaws", () => {
    const bad: FlawSpec = {
      ...FLAW_SPEC,
      flaws: FLAW_SPEC.flaws.map((f, i) =>
        i === 0 ? { ...f, line: 1, critical: false } : { ...f, critical: false },
      ),
      decoys: [{ file: FLAW_SPEC.flaws[1]!.file, line: FLAW_SPEC.flaws[1]!.line, note: "x" }],
    };
    const errors = flawSpecErrors(bad).join("\n");
    expect(errors).toMatch(/must be an added line/);
    expect(errors).toMatch(/at least one flaw must be critical/);
    expect(errors).toMatch(/decoys needs at least 2/);
    expect(errors).toMatch(/sits on a flaw/);
  });
});

describe("gradeReview", () => {
  const flaw = (id: string) => FLAW_SPEC.flaws.find((f) => f.id === id)!;

  it("passes a review that finds the criticals and most flaws, crediting near misses", () => {
    const marks = FLAW_SPEC.flaws.slice(0, 4).map((f, i) => ({
      file: f.file,
      line: f.line + (i === 0 ? 2 : 0),
      category: i === 1 ? ("other" as const) : f.category,
      reason: "looks wrong",
    }));
    const grade = gradeReview(FLAW_SPEC, marks);
    expect(grade.found).toHaveLength(4);
    expect(grade.found[1]?.categoryRight).toBe(false);
    expect(grade.missed.map((m) => m.id)).toEqual(["swallowed-error"]);
    expect(grade.passed).toBe(true);
  });

  it("fails a review that misses a critical flaw or cries wolf", () => {
    const secret = flaw("hardcoded-key");
    const grade = gradeReview(FLAW_SPEC, [
      { file: secret.file, line: secret.line, category: "secret", reason: "key in code" },
      ...FLAW_SPEC.decoys.map((d) => ({
        file: d.file,
        line: d.line,
        category: "other" as const,
        reason: "?",
      })),
      { file: secret.file, line: 1, category: "other", reason: "?" },
    ]);
    expect(grade.criticalMissed).toBeGreaterThan(0);
    expect(grade.falseAlarms).toHaveLength(3);
    expect(grade.falseAlarms[0]?.decoy).toBeDefined();
    expect(grade.problems.join(" ")).toMatch(/critical flaws? (was|were) missed/);
    expect(grade.passed).toBe(false);
    expect(falseAlarmLimit(5)).toBe(2);
  });

  it("counts a second mark on a found flaw as neither a find nor a false alarm", () => {
    const f = flaw("sql-injection");
    const grade = gradeReview(FLAW_SPEC, [
      { file: f.file, line: f.line, category: "injection", reason: "a" },
      { file: f.file, line: f.line + 1, category: "injection", reason: "b" },
    ]);
    expect(grade.found).toHaveLength(1);
    expect(grade.falseAlarms).toHaveLength(0);
  });
});
