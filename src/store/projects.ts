/**
 * projects.ts: repository debugging tasks ("projects") and the sessions that work them.
 *
 *   projects/bundles/<slug>/
 *     meta.json          title, framework, app, bug categories, the planted bugs, validation
 *     statement.md       the ticket the candidate reads: what the API should do, what users report
 *     hints.json         { levels: [{ level, text }] }
 *     files/<path>       the repository as the candidate gets it, on top of the skeleton
 *     fix/<path>         the reference fix: files that replace or add to files/
 *     tests/visible/     test_*.py shipped in the repository's read-only tests/ folder
 *     tests/hidden/      test_*.py added as hidden_tests/ when the candidate submits
 *   projects/sessions/<id>/
 *     session.json  events.jsonl  submissions/NN.json
 *
 * A project is the shape of a HackerRank-style backend task: a multi-file Django
 * project with bugs planted in it, a few visible tests, and more hidden ones. The
 * candidate works in a copy at ~/chudcode-drills/<session id>/, in the page's editor
 * or their own. Bundles never leave the server: the page sees the statement, the
 * workspace's own files, and test results, never fix/ or tests/hidden/.
 *
 * ChudCode writes the parts every project shares (manage.py, config/, the app's
 * __init__.py and apps.py, tests/__init__.py) from the meta, so a bundle holds only
 * what makes it different; a bundle file at the same path replaces the skeleton's.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { makeKey, type ReviewEvent } from "../review.ts";
import { appendJsonl, readJson, readJsonl, readText, writeJson, writeText } from "./json.ts";
import {
  dataDir,
  isDir,
  isValidSessionId,
  isValidSlug,
  lessonDir,
  phoneSessionDir,
  projectBundleDir,
  projectExamplesDir,
  projectsDir,
  projectSessionDir,
  sessionDir,
  slugify,
} from "./paths.ts";
import { DIFFICULTIES, type Difficulty, type Hint } from "./problems.ts";
import { generateSessionId, type Phase, type SessionEvent } from "./sessions.ts";

// ── Bug categories ────────────────────────────────────────────────────────────

export interface ProjectPattern {
  id: string;
  name: string;
  blurb: string;
}

let patternCache: ProjectPattern[] | null = null;

export function projectPatterns(): ProjectPattern[] {
  patternCache ??=
    readJson<{ patterns: ProjectPattern[] }>(path.join(dataDir(), "project-patterns.json"))
      ?.patterns ?? [];
  return patternCache;
}

export function projectPatternById(id: string): ProjectPattern | undefined {
  return projectPatterns().find((p) => p.id === id);
}

// ── Bundles ───────────────────────────────────────────────────────────────────

export const FRAMEWORKS = ["django"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export interface PlantedBug {
  /** Kebab-case, unique in the bundle. */
  id: string;
  /** The bug category it drills, from data/project-patterns.json. */
  pattern: string;
  /** What is wrong and where, for the interviewer. Never shown to the candidate. */
  summary: string;
  /** The files the fix touches. */
  files: string[];
  /** Hidden tests that fail while it is there, as `Class.test_method`. */
  tests: string[];
}

export interface ProjectMeta {
  slug: string;
  title: string;
  framework: Framework;
  /** The Django app's package name. */
  app: string;
  /** Whether the project uses Django REST framework. */
  drf: boolean;
  /** Bug categories, first the one it drills hardest. Derived from the bugs when absent. */
  patterns: string[];
  difficulty: Difficulty;
  /** The time it is meant to take, in minutes. The default clock. */
  minutes: number;
  source: { kind: "generated" | "hand"; trendIds?: string[] };
  bugs: PlantedBug[];
  /** Extra read-only paths beyond manage.py, config/settings.py, and tests/. */
  protected?: string[];
  createdAt: number;
  validatedAt?: number;
  validation?: { visibleFailing: number; hiddenFailing: number; total: number };
  timesServed: number;
  lastServedAt?: number;
}

