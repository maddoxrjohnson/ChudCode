import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCurriculum } from "../src/curriculum.ts";
import {
  allowedPattern,
  CLAUDE_MD_LINES,
  frontmatter,
  inspectProject,
  isDenied,
  LAB_ALLOW,
  LAB_LIMITS,
  LabError,
  lintLab,
  listLabFiles,
  matchesPattern,
  redactSecrets,
  resolveProjectRoot,
  SKILL_LINES,
  type LabFile,
} from "../src/lab.ts";

let base: string;
let home: string;
let state: string;
let project: string;

function put(relative: string, content: string): void {
  const file = path.join(project, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-lab-")));
  home = path.join(base, "home");
  state = path.join(home, ".chudcode");
  project = path.join(home, "code", "app");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("resolveProjectRoot", () => {
  const guards = () => ({ home, stateRoot: state });

  it("accepts a project folder, by absolute path or from ~", () => {
    expect(resolveProjectRoot(project, guards())).toBe(project);
    expect(resolveProjectRoot("~/code/app", guards())).toBe(project);
  });

  it.each([
    ["/", "root"],
    ["~", "home"],
    ["home-parent", "above home"],
    ["~/.chudcode", "ChudCode state"],
    ["relative/path", "relative"],
    ["~/nope", "missing"],
  ])("refuses %s (%s)", (input) => {
    const value = input === "home-parent" ? path.dirname(home) : input;
    expect(() => resolveProjectRoot(value, guards())).toThrow(LabError);
  });

  it("refuses a folder that contains ChudCode's state", () => {
    const outer = path.join(base, "outer");
    fs.mkdirSync(path.join(outer, "state"), { recursive: true });
    expect(() => resolveProjectRoot(outer, { home, stateRoot: path.join(outer, "state") })).toThrow(
      /ChudCode's own state/,
    );
  });

  it("refuses a file, and resolves a symlinked folder to its target", () => {
    put("README.md", "hi");
    expect(() => resolveProjectRoot(path.join(project, "README.md"), guards())).toThrow(
      /not a directory/,
    );
    const link = path.join(home, "link");
    fs.symlinkSync(project, link);
    expect(resolveProjectRoot(link, guards())).toBe(project);
    fs.symlinkSync(home, path.join(home, "code", "back-home"));
    expect(() => resolveProjectRoot(path.join(home, "code", "back-home"), guards())).toThrow(
      /home directory/,
    );
  });
});

describe("patterns", () => {
  it("matches * within a segment and **/ across segments", () => {
    expect(matchesPattern(".claude/skills/review/SKILL.md", ".claude/skills/*/SKILL.md")).toBe(
      true,
    );
    expect(matchesPattern(".claude/skills/a/b/SKILL.md", ".claude/skills/*/SKILL.md")).toBe(false);
    expect(matchesPattern(".claude/agents/x.md", ".claude/agents/**/*.md")).toBe(true);
    expect(matchesPattern(".claude/agents/team/x.md", ".claude/agents/**/*.md")).toBe(true);
    expect(matchesPattern("CLAUDExmd", "CLAUDE.md")).toBe(false);
  });

  it("denies secrets and git internals whatever the pattern", () => {
    expect(isDenied(".env")).toBe(true);
    expect(isDenied(".env.local")).toBe(true);
    expect(isDenied(".claude/agents/secret-keeper.md")).toBe(true);
    expect(isDenied(".git/config")).toBe(true);
    expect(isDenied("deploy.pem")).toBe(true);
    expect(isDenied(".claude/agents/reviewer.md")).toBe(false);
  });

  it("every lab file a lesson names is on the allow-list", () => {
    for (const module of loadCurriculum().modules)
      for (const lesson of module.lessons)
        for (const pattern of lesson.labFiles ?? []) expect(allowedPattern(pattern)).toBe(true);
  });
});

describe("listLabFiles", () => {
  it("lists only allowed files, skips denied and escaping links, and dedupes", () => {
    put("CLAUDE.md", "# Project\n");
    put("src/CLAUDE.md", "not read: only the root and .claude are walked");
    put(".claude/agents/reviewer.md", "---\nname: reviewer\n---\n");
    put(".claude/agents/secret-keeper.md", "---\nname: x\n---\n");
    put(".claude/settings.json", "{}");
    put(".env", "TOKEN=abc");
    fs.writeFileSync(path.join(base, "outside.md"), "outside");
    fs.symlinkSync(path.join(base, "outside.md"), path.join(project, "AGENTS.md"));
    fs.symlinkSync(path.join(project, "CLAUDE.md"), path.join(project, "CLAUDE.local.md"));

    const listing = listLabFiles(project, [...LAB_ALLOW]);
    expect(listing.files.map((f) => f.path)).toEqual([
      ".claude/agents/reviewer.md",
      ".claude/settings.json",
      "CLAUDE.local.md",
    ]);
    expect(listing.skipped).toEqual([
      { path: ".claude/agents/secret-keeper.md", reason: "never read: it may hold secrets" },
      { path: "AGENTS.md", reason: "a link to a file outside the project" },
    ]);
  });

  it("ignores patterns that are not on the allow-list", () => {
    put("package.json", "{}");
    put("CLAUDE.md", "x");
    expect(listLabFiles(project, ["package.json", "CLAUDE.md"]).files.map((f) => f.path)).toEqual([
      "CLAUDE.md",
    ]);
  });

  it("caps the number of files", () => {
    for (let i = 0; i < LAB_LIMITS.files + 3; i++)
      put(`.claude/agents/a${String(i).padStart(2, "0")}.md`, "x");
    const listing = listLabFiles(project, [".claude/agents/**/*.md"]);
    expect(listing.files).toHaveLength(LAB_LIMITS.files);
    expect(listing.skipped).toHaveLength(3);
  });
});

describe("redactSecrets", () => {
  it("redacts tokens and keys, keeping the label", () => {
    const { text, redactions } = redactSecrets(
      [
        "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuv",
        'password: "hunter2hunter2"',
        "aws AKIAABCDEFGHIJKLMNOP",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
        "run npm test",
      ].join("\n"),
    );
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("AKIA");
    expect(text).not.toContain("MIIE");
    expect(text).toContain('password: "[redacted]"');
    expect(text).toContain("run npm test");
    expect(redactions).toBeGreaterThanOrEqual(4);
  });
});

describe("inspectProject", () => {
  it("reads, truncates, redacts, and logs git history", async () => {
    put("CLAUDE.md", "# App\n\nRun `npm test`.\nToken: ghp_abcdefghijklmnopqrstuvwx1234\n");
    put("progress.md", "x".repeat(LAB_LIMITS.fileBytes + 10));
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync(
      "git",
      ["-c", "user.name=T", "-c", "user.email=t@example.com", "add", "CLAUDE.md"],
      { cwd: project },
    );
    execFileSync(
      "git",
      ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "Add CLAUDE.md"],
      { cwd: project },
    );

    const snap = await inspectProject(project, ["CLAUDE.md", "progress.md"], 1000);
    expect(snap.at).toBe(1000);
    const claude = snap.files.find((f) => f.path === "CLAUDE.md");
    expect(claude?.content).toContain("[redacted]");
    expect(claude?.content).not.toContain("ghp_");
    expect(claude?.redactions).toBe(1);
    const progress = snap.files.find((f) => f.path === "progress.md");
    expect(progress?.truncated).toBe(true);
    expect(progress?.content.length).toBe(LAB_LIMITS.fileBytes);
    expect(snap.gitLog).toMatch(/Add CLAUDE\.md/);
    expect(snap.gitLog).toMatch(/CLAUDE\.md \| /);
  });

  it("has no git log outside a repository", async () => {
    put("CLAUDE.md", "x");
    expect((await inspectProject(project, ["CLAUDE.md"])).gitLog).toBeNull();
  });
});

describe("lints", () => {
  const file = (p: string, content: string): LabFile => ({
    path: p,
    bytes: content.length,
    lines: content.split("\n").length,
    sha256: "",
    truncated: false,
    redactions: 0,
    content,
  });

  it("reads frontmatter keys and lines", () => {
    expect(frontmatter("---\nname: a\nmodel: 'opus'\n---\nbody")).toEqual(
      new Map([
        ["name", { value: "a", line: 2 }],
        ["model", { value: "opus", line: 3 }],
      ]),
    );
    expect(frontmatter("no frontmatter")).toBeNull();
  });

  it("flags subagent fields the docs do not list, and bad model and effort values", () => {
    const lints = lintLab([
      file(
        ".claude/agents/fast.md",
        "---\nname: fast\ndescription: Quick search\nmodel: gpt-5\neffort: extreme\ntemperature: 0\n---\nBody",
      ),
      file(".claude/agents/ok.md", "---\nname: ok\ndescription: d\nmodel: claude-haiku-5-5\n---\n"),
      file(".claude/agents/bare.md", "Just a prompt"),
      file(".claude/agents/half.md", "---\nname: half\n---\n"),
    ]);
    expect(lints.map((l) => [l.file, l.id, l.line])).toEqual([
      [".claude/agents/fast.md", "subagent-unknown-field", 6],
      [".claude/agents/fast.md", "subagent-bad-model", 4],
      [".claude/agents/fast.md", "subagent-bad-effort", 5],
      [".claude/agents/bare.md", "subagent-no-frontmatter", 1],
      [".claude/agents/half.md", "subagent-missing-field", 1],
    ]);
  });

  it("flags a long CLAUDE.md, a shadowed AGENTS.md, and broken settings", () => {
    const long = Array.from({ length: CLAUDE_MD_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
    const lints = lintLab([
      file("CLAUDE.md", long),
      file("AGENTS.md", "# Agents"),
      file(".claude/settings.json", "{ nope"),
    ]);
    expect(lints.map((l) => l.id)).toEqual([
      "claude-md-long",
      "agents-md-shadowed",
      "settings-invalid-json",
    ]);
    expect(lintLab([file("CLAUDE.md", "@AGENTS.md\n"), file("AGENTS.md", "x")])).toEqual([]);
  });

  it("rests every lint on a fact the curriculum has", () => {
    const facts = new Set(
      loadCurriculum().modules.flatMap((m) => m.lessons.flatMap((l) => l.facts.map((f) => f.id))),
    );
    const lints = lintLab([
      file("CLAUDE.md", "x\n".repeat(CLAUDE_MD_LINES + 1)),
      file("AGENTS.md", "x"),
      file(".claude/agents/a.md", "---\nfoo: 1\nmodel: x\neffort: y\n---\n"),
      file(".claude/agents/b.md", "nothing"),
      file(".claude/skills/a/SKILL.md", "---\nname: a\ntriggers: x\n---\n" + "x\n".repeat(600)),
      file(
        ".claude/settings.json",
        JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
      ),
      file(".claude/skills/b/SKILL.md", `---\ndescription: ${"d".repeat(2000)}\n---\n`),
      file("x/.claude/settings.json", JSON.stringify({ permissions: { defaultMode: "yolo" } })),
    ]);
    for (const lint of lints) if (lint.fact) expect(facts.has(lint.fact)).toBe(true);
    expect(lints.length).toBeGreaterThanOrEqual(10);
  });

  it("reads a block-scalar description", () => {
    expect(
      frontmatter("---\ndescription: >\n  Use when the\n  user asks.\nname: x\n---\n")?.get(
        "description",
      ),
    ).toEqual({ value: "Use when the user asks.", line: 2 });
  });

  it("flags skills with no description, unknown fields, and long bodies", () => {
    const lints = lintLab([
      file(".claude/skills/deploy/SKILL.md", "---\nname: deploy\ntriggers: ship it\n---\nBody"),
      file(
        ".claude/skills/review/SKILL.md",
        `---\ndescription: ${"Review. ".repeat(150)}\nwhen_to_use: ${"x".repeat(400)}\n---\n${"line\n".repeat(SKILL_LINES + 1)}`,
      ),
      file(".claude/skills/ok/SKILL.md", "---\ndescription: Use when asked to ok.\n---\nBody"),
      file(".claude/skills/ok/reference.md", "no frontmatter needed here"),
    ]);
    expect(lints.map((l) => [l.file, l.id])).toEqual([
      [".claude/skills/deploy/SKILL.md", "skill-no-description"],
      [".claude/skills/deploy/SKILL.md", "skill-unknown-field"],
      [".claude/skills/review/SKILL.md", "skill-description-long"],
      [".claude/skills/review/SKILL.md", "skill-long"],
    ]);
  });

  it("flags a bad or bypassing default mode and allow rules that hand over a tool", () => {
    const lint = (settings: unknown) =>
      lintLab([file(".claude/settings.json", JSON.stringify(settings))]).map((l) => l.id);
    expect(lint({ permissions: { defaultMode: "yolo" } })).toEqual(["settings-bad-mode"]);
    expect(lint({ permissions: { defaultMode: "bypassPermissions" } })).toEqual([
      "settings-bypass-default",
    ]);
    expect(
      lint({ permissions: { defaultMode: "acceptEdits", allow: ["Bash", "Bash(npm test)"] } }),
    ).toEqual(["settings-broad-allow"]);
    expect(lint({ permissions: { allow: ["Bash(git diff *)"], deny: ["Read(.env)"] } })).toEqual(
      [],
    );
    expect(lint({ model: "opus" })).toEqual([]);
  });
});
