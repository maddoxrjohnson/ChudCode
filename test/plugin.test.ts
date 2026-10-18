/**
 * The Claude Code plugin manifest and skills: JSON and Markdown that no compiler
 * checks, so these tests catch a renamed entry point or a skill naming a tool that
 * does not exist.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { CandidateInbox, MAX_WAIT_SECONDS, McpSession } from "../src/mcp.ts";
import { packageRoot } from "../src/store/paths.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const readJson = (relative: string) =>
  JSON.parse(fs.readFileSync(path.join(packageRoot(), relative), "utf8")) as Record<string, any>;

describe("Claude Code plugin", () => {
  const manifest = readJson(".claude-plugin/plugin.json");

  it("runs the MCP launcher from the plugin root", () => {
    expect(manifest["mcpServers"].chudcode.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/mcp/launch.mjs"]);
    expect(fs.existsSync(path.join(packageRoot(), "mcp/launch.mjs"))).toBe(true);
  });

  it("lets the longest wait finish", () => {
    expect(manifest["mcpServers"].chudcode.timeout).toBeGreaterThan(MAX_WAIT_SECONDS * 1000);
  });

  it("matches the package version", () => {
    expect(manifest["version"]).toBe(readJson("package.json")["version"]);
  });

  it("names the author and no one else", () => {
    expect(manifest["author"]).toEqual({ name: "Maddox Johnson" });
    expect(manifest["contributors"]).toBeUndefined();
  });

  it("is listed by the marketplace at the repository root", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    expect(marketplace["plugins"]).toEqual([
      expect.objectContaining({ name: manifest["name"], source: "./" }),
    ]);
  });
});

describe("Pi package", () => {
  const pkg = readJson("package.json");

  it("points Pi at an extension entry that exists", () => {
    expect(pkg["pi"]).toEqual({ extensions: ["./pi/index.ts"] });
    expect(fs.existsSync(path.join(packageRoot(), "pi/index.ts"))).toBe(true);
  });
});

describe("skills", () => {
  const known = new McpSession(new CandidateInbox()).toolNames();

  it.each(["interview", "review", "roadmap", "dashboard", "research"])(
    "%s has frontmatter and names only tools the server lists",
    (skill) => {
      const body = fs.readFileSync(path.join(packageRoot(), "skills", skill, "SKILL.md"), "utf8");
      expect(body).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---\\n`));
      const tools = [...body.matchAll(/`([a-z_]+)`/g)]
        .map((m) => m[1])
        .filter((t) => t && t.includes("_"));
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) expect(known).toContain(tool);
    },
  );
});
