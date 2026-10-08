/**
 * server.ts: the loopback HTTP server, one per process, started on demand.
 *
 * It binds 127.0.0.1 only. The port comes from config (0 means ephemeral) and is
 * written to ~/.chudcode/server.json so other processes can find a running server.
 */

import * as fs from "node:fs";
import * as http from "node:http";

import { FlowError } from "../flow.ts";
import { InvalidCustomInput } from "../runs.ts";
import { readConfig } from "../store/config.ts";
import { writeJson } from "../store/json.ts";
import { serverFile } from "../store/paths.ts";
import { ProblemValidationError } from "../store/problems.ts";
import { HttpError, sendHtml, sendJson, splitPath } from "./http.ts";
import { errorPage, notFoundPage } from "./pages/layout.ts";
import { handleApi } from "./routes-api.ts";
import { handlePage } from "./routes-pages.ts";
import { closeAll } from "./sse.ts";

let server: http.Server | null = null;
let serverPort: number | null = null;
let starting: Promise<string> | null = null;

export interface StartOptions {
  /** Overrides the configured port. */
  port?: number;
}

export async function start(options: StartOptions = {}): Promise<string> {
  if (server && serverPort) return `http://127.0.0.1:${serverPort}`;
  if (starting) return starting;

  const preferredPort = options.port ?? readConfig().port;
  starting = new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      void handleRequest(req, res);
    });
    s.on("error", (err: NodeJS.ErrnoException) => {
      reject(
        new Error(`Cannot start the ChudCode server on port ${preferredPort}: ${err.message}`, {
          cause: err,
        }),
      );
    });
    s.listen(preferredPort, "127.0.0.1", () => {
      const address = s.address();
      if (!address || typeof address === "string") {
        s.close();
        reject(new Error("Could not determine the server port"));
        return;
      }
      server = s;
      serverPort = address.port;
      try {
        writeJson(serverFile(), { port: serverPort, pid: process.pid, startedAt: Date.now() });
      } catch {
        /* a missing state dir is not fatal for serving */
      }
      resolve(`http://127.0.0.1:${serverPort}`);
    });
  });
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export async function close(): Promise<void> {
  if (starting) await starting;
  const s = server;
  if (!s) return;
  server = null;
  serverPort = null;
  closeAll();
  await new Promise<void>((resolve) => s.close(() => resolve()));
  try {
    fs.rmSync(serverFile(), { force: true });
  } catch {
    /* ignore */
  }
}

export function isRunning(): boolean {
  return server !== null;
}

export function getBaseUrl(): string | null {
  return server && serverPort ? `http://127.0.0.1:${serverPort}` : null;
}

export function urlForSession(id: string): string | null {
  const base = getBaseUrl();
  return base ? `${base}/s/${encodeURIComponent(id)}` : null;
}

export function urlForProblem(slug: string): string | null {
  const base = getBaseUrl();
  return base ? `${base}/p/${encodeURIComponent(slug)}` : null;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const wantsJson = url.pathname.startsWith("/api/");
  try {
    const segments = splitPath(url.pathname);
    if (!segments) throw new HttpError(400, "Malformed path");
    if (segments[0] === "api") await handleApi(req, res, segments, url);
    else handlePage(req, res, segments);
  } catch (err) {
    sendError(res, err, wantsJson);
  }
}

function sendError(res: http.ServerResponse, err: unknown, wantsJson: boolean): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = statusOf(err);
  const message = err instanceof Error ? err.message : String(err);
  if (status >= 500) console.error("[chudcode] request failed:", err);
  // The client may still be uploading; closing after the reply stops it cleanly.
  if (status === 413) res.setHeader("Connection", "close");
  if (wantsJson) return sendJson(res, { error: message }, status);
  if (status === 404) return sendHtml(res, notFoundPage(message), 404);
  return sendHtml(res, errorPage(message), status);
}

function statusOf(err: unknown): number {
  if (err instanceof HttpError || err instanceof FlowError) return err.status;
  if (err instanceof ProblemValidationError || err instanceof InvalidCustomInput) return 400;
  return 500;
}
