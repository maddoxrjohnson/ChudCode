/**
 * Project sessions: the bundle schema and skeleton, the workspace guards and diff,
 * the flow against a scripted runner, and the bundled examples against real Django
 * when an environment with it is available.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createProjectWorkspace,
  diffRepositories,
  readProjectWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../src/drill/project-workspace.ts";
import { FlowError } from "../src/flow.ts";
import {
  candidateView,
  openProjectFile,
  postProjectMessage,
  projectState,
  recordProject,
  revealProjectHint,
  saveProjectFile,
  startProject,
  submitProject,
  type ProjectRunner,
} from "../src/project-flow.ts";
import { validateProjectBundle as runValidation } from "../src/project-validate.ts";
import type { SuiteResult, SuiteTest } from "../src/runner/process-runner.ts";
import { projectExamplesDir } from "../src/store/paths.ts";
import {
  bugsFixed,
  createProjectSession,
  hiddenTestFiles,
  importProjectExamples,
  newProjectSessionId,
  ProjectValidationError,
  protectedPaths,
  readProject,
  readProjectFrom,
  readSubmission,
  startingRepository,
  validateProjectBundle,
  type ProjectBundle,
} from "../src/store/projects.ts";
import { reviewItems } from "../src/store/review-events.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

const EXAMPLES = ["box-office", "library-loans"];

function example(slug: string): ProjectBundle {
  return readProjectFrom(path.join(projectExamplesDir(), slug));
}

/** A runner that reports every test of a run with the statuses `script` gives. */
function scripted(
  script: (files: Record<string, string>, labels: string[]) => SuiteTest[],
): ProjectRunner {
  return {
    python: async () => "python3",
    run: async (request): Promise<SuiteResult> => ({
      status: "ok",
      tests: script(request.files, request.labels),
      scan: [],
      wallMs: 5,
      stderrTail: "",
    }),
  };
}

const pass = (id: string): SuiteTest => ({ id, status: "pass", message: "" });
const failing = (id: string): SuiteTest => ({
  id,
  status: "fail",
  message: `AssertionError in ${id}`,
});

describe("project bundles", () => {
  it("reads both bundled examples", () => {
    for (const slug of EXAMPLES) {
      const bundle = example(slug);
      expect(bundle.meta.slug).toBe(slug);
      expect(bundle.meta.bugs.length).toBeGreaterThanOrEqual(3);
      expect(bundle.statement).toMatch(/Reported issues/);
    }
  });

  it("lays out the skeleton, the app, and the visible tests", () => {
    const bundle = example("library-loans");
    const repo = startingRepository(bundle);
    expect(repo["manage.py"]).toMatch(/config\.settings/);
    expect(repo["config/settings.py"]).toMatch(/"rest_framework"/);
    expect(repo["config/settings.py"]).toMatch(/"library"/);
    expect(repo["config/urls.py"]).toMatch(/include\("library\.urls"\)/);
    expect(repo["library/apps.py"]).toMatch(/class LibraryConfig/);
    expect(repo["tests/test_books.py"]).toBeDefined();
    expect(Object.keys(repo).some((p) => p.startsWith("hidden_tests/"))).toBe(false);
    expect(Object.keys(hiddenTestFiles(bundle))).toContain("hidden_tests/test_hidden.py");
    expect(protectedPaths(bundle)).toEqual([
      "config/settings.py",
      "manage.py",
      "tests/__init__.py",
      "tests/test_books.py",
    ]);
  });

  it("rejects paths that escape, reserved paths, and unknown categories", () => {
    const bundle = example("box-office");
    const bad = {
      ...bundle,
      meta: {
        ...bundle.meta,
        bugs: [{ ...bundle.meta.bugs[0]!, pattern: "vibes", tests: ["not a test"] }],
      },
      files: { ...bundle.files, "../escape.py": "x", "tests/test_mine.py": "x", "a/b.exe": "x" },
    };
    try {
      validateProjectBundle(bad);
      expect.unreachable();
    } catch (err) {
      const problems = (err as ProjectValidationError).problems.join("\n");
      expect(problems).toMatch(/\.\.\/escape\.py is not a plain relative path/);
      expect(problems).toMatch(/tests\/test_mine\.py is reserved/);
      expect(problems).toMatch(/a\/b\.exe is not a plain relative path/);
      expect(problems).toMatch(/bugs\[0\]\.pattern must be one of/);
      expect(problems).toMatch(/Class\.test_method/);
    }
  });

  it("counts a bug fixed only when every one of its tests passed", () => {
    const bugs = example("box-office").meta.bugs;
    const tests = bugs.flatMap((b) => b.tests.map((t) => pass(`hidden_tests.test_hidden.${t}`)));
    tests[0] = failing(tests[0]!.id);
    const fixed = bugsFixed(bugs, tests);
    expect(fixed).not.toContain(bugs[0]!.id);
    expect(fixed).toEqual(bugs.slice(1).map((b) => b.id));
    expect(bugsFixed(bugs, [])).toEqual([]);
  });
});

