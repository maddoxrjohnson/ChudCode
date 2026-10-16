/**
 * Host end-to-end check: a real Claude Code session interviews a scripted candidate.
 *
 *   npm run e2e:claude [-- --keep]
 *
 * Runs `claude -p --plugin-dir .` against a throwaway state directory, with only the
 * ChudCode tools allowed. The agent is asked to run a short interview on the bundled
 * example; this script plays the candidate over the same HTTP routes the page uses:
 * a clarifying question, a passing submission, and an answer to the follow-up. It
 * then checks what the session left on disk. This is the one check that exercises
 * the plugin manifest, the stdio launcher, the host's tool-call timeouts, and the
 * prompts as a model actually reads them. It needs `claude` on the PATH and signed
 * in, takes a few minutes, and costs a short session's worth of tokens, so CI does
 * not run it.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SessionState } from "../src/flow.ts";
import { packageRoot } from "../src/store/paths.ts";

const keep = process.argv.includes("--keep");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-e2e-claude-"));
const TIMEOUT_MS = 8 * 60_000;

const CORRECT = [
  "def max_window_sum(nums, k):",
  "    if k > len(nums):",
  "        return 0",
  "    window = sum(nums[:k])",
  "    best = window",
  "    for i in range(k, len(nums)):",
  "        window += nums[i] - nums[i - k]",
  "        best = max(best, window)",
  "    return best",
  "",
].join("\n");

const PROMPT = [
  "This is an automated end-to-end test of ChudCode; a script plays the candidate.",
  "Call begin_interview with pattern sliding-window and read the method. Then call start_session with slug window-sum, timer_minutes 10, and start_now true.",
  "Say one short greeting with say_to_candidate, then keep calling wait_for_candidate and handle each event as the brief says, in one or two sentences each.",
  "After a passing submission ask exactly one follow-up about complexity, wait for the answer, then call record_session with your honest scores and stop. Do not abandon the session.",
].join(" ");

const passed: string[] = [];
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) throw new Error(`${name}${detail === undefined ? "" : `: ${String(detail)}`}`);
  passed.push(name);
  console.log(`  ok  ${name}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, probe: () => Promise<T | null> | T | null): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    if (exited) throw new Error(`claude exited while waiting for ${what}\n${output.join("")}`);
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ── The interviewer ───────────────────────────────────────────────────────────

const output: string[] = [];
let exited = false;
const child = spawn(
  "claude",
  [
    "-p",
    "--plugin-dir",
    packageRoot(),
    "--allowedTools",
    "mcp__plugin_chudcode_chudcode",
    "--output-format",
    "text",
    PROMPT,
  ],
  {
    cwd: stateDir,
    env: { ...process.env, CHUDCODE_DIR: stateDir, CHUDCODE_AUTO_OPEN: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
const exitCode = new Promise<number | null>((resolve) =>
  child.on("close", (code) => {
    exited = true;
    resolve(code);
  }),
);
const killer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);

// ── The candidate ─────────────────────────────────────────────────────────────

let base = "";
const get = async (route: string) => (await fetch(`${base}${route}`)).json() as Promise<unknown>;
const post = (route: string, body: unknown = {}) =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const state = (id: string) => get(`/api/sessions/${id}`) as Promise<SessionState>;
const interviewerSaid = async (id: string) =>
  (await state(id)).messages.filter((m) => m.from === "interviewer").length;

async function replyAfter(id: string, before: number, what: string): Promise<void> {
  await until(what, async () => ((await interviewerSaid(id)) > before ? true : null));
}

try {
  console.log(`claude -p in ${stateDir}`);
  const port = await until("server.json", () => {
    try {
      return (
        JSON.parse(fs.readFileSync(path.join(stateDir, "server.json"), "utf8")) as {
          port: number;
        }
      ).port;
    } catch {
      return null;
    }
  });
  base = `http://127.0.0.1:${port}`;

  const id = await until("a session", async () => {
    const dashboard = (await get("/api/dashboard")) as { sessions: Array<{ id: string }> };
    return dashboard.sessions[0]?.id ?? null;
  });
  check("the agent started a session", true);

  await until("the clock", async () =>
    (await state(id)).session.phase === "coding" ? true : null,
  );
  await replyAfter(id, 0, "a greeting");
  check("the interviewer greeted the candidate on the page", true);

  let said = await interviewerSaid(id);
  await post(`/api/sessions/${id}/message`, { text: "Can k be larger than the length of nums?" });
  await replyAfter(id, said, "an answer to the clarifying question");
  check("the interviewer answered a clarifying question", true);

  said = await interviewerSaid(id);
  const submitted = (await (
    await post(`/api/sessions/${id}/submit`, { code: CORRECT })
  ).json()) as {
    passed: number;
    total: number;
  };
  check(
    "the reference submission passes",
    submitted.passed === submitted.total,
    JSON.stringify(submitted),
  );
  await replyAfter(id, said, "a follow-up after the submission");
  check("the interviewer asked a follow-up after the submission", true);

  await post(`/api/sessions/${id}/message`, {
    text: "O(n) time: each element enters and leaves the window once. O(1) extra space.",
  });
  const code = await exitCode;
  clearTimeout(killer);
  check("claude exited cleanly", code === 0, `${code}\n${output.join("")}`);

  const session = JSON.parse(
    fs.readFileSync(path.join(stateDir, "sessions", id, "session.json"), "utf8"),
  ) as { phase: string; verdict?: unknown };
  check(
    "the session was scored",
    session.phase === "done" && !!session.verdict,
    JSON.stringify(session),
  );
  const review = fs.readFileSync(path.join(stateDir, "review", "events.jsonl"), "utf8");
  check("its patterns entered the review schedule", review.includes("pattern:sliding-window"));

  console.log(`\n${passed.length} checks passed. Verdict: ${JSON.stringify(session.verdict)}.`);
  console.log(output.join("").trim());
} catch (err) {
  child.kill("SIGTERM");
  console.error(`\nFAILED after ${passed.length} checks: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(killer);
  if (keep) console.log(`State kept in ${stateDir}`);
  else fs.rmSync(stateDir, { recursive: true, force: true });
}
