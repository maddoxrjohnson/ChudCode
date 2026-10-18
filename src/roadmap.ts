/**
 * roadmap.ts: working through a public problem list in order, NeetCode 150 or Grind 75.
 *
 * A roadmap is a list of stages, each a group of seed titles: NeetCode's categories,
 * joined by its topic tree (data/roadmaps.json), or Grind 75's weeks, each requiring
 * the one before. A stage unlocks once half of every stage it requires is solved.
 *
 * Nothing is stored. Standing is derived on read from recorded sessions: a session
 * counts against an item when its problem was written as a mimic of that title
 * (`source.mimicOf`), whether the candidate got there through the roadmap or by asking
 * for "something like Two Sum". The candidate never sees the listed problem itself,
 * only an original one of the same shape.
 */

import * as path from "node:path";

import {
  matchSeedTitle,
  seedEntries,
  seedListName,
  titleKey,
  type SeedEntry,
  type SeedList,
} from "./seed.ts";
import { readJson } from "./store/json.ts";
import { dataDir } from "./store/paths.ts";
import { listProblems, type ProblemMeta } from "./store/problems.ts";
import { listSessions, type Session } from "./store/sessions.ts";

export type RoadmapId = SeedList;

export const ROADMAP_IDS: readonly RoadmapId[] = ["neetcode150", "grind75"];

/** Share of a required stage that must be solved before the stages after it unlock. */
export const UNLOCK_SHARE = 0.5;

export interface Stage {
  id: string;
  name: string;
  /** Stage ids that must be half solved first. */
  requires: string[];
  /** In the list's own order. */
  items: SeedEntry[];
}

export interface Roadmap {
  id: RoadmapId;
  name: string;
  stages: Stage[];
}

/** One recorded outcome against a seed title. */
export interface RoadmapAttempt {
  title: string;
  correct: boolean;
  at: number;
  session: string;
}

export type ItemState = "solved" | "missed" | "new";

export interface ItemStanding {
  title: string;
  difficulty: SeedEntry["difficulty"];
  patterns: string[];
  state: ItemState;
  attempts: number;
  lastAt: number | null;
  lastSession: string | null;
}

export interface StageStanding {
  id: string;
  name: string;
  requires: string[];
  unlocked: boolean;
  solved: number;
  total: number;
  /** Solved items needed in this stage before the stages that require it unlock. */
  unlockAt: number;
  items: ItemStanding[];
}

export interface RoadmapProgress {
  id: RoadmapId;
  name: string;
  stages: StageStanding[];
  solved: number;
  total: number;
  /** What to serve next, or null when every item is solved. */
  next: { stage: StageStanding; item: ItemStanding } | null;
}

interface StageSpec {
  id: string;
  category: string;
  requires: string[];
}

const cache = new Map<RoadmapId, Roadmap>();

export function isRoadmapId(value: unknown): value is RoadmapId {
  return ROADMAP_IDS.includes(value as RoadmapId);
}

/** A roadmap's stages and items, checked against the seed list it is built from. */
export function roadmap(id: RoadmapId): Roadmap {
  const cached = cache.get(id);
  if (cached) return cached;
  const entries = seedEntries()
    .filter((e) => e.lists.includes(id))
    .sort((a, b) => (a.positions[id] as number) - (b.positions[id] as number));
  const built: Roadmap = {
    id,
    name: seedListName(id),
    stages: id === "neetcode150" ? neetcodeStages(entries) : grindStages(entries),
  };
  cache.set(id, built);
  return built;
}

function neetcodeStages(entries: SeedEntry[]): Stage[] {
  const file = path.join(dataDir(), "roadmaps.json");
  const specs = readJson<{ neetcode150: StageSpec[] }>(file)?.neetcode150;
  if (!specs) throw new Error(`Missing the NeetCode 150 topic tree in ${file}`);
  const seen = new Set<string>();
  const stages = specs.map((spec) => {
    for (const required of spec.requires) {
      if (!seen.has(required))
        throw new Error(`Stage ${spec.id} requires ${required}, which is not listed before it`);
    }
    seen.add(spec.id);
    const items = entries.filter((e) => e.category === spec.category);
    if (items.length === 0) throw new Error(`Stage ${spec.id} matches no NeetCode category`);
    return { id: spec.id, name: spec.category, requires: [...spec.requires], items };
  });
  const covered = stages.reduce((n, stage) => n + stage.items.length, 0);
  if (covered !== entries.length)
    throw new Error(`The topic tree covers ${covered} of ${entries.length} NeetCode problems`);
  return stages;
}

