/**
 * cache-sim.ts: what a sequence of requests costs under a caching plan.
 *
 * A deliberately simplified model of Anthropic's prompt caching, for planning
 * exercises, with every parameter from `data/agentic/cache-model.json` and each one
 * resting on a sourced curriculum fact:
 *
 *   - A prompt is an ordered list of segments, then each request's own new tokens.
 *     Segments sit at a level (tools, system, messages) and must stay in that order.
 *   - A plan orders the segments within their levels and places up to four
 *     breakpoints, each with a 5-minute or 1-hour lifetime; longer lifetimes first.
 *   - A request reads the longest prefix ending at a breakpoint that is cached and
 *     unexpired, at the model's read multiplier, and refreshes it. Every later
 *     breakpoint's stretch is written at its lifetime's write multiplier. Tokens past
 *     the last breakpoint, and any prefix shorter than the model's minimum, are plain
 *     input.
 *   - A segment that changes at a request changes the prefix from there on, so
 *     everything after it misses.
 *
 * What it leaves out: the 20-block lookback, output tokens, and batch discounts. The
 * page says so; the point is the shape of the trade-off, not an invoice.
 */

import * as path from "node:path";

import { readJson } from "../store/json.ts";
import { dataDir } from "../store/paths.ts";

export const LEVELS = ["tools", "system", "messages"] as const;
export type Level = (typeof LEVELS)[number];
export const TTLS = ["5m", "1h"] as const;
export type Ttl = (typeof TTLS)[number];

export interface CacheModel {
  verifiedAt: string;
  ttlMinutes: Record<Ttl, number>;
  writeMultiplier: Record<Ttl, number>;
  maxBreakpoints: number;
  facts: Record<string, string[]>;
  models: Record<string, { inputPerMTok: number; readMultiplier: number; minCacheable: number }>;
}

export interface Segment {
  id: string;
  level: Level;
  tokens: number;
  /** What it is, for the page: "tool definitions", "today's date". */
  label: string;
  /** Request indexes (0-based) at which the segment's content changes. */
  changesAt?: number[];
}

export interface CacheRequest {
  /** Minutes from the start. */
  at: number;
  /** This request's own new tokens, after every segment. */
  newTokens: number;
}

export interface CacheScenario {
  model: string;
  segments: Segment[];
  requests: CacheRequest[];
}

export interface CachePlan {
  order: string[];
  breakpoints: Array<{ after: string; ttl: Ttl }>;
}

let cachedModel: CacheModel | null = null;

export function loadCacheModel(): CacheModel {
  cachedModel ??= readJson<CacheModel>(path.join(dataDir(), "agentic", "cache-model.json"));
  if (!cachedModel) throw new Error("data/agentic/cache-model.json is missing");
  return cachedModel;
}

/** Problems with a scenario's shape. */
export function scenarioErrors(scenario: CacheScenario, model = loadCacheModel()): string[] {
  const errors: string[] = [];
  if (!model.models[scenario.model])
    errors.push(`model must be one of ${Object.keys(model.models).join(", ")}`);
  if (scenario.segments.length < 3 || scenario.segments.length > 12)
    errors.push("segments needs 3 to 12 entries");
  const ids = new Set<string>();
  for (const seg of scenario.segments) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(seg.id))
      errors.push(`segment id ${seg.id} must be kebab-case`);
    if (ids.has(seg.id)) errors.push(`segment id ${seg.id} is repeated`);
    ids.add(seg.id);
    if (!(LEVELS as readonly string[]).includes(seg.level))
      errors.push(`segment ${seg.id}: level must be ${LEVELS.join(", ")}`);
    if (!Number.isInteger(seg.tokens) || seg.tokens < 1 || seg.tokens > 200_000)
      errors.push(`segment ${seg.id}: tokens must be 1 to 200,000`);
    for (const at of seg.changesAt ?? [])
      if (!Number.isInteger(at) || at < 1 || at >= scenario.requests.length)
        errors.push(
          `segment ${seg.id}: changesAt must name requests 1 to ${scenario.requests.length - 1}`,
        );
  }
  if (scenario.requests.length < 3 || scenario.requests.length > 200)
    errors.push("requests needs 3 to 200 entries");
  let last = -Infinity;
  for (const [i, req] of scenario.requests.entries()) {
    if (!(req.at >= last)) errors.push(`requests[${i}].at must not go back in time`);
    last = req.at;
    if (!Number.isInteger(req.newTokens) || req.newTokens < 0)
      errors.push(`requests[${i}].newTokens must be a non-negative integer`);
  }
  return errors;
}

