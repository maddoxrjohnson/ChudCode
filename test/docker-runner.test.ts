/**
 * DockerRunner: the `docker run` policy as a pure argv, and real runs when a Docker
 * daemon with the default image is available (skipped otherwise; it is never pulled).
 */

import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pythonAdapter } from "../src/runner/adapters/python/adapter.ts";
import {
  DEFAULT_DOCKER_IMAGE,
  DockerRunner,
  dockerArgs,
  dockerReady,
} from "../src/runner/docker-runner.ts";
import { processRunner } from "../src/runner/process-runner.ts";
import type { Limits, RunRequest, Signature, TestCase } from "../src/runner/types.ts";
import { activeRunner } from "../src/runs.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

const LIMITS: Limits = {
  wallMs: 8_000,
  cpuSeconds: 3,
  memoryMb: 256,
  outputKb: 4,
  fileSizeKb: 64,
  perCaseMs: 1_000,
};

const ADD: Signature = {
  style: "function",
  name: "add",
  params: [
    { name: "a", type: "int" },
    { name: "b", type: "int" },
  ],
  returns: "int",
};

const CASES: TestCase[] = [
  { id: "1", visible: true, input: { a: 1, b: 2 }, expected: 3 },
  { id: "2", visible: false, input: { a: -1, b: 1 }, expected: 0 },
];

describe("dockerArgs", () => {
  const args = dockerArgs({
    name: "chudcode-abc",
    image: "python:3.12-slim",
    workdir: "/home/u/.chudcode/tmp/run-1",
    limits: LIMITS,
    command: { cmd: "/usr/local/bin/python3", args: ["-s", "-P", "harness.py"] },
  });
  const pairs = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

  it("cuts the network, the root filesystem, capabilities, and processes", () => {
    expect(pairs("--network")).toEqual(["none"]);
    expect(args).toContain("--read-only");
    expect(pairs("--cap-drop")).toEqual(["ALL"]);
    expect(pairs("--security-opt")).toEqual(["no-new-privileges"]);
    expect(pairs("--pids-limit")).toEqual(["64"]);
    expect(pairs("--volume")).toEqual(["/home/u/.chudcode/tmp/run-1:/work:ro"]);
  });

  it("caps memory above the harness's own limit, so the harness reports it first", () => {
    expect(pairs("--memory")).toEqual(["384m"]);
    expect(pairs("--memory-swap")).toEqual(["384m"]);
  });

  it("passes only the run environment and runs the image's interpreter", () => {
    expect(pairs("--env")).toEqual(expect.arrayContaining(["PYTHONHASHSEED=0", "HOME=/tmp"]));
    expect(pairs("--env").some((e) => e?.startsWith("PATH="))).toBe(false);
    expect(args.slice(-5)).toEqual(["python:3.12-slim", "python3", "-s", "-P", "harness.py"]);
  });
});

describe("activeRunner", () => {
  it("is the process runner unless Docker is asked for", () => {
    expect(activeRunner({})).toBe(processRunner);
    const docker = activeRunner({ CHUDCODE_RUNNER: "docker" });
    expect(docker).toBeInstanceOf(DockerRunner);
    expect((docker as DockerRunner).image).toBe(DEFAULT_DOCKER_IMAGE);
    expect(activeRunner({ CHUDCODE_RUNNER: "docker" })).toBe(docker);
    const other = activeRunner({ CHUDCODE_RUNNER: "docker", CHUDCODE_DOCKER_IMAGE: "py:x" });
    expect((other as DockerRunner).image).toBe("py:x");
  });
});

describe.skipIf(!dockerReady())("DockerRunner in a real container", () => {
  let fixture: Fixture;
  const runner = new DockerRunner();

  beforeAll(() => {
    fixture = makeFixture();
  });
  afterAll(() => fixture.cleanup());

  const run = (source: string, overrides: Partial<RunRequest> = {}) =>
    runner.run({
      adapter: pythonAdapter,
      source,
      signature: ADD,
      cases: CASES,
      limits: LIMITS,
      ...overrides,
    });

  it("passes a correct solution", async () => {
    const result = await run("def add(a, b):\n    return a + b\n");
    expect(result).toMatchObject({ status: "ok", passed: 2, total: 2 });
  }, 30_000);

  it("has no network and cannot write its workdir", async () => {
    const result = await run(
      [
        "import socket",
        "def add(a, b):",
        "    try:",
        "        socket.create_connection(('1.1.1.1', 53), timeout=1)",
        "        net = 'open'",
        "    except OSError:",
        "        net = 'closed'",
        "    try:",
        "        open('planted.txt', 'w')",
        "        fs = 'writable'",
        "    except OSError:",
        "        fs = 'read-only'",
        "    print(net, fs)",
        "    return a + b",
        "",
      ].join("\n"),
    );
    expect(result.status).toBe("ok");
    expect(result.cases[0]?.stdout).toContain("closed read-only");
  }, 30_000);

  it("times out an infinite loop and leaves no container behind", async () => {
    const result = await run("def add(a, b):\n    while True:\n        pass\n", {
      limits: { ...LIMITS, wallMs: 4_000, perCaseMs: 10_000, cpuSeconds: 30 },
    });
    expect(result.status).toBe("timeout");
    const left = spawnSync("docker", ["ps", "-aq", "--filter", "name=chudcode-"], {
      encoding: "utf8",
    });
    expect(left.stdout.trim()).toBe("");
  }, 30_000);
});
