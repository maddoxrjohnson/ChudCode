/**
 * session-link.ts: make sure the user gets the link of every session that starts.
 *
 * After `start_session`, `start_lesson`, or `start_phone_screen` (PostToolUse) it
 * prints the link as a `systemMessage`, read from the tool's own result ("Session
 * <id> is ready: <url>"), so nothing is guessed. That message is easy to miss, so the
 * link must also be in the model's own words: before `wait_for_candidate`
 * (PreToolUse) and before the turn ends (Stop), the hook reads the transcript and
 * refuses while the latest session's link has not appeared in any message the
 * model wrote since. Any failure prints nothing, so the hook can never break a
 * session. Like the MCP server, it runs as TypeScript directly on Node 22.18 or later.
 */

import * as fs from "node:fs";

const SESSION_URL = /Session (\S+) is ready: (http:\/\/127\.0\.0\.1:\d+\/s\/[\w-]+)/;

/** The session a hook's stdin names, from the tool's result; null when it names none. */
export interface SessionLink {
  sessionId: string;
  url: string;
}

export function sessionLink(input: string): SessionLink | null {
  try {
    const event = JSON.parse(input) as { tool_response?: unknown };
    return linkIn(JSON.stringify(event.tool_response ?? ""));
  } catch {
    return null;
  }
}

function linkIn(text: string): SessionLink | null {
  const match = SESSION_URL.exec(text);
  return match?.[1] && match[2] ? { sessionId: match[1], url: match[2] } : null;
}

export function hookOutput(link: SessionLink) {
  return {
    systemMessage: `ChudCode session ready: ${link.url}`,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `The user cannot see tool results. Write ${link.url} in a message to them now, before any other tool call, or they cannot reach the session.`,
    },
  };
}

interface TranscriptLine {
  type?: string;
  message?: { content?: unknown };
}

/**
 * The latest session link the transcript's tool results gave, if no message the
 * model wrote since holds it; null when it was sent or no session started.
 */
export function unsentLink(transcript: string): SessionLink | null {
  let latest: SessionLink | null = null;
  let sent = false;
  for (const raw of transcript.split("\n")) {
    if (!raw.trim()) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }
    const content = Array.isArray(line.message?.content) ? line.message.content : [];
    if (line.type === "user") {
      for (const block of content as Array<{ type?: string; content?: unknown }>) {
        if (block.type !== "tool_result") continue;
        const link = linkIn(JSON.stringify(block.content ?? ""));
        if (link) {
          latest = link;
          sent = false;
        }
      }
    } else if (line.type === "assistant" && latest) {
      for (const block of content as Array<{ type?: string; text?: unknown }>) {
        if (
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.includes(latest.url)
        )
          sent = true;
      }
    }
  }
  return latest && !sent ? latest : null;
}

function reminder(link: SessionLink): string {
  return `The user has not been given the session link. Write it in a message to them now: ${link.url} (they cannot see tool results, and without it they cannot reach the page).`;
}

interface HookEvent {
  hook_event_name?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

/** What the hook prints for an event, given a way to read the transcript; null prints nothing. */
export function respond(input: string, readTranscript: (path: string) => string): object | null {
  let event: HookEvent;
  try {
    event = JSON.parse(input) as HookEvent;
  } catch {
    return null;
  }
  if (event.hook_event_name === "PreToolUse" || event.hook_event_name === "Stop") {
    // A turn already held back once ends anyway, so a hook can never trap it.
    if (event.stop_hook_active || !event.transcript_path) return null;
    let link: SessionLink | null;
    try {
      link = unsentLink(readTranscript(event.transcript_path));
    } catch {
      return null;
    }
    if (!link) return null;
    return event.hook_event_name === "Stop"
      ? { decision: "block", reason: reminder(link) }
      : {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `${reminder(link)} Then call wait_for_candidate again.`,
          },
        };
  }
  const link = sessionLink(input);
  return link ? hookOutput(link) : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => (input += chunk));
  process.stdin.on("end", () => {
    const output = respond(input, (p) => fs.readFileSync(p, "utf8"));
    if (output) process.stdout.write(JSON.stringify(output));
  });
}
