/**
 * sse.ts: Server-Sent Events channels.
 *
 * A browser subscribes to its session's channel and receives everything that
 * changes it: interviewer messages, hints, run results, phase changes. The agent
 * channel (Pi host) and the dashboard channel share the same registry.
 */

import type * as http from "node:http";

const KEEPALIVE_MS = 25_000;

interface Client {
  res: http.ServerResponse;
  keepalive: NodeJS.Timeout;
}

const channels = new Map<string, Set<Client>>();

let onSubscribers: ((channel: string, count: number) => void) | null = null;

/** Called whenever a channel gains or loses a subscriber. */
export function setSubscriberListener(
  listener: ((channel: string, count: number) => void) | null,
): void {
  onSubscribers = listener;
}

function notifySubscribers(channel: string): void {
  onSubscribers?.(channel, subscriberCount(channel));
}

export function sessionChannel(sessionId: string): string {
  return `session:${sessionId}`;
}

export const DASHBOARD_CHANNEL = "dashboard";
export const AGENT_CHANNEL = "agent";

export function subscribe(
  channel: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  const client: Client = {
    res,
    keepalive: setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        remove(channel, client);
      }
    }, KEEPALIVE_MS),
  };
  let set = channels.get(channel);
  if (!set) {
    set = new Set();
    channels.set(channel, set);
  }
  set.add(client);
  req.on("close", () => remove(channel, client));
  notifySubscribers(channel);
}

function remove(channel: string, client: Client): void {
  clearInterval(client.keepalive);
  const set = channels.get(channel);
  if (!set?.delete(client)) return;
  if (set.size === 0) channels.delete(channel);
  notifySubscribers(channel);
}

/** Send one event to every subscriber of `channel`; returns how many received it. */
export function push(channel: string, type: string, payload: unknown): number {
  const set = channels.get(channel);
  if (!set) return 0;
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  let delivered = 0;
  for (const client of [...set]) {
    try {
      client.res.write(frame);
      delivered += 1;
    } catch {
      remove(channel, client);
    }
  }
  return delivered;
}

export function subscriberCount(channel: string): number {
  return channels.get(channel)?.size ?? 0;
}

/** End every stream. An open event stream otherwise keeps `server.close()` pending. */
export function closeAll(): void {
  for (const [channel, set] of channels) {
    for (const client of set) {
      clearInterval(client.keepalive);
      try {
        client.res.end();
      } catch {
        /* already gone */
      }
    }
    channels.delete(channel);
  }
}
