/**
 * Runner integration: real python3 processes under real limits.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pythonAdapter, pythonAvailable } from "../src/runner/adapters/python/adapter.ts";
import { ProcessRunner } from "../src/runner/process-runner.ts";
import type { CaseResult, Limits, RunRequest, Signature, TestCase } from "../src/runner/types.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

const LIMITS: Limits = {
  wallMs: 5_000,
  cpuSeconds: 3,
  memoryMb: 256,
  outputKb: 4,
  fileSizeKb: 64,
  perCaseMs: 500,
};

const ADD: Signature = {
  style: "function",
  name: "add",
  params: [
    { name: "a", type: "int" },
    { name: "b", type: "int" },
  ],
  returns: "int",
};

const ADD_CASES: TestCase[] = [
  { id: "1", visible: true, input: { a: 1, b: 2 }, expected: 3 },
  { id: "2", visible: false, input: { a: -1, b: 1 }, expected: 0 },
];

describe.skipIf(!pythonAvailable())("ProcessRunner with the Python adapter", () => {
  let fixture: Fixture;
  const runner = new ProcessRunner();

  beforeAll(() => {
    fixture = makeFixture();
  });
  afterAll(() => fixture.cleanup());

  function run(source: string, overrides: Partial<RunRequest> = {}) {
    return runner.run({
      adapter: pythonAdapter,
      source,
      signature: ADD,
      cases: ADD_CASES,
      limits: LIMITS,
      ...overrides,
    });
  }

  it("passes a correct solution and streams each case", async () => {
    const seen: CaseResult[] = [];
    const result = await run("def add(a, b):\n    return a + b\n", { onCase: (c) => seen.push(c) });
    expect(result.status).toBe("ok");
    expect(result.passed).toBe(2);
    expect(result.total).toBe(2);
    expect(result.cases.map((c) => c.status)).toEqual(["pass", "pass"]);
    expect(seen.map((c) => c.id)).toEqual(["1", "2"]);
    expect(result.maxRssKb).toBeGreaterThan(0);
  });

  it("fails a wrong answer and keeps the actual value", async () => {
    const result = await run("def add(a, b):\n    return a - b\n");
    expect(result.status).toBe("ok");
    expect(result.cases[0]).toMatchObject({ status: "fail", actual: -1, expected: 3 });
    expect(result.cases[1]).toMatchObject({ status: "fail", actual: -2, expected: 0 });
  });

  it("reports an exception with a traceback that starts in the solution", async () => {
    const result = await run("def add(a, b):\n    return a / 0\n");
    const [first] = result.cases;
    expect(first?.status).toBe("error");
    expect(first?.message).toMatch(/^ZeroDivisionError/);
    expect(first?.stderr).toContain("solution.py");
    expect(first?.stderr).not.toContain("harness.py");
  });

  it("times out one slow case and still runs the rest", async () => {
    const result = await run(
      "import time\n\ndef add(a, b):\n    if a == 1:\n        time.sleep(5)\n    return a + b\n",
    );
    expect(result.status).toBe("ok");
    expect(result.cases[0]).toMatchObject({ status: "timeout" });
    expect(result.cases[0]?.message).toMatch(/500 ms/);
    expect(result.cases[1]).toMatchObject({ status: "pass" });
  });

  it("kills a solution that swallows the per-case timeout", async () => {
    const result = await run(
      "import time\n\ndef add(a, b):\n    while True:\n        try:\n            time.sleep(10)\n        except BaseException:\n            pass\n",
      { limits: { ...LIMITS, wallMs: 1_500 } },
    );
    expect(result.status).toBe("timeout");
    expect(result.cases.every((c) => c.status === "skipped")).toBe(true);
    expect(result.cases[0]?.message).toMatch(/wall-clock/);
  }, 10_000);

  it("turns a huge allocation into a memory error, not a crash", async () => {
    const result = await run("def add(a, b):\n    x = [0] * (10 ** 9)\n    return len(x)\n");
    expect(result.status).toBe("ok");
    expect(result.cases[0]).toMatchObject({ status: "error" });
    expect(result.cases[0]?.message).toMatch(/MemoryError/);
  });

  it("captures and caps stdout", async () => {
    const result = await run('def add(a, b):\n    print("x" * 10000)\n    return a + b\n');
    expect(result.cases[0]?.status).toBe("pass");
    expect(result.cases[0]?.stdout.length).toBe(4096);
    expect(result.truncated).toBe(true);
  });

  it("reports an import error once and skips every case", async () => {
    const result = await run("def add(a, b\n    return a + b\n");
    expect(result.status).toBe("import-error");
    expect(result.stderrTail).toContain("SyntaxError");
    expect(result.cases.every((c) => c.status === "skipped")).toBe(true);
    expect(result.passed).toBe(0);
  });

  it("reports a missing function as an import error", async () => {
    const result = await run("def plus(a, b):\n    return a + b\n");
    expect(result.status).toBe("import-error");
    expect(result.stderrTail).toContain("def add was not found");
  });

  it("supports LeetCode-style Solution methods with a fresh instance per case", async () => {
    const result = await run(
      "class Solution:\n    def __init__(self):\n        self.calls = 0\n    def add(self, a, b):\n        self.calls += 1\n        return a + b + self.calls - 1\n",
      { signature: { ...ADD, style: "method" } },
    );
    expect(result.cases.map((c) => c.status)).toEqual(["pass", "pass"]);
  });

  it("scrubs the environment the solution sees", async () => {
    process.env["CHUDCODE_SECRET"] = "hunter2";
    try {
      const result = await run(
        'import os\n\ndef add(a, b):\n    return os.environ.get("CHUDCODE_SECRET", "none")\n',
        { cases: [{ id: "env", visible: true, input: { a: 0, b: 0 }, expected: "none" }] },
      );
      expect(result.cases[0]?.status).toBe("pass");
    } finally {
      delete process.env["CHUDCODE_SECRET"];
    }
  });

  it("round-trips linked lists and trees through chud_types", async () => {
    const result = await runner.run({
      adapter: pythonAdapter,
      source: [
        "from typing import Optional",
        "from chud_types import ListNode, TreeNode",
        "",
        "def reverse_list(head: Optional[ListNode]) -> Optional[ListNode]:",
        "    prev = None",
        "    while head:",
        "        head.next, prev, head = prev, head, head.next",
        "    return prev",
      ].join("\n"),
      signature: {
        style: "function",
        name: "reverse_list",
        params: [{ name: "head", type: "Optional[ListNode]" }],
        returns: "Optional[ListNode]",
      },
      cases: [
        { id: "1", visible: true, input: { head: [1, 2, 3] }, expected: [3, 2, 1] },
        { id: "2", visible: true, input: { head: [] }, expected: [] },
      ],
      limits: LIMITS,
    });
    expect(result.cases.map((c) => c.status)).toEqual(["pass", "pass"]);

    const depth = await runner.run({
      adapter: pythonAdapter,
      source: [
        "def depth(root):",
        "    return 0 if root is None else 1 + max(depth(root.left), depth(root.right))",
      ].join("\n"),
      signature: {
        style: "function",
        name: "depth",
        params: [{ name: "root", type: "Optional[TreeNode]" }],
        returns: "int",
      },
      cases: [
        { id: "1", visible: true, input: { root: [3, 9, 20, null, null, 15, 7] }, expected: 3 },
      ],
      limits: LIMITS,
    });
    expect(depth.cases[0]?.status).toBe("pass");
  });

  it("treats a case without expected as an oracle case", async () => {
    const result = await run("def add(a, b):\n    return a * b\n", {
      cases: [{ id: "oracle", visible: false, input: { a: 6, b: 7 } }],
    });
    expect(result.cases[0]).toMatchObject({ status: "pass", actual: 42 });
    expect(result.cases[0]).not.toHaveProperty("expected");
  });

  it("reads in-place results from a named argument", async () => {
    const result = await runner.run({
      adapter: pythonAdapter,
      source: "def rotate(nums, k):\n    k %= len(nums)\n    nums[:] = nums[-k:] + nums[:-k]\n",
      signature: {
        style: "function",
        name: "rotate",
        params: [
          { name: "nums", type: "List[int]" },
          { name: "k", type: "int" },
        ],
        returns: "None",
      },
      cases: [
        {
          id: "1",
          visible: true,
          input: { nums: [1, 2, 3, 4, 5], k: 2 },
          expected: [4, 5, 1, 2, 3],
          outputFrom: "nums",
        },
      ],
      limits: LIMITS,
    });
    expect(result.cases[0]?.status).toBe("pass");
  });

  it("builds inputs from generators.py and defers to checker.py", async () => {
    const result = await run("def add(a, b):\n    return a + b\n", {
      cases: [
        { id: "gen", visible: false, gen: "make(5)", expected: 10 },
        { id: "chk", visible: false, input: { a: 1, b: 1 }, compare: "checker" },
      ],
      extraFiles: {
        "generators.py": 'def make(n):\n    return {"a": n, "b": n}\n',
        "checker.py":
          'def check(input, actual, expected):\n    return actual == input["a"] + input["b"]\n',
      },
    });
    expect(result.cases.map((c) => c.status)).toEqual(["pass", "pass"]);
    expect(result.cases[1]?.checkerPassed).toBe(true);
  });

  it("applies compare modes from the case", async () => {
    const result = await run("def add(a, b):\n    return [b, a]\n", {
      cases: [
        { id: "u", visible: true, input: { a: 1, b: 2 }, expected: [1, 2], compare: "unordered" },
      ],
    });
    expect(result.cases[0]?.status).toBe("pass");
  });
});

describe("PythonAdapter.stub", () => {
  it("writes a function stub with only the imports it needs", () => {
    const stub = pythonAdapter.stub({
      style: "function",
      name: "merge",
      params: [{ name: "lists", type: "List[Optional[ListNode]]" }],
      returns: "Optional[ListNode]",
    });
    expect(stub).toBe(
      [
        "from typing import List, Optional",
        "from chud_types import ListNode",
        "",
        "",
        "def merge(lists: List[Optional[ListNode]]) -> Optional[ListNode]:",
        "    pass",
        "",
      ].join("\n"),
    );
  });

  it("writes a Solution class for method style", () => {
    const stub = pythonAdapter.stub({
      style: "method",
      name: "twoSum",
      params: [
        { name: "nums", type: "list[int]" },
        { name: "target", type: "int" },
      ],
      returns: "list[int]",
    });
    expect(stub).toBe(
      "class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        pass\n",
    );
  });
});
