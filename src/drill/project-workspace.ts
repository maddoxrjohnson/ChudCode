/**
 * project-workspace.ts: the repository a project session's candidate works in.
 *
 *   ~/chudcode-drills/<session id>/
 *     README.md         the ticket, how to run the tests, and the read-only files
 *     manage.py config/ <app>/ tests/ requirements.txt
 *
 * Like the drill workspaces, it lives outside the state root so nothing explored
 * from it leads to the fix or the hidden tests. The candidate edits it in the page's
 * editor or in their own; Run and Submit read it back as text, through the same
 * guards: regular files only, never a link, plain paths, size caps.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  isProjectPath,
  protectedPaths,
  startingRepository,
  type ProjectBundle,
} from "../store/projects.ts";
import { workspaceDir, workspacesDir } from "../store/paths.ts";
import { commitWorkspace, WorkspaceError } from "./workspace.ts";

export const WORKSPACE_LIMITS = { files: 200, fileBytes: 128 * 1024, totalBytes: 2 * 1024 * 1024 };

/** Folders a repository read skips: tooling, caches, and the local database. */
const SKIPPED_DIRS = new Set([
  ".git",
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  ".pytest_cache",
  ".idea",
  ".vscode",
  "hidden_tests",
]);
const SKIPPED_FILES = new Set(["db.sqlite3", "README.md"]);

export function projectReadme(bundle: ProjectBundle): string {
  const locked = protectedPaths(bundle);
  return [
    bundle.statement.trim(),
    "",
    "## Read-only files",
    "",
    "You may read these but not change them. A submission that changes one does not run.",
    "",
    ...locked.map((p) => `- \`${p}\``),
    "",
    "## Working locally",
    "",
    "The ChudCode page has an editor and Run and Submit buttons. You can also open this",
    "folder in your own editor; the page picks up your saved changes. To run the visible",
    "tests in a terminal, use a Python that has the packages in requirements.txt:",
    "",
    "```sh",
    "python manage.py test tests",
    "```",
    "",
  ].join("\n");
}

/** Lay out a fresh workspace with the starting repository, committed if git is there. */
export async function createProjectWorkspace(id: string, bundle: ProjectBundle): Promise<string> {
  const dir = workspaceDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const files = { ...startingRepository(bundle), "README.md": projectReadme(bundle) };
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  fs.writeFileSync(path.join(dir, ".gitignore"), "__pycache__/\ndb.sqlite3\n");
  await commitWorkspace(dir, "Start the project");
  return dir;
}

/** The workspace's real path, refusing one that moved out from under the drills folder. */
function workspaceRoot(dir: string): string {
  let root: string;
  let real: string;
  try {
    root = fs.realpathSync(workspacesDir());
    real = fs.realpathSync(dir);
  } catch {
    throw new WorkspaceError(`The workspace ${dir} is gone.`);
  }
  if (!real.startsWith(root + path.sep)) throw new WorkspaceError("The workspace has moved.");
  return real;
}

/**
 * Every project file in the workspace, by relative path. Skips tooling folders and
 * the local database; anything that is not a regular text file under the caps is
 * left out, so a stray binary cannot sink a run.
 */
export function readProjectWorkspace(dir: string): Record<string, string> {
  const root = workspaceRoot(dir);
  const out: Record<string, string> = {};
  let total = 0;
  const walk = (rel: string, depth: number) => {
    for (const entry of fs
      .readdirSync(path.join(root, rel), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".") && depth < 5)
          walk(child, depth + 1);
        continue;
      }
      if (!entry.isFile() || SKIPPED_FILES.has(child) || !isProjectPath(child)) continue;
      const size = fs.statSync(path.join(root, child)).size;
      if (size > WORKSPACE_LIMITS.fileBytes) continue;
      if (Object.keys(out).length >= WORKSPACE_LIMITS.files)
        throw new WorkspaceError(`The workspace holds more than ${WORKSPACE_LIMITS.files} files.`);
      total += size;
      if (total > WORKSPACE_LIMITS.totalBytes)
        throw new WorkspaceError(
          `The workspace is over ${WORKSPACE_LIMITS.totalBytes / 1024 / 1024} MB of source.`,
        );
      out[child] = fs.readFileSync(path.join(root, child), "utf8");
    }
  };
  walk("", 0);
  return out;
}

/** One file, for the page's editor. */
export function readWorkspaceFile(dir: string, rel: string): string {
  const file = guardedFile(dir, rel);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new WorkspaceError(`${rel} is not in the workspace.`);
  }
  if (!stat.isFile()) throw new WorkspaceError(`${rel} is not a regular file.`);
  if (stat.size > WORKSPACE_LIMITS.fileBytes)
    throw new WorkspaceError(`${rel} is over ${WORKSPACE_LIMITS.fileBytes / 1024} KB.`);
  return fs.readFileSync(file, "utf8");
}

