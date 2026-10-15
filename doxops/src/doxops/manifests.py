"""Read every place a Python project declares dependencies or a Python version."""

from __future__ import annotations

import re
import tomllib
from collections import defaultdict
from pathlib import Path

from packaging.requirements import InvalidRequirement
from packaging.requirements import Requirement as PkgRequirement
from packaging.utils import canonicalize_name

from .models import ManifestDrift, ManifestReport, PythonConstraint, Requirement

REQUIREMENT_GLOBS = ("requirements*.txt", "requirements/*.txt", "*requirements*.in")
SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".doxops", "build", "dist", ".tox"}

_DOCKER_PY = re.compile(r"^\s*FROM\s+(?:\S+/)?python:(?P<ver>\d+\.\d+)", re.IGNORECASE)
_MAKE_PY = re.compile(r"^\s*PYTHON\s*\??[:]?=\s*\S*?python(?P<ver>\d+\.\d+)")
_CI_PY = re.compile(r"python-version\s*:\s*\[?(?P<ver>[\"']?\d+\.\d+[^\n]*)")


def _iter_files(root: Path, patterns: tuple[str, ...]) -> list[Path]:
    seen: set[Path] = set()
    for pattern in patterns:
        for path in root.glob(pattern):
            if path.is_file() and not (set(path.relative_to(root).parts) & SKIP_DIRS):
                seen.add(path)
    return sorted(seen)


def _parse_line(text: str, source: str, line: int, section: str, commented: bool) -> Requirement | None:
    candidate = text.split(" #", 1)[0].strip()
    if not candidate or candidate.startswith(("-", "http://", "https://", "git+", ".", "/")):
        return None
    try:
        req = PkgRequirement(candidate)
    except InvalidRequirement:
        return None
    pinned: str | None = None
    specs = list(req.specifier)
    if len(specs) == 1 and specs[0].operator in ("==", "==="):
        pinned = specs[0].version
    return Requirement(
        name=canonicalize_name(req.name),
        raw=candidate,
        specifier=str(req.specifier),
        pinned_version=pinned,
        extras=sorted(req.extras),
        marker=str(req.marker) if req.marker else None,
        source_file=source,
        line=line,
        section=section,
        commented_out=commented,
    )


def parse_requirements_file(path: Path, root: Path, _seen: set[Path] | None = None) -> list[Requirement]:
    seen = _seen if _seen is not None else set()
    path = path.resolve()
    if path in seen or not path.is_file():
        return []
    seen.add(path)
    rel = path.relative_to(root.resolve()).as_posix()
    out: list[Requirement] = []
    for lineno, raw in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped.startswith(("-r ", "--requirement ")):
            include = stripped.split(maxsplit=1)[1].strip()
            out.extend(parse_requirements_file(path.parent / include, root, seen))
            continue
        if stripped.startswith("#"):
            # A commented-out requirement is still a signal (a dependency someone parked).
            req = _parse_line(stripped.lstrip("#").strip(), rel, lineno, "requirements", commented=True)
            if req is not None and re.search(r"[=<>~!]", req.raw):
                out.append(req)
            continue
        req = _parse_line(stripped, rel, lineno, "requirements", commented=False)
        if req is not None:
            out.append(req)
    return out


def _line_of(text: str, needle: str) -> int | None:
    for lineno, line in enumerate(text.splitlines(), start=1):
        if needle in line:
            return lineno
    return None


