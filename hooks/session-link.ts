/**
 * session-link.ts: after `start_session`, `start_lesson`, or `start_phone_screen`, print the link in the terminal.
 *
 * The model is asked to give the link, but this hook makes it certain: Claude Code
 * shows a hook's `systemMessage` to the user directly. The link is read from the
 * tool's own result ("Session <id> is ready: <url>"), so nothing is guessed. Any
 * failure prints nothing, so the hook can never break a session. Like the MCP server,
 * it runs as TypeScript directly on Node 22.18 or later.
 */

const SESSION_URL = /Session (\S+) is ready: (http:\/\/127\.0\.0\.1:\d+\/s\/[\w-]+)/;

/** The session a hook's stdin names, from the tool's result; null when it names none. */
export interface SessionLink {
  sessionId: string;
  url: string;
}

export function sessionLink(input: string): SessionLink | null {
  try {
    const event = JSON.parse(input) as { tool_response?: unknown };
    const match = SESSION_URL.exec(JSON.stringify(event.tool_response ?? ""));
    return match?.[1] && match[2] ? { sessionId: match[1], url: match[2] } : null;
  } catch {
    return null;
  }
}

export function hookOutput(link: SessionLink) {
  return {
    systemMessage: `ChudCode session ready: ${link.url}`,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `The session link ${link.url} was shown to the user. Still include it in your reply.`,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => (input += chunk));
  process.stdin.on("end", () => {
    const link = sessionLink(input);
    if (link) process.stdout.write(JSON.stringify(hookOutput(link)));
  });
}
