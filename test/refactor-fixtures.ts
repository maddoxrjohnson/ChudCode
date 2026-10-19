/**
 * A refactor drill that passes validation: one tangled pricing function, a clean
 * version with the same behaviour, four mutants of the original, and an oracle.
 */

import type { RefactorSpec } from "../src/drill/refactor.ts";

export const LEGACY = `"""Order pricing, grown one feature at a time."""


def price(items, coupon=None, member=False):
    total = 0
    for item in items:
        if item["qty"] > 0:
            if item.get("sale"):
                if item["price"] > 100:
                    total += item["qty"] * item["price"] * 0.8
                else:
                    total += item["qty"] * item["price"] * 0.9
            else:
                total += item["qty"] * item["price"]
        else:
            if item["qty"] < 0:
                raise ValueError("negative quantity")
    if coupon:
        if coupon == "TENOFF":
            if total >= 50:
                total -= 10
        elif coupon == "HALF":
            total = total / 2
        else:
            raise ValueError("unknown coupon")
    if member:
        if total > 200:
            total = total * 0.95
    if total < 0:
        total = 0
    return round(total, 2)
`;

export const CLEAN = `"""Order pricing."""

COUPONS = {"TENOFF", "HALF"}


def _line_total(item):
    if item["qty"] < 0:
        raise ValueError("negative quantity")
    subtotal = item["qty"] * item["price"]
    if not item.get("sale"):
        return subtotal
    return subtotal * (0.8 if item["price"] > 100 else 0.9)


def _apply_coupon(total, coupon):
    if coupon is None or coupon == "":
        return total
    if coupon not in COUPONS:
        raise ValueError("unknown coupon")
    if coupon == "HALF":
        return total / 2
    return total - 10 if total >= 50 else total


def price(items, coupon=None, member=False):
    total = sum(_line_total(item) for item in items)
    total = _apply_coupon(total, coupon)
    if member and total > 200:
        total *= 0.95
    return round(max(total, 0), 2)
`;

export const REFACTOR_ORACLE = `import unittest

from pricing import price


def item(qty, unit, sale=False):
    return {"qty": qty, "price": unit, "sale": sale}


class PriceTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(price([item(2, 10)]), 20)

    def test_sale_discounts(self):
        self.assertEqual(price([item(1, 100, True)]), 90)
        self.assertEqual(price([item(1, 200, True)]), 160)

    def test_zero_quantity_is_free(self):
        self.assertEqual(price([item(0, 10)]), 0)

    def test_negative_quantity(self):
        with self.assertRaises(ValueError):
            price([item(-1, 10)])

    def test_coupons(self):
        self.assertEqual(price([item(5, 10)], "TENOFF"), 40)
        self.assertEqual(price([item(4, 10)], "TENOFF"), 40)
        self.assertEqual(price([item(4, 10)], "HALF"), 20)
        with self.assertRaises(ValueError):
            price([item(1, 10)], "BOGUS")

    def test_member(self):
        self.assertEqual(price([item(3, 100)], member=True), 285)
        self.assertEqual(price([item(2, 100)], member=True), 200)


if __name__ == "__main__":
    unittest.main()
`;

export const REFACTOR_SPEC: RefactorSpec = {
  module: "pricing",
  legacy: LEGACY,
  clean: CLEAN,
  mutants: [
    {
      id: "sale-threshold",
      description: "The bigger sale discount starts at 100 instead of above it",
      find: 'if item["price"] > 100:',
      replace: 'if item["price"] >= 100:',
    },
    {
      id: "tenoff-threshold",
      description: "TENOFF applies only above 50, not at exactly 50",
      find: "if total >= 50:",
      replace: "if total > 50:",
    },
    {
      id: "member-rate",
      description: "Members get 10% off instead of 5%",
      find: "total = total * 0.95",
      replace: "total = total * 0.9",
    },
    {
      id: "silent-negative",
      description: "A negative quantity is ignored instead of rejected",
      find: '                raise ValueError("negative quantity")',
      replace: "                pass",
    },
  ],
  oracleTests: REFACTOR_ORACLE,
};

/** Characterisation tests a careful agent would write before touching the code. */
export const CHARACTERISATION = REFACTOR_ORACLE;

/** A refactor that keeps behaviour: the clean module. */
export const GOOD_REFACTOR = CLEAN;

/** A refactor that changes behaviour: the member discount moved. */
export const BAD_REFACTOR = CLEAN.replace("total *= 0.95", "total *= 0.9");

const REFACTOR_PARA =
  "A refactor with no test pinning today's behaviour is a rewrite with extra confidence. ";

export const REFACTOR_TEACHING = [
  "## What a refactor is",
  "",
  `Fowler defines it as changing internal structure without changing observable behaviour [fact:fowler-definition-of-refactoring]. ${REFACTOR_PARA.repeat(2)}`,
  "",
  "## Pin it first",
  "",
  `Give the agent a check it can run [fact:refactor-needs-a-check]. ${REFACTOR_PARA.repeat(2)}`,
  "",
  "## Small steps",
  "",
  `Refactor in small, testable increments [fact:refactor-small-testable-increments]. ${REFACTOR_PARA}`,
].join("\n");

export const REFACTOR_BRIEF = [
  "## Scenario",
  "",
  "A shop's pricing function grew a branch per promotion. The next change adds a coupon type, and nobody wants to touch it. It has no tests.",
  "",
  "## Your task",
  "",
  "With your own agent: pin what `price` does today with characterisation tests and commit them, then refactor it into something the next coupon fits into, and commit again. Keep `price`'s signature.",
].join("\n");

export function refactorArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "untangle-the-pricing",
    lesson: "when-to-refactor",
    kind: "refactor",
    title: "Untangle the pricing",
    teaching_md: REFACTOR_TEACHING,
    brief_md: REFACTOR_BRIEF,
    model_outline:
      "Characterisation tests first: each discount tier at and around its threshold, both coupons, the unknown coupon, negative and zero quantities, the member threshold. Commit. Then split line totals and coupons into helpers and a coupon table; run the tests after each step.",
    follow_ups: [
      "Which threshold would you have missed without a test?",
      "Why commit the tests separately?",
    ],
    pitfalls: ["Refactoring before any test exists", "Tests that assert on helper names"],
    module_name: REFACTOR_SPEC.module,
    legacy_py: REFACTOR_SPEC.legacy,
    clean_py: REFACTOR_SPEC.clean,
    mutants: REFACTOR_SPEC.mutants,
    oracle_tests_py: REFACTOR_SPEC.oracleTests,
    ...extra,
  };
}
