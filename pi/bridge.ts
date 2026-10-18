/**
 * bridge.ts: carries candidate events from the ChudCode server into a Pi session.
 *
 * In Pi the MCP server runs as a child of the MCP adapter and this extension runs in
 * Pi itself, so the two meet over loopback HTTP. The bridge finds the server through
 * server.json, subscribes to the agent SSE channel with the token from that file, and
 * turns each `candidate` event into a user message. A message that lands while the
 * agent is mid-turn is queued as a follow-up rather than interrupting it.
 *
 * Every event carries a stream id and a sequence number. The bridge delivers each
 * number once, in order: after a reconnect, or when it sees a gap, it asks
 * `GET /api/inbox?since=<last>` for what it missed. A new stream id means a new server
 * process, and everything it has queued is new.
 *
 * A `session` event names a session `start_session` just opened. The bridge passes its
 * link to the status line, so the candidate always has it, whatever the agent says.
 *
 * The wake-up shape follows pi-teach's src/bridge.ts (Josh Noll, MIT); see
 * docs/ATTRIBUTION.md. Its reply-from-final-text fallback is not needed here: an
 * interviewer only reaches the page through `say_to_candidate`.
 */

import * as fs from "node:fs";

import type { InboxEntry, InboxPage } from "../src/server/hooks.ts";
import { serverFile } from "../src/store/paths.ts";

/** The slice of the Pi API the bridge needs, so tests can pass a stub. */
export interface MessageSender {
  sendUserMessage(text: string, options?: { deliverAs?: string }): void;
}

export interface ServerInfo {
  port: number;
  agentToken: string;
}

/** The session `start_session` opened last, shown under the editor with its link. */
export interface OpenSession {
  sessionId: string;
  title: string;
  url: string;
}

export type BridgeStatus =
  { connected: false } | { connected: true; port: number; session?: OpenSession };

export interface BridgeOptions {
  /** Where to find the server. Defaults to reading server.json. */
  readServer?: () => ServerInfo | null;
  /** How long to wait before looking for the server again. */
  retryMs?: number;
  onStatus?: (status: BridgeStatus) => void;
}

export const DEFAULT_RETRY_MS = 2_000;

export class InterviewBridge {
  private readonly pi: MessageSender;
  private readonly readServer: () => ServerInfo | null;
  private readonly retryMs: number;
  private readonly onStatus: (status: BridgeStatus) => void;
  private idle: () => boolean = () => true;
  private stream: string | null = null;
  private lastSeq = 0;
  private running = false;
  private controller: AbortController | null = null;
  private retry: { timer: NodeJS.Timeout; resolve(): void } | null = null;
  private loop: Promise<void> | null = null;

  constructor(pi: MessageSender, options: BridgeOptions = {}) {
    this.pi = pi;
    this.readServer = options.readServer ?? readServerFile;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.onStatus = options.onStatus ?? (() => {});
  }

  /** Whether the agent is between turns. Pi hands this out on the session context. */
  setIdleProbe(probe: () => boolean): void {
    this.idle = probe;
  }

  /** Start looking for the server and keep a subscription open until `stop()`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Look for the server now instead of at the next retry, e.g. after a tool started it. */
  poke(): void {
    this.retry?.resolve();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    this.poke();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (this.running) {
      const info = this.readServer();
      if (info) {
        try {
          await this.subscribe(info);
        } catch {
          /* the server went away or refused us; look again after a pause */
        }
        this.onStatus({ connected: false });
      }
      if (this.running) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.retry = null;
        resolve();
      };
      const timer = setTimeout(done, this.retryMs);
      this.retry = { timer, resolve: done };
    });
  }

  private async subscribe(info: ServerInfo): Promise<void> {
    const base = `http://127.0.0.1:${info.port}`;
    const headers = { Authorization: `Bearer ${info.agentToken}` };
    this.controller = new AbortController();
    const res = await fetch(`${base}/api/events?scope=agent`, {
      headers,
      signal: this.controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`agent channel: HTTP ${res.status}`);
    this.onStatus({ connected: true, port: info.port });

    const catchUp = () => this.catchUp(base, headers);
    await catchUp();
    for await (const frame of sseFrames(res.body)) {
      if (frame.type === "session") {
        const session = asOpenSession(frame.data);
        if (session) this.onStatus({ connected: true, port: info.port, session });
        continue;
      }
      if (frame.type !== "candidate") continue;
      const entry = frame.data as InboxEntry;
      if (entry.stream === this.stream && entry.seq === this.lastSeq + 1) this.deliver(entry);
      else if (entry.stream !== this.stream || entry.seq > this.lastSeq) await catchUp();
    }
  }

  private async catchUp(base: string, headers: Record<string, string>): Promise<void> {
    let page = await fetchInbox(base, headers, this.lastSeq);
    if (page.stream !== this.stream) {
      this.stream = page.stream;
      if (this.lastSeq > 0) page = await fetchInbox(base, headers, 0);
      this.lastSeq = 0;
    }
    for (const entry of page.entries) if (entry.seq > this.lastSeq) this.deliver(entry);
    // Entries dropped as stale still advance the cursor.
    this.lastSeq = Math.max(this.lastSeq, page.latest);
  }

  private deliver(entry: InboxEntry): void {
    this.lastSeq = entry.seq;
    this.pi.sendUserMessage(entry.prompt, this.idle() ? undefined : { deliverAs: "followUp" });
  }
}

async function fetchInbox(
  base: string,
  headers: Record<string, string>,
  since: number,
): Promise<InboxPage> {
  const res = await fetch(`${base}/api/inbox?since=${since}`, { headers });
  if (!res.ok) throw new Error(`inbox: HTTP ${res.status}`);
  return (await res.json()) as InboxPage;
}

/** server.json, when it names a port and a token. A missing or partial file is null. */
export function readServerFile(file = serverFile()): ServerInfo | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ServerInfo>;
    if (typeof value.port !== "number" || typeof value.agentToken !== "string") return null;
    return { port: value.port, agentToken: value.agentToken };
  } catch {
    return null;
  }
}

function asOpenSession(value: unknown): OpenSession | null {
  const v = value as Partial<OpenSession> | null;
  if (!v || typeof v.sessionId !== "string" || typeof v.title !== "string") return null;
  if (typeof v.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\//.test(v.url)) return null;
  return { sessionId: v.sessionId, title: v.title, url: v.url };
}

export interface SseFrame {
  type: string;
  data: unknown;
}

/** Parse a `text/event-stream` body into frames. Comments and empty frames are skipped. */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let type = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) type = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      if (data.length === 0) continue;
      try {
        yield { type, data: JSON.parse(data.join("\n")) };
      } catch {
        /* not ours */
      }
    }
  }
}
