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
from dataclasses import dataclass, field
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
    TestResult,
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
   indentation; Makefile recipe lines start with a TAB) and must be unique in that file. The "  12 | " line-number
   gutter in the listings is not part of the file: never copy it into "find" or "replace".
   Keep edits small: change only lines that use the old API.
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
    requires_python: list[str] = field(default_factory=list)  # e.g. [">=3.10"] from pyproject


def untested_pythons(requires_python: list[str], tested: list[str]) -> list[str]:
    """CPython 3.x versions the project claims to support that are older than every version DoxOps tested."""
    try:
        lowest = min(int(v.split(".")[1]) for v in tested)
    except (ValueError, IndexError):
        return []
    older: list[str] = []
    for minor in range(8, lowest):
        version = f"3.{minor}"
        try:
            if requires_python and all(SpecifierSet(spec).contains(version) for spec in requires_python):
                older.append(version)
        except InvalidSpecifier:
            return []
    return older


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
        "project_requires_python": ctx.requires_python,
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


MAX_TRACE_LINES = 25
MAX_FAILURE_CHARS = 4000
MAX_DIFF_CHARS = 6000
MAX_LISTED_TESTS = 8
_FAILED = frozenset({"failed", "error"})
COLLECTION_SUFFIX = "::<collection>"  # node id suffix the probe gives a module that failed to import or collect
_CHANGE_LABELS = {"new": "new failure"}


def _tail(text: str, max_lines: int) -> str:
    return "\n".join(text.strip("\n").splitlines()[-max_lines:])


def _excerpt(result: TestResult | None, message: str, max_lines: int) -> str:
    """The last lines of the probe's traceback (else of the crash message), ending with the error line."""
    message = message.strip()
    trace = result.traceback if result else ""
    excerpt = _tail(trace, max_lines) if trace.strip() else _tail(message, max_lines)
    first = message.splitlines()[0].strip() if message else ""
    if first and first not in excerpt:
        excerpt = f"{excerpt}\n{first}".strip("\n")
    return excerpt


def _collection_error(errors: list[str], nodeid: str) -> str | None:
    """The collection error (its node id) that kept ``nodeid`` from running: its module's, else a parent directory's."""
    path = nodeid.split("::", 1)[0]
    best: str | None = None
    for coll in errors:
        where = coll.removesuffix(COLLECTION_SUFFIX).strip("/")
        if (where in ("", ".") or path == where or path.startswith(where + "/")) and (
            best is None or len(coll) > len(best)
        ):
            best = coll
    return best


@dataclass
class _Excerpt:
    title: str  # what failed, shown before the Python versions
    body: str  # the error text
    suffix: str = ""  # shown after the Python versions (the failure class)
    root_cause: bool = False  # an import, collection or run error: shown before individual test failures
    pythons: list[str] = field(default_factory=list)
    stopped: list[str] = field(default_factory=list)  # tests that passed before and did not run because of it

    def add(self, python: str, stopped: str | None = None) -> None:
        if python not in self.pythons:
            self.pythons.append(python)
        if stopped and stopped not in self.stopped:
            self.stopped.append(stopped)

    def header(self) -> str:
        text = f"### {self.title} on Python {', '.join(self.pythons)}{self.suffix}"
        if self.stopped:
            more = len(self.stopped) - MAX_LISTED_TESTS
            listed = ", ".join(self.stopped[:MAX_LISTED_TESTS]) + (f" (+{more} more)" if more > 0 else "")
            text += f"\nTests that passed before and did not run because of this: {listed}"
        return text


