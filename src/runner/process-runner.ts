/**
 * process-runner.ts: run untrusted source in a child process with hard limits.
 *
 * Each run gets a fresh workdir under ~/.chudcode/tmp, a detached process group so a
 * wall-clock timeout can kill everything the solution spawned, capped output capture,
 * and a serial queue so hammering the Run button cannot fork-bomb the machine.
 * Resource limits inside the process (memory, CPU, file size) are the adapter's job;
 * the Python harness sets them with setrlimit before importing the solution.
 *
 * This is deliberately not a security sandbox: the code runs as the user, with the
 * user's filesystem and network. It protects the machine from runaway solutions, not
 * from hostile ones. DockerRunner (docker-runner.ts) reuses all of this and only changes
 * the command it spawns, through `prepare`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

import { pythonAdapterDir, safeJoin, tmpDir } from "../store/paths.ts";
import { PYTHON_FLAGS } from "./adapters/python/adapter.ts";
import { countPassed, evaluateCase, skippedCase } from "./evaluate.ts";
import type {
  CaseResult,
  Command,
  HarnessLine,
  Limits,
  RunRequest,
  RunResult,
  Runner,
  TestCase,
} from "./types.ts";

/** Runs tasks one at a time, in order. */
class RunQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** The environment every run sees. Nothing else from the user's environment leaks in. */
export const RUN_ENV: Readonly<Record<string, string>> = {
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PYTHONIOENCODING: "utf-8",
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONHASHSEED: "0",
};

/** What actually gets spawned for an adapter command. */
export interface Prepared {
  command: Command;
  env: Record<string, string>;
  /** Called on a wall-clock timeout, after the process group is killed. */
  abort?: () => void;
}

interface SpawnOutcome<T = HarnessLine> {
  lines: T[];
  stderr: string;
  stderrTruncated: boolean;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  wallMs: number;
}

export class ProcessRunner implements Runner {
  readonly name: string = "process";
  private readonly queue = new RunQueue();

