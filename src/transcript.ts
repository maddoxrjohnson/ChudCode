/**
 * transcript.ts: read one of the learner's own Claude Code session logs, as evidence.
 *
 * Claude Code keeps each session as JSON lines under ~/.claude/projects/<project>/.
 * A transcript lesson asks the learner to pick one of their recent sessions on the
 * page and consent; nothing is listed or read before they ask. The format is
 * Claude Code's own and not a published contract, so every field is read
 * defensively and a line that does not parse is skipped:
 *
 *   - assistant lines carry `message.model`, `message.id`, and `message.usage`
 *     (input, cache-creation with its 5m and 1h split, cache-read, output tokens);
 *     one message can span several lines, so usage is counted once per message id;
 *   - user lines carry the prompt as `message.content` (a string; tool results are
 *     lists and are not prompts);
 *   - a `system` line with subtype `compact_boundary` marks a compaction.
 *
 * What goes to the interviewer is a summary: request and token counts, models and
 * switches, gaps long enough to let a five-minute cache expire, compactions, a cost
 * estimate from the cache model where the model is priced there, and the learner's
 * first prompts, clipped and redacted. Never the assistant's replies or tool output.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadCacheModel } from "./drill/cache-sim.ts";
import { redactSecrets } from "./lab.ts";

export const TRANSCRIPT_LIMITS = {
  list: 20,
  readBytes: 32 * 1024 * 1024,
  prompts: 15,
  promptChars: 400,
};

/** Where Claude Code keeps session logs. CHUDCODE_CLAUDE_PROJECTS moves it (tests). */
export function claudeProjectsDir(): string {
  return process.env["CHUDCODE_CLAUDE_PROJECTS"] ?? path.join(os.homedir(), ".claude", "projects");
}

export interface TranscriptEntry {
  /** A stable token for the file, so the page never sends a path. */
  id: string;
  project: string;
  modifiedAt: number;
  bytes: number;
  /** The first prompt, clipped, so the learner can tell sessions apart. */
  firstPrompt: string;
}

function fileId(relative: string): string {
  return createHash("sha256").update(relative).digest("hex").slice(0, 16);
}

/** The most recent session logs, newest first. Only regular files, never through a link. */
export function listTranscripts(limit = TRANSCRIPT_LIMITS.list): TranscriptEntry[] {
  const root = claudeProjectsDir();
  const found: Array<{ relative: string; full: string; stat: fs.Stats; project: string }> = [];
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(path.join(root, project.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const full = path.join(root, project.name, file.name);
      found.push({
        relative: `${project.name}/${file.name}`,
        full,
        stat: fs.statSync(full),
        project: project.name,
      });
    }
  }
  return found
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, limit)
    .map((f) => ({
      id: fileId(f.relative),
      project: f.project,
      modifiedAt: Math.round(f.stat.mtimeMs),
      bytes: f.stat.size,
      firstPrompt: firstPrompt(f.full),
    }));
}