def failure_excerpts(
    runs: list[SuiteRun],
    comps: list[Comparison],
    max_lines: int = MAX_TRACE_LINES,
    max_chars: int = MAX_FAILURE_CHARS,
) -> list[str]:
    """For each regressed, still-failing or newly failing test: its id, failure class and traceback tail.

    The text comes from the executed test run (the probe's traceback, else the crash message), so the model
    sees the real error. A test that vanished because its module no longer imports is folded into that
    module's collection error, so the ImportError itself is shown once instead of one empty block per test;
    vanished tests that no collection error explains (failed install, crashed run) share one block. Identical
    failures on several Python versions are shown once and root causes come first. ``max_chars`` bounds the
    total across all blocks; the end of a traceback (where the error line is) is what gets kept.
    """
    results = {(r.python, t.nodeid): t for r in runs for t in r.tests}
    collection_errors = {
        r.python: [t.nodeid for t in r.tests if t.nodeid.endswith(COLLECTION_SUFFIX) and t.outcome in _FAILED]
        for r in runs
    }
    run_errors = {r.python: (r.error or "").strip() for r in runs}
    blocks: dict[tuple[str, str], _Excerpt] = {}

    def block(title: str, body: str, suffix: str = "", root_cause: bool = False) -> _Excerpt:
        return blocks.setdefault((title + suffix, body), _Excerpt(title, body, suffix, root_cause))

    for comp in comps:
        deltas = {d.nodeid: d for d in comp.deltas}
        not_run: list[str] = []
        for d in comp.deltas:
            vanished = d.change == "regressed" and d.after == "absent"
            if not vanished and not (
                d.change in ("regressed", "still-failing") or (d.change == "new" and d.after in _FAILED)
            ):
                continue
            nodeid = d.nodeid
            coll = _collection_error(collection_errors.get(comp.python, []), nodeid) if vanished else None
            if vanished and coll is None:
                not_run.append(nodeid)
                continue
            if coll is not None:
                nodeid = coll
            result = results.get((comp.python, nodeid))
            source = deltas.get(nodeid)
            change = source.change if source else "new"
            cls = (source.failure_class if source else None) or (result.failure_class if result else None) or ""
            message = result.message if result and result.message else (source.after_message if source else "")
            excerpt = _excerpt(result, message, max_lines) or f"(no error text was captured; the test is now {d.after})"
            entry = block(
                f"{nodeid} - {_CHANGE_LABELS.get(change, change)}",
                excerpt,
                f" [{cls}]" if cls else "",
                root_cause=nodeid.endswith(COLLECTION_SUFFIX),
            )
            entry.add(comp.python, d.nodeid if coll is not None else None)
        if not_run:
            reason = _tail(run_errors.get(comp.python, ""), max_lines) or (
                "(no error text was captured: neither an import nor a collection error explains why they did not run)"
            )
            entry = block(f"{len(not_run)} test(s) that passed before did not run", reason, root_cause=True)
            for nodeid in not_run:
                entry.add(comp.python, nodeid)
    out: list[str] = []
    budget = max_chars
    ordered = sorted(blocks.values(), key=lambda b: not b.root_cause)  # stable: discovery order otherwise
    for n, entry in enumerate(ordered):
        header = entry.header()
        excerpt = entry.body
        room = budget - len(header) - 10
        if room < 120:
            out.append(f"({len(ordered) - n} more failing test(s) omitted to keep the prompt short)")
            break
        if len(excerpt) > room:
            excerpt = "..." + excerpt[-(room - 3) :]
        rendered = f"{header}\n```\n{excerpt}\n```"
        budget -= len(rendered)
        out.append(rendered)
    return out


def build_repair_prompt(
    ctx: PlanContext,
    previous: MigrationPlan,
    problems: list[str],
    failures: list[str] | None = None,
    applied_diff: str = "",
) -> str:
    """The first prompt plus what DoxOps observed when it applied and tested the previous plan."""
    parts = [
        build_prompt(ctx),
        "## Your previous plan\n```json\n" + previous.model_dump_json(indent=2) + "\n```",
        "## What happened when DoxOps applied and tested it\n"
        + ("\n".join(f"- {p}" for p in problems) or "- (no problem summary was recorded)"),
    ]
    if failures:
        parts.append(
            "## Errors from the test run of your previous plan (last lines of each traceback)\n" + "\n\n".join(failures)
        )
    if applied_diff.strip():
        diff = applied_diff.strip("\n")
        if len(diff) > MAX_DIFF_CHARS:
            diff = diff[:MAX_DIFF_CHARS] + "\n... (diff truncated)"
        parts.append(
            "## Exact changes DoxOps applied for your previous plan (unified diff against the original files)\n"
            f"```diff\n{diff}\n```"
        )
    parts.append(
        "Return a corrected complete plan. Keep what worked; fix only what failed. The errors above come from "
        "actually running the tests on your change: fix the cause they show. Every attempt starts again from the "
        "ORIGINAL files listed above, so each 'find' must match the original text, not your previous change."
    )
    return "\n\n".join(parts)


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
    if meta and not meta.found and (meta.error or "").startswith("offline"):
        vetting.notes.append(f"Offline index: could not check that '{package}' exists on PyPI.")
        return vetting
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


