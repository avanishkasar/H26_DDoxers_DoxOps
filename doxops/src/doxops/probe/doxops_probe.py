"""pytest plugin injected into the target's test run (``-p doxops_probe``).

It records per-test outcomes, every warning, and - when tracing is on - each call
that project code makes into a third-party package. The call trace is the
dynamic half of usage discovery: it finds dependency calls that a static import
scan misses and shows which usages the test suite actually exercises.

Standard library only: this file runs inside the target's own virtualenv.
"""

from __future__ import annotations

import json
import os
import re
import sys
import sysconfig
import threading
from collections import Counter
from pathlib import Path

_OUT = os.environ.get("DOXOPS_PROBE_OUT")
_ROOT = os.path.normcase(os.path.abspath(os.environ.get("DOXOPS_PROJECT_ROOT", os.getcwd())))
_TRACE = os.environ.get("DOXOPS_TRACE", "1") == "1"
_MAX_MSG = 4000

_tests: dict[str, dict] = {}
_warnings: Counter = Counter()
_calls: Counter = Counter()
_collected = 0


def _site_dirs() -> list[str]:
    dirs = {sysconfig.get_paths()["purelib"], sysconfig.get_paths()["platlib"]}
    return sorted({os.path.normcase(os.path.abspath(d)) + os.sep for d in dirs}, key=len, reverse=True)


_SITE = _site_dirs()
_STDLIB = os.path.normcase(os.path.abspath(sysconfig.get_paths()["stdlib"])) + os.sep


def _top_module(filename: str) -> str | None:
    norm = os.path.normcase(os.path.abspath(filename))
    for site in _SITE:
        if norm.startswith(site):
            rel = norm[len(site) :]
            first = rel.split(os.sep, 1)[0]
            return first[:-3] if first.endswith(".py") else first
    return None


def _project_file(filename: str) -> str | None:
    if not filename or filename.startswith("<"):
        return None
    norm = os.path.normcase(os.path.abspath(filename))
    if not norm.startswith(_ROOT + os.sep):
        return None
    if any(norm.startswith(site) for site in _SITE) or norm.startswith(_STDLIB):
        return None
    rel = os.path.relpath(norm, _ROOT)
    if rel.split(os.sep, 1)[0] in {".venv", "venv", ".doxops", "_doxops_probe"}:
        return None
    return Path(rel).as_posix()


def _profiler(frame, event, arg):
    if event != "call":
        return
    caller = frame.f_back
    if caller is None:
        return
    module = _top_module(frame.f_code.co_filename)
    if module is None or module.startswith("_pytest") or module in {"pytest", "pluggy", "doxops_probe"}:
        return
    project = _project_file(caller.f_code.co_filename)
    if project is None:
        return
    qualname = getattr(frame.f_code, "co_qualname", frame.f_code.co_name)
    _calls[(module, qualname, project, caller.f_lineno)] += 1


_SITE_FRAME = re.compile(r"site-packages[\\/]+([A-Za-z0-9_]+)")


def _frames(report) -> list[str]:
    """Third-party top-level modules appearing in the failure traceback, outermost first."""
    text = getattr(report, "longreprtext", "") or ""
    seen: list[str] = []
    for m in _SITE_FRAME.finditer(text):
        mod = m.group(1)
        if mod in ("_pytest", "pluggy", "pytest"):
            continue
        if not seen or seen[-1] != mod:
            seen.append(mod)
    return seen[-12:]


def _crash_message(report) -> str:
    crash = getattr(getattr(report, "longrepr", None), "reprcrash", None)
    if crash is not None and getattr(crash, "message", None):
        return str(crash.message)[:_MAX_MSG]
    text = getattr(report, "longreprtext", "") or ""
    return text[-_MAX_MSG:]


_MAX_TB_LINES = 40


def _display_path(path: str) -> str:
    """Repository-relative path, or ``site-packages/...`` for installed code (portable, leaks no host paths)."""
    norm = os.path.normcase(os.path.abspath(path))
    for site in _SITE:
        if norm.startswith(site):
            return "site-packages/" + Path(norm[len(site) :]).as_posix()
    if norm.startswith(_STDLIB):
        return "stdlib/" + Path(norm[len(_STDLIB) :]).as_posix()
    if norm.startswith(_ROOT + os.sep):
        return Path(os.path.relpath(norm, _ROOT)).as_posix()
    return str(path)