/** The full path of a listed transcript, or null when the id names none. */
export function transcriptPath(id: string): string | null {
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  const root = claudeProjectsDir();
  for (const project of safeReaddir(root)) {
    for (const name of safeReaddir(path.join(root, project))) {
      if (name.endsWith(".jsonl") && fileId(`${project}/${name}`) === id) {
        const full = path.join(root, project, name);
        return fs.lstatSync(full).isFile() ? full : null;
      }
    }
  }
  return null;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function firstPrompt(file: string): string {
  const head = readHead(file, 256 * 1024);
  let command = "";
  for (const line of head.split("\n")) {
    const prompt = promptOf(parse(line));
    if (!prompt) continue;
    // A slash command is markup; the first typed prompt tells sessions apart better.
    const name = /<command-name>(\/[^<\s]+)<\/command-name>/.exec(prompt)?.[1];
    if (name) command ||= name;
    else return clip(redactSecrets(prompt).text, 120);
  }
  return command;
}

function readHead(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function parse(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A user line's typed prompt, or null for tool results, meta lines, and summaries. */
function promptOf(line: Record<string, unknown> | null): string | null {
  if (!line || line["type"] !== "user" || line["isMeta"] || line["isCompactSummary"]) return null;
  const content = record(line["message"])["content"];
  if (typeof content !== "string") return null;
  const text = content.trim();
  return text ? text : null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── The audit ─────────────────────────────────────────────────────────────────

export interface TranscriptAudit {
  project: string;
  lines: number;
  skipped: number;
  truncated: boolean;
  firstAt: string | null;
  lastAt: string | null;
  requests: number;
  models: Array<{ model: string; requests: number }>;
  /** Times the model changed from one request to the next. */
  modelSwitches: number;
  efforts: string[];
  tokens: {
    input: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheRead: number;
    output: number;
  };
  /** Cache reads over all input-side tokens. */
  cacheHitRatio: number;
  /** Requests that came more than five minutes after the one before. */
  longGaps: number;
  compactions: number;
  /** Slash commands the learner typed, by name. */
  commands: Record<string, number>;
  /** Input-side cost in dollars, for requests on models the cache model prices. */
  estimatedInputCost: number | null;
  prompts: string[];
}

export function auditTranscript(file: string, project: string): TranscriptAudit {
  const size = fs.statSync(file).size;
  const text = readHead(file, TRANSCRIPT_LIMITS.readBytes);
  const usageById = new Map<
    string,
    { model: string; usage: Record<string, unknown>; at: number }
  >();
  const prompts: string[] = [];
  const commands: Record<string, number> = {};
  const efforts = new Set<string>();
  let lines = 0;
  let skipped = 0;
  let compactions = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    lines++;
    const line = parse(raw);
    if (!line) {
      skipped++;
      continue;
    }
    const at = typeof line["timestamp"] === "string" ? line["timestamp"] : null;
    if (at) {
      firstAt ??= at;
      lastAt = at;
    }
    if (line["type"] === "system" && line["subtype"] === "compact_boundary") compactions++;
    if (line["type"] === "assistant") {
      const message = record(line["message"]);
      const id = typeof message["id"] === "string" ? message["id"] : `line-${lines}`;
      const model = typeof message["model"] === "string" ? message["model"] : "unknown";
      if (model === "<synthetic>") continue;
      if (typeof line["effort"] === "string") efforts.add(line["effort"]);
      // A message spans several lines; the last one carries its final usage.
      usageById.set(id, { model, usage: record(message["usage"]), at: at ? Date.parse(at) : NaN });
    }
    const prompt = promptOf(line);
    if (prompt) {
      const command = /<command-name>(\/[^<\s]+)<\/command-name>/.exec(prompt)?.[1];
      if (command) commands[command] = (commands[command] ?? 0) + 1;
      else if (prompts.length < TRANSCRIPT_LIMITS.prompts)
        prompts.push(clip(redactSecrets(prompt).text, TRANSCRIPT_LIMITS.promptChars));
    }
  }

  const requests = [...usageById.values()].sort((a, b) => a.at - b.at);
  const tokens = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
  const byModel = new Map<string, number>();
  let switches = 0;
  let gaps = 0;
  let cost = 0;
  let priced = false;
  const model = loadCacheModel();
  requests.forEach((req, i) => {
    const u = req.usage;
    const split = record(u["cache_creation"]);
    const write = num(u["cache_creation_input_tokens"]);
    const w1h = num(split["ephemeral_1h_input_tokens"]);
    const w5m =
      split["ephemeral_5m_input_tokens"] !== undefined
        ? num(split["ephemeral_5m_input_tokens"])
        : write - w1h;
    tokens.input += num(u["input_tokens"]);
    tokens.cacheWrite5m += w5m;
    tokens.cacheWrite1h += w1h;
    tokens.cacheRead += num(u["cache_read_input_tokens"]);
    tokens.output += num(u["output_tokens"]);
    byModel.set(req.model, (byModel.get(req.model) ?? 0) + 1);
    const prev = requests[i - 1];
    if (prev && prev.model !== req.model) switches++;
    if (prev && req.at - prev.at > 5 * 60_000) gaps++;
    const pricing = model.models[req.model];
    if (pricing) {
      priced = true;
      const base = pricing.inputPerMTok / 1_000_000;
      cost +=
        base *
        (num(u["input_tokens"]) +
          w5m * model.writeMultiplier["5m"] +
          w1h * model.writeMultiplier["1h"] +
          num(u["cache_read_input_tokens"]) * pricing.readMultiplier);
    }
  });
  const inputSide = tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead;
  return {
    project,
    lines,
    skipped,
    truncated: size > TRANSCRIPT_LIMITS.readBytes,
    firstAt,
    lastAt,
    requests: requests.length,
    models: [...byModel.entries()]
      .map(([m, n]) => ({ model: m, requests: n }))
      .sort((a, b) => b.requests - a.requests),
    modelSwitches: switches,
    efforts: [...efforts],
    tokens,
    cacheHitRatio: inputSide ? tokens.cacheRead / inputSide : 0,
    longGaps: gaps,
    compactions,
    commands,
    estimatedInputCost: priced ? cost : null,
    prompts,
  };
}
