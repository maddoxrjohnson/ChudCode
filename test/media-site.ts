/**
 * A small project with a GitHub Pages site in docs/, for media lab tests: a polished
 * version that passes every fail-level check, and the mistakes a first attempt makes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { gif, jpeg, mp4, png } from "./media-fixtures.ts";

export const GOOD_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tally</title>
  <meta property="og:title" content="Tally">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://maddo.github.io/tally/">
  <meta property="og:image" content="https://maddo.github.io/tally/media/og.png">
  <meta property="og:image:alt" content="Tally's budget screen with three categories">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Budgets that add up</h1>
  <video autoplay muted playsinline loop poster="media/poster.jpg" preload="metadata" width="1280" height="720">
    <source src="media/demo.mp4" type="video/mp4">
  </video>
  <img src="media/shot.png" alt="Adding a transaction in two taps" width="1200" height="750">
  <a href="guide.html">Read the guide</a>
</body>
</html>
`;

export const BAD_PAGE = `<!doctype html>
<html>
<head>
  <title>Tally</title>
</head>
<body>
  <video autoplay src="media/slow.mp4"></video>
  <img src="media/shot.png" loading="lazy">
  <img src="media/missing.png" alt="">
  <a href="/guide.html">Guide</a>
</body>
</html>
`;

export function put(root: string, relative: string, content: string | Buffer): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Write a site into `root`. */
export function writeSite(root: string, variant: "good" | "bad"): void {
  put(root, "README.md", "# Tally\n\n![Tally in action](docs/media/demo.gif)\n");
  put(root, "docs/media/demo.gif", gif(800, 450, 2));
  put(root, "docs/style.css", "body { font-family: system-ui; }\n");
  put(root, "docs/guide.html", "<!doctype html><title>Guide</title><p>How to use Tally.</p>");
  put(root, "docs/media/shot.png", png(1200, 750));
  put(root, ".env", "TOKEN=nope");
  if (variant === "good") {
    put(root, "docs/index.html", GOOD_PAGE);
    put(root, "docs/media/og.png", png(1200, 630));
    put(root, "docs/media/poster.jpg", jpeg(1280, 720));
    put(root, "docs/media/demo.mp4", mp4({ width: 1280, height: 720, seconds: 40 }));
  } else {
    put(root, "docs/index.html", BAD_PAGE);
    put(
      root,
      "docs/media/slow.mp4",
      mp4({ width: 640, height: 360, seconds: 240, faststart: false, audio: true, codec: "hvc1" }),
    );
  }
}
