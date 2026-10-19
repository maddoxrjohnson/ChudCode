/**
 * A cache-plan drill that passes validation: a date line placed before the stable
 * system prompt breaks every prefix until the plan moves it.
 */

import type { CachePlan, CacheScenario } from "../src/drill/cache-sim.ts";

/** The date line sits before the instructions and changes every request. */
export const SCENARIO: CacheScenario = {
  model: "claude-sonnet-4-5",
  segments: [
    { id: "tools", level: "tools", tokens: 2000, label: "tool definitions" },
    { id: "date", level: "system", tokens: 50, label: "today's date and time", changesAt: [1, 2] },
    { id: "instructions", level: "system", tokens: 4000, label: "the system prompt" },
    { id: "docs", level: "messages", tokens: 10000, label: "the API reference" },
  ],
  requests: [
    { at: 0, newTokens: 100 },
    { at: 2, newTokens: 100 },
    { at: 4, newTokens: 100 },
  ],
};

export const REFERENCE: CachePlan = {
  order: ["tools", "instructions", "date", "docs"],
  breakpoints: [{ after: "instructions", ttl: "5m" }],
};

const CACHE_PARA =
  "Every request pays again for whatever the cache could not reuse, so the order of a prompt is a cost decision. ";

export const CACHE_TEACHING = [
  "## What a cache write and read cost",
  "",
  `Writing to the five-minute cache costs 1.25 times the base price and to the hour cache twice [fact:cache-write-multipliers]; reading costs a tenth [fact:cache-read-multiplier]. ${CACHE_PARA.repeat(2)}`,
  "",
  "## Order decides what is reused",
  "",
  `A change at one level invalidates it and everything after [fact:cache-invalidation-order]. ${CACHE_PARA.repeat(2)}`,
].join("\n");

export const CACHE_BRIEF = [
  "## Scenario",
  "",
  "A support assistant runs on Sonnet 4.5. Its system prompt starts with the current date and time, then the long instructions; every request also carries the API reference. Requests come two minutes apart.",
  "",
  "## Your task",
  "",
  "With your agent, write a caching plan as JSON: the order of the segments and where the breakpoints go, with their lifetimes. Check it on the page; it passes within 10% of the best plan known.",
].join("\n");

export function cacheArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "cache-the-support-bot",
    lesson: "prompt-caching",
    kind: "cache-plan",
    title: "Cache the support bot",
    teaching_md: CACHE_TEACHING,
    brief_md: CACHE_BRIEF,
    model_outline:
      "Move the date after the stable instructions within the system level, and put the breakpoint after the instructions: the date changes every request, so nothing after it can be reused. The API reference cannot be cached while it follows the date.",
    follow_ups: [
      "Why does the date have to move?",
      "When would a one-hour lifetime pay for itself?",
    ],
    pitfalls: [
      "A breakpoint after a segment that changes every request",
      "Leaving the listed order",
    ],
    scenario: SCENARIO,
    reference_plan: REFERENCE,
    ...extra,
  };
}
