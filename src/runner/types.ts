/**
 * types.ts: the contract between the server, the runner, and each language adapter.
 *
 * A Runner executes untrusted source against a list of test cases and reports one
 * result per case. It knows nothing about problems or sessions. A LanguageAdapter
 * tells the runner how to lay out a workdir, what command to spawn, and how to read
 * the adapter's line protocol back. Comparison of actual against expected output is
 * not the runner's job: it emits raw values and `evaluate.ts` decides pass or fail,
 * so comparators are written once in TypeScript and shared by every language.
 */

export interface Limits {
  /** Kill the whole process group after this long, whatever it is doing. */
  wallMs: number;
  /** CPU seconds the sandboxed process may consume (RLIMIT_CPU). */
  cpuSeconds: number;
  /** Address-space ceiling for the sandboxed process (RLIMIT_AS). */
  memoryMb: number;
  /** Cap on captured stdout and stderr, each. */
  outputKb: number;
  /** Largest file the sandboxed process may create (RLIMIT_FSIZE). */
  fileSizeKb: number;
  /** Per-case timeout enforced inside the harness so one slow case does not hide the rest. */
  perCaseMs: number;
}

export interface SignatureParam {
  name: string;
  /** A type in the problem language's notation, e.g. `List[int]`, `str`, `ListNode`. */
  type: string;
}

export interface Signature {
  /** `function`: a top-level `def`. `method`: a method on `class Solution`, LeetCode style. */
  style: "function" | "method";
  name: string;
  params: SignatureParam[];
  returns: string;
}

export type CompareMode =
  /** Deep equality after canonicalisation. */
  | "exact"
  /** Top-level list compared as a multiset. */
  | "unordered"
  /** Top-level list of lists, each inner list and the outer list compared as multisets. */
  | "unordered-nested"
  /** Numbers compared within `tolerance`, recursively. */
  | "float"
  /** `expected` is a list of acceptable outputs; any exact match passes. */
  | "any-of"
  /** The bundle's checker.py decides; the harness reports its verdict. */
  | "checker";

export interface TestCase {
  id: string;
  label?: string;
  /** Visible cases are shown to the candidate and run by the Run button. */
  visible: boolean;
  /** Keyword arguments by parameter name. Absent when `gen` builds the input. */
  input?: Record<string, unknown>;
  /** A Python expression evaluated in the bundle's generators.py that returns the input dict. */
  gen?: string;
  /** Omit to have validation fill it from the reference solution. An explicit null expects None. */
  expected?: unknown;
  compare?: CompareMode;
  tolerance?: number;
  /** For in-place problems: report this parameter's value after the call as the output. */
  outputFrom?: string;
}

export type CaseStatus = "pass" | "fail" | "error" | "timeout" | "skipped";

export interface CaseResult {
  id: string;
  status: CaseStatus;
  actual?: unknown;
  expected?: unknown;
  stdout: string;
  stderr: string;
  timeMs: number;
  /** A one-line explanation for error, timeout, and skipped statuses. */
  message?: string;
  /** Verdict from checker.py, when the case uses `compare: "checker"`. */
  checkerPassed?: boolean;
}

export type RunStatus =
  /** The harness ran to completion. Cases may still have failed. */
  | "ok"
  /** The candidate's source did not import. */
  | "import-error"
  /** The harness died outside any single case. */
  | "runtime-error"
  /** The wall clock expired and the process group was killed. */
  | "timeout"
  /** The process ran out of memory outside any single case. */
  | "memory"
  /** Killed by a signal the runner did not send. */
  | "killed"
  /** The harness produced output the adapter could not read. */
  | "harness-error";

export interface RunResult {
  status: RunStatus;
  cases: CaseResult[];
  passed: number;
  total: number;
  wallMs: number;
  maxRssKb?: number;
  /** The last few KB of stderr from the process itself, for import errors and crashes. */
  stderrTail: string;
  /** Some captured output was cut at the configured cap. */
  truncated: boolean;
}

export interface RunRequest {
  adapter: LanguageAdapter;
  /** The candidate's or reference source, written to `adapter.sourceFileName`. */
  source: string;
  signature: Signature;
  cases: TestCase[];
  limits: Limits;
  /** Extra bundle files the harness may import, e.g. generators.py and checker.py. */
  extraFiles?: Record<string, string>;
  /** Called as each case result arrives, already compared against its expected output. */
  onCase?: (result: CaseResult) => void;
}

/** A case result as the harness reports it, before expected/actual comparison. */
export type RawCaseResult = Omit<CaseResult, "status" | "expected"> & {
  status: "ok" | "error" | "timeout";
  /** Python exception class name, when status is `error`. */
  errorType?: string;
};

export type HarnessLine =
  | { event: "case"; result: RawCaseResult }
  | { event: "done"; maxRssKb: number }
  | { event: "fatal"; kind: "import-error" | "runtime-error" | "memory"; message: string };

export interface Command {
  cmd: string;
  args: string[];
}

export interface Runner {
  readonly name: string;
  run(request: RunRequest): Promise<RunResult>;
}

export interface LanguageAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Where the runner writes `request.source` inside the workdir. */
  readonly sourceFileName: string;
  /** Starter code for the editor, derived from the signature. */
  stub(signature: Signature): string;
  /** Present for compiled languages; the runner runs it before `runCommand`. */
  compileCommand?(workdir: string): Command;
  runCommand(workdir: string): Command;
  /** Files the runner copies into every workdir alongside the source. */
  harnessFiles(): Array<{ name: string; contents: string }>;
  /** Parse one line of the process's stdout, or return null for lines to ignore. */
  parseLine(line: string): HarnessLine | null;
}
