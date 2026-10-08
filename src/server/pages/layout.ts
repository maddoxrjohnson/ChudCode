/**
 * layout.ts: the HTML shell every page shares.
 */

import { escapeHtml, toScriptJson } from "../../markdown.ts";

export interface PageOptions {
  title: string;
  bodyClass: string;
  body: string;
  /** Serialised into `#cc-config` for the page's module to read. */
  config?: unknown;
  /** Path under /static/ of the ES module that drives the page. */
  module?: string;
}

export function page(options: PageOptions): string {
  const config =
    options.config === undefined
      ? ""
      : `<script type="application/json" id="cc-config">${toScriptJson(options.config)}</script>\n`;
  const module = options.module
    ? `<script type="module" src="/static/${options.module}"></script>\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} · ChudCode</title>
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/static/runtime/app.css">
<script>
(function () {
  // Applied before first paint so a dark-mode reader never sees a white flash.
  try {
    var stored = localStorage.getItem("chudcode-theme");
    if (stored === "dark" || stored === "light") document.documentElement.setAttribute("data-theme", stored);
  } catch (e) {}
})();
</script>
</head>
<body class="${escapeHtml(options.bodyClass)}">
${options.body}
${config}${module}</body>
</html>
`;
}

export interface TopbarOptions {
  title: string;
  /** HTML for the middle of the bar. */
  middle?: string;
  /** HTML for the right of the bar, before the theme toggle. */
  right?: string;
}

export function topbar(options: TopbarOptions): string {
  return `<header class="topbar">
  <a class="brand" href="/">ChudCode</a>
  <div class="topbar-title">${options.title}</div>
  <div class="topbar-middle">${options.middle ?? ""}</div>
  <div class="topbar-right">${options.right ?? ""}
    <button type="button" class="icon-button" id="theme-toggle" title="Toggle dark mode" aria-label="Toggle dark mode">◐</button>
  </div>
</header>`;
}

export function difficultyBadge(difficulty: string): string {
  return `<span class="badge difficulty-${escapeHtml(difficulty)}">${escapeHtml(difficulty)}</span>`;
}

export function notFoundPage(message: string): string {
  return page({
    title: "Not found",
    bodyClass: "plain",
    body: `${topbar({ title: "Not found" })}
<main class="narrow">
  <h1>Not found</h1>
  <p>${escapeHtml(message)}</p>
  <p><a href="/">Back to the dashboard</a></p>
</main>`,
  });
}

export function errorPage(message: string): string {
  return page({
    title: "Error",
    bodyClass: "plain",
    body: `${topbar({ title: "Error" })}
<main class="narrow">
  <h1>Something went wrong</h1>
  <pre class="error-text">${escapeHtml(message)}</pre>
  <p><a href="/">Back to the dashboard</a></p>
</main>`,
  });
}
