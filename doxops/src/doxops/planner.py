"""Ask Gemma for a migration plan, then apply it under guardrails.

Design notes taken from the literature:
* Islam et al. (2025, "Using LLMs for Library Migration") found models make unrequested edits,
  drop code from large files and pick APIs from the wrong library version. So we give the model
  exact versions, ask for the analysis first, and accept only minimal find/replace edits that must
  match exactly once - the model never rewrites whole files.
* MigrateLib (Islam et al., 2025) validates every step against a baseline test run and uses a
  runtime call trace to find usages that imports miss. We do both.
* Breaking-Good (Reyes et al., 2024) explains breaking updates by failure category; repair prompts
  carry the categorised failure, not a raw log dump.
"""

from __future__ import annotations

import ast
import json
import re
from dataclasses import dataclass
from pathlib import Path

from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version

from .models import (
    CandidateVetting,
    Comparison,
    DependencyRisk,
    EditOutcome,
    MigrationPlan,
    PackageMetadata,
    Requirement,
    RuntimeCall,
    SuiteRun,
    UsageSite,
)
from .pypi import PyPIClient, available_versions, python_supported

MAX_FULL_FILE_LINES = 300
WINDOW = 15
MANIFEST_NAMES = re.compile(r"(^|/)(requirements[^/]*\.txt|pyproject\.toml|setup\.cfg|setup\.py)$")
TEST_HARNESS = re.compile(r"(^|/)(conftest\.py|pytest\.ini|tox\.ini|noxfile\.py|\.coveragerc)$")

SYSTEM_PROMPT = """You are DoxOps, a careful Python maintenance engineer.
You plan the safe exit from ONE at-risk dependency in a real repository.

Rules:
1. Analyse first, then decide. Base every claim on the facts given; never invent package names or APIs.
2. Choose exactly one strategy: upgrade, replace, stdlib, remove, declare, or keep.
   Prefer the smallest change that removes the risk. Prefer the standard library when it fully covers the usage.
3. Pick a version_spec whose APIs you actually use, and make it compatible with every target Python version.
4. Code changes are minimal find/replace edits. "find" must be copied EXACTLY from the file shown (including
   indentation) and must be unique in that file. Keep edits small: change only lines that use the old API.
5. Do NOT edit requirements*.txt, pyproject.toml, setup.cfg or setup.py: DoxOps rewrites dependency
   declarations itself from your replacement choice.
6. Never weaken, skip or delete tests to make them pass. Do not refactor, reformat, rename or add features.
7. Preserve behaviour exactly (units, defaults, exception types, timeouts, encodings). If the new library
   behaves differently, keep the old behaviour explicitly and list the difference in expected_compatibility_gaps.
8. Reply with one JSON object that matches the schema. No prose outside JSON."""


@dataclass
class PlanContext:
    dist: str
    risk: DependencyRisk
    metadata: PackageMetadata | None
    declarations: list[Requirement]
    usage: list[UsageSite]
    runtime: list[RuntimeCall]
    baseline: list[SuiteRun]
    pythons: list[str]
    other_dependencies: list[str]
    tree: Path


def _numbered(lines: list[str], start: int, end: int) -> str:
    return "\n".join(f"{i + 1:4d} | {lines[i]}" for i in range(start, end))


def file_context(tree: Path, usage: list[UsageSite]) -> str:
    """Whole files when small, otherwise windows around each usage (the model needs exact text to edit)."""
    chunks: list[str] = []
    by_file: dict[str, list[int]] = {}
    for site in usage:
        if site.kind == "runtime-call":
            continue
        by_file.setdefault(site.file, []).append(site.line)
    for rel, lines_used in sorted(by_file.items()):
        path = tree / rel
        if not path.is_file():
            continue
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        if len(lines) <= MAX_FULL_FILE_LINES:
            chunks.append(f"### {rel} (full file, {len(lines)} lines)\n```\n{_numbered(lines, 0, len(lines))}\n```")
            continue
        spans: list[tuple[int, int]] = []
        for ln in sorted(set(lines_used)):
            s, e = max(0, ln - 1 - WINDOW), min(len(lines), ln + WINDOW)
            if spans and s <= spans[-1][1]:
                spans[-1] = (spans[-1][0], max(spans[-1][1], e))
            else:
                spans.append((s, e))
        body = "\n...\n".join(_numbered(lines, s, e) for s, e in spans)
        chunks.append(f"### {rel} (excerpts of {len(lines)} lines)\n```\n{body}\n```")
    return "\n\n".join(chunks) or "(no Python file imports it directly)"


