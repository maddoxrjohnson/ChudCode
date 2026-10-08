/**
 * markdown.ts: Markdown to HTML, plus the escaping the page builders rely on.
 *
 * Problem statements and interviewer messages are rendered on the server so the
 * browser runtime needs no Markdown library.
 */

import { marked } from "marked";

export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
}

/** Escape text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialise a value for a <script> block. A `</script>` inside the JSON would end the
 * block early; escaping `<` prevents that and `-->` at once.
 */
export function toScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