def _line_hits(text: str, find: str) -> list[int]:
    """Start lines where ``find`` matches line by line, ignoring each line's surrounding whitespace."""
    want = [ln.strip() for ln in find.strip("\n").splitlines()]
    if not want:
        return []
    lines = text.splitlines()
    return [
        i for i in range(len(lines) - len(want) + 1) if all(lines[i + k].strip() == want[k] for k in range(len(want)))
    ]


def _match_count(text: str, find: str) -> int:
    return text.count(find) or len(_line_hits(text, find))


def _tolerant_find(text: str, find: str) -> tuple[int, int] | None:
    """Exact match first; otherwise match line-by-line ignoring surrounding whitespace (small models drift).

    Leading whitespace is ignored entirely, so tabs versus spaces never prevent a match.
    """
    if text.count(find) == 1:
        start = text.index(find)
        return start, start + len(find)
    if text.count(find) > 1:
        return None
    hits = _line_hits(text, find)
    if len(hits) != 1:
        return None
    lines = text.splitlines(keepends=True)
    n = len(find.strip("\n").splitlines())
    start = sum(len(ln) for ln in lines[: hits[0]])
    end = start + sum(len(ln) for ln in lines[hits[0] : hits[0] + n])
    return start, end


_GUTTER = re.compile(r"^[ \t]*(\d+)[ \t]*\| ?")
TAB_WIDTH = 8


def _strip_gutter(text: str, *, strict: bool = True) -> tuple[str, int] | None:
    """Remove the ``  12 | `` gutter that file_context() adds, when the model copied it into an edit.

    Returns the text without the gutter and the line number on its first non-blank line, or None when the
    text does not carry a gutter: some non-blank line lacks one, so a genuine ``|`` in code (``a | b``) is
    left alone, or (``strict``) the numbers do not count up one per line the way the listing prints them.
    Callers must still check that the first number is the line where the text sits in the file.
    """
    lines = text.split("\n")
    out: list[str] = []
    numbered: list[tuple[int, int]] = []  # (index of the line in the text, number in its gutter)
    for i, ln in enumerate(lines):
        if not ln.strip():
            out.append("")
            continue
        m = _GUTTER.match(ln)
        if m is None:
            return None
        numbered.append((i, int(m.group(1))))
        out.append(ln[m.end() :])
    if not numbered:
        return None
    first_index, first = numbered[0]
    if strict and any(number - first != i - first_index for i, number in numbered):
        return None
    return "\n".join(out), first


def _content_line(text: str, span: tuple[int, int]) -> int:
    """1-based line number of the first non-blank line inside ``text[span[0]:span[1]]``."""
    s, e = span
    blank = next((k for k, ln in enumerate(text[s:e].split("\n")) if ln.strip()), 0)
    return text.count("\n", 0, s) + 1 + blank


def _lines_found_at(texts: list[str], find: str) -> set[int]:
    """Lines where ``find`` matches exactly once, in each of ``texts`` (the file now, and before any edit)."""
    return {_content_line(t, span) for t in texts if (span := _tolerant_find(t, find)) is not None}


def _leading(line: str) -> str:
    return line[: len(line) - len(line.lstrip(" \t"))]


def _first_indent(block: str) -> str | None:
    return next((_leading(ln) for ln in block.splitlines() if ln.strip()), None)


def _width(indent: str) -> int:
    return len(indent.expandtabs(TAB_WIDTH))