/** Save one file from the page's editor. New files may only go in existing folders. */
export function writeWorkspaceFile(dir: string, rel: string, text: string): void {
  const file = guardedFile(dir, rel);
  if (Buffer.byteLength(text) > WORKSPACE_LIMITS.fileBytes)
    throw new WorkspaceError(`${rel} is over ${WORKSPACE_LIMITS.fileBytes / 1024} KB.`);
  const parent = path.dirname(file);
  if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory())
    throw new WorkspaceError(`The folder for ${rel} does not exist.`);
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile())
    throw new WorkspaceError(`${rel} is not a regular file.`);
  fs.writeFileSync(file, text);
}

function guardedFile(dir: string, rel: string): string {
  if (!isProjectPath(rel) || rel.split("/").some((part) => SKIPPED_DIRS.has(part)))
    throw new WorkspaceError(`${rel} is not a project file the page can open.`);
  const root = workspaceRoot(dir);
  // Each folder on the way must be a real folder, not a link out of the workspace.
  let at = root;
  for (const part of rel.split("/").slice(0, -1)) {
    at = path.join(at, part);
    if (fs.existsSync(at) && !fs.lstatSync(at).isDirectory())
      throw new WorkspaceError(`${rel} goes through something that is not a folder.`);
  }
  return path.join(root, ...rel.split("/"));
}

export interface TreeEntry {
  path: string;
  readOnly: boolean;
  /** Differs from the starting repository, or is new. */
  changed: boolean;
}

export function workspaceTree(
  files: Record<string, string>,
  start: Record<string, string>,
  locked: readonly string[],
): TreeEntry[] {
  return Object.keys(files)
    .sort(byFolderThenName)
    .map((p) => ({ path: p, readOnly: locked.includes(p), changed: start[p] !== files[p] }));
}

/** Folders before files at each level, the way an editor's tree reads. */
function byFolderThenName(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    const aDir = i < pa.length - 1;
    const bDir = i < pb.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return (pa[i] as string).localeCompare(pb[i] as string);
  }
  return pa.length - pb.length;
}

/** Read-only files whose contents no longer match the start, or that are gone. */
export function changedProtected(
  files: Record<string, string>,
  start: Record<string, string>,
  locked: readonly string[],
): string[] {
  return locked.filter((p) => p in start && files[p] !== start[p]);
}

// ── Diff ──────────────────────────────────────────────────────────────────────

const DIFF_CONTEXT = 2;
const MAX_DIFF_LINES = 1_500;

/**
 * A unified-style diff of every file that changed between two repositories. Plain
 * LCS per file: project files are a few hundred lines, so the quadratic table is
 * small, and a file too big for it is reported as changed without its lines.
 */
export function diffRepositories(
  before: Record<string, string>,
  after: Record<string, string>,
): string {
  const out: string[] = [];
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const name of names) {
    const a = before[name];
    const b = after[name];
    if (a === b) continue;
    if (a === undefined) out.push(`--- /dev/null`, `+++ ${name} (new)`);
    else if (b === undefined) out.push(`--- ${name}`, `+++ /dev/null (deleted)`);
    else out.push(`--- ${name}`, `+++ ${name}`);
    out.push(...hunks(a?.split("\n") ?? [], b?.split("\n") ?? []));
    if (out.length > MAX_DIFF_LINES) {
      out.length = MAX_DIFF_LINES;
      out.push("… (diff cut short)");
      break;
    }
  }
  return out.join("\n");
}

function hunks(a: string[], b: string[]): string[] {
  if (a.length * b.length > 4_000_000) return ["@@ (too large to diff line by line) @@"];
  // lcs[i][j]: the longest common subsequence of a[i:] and b[j:].
  const lcs: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (lcs[i] as Uint32Array)[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as Uint32Array)[j + 1] as number) + 1
          : Math.max(
              (lcs[i + 1] as Uint32Array)[j] as number,
              (lcs[i] as Uint32Array)[j + 1] as number,
            );
  const ops: Array<{ op: " " | "-" | "+"; line: string; a: number; b: number }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: " ", line: a[i] as string, a: i++, b: j++ });
    } else if (
      i < a.length &&
      (j === b.length ||
        ((lcs[i + 1] as Uint32Array)[j] as number) >= ((lcs[i] as Uint32Array)[j + 1] as number))
    ) {
      // Removals before insertions, as unified diffs read.
      ops.push({ op: "-", line: a[i] as string, a: i++, b: j });
    } else {
      ops.push({ op: "+", line: b[j] as string, a: i, b: j++ });
    }
  }
  const changed = ops.flatMap((o, n) => (o.op === " " ? [] : [n]));
  const out: string[] = [];
  for (let g = 0; g < changed.length; g++) {
    const first = changed[g] as number;
    let last = first;
    // Changes closer than twice the context share a hunk.
    while (g + 1 < changed.length && (changed[g + 1] as number) - last <= DIFF_CONTEXT * 2 + 1)
      last = changed[++g] as number;
    const from = Math.max(0, first - DIFF_CONTEXT);
    const to = Math.min(ops.length, last + DIFF_CONTEXT + 1);
    const head = ops[from] as (typeof ops)[number];
    out.push(`@@ -${head.a + 1} +${head.b + 1} @@`);
    for (let n = from; n < to; n++) {
      const o = ops[n] as (typeof ops)[number];
      out.push(`${o.op}${o.line}`);
    }
  }
  return out;
}