export interface ProjectBundle {
  meta: ProjectMeta;
  statement: string;
  hints: Hint[];
  /** The repository as the candidate gets it, by relative path; the skeleton fills the rest. */
  files: Record<string, string>;
  /** The reference fix: files that replace or add to `files`. */
  fix: Record<string, string>;
  /** `test_*.py` name to contents, shipped in tests/. */
  visibleTests: Record<string, string>;
  /** `test_*.py` name to contents, added as hidden_tests/ on submit. */
  hiddenTests: Record<string, string>;
}

export const PROJECT_LIMITS = {
  files: 60,
  fileBytes: 64 * 1024,
  totalBytes: 512 * 1024,
  depth: 5,
  bugs: 8,
  testFiles: 10,
};

const TEXT_EXTENSIONS = [
  ".py",
  ".html",
  ".txt",
  ".md",
  ".json",
  ".cfg",
  ".toml",
  ".ini",
  ".yml",
  ".yaml",
  ".css",
  ".js",
  ".csv",
];
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const TEST_FILE_RE = /^test_[a-z0-9_]+\.py$/;
const IDENT_RE = /^[a-z][a-z0-9_]*$/;
const BUG_TEST_RE = /^[A-Za-z_]\w*\.test\w*$/;
/** Paths the harness and grading own; no bundle file may sit there. */
const RESERVED = /^(tests|hidden_tests)\/|^chud_django_harness\.py$|^project\.json$/;

/** A repository path a bundle or the page may name: relative, plain segments, a text file. */
export function isProjectPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 200) return false;
  const parts = p.split("/");
  if (parts.length > PROJECT_LIMITS.depth) return false;
  if (!parts.every((part) => SEGMENT_RE.test(part))) return false;
  return TEXT_EXTENSIONS.includes(path.extname(p).toLowerCase());
}

