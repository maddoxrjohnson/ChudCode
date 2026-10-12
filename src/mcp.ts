/**
 * mcp.ts: ChudCode as an MCP server for Claude Code.
 *
 * An MCP server cannot wake its client, so the interviewer listens instead:
 * `wait_for_candidate` blocks until the candidate does something in the browser, then
 * returns a self-contained prompt that names the tool to call next. Everything else
 * is an ordinary tool call.
 *
 * `McpSession.handle` is a pure JSON-RPC dispatcher, so tests drive it without a child
 * process; `mcp-stdio.ts` wires it to stdin and stdout. The inbox and long-poll shape
 * follow pi-teach's src/mcp.ts (Josh Noll, MIT); see docs/ATTRIBUTION.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { readProblem } from "./store/problems.ts";
import {
  candidateDonePrompt,
  hintUsedPrompt,
  messagePrompt,
  notePrompt,
  nothingYetText,
  recoveredSessionPrompt,
  startedPrompt,
  submissionPrompt,
  timerExpiredPrompt,
} from "./prompts.ts";
import { setHooks, type CandidateEvent } from "./server/hooks.ts";
import * as server from "./server/server.ts";
import { push, sessionChannel } from "./server/sse.ts";
import { packageRoot } from "./store/paths.ts";
import { listSessions, readEvents, readSession, type Session } from "./store/sessions.ts";
import {
  fail,
  isFailure,
  ok,
  ToolArgumentError,
  type ToolDef,
  type ToolResult,
} from "./tools/index.ts";
import { interviewTools } from "./tools/interview-tools.ts";
import { problemTools } from "./tools/problem-tools.ts";
import { sessionTools } from "./tools/session-tools.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const SERVER_NAME = "chudcode";
export const SERVER_VERSION = (
  JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
    version: string;
  }
).version;

/** Newest first. A client asking for one of these gets it echoed back. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * Claude Code moves any tool call that runs past two minutes into a background task,
 * which would turn the interviewer's wait into a notification it may not read in time.
 * Sixty seconds keeps every wait well inside that limit.
 */
export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 60;

/** Appended to the interviewing brief for this host. */
export const HOST_BRIEF = `## ChudCode tools in this session

This session cannot push the candidate's actions to you. You listen for them:

- \`start_session\` creates a session, starts the local server if needed, and returns the URL. \`open_dashboard\` opens the dashboard and recovers any session already in progress. URLs work only while this session runs.
- \`wait_for_candidate\` blocks until the candidate presses Start, posts an approach note or a message, takes a hint, submits, says they are done, or the timer runs out. It returns the full event and names the tool that handles it. Each wait lasts at most ${MAX_WAIT_SECONDS} seconds.

Keep calling \`wait_for_candidate\` while the clock runs. A wait that returns nothing means the candidate is coding; call it again. Speak only when you have a reason: a question arrived, a submission landed, or several silent minutes have passed and one short check-in would help. The page shows "Interviewer listening" while a wait is open and "Interviewer away" when none is, so do not leave the candidate alone: end your turn only after \`record_session\` or \`abandon_session\`, or when the user talks to you in the terminal. The user can press Esc to interrupt a wait and talk to you here; answer, then resume waiting.

\`say_to_candidate\` is the only way your words reach the page. Terminal text is for setup and the final summary.`;

// ── Candidate inbox ───────────────────────────────────────────────────────────

interface Waiter {
  resolve(prompts: string[] | null): void;
  timer: NodeJS.Timeout;
}

interface Activity {
  runs: number;
  lastRun?: { scope: string; passed: number; total: number };
}

/**
 * Prompts from the browser, held until the interviewer asks for them.
 *
 * A prompt that arrives while nobody waits stays queued, so an event that lands while
 * the interviewer is speaking is returned by the next wait. Only one waiter is live at
 * a time: a new wait supersedes an older one, because the host may abandon a call
 * (Esc) without telling the server, and a stale waiter must not swallow events.
 */
export class CandidateInbox {
  private readonly queue: Array<{
    prompt: string;
    key?: string | undefined;
    pending?: (() => boolean) | undefined;
  }> = [];
  private readonly seen = new Set<string>();
  private readonly waiters = new Map<string | number, Waiter>();
  private readonly activity = new Map<string, Activity>();
  private onListening: ((listening: boolean) => void) | null = null;

  get size(): number {
    return this.queue.length;
  }

  get listening(): boolean {
    return this.waiters.size > 0;
  }

  /** Called whenever the server starts or stops waiting. */
  setListeningListener(listener: ((listening: boolean) => void) | null): void {
    this.onListening = listener;
  }

  push(prompt: string, key?: string, pending?: () => boolean): void {
    if (key && this.seen.has(key)) return;
    if (pending && !pending()) return;
    if (key) this.seen.add(key);
    this.queue.push({ prompt, key, pending });
    const oldest = this.waiters.entries().next();
    if (oldest.done) return;
    const [waitKey, waiter] = oldest.value;
    const prompts = this.take();
    this.waiters.delete(waitKey);
    clearTimeout(waiter.timer);
    waiter.resolve(prompts);
    this.notifyListening();
  }

