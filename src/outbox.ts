/**
 * outbox.ts: candidate prompts for a host that can be woken (Pi).
 *
 * Claude Code has to listen for candidate events with `wait_for_candidate`. Pi's
 * extension can start a turn itself, so in that host every prompt is numbered,
 * published on the agent SSE channel, and kept here so a bridge that reconnects can
 * ask for what it missed with `GET /api/inbox?since=<seq>`. The extension delivers
 * each sequence number once.
 */

import { randomBytes } from "node:crypto";

import type { InboxEntry, InboxPage } from "./server/hooks.ts";

/** Prompts kept for replay. An interview produces a few dozen. */
export const OUTBOX_LIMIT = 200;

interface Held extends InboxEntry {
  pending?: (() => boolean) | undefined;
}

export class AgentOutbox {
  readonly stream = randomBytes(6).toString("hex");
  private readonly entries: Held[] = [];
  private readonly seen = new Set<string>();
  private readonly publish: (entry: InboxEntry) => void;
  private latest = 0;

  /** `publish` sends one entry to whoever is subscribed right now. */
  constructor(publish: (entry: InboxEntry) => void) {
    this.publish = publish;
  }

  /** Same contract as `CandidateInbox.push`: dedupe by key, skip a stale prompt. */
  push(prompt: string, key?: string, pending?: () => boolean, now = Date.now()): void {
    if (key && this.seen.has(key)) return;
    if (pending && !pending()) return;
    if (key) this.seen.add(key);
    this.latest += 1;
    const entry: Held = { stream: this.stream, seq: this.latest, at: now, prompt, pending };
    this.entries.push(entry);
    if (this.entries.length > OUTBOX_LIMIT) this.entries.shift();
    this.publish(publicEntry(entry));
  }

  /** Everything after `since` that still matters, oldest first. */
  since(since: number): InboxPage {
    return {
      stream: this.stream,
      latest: this.latest,
      entries: this.entries
        .filter((entry) => entry.seq > since && (!entry.pending || entry.pending()))
        .map(publicEntry),
    };
  }

  reset(): void {
    this.entries.length = 0;
    this.seen.clear();
  }
}

function publicEntry(entry: Held): InboxEntry {
  return { stream: entry.stream, seq: entry.seq, at: entry.at, prompt: entry.prompt };
}
