import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCurriculum } from "../src/curriculum.ts";
import {
  CHECK_IDS,
  inspectMedia,
  listMediaFiles,
  loadMediaChecks,
  matchUrlToFile,
  MEDIA_LIMITS,
  mediaChecksErrors,
  readVisual,
  resolveRef,
  type MediaSnapshot,
} from "../src/media-lab.ts";
import { png } from "./media-fixtures.ts";
import { put, writeSite } from "./media-site.ts";

let project: string;

beforeEach(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-media-")));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

const status = (snap: MediaSnapshot, id: string) => snap.checks.find((c) => c.id === id)?.status;

describe("the checks file", () => {
  it("lists every check once, each resting on curriculum facts or a stated basis", () => {
    const facts = new Set(
      loadCurriculum().modules.flatMap((m) => m.lessons.flatMap((l) => l.facts.map((f) => f.id))),
    );
    expect(mediaChecksErrors(loadMediaChecks(), facts)).toEqual([]);
    expect(
      loadMediaChecks()
        .checks.map((c) => c.id)
        .sort(),
    ).toEqual([...CHECK_IDS].sort());
  });

  it("reports drift between the data file and the engine", () => {
    const data = structuredClone(loadMediaChecks());
    data.checks = data.checks.filter((c) => c.id !== "img-alt");
    data.checks.push({
      id: "made-up",
      severity: "fail",
      title: "A check nobody wrote",
      facts: ["nope"],
    });
    expect(mediaChecksErrors(data, new Set())).toEqual(
      expect.arrayContaining([
        "unknown check made-up",
        "check made-up: unknown fact nope",
        "check img-alt is missing from the data file",
      ]),
    );
  });
});

describe("listMediaFiles", () => {
  it("finds site pages, the README, and media, and never denied or outside files", () => {
    writeSite(project, "good");
    put(project, "node_modules/pkg/logo.png", png(10, 10));
    put(project, "secrets/key.png", png(10, 10));
    put(project, "src/notes.html", "<p>not a site page</p>");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-media-out-"));
    put(outside, "private.png", png(10, 10));
    fs.symlinkSync(path.join(outside, "private.png"), path.join(project, "docs", "linked.png"));
    try {
      const listing = listMediaFiles(project);
      expect(listing.pages.map((p) => p.path)).toEqual(["docs/index.html", "docs/guide.html"]);
      expect(listing.readme?.path).toBe("README.md");
      expect(listing.media.map((m) => m.path).sort()).toEqual([
        "docs/media/demo.gif",
        "docs/media/demo.mp4",
        "docs/media/og.png",
        "docs/media/poster.jpg",
        "docs/media/shot.png",
      ]);
      expect(listing.skipped).toEqual([
        { path: "docs/linked.png", reason: "a link to a file outside the project" },
      ]);
      expect(listing.servedAtRoot).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("knows a site served from / by its CNAME or repository name", () => {
    put(project, "docs/CNAME", "tally.app\n");
    expect(listMediaFiles(project).servedAtRoot).toBe(true);
    const user = path.join(project, "maddo.github.io");
    put(user, "index.html", "<title>Me</title>");
    expect(listMediaFiles(user).servedAtRoot).toBe(true);
  });
});

describe("resolving references", () => {
  it("resolves relative and root-absolute links inside the project, and nothing outside", () => {
    expect(resolveRef("docs/index.html", "media/a.png", project)).toBe("docs/media/a.png");
    expect(resolveRef("docs/index.html", "/media/a.png", project)).toBe("docs/media/a.png");
    expect(resolveRef("README.md", "docs/a.png", project)).toBe("docs/a.png");
    expect(resolveRef("docs/index.html", "../../etc/passwd", project)).toBeNull();
    expect(resolveRef("docs/index.html", "https://x.test/a.png", project)).toBeNull();
  });

  it("matches an absolute og:image URL to the local file with the longest path suffix", () => {
    const files = ["docs/media/og.png", "docs/og.png", "assets/media/og.png"];
    expect(matchUrlToFile("https://maddo.github.io/tally/media/og.png", files)).toBe(
      "docs/media/og.png",
    );
    expect(matchUrlToFile("https://x.test/other.png", files)).toBeNull();
    expect(matchUrlToFile("not a url", files)).toBeNull();
  });
});

describe("inspectMedia", () => {
  it("passes a polished site and picks the og image, the poster, and a screenshot to show", () => {
    writeSite(project, "good");
    const snap = inspectMedia(project, 1);
    const failing = snap.checks.filter((c) => c.status === "fail" || c.status === "warn");
    expect(failing.map((c) => [c.id, c.findings])).toEqual([]);
    expect(snap.gatePassed).toBe(true);
    expect(status(snap, "video-faststart")).toBe("pass");
    expect(status(snap, "video-captions")).toBe("n/a");
    expect(snap.visuals.map((v) => [v.path, v.role, v.mimeType])).toEqual([
      ["docs/media/og.png", "og-image", "image/png"],
      ["docs/media/poster.jpg", "poster", "image/jpeg"],
      ["docs/media/shot.png", "image", "image/png"],
    ]);
    const bytes = readVisual(project, snap.visuals[0]!);
    expect(bytes?.subarray(1, 4).toString()).toBe("PNG");
    const index = snap.pages.find((p) => p.path === "docs/index.html");
    // The demo has preload=metadata but autoplays, so it counts toward the first load.
    expect(index?.weightBytes).toBeGreaterThan(
      fs.statSync(path.join(project, "docs/media/demo.mp4")).size,
    );
  });

  it("fails the mistakes a first attempt makes, naming file and line", () => {
    writeSite(project, "bad");
    const snap = inspectMedia(project, 1);
    expect(snap.gatePassed).toBe(false);
    const byId = Object.fromEntries(snap.checks.map((c) => [c.id, c]));
    expect(byId["video-codec"]).toMatchObject({
      status: "fail",
      findings: ["docs/media/slow.mp4 is hvc1"],
    });
    expect(byId["video-faststart"]?.status).toBe("fail");
    expect(byId["autoplay-muted"]).toMatchObject({
      status: "fail",
      findings: ["docs/index.html:7 autoplays without muted"],
    });
    expect(byId["autoplay-playsinline"]?.status).toBe("warn");
    expect(byId["video-poster"]?.status).toBe("warn");
    expect(byId["video-captions"]?.status).toBe("warn");
    expect(byId["video-length"]?.findings).toEqual(["docs/media/slow.mp4 runs 240 s"]);
    expect(byId["video-resolution"]?.status).toBe("warn");
    expect(byId["img-alt"]).toMatchObject({
      status: "fail",
      findings: ["docs/index.html:8 media/shot.png has no alt attribute"],
    });
    expect(byId["img-dimensions"]?.status).toBe("warn");
    expect(byId["lazy-first-image"]?.status).toBe("warn");
    expect(byId["missing-file"]?.findings).toEqual([
      "docs/index.html:9 references media/missing.png, which is not in the project",
    ]);
    expect(byId["og-image"]?.status).toBe("fail");
    expect(byId["og-required"]?.findings).toEqual([
      "docs/index.html has no og:title, og:type, og:url",
    ]);
    expect(byId["root-absolute-links"]?.findings).toEqual([
      "docs/index.html:10 links to /guide.html",
    ]);
    expect(byId["repo-file-blocked"]?.status).toBe("pass");
    expect(snap.visuals.map((v) => v.path)).toEqual(["docs/media/shot.png", "docs/media/demo.gif"]);
  });

  it("allows root-absolute links when the site is served from /", () => {
    writeSite(project, "bad");
    put(project, "docs/CNAME", "tally.app");
    expect(status(inspectMedia(project, 1), "root-absolute-links")).toBe("n/a");
  });

  it("says when there is nothing to measure, and checks a relative og:image", () => {
    put(project, "notes.txt", "hello");
    const empty = inspectMedia(project, 1);
    expect(status(empty, "something-to-measure")).toBe("fail");
    expect(empty.gatePassed).toBe(false);

    put(project, "index.html", '<meta property="og:image" content="og.png"><title>x</title>');
    put(project, "og.png", png(400, 400));
    const snap = inspectMedia(project, 1);
    expect(snap.checks.find((c) => c.id === "og-image-shape")?.findings).toEqual([
      "index.html: og:image is og.png; link previews need an absolute URL",
      "og.png is 400×400 (ratio 1.00)",
    ]);
  });

  it("caps what it reads and shows", () => {
    for (let i = 0; i < MEDIA_LIMITS.media + 5; i++)
      put(project, `media/${String(i).padStart(3, "0")}.png`, png(10, 10));
    put(
      project,
      "big.png",
      Buffer.concat([png(2000, 1000), Buffer.alloc(MEDIA_LIMITS.visualBytes)]),
    );
    put(project, "index.html", '<img src="big.png" alt="big" width="2000" height="1000">');
    const snap = inspectMedia(project, 1);
    expect(snap.media.length).toBeLessThanOrEqual(MEDIA_LIMITS.media);
    expect(snap.skipped.some((s) => s.reason.includes("file limit"))).toBe(true);
    expect(snap.visuals.map((v) => v.path)).not.toContain("big.png");
  });
});