function grindStages(entries: SeedEntry[]): Stage[] {
  const weeks = [...new Set(entries.map((e) => e.week as number))].sort((a, b) => a - b);
  return weeks.map((week, i) => ({
    id: `week-${week}`,
    name: `Week ${week}`,
    requires: i === 0 ? [] : [`week-${weeks[i - 1] as number}`],
    items: entries.filter((e) => e.week === week),
  }));
}

/** Solved items needed in a stage of this size before what requires it unlocks. */
export function unlockThreshold(total: number): number {
  return Math.ceil(total * UNLOCK_SHARE);
}

/** Every stage and item with its state, which stages are open, and what comes next. */
export function buildRoadmapProgress(
  map: Roadmap,
  attempts: readonly RoadmapAttempt[],
): RoadmapProgress {
  const byTitle = new Map<string, RoadmapAttempt[]>();
  for (const attempt of [...attempts].sort((a, b) => a.at - b.at)) {
    const key = titleKey(attempt.title);
    const list = byTitle.get(key);
    if (list) list.push(attempt);
    else byTitle.set(key, [attempt]);
  }

  const stages: StageStanding[] = [];
  const byId = new Map<string, StageStanding>();
  for (const stage of map.stages) {
    const items = stage.items.map((entry): ItemStanding => {
      const history = byTitle.get(titleKey(entry.title)) ?? [];
      const last = history[history.length - 1];
      return {
        title: entry.title,
        difficulty: entry.difficulty,
        patterns: [...entry.patterns],
        state: history.some((a) => a.correct) ? "solved" : history.length > 0 ? "missed" : "new",
        attempts: history.length,
        lastAt: last?.at ?? null,
        lastSession: last?.session ?? null,
      };
    });
    const standing: StageStanding = {
      id: stage.id,
      name: stage.name,
      requires: [...stage.requires],
      unlocked: stage.requires.every((id) => {
        const required = byId.get(id) as StageStanding;
        return required.solved >= required.unlockAt;
      }),
      solved: items.filter((item) => item.state === "solved").length,
      total: items.length,
      unlockAt: unlockThreshold(items.length),
      items,
    };
    stages.push(standing);
    byId.set(stage.id, standing);
  }

  return {
    id: map.id,
    name: map.name,
    stages,
    solved: stages.reduce((n, s) => n + s.solved, 0),
    total: stages.reduce((n, s) => n + s.total, 0),
    next: nextItem(stages),
  };
}

/**
 * The first item never tried in the earliest open stage that has one; failing that,
 * the first missed item in an open stage. With a stage given, only that stage counts.
 */
export function nextItem(
  stages: readonly StageStanding[],
  stageId?: string,
): { stage: StageStanding; item: ItemStanding } | null {
  const open = stages.filter((s) => s.unlocked && (stageId === undefined || s.id === stageId));
  for (const state of ["new", "missed"] as const) {
    for (const stage of open) {
      const item = stage.items.find((i) => i.state === state);
      if (item) return { stage, item };
    }
  }
  return null;
}

/**
 * The outcome of every finished session whose problem mimics a seed title. A session
 * abandoned for a reason other than "interrupted" counts as a miss, as it does in the
 * review schedule.
 */
export function roadmapAttempts(
  sessions: readonly Session[],
  problems: readonly ProblemMeta[],
): RoadmapAttempt[] {
  const mimicOf = new Map(problems.map((p) => [p.slug, p.source.mimicOf]));
  const attempts: RoadmapAttempt[] = [];
  for (const session of sessions) {
    const named = mimicOf.get(session.problem);
    if (!named) continue;
    const title = roadmapTitle(named);
    if (!title) continue;
    let correct: boolean;
    if (session.verdict) correct = session.verdict.correct;
    else if (session.abandonedReason !== undefined && session.abandonedReason !== "interrupted")
      correct = false;
    else continue;
    attempts.push({
      title,
      correct,
      at: session.endedAt ?? session.createdAt,
      session: session.id,
    });
  }
  return attempts;
}

/** The seed title a `mimic_of` value names: an exact title first, then a close match. */
export function roadmapTitle(named: string): string | undefined {
  const key = titleKey(named);
  return (
    seedEntries().find((e) => titleKey(e.title) === key)?.title ?? matchSeedTitle(named)?.title
  );
}

/** A roadmap's standing right now, from the sessions and problems on disk. */
export function loadRoadmapProgress(id: RoadmapId): RoadmapProgress {
  return buildRoadmapProgress(
    roadmap(id),
    roadmapAttempts(listSessions(Number.MAX_SAFE_INTEGER), listProblems()),
  );
}
