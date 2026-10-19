/**
 * lab.ts: read a learner's own project for a lab, read-only and narrowly.
 *
 * A lab grades what the learner set up in a real repository: their CLAUDE.md, their
 * progress file, their subagents. The path comes from the lesson page, where the
 * learner consents to it; the interviewer can never name a path itself. What is read
 * is fenced on every side:
 *
 *   - the root must be a real directory that is neither `/`, the home directory, an
 *     ancestor of either, nor inside or above ChudCode's own state;
 *   - only paths on `LAB_ALLOW` are read, and `LAB_DENY` wins over it (env files,
 *     keys, anything under .git);
 *   - a symlink is followed only when its target stays inside the root;
 *   - files, their count, and their total are capped, and secrets that look like
 *     tokens or keys are redacted before anything leaves this module;
 *   - `git log` runs through execFile with no shell, no pager, no external diff, and
 *     the user's global and system git config ignored.
 *
 * The lints are mechanical checks drawn from curriculum facts (a subagent field the
 * docs do not list, a CLAUDE.md past 200 lines); the interviewer judges the rest
 * against the lesson's checklist.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { rootDir } from "./store/paths.ts";

/** Every path a lab may read, relative to the project root. Lessons narrow it. */
export const LAB_ALLOW = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "progress.md",
  "PROGRESS.md",
  "PLAN.md",
  "plan.md",
  "docs/PLAN.md",
  "docs/progress.md",
  ".claude/CLAUDE.md",
  ".claude/settings.json",
  ".mcp.json",
  ".claude/skills/*/SKILL.md",
  ".claude/skills/*/*.md",
  ".claude/agents/**/*.md",
  ".claude/commands/*.md",
] as const;

/** Never read, whatever a pattern says. Tested against each path segment. */
const LAB_DENY: readonly RegExp[] = [
  /^\.git$/,
  /^\.env/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /secret/i,
  /credential/i,
  /^node_modules$/,
];

export const LAB_LIMITS = {
  fileBytes: 64 * 1024,
  totalBytes: 256 * 1024,
  files: 40,
  walkEntries: 4_000,
  depth: 6,
  gitCommits: 12,
  gitBytes: 8 * 1024,
};

export class LabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabError";
  }
}

export interface LabGuards {
  home: string;
  /** ChudCode's own state root, which a lab may not read or contain. */
  stateRoot: string;
}

export function defaultGuards(): LabGuards {
  return { home: os.homedir(), stateRoot: rootDir() };
}

/** Is `inner` equal to `outer` or below it? */
function within(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The real path of the project the learner named, or a LabError saying why it cannot
 * be read. `~` expands to the home directory; anything else must be absolute.
 */
export function resolveProjectRoot(input: string, guards: LabGuards = defaultGuards()): string {
  const trimmed = input.trim();
  if (!trimmed) throw new LabError("Enter the path of your project.");
  if (trimmed.includes("\0")) throw new LabError("That path is not valid.");
  const home = realOrSelf(guards.home);
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/") ? path.join(home, trimmed.slice(1)) : trimmed;
  if (!path.isAbsolute(expanded))
    throw new LabError("Use an absolute path, or one starting with ~/.");
  let real: string;
  try {
    real = fs.realpathSync(expanded);
  } catch {
    throw new LabError(`There is no directory at ${expanded}.`);
  }
  if (!fs.statSync(real).isDirectory()) throw new LabError(`${real} is not a directory.`);
  const state = realOrSelf(guards.stateRoot);
  if (real === path.parse(real).root) throw new LabError("The filesystem root is not a project.");
  if (within(home, real))
    throw new LabError("That is your home directory or above it. Pick the project's own folder.");
  if (within(real, state) || within(state, real))
    throw new LabError("That folder holds ChudCode's own state, which a lab does not read.");
  return real;
}

// ── Finding files ─────────────────────────────────────────────────────────────

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
      out += "(?:[^/]+/)*";
      i += 2;
    } else if (c === "*") out += "[^/]*";
    else out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function matchesPattern(relative: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relative);
}

export function isDenied(relative: string): boolean {
  return relative.split("/").some((segment) => LAB_DENY.some((re) => re.test(segment)));
}

/** Whether a lesson's lab pattern is one the global allow-list covers. */
export function allowedPattern(pattern: string): boolean {
  return (LAB_ALLOW as readonly string[]).includes(pattern);
}

export interface LabSkip {
  path: string;
  reason: string;
}

export interface LabListing {
  root: string;
  files: Array<{ path: string; bytes: number }>;
  skipped: LabSkip[];
}

/**
 * The files a lab would read under `root` for these patterns, without reading them.
 * The page shows this list before the learner consents.
 */
