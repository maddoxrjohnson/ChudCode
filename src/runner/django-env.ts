/**
 * django-env.ts: the Python environment project sessions run in.
 *
 * Interview problems use the standard library only, so they run on the system
 * `python3`. A Django project needs Django and Django REST framework, so ChudCode
 * keeps its own virtual environment under the state root and builds it on first
 * use: with `uv` when it is installed (fast, and it works where Debian's python3
 * lacks `ensurepip`), otherwise with `python3 -m venv` and pip. Building needs the
 * network once. `CHUDCODE_DJANGO_PYTHON` points at an interpreter that already has
 * both packages, and skips the build.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { rootDir } from "../store/paths.ts";

/** Pinned to the Django LTS line and the REST framework release that supports it. */
export const DJANGO_REQUIREMENTS = ["django>=5.2,<5.3", "djangorestframework>=3.16,<3.17"];
export const DJANGO_ENV_NAME = "django-5.2";

export class DjangoEnvError extends Error {}

export function djangoEnvDir(): string {
  return path.join(rootDir(), "envs", DJANGO_ENV_NAME);
}

function envPython(dir: string): string {
  return path.join(dir, "bin", "python");
}

function run(
  cmd: string,
  args: string[],
  timeout: number,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
      },
      (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.slice(-3000) }),
    );
  });
}

/** Whether `python` imports both packages. */
async function usable(python: string): Promise<boolean> {
  if (!fs.existsSync(python)) return false;
  const check = await run(python, ["-c", "import django, rest_framework"], 30_000);
  return check.ok;
}

let ready: Promise<string> | null = null;

/**
 * The interpreter to run projects with, building the environment if it is missing.
 * Concurrent callers share one build. A failed build is not cached, so the next
 * call tries again after the user fixes what the error names.
 */
export function ensureDjangoEnv(): Promise<string> {
  ready ??= locate().catch((err: unknown) => {
    ready = null;
    throw err;
  });
  return ready;
}

/** Forget a located interpreter, for tests that move the state root. */
export function _resetDjangoEnv(): void {
  ready = null;
}

async function locate(): Promise<string> {
  const override = process.env["CHUDCODE_DJANGO_PYTHON"];
  if (override) {
    if (await usable(override)) return override;
    throw new DjangoEnvError(
      `CHUDCODE_DJANGO_PYTHON is ${override}, which cannot import django and rest_framework.`,
    );
  }
  const dir = djangoEnvDir();
  const python = envPython(dir);
  if (await usable(python)) return python;
  await build(dir);
  if (await usable(python)) return python;
  throw new DjangoEnvError(`Built ${dir}, but its Python still cannot import Django.`);
}

async function build(dir: string): Promise<void> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const system = process.env["CHUDCODE_PYTHON"] ?? "python3";
  const python = envPython(dir);

  const uv = await run("uv", ["--version"], 10_000);
  if (uv.ok) {
    const venv = await run("uv", ["venv", "--quiet", "--python", system, dir], 120_000);
    if (venv.ok) {
      const install = await run(
        "uv",
        ["pip", "install", "--quiet", "--python", python, ...DJANGO_REQUIREMENTS],
        300_000,
      );
      if (install.ok) return;
      throw new DjangoEnvError(`uv could not install Django:\n${install.output}`);
    }
  }

  const venv = await run(system, ["-m", "venv", dir], 120_000);
  if (!venv.ok)
    throw new DjangoEnvError(
      `Could not create a virtual environment for Django projects. Install uv (https://docs.astral.sh/uv/) or your system's python3-venv package, then try again.\n${venv.output}`,
    );
  const install = await run(
    python,
    ["-m", "pip", "install", "--quiet", ...DJANGO_REQUIREMENTS],
    300_000,
  );
  if (!install.ok) throw new DjangoEnvError(`pip could not install Django:\n${install.output}`);
}
