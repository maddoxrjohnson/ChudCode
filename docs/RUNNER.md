# Running candidate code

Every Run, Submit, and `validate_problem` goes through one interface:

```ts
interface Runner {
  name: string;
  run(request: RunRequest): Promise<RunResult>;
}
```

A request carries a language adapter, the source, the signature, the cases, and the
limits. The adapter knows how to lay out a workdir and start its harness; the runner
knows how to start a process safely. Results stream back as one JSON line per case,
and comparison against expected values happens in Node (`src/runner/compare.ts`), so
comparators are shared by every language.

## ProcessRunner (default)

`src/runner/process-runner.ts`. For each run:

- A fresh workdir under `~/.chudcode/tmp/`, removed afterwards whatever happens.
- A detached process group, so a wall-clock timeout kills everything the solution
  started with one `SIGKILL`.
- A clean environment: `PATH`, `HOME` set to the workdir, a UTF-8 locale, and fixed
  `PYTHONHASHSEED` so set and dict ordering is the same on every run.
- Output caps on stdout per case and on stderr, reported as `truncated`.
- One run at a time, in order, so a burst of Run presses cannot fork-bomb the machine.

Inside the process the Python harness sets `RLIMIT_AS`, `RLIMIT_CPU`, `RLIMIT_FSIZE`,
and `RLIMIT_NOFILE` before importing the solution, runs each case under its own
timer, and reports `memory`, `timeout`, or the exception for each case.

The defaults are in `config.json` under `limits` (`run`, `submit`, `validate`):
10 s wall for Run, 20 s for Submit, 5 s CPU, 512 MB memory, 2 s per case, 64 KB of
output, 1 MB per written file.

This protects the machine from runaway code. It is not a security sandbox: the
solution runs as you, with your filesystem and your network. That is the right
trade for a tool where the only author of the code is the person running it.

## DockerRunner (opt in)

`src/runner/docker-runner.ts`. The same runner with one change: each command runs in
a throwaway container instead of directly. Enable it with:

```sh
docker pull python:3.12-slim
export CHUDCODE_RUNNER=docker
export CHUDCODE_DOCKER_IMAGE=python:3.12-slim   # optional; this is the default
```

Set these where the MCP server is started (the shell that runs `claude`, or the
`env` block in Pi's `mcp.json`). The image is never pulled for you; a missing image
fails the run with Docker's own message. Any image with `python3` on its `PATH`
works.

Each container gets:

| Flag                                                        | Why                                               |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `--network none`                                            | No exfiltration and no downloading a solution.    |
| `--read-only`, workdir mounted `:ro`, 16 MB `noexec` `/tmp` | Nothing persists and nothing new can be executed. |
| `--cap-drop ALL`, `--security-opt no-new-privileges`        | No privileged syscalls, no setuid escalation.     |
| `--user <your uid>:<your gid>`                              | Not root inside the container.                    |
| `--pids-limit 64`                                           | A fork bomb hits a wall.                          |
| `--memory` = limit + 128 MB, no swap, `--cpus 1`            | Cgroup caps behind the harness's own rlimits.     |
| `--env` with the run environment only                       | None of your environment reaches the solution.    |

The cgroup memory cap sits 128 MB above the harness's `RLIMIT_AS`, so an
over-allocating solution gets a `MemoryError` the harness can report as `memory`,
rather than an OOM kill with no explanation. Killing the `docker` client does not
stop its container, so on a wall-clock timeout the runner also removes the
container by name.

Startup costs a few hundred milliseconds per run, which is why it is not the
default for a local practice tool. It is the runner to use if ChudCode is ever
served to people other than the one writing the code.

`test/docker-runner.test.ts` checks the flags as a pure argv and, when a daemon with
the default image is present, runs a correct solution, a solution that tries the
network and the filesystem, and an infinite loop.