def transitive_packages(ctx: PlanContext, limit: int = 40) -> list[str]:
    """Installed packages the project gets for free through other dependencies (a replacement may already be here)."""
    run = next((r for r in ctx.baseline if r.installed), None)
    if run is None:
        return []
    declared = set(ctx.other_dependencies) | {ctx.dist}
    out: list[str] = []
    for name, version in sorted(run.installed.items()):
        if name in declared:
            continue
        parents = sorted(p for p, reqs in run.requires.items() if name in reqs and p != ctx.dist)
        if parents:
            out.append(f"{name} {version} (required by {', '.join(parents)})")
    return out[:limit]


def build_prompt(ctx: PlanContext) -> str:
    meta = ctx.metadata
    facts = {
        "dependency": ctx.dist,
        "declared_as": [f"{d.source_file}:{d.line} -> {d.raw}" for d in ctx.declarations if not d.commented_out],
        "pinned_version": meta.pinned_version if meta else None,
        "latest_version_on_pypi": meta.latest_version if meta else None,
        "latest_release_date": meta.latest_release_at.date().isoformat() if meta and meta.latest_release_at else None,
        "pypi_project_status": meta.project_status if meta else None,
        "target_python_versions": ctx.pythons,
        "other_project_dependencies": ctx.other_dependencies,
        "already_installed_through_other_dependencies": transitive_packages(ctx),
        "risk_score": ctx.risk.score,
        "risk_indicators": [
            {"code": i.code, "provenance": i.provenance.value, "title": i.title, "detail": i.detail}
            for i in ctx.risk.indicators
        ],
    }
    usage_lines = [f"- {s.file}:{s.line} [{s.kind}] {s.symbol or s.module}  `{s.snippet}`" for s in ctx.usage[:60]] or [
        "- (none found by static analysis)"
    ]
    runtime_lines = [
        f"- {c.caller_file}:{c.caller_line} calls {c.module}.{c.function} ({c.count}x during tests)"
        for c in ctx.runtime[:30]
    ] or ["- (no calls recorded while the test suite ran)"]
    failures: list[str] = []
    for run in ctx.baseline:
        for t in run.tests:
            if t.outcome in ("failed", "error"):
                failures.append(f"- py{run.python} {t.nodeid}: {t.message.splitlines()[0][:300] if t.message else ''}")
    return (
        "## Facts observed or verified by DoxOps\n"
        f"```json\n{json.dumps(facts, indent=2)}\n```\n\n"
        "## Static usage sites\n" + "\n".join(usage_lines) + "\n\n"
        "## Runtime calls recorded during the baseline test run\n" + "\n".join(runtime_lines) + "\n\n"
        "## Baseline test failures (all dependencies, for context)\n" + ("\n".join(failures[:20]) or "- none") + "\n\n"
        "## Source files that use it\n" + file_context(ctx.tree, ctx.usage) + "\n\n"
        "## Task\nPlan the migration for this one dependency following the rules. "
        "If it is unused, choose 'remove'. If it is imported but undeclared, choose 'declare' with a safe specifier. "
        "If a package that is already installed through another dependency does the same job, prefer it. "
        "If the build tooling (Makefile, Dockerfile, CI) calls a command from it, include edits for those files too."
    )


def build_repair_prompt(ctx: PlanContext, previous: MigrationPlan, problems: list[str]) -> str:
    return (
        build_prompt(ctx)
        + "\n\n## Your previous plan\n```json\n"
        + previous.model_dump_json(indent=2)
        + "\n```\n\n## What happened when DoxOps applied and tested it\n"
        + "\n".join(f"- {p}" for p in problems)
        + "\n\nReturn a corrected complete plan. Keep what worked; fix only what failed."
    )


