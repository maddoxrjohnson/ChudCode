/**
 * The cache simulator, against costs worked out by hand. Sonnet 4.5 in the model
 * file: $3 per million input tokens, reads at 0.1x, a 1,024-token minimum.
 */

import { describe, expect, it } from "vitest";

import { loadCurriculum } from "../src/curriculum.ts";
import {
  cacheSpecErrors,
  gradePlan,
  loadCacheModel,
  naivePlan,
  planErrors,
  scenarioErrors,
  simulate,
  type CachePlan,
} from "../src/drill/cache-sim.ts";
import { REFERENCE, SCENARIO } from "./cache-fixtures.ts";

const BASE = 3 / 1_000_000;

describe("plans", () => {
  it("accepts the shipped model and the scenario", () => {
    expect(scenarioErrors(SCENARIO)).toEqual([]);
    expect(planErrors(SCENARIO, REFERENCE)).toEqual([]);
  });

  it("rests every model parameter on a curriculum fact", () => {
    const facts = new Set(
      loadCurriculum().modules.flatMap((m) => m.lessons.flatMap((l) => l.facts.map((f) => f.id))),
    );
    for (const ids of Object.values(loadCacheModel().facts))
      for (const id of ids) expect(facts.has(id), id).toBe(true);
  });

  it("rejects plans that break the level order, the breakpoint limit, or TTL order", () => {
    const errors = planErrors(SCENARIO, {
      order: ["instructions", "tools", "date", "date"],
      breakpoints: [
        { after: "date", ttl: "5m" },
        { after: "tools", ttl: "1h" },
        { after: "nope", ttl: "5m" },
        { after: "docs", ttl: "5m" },
        { after: "instructions", ttl: "5m" },
      ],
    }).join("\n");
    expect(errors).toMatch(/order lists date twice/);
    expect(errors).toMatch(/order leaves out docs/);
    expect(errors).toMatch(/tools is a tools segment after a later level/);
    expect(errors).toMatch(/at most 4 breakpoints/);
    expect(errors).toMatch(/a 1h breakpoint cannot come after a 5m one/);
    expect(errors).toMatch(/breakpoint after nope/);
  });
});

describe("simulate", () => {
  it("prices the naive plan: the changing date breaks every prefix", () => {
    const naive = naivePlan(SCENARIO);
    expect(naive.order).toEqual(["tools", "date", "instructions", "docs"]);
    const cost = simulate(SCENARIO, naive);
    // Each request writes all 16,050 segment tokens at 1.25x and sends 100 fresh ones.
    expect(cost.total).toBeCloseTo(3 * (16050 * 1.25 + 100) * BASE, 9);
    expect(cost.hits).toBe(0);
  });

  it("prices the reference: the stable prefix is read after the first write", () => {
    const cost = simulate(SCENARIO, REFERENCE);
    const first = (6000 * 1.25 + 10150) * BASE;
    const later = (6000 * 0.1 + 10150) * BASE;
    expect(cost.total).toBeCloseTo(first + 2 * later, 9);
    expect(cost.hits).toBe(2);
    expect(cost.readTokens).toBe(12000);
    expect(cost.writeTokens).toBe(6000);
  });

  it("lets a five-minute entry expire across a long gap, and a one-hour entry survive it", () => {
    const gap = {
      ...SCENARIO,
      requests: [
        { at: 0, newTokens: 0 },
        { at: 30, newTokens: 0 },
        { at: 31, newTokens: 0 },
      ],
    };
    expect(simulate(gap, REFERENCE).hits).toBe(1);
    const hour: CachePlan = { ...REFERENCE, breakpoints: [{ after: "instructions", ttl: "1h" }] };
    expect(simulate(gap, hour).hits).toBe(2);
    // The one-hour write costs 2x once; reads follow.
    expect(simulate(gap, hour).total).toBeCloseTo((6000 * 2 + 10050 + 2 * (600 + 10050)) * BASE, 9);
  });

  it("does not cache a prefix under the model's minimum", () => {
    const small: CachePlan = { ...REFERENCE, breakpoints: [{ after: "tools", ttl: "5m" }] };
    const haiku = { ...SCENARIO, model: "claude-haiku-4-5" };
    expect(simulate(haiku, small).hits).toBe(0);
    expect(simulate(haiku, small).writeTokens).toBe(0);
  });
});

describe("grading", () => {
  it("passes a plan within 10% of the reference and fails the naive one", () => {
    expect(gradePlan(SCENARIO, REFERENCE, REFERENCE)).toMatchObject({ ratio: 1, passed: true });
    const naive = gradePlan(SCENARIO, naivePlan(SCENARIO), REFERENCE);
    expect(naive.passed).toBe(false);
    expect(naive.ratio).toBeGreaterThan(1.4);
    expect(naive.uncachedCost).toBeCloseTo(3 * 16150 * BASE, 9);
  });

  it("refuses a scenario whose naive plan is already good enough", () => {
    const flat = { ...SCENARIO, segments: SCENARIO.segments.map((s) => ({ ...s, changesAt: [] })) };
    expect(cacheSpecErrors(flat, naivePlan(flat)).join()).toMatch(
      /Make the scenario reward a real plan/,
    );
    expect(cacheSpecErrors(SCENARIO, REFERENCE)).toEqual([]);
  });
});