export class ProjectValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid project bundle:\n- ${problems.join("\n- ")}`);
    this.name = "ProjectValidationError";
    this.problems = problems;
  }
}

/** Check a bundle-shaped object from disk or a tool call; throws with every problem. */
export function validateProjectBundle(input: ProjectBundle): ProjectBundle {
  const problems: string[] = [];
  const m = input.meta as Partial<ProjectMeta> | undefined;
  if (!m || typeof m !== "object") throw new ProjectValidationError(["meta must be an object"]);
  if (!isValidSlug(m.slug)) problems.push("meta.slug must be lowercase kebab-case");
  if (typeof m.title !== "string" || !m.title.trim() || m.title.length > 120)
    problems.push("meta.title must be 1 to 120 characters");
  if (!FRAMEWORKS.includes(m.framework as Framework))
    problems.push(`meta.framework must be one of ${FRAMEWORKS.join(", ")}`);
  if (
    typeof m.app !== "string" ||
    !IDENT_RE.test(m.app) ||
    ["config", "tests", "hidden_tests"].includes(m.app)
  )
    problems.push("meta.app must be a lowercase Python package name other than config or tests");
  if (typeof m.drf !== "boolean") problems.push("meta.drf must be true or false");
  if (!DIFFICULTIES.includes(m.difficulty as Difficulty))
    problems.push(`meta.difficulty must be one of ${DIFFICULTIES.join(", ")}`);
  if (!Number.isInteger(m.minutes) || (m.minutes as number) < 10 || (m.minutes as number) > 120)
    problems.push("meta.minutes must be a whole number from 10 to 120");
  if (!m.source || !["generated", "hand"].includes(m.source.kind))
    problems.push("meta.source.kind must be generated or hand");

  const bugs = Array.isArray(m.bugs) ? m.bugs : [];
  if (bugs.length === 0 || bugs.length > PROJECT_LIMITS.bugs)
    problems.push(`meta.bugs must list 1 to ${PROJECT_LIMITS.bugs} planted bugs`);
  const bugIds = new Set<string>();
  bugs.forEach((bug, i) => {
    if (!isValidSlug(bug?.id) || bugIds.has(bug.id))
      problems.push(`meta.bugs[${i}].id must be a unique kebab-case id`);
    bugIds.add(bug?.id);
    if (!projectPatternById(bug?.pattern))
      problems.push(
        `meta.bugs[${i}].pattern must be one of ${projectPatterns()
          .map((p) => p.id)
          .join(", ")}`,
      );
    if (typeof bug?.summary !== "string" || !bug.summary.trim())
      problems.push(`meta.bugs[${i}].summary must say what is wrong and where`);
    if (!Array.isArray(bug?.files) || bug.files.length === 0 || !bug.files.every(isProjectPath))
      problems.push(`meta.bugs[${i}].files must list the repository paths the fix touches`);
    if (
      !Array.isArray(bug?.tests) ||
      bug.tests.length === 0 ||
      !bug.tests.every((t) => BUG_TEST_RE.test(t))
    )
      problems.push(`meta.bugs[${i}].tests must list hidden tests as Class.test_method`);
  });
  const patterns =
    Array.isArray(m.patterns) && m.patterns.length > 0
      ? m.patterns
      : [...new Set(bugs.map((b) => b?.pattern))];
  for (const p of patterns)
    if (!projectPatternById(p)) problems.push(`meta.patterns has an unknown category: ${p}`);
  for (const p of m.protected ?? [])
    if (!isProjectPath(p)) problems.push(`meta.protected has a bad path: ${p}`);

  if (typeof input.statement !== "string" || !input.statement.trim())
    problems.push("statement must be non-empty Markdown");
  else if (/leetcode|hackerrank/i.test(input.statement))
    problems.push("statement must not name LeetCode or HackerRank");
  input.hints.forEach((h, i) => {
    if (h.level !== i + 1 || typeof h.text !== "string" || !h.text.trim())
      problems.push(`hints[${i}] must be { level: ${i + 1}, text }`);
  });

  const all = { ...input.files, ...input.fix };
  checkFiles(input.files, "files", problems);
  checkFiles(input.fix, "fix", problems);
  if (Object.keys(input.fix).length === 0) problems.push("fix must change at least one file");
  if (Object.keys(all).length > PROJECT_LIMITS.files)
    problems.push(`a project holds at most ${PROJECT_LIMITS.files} files`);
  const total = Object.values(all).reduce((n, text) => n + Buffer.byteLength(text), 0);
  if (total > PROJECT_LIMITS.totalBytes)
    problems.push(`a project is at most ${PROJECT_LIMITS.totalBytes / 1024} KB of source`);
  for (const bug of bugs)
    for (const file of bug?.files ?? [])
      if (isProjectPath(file) && !(file in input.files) && !(file in input.fix))
        problems.push(`bug ${bug.id} names ${file}, which is in neither files nor fix`);
  for (const [name, tests] of [
    ["tests.visible", input.visibleTests],
    ["tests.hidden", input.hiddenTests],
  ] as const) {
    const names = Object.keys(tests);
    if (names.length === 0 || names.length > PROJECT_LIMITS.testFiles)
      problems.push(`${name} must hold 1 to ${PROJECT_LIMITS.testFiles} test files`);
    for (const file of names)
      if (!TEST_FILE_RE.test(file)) problems.push(`${name}: ${file} must be named test_<name>.py`);
  }
  if (problems.length > 0) throw new ProjectValidationError(problems);
  return {
    ...input,
    meta: {
      ...(m as ProjectMeta),
      patterns,
      timesServed: m.timesServed ?? 0,
      createdAt: m.createdAt ?? Date.now(),
    },
  };
}

function checkFiles(files: Record<string, string>, label: string, problems: string[]): void {
  for (const [p, text] of Object.entries(files)) {
    if (!isProjectPath(p))
      problems.push(`${label}: ${p} is not a plain relative path to a text file`);
    else if (RESERVED.test(p))
      problems.push(`${label}: ${p} is reserved; tests go in tests.visible and tests.hidden`);
    if (typeof text !== "string") problems.push(`${label}: ${p} must be text`);
    else if (Buffer.byteLength(text) > PROJECT_LIMITS.fileBytes)
      problems.push(`${label}: ${p} is over ${PROJECT_LIMITS.fileBytes / 1024} KB`);
  }
}

// ── Reading and writing bundles ───────────────────────────────────────────────

/** Every regular file under `dir`, by path relative to it, read as text. */
function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isDir(dir)) return out;
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out[child] = fs.readFileSync(path.join(dir, child), "utf8");
    }
  };
  walk("");
  return out;
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files))
    writeText(path.join(dir, ...rel.split("/")), text);
}

export function projectExists(slug: string): boolean {
  return isValidSlug(slug) && isDir(projectBundleDir(slug));
}

export function readProjectFrom(dir: string): ProjectBundle {
  const meta = readJson<ProjectMeta>(path.join(dir, "meta.json"));
  if (!meta) throw new Error(`No project at ${dir}`);
  return validateProjectBundle({
    meta,
    statement: readText(path.join(dir, "statement.md")) ?? "",
    hints: readJson<{ levels: Hint[] }>(path.join(dir, "hints.json"))?.levels ?? [],
    files: readTree(path.join(dir, "files")),
    fix: readTree(path.join(dir, "fix")),
    visibleTests: readTree(path.join(dir, "tests", "visible")),
    hiddenTests: readTree(path.join(dir, "tests", "hidden")),
  });
}

export function readProject(slug: string): ProjectBundle {
  const bundle = readProjectFrom(projectBundleDir(slug));
  if (bundle.meta.slug !== slug)
    throw new Error(`Project directory ${slug} holds ${bundle.meta.slug}`);
  return bundle;
}

/** Write a whole bundle, swapped in at the end so a reader never sees half of one. */
export function writeProject(input: ProjectBundle): ProjectBundle {
  const bundle = validateProjectBundle(input);
  const target = projectBundleDir(bundle.meta.slug);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, `.staging-${bundle.meta.slug}-`));
  try {
    writeJson(path.join(staging, "meta.json"), bundle.meta);
    writeText(path.join(staging, "statement.md"), bundle.statement);
    writeJson(path.join(staging, "hints.json"), { levels: bundle.hints });
    writeTree(path.join(staging, "files"), bundle.files);
    writeTree(path.join(staging, "fix"), bundle.fix);
    writeTree(path.join(staging, "tests", "visible"), bundle.visibleTests);
    writeTree(path.join(staging, "tests", "hidden"), bundle.hiddenTests);
    if (isDir(target)) {
      const retired = `${target}.replaced-${Date.now()}`;
      fs.renameSync(target, retired);
      fs.renameSync(staging, target);
      fs.rmSync(retired, { recursive: true, force: true });
    } else fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return bundle;
}

export function updateProjectMeta(slug: string, patch: Partial<ProjectMeta>): ProjectMeta {
  const file = path.join(projectBundleDir(slug), "meta.json");
  const current = readJson<ProjectMeta>(file);
  if (!current) throw new Error(`No project named ${slug}`);
  const next = { ...current, ...patch, slug };
  writeJson(file, next);
  return next;
}

export function listProjects(): ProjectMeta[] {
  const root = path.join(projectsDir(), "bundles");
  if (!isDir(root)) return [];
  const out: ProjectMeta[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
    const meta = readJson<ProjectMeta>(path.join(root, entry.name, "meta.json"));
    if (meta?.slug === entry.name) out.push(meta);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Copy in every bundled example project that is not on disk yet. Examples ship
 * validated by the repository's own tests, so they are stamped as validated.
 */
export function importProjectExamples(now = Date.now()): string[] {
  const source = projectExamplesDir();
  if (!isDir(source)) return [];
  const imported: string[] = [];
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSlug(entry.name) || projectExists(entry.name)) continue;
    const bundle = readProjectFrom(path.join(source, entry.name));
    writeProject({ ...bundle, meta: { ...bundle.meta, validatedAt: now } });
    imported.push(entry.name);
  }
  return imported;
}

// ── The repository ────────────────────────────────────────────────────────────

/** The files every Django project shares, generated from the meta. */
export function projectSkeleton(meta: Pick<ProjectMeta, "app" | "drf">): Record<string, string> {
  const appClass = `${meta.app.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase())}Config`;
  const apps = [
    '"django.contrib.contenttypes"',
    '"django.contrib.auth"',
    ...(meta.drf ? ['"rest_framework"'] : []),
    `"${meta.app}"`,
  ];
  return {
    "manage.py": `#!/usr/bin/env python