# ------------------------------------------------------------------ vetting


def normalize_spec(spec: str | None) -> str | None:
    """Accept what small models write ('3.1.6', '>= 3.1', '==2.*') and return a PEP 440 specifier string."""
    if spec is None:
        return None
    spec = spec.strip().replace(" ", "")
    if not spec or spec.lower() in ("latest", "any", "*"):
        return None
    if spec[0].isdigit():
        spec = ">=" + spec
    SpecifierSet(spec)  # raises InvalidSpecifier (a ValueError) when still invalid
    return spec


def vet_candidate(plan: MigrationPlan, ctx: PlanContext, pypi: PyPIClient) -> CandidateVetting | None:
    """Stop package hallucinations before anything is installed."""
    choice = plan.replacement
    if choice.strategy in ("stdlib", "remove", "keep"):
        return None
    package = canonicalize_name(choice.package or ctx.dist)
    meta = pypi.fetch({package: None}).get(package)
    vetting = CandidateVetting(package=package, exists_on_index=bool(meta and meta.found))
    if not meta or not meta.found:
        vetting.notes.append(f"'{package}' does not exist on PyPI - the proposal is rejected (possible hallucination).")
        return vetting
    vetting.latest_version = meta.latest_version
    vetting.project_status = meta.project_status
    if meta.project_status in ("archived", "deprecated", "quarantined"):
        vetting.notes.append(f"PyPI marks '{package}' as {meta.project_status}.")
    support = [python_supported(meta.requires_python, py) for py in ctx.pythons]
    vetting.supports_target_python = None if all(s is None for s in support) else all(s is not False for s in support)
    if vetting.supports_target_python is False:
        vetting.notes.append(f"Latest release requires Python '{meta.requires_python}'.")
    if choice.version_spec:
        try:
            spec = SpecifierSet(normalize_spec(choice.version_spec) or "")
        except InvalidSpecifier:
            vetting.notes.append(f"Invalid version specifier '{choice.version_spec}'.")
            return vetting
        versions = available_versions(pypi, package) or []
        matching = [v for v in versions if _safe_in(v, spec)]
        if versions and not matching:
            vetting.notes.append(f"No release of '{package}' satisfies '{choice.version_spec}'.")
    return vetting


def vetting_blocks(v: CandidateVetting | None) -> list[str]:
    if v is None:
        return []
    return [
        n
        for n in v.notes
        if any(k in n for k in ("does not exist", "Invalid version", "No release", "quarantined", "archived"))
    ]


def _safe_in(version: str, spec: SpecifierSet) -> bool:
    try:
        v = Version(version)
    except InvalidVersion:
        return False
    return not v.is_prerelease and v in spec


# ------------------------------------------------------------------ applying a plan


def _test_only(ctx: PlanContext) -> bool:
    files = {s.file for s in ctx.usage if s.kind != "tool-command"}
    return (bool(files) and all(f.startswith(("tests/", "test/")) or "/tests/" in f for f in files)) or (
        not files and any(s.kind == "tool-command" for s in ctx.usage)
    )


def _tolerant_find(text: str, find: str) -> tuple[int, int] | None:
    """Exact match first; otherwise match line-by-line ignoring surrounding whitespace (small models drift)."""
    if text.count(find) == 1:
        start = text.index(find)
        return start, start + len(find)
    if text.count(find) > 1:
        return None
    want = [ln.strip() for ln in find.strip("\n").splitlines()]
    if not want:
        return None
    lines = text.splitlines(keepends=True)
    hits = []
    for i in range(len(lines) - len(want) + 1):
        if all(lines[i + k].strip() == want[k] for k in range(len(want))):
            hits.append(i)
    if len(hits) != 1:
        return None
    start = sum(len(ln) for ln in lines[: hits[0]])
    end = start + sum(len(ln) for ln in lines[hits[0] : hits[0] + len(want)])
    return start, end


