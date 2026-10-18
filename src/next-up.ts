/**
 * next-up.ts: the Next problem button on the dashboard and the debrief.
 *
 * Problems are written by the agent, so the button cannot serve one itself. A press
 * becomes a pending request: the page shows that it is waiting, the host is told (the
 * listening interviewer's next wait returns it; Pi's extension pushes it), and the
 * next roadmap session `start_session` creates answers it, which sends the waiting
 * pages to the new session. One request is pending at a time, and it lapses after a
 * while so a stale press never redirects a page much later.
 */

import {
  loadRoadmapProgress,
  preparedProblem,
  roadmapFor,
  roadmapTitle,
  type RoadmapId,
} from "./roadmap.ts";
import { emitNextRequest, type NextRequest } from "./server/hooks.ts";
import { DASHBOARD_CHANNEL, push, sessionChannel } from "./server/sse.ts";
import { listProblems, readProblem, type Difficulty, type ProblemMeta } from "./store/problems.ts";
import { listSessions, readEvents, type Session } from "./store/sessions.ts";

/** How long a press waits for the interviewer before it is dropped. */
export const NEXT_REQUEST_TTL_MS = 15 * 60_000;

/**
 * How long the listening interviewer stays after a roadmap debrief for a press of
 * Next problem before it ends its turn.
 */
export const NEXT_WINDOW_MS = 10 * 60_000;

/** The stretch after a roadmap debrief while the interviewer keeps listening. */
export interface NextWindow {
  roadmap: RoadmapId;
  name: string;
  leftMs: number;
}

/** What the button offers: the next step on one roadmap. */
export interface NextUp {
  roadmap: RoadmapId;
  name: string;
  title: string;
  difficulty: Difficulty;
  stage: string;
  solved: number;
  total: number;
  /** The slug of a problem already written for this step, if there is one. */
  prepared: string | null;
}

let pending: NextRequest | null = null;

/** The next step on a roadmap, or null when every problem on it is solved. */
export function nextUp(
  roadmap: RoadmapId,
  problems: readonly ProblemMeta[] = listProblems(),
): NextUp | null {
  const progress = loadRoadmapProgress(roadmap);
  if (!progress.next) return null;
  const { stage, item } = progress.next;
  return {
    roadmap,
    name: progress.name,
    title: item.title,
    difficulty: item.difficulty,
    stage: stage.name,
    solved: progress.solved,
    total: progress.total,
    prepared: preparedProblem(item.title, problems)?.slug ?? null,
  };
}

/** The list a roadmap session works through: the one it was started with, else its title's. */
export function sessionRoadmap(session: Session): RoadmapId | undefined {
  if (session.mode !== "roadmap") return undefined;
  if (session.roadmap) return session.roadmap;
  try {
    const mimicOf = readProblem(session.problem).meta.source.mimicOf;
    const title = mimicOf === undefined ? undefined : roadmapTitle(mimicOf);
    return title === undefined ? undefined : roadmapFor(title);
  } catch {
    return undefined;
  }
}

/**
 * The listening window after the latest session, when that session is a roadmap
 * session scored less than `NEXT_WINDOW_MS` ago. Null once it closes.
 */
export function nextWindow(sessions = listSessions(1), now = Date.now()): NextWindow | null {
  const latest = sessions[0];
  if (!latest || latest.phase !== "done" || !latest.rubric) return null;
  const roadmap = sessionRoadmap(latest);
  if (!roadmap) return null;
  const scored = readEvents(latest.id)
    .filter((e) => e.type === "rubric")
    .pop()?.at;
  if (scored === undefined) return null;
  const leftMs = scored + NEXT_WINDOW_MS - now;
  if (leftMs <= 0) return null;
  return { roadmap, name: loadRoadmapProgress(roadmap).name, leftMs };
}

/** The press still waiting for a session, if any. */
export function pendingNext(now = Date.now()): NextRequest | null {
  if (pending && now - pending.at > NEXT_REQUEST_TTL_MS) pending = null;
  return pending;
}

/**
 * Record a press and tell the host. Pressing again while a request for the same
 * roadmap is pending changes nothing; a press for the other roadmap replaces it.
 */
export function requestNext(roadmap: RoadmapId, from?: string, now = Date.now()): NextRequest {
  const current = pendingNext(now);
  if (current && current.roadmap === roadmap) return current;
  const request: NextRequest = { roadmap, at: now, ...(from ? { from } : {}) };
  pending = request;
  for (const channel of channelsFor(request)) push(channel, "next", { pending: request });
  emitNextRequest(request);
  return request;
}

/** A roadmap session was created: send every page waiting on the press to it. */
export function resolveNext(session: Session, now = Date.now()): void {
  const request = pendingNext(now);
  if (!request || session.mode !== "roadmap") return;
  pending = null;
  const payload = { sessionId: session.id, url: `/s/${session.id}` };
  for (const channel of channelsFor(request)) push(channel, "next_session", payload);
}

/** Forget any pending press (tests, shutdown). */
export function clearNext(): void {
  pending = null;
}

function channelsFor(request: NextRequest): string[] {
  return [DASHBOARD_CHANNEL, ...(request.from ? [sessionChannel(request.from)] : [])];
}
