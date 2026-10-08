/**
 * http.ts: response helpers, body parsing, and path splitting for the local server.
 */

import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const NO_STORE = { "Cache-Control": "no-store" };

export function sendHtml(res: http.ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...NO_STORE });
  res.end(html);
}

export function sendJson(res: http.ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...NO_STORE });
  res.end(JSON.stringify(value));
}

export function sendText(res: http.ServerResponse, text: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE });
  res.end(text);
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function sendFile(res: http.ServerResponse, file: string): void {
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch {
    throw new HttpError(404, `File not found: ${path.basename(file)}`);
  }
  // Static assets change only when the package is upgraded; a short cache keeps the
  // editor bundle from reloading on every page view without sticking across upgrades.
  res.writeHead(200, { "Content-Type": contentTypeFor(file), "Cache-Control": "max-age=300" });
  res.end(body);
}

/**
 * Read and parse a JSON body, rejecting anything above `limit` bytes.
 *
 * On overflow the rest of the upload is drained rather than the socket destroyed, so
 * the client receives a 413 instead of a connection reset.
 */
export function readJsonBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, `Request body exceeds ${limit} bytes`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        chunks.length = 0;
        reject(new HttpError(413, `Request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (exceeded) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "Request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Decoded, non-empty path segments, or null when a segment is malformed. */
export function splitPath(pathname: string): string[] | null {
  const segments: string[] = [];
  for (const raw of pathname.split("/")) {
    if (raw === "") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\0"))
      return null;
    segments.push(segment);
  }
  return segments;
}

export function expectString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new HttpError(400, `${label} must be a string`);
  if (value.length > maxLength)
    throw new HttpError(413, `${label} exceeds ${maxLength} characters`);
  return value;
}
