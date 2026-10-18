/**
 * routes-api.ts: the JSON API the browser runtime talks to.
 *
 *   GET  /api/events?session=<id>           SSE for one session
 *   GET  /api/events?scope=dashboard        SSE for the dashboard
 *   GET  /api/events?scope=agent            SSE for the host bridge (agent token)
 *   GET  /api/inbox?since=<seq>             prompts the bridge missed (agent token)
 *   GET  /api/sessions/<id>                 full candidate-safe state
 *   PUT  /api/sessions/<id>/draft           { code }
 *   POST /api/sessions/<id>/start
 *   POST /api/sessions/<id>/note            { text }
 *   POST /api/sessions/<id>/message         { text }
 *   POST /api/sessions/<id>/run             { code, custom?: [{...args}] }
 *   POST /api/sessions/<id>/submit          { code }
 *   POST /api/sessions/<id>/hint
 *   POST /api/sessions/<id>/timeout
 *   POST /api/sessions/<id>/done
 *   GET  /api/problems/<slug>               public view
 *   GET  /api/dashboard
 *   POST /api/roadmaps/<id>/next            { from?: session id }  the Next problem button
 */

import type * as http from "node:http";

import * as flow from "../flow.ts";
import { loadProgress } from "../progress.ts";
import { nextUp, requestNext } from "../next-up.ts";
import { isRoadmapId, loadRoadmapProgress, ROADMAP_IDS } from "../roadmap.ts";
import { readConfig } from "../store/config.ts";
import { isValidSessionId, isValidSlug } from "../store/paths.ts";
import { listProblems, problemExists, publicView, readProblem } from "../store/problems.ts";
import { listSessions, sessionExists, writeDraft } from "../store/sessions.ts";
import { hasAgentToken } from "./agent-auth.ts";
import { agentConnected, agentInbox, agentListening } from "./hooks.ts";
import { HttpError, expectString, readJsonBody, sendJson } from "./http.ts";
import { AGENT_CHANNEL, DASHBOARD_CHANNEL, sessionChannel, subscribe } from "./sse.ts";

export const MAX_CODE_BYTES = 200 * 1024;
export const MAX_TEXT_CHARS = 8 * 1024;

export async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  segments: string[],
  url: URL,
): Promise<void> {
  const [, resource, id, action] = segments;

  if (resource === "health" && req.method === "GET") return sendJson(res, { ok: true });

  if (resource === "events" && req.method === "GET") return handleEvents(req, res, url);

  if (resource === "inbox" && id === undefined && req.method === "GET") {
    requireAgent(req);
    const page = agentInbox(sinceParam(url));
    if (!page) throw new HttpError(404, "This host listens for events; it has no inbox");
    return sendJson(res, page);
  }

  if (resource === "dashboard" && req.method === "GET") {
    return sendJson(res, {
      sessions: listSessions(20),
      problems: listProblems(),
      progress: loadProgress(),
      roadmaps: ROADMAP_IDS.map(loadRoadmapProgress),
    });
  }

  if (resource === "roadmaps" && action === "next" && req.method === "POST") {
    if (!isRoadmapId(id)) throw new HttpError(404, "No such roadmap");
    const body = asRecord(await readJsonBody(req, 1024));
    const from = body["from"];
    if (from !== undefined && (typeof from !== "string" || !sessionExists(from)))
      throw new HttpError(400, "from must be a session id");
    const next = nextUp(id);
    if (!next) throw new HttpError(409, "Every problem on this roadmap is solved");
    return sendJson(res, { request: requestNext(id, from), next, connected: agentConnected() });
  }

  if (resource === "problems" && id !== undefined && action === undefined && req.method === "GET") {
    if (!isValidSlug(id) || !problemExists(id)) throw new HttpError(404, "No such problem");
    return sendJson(res, publicView(readProblem(id), 0));
  }

  if (resource === "sessions" && id !== undefined) {
    if (!isValidSessionId(id) || !sessionExists(id)) throw new HttpError(404, "No such session");
    if (action === undefined && req.method === "GET")
      return sendJson(res, flow.sessionState(id, agentListening()));
    if (action !== undefined) return handleSessionAction(req, res, id, action);
  }

  throw new HttpError(404, "No such API route");
}

function handleEvents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const session = url.searchParams.get("session");
  const scope = url.searchParams.get("scope");
  if (session !== null) {
    if (!isValidSessionId(session) || !sessionExists(session))
      throw new HttpError(404, "No such session");
    return subscribe(sessionChannel(session), req, res);
  }
  if (scope === DASHBOARD_CHANNEL) return subscribe(scope, req, res);
  if (scope === AGENT_CHANNEL) {
    requireAgent(req);
    return subscribe(scope, req, res);
  }
  throw new HttpError(400, "Pass ?session=<id> or ?scope=dashboard|agent");
}

async function handleSessionAction(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  action: string,
): Promise<void> {
  const method = req.method ?? "GET";

  if (action === "draft" && method === "PUT") {
    const body = asRecord(await readJsonBody(req, MAX_CODE_BYTES + 1024));
    writeDraft(id, expectString(body["code"], "code", MAX_CODE_BYTES));
    return sendJson(res, { ok: true });
  }

  if (method !== "POST") throw new HttpError(405, "Method not allowed");

  switch (action) {
    case "start":
      return sendJson(res, { session: flow.startSession(id) });
    case "note": {
      const body = asRecord(await readJsonBody(req, MAX_TEXT_CHARS * 4));
      return sendJson(res, {
        session: flow.postApproachNote(id, expectString(body["text"], "text", MAX_TEXT_CHARS)),
      });
    }
    case "message": {
      const body = asRecord(await readJsonBody(req, MAX_TEXT_CHARS * 4));
      return sendJson(res, {
        message: flow.postMessage(
          id,
          "candidate",
          expectString(body["text"], "text", MAX_TEXT_CHARS),
        ),
      });
    }
    case "run": {
      const body = asRecord(await readJsonBody(req, MAX_CODE_BYTES + 64 * 1024));
      const code = expectString(body["code"], "code", MAX_CODE_BYTES);
      const custom = body["custom"];
      if (custom !== undefined && !Array.isArray(custom))
        throw new HttpError(400, "custom must be a list of argument objects");
      writeDraft(id, code);
      const config = readConfig();
      return sendJson(
        res,
        await flow.runVisible(
          id,
          code,
          custom as Array<Record<string, unknown>> | undefined,
          config,
        ),
      );
    }
    case "submit": {
      const body = asRecord(await readJsonBody(req, MAX_CODE_BYTES + 1024));
      const code = expectString(body["code"], "code", MAX_CODE_BYTES);
      writeDraft(id, code);
      return sendJson(res, await flow.submitCode(id, code, readConfig()));
    }
    case "hint":
      return sendJson(res, flow.revealHint(id));
    case "timeout":
      return sendJson(res, { session: flow.timerExpired(id) });
    case "done":
      return sendJson(res, { session: flow.candidateDone(id) });
    default:
      throw new HttpError(404, "No such session action");
  }
}

function requireAgent(req: http.IncomingMessage): void {
  if (!hasAgentToken(req))
    throw new HttpError(401, "The agent channel needs the token in server.json");
}

function sinceParam(url: URL): number {
  const raw = url.searchParams.get("since") ?? "0";
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, "since must be a non-negative integer");
  return Number(raw);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Body must be a JSON object");
  return value as Record<string, unknown>;
}