  /**
   * Resolve with every queued prompt as soon as there is one; with `[]` when
   * `timeoutMs` passes first; with `null` when `cancel(key)` is called.
   */
  wait(key: string | number, timeoutMs: number): Promise<string[] | null> {
    const queued = this.take();
    if (queued.length > 0) return Promise.resolve(queued);
    for (const [staleKey, stale] of this.waiters) {
      this.waiters.delete(staleKey);
      clearTimeout(stale.timer);
      stale.resolve([]);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        resolve([]);
        this.notifyListening();
      }, timeoutMs);
      this.waiters.set(key, { resolve, timer });
      this.notifyListening();
    });
  }

  cancel(key: string | number): void {
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.resolve(null);
    this.notifyListening();
  }

  /** Count a Run-button execution for the next wait's digest. */
  recordRun(sessionId: string, scope: string, passed: number, total: number): void {
    const current = this.activity.get(sessionId) ?? { runs: 0 };
    current.runs += 1;
    current.lastRun = { scope, passed, total };
    this.activity.set(sessionId, current);
  }

  /** The digest of silent activity since the last wait returned, then clear it. */
  takeDigest(): string {
    const lines: string[] = [];
    for (const [sessionId, activity] of this.activity) {
      if (activity.runs === 0 || !activity.lastRun) continue;
      lines.push(
        `Since your last wait, session \`${sessionId}\`: ran the ${activity.lastRun.scope === "custom" ? "custom input" : "examples"} ${activity.runs} time${activity.runs === 1 ? "" : "s"} (last ${activity.lastRun.passed}/${activity.lastRun.total} passed).`,
      );
    }
    this.activity.clear();
    return lines.join("\n");
  }

  /** Release every waiter with nothing and forget everything, for shutdown. */
  reset(): void {
    for (const key of [...this.waiters.keys()]) this.cancel(key);
    this.queue.length = 0;
    this.seen.clear();
    this.activity.clear();
  }

  private take(): string[] {
    const pending = this.queue.filter((entry) => !entry.pending || entry.pending());
    this.queue.length = 0;
    return pending.map((entry) => entry.prompt);
  }

  private notifyListening(): void {
    this.onListening?.(this.listening);
  }
}

// ── Routing browser events into the inbox ─────────────────────────────────────

export function activeSessions(): Session[] {
  return listSessions(10).filter((s) => s.phase !== "done");
}

function broadcastPresence(listening: boolean): void {
  for (const session of activeSessions()) {
    push(sessionChannel(session.id), "presence", { listening });
  }
}

/** Route candidate events into the inbox and tell the page when the interviewer listens. */
export function connectInbox(inbox: CandidateInbox): void {
  inbox.setListeningListener(broadcastPresence);
  setHooks({
    isListening: () => inbox.listening,
    onCandidateEvent: (event) => routeEvent(inbox, event),
  });
}

function routeEvent(inbox: CandidateInbox, event: CandidateEvent): void {
  if (event.kind === "run") {
    inbox.recordRun(event.sessionId, event.scope, event.passed, event.total);
    return;
  }
  let session: Session;
  try {
    session = readSession(event.sessionId);
  } catch {
    return;
  }
  const notDone = () => {
    try {
      return readSession(event.sessionId).phase !== "done";
    } catch {
      return false;
    }
  };
  switch (event.kind) {
    case "started":
      return inbox.push(startedPrompt(session, event.at), `started:${event.sessionId}`, notDone);
    case "note":
      return inbox.push(
        notePrompt(session, event.text, event.at),
        `note:${event.sessionId}:${event.at}`,
        notDone,
      );
    case "message":
      return inbox.push(
        messagePrompt(session, event.text, event.at),
        `message:${event.sessionId}:${event.at}`,
        notDone,
      );
    case "hint_used": {
      const hint = readProblem(session.problem).hints.find((h) => h.level === event.level);
      return inbox.push(
        hintUsedPrompt(session, event.level, hint?.text ?? "", event.at),
        `hint:${event.sessionId}:${event.level}`,
        notDone,
      );
    }
    case "submission": {
      const bundle = readProblem(session.problem);
      return inbox.push(
        submissionPrompt(session, event.number, event.result, bundle, event.at),
        `submit:${event.sessionId}:${event.number}`,
        notDone,
      );
    }
    case "timer_expired":
      return inbox.push(
        timerExpiredPrompt(session, event.at),
        `timeout:${event.sessionId}`,
        notDone,
      );
    case "candidate_done":
      return inbox.push(candidateDonePrompt(session, event.at), `done:${event.sessionId}`, notDone);
    default:
      return;
  }
}

/**
 * Queue what an interviewer joining mid-session needs to know: each session still in
 * progress that this process did not create, once, plus any candidate message that
 * never got an interviewer reply.
 */