export function listLabFiles(root: string, patterns: readonly string[]): LabListing {
  const wanted = patterns.filter(allowedPattern);
  const regexes = wanted.map(globToRegExp);
  const files: LabListing["files"] = [];
  const skipped: LabSkip[] = [];
  const seen = new Set<string>();
  let entries = 0;

  const walk = (dir: string, rel: string, depth: number): void => {
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > LAB_LIMITS.walkEntries) return;
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Only .claude and docs can hold allowed files below the root.
        if (depth === 0 && entry.name !== ".claude" && entry.name !== "docs") continue;
        if (isDenied(relative) || depth >= LAB_LIMITS.depth) continue;
        walk(full, relative, depth + 1);
        continue;
      }
      if (!regexes.some((re) => re.test(relative))) continue;
      if (isDenied(relative)) {
        skipped.push({ path: relative, reason: "never read: it may hold secrets" });
        continue;
      }
      let real: string;
      try {
        real = fs.realpathSync(full);
      } catch {
        skipped.push({ path: relative, reason: "a broken link" });
        continue;
      }
      if (!within(real, root)) {
        skipped.push({ path: relative, reason: "a link to a file outside the project" });
        continue;
      }
      const stat = fs.statSync(real);
      if (!stat.isFile()) continue;
      // PLAN.md and plan.md are one file on a case-insensitive disk.
      if (seen.has(real)) continue;
      seen.add(real);
      if (files.length >= LAB_LIMITS.files) {
        skipped.push({ path: relative, reason: `over the ${LAB_LIMITS.files}-file limit` });
        continue;
      }
      files.push({ path: relative, bytes: stat.size });
    }
  };
  walk(root, "", 0);
  return { root, files, skipped };
}

// ── Reading them ──────────────────────────────────────────────────────────────

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)([^\s"'`,;[]{8,})/gi,
];

/** Replace anything that looks like a credential. Returns the text and the count. */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (whole: string, prefix?: string) => {
      redactions++;
      return typeof prefix === "string" && whole.startsWith(prefix)
        ? `${prefix}[redacted]`
        : "[redacted]";
    });
  }
  return { text: out, redactions };
}

export interface LabFile {
  path: string;
  bytes: number;
  lines: number;
  sha256: string;
  truncated: boolean;
  redactions: number;
  content: string;
}

export interface LabLint {
  id: string;
  file: string;
  line?: number;
  message: string;
  /** The curriculum fact the check rests on. */
  fact?: string;
}

export interface LabSnapshot {
  at: number;
  root: string;
  files: LabFile[];
  skipped: LabSkip[];
  lints: LabLint[];
  /** `git log --stat` for the last commits, or null when the project is not a repository. */
  gitLog: string | null;
}

export async function inspectProject(
  root: string,
  patterns: readonly string[],
  now = Date.now(),
): Promise<LabSnapshot> {
  const listing = listLabFiles(root, patterns);
  const files: LabFile[] = [];
  const skipped = [...listing.skipped];
  let total = 0;
  for (const entry of listing.files) {
    if (total >= LAB_LIMITS.totalBytes) {
      skipped.push({ path: entry.path, reason: "over the total size limit" });
      continue;
    }
    const budget = Math.min(LAB_LIMITS.fileBytes, LAB_LIMITS.totalBytes - total);
    const raw = readHead(path.join(root, entry.path), budget);
    total += raw.length;
    const decoded = raw.toString("utf8");
    if (decoded.includes("\0")) {
      skipped.push({ path: entry.path, reason: "not a text file" });
      continue;
    }
    const { text, redactions } = redactSecrets(decoded);
    files.push({
      path: entry.path,
      bytes: entry.bytes,
      lines: text.split("\n").length,
      sha256: createHash("sha256").update(raw).digest("hex"),
      truncated: entry.bytes > raw.length,
      redactions,
      content: text,
    });
  }
  return { at: now, root, files, skipped, lints: lintLab(files), gitLog: await gitLog(root) };
}

function readHead(file: string, bytes: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** The repository's recent history, through git with every external hook switched off. */
export function gitLog(root: string): Promise<string | null> {
  if (!fs.existsSync(path.join(root, ".git"))) return Promise.resolve(null);
  const args = [
    "-C",
    root,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.pager=cat",
    "-c",
    "log.showSignature=false",
    "--no-pager",
    "log",
    "-n",
    String(LAB_LIMITS.gitCommits),
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--stat=100",
    "--format=%h %ad %s",
    "--date=short",
  ];
  const env = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { env, timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const clipped =
          stdout.length > LAB_LIMITS.gitBytes
            ? `${stdout.slice(0, LAB_LIMITS.gitBytes)}\n[… clipped]`
            : stdout;
        resolve(redactSecrets(clipped).text.trimEnd());
      },
    );
  });
}

