"""Run a Django project's test suite and report one JSON line per test.

Invoked by the runner as `<env python> -s -P chud_django_harness.py` at the root of
a copy of the project (`manage.py`, `config/`, the app, `tests/`, and for a submit
`hidden_tests/`), with `project.json` holding the test labels and limits. Used by
project sessions: Run passes `["tests"]`, Submit adds `"hidden_tests"`.

Protocol, one JSON object per stdout line, the same as suite_harness.py:
  {"event": "test", "id": "...", "status": "pass" | "fail" | "error" | "skip", "message": "..."}
  {"event": "done"}
  {"event": "fatal", "kind": "import-error" | "runtime-error", "message": "..."}

Django's TestCase sets up its transaction in setUpClass, so the suite runs whole,
through a result object that reports each test as it finishes, rather than test by
test. A hang is caught by the runner's wall clock. Output a test prints is kept
off stdout so it cannot forge a protocol line.
"""

from __future__ import annotations

import io
import json
import os
import resource
import sys
import traceback
import unittest

# `-P` keeps the working directory off sys.path; the project imports from here.
WORKDIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, WORKDIR)

REAL_STDOUT = sys.stdout


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


def tidy(text):
    """Name files by repository path, and fold framework frames out of tracebacks.

    A frame in the project has a relative path once the workdir is stripped; a frame
    in Django or the standard library keeps its absolute one. Runs of those collapse
    into one line, so the candidate's own frames and the error stay in view.
    """
    out = []
    skipping = False
    for line in text.replace(WORKDIR + os.sep, "").split("\n"):
        if line.startswith('  File "'):
            skipping = line.startswith('  File "/') or line.startswith('  File "<')
            if skipping:
                if not out or out[-1] != "  (framework frames hidden)":
                    out.append("  (framework frames hidden)")
                continue
        elif skipping and line.startswith("    "):
            continue
        else:
            skipping = False
        out.append(line)
    return "\n".join(out)


def test_id(test):
    # A module that fails to import becomes a `_FailedTest` named after the module,
    # and a failing setUpClass an `_ErrorHolder` whose description names the class.
    description = getattr(test, "description", None)
    if description:
        return description
    return test.id().replace("unittest.loader._FailedTest.", "")


class StreamingResult(unittest.TestResult):
    """Emit each test's outcome the moment it is known."""

    def __init__(self):
        super().__init__()
        self._outcome = {}

    def _report(self, test, status, message=""):
        emit({"event": "test", "id": test_id(test), "status": status, "message": tidy(message)[-2000:]})

    def addSuccess(self, test):
        super().addSuccess(test)
        self._report(test, "pass")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._report(test, "fail", self.failures[-1][1])

    def addError(self, test, err):
        super().addError(test, err)
        self._report(test, "error", self.errors[-1][1])

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._report(test, "skip", reason)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._report(test, "pass")

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._report(test, "fail", "unexpected success")

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            status = "fail" if issubclass(err[0], test.failureException) else "error"
            self._report(subtest, status, self._exc_info_to_string(err, test))


def main():
    with open(os.path.join(WORKDIR, "project.json"), encoding="utf-8") as fh:
        config = json.load(fh)
    labels = config.get("labels") or ["tests"]
    apply_rlimits(config.get("limits", {}))
    os.environ["DJANGO_SETTINGS_MODULE"] = config.get("settings", "config.settings")

    captured = io.StringIO()
    sys.stdout = captured
    sys.stderr = captured
    try:
        import django

        django.setup()
        from django.test.utils import get_runner
        from django.conf import settings

        runner = get_runner(settings)(verbosity=0, interactive=False)
        runner.setup_test_environment()
        suite = runner.build_suite(labels)
    except Exception:
        sys.stdout = REAL_STDOUT
        emit({"event": "fatal", "kind": "import-error", "message": tidy(traceback.format_exc())[-4000:]})
        os._exit(1)

    try:
        old_config = runner.setup_databases()
        try:
            suite.run(StreamingResult())
        finally:
            runner.teardown_databases(old_config)
            runner.teardown_test_environment()
    except Exception:
        sys.stdout = REAL_STDOUT
        emit({"event": "fatal", "kind": "runtime-error", "message": tidy(traceback.format_exc())[-4000:]})
        os._exit(1)
    sys.stdout = REAL_STDOUT
    emit({"event": "done"})
    os._exit(0)


if __name__ == "__main__":
    main()
