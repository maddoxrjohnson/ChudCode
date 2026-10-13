/**
 * routes-pages.ts: HTML pages and static assets.
 */

import type * as http from "node:http";

import { sessionState } from "../flow.ts";
import { loadProgress } from "../progress.ts";
import { readConfig } from "../store/config.ts";
import { assetsDir, isValidSessionId, isValidSlug, safeJoin } from "../store/paths.ts";
import { listProblems, problemExists, publicView, readProblem } from "../store/problems.ts";
import { listSessions, sessionExists } from "../store/sessions.ts";
import { agentListening } from "./hooks.ts";
import { HttpError, sendFile, sendHtml } from "./http.ts";
import { dashboardPage } from "./pages/dashboard.ts";
import { problemPage } from "./pages/problem.ts";
import { sessionPage } from "./pages/session.ts";

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f6feb"/><path d="M11 10l-5 6 5 6M21 10l5 6-5 6M18 8l-4 16" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function handlePage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  segments: string[],
): void {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");

  if (segments.length === 0) {
    return sendHtml(
      res,
      dashboardPage({
        sessions: listSessions(20),
        problems: listProblems(),
        progress: loadProgress(),
      }),
    );
  }

  const [head, ...rest] = segments;
  if (head === "favicon.ico") {
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" });
    return void res.end(FAVICON);
  }

  if (head === "static") {
    const file = safeJoin(assetsDir(), rest.join("/"));
    if (!file || rest.length === 0) throw new HttpError(404, "No such asset");
    return sendFile(res, file);
  }

  if (head === "s" && rest.length === 1) {
    const [id] = rest;
    if (!isValidSessionId(id) || !sessionExists(id)) throw new HttpError(404, "No such session");
    const config = readConfig();
    return sendHtml(
      res,
      sessionPage(sessionState(id, agentListening()), { autocomplete: config.editor.autocomplete }),
    );
  }

  if (head === "p" && rest.length === 1) {
    const [slug] = rest;
    if (!isValidSlug(slug) || !problemExists(slug)) throw new HttpError(404, "No such problem");
    return sendHtml(res, problemPage(publicView(readProblem(slug), 0)));
  }

  throw new HttpError(404, "No such page");
}
