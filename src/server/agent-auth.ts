/**
 * agent-auth.ts: the token that separates the host bridge from the candidate's browser.
 *
 * The agent channel and `/api/inbox` carry the interviewer's prompts, and a submission
 * prompt quotes hidden cases. Both bind to loopback, but so does the candidate's page,
 * and anything it can fetch it can read. So the server mints a random token when it
 * starts and writes it only to server.json, which the Pi extension reads from disk; no
 * browser route ever returns it.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type * as http from "node:http";

let token: string | null = null;

/** Mint a fresh token. Called once per server start. */
export function issueAgentToken(): string {
  token = randomBytes(24).toString("base64url");
  return token;
}

export function revokeAgentToken(): void {
  token = null;
}

/** Whether the request carries the current token as `Authorization: Bearer <token>`. */
export function hasAgentToken(req: http.IncomingMessage): boolean {
  if (token === null) return false;
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
