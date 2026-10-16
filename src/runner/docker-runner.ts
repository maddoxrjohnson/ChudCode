/**
 * docker-runner.ts: the same runs as ProcessRunner, inside a throwaway container.
 *
 * ProcessRunner keeps runaway code from hurting the machine but runs it as the user.
 * DockerRunner adds the isolation a shared or hosted ChudCode would need: no network,
 * a read-only root and workdir, no capabilities, a pid limit, and cgroup memory and
 * CPU caps on top of the harness's own rlimits. Everything else (workdir layout, the
 * harness protocol, output caps, the serial queue, comparison in Node) is ProcessRunner's,
 * so both runners produce identical results for well-behaved code.
 *
 * Opt in with CHUDCODE_RUNNER=docker. CHUDCODE_DOCKER_IMAGE picks the image; it must
 * have `python3` on its PATH. The image is never pulled implicitly: a run fails with
 * Docker's own message if it is missing. See docs/RUNNER.md.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

import { ProcessRunner, RUN_ENV, type Prepared } from "./process-runner.ts";
import type { Command, Limits } from "./types.ts";

export const DEFAULT_DOCKER_IMAGE = "python:3.12-slim";

/** Where the workdir appears inside the container. */
const MOUNT = "/work";

export interface DockerOptions {
  image?: string;
  /** The docker CLI. */
  docker?: string;
}

export class DockerRunner extends ProcessRunner {
  override readonly name = "docker";
  readonly image: string;
  readonly docker: string;

  constructor(options: DockerOptions = {}) {
    super();
    this.image = options.image ?? DEFAULT_DOCKER_IMAGE;
    this.docker = options.docker ?? "docker";
  }

  protected override prepare(command: Command, workdir: string, limits: Limits): Prepared {
    const name = `chudcode-${randomBytes(6).toString("hex")}`;
    return {
      command: {
        cmd: this.docker,
        args: dockerArgs({ name, image: this.image, workdir, limits, command }),
      },
      // The client needs the user's Docker config and context; the run itself gets
      // only RUN_ENV, passed with --env below.
      env: clientEnv(),
      // Killing the docker client does not stop the container; remove it by name.
      abort: () => {
        spawnSync(this.docker, ["rm", "-f", name], { stdio: "ignore" });
      },
    };
  }
}

/** The `docker run` argv for one command. Pure, so the policy is unit-tested. */
export function dockerArgs(options: {
  name: string;
  image: string;
  workdir: string;
  limits: Limits;
  command: Command;
}): string[] {
  const { limits } = options;
  // Headroom over the harness's RLIMIT_AS, so the harness reports `memory` itself
  // before the cgroup OOM killer ends the container with no explanation.
  const cgroupMb = limits.memoryMb + 128;
  const env = Object.entries({ ...RUN_ENV, HOME: "/tmp" }).flatMap(([key, value]) => [
    "--env",
    `${key}=${value}`,
  ]);
  const user =
    process.getuid && process.getgid ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];
  return [
    "run",
    "--rm",
    "--name",
    options.name,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    `${cgroupMb}m`,
    "--memory-swap",
    `${cgroupMb}m`,
    "--cpus",
    "1",
    ...user,
    "--volume",
    `${options.workdir}:${MOUNT}:ro`,
    "--workdir",
    MOUNT,
    ...env,
    options.image,
    // The host's interpreter path means nothing inside the image.
    path.basename(options.command.cmd),
    ...options.command.args,
  ];
}

function clientEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: os.homedir(),
  };
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Whether a Docker daemon answers and has `image` locally. */
export function dockerReady(image = DEFAULT_DOCKER_IMAGE, docker = "docker"): boolean {
  const probe = spawnSync(docker, ["image", "inspect", image], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}
