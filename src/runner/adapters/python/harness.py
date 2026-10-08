"""Run a solution against test cases and report one JSON line per case.

Invoked by the runner as `python3 -I harness.py` inside a workdir that holds
solution.py, chud_types.py, cases.json, and optionally generators.py and checker.py.

Protocol, one JSON object per stdout line:
  {"event": "case", "result": {id, status, actual, stdout, stderr, timeMs, ...}}
  {"event": "done", "maxRssKb": N}
  {"event": "fatal", "kind": "import-error" | "runtime-error" | "memory", "message": "..."}

Anything the solution prints is captured per case and travels inside the case result,
so stdout stays a clean transport. Resource limits are applied in-process before the
solution is imported. Comparison of actual against expected output happens on the
Node side; this file only executes and reports.
"""

from __future__ import annotations

import copy
import importlib
import io
import json
import os
import resource
import signal
import sys
import time
import traceback

# `-I` keeps the interpreter isolated from the user's environment, which also drops the
# script's own directory from sys.path. Put it back so the helper module and the
# solution import from the workdir and nowhere else.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import chud_types  # noqa: E402

REAL_STDOUT = sys.stdout
REAL_STDERR = sys.stderr
HARNESS_FILE = os.path.abspath(__file__)


class CaseTimeout(Exception):
    pass


class CpuExceeded(Exception):
    pass


def emit(obj):
    REAL_STDOUT.write(json.dumps(obj, allow_nan=False) + "\n")
    REAL_STDOUT.flush()


def fatal(kind, message):
    emit({"event": "fatal", "kind": kind, "message": message[-8000:]})
    # Skip atexit handlers and open-file flushing the solution may have registered.
    os._exit(1)


# ── Limits ────────────────────────────────────────────────────────────────────


def apply_rlimits(limits):
    def set_limit(name, soft, hard=None):
        res_id = getattr(resource, name, None)
        if res_id is None:
            return
        hard = soft if hard is None else hard
        try:
            _, current_hard = resource.getrlimit(res_id)
            if current_hard != resource.RLIM_INFINITY:
                soft = min(soft, current_hard)
                hard = min(hard, current_hard)
            resource.setrlimit(res_id, (soft, hard))
        except (ValueError, OSError):
            pass  # Best effort: the Node side still enforces the wall clock.

    memory_mb = limits.get("memoryMb")
    if memory_mb:
        set_limit("RLIMIT_AS", int(memory_mb) * 1024 * 1024)
    cpu = limits.get("cpuSeconds")
    if cpu:
        set_limit("RLIMIT_CPU", int(cpu), int(cpu) + 1)
    file_kb = limits.get("fileSizeKb")
    if file_kb is not None:
        set_limit("RLIMIT_FSIZE", int(file_kb) * 1024)
    set_limit("RLIMIT_NOFILE", 64)


class CappedIO(io.StringIO):
    """A StringIO that stops storing past `cap` characters and remembers that it did."""

    def __init__(self, cap):
        super().__init__()
        self.cap = cap
        self.size = 0
        self.truncated = False

    def write(self, s):
        if self.size >= self.cap:
            self.truncated = True
            return len(s)
        room = self.cap - self.size
        if len(s) > room:
            s = s[:room]
            self.truncated = True
        self.size += len(s)
        return super().write(s)


class case_alarm:
    def __init__(self, ms):
        self.seconds = max(ms, 1) / 1000.0

    def __enter__(self):
        signal.setitimer(signal.ITIMER_REAL, self.seconds)

    def __exit__(self, *exc):
        signal.setitimer(signal.ITIMER_REAL, 0)
        return False


def _on_alarm(signum, frame):
    raise CaseTimeout()


def _on_xcpu(signum, frame):
    raise CpuExceeded()


# ── Solution access ───────────────────────────────────────────────────────────


def make_callable_factory(module, sig):
    """Return a zero-arg function that yields the callable for one case.

    Method-style problems get a fresh `Solution()` per case, as LeetCode does, so
    instance state cannot leak between cases.
    """
    name = sig["name"]
    if sig.get("style") == "method":
        cls = getattr(module, "Solution", None)
        if cls is None:
            raise LookupError("class Solution was not found in solution.py")
        probe = getattr(cls, name, None)
        if probe is None:
            raise LookupError(f"Solution.{name} was not found in solution.py")
        return lambda: getattr(cls(), name)
    fn = getattr(module, name, None)
    if not callable(fn):
        raise LookupError(f"def {name} was not found in solution.py")
    return lambda: fn


def build_input(case, param_types, generators):
    if case.get("gen") is not None:
        if generators is None:
            raise RuntimeError("this case uses a generator but generators.py is missing")
        namespace = dict(vars(generators))
        raw = eval(case["gen"], namespace)  # noqa: S307 - bundle-authored, already untrusted
        if not isinstance(raw, dict):
            raise RuntimeError("a generator expression must return a dict of arguments")
    else:
        raw = case.get("input") or {}
    kwargs = {}
    for key, value in raw.items():
        kwargs[key] = chud_types.from_json(copy.deepcopy(value), param_types.get(key, ""))
    return raw, kwargs


def solution_traceback(exc):
    """Format a traceback that starts at the solution's own frames."""
    tb = exc.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename == HARNESS_FILE:
        tb = tb.tb_next
    return "".join(traceback.format_exception(type(exc), exc, tb))


