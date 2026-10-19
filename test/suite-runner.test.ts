/**
 * The suite runner behind the agentic drills: a learner's unittest suite against one
 * module, in a real python3 process, with a per-test alarm.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pythonAdapter, pythonAvailable } from "../src/runner/adapters/python/adapter.ts";
import { ProcessRunner } from "../src/runner/process-runner.ts";
import type { Limits } from "../src/runner/types.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

const LIMITS: Limits = {
  wallMs: 8_000,
  cpuSeconds: 5,
  memoryMb: 256,
  outputKb: 16,
  fileSizeKb: 64,
  perCaseMs: 500,
};

const MODULE = "def clamp(x, lo, hi):\n    return max(lo, min(x, hi))\n";

const TESTS = [
  "import unittest",
  "from clamp import clamp",
  "",
  "class ClampTest(unittest.TestCase):",
  "    def test_inside(self):",
  "        self.assertEqual(clamp(5, 0, 10), 5)",
  "",
  "    def test_below(self):",
  "        self.assertEqual(clamp(-1, 0, 10), 0)",
  "",
  "    def test_nothing(self):",
  "        clamp(1, 0, 2)",
  "",
  "    def test_print(self):",
  "        print('noise')",
  "        assert clamp(11, 0, 10) == 10",
  "",
].join("\n");

describe.skipIf(!pythonAvailable())("ProcessRunner.runSuite", () => {
  let fixture: Fixture;
  const runner = new ProcessRunner();
  const run = (module: string, tests = TESTS) =>
    runner.runSuite({
      files: { "clamp.py": module, "tests/test_clamp.py": tests },
      limits: LIMITS,
      pythonBin: pythonAdapter.pythonBin,
    });

  beforeAll(() => {
    fixture = makeFixture();
  });
  afterAll(() => fixture.cleanup());

  it("runs every test and counts each test's assertions", async () => {
    const result = await run(MODULE);
    expect(result.status).toBe("ok");
    expect(result.tests.map((t) => [t.id.split(".").pop(), t.status])).toEqual([
      ["test_below", "pass"],
      ["test_inside", "pass"],
      ["test_nothing", "pass"],
      ["test_print", "pass"],
    ]);
    expect(result.scan).toEqual([
      { id: "tests.test_clamp.ClampTest.test_inside", asserts: 1 },
      { id: "tests.test_clamp.ClampTest.test_below", asserts: 1 },
      { id: "tests.test_clamp.ClampTest.test_nothing", asserts: 0 },
      { id: "tests.test_clamp.ClampTest.test_print", asserts: 1 },
    ]);
  });

  it("reports failures against a mutant", async () => {
    const result = await run("def clamp(x, lo, hi):\n    return min(x, hi)\n");
    expect(result.tests.find((t) => t.id.endsWith("test_below"))).toMatchObject({
      status: "fail",
      message: expect.stringContaining("-1 != 0"),
    });
  });

  it("times out one hanging test without stalling the rest", async () => {
    const hang = "def clamp(x, lo, hi):\n    while x < lo:\n        pass\n    return min(x, hi)\n";
    const result = await run(hang);
    expect(result.status).toBe("ok");
    expect(result.tests.find((t) => t.id.endsWith("test_below"))?.status).toBe("timeout");
    expect(result.tests.find((t) => t.id.endsWith("test_inside"))?.status).toBe("pass");
  });

  it("reports a module that fails to import as errors, and a hang at import as unfinished", async () => {
    const broken = await run("def clamp(x, lo, hi)\n    return x\n");
    expect(broken.tests.length).toBeGreaterThan(0);
    expect(broken.tests.every((t) => t.status === "error")).toBe(true);
    const stuck = await run("while True:\n    pass\n");
    // The CPU limit or the wall clock ends it; either way the suite did not finish.
    expect(["timeout", "crashed"]).toContain(stuck.status);
  }, 20_000);

  it("refuses paths that leave the workdir", async () => {
    await expect(
      runner.runSuite({
        files: { "../escape.py": "x" },
        limits: LIMITS,
        pythonBin: pythonAdapter.pythonBin,
      }),
    ).rejects.toThrow(/Bad suite path/);
  });
});