/** Problems with a plan for a scenario; [] when it can be simulated. */
export function planErrors(
  scenario: CacheScenario,
  plan: CachePlan,
  model = loadCacheModel(),
): string[] {
  const errors: string[] = [];
  const byId = new Map(scenario.segments.map((s) => [s.id, s]));
  if (!Array.isArray(plan.order)) return ["order must be a list of segment ids"];
  const seen = new Set<string>();
  for (const id of plan.order) {
    if (!byId.has(id)) errors.push(`order names ${id}, which is not a segment`);
    if (seen.has(id)) errors.push(`order lists ${id} twice`);
    seen.add(id);
  }
  for (const seg of scenario.segments)
    if (!seen.has(seg.id)) errors.push(`order leaves out ${seg.id}`);
  let level = 0;
  for (const id of plan.order) {
    const seg = byId.get(id);
    if (!seg) continue;
    const at = LEVELS.indexOf(seg.level);
    if (at < level)
      errors.push(
        `${id} is a ${seg.level} segment after a later level; tools, then system, then messages`,
      );
    level = Math.max(level, at);
  }
  if (!Array.isArray(plan.breakpoints)) return [...errors, "breakpoints must be a list"];
  if (plan.breakpoints.length > model.maxBreakpoints)
    errors.push(`at most ${model.maxBreakpoints} breakpoints`);
  let position = -1;
  let ttlRank = 0;
  for (const bp of plan.breakpoints) {
    const at = plan.order.indexOf(bp.after);
    if (at < 0) {
      errors.push(`breakpoint after ${bp.after}: not a segment in order`);
      continue;
    }
    if (at <= position) errors.push("breakpoints must follow the order, one per segment");
    position = at;
    if (!(TTLS as readonly string[]).includes(bp.ttl))
      errors.push(`breakpoint ttl must be 5m or 1h`);
    const rank = bp.ttl === "1h" ? 0 : 1;
    if (rank < ttlRank) errors.push("a 1h breakpoint cannot come after a 5m one");
    ttlRank = Math.max(ttlRank, rank);
  }
  return errors;
}

export interface CacheCost {
  /** In dollars. */
  total: number;
  writeTokens: number;
  readTokens: number;
  uncachedTokens: number;
  hits: number;
  perRequest: Array<{ at: number; cost: number; read: number; written: number; uncached: number }>;
}

/** Simulate a valid plan. Throws if the plan is invalid; call `planErrors` first. */
export function simulate(
  scenario: CacheScenario,
  plan: CachePlan,
  model = loadCacheModel(),
): CacheCost {
  const errors = planErrors(scenario, plan, model);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const pricing = model.models[scenario.model];
  if (!pricing) throw new Error(`unknown model ${scenario.model}`);
  const base = pricing.inputPerMTok / 1_000_000;
  const segs = plan.order.map((id) => scenario.segments.find((s) => s.id === id) as Segment);
  const version = (seg: Segment, req: number) =>
    (seg.changesAt ?? []).filter((c) => c <= req).length;
  // Prefix end (exclusive index into segs) and lifetime for each breakpoint.
  const points = plan.breakpoints.map((bp) => ({
    end: plan.order.indexOf(bp.after) + 1,
    ttl: bp.ttl,
  }));
  const entries = new Map<string, number>(); // prefix key -> expires at (minutes)

  const out: CacheCost = {
    total: 0,
    writeTokens: 0,
    readTokens: 0,
    uncachedTokens: 0,
    hits: 0,
    perRequest: [],
  };
  scenario.requests.forEach((req, i) => {
    const key = (end: number) =>
      segs
        .slice(0, end)
        .map((s) => `${s.id}@${version(s, i)}`)
        .join("|");
    const tokensTo = (end: number) => segs.slice(0, end).reduce((n, s) => n + s.tokens, 0);
    let read = 0;
    let written = 0;
    let cost = 0;
    let hitIndex = -1;
    for (let p = points.length - 1; p >= 0; p--) {
      const point = points[p] as (typeof points)[number];
      const expires = entries.get(key(point.end));
      if (
        expires !== undefined &&
        expires >= req.at &&
        tokensTo(point.end) >= pricing.minCacheable
      ) {
        hitIndex = p;
        break;
      }
    }
    let covered = 0;
    if (hitIndex >= 0) {
      const point = points[hitIndex] as (typeof points)[number];
      read = tokensTo(point.end);
      covered = read;
      cost += read * base * pricing.readMultiplier;
      out.hits += 1;
      // Reading refreshes the entry, and the shorter prefixes inside it.
      for (let p = 0; p <= hitIndex; p++) {
        const inner = points[p] as (typeof points)[number];
        if (entries.has(key(inner.end)))
          entries.set(key(inner.end), req.at + model.ttlMinutes[inner.ttl]);
      }
    }
    for (let p = hitIndex + 1; p < points.length; p++) {
      const point = points[p] as (typeof points)[number];
      const upTo = tokensTo(point.end);
      const stretch = upTo - covered;
      if (upTo >= pricing.minCacheable) {
        written += stretch;
        cost += stretch * base * model.writeMultiplier[point.ttl];
        entries.set(key(point.end), req.at + model.ttlMinutes[point.ttl]);
      } else {
        cost += stretch * base;
      }
      covered = upTo;
    }
    const uncached = tokensTo(segs.length) - covered + req.newTokens;
    cost += uncached * base;
    out.total += cost;
    out.readTokens += read;
    out.writeTokens += written;
    out.uncachedTokens += uncached;
    out.perRequest.push({ at: req.at, cost, read, written, uncached });
  });
  return out;
}