def _indent_of_width(style: str, width: int) -> str:
    """Indentation of a visual width, written with tabs when the original block is tab-indented."""
    if "\t" in style:
        return "\t" * (width // TAB_WIDTH) + " " * (width % TAB_WIDTH)
    return " " * width


def _reindent(original: str, replacement: str) -> str:
    """Re-base the replacement onto the original block's indentation string.

    The replacement's first non-blank line takes the original's exact leading whitespace (a Makefile recipe
    keeps its TAB even when the model wrote spaces); deeper lines keep their extra indentation on top of it.
    """
    orig_indent = _first_indent(original)
    rep_lines = replacement.strip("\n").splitlines()
    rep_indent = _first_indent(replacement.strip("\n"))
    if orig_indent is None:
        return replacement
    if not rep_lines or rep_indent is None:
        return ""
    out: list[str] = []
    for ln in rep_lines:
        if not ln.strip():
            out.append("")
            continue
        lead = _leading(ln)
        if lead.startswith(rep_indent):
            out.append(orig_indent + lead[len(rep_indent) :] + ln[len(lead) :])
        else:  # less indented than the first line (or mixed tabs/spaces): keep the relative visual width
            width = max(0, _width(orig_indent) - (_width(rep_indent) - _width(lead)))
            out.append(_indent_of_width(orig_indent, width) + ln[len(lead) :])
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
    before_edits: dict[Path, str] = {}  # gutter numbers refer to the listing, i.e. the file before any edit
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
            or Path(rel).name.endswith("_test.py")
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
            numbered = _strip_gutter(edit.replace)
            new_text = numbered[0] if numbered is not None and numbered[1] == 1 else edit.replace
            path.write_text(new_text, encoding="utf-8", newline="\n")
            touched.add(path)
            outcomes.append(EditOutcome(file=rel, applied=True, reason=edit.reason or "new file"))
            continue
        text = path.read_text(encoding="utf-8")
        texts = list(dict.fromkeys([text, before_edits.setdefault(path, text)]))
        find = edit.find
        span = _tolerant_find(text, find)
        gutter_in_find = False
        if span is None and (numbered := _strip_gutter(find)) is not None:
            stripped, first = numbered
            if _match_count(text, stripped) > 1:
                find = stripped  # reported below as ambiguous: the gutter number does not make a find unique
            elif first in _lines_found_at(texts, stripped):
                # the model copied the listing's line-number gutter: its numbers name the very lines it matches
                find, gutter_in_find = stripped, True
                span = _tolerant_find(text, find)
        if span is None:
            count = _match_count(text, find)
            msg = f"find text occurs {count} times; it must be unique" if count > 1 else "find text not found in file"
            outcomes.append(EditOutcome(file=rel, applied=False, error=msg))
            continue
        s, e = span
        original = text[s:e]
        replace = edit.replace
        # strip a gutter from the replacement when the find had one, or when the replacement's numbers start at
        # the matched line and the file's own text there does not look like one ("    1 | 2")
        numbered = _strip_gutter(replace, strict=not gutter_in_find)
        if numbered is not None and (
            gutter_in_find
            or (_strip_gutter(original, strict=False) is None and numbered[1] in _lines_found_at(texts, find))
        ):
            replace = numbered[0]
        at_line_start = s == 0 or text[s - 1] == "\n"
        orig_indent = _first_indent(original) or ""
        if original == find and not (at_line_start and "\t" in orig_indent):
            options = [_continue_indent(text, s, replace), replace]
        else:  # tolerant match, or a tab-indented block: keep the file's own indentation characters
            options = [_reindent(original, replace), replace]
        candidates = [text[:s] + r + text[e:] for r in dict.fromkeys(options)]
        if path.suffix == ".py":
            candidates.sort(key=lambda c: not _parses(c))  # stable: first parseable option wins
        path.write_text(candidates[0], encoding="utf-8", newline="\n")
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
            req.write_text(text.rstrip("\n") + f"\n{new_line}\n", encoding="utf-8", newline="\n")
            changes.append(f"requirements.txt: added `{new_line}`")
        py = tree / "pyproject.toml"
        if py.is_file():
            text = py.read_text(encoding="utf-8")
            m = re.search(r"(?ms)^dependencies\s*=\s*\[(.*?)^\]", text)
            if m:
                insert_at = m.end(1)
                text = text[:insert_at] + f'    "{new_line}",\n' + text[insert_at:]
                py.write_text(text, encoding="utf-8", newline="\n")
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
        path.write_text("".join(lines), encoding="utf-8", newline="\n")
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
        not_run: list[str] = []
        for d in comp.deltas:
            if d.change == "regressed" and d.after == "absent":
                not_run.append(d.nodeid)  # no message of its own: the module's collection error explains it
            elif d.change in ("regressed", "still-failing") or (d.change == "new" and d.after in _FAILED):
                cls = f" [{d.failure_class}]" if d.failure_class else ""
                label = _CHANGE_LABELS.get(d.change, d.change)
                problems.append(f"Python {comp.python}: {d.nodeid} {label}{cls}: {d.after_message[:300]}")
        if not_run:
            more = len(not_run) - MAX_LISTED_TESTS
            listed = ", ".join(not_run[:MAX_LISTED_TESTS]) + (f" (+{more} more)" if more > 0 else "")
            problems.append(
                f"Python {comp.python}: {len(not_run)} test(s) that passed before did not run "
                f"(their module failed to import or collect, or the run stopped): {listed}"
            )
    return problems[:30]