  /** Turn an adapter command into what is spawned. Here: run it directly, as the user. */
  // `limits` is unused here; DockerRunner turns it into cgroup caps.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected prepare(command: Command, workdir: string, _limits: Limits): Prepared {
    return {
      command,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: workdir, ...RUN_ENV },
    };
  }

  async run(request: RunRequest): Promise<RunResult> {
    return this.queue.enqueue(() => this.execute(request));
  }

  private async execute(request: RunRequest): Promise<RunResult> {
    fs.mkdirSync(tmpDir(), { recursive: true });
    const workdir = fs.mkdtempSync(path.join(tmpDir(), "run-"));
    try {
      this.populate(workdir, request);

      if (request.adapter.compileCommand) {
        const compile = await this.spawnAndCollect(
          request.adapter.compileCommand(workdir),
          workdir,
          request.limits,
          (text) => request.adapter.parseLine(text),
          () => undefined,
        );
        if (compile.exitCode !== 0) {
          return {
            status: "import-error",
            cases: request.cases.map((c) => skippedCase(c, "compilation failed")),
            passed: 0,
            total: request.cases.length,
            wallMs: compile.wallMs,
            stderrTail: compile.stderr,
            truncated: compile.stderrTruncated,
          };
        }
      }

      const byId = new Map(request.cases.map((c) => [c.id, c]));
      const evaluated = new Map<string, CaseResult>();
      let fatal: Extract<HarnessLine, { event: "fatal" }> | null = null;
      let done: Extract<HarnessLine, { event: "done" }> | null = null;

      const outcome = await this.spawnAndCollect(
        request.adapter.runCommand(workdir),
        workdir,
        request.limits,
        (text) => request.adapter.parseLine(text),
        (line) => {
          if (line.event === "case") {
            const testCase = byId.get(line.result.id);
            if (!testCase || evaluated.has(testCase.id)) return;
            const result = evaluateCase(line.result, testCase);
            evaluated.set(testCase.id, result);
            request.onCase?.(result);
          } else if (line.event === "done") {
            done = line;
          } else {
            fatal = line;
          }
        },
      );

      const status = resolveStatus(fatal, done, outcome);
      const cases = request.cases.map((testCase) => {
        const result = evaluated.get(testCase.id);
        if (result) return result;
        return skippedCase(testCase, skipReason(status));
      });

      const result: RunResult = {
        status,
        cases,
        passed: countPassed(cases),
        total: cases.length,
        wallMs: outcome.wallMs,
        stderrTail: fatal ? (fatal as { message: string }).message : outcome.stderr,
        truncated:
          outcome.stderrTruncated ||
          cases.some((c) => c.stdout.length >= request.limits.outputKb * 1024),
      };
      if (done) result.maxRssKb = (done as { maxRssKb: number }).maxRssKb;
      return result;
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }

  /**
   * Run a test suite against one module, for the agentic drills: `files` is laid out
   * in a fresh workdir (paths may hold one directory, like `tests/test_x.py`), the
   * suite harness discovers and runs the tests, and each test's outcome comes back.
   */
  async runSuite(request: SuiteRequest): Promise<SuiteResult> {
    return this.queue.enqueue(() => this.executeSuite(request));
  }

  private async executeSuite(request: SuiteRequest): Promise<SuiteResult> {
    fs.mkdirSync(tmpDir(), { recursive: true });
    const workdir = fs.mkdtempSync(path.join(tmpDir(), "suite-"));
    try {
      for (const [name, contents] of Object.entries(request.files)) {
        const target = safeJoin(workdir, name);
        if (!target || name.split("/").length > 2) throw new Error(`Bad suite path: ${name}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents, "utf8");
      }
      fs.mkdirSync(path.join(workdir, "tests"), { recursive: true });
      fs.writeFileSync(path.join(workdir, "tests", "__init__.py"), "", { flag: "a" });
      fs.writeFileSync(path.join(workdir, "suite_harness.py"), suiteHarness(), "utf8");
      fs.writeFileSync(
        path.join(workdir, "suite.json"),
        JSON.stringify({ limits: request.limits }),
      );

      const tests: SuiteTest[] = [];
      let scan: SuiteScan[] = [];
      let fatal: string | null = null;
      let done = false;
      const outcome = await this.spawnAndCollect(
        { cmd: request.pythonBin, args: [...PYTHON_FLAGS, "suite_harness.py"] },
        workdir,
        request.limits,
        parseSuiteLine,
        (line) => {
          if (line.event === "test") tests.push(line.test);
          else if (line.event === "scan") scan = line.tests;
          else if (line.event === "fatal") fatal = line.message;
          else done = true;
        },
      );
      const status: SuiteResult["status"] = fatal
        ? "error"
        : outcome.timedOut
          ? "timeout"
          : done
            ? "ok"
            : "crashed";
      return {
        status,
        tests,
        scan,
        wallMs: outcome.wallMs,
        stderrTail: fatal ?? outcome.stderr.slice(-4000),
      };
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }

  private populate(workdir: string, request: RunRequest): void {
    const write = (name: string, contents: string) => {
      const target = path.join(workdir, path.basename(name));
      fs.writeFileSync(target, contents, "utf8");
    };
    write(request.adapter.sourceFileName, request.source);
    for (const file of request.adapter.harnessFiles()) write(file.name, file.contents);
    for (const [name, contents] of Object.entries(request.extraFiles ?? {})) write(name, contents);
    write(
      "cases.json",
      JSON.stringify({
        signature: request.signature,
        cases: request.cases.map(stripForHarness),
        limits: request.limits,
      }),
    );
  }

  private spawnAndCollect<T>(
    adapterCommand: Command,
    workdir: string,
    limits: Limits,
    parse: (text: string) => T | null,
    onLine: (line: T) => void,
  ): Promise<SpawnOutcome<T>> {
    const { command, env, abort } = this.prepare(adapterCommand, workdir, limits);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const stderrCap = limits.outputKb * 1024;
      let stderr = "";
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;

      const child = spawn(command.cmd, command.args, {
        cwd: workdir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });

      const killGroup = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
        abort?.();
      }, limits.wallMs);

      const lines: T[] = [];
      const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      reader.on("line", (text) => {
        const line = parse(text);
        if (!line) return;
        lines.push(line);
        onLine(line);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length >= stderrCap) {
          stderrTruncated = true;
          return;
        }
        const text = chunk.toString("utf8");
        const room = stderrCap - stderr.length;
        if (text.length > room) {
          stderr += text.slice(0, room);
          stderrTruncated = true;
        } else {
          stderr += text;
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(new Error(`Cannot start ${command.cmd}: ${err.message}`, { cause: err }));
      });

      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        // Drain any final line the reader has buffered before resolving.
        reader.close();
        resolve({
          lines,
          stderr,
          stderrTruncated,
          timedOut,
          exitCode,
          signal,
          wallMs: Date.now() - started,
        });
      });
    });
  }
}

function stripForHarness(testCase: TestCase): Record<string, unknown> {
  const out: Record<string, unknown> = { id: testCase.id };
  if (testCase.input !== undefined) out["input"] = testCase.input;
  if (testCase.gen !== undefined) out["gen"] = testCase.gen;
  if (testCase.compare !== undefined) out["compare"] = testCase.compare;
  if (testCase.outputFrom !== undefined) out["outputFrom"] = testCase.outputFrom;
  // The checker is the only consumer of expected on the Python side.
  if (testCase.compare === "checker" && "expected" in testCase) out["expected"] = testCase.expected;
  return out;
}

function resolveStatus(
  fatal: HarnessLine | null,
  done: HarnessLine | null,
  outcome: SpawnOutcome,
): RunResult["status"] {
  if (fatal && fatal.event === "fatal") return fatal.kind;
  if (outcome.timedOut) return "timeout";
  if (outcome.signal && outcome.signal !== "SIGKILL") return "killed";
  if (outcome.signal === "SIGKILL") return "killed";
  if (!done) return "harness-error";
  return "ok";
}

function skipReason(status: RunResult["status"]): string {
  switch (status) {
    case "timeout":
      return "not run: the wall-clock limit expired";
    case "import-error":
      return "not run: the solution failed to import";
    case "memory":
      return "not run: the process ran out of memory";
    case "killed":
      return "not run: the process was killed";
    case "harness-error":
      return "not run: the harness stopped unexpectedly";
    case "runtime-error":
      return "not run: the harness crashed";
    case "ok":
      return "not run";
    default:
      return "not run";
  }
}

export interface SuiteRequest {
  /** Relative path to contents: the module under test and `tests/*.py`. */
  files: Record<string, string>;
  limits: Limits;
  pythonBin: string;
}

export type SuiteTestStatus = "pass" | "fail" | "error" | "timeout" | "skip";

export interface SuiteTest {
  id: string;
  status: SuiteTestStatus;
  message: string;
}

export interface SuiteScan {
  id: string;
  asserts: number;
}

export interface SuiteResult {
  /** ok: every test ran. timeout: the wall clock killed the suite. error: discovery failed. */
  status: "ok" | "timeout" | "error" | "crashed";
  tests: SuiteTest[];
  scan: SuiteScan[];
  wallMs: number;
  stderrTail: string;
}

type SuiteLine =
  | { event: "test"; test: SuiteTest }
  | { event: "scan"; tests: SuiteScan[] }
  | { event: "fatal"; message: string }
  | { event: "done" };

const SUITE_STATUSES: readonly string[] = ["pass", "fail", "error", "timeout", "skip"];

function parseSuiteLine(text: string): SuiteLine | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (record["event"]) {
    case "test": {
      const status = String(record["status"]);
      if (!SUITE_STATUSES.includes(status)) return null;
      return {
        event: "test",
        test: {
          id: String(record["id"] ?? ""),
          status: status as SuiteTestStatus,
          message: String(record["message"] ?? ""),
        },
      };
    }
    case "scan":
      return {
        event: "scan",
        tests: Array.isArray(record["tests"])
          ? (record["tests"] as Array<Record<string, unknown>>).map((t) => ({
              id: String(t["id"]),
              asserts: Number(t["asserts"]) || 0,
            }))
          : [],
      };
    case "fatal":
      return { event: "fatal", message: String(record["message"] ?? "") };
    case "done":
      return { event: "done" };
    default:
      return null;
  }
}

let suiteHarnessSource: string | null = null;
function suiteHarness(): string {
  suiteHarnessSource ??= fs.readFileSync(path.join(pythonAdapterDir(), "suite_harness.py"), "utf8");
  return suiteHarnessSource;
}

export const processRunner = new ProcessRunner();