def parse_pyproject(path: Path, root: Path) -> tuple[list[Requirement], list[PythonConstraint]]:
    rel = path.relative_to(root).as_posix()
    text = path.read_text(encoding="utf-8")
    data = tomllib.loads(text)
    reqs: list[Requirement] = []
    constraints: list[PythonConstraint] = []

    def add(items: list[str], section: str) -> None:
        for item in items:
            req = _parse_line(item, rel, _line_of(text, item) or 0, section, commented=False)
            if req is not None:
                reqs.append(req)

    project = data.get("project", {})
    add(project.get("dependencies", []), "project.dependencies")
    for extra, items in project.get("optional-dependencies", {}).items():
        add(items, f"project.optional-dependencies.{extra}")
    for group, items in data.get("dependency-groups", {}).items():
        add([i for i in items if isinstance(i, str)], f"dependency-groups.{group}")
    add(data.get("build-system", {}).get("requires", []), "build-system.requires")

    if rp := project.get("requires-python"):
        constraints.append(
            PythonConstraint(source_file=rel, line=_line_of(text, "requires-python"), value=rp, kind="requires-python")
        )
    for classifier in project.get("classifiers", []):
        if classifier.startswith("Programming Language :: Python :: 3."):
            constraints.append(
                PythonConstraint(source_file=rel, line=_line_of(text, classifier), value=classifier, kind="classifier")
            )
    return reqs, constraints


def _python_hints(root: Path) -> list[PythonConstraint]:
    out: list[PythonConstraint] = []
    candidates = [
        *_iter_files(root, ("Dockerfile", "*.Dockerfile", "Dockerfile.*")),
        *_iter_files(root, ("Makefile", "makefile", "GNUmakefile")),
        *_iter_files(root, (".github/workflows/*.yml", ".github/workflows/*.yaml")),
        *_iter_files(root, (".python-version",)),
    ]
    for path in candidates:
        rel = path.relative_to(root).as_posix()
        for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
            if m := _DOCKER_PY.match(line):
                out.append(PythonConstraint(source_file=rel, line=lineno, value=m["ver"], kind="docker-image"))
            elif m := _MAKE_PY.match(line):
                out.append(PythonConstraint(source_file=rel, line=lineno, value=m["ver"], kind="makefile"))
            elif m := _CI_PY.search(line):
                out.append(PythonConstraint(source_file=rel, line=lineno, value=m["ver"].strip(), kind="other"))
            elif path.name == ".python-version" and line.strip():
                out.append(PythonConstraint(source_file=rel, line=lineno, value=line.strip(), kind="other"))
    return out


def find_drift(requirements: list[Requirement]) -> list[ManifestDrift]:
    """Same distribution declared differently in two places: installs depend on which file you use."""
    by_name: dict[str, list[Requirement]] = defaultdict(list)
    for req in requirements:
        if not req.commented_out and not req.section.startswith("build-system"):
            by_name[req.name].append(req)
    drift: list[ManifestDrift] = []
    for name, decls in sorted(by_name.items()):
        files = {d.source_file for d in decls}
        specs = {d.specifier for d in decls}
        if len(files) > 1 and len(specs) > 1:
            parts = ", ".join(f"{d.source_file}:{d.line} '{d.specifier or 'any'}'" for d in decls)
            drift.append(
                ManifestDrift(
                    name=name,
                    declarations=decls,
                    description=f"{name} is declared with different constraints: {parts}",
                )
            )
    return drift


def read_manifests(root: Path) -> ManifestReport:
    root = root.resolve()
    reqs: list[Requirement] = []
    constraints: list[PythonConstraint] = []
    files_read: list[str] = []
    for path in _iter_files(root, REQUIREMENT_GLOBS):
        files_read.append(path.relative_to(root).as_posix())
        reqs.extend(parse_requirements_file(path, root))
    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        files_read.append("pyproject.toml")
        p_reqs, p_constraints = parse_pyproject(pyproject, root)
        reqs.extend(p_reqs)
        constraints.extend(p_constraints)
    constraints.extend(_python_hints(root))
    return ManifestReport(
        requirements=reqs,
        drift=find_drift(reqs),
        python_constraints=constraints,
        tool_references=[],
        files_read=files_read,
    )


def runtime_requirement_names(report: ManifestReport) -> list[str]:
    """Distributions the project needs at run or test time (not build backends)."""
    names: list[str] = []
    for req in report.requirements:
        if req.commented_out or req.section.startswith("build-system"):
            continue
        if req.name not in names:
            names.append(req.name)
    return names
