/**
 * mcp-stdio.ts: run the MCP server over stdio. Importing this module starts it.
 *
 * Messages are newline-delimited JSON-RPC. stdout carries protocol messages only;
 * diagnostics go to stderr. The process exits when the client closes stdin or sends
 * SIGTERM, and takes the HTTP server with it so no listener is orphaned.
 */

import * as readline from "node:readline";

import { CandidateInbox, connectInbox, McpSession, type JsonRpcMessage } from "./mcp.ts";
import * as server from "./server/server.ts";

const inbox = new CandidateInbox();
const session = new McpSession(inbox);
connectInbox(inbox);

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  if (!line.trim()) return;
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(line) as JsonRpcMessage;
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  session.handle(message).then(
    (response) => {
      if (response) write(response);
    },
    (err: unknown) => {
      console.error("[chudcode] MCP request failed", err);
      if (message.id !== undefined && message.id !== null) {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  inbox.reset();
  void server.close().then(() => process.exit(0));
}

lines.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