def _is_marker(line: str) -> bool:
    """Python 3.11+ position markers (``^^^^``/``~~~~``) carry no information for a reader of the excerpt."""
    body = line.lstrip(">E ").strip()
    return bool(body) and not body.strip("^~")


def _traceback(report) -> str:
    """Compact failure traceback: per frame its location, the failing line and the error lines."""
    out: list[str] = []
    chain = getattr(getattr(report, "longrepr", None), "chain", None)
    try:
        for reprtraceback, _crash, descr in chain or []:
            for entry in getattr(reprtraceback, "reprentries", None) or []:
                lines = [str(ln) for ln in (getattr(entry, "lines", None) or [])]
                loc = getattr(entry, "reprfileloc", None)
                if loc is not None:
                    out.append(f"{_display_path(str(loc.path))}:{loc.lineno}: {loc.message}")
                source = [ln for ln in lines if ln.startswith(">")]
                if not source:
                    source = [ln for ln in lines if ln.strip() and not ln.startswith("E ") and not _is_marker(ln)][-1:]
                out.extend(source)
                out.extend(ln for ln in lines if ln.startswith("E "))
            if descr:
                out.append(str(descr))
    except (TypeError, ValueError, AttributeError):
        out = []
    if not out:
        out = (getattr(report, "longreprtext", "") or "").splitlines()
    return "\n".join(out[-_MAX_TB_LINES:])[-_MAX_MSG:]


def pytest_sessionstart(session):
    if _TRACE:
        threading.setprofile(_profiler)
        sys.setprofile(_profiler)


def pytest_collection_finish(session):
    global _collected
    _collected = len(session.items)


def pytest_runtest_logreport(report):
    entry = _tests.setdefault(
        report.nodeid, {"outcome": "passed", "duration_s": 0.0, "message": "", "frames": [], "traceback": ""}
    )
    if report.failed and not entry["traceback"]:
        # the first failing phase is the one whose message is kept (a teardown failing after a failed call
        # must not replace the call's traceback with its own)
        entry["frames"] = _frames(report)
        entry["traceback"] = _traceback(report)
    entry["duration_s"] += float(getattr(report, "duration", 0.0) or 0.0)
    if hasattr(report, "wasxfail"):
        entry["outcome"] = "xpassed" if report.passed else "xfailed"
        return
    if report.when == "setup" and report.failed:
        entry["outcome"] = "error"
        entry["message"] = _crash_message(report)
    elif report.when == "call":
        if report.failed:
            entry["outcome"] = "failed"
            entry["message"] = _crash_message(report)
        elif report.skipped:
            entry["outcome"] = "skipped"
    elif report.when == "teardown" and report.failed and entry["outcome"] == "passed":
        entry["outcome"] = "error"
        entry["message"] = _crash_message(report)
    if report.skipped and report.when == "setup":
        entry["outcome"] = "skipped"


def pytest_collectreport(report):
    if report.failed:
        _tests[f"{report.nodeid}::<collection>"] = {
            "outcome": "error",
            "duration_s": 0.0,
            "message": _crash_message(report),
            "frames": _frames(report),
            "traceback": _traceback(report),
        }


def pytest_warning_recorded(warning_message, when, nodeid, location):
    _warnings[
        (
            warning_message.category.__name__,
            str(warning_message.message)[:500],
            str(warning_message.filename),
            int(warning_message.lineno or 0),
        )
    ] += 1


def pytest_sessionfinish(session, exitstatus):
    sys.setprofile(None)
    threading.setprofile(None)
    if not _OUT:
        return
    payload = {
        "collected": _collected,
        "tests": [{"nodeid": k, **v} for k, v in _tests.items()],
        "warnings": [
            {"category": c, "message": m, "filename": f, "lineno": ln, "count": n}
            for (c, m, f, ln), n in _warnings.items()
        ],
        "calls": [
            {"module": mod, "function": fn, "caller_file": cf, "caller_line": cl, "count": n}
            for (mod, fn, cf, cl), n in _calls.most_common(500)
        ],
        "site_packages": _SITE,
    }
    Path(_OUT).write_text(json.dumps(payload, indent=2), encoding="utf-8")