def _reindent(original: str, replacement: str) -> str:
    """Keep the original block's indentation when the model dropped or changed it."""
    orig_lines = original.splitlines()
    if not orig_lines:
        return replacement
    base = len(orig_lines[0]) - len(orig_lines[0].lstrip())
    rep_lines = replacement.strip("\n").splitlines()
    if not rep_lines:
        return ""
    rep_base = len(rep_lines[0]) - len(rep_lines[0].lstrip())
    shift = base - rep_base
    out = []
    for ln in rep_lines:
        if not ln.strip():
            out.append("")
        elif shift >= 0:
            out.append(" " * shift + ln)
        else:
            out.append(ln[min(-shift, len(ln) - len(ln.lstrip())) :])
    trailing = "\n" if original.endswith("\n") else ""
    return "\n".join(out) + trailing


def _continue_indent(text: str, start: int, replacement: str) -> str:
    """Treat later lines of a multi-line replacement inserted mid-line as relative to that line's indentation."""
    line_start = text.rfind("\n", 0, start) + 1
    prefix = text[line_start:start]
    lines = replacement.split("\n")
    if len(lines) == 1 or not prefix or prefix.strip():
        return replacement
    return "\n".join([lines[0], *[(prefix + ln) if ln.strip() else ln for ln in lines[1:]]])


def _parses(source: str) -> bool:
    try:
        ast.parse(source)
    except SyntaxError:
        return False
    return True


def apply_edits(plan: MigrationPlan, ctx: PlanContext, tree: Path) -> tuple[list[EditOutcome], bool]:
    outcomes: list[EditOutcome] = []
    touched: set[Path] = set()
    allow_tests = _test_only(ctx)
    root = tree.resolve()
    for edit in plan.edits:
        rel = edit.file.strip().replace("\\", "/").removeprefix("./")
        path = (tree / rel).resolve()
        if not path.is_relative_to(root):
            outcomes.append(EditOutcome(file=rel, applied=False, error="path escapes the repository"))
            continue
        if MANIFEST_NAMES.search(rel):
            outcomes.append(
                EditOutcome(
                    file=rel, applied=False, reason="dependency declarations are rewritten by DoxOps", error=None
                )
            )
            continue
        if (
            rel.startswith(("tests/", "test/"))
            or "/tests/" in rel
            or Path(rel).name.startswith("test_")
            or TEST_HARNESS.search(rel)
        ) and not allow_tests:
            outcomes.append(
                EditOutcome(
                    file=rel, applied=False, error="integrity guard: tests may not be edited for a runtime dependency"
                )
            )
            continue
        if not path.is_file():
            if edit.find.strip():
                outcomes.append(EditOutcome(file=rel, applied=False, error="file does not exist"))
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(edit.replace, encoding="utf-8")
            touched.add(path)
            outcomes.append(EditOutcome(file=rel, applied=True, reason=edit.reason or "new file"))
            continue
        text = path.read_text(encoding="utf-8")
        span = _tolerant_find(text, edit.find)
        if span is None:
            count = text.count(edit.find)
            msg = f"find text occurs {count} times; it must be unique" if count > 1 else "find text not found in file"
            outcomes.append(EditOutcome(file=rel, applied=False, error=msg))
            continue
        s, e = span
        original = text[s:e]
        if original == edit.find:
            options = [_continue_indent(text, s, edit.replace), edit.replace]
        else:
            options = [_reindent(original, edit.replace), edit.replace]
        candidates = [text[:s] + r + text[e:] for r in dict.fromkeys(options)]
        if path.suffix == ".py":
            candidates.sort(key=lambda c: not _parses(c))  # stable: first parseable option wins
        path.write_text(candidates[0], encoding="utf-8")
        touched.add(path)
        outcomes.append(EditOutcome(file=rel, applied=True, reason=edit.reason))
    syntax_ok = True
    for path in touched:
        if path.suffix == ".py":
            try:
                ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            except SyntaxError as exc:
                syntax_ok = False
                outcomes.append(
                    EditOutcome(file=path.relative_to(root).as_posix(), applied=False, error=f"syntax error: {exc}")
                )
    return outcomes, syntax_ok


def _requirement_line(plan: MigrationPlan, dist: str) -> str | None:
    choice = plan.replacement
    if choice.strategy in ("stdlib", "remove", "keep"):
        return None
    name = choice.package or dist
    return f"{name}{normalize_spec(choice.version_spec) or ''}"