// ── Lints ─────────────────────────────────────────────────────────────────────

/** Top-level keys of a Markdown file's YAML frontmatter, with their line numbers. */
export function frontmatter(content: string): Map<string, { value: string; line: number }> | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const out = new Map<string, { value: string; line: number }>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "---") return out;
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (match) out.set(match[1] as string, { value: unquote(match[2] as string), line: i + 1 });
  }
  return null;
}

function unquote(value: string): string {
  const v = value.trim();
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
}

/** Subagent frontmatter fields the sub-agents page documents. */
export const SUBAGENT_FIELDS = [
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "effort",
  "permissionMode",
  "maxTurns",
  "skills",
  "mcpServers",
  "hooks",
  "memory",
  "background",
  "isolation",
  "color",
  "initialPrompt",
] as const;

export const MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable", "inherit"] as const;
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The longest CLAUDE.md the memory docs suggest. */
export const CLAUDE_MD_LINES = 200;

const CLAUDE_MD_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];

export function lintLab(files: readonly LabFile[]): LabLint[] {
  const lints: LabLint[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));

  for (const name of CLAUDE_MD_FILES) {
    const file = byPath.get(name);
    if (file && file.lines > CLAUDE_MD_LINES)
      lints.push({
        id: "claude-md-long",
        file: name,
        message: `${name} is ${file.lines} lines; the docs suggest under ${CLAUDE_MD_LINES}.`,
        fact: "claude-md-size",
      });
  }

  const agents = byPath.get("AGENTS.md");
  const claude = byPath.get("CLAUDE.md") ?? byPath.get("CLAUDE.local.md");
  if (agents && claude && !/@AGENTS\.md\b/.test(claude.content))
    lints.push({
      id: "agents-md-shadowed",
      file: "AGENTS.md",
      message: `AGENTS.md sits beside ${claude.path}, so Claude Code does not read it. Import it from ${claude.path} with @AGENTS.md, or merge the two.`,
      fact: "agents-md-support",
    });

  for (const file of files) {
    if (!/^\.claude\/agents\/.+\.md$/.test(file.path)) continue;
    lints.push(...lintSubagent(file));
  }

  const settings = byPath.get(".claude/settings.json");
  if (settings) {
    try {
      JSON.parse(settings.content);
    } catch {
      lints.push({
        id: "settings-invalid-json",
        file: settings.path,
        message: ".claude/settings.json is not valid JSON, so none of it applies.",
      });
    }
  }
  return lints;
}

function lintSubagent(file: LabFile): LabLint[] {
  const lints: LabLint[] = [];
  const fields = frontmatter(file.content);
  if (!fields) {
    return [
      {
        id: "subagent-no-frontmatter",
        file: file.path,
        line: 1,
        message: "This subagent has no frontmatter, so it has no name or description.",
        fact: "subagent-required-fields",
      },
    ];
  }
  for (const required of ["name", "description"]) {
    if (!fields.get(required)?.value)
      lints.push({
        id: "subagent-missing-field",
        file: file.path,
        line: 1,
        message: `The frontmatter has no ${required}, which every subagent needs.`,
        fact: "subagent-required-fields",
      });
  }
  for (const [key, { line }] of fields) {
    if (!(SUBAGENT_FIELDS as readonly string[]).includes(key))
      lints.push({
        id: "subagent-unknown-field",
        file: file.path,
        line,
        message: `"${key}" is not a documented subagent field, so Claude Code ignores it.`,
        fact: "subagent-frontmatter-fields",
      });
  }
  const model = fields.get("model");
  if (model && model.value && !validModel(model.value))
    lints.push({
      id: "subagent-bad-model",
      file: file.path,
      line: model.line,
      message: `model "${model.value}" is neither an alias (${MODEL_ALIASES.join(", ")}) nor a full model id.`,
      fact: "subagent-model-values",
    });
  const effort = fields.get("effort");
  if (effort && effort.value && !(EFFORT_LEVELS as readonly string[]).includes(effort.value))
    lints.push({
      id: "subagent-bad-effort",
      file: file.path,
      line: effort.line,
      message: `effort "${effort.value}" is not one of ${EFFORT_LEVELS.join(", ")}.`,
      fact: "subagent-effort-values",
    });
  return lints;
}

function validModel(value: string): boolean {
  if ((MODEL_ALIASES as readonly string[]).includes(value)) return true;
  // A full id: claude-…, or a provider id that names a Claude model.
  return /claude/i.test(value) && /^[A-Za-z0-9._:/@-]+$/.test(value);
}
