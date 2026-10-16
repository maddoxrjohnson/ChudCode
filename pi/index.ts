/**
 * ChudCode for Pi.
 *
 * The tools come from the ChudCode MCP server, which Pi's MCP adapter runs with
 * `CHUDCODE_HOST=pi` (see README). This extension adds what an MCP server cannot do on
 * its own: slash commands, and a bridge that wakes the agent when the candidate acts
 * in the browser, so the interviewer never has to poll.
 *
 * Commands: /interview, /review, /research, /dashboard.
 */

import { InterviewBridge, type MessageSender } from "./bridge.ts";
import { registerCommands, type CommandHost } from "./commands.ts";
import { showStatus, type WidgetHost } from "./status.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function chudcodeExtension(pi: any): void {
  let ui: WidgetHost | null = null;
  const bridge = new InterviewBridge(pi as MessageSender, {
    onStatus: (status) => showStatus(ui, status),
  });

  // A command usually leads to start_session, which starts the server; look for it
  // promptly rather than at the next retry.
  registerCommands(pi as CommandHost, () => bridge.poke());

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    // The idle probe and the UI live on the session context, which only handlers get.
    bridge.setIdleProbe(() => ctx.isIdle());
    ui = (ctx.ui as WidgetHost | undefined) ?? null;
    bridge.start();
  });

  pi.on("session_shutdown", async () => {
    await bridge.stop();
    showStatus(ui, { connected: false });
    ui = null;
  });
}
