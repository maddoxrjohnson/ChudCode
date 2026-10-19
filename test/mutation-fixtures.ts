/**
 * A mutation drill that passes validation: a token-bucket limiter, two rewrites,
 * five mutants, and an oracle that kills them all.
 */

import type { MutationSpec } from "../src/drill/mutation.ts";

export const REFERENCE = `"""A token bucket: \`capacity\` tokens, refilled at \`rate\` per second."""


class Bucket:
    def __init__(self, capacity, rate):
        if capacity <= 0 or rate < 0:
            raise ValueError("capacity must be positive and rate non-negative")
        self.capacity = capacity
        self.rate = rate
        self.tokens = capacity
        self.last = 0.0

    def allow(self, now, cost=1):
        elapsed = max(0.0, now - self.last)
        self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
        self.last = max(self.last, now)
        if cost <= self.tokens:
            self.tokens -= cost
            return True
        return False
`;

export const REWRITE_A = `class Bucket:
    def __init__(self, capacity, rate):
        if not (capacity > 0 and rate >= 0):
            raise ValueError("bad bucket")
        self.capacity, self.rate = capacity, rate
        self.tokens, self.last = capacity, 0.0

    def _refill(self, now):
        if now > self.last:
            self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate)
            self.last = now

    def allow(self, now, cost=1):
        self._refill(now)
        if self.tokens >= cost:
            self.tokens = self.tokens - cost
            return True
        return False
`;

export const REWRITE_B = `class Bucket:
    def __init__(self, capacity, rate):
        if capacity <= 0:
            raise ValueError("capacity")
        if rate < 0:
            raise ValueError("rate")
        self.capacity = capacity
        self.rate = rate
        self.level = capacity
        self.stamp = 0.0

    @property
    def tokens(self):
        return self.level

    def allow(self, now, cost=1):
        gained = (now - self.stamp) * self.rate if now > self.stamp else 0.0
        self.level = min(self.capacity, self.level + gained)
        self.stamp = max(self.stamp, now)
        ok = self.level >= cost
        if ok:
            self.level -= cost
        return ok
`;

export const ORACLE = `import unittest

from limiter import Bucket


class BucketTest(unittest.TestCase):
    def test_starts_full(self):
        b = Bucket(3, 1)
        self.assertTrue(b.allow(0))
        self.assertTrue(b.allow(0))
        self.assertTrue(b.allow(0))
        self.assertFalse(b.allow(0))

    def test_refills_over_time(self):
        b = Bucket(1, 2)
        self.assertTrue(b.allow(0))
        self.assertFalse(b.allow(0.25))
        self.assertTrue(b.allow(0.5))

    def test_caps_at_capacity(self):
        b = Bucket(2, 10)
        self.assertTrue(b.allow(100, cost=2))
        self.assertFalse(b.allow(100))

    def test_exact_cost_is_allowed(self):
        b = Bucket(2, 0)
        self.assertTrue(b.allow(0, cost=2))

    def test_clock_going_backwards_adds_nothing(self):
        b = Bucket(1, 1)
        self.assertTrue(b.allow(5))
        self.assertFalse(b.allow(4))
        self.assertFalse(b.allow(5.5))
        self.assertTrue(b.allow(6))

    def test_rejects_bad_arguments(self):
        with self.assertRaises(ValueError):
            Bucket(0, 1)
        with self.assertRaises(ValueError):
            Bucket(1, -1)


if __name__ == "__main__":
    unittest.main()
`;

export const SPEC: MutationSpec = {
  module: "limiter",
  reference: REFERENCE,
  rewrites: [REWRITE_A, REWRITE_B],
  mutants: [
    {
      id: "strict-cost",
      description: "A request costing exactly the tokens left is refused",
      find: "if cost <= self.tokens:",
      replace: "if cost < self.tokens:",
    },
    {
      id: "no-cap",
      description: "Refill is not capped at capacity",
      find: "self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)",
      replace: "self.tokens = self.tokens + elapsed * self.rate",
    },
    {
      id: "backwards-clock",
      description: "A clock going backwards moves the refill point back",
      find: "self.last = max(self.last, now)",
      replace: "self.last = now",
    },
    {
      id: "free-requests",
      description: "Allowed requests do not spend tokens",
      find: "self.tokens -= cost",
      replace: "pass",
    },
    {
      id: "zero-capacity",
      description: "A bucket of capacity zero is accepted",
      find: "if capacity <= 0 or rate < 0:",
      replace: "if capacity < 0 or rate < 0:",
    },
  ],
  oracleTests: ORACLE,
};

/** A learner suite that kills two of the five mutants. */
export const WEAK_TESTS = `import unittest
from limiter import Bucket


class T(unittest.TestCase):
    def test_full_then_empty(self):
        b = Bucket(2, 1)
        self.assertTrue(b.allow(0))
        self.assertTrue(b.allow(0))
        self.assertFalse(b.allow(0))

    def test_refill(self):
        b = Bucket(1, 1)
        b.allow(0)
        self.assertTrue(b.allow(1))

    def test_runs(self):
        Bucket(5, 1).allow(0)
`;

const CHECK_PARA =
  "A suite that only restates what the code returns today passes on the bug you are about to ship. ";

export const DRILL_TEACHING = [
  "## Give the agent a check",
  "",
  `An agent stops when the work looks done, so hand it a check it can run [fact:verify-work]. ${CHECK_PARA.repeat(2)}`,
  "",
  "## Start from a failing test",
  "",
  `For a bug, have it write a failing test that reproduces the issue before the fix [fact:write-failing-test]. ${CHECK_PARA.repeat(2)}`,
  "",
  "## What makes a test strong",
  "",
  `A strong test pins behaviour at the edges: the exact boundary, the empty case, the clock that runs backwards. ${CHECK_PARA}`,
].join("\n");

export const DRILL_BRIEF = [
  "## Scenario",
  "",
  "A payments API throttles each merchant with a token bucket in `limiter.py`. It has no tests, and an incident last month came from a refill bug. The module is in your workspace.",
  "",
  "## Your task",
  "",
  "Have your agent write tests in `tests/` that would catch real bugs in this module, then press Grade. Your suite is run against hidden variants of the module: some correct, some with one bug each.",
].join("\n");

export function drillArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "test-the-token-bucket",
    lesson: "verify-with-checks",
    kind: "mutation",
    title: "Test the token bucket",
    teaching_md: DRILL_TEACHING,
    brief_md: DRILL_BRIEF,
    model_outline:
      "A strong suite: a full bucket allows exactly capacity requests; a request costing exactly the tokens left is allowed; refill is proportional to elapsed time and capped at capacity; a clock going backwards adds nothing; bad constructor arguments raise.",
    follow_ups: [
      "Which boundary in allow() would you test first, and why?",
      "How would you test the refill without sleeping?",
    ],
    pitfalls: ["Only testing the happy path", "Asserting on private attributes"],
    module_name: SPEC.module,
    module_py: SPEC.reference,
    rewrites_py: SPEC.rewrites,
    mutants: SPEC.mutants,
    oracle_tests_py: SPEC.oracleTests,
    ...extra,
  };
}
