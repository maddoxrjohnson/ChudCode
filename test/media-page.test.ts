import { describe, expect, it } from "vitest";

import { isLocalRef, localPath, scanMarkdown, scanPage } from "../src/media/page.ts";

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tally &amp; Co</title>
  <meta property="og:title" content="Tally">
  <meta property="og:image" content="https://example.github.io/tally/og.png">
  <meta property="og:image" content="ignored-second.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="description" content="Budgets that add up.">
  <link rel="stylesheet" href="style.css">
  <link rel="icon" href="/favicon.ico">
  <!-- <img src="commented.png"> -->
  <script>const fake = '<img src="in-script.png">';</script>
  <script src="app.js" defer></script>
</head>
<body>
  <img src="hero.png" alt="The Tally budget screen" width="1200" height="630">
  <img src='media/shot%202.webp' alt="" loading=lazy>
  <img src="https://cdn.example.com/badge.svg">
  <video autoplay muted playsinline loop poster="media/poster.jpg" preload="metadata">
    <source src="media/demo.webm" type="video/webm">
    <source src="media/demo.mp4?v=2" type="video/mp4">
    <track kind="captions" src="media/demo.en.vtt" srclang="en">
  </video>
  <video src="/media/tour.mp4" controls></video>
  <iframe src="https://www.youtube.com/embed/abc"></iframe>
</body>
</html>`;

describe("scanPage", () => {
  const scan = scanPage(PAGE);

  it("collects the link-preview tags, first value winning", () => {
    expect(scan.title).toBe("Tally & Co");
    expect(scan.lang).toBe("en");
    expect(scan.viewport).toBe(true);
    expect(scan.meta).toEqual({
      "og:title": "Tally",
      "og:image": "https://example.github.io/tally/og.png",
      "twitter:card": "summary_large_image",
      description: "Budgets that add up.",
    });
  });

  it("reads images with alt and size, skipping comments and script bodies", () => {
    expect(scan.images.map((i) => [i.src, i.alt, i.width, i.loading])).toEqual([
      ["hero.png", "The Tally budget screen", "1200", null],
      ["media/shot%202.webp", "", null, "lazy"],
      ["https://cdn.example.com/badge.svg", null, null, null],
    ]);
    expect(scan.images[0]?.line).toBe(19);
  });

  it("reads each video's playback attributes, sources, poster, and captions", () => {
    expect(scan.videos).toHaveLength(2);
    expect(scan.videos[0]).toMatchObject({
      src: "media/demo.webm",
      sources: ["media/demo.webm", "media/demo.mp4?v=2"],
      autoplay: true,
      muted: true,
      playsinline: true,
      loop: true,
      controls: false,
      poster: "media/poster.jpg",
      preload: "metadata",
      captions: ["media/demo.en.vtt"],
    });
    expect(scan.videos[1]).toMatchObject({
      src: "/media/tour.mp4",
      controls: true,
      autoplay: false,
      captions: [],
    });
    expect(scan.embeds).toEqual([{ host: "www.youtube.com", line: 28 }]);
  });

  it("lists local assets and root-absolute links", () => {
    expect(scan.assets.sort()).toEqual(
      [
        "style.css",
        "/favicon.ico",
        "app.js",
        "hero.png",
        "media/shot 2.webp",
        "media/poster.jpg",
        "media/demo.webm",
        "media/demo.mp4",
        "media/demo.en.vtt",
        "/media/tour.mp4",
      ].sort(),
    );
    expect(scan.rootAbsolute.map((r) => r.value)).toEqual(["/favicon.ico", "/media/tour.mp4"]);
  });
});

describe("references", () => {
  it("tells local paths from remote ones", () => {
    expect(isLocalRef("media/a.png")).toBe(true);
    expect(isLocalRef("/a.png")).toBe(true);
    expect(isLocalRef("https://x.test/a.png")).toBe(false);
    expect(isLocalRef("//cdn.test/a.png")).toBe(false);
    expect(isLocalRef("data:image/png;base64,AAA")).toBe(false);
    expect(isLocalRef("#top")).toBe(false);
    expect(localPath("a%20b.png?x=1#y")).toBe("a b.png");
    expect(localPath("bad%zz.png")).toBe("bad%zz.png");
  });
});

describe("scanMarkdown", () => {
  it("finds Markdown and HTML images and videos in a README", () => {
    const readme = [
      "# Tally",
      "![Demo of Tally](docs/media/demo.gif)",
      '<img src="docs/shot.png" width="600">',
      "![](https://img.shields.io/badge/x)",
      '<video src="https://github.com/user-attachments/assets/abc.mp4"></video>',
    ].join("\n");
    const scan = scanMarkdown(readme);
    expect(scan.images.map((i) => [i.src, i.alt, i.line])).toEqual([
      ["docs/media/demo.gif", "Demo of Tally", 2],
      ["docs/shot.png", null, 3],
      ["https://img.shields.io/badge/x", "", 4],
    ]);
    expect(scan.videos).toHaveLength(1);
    expect(scan.assets.sort()).toEqual(["docs/media/demo.gif", "docs/shot.png"]);
  });
});
