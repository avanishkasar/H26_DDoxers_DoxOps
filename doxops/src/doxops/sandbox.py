"""Isolated virtualenvs per (tree, Python version): install, probe imports, run the tests."""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path

from packaging.utils import canonicalize_name

from .evidence import EvidenceLog
from .models import ImportProbe, RuntimeCall, SuiteRun, TestResult, WarningRecord

INSTALL_TIMEOUT_S = 900.0
TEST_TIMEOUT_S = 900.0
PROBE_TIMEOUT_S = 600.0

_EXC_NAME = re.compile(r"^(?:E\s+)?(?P<name>[A-Za-z_][\w.]*(?:Error|Exception|Warning|Exit|Interrupt|Timeout))\b")


class SandboxError(RuntimeError):
    pass


def uv_executable() -> str:
    found = shutil.which("uv")
    if not found:
        raise SandboxError("uv is required (https://docs.astral.sh/uv/). Install it, then re-run 'doxops doctor'.")
    return found


def venv_python(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def failure_class(message: str) -> str | None:
    """Breaking-Good style category from the crash line: ImportError, AttributeError, ..."""
    for line in message.splitlines():
        m = _EXC_NAME.match(line.strip())
        if m:
            return m["name"].rsplit(".", 1)[-1]
    if "Timeout" in message or "timed out" in message:
        return "Timeout"
    if message.startswith("assert") or "AssertionError" in message:
        return "AssertionError"
    return None


@dataclass
class EnvInfo:
    python: str
    venv: Path
    install_ok: bool
    install_evidence: str | None
    packages_distributions: dict[str, list[str]] = field(default_factory=dict)
    installed: dict[str, str] = field(default_factory=dict)
    requires: dict[str, list[str]] = field(default_factory=dict)
    console_scripts: dict[str, list[str]] = field(default_factory=dict)
    purelib: str = ""
    probes: list[ImportProbe] = field(default_factory=list)
    error: str | None = None


def install_spec(tree: Path, extra_requirements: list[str] | None = None) -> list[str]:
    """What to install, mirroring how the project documents installation.

    Requirement files win (that is what LinkWatch's Makefile, Dockerfile and README use);
    otherwise the project itself is installed with its test extras.
    """
    args: list[str] = []
    req_files = sorted(p for p in tree.glob("requirements*.txt") if p.is_file())
    for path in req_files:
        args += ["-r", str(path)]
    if not req_files and (tree / "pyproject.toml").is_file():
        args += ["-e", str(tree)]
    for extra in extra_requirements or []:
        args.append(extra)
    return args


class Sandbox:
    def __init__(self, work_dir: Path, evidence: EvidenceLog) -> None:
        self.work_dir = work_dir
        self.venvs = work_dir / "venvs"
        self.venvs.mkdir(parents=True, exist_ok=True)
        self.evidence = evidence
        self.probe_dir = work_dir / "_doxops_probe"
        self.probe_dir.mkdir(parents=True, exist_ok=True)
        for name in ("doxops_probe.py", "env_probe.py"):
            src = resources.files("doxops.probe").joinpath(name)
            (self.probe_dir / name).write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
        self.uv = uv_executable()

    # ------------------------------------------------------------------ environments

    def create_env(self, tree: Path, python: str, label: str, needs_pytest: bool) -> EnvInfo:
        venv = self.venvs / f"{label}-py{python}"
        if venv.exists():
            shutil.rmtree(venv, ignore_errors=True)
        ev, _ = self.evidence.run(
            "install",
            [self.uv, "venv", "--python", python, str(venv)],
            tree,
            python=python,
            timeout_s=INSTALL_TIMEOUT_S,
        )
        if ev.exit_code != 0:
            return EnvInfo(python, venv, False, ev.id, error=f"could not create Python {python} environment")
        extra = ["pytest"] if needs_pytest else []
        cmd = [self.uv, "pip", "install", "--python", str(venv_python(venv)), *install_spec(tree, extra)]
        ev, _ = self.evidence.run("install", cmd, tree, python=python, timeout_s=INSTALL_TIMEOUT_S)
        ok = ev.exit_code == 0
        return EnvInfo(python, venv, ok, ev.id, error=None if ok else "dependency installation failed")

    def introspect(self, env: EnvInfo, tree: Path, dists: list[str], modules: list[str]) -> EnvInfo:
        """Map import names to distributions and probe each module import (normal and warnings-as-errors)."""
        out = self.work_dir / f"env-{env.venv.name}.json"
        ev, _ = self.evidence.run(
            "import-probe",
            [str(venv_python(env.venv)), str(self.probe_dir / "env_probe.py"), str(out), ",".join(dists), *modules],
            tree,
            python=env.python,
            timeout_s=PROBE_TIMEOUT_S,
        )
        if ev.exit_code != 0 or not out.is_file():
            env.error = env.error or "import probe failed"
            return env
        data = json.loads(out.read_text(encoding="utf-8"))
        env.packages_distributions = data["packages_distributions"]
        env.installed = data["installed"]
        env.requires = data.get("requires", {})
        env.console_scripts = data["console_scripts"]
        env.purelib = data["purelib"]
        for probe in data["probes"]:
            dists = env.packages_distributions.get(probe["module"], [])
            env.probes.append(
                ImportProbe(
                    distribution=dists[0] if dists else probe["module"],
                    module=probe["module"],
                    ok=probe["ok"],
                    strict_ok=probe["strict_ok"],
                    error=sanitize(probe["error"], tree, env.purelib),
                    strict_error=sanitize(probe["strict_error"], tree, env.purelib),
                    evidence_ids=[ev.id],
                )
            )
        return env

    def pip_check(self, env: EnvInfo, tree: Path) -> tuple[bool, str]:
        ev, _ = self.evidence.run(
            "pip-check",
            [self.uv, "pip", "check", "--python", str(venv_python(env.venv))],
            tree,
            python=env.python,
            timeout_s=120,
        )
        return ev.exit_code == 0, ev.id

    # ------------------------------------------------------------------ tests

    def run_tests(self, env: EnvInfo, tree: Path, label: str, trace: bool = True) -> SuiteRun:
        run = SuiteRun(label=label, python=env.python, install_ok=env.install_ok, install_evidence=env.install_evidence)
        run.import_probes = env.probes
        run.installed = {canonicalize_name(k): v for k, v in env.installed.items()}
        run.requires = {canonicalize_name(k): v for k, v in env.requires.items()}
        if not env.install_ok:
            run.error = env.error or "install failed"
            return run
        ok, pc_id = self.pip_check(env, tree)
        run.pip_check_ok, run.pip_check_evidence = ok, pc_id
        out = self.work_dir / f"probe-{label}-py{env.python}.json"
        out.unlink(missing_ok=True)
        py_path = os.pathsep.join([str(self.probe_dir), str(tree)])
        ev, _ = self.evidence.run(
            "test-run",
            [
                str(venv_python(env.venv)),
                "-m",
                "pytest",
                "-p",
                "doxops_probe",
                "-p",
                "no:cacheprovider",
                "-o",
                "addopts=",
                "-q",
                "-rA",
                "--rootdir",
                str(tree),
                "--basetemp",  # keep pytest's tmp_path inside the output folder (no user names in logs)
                str(self.work_dir / f"pytest-{label}-py{env.python}"),
            ],
            tree,
            python=env.python,
            timeout_s=TEST_TIMEOUT_S,
            env={
                "PYTHONPATH": py_path,
                "DOXOPS_PROBE_OUT": str(out),
                "DOXOPS_PROJECT_ROOT": str(tree),
                "DOXOPS_TRACE": "1" if trace else "0",
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        )
        run.test_evidence = ev.id
        if not out.is_file():
            run.error = "test run produced no results (pytest crashed or timed out)"
            if ev.timed_out:
                run.error = f"test run timed out after {TEST_TIMEOUT_S:.0f}s"
            return run
        data = json.loads(out.read_text(encoding="utf-8"))
        run.collected = data["collected"]
        run.tests = [
            TestResult(
                nodeid=t["nodeid"],
                outcome=t["outcome"],
                duration_s=round(t["duration_s"], 3),
                message=sanitize(t["message"], tree, env.purelib) or "",
                frames=t.get("frames", []),
                failure_class=failure_class(t["message"]) if t["outcome"] in ("failed", "error") else None,
            )
            for t in data["tests"]
        ]
        run.warnings = [
            WarningRecord(
                category=w["category"],
                message=sanitize(w["message"], tree, env.purelib) or "",
                filename=_rel(w["filename"], tree, env.purelib),
                lineno=w["lineno"],
                count=w["count"],
            )
            for w in data["warnings"]
        ]
        run.runtime_calls = [RuntimeCall(**c) for c in data["calls"]]
        return run


def sanitize(text: str | None, tree: Path, purelib: str) -> str | None:
    """Strip machine-specific absolute paths so capsules are portable and leak nothing about the host."""
    if not text:
        return text
    for base, label in ((purelib, "site-packages"), (str(tree), ".")):
        if base:
            for variant in {base, base.replace("\\", "/")}:
                text = text.replace(variant.rstrip("/\\") + os.sep, label + "/").replace(
                    variant.rstrip("/\\") + "/", label + "/"
                )
                text = text.replace(variant, label)
    return text


def _rel(filename: str, tree: Path, purelib: str) -> str:
    try:
        return Path(filename).resolve().relative_to(tree.resolve()).as_posix()
    except ValueError:
        pass
    if purelib:
        try:
            return "site-packages/" + Path(filename).resolve().relative_to(Path(purelib).resolve()).as_posix()
        except ValueError:
            pass
    return filename


def current_python() -> str:
    return f"{sys.version_info.major}.{sys.version_info.minor}"
