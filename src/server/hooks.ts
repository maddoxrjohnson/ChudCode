/**
 * hooks.ts: how the server tells the host about candidate activity.
 *
 * The MCP layer registers a hook and turns these into prompts for the waiting agent.
 * With no hook registered (tests, the solo dev server) events are simply dropped.
 */

import type { RoadmapId } from "../roadmap.ts";
import type { RunResult, RunStatus } from "../runner/types.ts";

export type CandidateEvent = { sessionId: string; at: number } & (
  | { kind: "started" }
  /** A Run-button execution. Informational: it never wakes a waiting interviewer. */
  | { kind: "run"; scope: "visible" | "custom"; status: RunStatus; passed: number; total: number }
  | { kind: "note"; text: string }
  | { kind: "message"; text: string }
  | { kind: "hint_used"; level: number }
  | { kind: "submission"; number: number; result: RunResult }
  | { kind: "timer_expired" }
  | { kind: "candidate_done" }
);

/** The candidate pressed Next problem: serve the next step on this roadmap. */
export interface NextRequest {
  roadmap: RoadmapId;
  /** The session page the press came from, if it was not the dashboard. */
  from?: string;
  at: number;
}

/** One prompt the host bridge has been sent, as `GET /api/inbox` returns it. */
export interface InboxEntry {
  /** Random per server process, so a bridge can tell a restarted server from a gap. */
  stream: string;
  /** 1, 2, 3, ... within a stream. */
  seq: number;
  at: number;
  prompt: string;
}

export interface InboxPage {
  stream: string;
  /** The highest seq issued so far, whether or not it is in `entries`. */
  latest: number;
  entries: InboxEntry[];
}

export interface ServerHooks {
  onCandidateEvent?(event: CandidateEvent): void;
  /** The candidate asked for the next roadmap problem from the page. */
  onNextRequested?(request: NextRequest): void;
  /** Prompts after `since` for the host bridge. Only push-delivery hosts register it. */
  agentInbox?(since: number): InboxPage;
  /** Whether an agent is currently waiting for candidate events. */
  isListening?(): boolean;
  /**
   * Whether an agent is around to answer the page: waiting now, or busy with other
   * tools a moment ago (writing a problem, say). False once it has been told to stop.
   */
  isConnected?(): boolean;
}

let hooks: ServerHooks = {};

export function setHooks(next: ServerHooks): void {
  hooks = next;
}

export function emitCandidateEvent(event: CandidateEvent): void {
  hooks.onCandidateEvent?.(event);
}

export function emitNextRequest(request: NextRequest): void {
  hooks.onNextRequested?.(request);
}

export function agentInbox(since: number): InboxPage | null {
  return hooks.agentInbox?.(since) ?? null;
}

export function agentListening(): boolean {
  return hooks.isListening?.() ?? false;
}

export function agentConnected(): boolean {
  return hooks.isConnected?.() ?? agentListening();
}