describe("project workspaces", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = makeFixture();
  });
  afterEach(() => fixture.cleanup());

  it("writes the repository and reads it back without tooling or the database", async () => {
    const bundle = example("box-office");
    const dir = await createProjectWorkspace("20261027-1200-project-box-office-ab12", bundle);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toMatch(/## Read-only files/);
    fs.writeFileSync(path.join(dir, "db.sqlite3"), "binary");
    fs.mkdirSync(path.join(dir, "boxoffice", "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(dir, "boxoffice", "__pycache__", "views.py"), "cached");
    const files = readProjectWorkspace(dir);
    expect(files).toEqual(startingRepository(bundle));
  });

  it("refuses paths out of the workspace and through links", async () => {
    const dir = await createProjectWorkspace(
      "20261027-1200-project-box-office-ab13",
      example("box-office"),
    );
    expect(() => readWorkspaceFile(dir, "../outside.py")).toThrow(/not a project file/);
    expect(() => writeWorkspaceFile(dir, "/etc/passwd.py", "x")).toThrow(/not a project file/);
    expect(() => writeWorkspaceFile(dir, "nowhere/new.py", "x")).toThrow(/does not exist/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-outside-"));
    try {
      fs.symlinkSync(outside, path.join(dir, "linked"));
      expect(() => writeWorkspaceFile(dir, "linked/evil.py", "x")).toThrow(/not a folder/);
      expect(fs.existsSync(path.join(outside, "evil.py"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("diffs the changed lines with context, new files, and deletions", () => {
    const before = { "a.py": "one\ntwo\nthree\nfour\nfive\nsix\nseven", "gone.py": "x" };
    const after = { "a.py": "one\ntwo\nTHREE\nfour\nfive\nsix\nseven", "new.py": "y" };
    const diff = diffRepositories(before, after);
    expect(diff).toContain("--- a.py");
    expect(diff).toContain("-three\n+THREE");
    expect(diff).toContain(" two");
    expect(diff).not.toContain(" six");
    expect(diff).toContain("+++ new.py (new)");
    expect(diff).toContain("+++ /dev/null (deleted)");
    expect(diffRepositories(before, before)).toBe("");
  });
});

describe("project flow", () => {
  let fixture: Fixture;
  let bundle: ProjectBundle;
  beforeEach(() => {
    fixture = makeFixture();
    importProjectExamples();
    bundle = readProject("box-office");
  });
  afterEach(() => fixture.cleanup());

  async function newSession(oa = false) {
    const id = newProjectSessionId("box-office", Date.now());
    const workspace = await createProjectWorkspace(id, bundle);
    return createProjectSession(id, { project: bundle, oa, timerMs: 45 * 60_000, workspace });
  }

  /** Hidden tests pass for the bugs whose files hold their fix. */
  const realistic = scripted((files, labels) => {
    const tests: SuiteTest[] = [pass("tests.test_events.EventApiTests.test_create_event")];
    if (!labels.includes("hidden_tests")) return tests;
    for (const bug of bundle.meta.bugs) {
      const fixedHere = bug.files.every((f) => files[f] === (bundle.fix[f] ?? bundle.files[f]));
      for (const t of bug.tests)
        tests.push(
          fixedHere
            ? pass(`hidden_tests.test_hidden.${t}`)
            : failing(`hidden_tests.test_hidden.${t}`),
        );
    }
    return tests;
  });

  it("imports the examples as validated", () => {
    expect(readProject("box-office").meta.validatedAt).toBeDefined();
    expect(readProject("library-loans").meta.validatedAt).toBeDefined();
  });

  it("needs Start before files change, and never lets a read-only file change", async () => {
    const session = await newSession();
    expect(() => saveProjectFile(session.id, "boxoffice/views.py", "x")).toThrow(/Press Start/);
    startProject(session.id);
    expect(() => saveProjectFile(session.id, "tests/test_events.py", "x")).toThrow(/read-only/);
    const tree = saveProjectFile(
      session.id,
      "boxoffice/views.py",
      bundle.fix["boxoffice/views.py"]!,
    );
    expect(tree.find((f) => f.path === "boxoffice/views.py")).toMatchObject({
      changed: true,
      readOnly: false,
    });
    expect(openProjectFile(session.id, "manage.py").readOnly).toBe(true);
  });

  it("refuses a submission that changed a read-only file, without counting it", async () => {
    const session = await newSession();
    startProject(session.id);
    fs.appendFileSync(path.join(session.workspace, "tests", "test_events.py"), "\n# skip it\n");
    const result = await submitProject(session.id, realistic);
    expect(result.status).toBe("protected");
    expect(result.protectedChanged).toEqual(["tests/test_events.py"]);
    expect(projectState(session.id).session.submissions).toBe(0);
  });

  it("records which bugs a submission fixed, and shows hidden tests by number only", async () => {
    const session = await newSession();
    startProject(session.id);
    saveProjectFile(session.id, "boxoffice/views.py", bundle.fix["boxoffice/views.py"]!);
    const result = await submitProject(session.id, realistic);
    expect(result.number).toBe(1);
    const hidden = result.tests.filter((t) => t.hidden);
    expect(hidden.length).toBeGreaterThan(0);
    for (const t of hidden) {
      expect(t.label).toMatch(/^Hidden \d+$/);
      expect(t.message).toBeUndefined();
      expect(JSON.stringify(t)).not.toMatch(/FilterTests|PaginationTests/);
    }
    const stored = readSubmission(session.id, 1)!;
    expect(stored.result.bugsFixed).toEqual(["filters"]);
    expect(stored.diff).toContain("+        events = events.filter(city__iexact=city)");
  });

  it("hides a hidden test's traceback when the run fails to import it", () => {
    const view = candidateView(
      { kind: "submit", status: "error", passed: 0, total: 0, at: 0 },
      [],
      'File "hidden_tests/test_hidden.py", line 3\nImportError: cannot import name Booking',
    );
    expect(view.error).not.toMatch(/test_hidden/);
    expect(view.error).toMatch(/hidden test could not import/);
  });

  it("keeps an online assessment silent: no candidate messages or hints while the clock runs", async () => {
    const session = await newSession(true);
    startProject(session.id);
    expect(() => postProjectMessage(session.id, "candidate", "is this right?")).toThrow(FlowError);
    expect(() => revealProjectHint(session.id)).toThrow(/no hints/);
    expect(revealProjectHint(session.id, 1, "interviewer").hint.level).toBe(1);
  });

  it("scores the session and schedules each bug category", async () => {
    const session = await newSession();
    startProject(session.id);
    for (const [file, text] of Object.entries(bundle.fix)) saveProjectFile(session.id, file, text);
    await submitProject(session.id, realistic);
    const outcome = recordProject(session.id, {
      scores: { correctness: 4, debugging: 3, codeQuality: 3, time: 3 },
      rootCauseOk: true,
      notesMd: "Good.",
      strengths: ["a", "b"],
      improvements: ["c", "d"],
    });
    expect(outcome.session.verdict).toMatchObject({ correct: true, bugsTotal: 5 });
    expect(outcome.session.verdict?.bugsFixed).toHaveLength(5);
    const keys = outcome.reviewEvents.map((e) => e.key).sort();
    expect(keys).toEqual([
      "project:caching",
      "project:input-validation",
      "project:orm-queries",
      "project:pagination",
    ]);
    expect(reviewItems().filter((i) => i.kind === "project")).toHaveLength(4);
    expect(() =>
      recordProject(session.id, {
        scores: { correctness: 4, debugging: 3, codeQuality: 3, time: 3 },
        rootCauseOk: true,
        notesMd: "",
        strengths: [],
        improvements: [],
      }),
    ).toThrow(/already recorded/);
  });

  it("marks a category missed when one of its bugs stayed open", async () => {
    const session = await newSession();
    startProject(session.id);
    saveProjectFile(session.id, "boxoffice/views.py", bundle.fix["boxoffice/views.py"]!);
    await submitProject(session.id, realistic);
    const outcome = recordProject(session.id, {
      scores: { correctness: 1, debugging: 2, codeQuality: 2, time: 1 },
      rootCauseOk: true,
      notesMd: "",
      strengths: [],
      improvements: [],
    });
    const byKey = Object.fromEntries(outcome.reviewEvents.map((e) => [e.key, e.correct]));
    expect(outcome.session.verdict?.correct).toBe(false);
    expect(byKey["project:orm-queries"]).toBe(false);
  });
});

/** An interpreter that has Django, when one is around: the env override or the built env. */
function djangoPython(): string | null {
  const override = process.env["CHUDCODE_DJANGO_PYTHON"];
  if (override && fs.existsSync(override)) return override;
  const built = path.join(os.homedir(), ".chudcode", "envs", "django-5.2", "bin", "python");
  return fs.existsSync(built) ? built : null;
}

const python = djangoPython();

describe.skipIf(!python)("bundled projects against real Django", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = makeFixture();
  });
  afterEach(() => fixture.cleanup());

  it.each(EXAMPLES)(
    "%s: every bug is proven planted and the fix passes everything",
    async (slug) => {
      const { processRunner } = await import("../src/runner/process-runner.ts");
      const report = await runValidation(example(slug), {
        python: async () => python as string,
        run: (request) => processRunner.runProject(request),
      });
      expect(report.problems).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.visibleFailing).toBeGreaterThan(0);
    },
    120_000,
  );
});