import os
import sys


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
`,
    "config/__init__.py": "",
    "config/settings.py": `from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = "practice-only-not-a-secret"
DEBUG = True
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
${apps.map((a) => `    ${a},`).join("\n")}
]

MIDDLEWARE = [
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}

# Production runs this on Redis; the local-memory cache has the same API.
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
    }
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
TIME_ZONE = "UTC"
${meta.drf ? '\nREST_FRAMEWORK = {\n    "DEFAULT_AUTHENTICATION_CLASSES": [],\n    "DEFAULT_PERMISSION_CLASSES": [],\n    "UNAUTHENTICATED_USER": None,\n}\n' : ""}`,
    "config/urls.py": `from django.urls import include, path

urlpatterns = [
    path("", include("${meta.app}.urls")),
]
`,
    [`${meta.app}/__init__.py`]: "",
    [`${meta.app}/apps.py`]: `from django.apps import AppConfig


class ${appClass}(AppConfig):
    name = "${meta.app}"
`,
    "tests/__init__.py": "",
    "requirements.txt": meta.drf
      ? "Django>=5.2,<5.3\ndjangorestframework>=3.16,<3.17\n"
      : "Django>=5.2,<5.3\n",
  };
}

/** The repository the candidate starts from: skeleton, bundle files, visible tests. */
export function startingRepository(bundle: ProjectBundle): Record<string, string> {
  const tests = Object.fromEntries(
    Object.entries(bundle.visibleTests).map(([name, text]) => [`tests/${name}`, text]),
  );
  return { ...projectSkeleton(bundle.meta), ...bundle.files, ...tests };
}

/** The repository with the reference fix applied, for validation. */
export function fixedRepository(bundle: ProjectBundle): Record<string, string> {
  return { ...startingRepository(bundle), ...bundle.fix };
}

/** Hidden tests, as they are laid into a copy of the repository on submit. */
export function hiddenTestFiles(bundle: ProjectBundle): Record<string, string> {
  return {
    "hidden_tests/__init__.py": "",
    ...Object.fromEntries(
      Object.entries(bundle.hiddenTests).map(([name, text]) => [`hidden_tests/${name}`, text]),
    ),
  };
}

/** Paths the candidate may read but not change: changing one fails a submission. */
export function protectedPaths(bundle: ProjectBundle): string[] {
  const start = startingRepository(bundle);
  return [
    "manage.py",
    "config/settings.py",
    ...Object.keys(start).filter((p) => p.startsWith("tests/")),
    ...(bundle.meta.protected ?? []),
  ]
    .filter((p, i, all) => all.indexOf(p) === i)
    .sort();
}

/** Which planted bugs a run shows as fixed: every one of its tests ran and passed. */
export function bugsFixed(
  bugs: readonly PlantedBug[],
  tests: ReadonlyArray<{ id: string; status: string }>,
): string[] {
  return bugs
    .filter((bug) =>
      bug.tests.every((t) => {
        const found = tests.find((r) => r.id === `hidden_tests.${t}` || r.id.endsWith(`.${t}`));
        return found?.status === "pass";
      }),
    )
    .map((bug) => bug.id);
}

// ── Sessions ──────────────────────────────────────────────────────────────────

/** What one Run or Submit showed: the counts, and for a submit, the bugs it fixed. */
export interface ProjectResult {
  kind: "visible" | "submit";
  status: "ok" | "timeout" | "error" | "crashed" | "protected";
  passed: number;
  total: number;
  /** Planted bugs whose hidden tests all passed. Submissions only. */
  bugsFixed?: string[];
  /** Read-only files the candidate changed; the submission did not run. */
  protectedChanged?: string[];
  at: number;
}

export const PROJECT_DIMENSIONS = ["correctness", "debugging", "codeQuality", "time"] as const;
export type ProjectDimension = (typeof PROJECT_DIMENSIONS)[number];

export interface ProjectRubric {
  scores: Record<ProjectDimension, number>;
  notesMd: string;
  strengths: string[];
  improvements: string[];
}

export interface ProjectVerdict {
  correct: boolean;
  allPassed: boolean;
  withinTime: boolean;
  /** The interviewer's call: the fixes address the causes, not the tests. */
  rootCauseOk: boolean;
  bugsFixed: string[];
  bugsTotal: number;
}

export interface ProjectSession {
  id: string;
  kind: "project";
  project: string;
  projectTitle: string;
  patterns: string[];
  difficulty: Difficulty;
  /** Online-assessment mode: no interviewer chat until the end, no hints. */
  oa: boolean;
  company?: string;
  workspace: string;
  timerMs: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  phase: Phase;
  hintsUsed: number[];
  runs: number;
  submissions: number;
  lastResult?: ProjectResult;
  rubric?: ProjectRubric;
  verdict?: ProjectVerdict;
  abandonedReason?: string;
}

export type ProjectEvent =
  | Extract<
      SessionEvent,
      {
        type:
          "created" | "started" | "message" | "hint" | "timeout" | "done" | "rubric" | "abandoned";
      }
    >
  | { at: number; type: "run"; status: string; passed: number; total: number; by?: "interviewer" }
  | {
      at: number;
      type: "submit";
      number: number;
      status: string;
      passed: number;
      total: number;
      bugsFixed: string[];
    }
  | { at: number; type: "save"; path: string };

export interface NewProjectSession {
  project: ProjectBundle;
  oa: boolean;
  company?: string;
  timerMs: number;
  workspace: (id: string) => string;
}

export function newProjectSessionId(slug: string, now: number): string {
  const label = slugify(`project-${slug}`, "project");
  let id = generateSessionId(label, now);
  // Unique across every kind of session: the page channel and URL use the id alone.
  while (
    isDir(projectSessionDir(id)) ||
    isDir(sessionDir(id)) ||
    isDir(lessonDir(id)) ||
    isDir(phoneSessionDir(id))
  )
    id = generateSessionId(label, now);
  return id;
}

export function createProjectSession(
  id: string,
  input: Omit<NewProjectSession, "workspace"> & { workspace: string },
  now = Date.now(),
): ProjectSession {
  const { meta } = input.project;
  const session: ProjectSession = {
    id,
    kind: "project",
    project: meta.slug,
    projectTitle: meta.title,
    patterns: [...meta.patterns],
    difficulty: meta.difficulty,
    oa: input.oa,
    ...(input.company ? { company: input.company } : {}),
    workspace: input.workspace,
    timerMs: input.timerMs,
    createdAt: now,
    phase: "briefing",
    hintsUsed: [],
    runs: 0,
    submissions: 0,
  };
  writeProjectSession(session);
  appendProjectEvent(id, { type: "created", at: now });
  return session;
}

export function projectSessionExists(id: string): boolean {
  return isValidSessionId(id) && isDir(projectSessionDir(id));
}

export function readProjectSession(id: string): ProjectSession {
  const session = readJson<ProjectSession>(path.join(projectSessionDir(id), "session.json"));
  if (!session) throw new Error(`No project session named ${id}`);
  return session;
}

export function writeProjectSession(session: ProjectSession): void {
  writeJson(path.join(projectSessionDir(session.id), "session.json"), session);
}

export function updateProjectSession(
  id: string,
  change: (session: ProjectSession) => void,
): ProjectSession {
  const session = readProjectSession(id);
  change(session);
  writeProjectSession(session);
  return session;
}

export function appendProjectEvent(id: string, event: ProjectEvent): void {
  appendJsonl(path.join(projectSessionDir(id), "events.jsonl"), event);
}

export function readProjectEvents(id: string): ProjectEvent[] {
  return readJsonl<ProjectEvent>(path.join(projectSessionDir(id), "events.jsonl"));
}

export interface StoredSubmission {
  number: number;
  result: ProjectResult;
  /** Every test's outcome, hidden ones included. */
  tests: Array<{ id: string; status: string; message: string }>;
  /** The candidate's changes against the starting repository. */
  diff: string;
  stderrTail: string;
}

export function writeSubmission(id: string, submission: StoredSubmission): void {
  const name = String(submission.number).padStart(2, "0");
  writeJson(path.join(projectSessionDir(id), "submissions", `${name}.json`), submission);
}

export function readSubmission(id: string, number: number): StoredSubmission | null {
  const name = String(number).padStart(2, "0");
  return readJson<StoredSubmission>(
    path.join(projectSessionDir(id), "submissions", `${name}.json`),
  );
}

export function listProjectSessions(limit = 50): ProjectSession[] {
  const root = path.join(projectsDir(), "sessions");
  if (!isDir(root)) return [];
  const sessions: ProjectSession[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;
    const session = readJson<ProjectSession>(path.join(root, entry.name, "session.json"));
    if (session) sessions.push(session);
  }
  return sessions.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

// ── Review events ─────────────────────────────────────────────────────────────

/**
 * One `project:<category>` event per bug category the project planted. A category
 * is correct when the session passed and every bug of that category was fixed, so a
 * candidate who fixes the cache bug but not the pagination one sees pagination
 * again sooner.
 */
export function projectReviewEvents(
  session: ProjectSession,
  bugs: readonly PlantedBug[],
  correct: boolean,
  now: number,
): ReviewEvent[] {
  const fixed = new Set(session.verdict?.bugsFixed ?? []);
  const categories = [...new Set([...session.patterns, ...bugs.map((b) => b.pattern)])].filter(
    (p) => isValidSlug(p),
  );
  return categories.map((category) => {
    const ofCategory = bugs.filter((b) => b.pattern === category);
    const event: ReviewEvent = {
      key: makeKey("project", category),
      at: now,
      correct: correct && ofCategory.every((b) => fixed.has(b.id)),
      session: session.id,
      difficulty: session.difficulty,
      hintsUsed: session.hintsUsed.length,
    };
    if (session.startedAt !== undefined && session.endedAt !== undefined)
      event.timeMs = session.endedAt - session.startedAt;
    return event;
  });
}

export function eventsFromProjects(sessions: readonly ProjectSession[]): ReviewEvent[] {
  const events: ReviewEvent[] = [];
  for (const session of sessions) {
    const at = session.endedAt ?? session.createdAt;
    let bugs: PlantedBug[] = [];
    try {
      bugs = readProject(session.project).meta.bugs;
    } catch {
      /* the bundle is gone: its patterns still count */
    }
    if (session.verdict)
      events.push(...projectReviewEvents(session, bugs, session.verdict.correct, at));
    else if (session.abandonedReason !== undefined && session.abandonedReason !== "interrupted")
      events.push(...projectReviewEvents(session, bugs, false, at));
  }
  return events.sort((a, b) => a.at - b.at);
}