def run_case(case, factory, sig, param_types, generators, checker, limits):
    out_cap = int(limits.get("outputKb", 64)) * 1024
    stdout = CappedIO(out_cap)
    stderr = CappedIO(out_cap)
    sys.stdout = stdout
    sys.stderr = stderr

    result = {"id": case["id"], "status": "ok", "stdout": "", "stderr": "", "timeMs": 0}
    started = None
    try:
        raw_input, kwargs = build_input(case, param_types, generators)
        fn = factory()
        started = time.perf_counter()
        with case_alarm(limits.get("perCaseMs", 2000)):
            value = fn(**kwargs)
        result["timeMs"] = round((time.perf_counter() - started) * 1000, 2)

        output_from = case.get("outputFrom")
        if output_from:
            actual = chud_types.to_json(kwargs.get(output_from), param_types.get(output_from, ""))
        else:
            actual = chud_types.to_json(value, sig.get("returns", ""))
        json.dumps(actual, allow_nan=False)  # Reject NaN/inf before they reach the transport.
        result["actual"] = actual

        if checker is not None and case.get("compare") == "checker":
            verdict = checker.check(copy.deepcopy(raw_input), actual, case.get("expected"))
            result["checkerPassed"] = bool(verdict)
    except CaseTimeout:
        result["status"] = "timeout"
        result["message"] = f"exceeded the per-case limit of {limits.get('perCaseMs', 2000)} ms"
    except CpuExceeded:
        result["status"] = "timeout"
        result["message"] = f"exceeded the CPU limit of {limits.get('cpuSeconds')} s"
    except MemoryError:
        result["status"] = "error"
        result["errorType"] = "MemoryError"
        result["message"] = f"MemoryError: exceeded the memory limit of {limits.get('memoryMb')} MB"
    except RecursionError as exc:
        result["status"] = "error"
        result["errorType"] = "RecursionError"
        result["message"] = f"RecursionError: {exc}"
        stderr.write(solution_traceback(exc)[-4000:])
    except ValueError as exc:
        if "allow_nan" in str(exc) or "Out of range float" in str(exc):
            result["status"] = "error"
            result["errorType"] = "ValueError"
            result["message"] = "output contains a non-finite float (NaN or infinity)"
        else:
            result["status"] = "error"
            result["errorType"] = "ValueError"
            result["message"] = f"ValueError: {exc}"
            stderr.write(solution_traceback(exc))
    except BaseException as exc:  # noqa: BLE001 - every failure must become a result
        result["status"] = "error"
        result["errorType"] = type(exc).__name__
        first_line = str(exc).splitlines()[0] if str(exc) else ""
        result["message"] = f"{type(exc).__name__}: {first_line}" if first_line else type(exc).__name__
        stderr.write(solution_traceback(exc))
    finally:
        if started is not None and result["timeMs"] == 0:
            result["timeMs"] = round((time.perf_counter() - started) * 1000, 2)
        sys.stdout = REAL_STDOUT
        sys.stderr = REAL_STDERR

    result["stdout"] = stdout.getvalue()
    result["stderr"] = stderr.getvalue()
    if stdout.truncated or stderr.truncated:
        result["truncated"] = True
    emit({"event": "case", "result": result})


# ── Entry ─────────────────────────────────────────────────────────────────────


def main():
    with open("cases.json", encoding="utf-8") as fh:
        spec = json.load(fh)
    limits = spec.get("limits", {})
    sig = spec["signature"]
    param_types = {p["name"]: p.get("type", "") for p in sig.get("params", [])}

    apply_rlimits(limits)
    sys.setrecursionlimit(int(limits.get("recursionLimit", 10_000)))
    signal.signal(signal.SIGALRM, _on_alarm)
    signal.signal(signal.SIGXCPU, _on_xcpu)

    # Swallow anything the solution prints at import time.
    sys.stdout = CappedIO(4096)
    sys.stderr = CappedIO(4096)
    try:
        module = importlib.import_module("solution")
        factory = make_callable_factory(module, sig)
        generators = importlib.import_module("generators") if os.path.exists("generators.py") else None
        checker = importlib.import_module("checker") if os.path.exists("checker.py") else None
    except MemoryError:
        sys.stdout, sys.stderr = REAL_STDOUT, REAL_STDERR
        fatal("memory", "ran out of memory while importing solution.py")
    except BaseException as exc:  # noqa: BLE001
        sys.stdout, sys.stderr = REAL_STDOUT, REAL_STDERR
        fatal("import-error", solution_traceback(exc) if exc.__traceback__ else str(exc))
    finally:
        sys.stdout, sys.stderr = REAL_STDOUT, REAL_STDERR

    for case in spec.get("cases", []):
        run_case(case, factory, sig, param_types, generators, checker, limits)

    usage = resource.getrusage(resource.RUSAGE_SELF)
    max_rss_kb = usage.ru_maxrss // 1024 if sys.platform == "darwin" else usage.ru_maxrss
    emit({"event": "done", "maxRssKb": int(max_rss_kb)})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001
        sys.stdout, sys.stderr = REAL_STDOUT, REAL_STDERR
        fatal("runtime-error", traceback.format_exc() or str(exc))