/** The plan a learner who does nothing special would write: as listed, one 5m breakpoint at the end. */
export function naivePlan(scenario: CacheScenario): CachePlan {
  const order = LEVELS.flatMap((level) =>
    scenario.segments.filter((s) => s.level === level).map((s) => s.id),
  );
  return { order, breakpoints: [{ after: order[order.length - 1] as string, ttl: "5m" }] };
}

export const COST_SLACK = 1.1;
/** A reference plan must beat the naive one by this much, or the exercise teaches nothing. */
export const NAIVE_MARGIN = 1.15;

export interface CachePlanGrade {
  cost: CacheCost;
  referenceCost: number;
  naiveCost: number;
  /** The cost with no caching at all. */
  uncachedCost: number;
  ratio: number;
  passed: boolean;
}

export function gradePlan(
  scenario: CacheScenario,
  plan: CachePlan,
  reference: CachePlan,
): CachePlanGrade {
  const cost = simulate(scenario, plan);
  const referenceCost = simulate(scenario, reference).total;
  const naiveCost = simulate(scenario, naivePlan(scenario)).total;
  const uncachedCost = simulate(scenario, {
    order: naivePlan(scenario).order,
    breakpoints: [],
  }).total;
  const ratio = referenceCost > 0 ? cost.total / referenceCost : 1;
  return { cost, referenceCost, naiveCost, uncachedCost, ratio, passed: ratio <= COST_SLACK };
}

/** Validation: the reference must be valid and clearly better than the naive plan. */
export function cacheSpecErrors(scenario: CacheScenario, reference: CachePlan): string[] {
  const errors = scenarioErrors(scenario);
  if (errors.length > 0) return errors;
  const planProblems = planErrors(scenario, reference);
  if (planProblems.length > 0) return planProblems.map((e) => `reference plan: ${e}`);
  const ref = simulate(scenario, reference).total;
  const naive = simulate(scenario, naivePlan(scenario)).total;
  if (naive < ref * NAIVE_MARGIN)
    errors.push(
      `The naive plan (listed order, one 5m breakpoint at the end) costs ${dollars(naive)}, within ${Math.round((NAIVE_MARGIN - 1) * 100)}% of your reference at ${dollars(ref)}. Make the scenario reward a real plan: a segment that changes, a long gap, a model's minimum.`,
    );
  return errors;
}

export function dollars(value: number): string {
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

/** A plan from JSON the learner pasted; throws with what is wrong with its shape. */
export function parsePlan(raw: unknown): CachePlan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("The plan must be a JSON object with order and breakpoints");
  const p = raw as Record<string, unknown>;
  if (!Array.isArray(p["order"]) || p["order"].some((o) => typeof o !== "string"))
    throw new Error("order must be a list of segment ids");
  if (!Array.isArray(p["breakpoints"])) throw new Error("breakpoints must be a list");
  return {
    order: p["order"] as string[],
    breakpoints: (p["breakpoints"] as unknown[]).map((bp, i) => {
      if (!bp || typeof bp !== "object") throw new Error(`breakpoints[${i}] must be an object`);
      const b = bp as Record<string, unknown>;
      return { after: String(b["after"] ?? ""), ttl: String(b["ttl"] ?? "") as Ttl };
    }),
  };
}