export function recoverSessions(
  inbox: CandidateInbox,
  created: ReadonlySet<string>,
  now = Date.now(),
): void {
  for (const session of activeSessions()) {
    if (created.has(session.id)) continue;
    inbox.push(
      recoveredSessionPrompt(session, now),
      `recover:${session.id}`,
      () => readSession(session.id).phase !== "done",
    );
    const events = readEvents(session.id);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (!event || event.type !== "message") continue;
      if (event.from === "interviewer") break;
      inbox.push(
        messagePrompt(session, event.markdown, event.at),
        `message:${session.id}:${event.at}`,
      );
      break;
    }
  }
}

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const WAIT_TOOL = {
  name: "wait_for_candidate",
  title: "Wait For Candidate",
  description:
    "Wait for the candidate to act in the browser: press Start, post an approach note or a message, take a hint, submit, say they are done, or run out of time. " +
    "Blocks until something happens, then returns every waiting event in full with the tool that handles it. " +
    `Call it whenever you are not doing something else during a session. Each call lasts at most ${MAX_WAIT_SECONDS} seconds; call it again while the clock runs.`,
  inputSchema: {
    type: "object",
    properties: {
      timeout_seconds: {
        type: "integer",
        description: `How long to wait before returning with nothing. Default ${DEFAULT_WAIT_SECONDS}, maximum ${MAX_WAIT_SECONDS}.`,
      },
    },
    required: [],
  },
};

export class McpSession {
  private readonly tools: Map<string, ToolDef>;
  private readonly inbox: CandidateInbox;
  /** Sessions this process created; recovery never re-announces them. */
  private readonly created = new Set<string>();

  constructor(inbox: CandidateInbox) {
    this.inbox = inbox;
    const host = {
      hostBrief: HOST_BRIEF,
      created: (sessionId: string) => this.created.add(sessionId),
      recover: () => recoverSessions(inbox, this.created),
    };
    this.tools = new Map(
      [...sessionTools(host), ...interviewTools(), ...problemTools()].map((tool) => [
        tool.name,
        tool,
      ]),
    );
  }

  /** Every tool this server lists, by name. */
  toolNames(): string[] {
    return [...this.tools.keys(), WAIT_TOOL.name];
  }

  /** Handle one message. Resolve with the response, or `null` when none is due. */
  async handle(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    if (message.method === undefined) return null;
    if (message.id === undefined || message.id === null) {
      if (message.method === "notifications/cancelled")
        this.inbox.cancel(message.params?.requestId);
      return null;
    }
    const id = message.id;
    switch (message.method) {
      case "initialize":
        return result(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(message.params?.protocolVersion)
            ? message.params.protocolVersion
            : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, { tools: this.listTools() });
      case "tools/call":
        return this.callTool(id, message.params?.name, message.params?.arguments ?? {});
      default:
        return error(id, -32601, `Method not found: ${message.method}`);
    }
  }

  private listTools(): unknown[] {
    return [
      ...[...this.tools.values()].map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      WAIT_TOOL,
    ];
  }

  private async callTool(
    id: string | number,
    name: unknown,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse | null> {
    if (name === WAIT_TOOL.name) return this.waitForCandidate(id, args);
    const tool = typeof name === "string" ? this.tools.get(name) : undefined;
    if (!tool) return error(id, -32602, `Unknown tool: ${String(name)}`);

    const required = ((tool.inputSchema as { required?: string[] }).required ?? []).filter(
      (key) => args[key] === undefined,
    );
    if (required.length > 0) {
      return result(id, toolResult(fail(`Missing required argument: ${required.join(", ")}`)));
    }
    try {
      return result(id, toolResult(await tool.execute(args)));
    } catch (err) {
      if (err instanceof ToolArgumentError) return result(id, toolResult(fail(err.message)));
      return result(id, toolResult(fail(err instanceof Error ? err.message : String(err))));
    }
  }

  private async waitForCandidate(
    id: string | number,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse | null> {
    if (!server.isRunning()) {
      return result(
        id,
        toolResult(
          fail(
            "The server is not running, so the candidate cannot do anything yet. Call start_session or open_dashboard first.",
          ),
        ),
      );
    }
    let seconds: number;
    try {
      seconds = waitSeconds(args["timeout_seconds"]);
    } catch (err) {
      return result(id, toolResult(fail((err as Error).message)));
    }
    recoverSessions(this.inbox, this.created);
    const prompts = await this.inbox.wait(id, seconds * 1000);
    if (prompts === null) return null;

    const digest = this.inbox.takeDigest();
    if (prompts.length === 0) {
      return result(id, toolResult(ok(nothingYetText(seconds, activeSessions(), digest))));
    }
    const header =
      prompts.length === 1 ? "" : `${prompts.length} events arrived. Handle each one in order.\n\n`;
    const body = header + prompts.join("\n\n---\n\n") + (digest ? `\n\n${digest}` : "");
    return result(id, toolResult(ok(body)));
  }
}

export function waitSeconds(requested: unknown): number {
  if (requested === undefined) return DEFAULT_WAIT_SECONDS;
  if (
    typeof requested !== "number" ||
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_WAIT_SECONDS
  ) {
    throw new Error(`timeout_seconds must be an integer from 1 to ${MAX_WAIT_SECONDS}.`);
  }
  return requested;
}

function toolResult(value: ToolResult): { content: ToolResult["content"]; isError: boolean } {
  return { content: value.content, isError: isFailure(value) };
}

function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