def rewrite_manifests(plan: MigrationPlan, ctx: PlanContext, tree: Path) -> list[str]:
    """Apply the replacement choice to every declaration; returns human-readable change notes."""
    choice = plan.replacement
    if choice.strategy == "keep":
        return []
    normalize_spec(choice.version_spec)
    new_line = _requirement_line(plan, ctx.dist)
    changes: list[str] = []
    live = [d for d in ctx.declarations if not d.commented_out and not d.section.startswith("build-system")]
    if choice.strategy == "declare" or not live:
        if new_line is None:
            return changes
        req = tree / "requirements.txt"
        if req.is_file():
            text = req.read_text(encoding="utf-8")
            req.write_text(text.rstrip("\n") + f"\n{new_line}\n", encoding="utf-8")
            changes.append(f"requirements.txt: added `{new_line}`")
        py = tree / "pyproject.toml"
        if py.is_file():
            text = py.read_text(encoding="utf-8")
            m = re.search(r"(?ms)^dependencies\s*=\s*\[(.*?)^\]", text)
            if m:
                insert_at = m.end(1)
                text = text[:insert_at] + f'    "{new_line}",\n' + text[insert_at:]
                py.write_text(text, encoding="utf-8")
                changes.append(f"pyproject.toml: added `{new_line}` to [project].dependencies")
        return changes
    for decl in live:
        path = tree / decl.source_file
        if not path.is_file():
            continue
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
        idx = (decl.line or 0) - 1
        if not (0 <= idx < len(lines)) or decl.raw not in lines[idx]:
            idx = next((i for i, ln in enumerate(lines) if decl.raw in ln), -1)
        if idx < 0:
            continue
        line = lines[idx]
        if new_line is None:
            if path.name == "pyproject.toml" and line.strip().strip(",").strip("\"'") != decl.raw:
                lines[idx] = re.sub(rf"\s*[\"']{re.escape(decl.raw)}[\"']\s*,?", "", line)
            else:
                lines[idx] = ""
            changes.append(f"{decl.source_file}:{decl.line}: removed `{decl.raw}`")
        else:
            lines[idx] = line.replace(decl.raw, new_line, 1)
            changes.append(f"{decl.source_file}:{decl.line}: `{decl.raw}` -> `{new_line}`")
        path.write_text("".join(lines), encoding="utf-8")
    return changes


def normalize_plan(plan: MigrationPlan, dist: str) -> MigrationPlan:
    """Make the model's choice internally consistent before anything is applied."""
    choice = plan.replacement
    if choice.package:
        choice.package = choice.package.strip()
    if choice.strategy == "upgrade" and choice.package and canonicalize_name(choice.package) != dist:
        choice.strategy = "replace"
    if choice.strategy == "replace" and choice.package and canonicalize_name(choice.package) == dist:
        choice.strategy = "upgrade"
    if choice.strategy in ("stdlib", "remove"):
        choice.package = None
        choice.version_spec = None
    if choice.strategy in ("upgrade", "declare") and not choice.package:
        choice.package = dist
    return plan


def summarise_problems(
    edits: list[EditOutcome], runs: list[SuiteRun], comps: list[Comparison], vetting_notes: list[str]
) -> list[str]:
    problems = list(vetting_notes)
    for e in edits:
        if not e.applied and e.error:
            problems.append(f"edit to {e.file} not applied: {e.error}")
    for run in runs:
        if not run.install_ok:
            problems.append(f"Python {run.python}: dependency installation failed ({run.error})")
        elif run.error:
            problems.append(f"Python {run.python}: {run.error}")
        for probe in run.import_probes:
            if not probe.ok:
                problems.append(
                    f"Python {run.python}: import {probe.module} fails: {(probe.error or '').splitlines()[-1:]}"
                )
    for comp in comps:
        for d in comp.deltas:
            if d.change in ("regressed", "still-failing"):
                cls = f" [{d.failure_class}]" if d.failure_class else ""
                problems.append(f"Python {comp.python}: {d.nodeid} {d.change}{cls}: {d.after_message[:300]}")
    return problems[:30]
