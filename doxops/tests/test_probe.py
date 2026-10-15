"""The pytest probe, run for real on a scratch project."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from importlib import resources
from pathlib import Path

TESTS = """
import pytest


@pytest.fixture
def bad_teardown():
    yield
    raise RuntimeError("teardown boom")


def test_call_and_teardown_fail(bad_teardown):
    raise ValueError("the real call failure")


def test_only_teardown_fails(bad_teardown):
    pass
"""


def test_traceback_belongs_to_the_failure_whose_message_is_kept(tmp_path: Path) -> None:
    probe_dir = tmp_path / "probe"
    probe_dir.mkdir()
    probe = resources.files("doxops.probe").joinpath("doxops_probe.py").read_text(encoding="utf-8")
    (probe_dir / "doxops_probe.py").write_text(probe, encoding="utf-8")
    project = tmp_path / "project"
    (project / "tests").mkdir(parents=True)
    (project / "tests" / "test_fixture.py").write_text(TESTS, encoding="utf-8")
    out = tmp_path / "probe.json"
    env = {
        **os.environ,
        "PYTHONPATH": str(probe_dir),
        "DOXOPS_PROBE_OUT": str(out),
        "DOXOPS_PROJECT_ROOT": str(project),
        "DOXOPS_TRACE": "0",
    }
    subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "doxops_probe", "-p", "no:cacheprovider", "tests"],
        cwd=project,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    results = {t["nodeid"]: t for t in json.loads(out.read_text(encoding="utf-8"))["tests"]}
    both = results["tests/test_fixture.py::test_call_and_teardown_fail"]
    assert both["outcome"] == "failed"
    assert both["message"] == "ValueError: the real call failure"
    assert "the real call failure" in both["traceback"] and "teardown boom" not in both["traceback"]
    teardown = results["tests/test_fixture.py::test_only_teardown_fails"]
    assert teardown["outcome"] == "error" and "teardown boom" in teardown["traceback"]
