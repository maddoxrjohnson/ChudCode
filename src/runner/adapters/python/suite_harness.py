"""Run a learner's unittest suite against one module and report one JSON line per test.

Invoked by the runner as `python3 -s -P suite_harness.py` inside a workdir that
holds the module under test (`<module>.py`), the learner's `tests/` directory,
and `suite.json` with the limits. Used by the agentic drills: the same suite runs
against the reference, against equivalent rewrites, and against each mutant.

Protocol, one JSON object per stdout line:
  {"event": "scan", "tests": [{"id": "...", "asserts": N}]}
  {"event": "test", "id": "...", "status": "pass" | "fail" | "error" | "timeout", "message": "..."}
  {"event": "done"}
  {"event": "fatal", "kind": "runtime-error", "message": "..."}

The scan counts assertions per test function from the source's syntax tree, so a
test that asserts nothing can be flagged without running it. Each test runs under
its own alarm, so one test that hangs on a mutant is a kill, not a stalled suite.
"""

from __future__ import annotations

import ast
import io
import json
import os
import resource
import signal
import sys
import traceback
import unittest

# `-P` keeps the working directory off sys.path; the module and the tests package
# import from the workdir and nowhere else.
WORKDIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, WORKDIR)

REAL_STDOUT = sys.stdout


class TestTimeout(BaseException):
    """BaseException, so a test's own `except Exception` cannot swallow the alarm."""


def emit(obj):
    REAL_STDOUT.write(json.dumps(obj) + "\n")
    REAL_STDOUT.flush()


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
            pass

    if limits.get("memoryMb"):
        set_limit("RLIMIT_AS", int(limits["memoryMb"]) * 1024 * 1024)
    if limits.get("cpuSeconds"):
        set_limit("RLIMIT_CPU", int(limits["cpuSeconds"]), int(limits["cpuSeconds"]) + 1)
    if limits.get("fileSizeKb") is not None:
        set_limit("RLIMIT_FSIZE", int(limits["fileSizeKb"]) * 1024)
    set_limit("RLIMIT_NOFILE", 64)


# ── The scan ──────────────────────────────────────────────────────────────────


def count_asserts(node):
    count = 0
    for child in ast.walk(node):
        if isinstance(child, ast.Assert):
            count += 1
        elif isinstance(child, ast.Call):
            func = child.func
            name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            if name.startswith("assert") or name in ("fail", "fail_"):
                count += 1
        elif isinstance(child, ast.Raise):
            count += 1  # `raise AssertionError(...)` and friends
    return count


def scan_tests():
    found = []
    tests_dir = os.path.join(WORKDIR, "tests")
    for name in sorted(os.listdir(tests_dir)) if os.path.isdir(tests_dir) else []:
        if not (name.startswith("test") and name.endswith(".py")):
            continue
        try:
            with open(os.path.join(tests_dir, name), encoding="utf-8") as fh:
                tree = ast.parse(fh.read(), filename=name)
        except (SyntaxError, UnicodeDecodeError, ValueError):
            continue
        module = "tests." + name[:-3]
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name.startswith("test"):
                        found.append({"id": f"{module}.{node.name}.{item.name}", "asserts": count_asserts(item)})
    return found


# ── Running ───────────────────────────────────────────────────────────────────


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def _on_alarm(signum, frame):
    raise TestTimeout()


def run_one(test, per_test_ms):
    result = unittest.TestResult()
    captured = io.StringIO()
    sys.stdout = captured
    sys.stderr = captured
    signal.setitimer(signal.ITIMER_REAL, max(per_test_ms, 1) / 1000.0)
    try:
        test.run(result)
        status = "pass"
        message = ""
    except TestTimeout:
        status, message = "timeout", f"took longer than {per_test_ms} ms"
    except RecursionError:
        status, message = "error", "RecursionError"
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        sys.stdout = REAL_STDOUT
        sys.stderr = sys.__stderr__
    if status == "pass":
        if result.failures:
            status, message = "fail", result.failures[0][1]
        elif result.errors:
            # unittest records any exception in a test as an error, the alarm included.
            message = result.errors[0][1]
            status = "timeout" if "TestTimeout" in message else "error"
            if status == "timeout":
                message = f"took longer than {per_test_ms} ms"
        elif result.skipped:
            status, message = "skip", result.skipped[0][1]
        elif result.unexpectedSuccesses:
            status, message = "fail", "unexpected success"
    return status, message[-1500:]


def main():
    with open(os.path.join(WORKDIR, "suite.json"), encoding="utf-8") as fh:
        config = json.load(fh)
    limits = config.get("limits", {})
    emit({"event": "scan", "tests": scan_tests()})
    apply_rlimits(limits)
    signal.signal(signal.SIGALRM, _on_alarm)
    try:
        loader = unittest.TestLoader()
        suite = loader.discover(os.path.join(WORKDIR, "tests"), pattern="test*.py", top_level_dir=WORKDIR)
    except Exception:
        emit({"event": "fatal", "kind": "runtime-error", "message": traceback.format_exc()[-4000:]})
        os._exit(1)
    for test in flatten(suite):
        status, message = run_one(test, int(limits.get("perCaseMs", 2000)))
        emit({"event": "test", "id": test.id(), "status": status, "message": message})
    emit({"event": "done"})
    os._exit(0)


if __name__ == "__main__":
    main()
