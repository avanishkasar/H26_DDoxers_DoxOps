"""Deterministic, explainable risk scoring. No AI here: every point has a source."""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime

from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version

from .models import (
    DependencyRisk,
    Evidence,
    ManifestReport,
    PackageMetadata,
    Provenance,
    RiskIndicator,
    RuntimeCall,
    Severity,
    SuiteRun,
    TestResult,
    ToolReference,
    UsageSite,
    WarningRecord,
)
from .pypi import python_supported

STALE_YEARS = 3
VERY_STALE_YEARS = 5
AT_RISK_SCORE = 20
_DEPRECATION_CATEGORIES = {"DeprecationWarning", "PendingDeprecationWarning", "FutureWarning"}
_INACTIVE_STATUSES = {"archived", "deprecated", "quarantined"}


@dataclass
class RiskInputs:
    manifest: ManifestReport
    usage: list[UsageSite]
    imported_top: dict[str, list[str]]
    third_party_top: set[str]
    module_to_dist: dict[str, str]
    metadata: dict[str, PackageMetadata]
    baseline: list[SuiteRun]
    tool_references: list[ToolReference]
    tool_commands: dict[str, str]
    pythons: list[str]
    evidence: list[Evidence] = field(default_factory=list)
    now: datetime = field(default_factory=lambda: datetime.now(UTC))


def dist_modules(module_to_dist: dict[str, str], dist: str) -> list[str]:
    return sorted(m for m, d in module_to_dist.items() if d == dist)


def attribute_warning(
    w: WarningRecord, module_to_dist: dict[str, str], sites_by_line: dict[tuple[str, int], list[str]]
) -> str | None:
    """Which distribution a warning is about: emitted inside it, triggered by a line using it, or naming it."""
    if w.filename.startswith("site-packages/"):
        top = w.filename.split("/", 2)[1].removesuffix(".py")
        if top in module_to_dist:
            return module_to_dist[top]
    for module in sites_by_line.get((w.filename, w.lineno), []):
        if module in module_to_dist:
            return module_to_dist[module]
    for module, dist in module_to_dist.items():
        if mentions_module(w.message, module):
            return dist
    return None


def mentions_module(text: str, module: str) -> bool:
    """True when ``module`` appears as a module name, not as part of a path or file suffix (``.py``)."""
    if len(module) < 3:
        return False
    return re.search(rf"(?<![\w./\\-]){re.escape(module)}(?![\w-])", text) is not None


def blamed_dist(test: TestResult, module_to_dist: dict[str, str], declared: set[str]) -> str | None:
    """The declared distribution a failing test should be blamed on.

    The deepest third-party frame in the traceback wins (that is where the error was raised); a transitive
    package is blamed on the declared package that called into it. Falls back to module names in the message.
    """
    frames = [module_to_dist.get(f) for f in test.frames]
    declared_frames = [d for d in frames if d and d in declared]
    if declared_frames:
        return declared_frames[-1]
    for module, dist in module_to_dist.items():
        if dist in declared and mentions_module(test.message, module):
            return dist
    return None


def _years(delta_from: datetime | None, now: datetime) -> float | None:
    if delta_from is None:
        return None
    return (now - delta_from).days / 365.25


def _major(v: str | None) -> int | None:
    try:
        return Version(v).major if v else None
    except InvalidVersion:
        return None


def severity_for(score: int) -> Severity:
    if score >= 60:
        return Severity.CRITICAL
    if score >= 40:
        return Severity.HIGH
    if score >= AT_RISK_SCORE:
        return Severity.MEDIUM
    if score > 0:
        return Severity.LOW
    return Severity.NONE


def assess(inputs: RiskInputs) -> list[DependencyRisk]:
    m2d = inputs.module_to_dist
    declared = {r.name for r in inputs.manifest.requirements if not r.commented_out}
    runtime_declared = {
        r.name for r in inputs.manifest.requirements if not r.commented_out and not r.section.startswith("build-system")
    }
    usage_by_dist: dict[str, list[UsageSite]] = defaultdict(list)
    sites_by_line: dict[tuple[str, int], list[str]] = defaultdict(list)
    for site in inputs.usage:
        sites_by_line[(site.file, site.line)].append(site.module)
        if dist := m2d.get(site.module):
            usage_by_dist[dist].append(site)
    calls_by_dist: dict[str, list[RuntimeCall]] = defaultdict(list)
    for run in inputs.baseline:
        for call in run.runtime_calls:
            if dist := m2d.get(call.module):
                calls_by_dist[dist].append(call)
    imported_dists = {m2d[m] for m in inputs.third_party_top if m in m2d}
    unknown_imports = sorted(m for m in inputs.third_party_top if m not in m2d)
    tools_by_dist: dict[str, list[ToolReference]] = defaultdict(list)
    for ref in inputs.tool_references:
        if dist := inputs.tool_commands.get(ref.tool):
            tools_by_dist[dist].append(ref)

    candidates = sorted(runtime_declared | imported_dists)
    drift = {d.name: d for d in inputs.manifest.drift}
    results: list[DependencyRisk] = []

    for dist in candidates:
        ind: list[RiskIndicator] = []
        modules = dist_modules(m2d, dist)
        meta = inputs.metadata.get(dist)

        # ---------- verified by execution
        for run in inputs.baseline:
            for probe in run.import_probes:
                if canonicalize_name(probe.distribution) != dist:
                    continue
                if not probe.ok:
                    ind.append(
                        RiskIndicator(
                            code="IMPORT_FAILS",
                            title=f"`import {probe.module}` fails on Python {run.python}",
                            detail=(probe.error or "").splitlines()[-1] if probe.error else "import failed",
                            weight=40,
                            provenance=Provenance.VERIFIED,
                            evidence_ids=probe.evidence_ids,
                        )
                    )
                elif not probe.strict_ok:
                    ind.append(
                        RiskIndicator(
                            code="IMPORT_DEPRECATED",
                            title=f"`import {probe.module}` emits a deprecation warning on Python {run.python}",
                            detail=(probe.strict_error or "").splitlines()[-1] if probe.strict_error else "",
                            weight=15,
                            provenance=Provenance.VERIFIED,
                            evidence_ids=probe.evidence_ids,
                        )
                    )
            failing = [
                t for t in run.tests if t.outcome in ("failed", "error") and blamed_dist(t, m2d, declared) == dist
            ]
            if failing:
                ind.append(
                    RiskIndicator(
                        code="TESTS_FAIL",
                        title=f"{len(failing)} test(s) fail because of it on Python {run.python}",
                        detail="; ".join(f"{t.nodeid}: {t.message.splitlines()[0][:160]}" for t in failing[:3]),
                        weight=30,
                        provenance=Provenance.VERIFIED,
                        evidence_ids=[run.test_evidence] if run.test_evidence else [],
                    )
                )
            dep_warnings = [
                w
                for w in run.warnings
                if w.category in _DEPRECATION_CATEGORIES and attribute_warning(w, m2d, sites_by_line) == dist
            ]
            if dep_warnings:
                total = sum(w.count for w in dep_warnings)
                ind.append(
                    RiskIndicator(
                        code="RUNTIME_DEPRECATION",
                        title=f"{total} deprecation warning(s) during tests on Python {run.python}",
                        detail="; ".join(f"{w.filename}:{w.lineno} {w.message[:140]}" for w in dep_warnings[:3]),
                        weight=10,
                        provenance=Provenance.VERIFIED,
                        evidence_ids=[run.test_evidence] if run.test_evidence else [],
                    )
                )
            if run.pip_check_ok is False and run.pip_check_evidence:
                ev = next((e for e in inputs.evidence if e.id == run.pip_check_evidence), None)
                if ev and re.search(rf"\b{re.escape(dist)}\b", ev.excerpt.lower().replace("_", "-")):
                    ind.append(
                        RiskIndicator(
                            code="CONFLICT",
                            title=f"Installed set is inconsistent on Python {run.python}",
                            detail=ev.excerpt.splitlines()[-1][:200] if ev.excerpt else "",
                            weight=20,
                            provenance=Provenance.VERIFIED,
                            evidence_ids=[ev.id],
                        )
                    )
        if tools_by_dist.get(dist) and any(i.code == "IMPORT_FAILS" for i in ind):
            refs = tools_by_dist[dist]
            ind.append(
                RiskIndicator(
                    code="TOOL_BROKEN",
                    title=f"Build tooling calls a command from {dist} that cannot run",
                    detail="; ".join(f"{r.source_file}:{r.line} `{r.text}`" for r in refs[:3]),
                    weight=20,
                    provenance=Provenance.VERIFIED,
                    evidence_ids=sorted({e for i in ind if i.code == "IMPORT_FAILS" for e in i.evidence_ids}),
                )
            )

        # ---------- observed from package index
        if meta and meta.found:
            if meta.project_status in _INACTIVE_STATUSES:
                ind.append(
                    RiskIndicator(
                        code="INDEX_STATUS",
                        title=f"PyPI marks the project '{meta.project_status}' (PEP 792)",
                        detail="The package index itself flags this project as no longer active.",
                        weight=35,
                        provenance=Provenance.OBSERVED,
                    )
                )
            if any("Development Status :: 7 - Inactive" in c for c in meta.classifiers):
                ind.append(
                    RiskIndicator(
                        code="INACTIVE_CLASSIFIER",
                        title="Maintainers declare it inactive",
                        detail="Trove classifier 'Development Status :: 7 - Inactive'",
                        weight=25,
                        provenance=Provenance.OBSERVED,
                    )
                )
            if meta.deprecation_phrases:
                ind.append(
                    RiskIndicator(
                        code="DEPRECATION_NOTICE",
                        title="Project page announces deprecation or end of maintenance",
                        detail=" | ".join(meta.deprecation_phrases[:2]),
                        weight=20,
                        provenance=Provenance.OBSERVED,
                    )
                )
            age = _years(meta.latest_release_at, inputs.now)
            if age is not None and age >= STALE_YEARS:
                ind.append(
                    RiskIndicator(
                        code="STALE_PROJECT",
                        title=f"No release for {age:.1f} years",
                        detail=f"Latest release {meta.latest_version} on {meta.latest_release_at:%Y-%m-%d}",
                        weight=25 if age >= VERY_STALE_YEARS else 15,
                        provenance=Provenance.OBSERVED,
                    )
                )
            if meta.pinned_yanked:
                ind.append(
                    RiskIndicator(
                        code="YANKED_PIN",
                        title=f"Pinned version {meta.pinned_version} was yanked",
                        detail=meta.pinned_yanked_reason or "no reason given",
                        weight=30,
                        provenance=Provenance.OBSERVED,
                    )
                )
            if meta.pinned_version and meta.latest_version and meta.pinned_version != meta.latest_version:
                pin_major, latest_major = _major(meta.pinned_version), _major(meta.latest_version)
                behind = (latest_major - pin_major) if pin_major is not None and latest_major is not None else 0
                pin_age = _years(meta.pinned_release_at, inputs.now)
                age_txt = f", released {pin_age:.1f} years ago" if pin_age is not None else ""
                ind.append(
                    RiskIndicator(
                        code="OUTDATED_PIN",
                        title=(
                            f"Pinned {meta.pinned_version} is {behind} major version(s) behind {meta.latest_version}"
                            if behind > 0
                            else f"Pinned {meta.pinned_version}, latest is {meta.latest_version}"
                        ),
                        detail=f"Exact pin blocks fixes{age_txt}.",
                        weight=20 if behind >= 2 else (15 if behind == 1 else 5),
                        provenance=Provenance.OBSERVED,
                    )
                )
            for py in inputs.pythons:
                rp = meta.pinned_requires_python if meta.pinned_version else meta.requires_python
                if python_supported(rp, py) is False:
                    ind.append(
                        RiskIndicator(
                            code="PYTHON_UNSUPPORTED",
                            title=f"Declares no support for Python {py}",
                            detail=f"requires_python '{rp}'",
                            weight=20,
                            provenance=Provenance.OBSERVED,
                        )
                    )
            if meta.python_classifiers:
                top = max(
                    meta.python_classifiers, key=lambda v: Version(v) if re.fullmatch(r"\d+\.\d+", v) else Version("0")
                )
                newest_target = max(inputs.pythons, key=Version)
                if re.fullmatch(r"\d+\.\d+", top) and Version(top) < Version(newest_target):
                    ind.append(
                        RiskIndicator(
                            code="PYTHON_CLASSIFIERS_OLD",
                            title=f"Latest release only advertises Python up to {top}",
                            detail=f"Target runs Python {', '.join(inputs.pythons)}",
                            weight=5,
                            provenance=Provenance.OBSERVED,
                        )
                    )
        elif meta and not meta.found and meta.error and "not found" in meta.error:
            ind.append(
                RiskIndicator(
                    code="NOT_ON_INDEX",
                    title="Not found on PyPI",
                    detail="The declared name does not exist on the public index (typo, private package, or removed).",
                    weight=30,
                    provenance=Provenance.OBSERVED,
                )
            )

        # ---------- observed from the repository
        if dist in drift:
            ind.append(
                RiskIndicator(
                    code="MANIFEST_DRIFT",
                    title="Declared with conflicting constraints in different files",
                    detail=drift[dist].description,
                    weight=15,
                    provenance=Provenance.OBSERVED,
                )
            )
        if dist in imported_dists and dist not in declared:
            files = sorted({f for m in modules for f in inputs.imported_top.get(m, [])})
            ind.append(
                RiskIndicator(
                    code="UNDECLARED",
                    title="Imported but never declared",
                    detail=f"Only present as a transitive dependency; imported in {', '.join(files[:4])}",
                    weight=20,
                    provenance=Provenance.OBSERVED,
                )
            )
        used = bool(usage_by_dist.get(dist) or calls_by_dist.get(dist) or tools_by_dist.get(dist))
        if dist in runtime_declared and not used:
            parents = sorted({p for run in inputs.baseline for p, reqs in run.requires.items() if dist in reqs})
            detail = "No import, runtime call, or build-tool reference found."
            if parents:
                detail += (
                    f" It is still installed as a dependency of {', '.join(parents)}, so declaring it here only "
                    "constrains their version (an exact pin can hold them back)."
                )
            else:
                detail += " Nothing else in the environment needs it: dead weight."
            ind.append(
                RiskIndicator(
                    code="UNUSED",
                    title="Declared but never imported or invoked",
                    detail=detail,
                    weight=20,
                    provenance=Provenance.OBSERVED,
                )
            )
        private = [s for s in usage_by_dist.get(dist, []) if s.kind == "private-api"]
        if private:
            ind.append(
                RiskIndicator(
                    code="PRIVATE_API",
                    title="Uses private API that can change without notice",
                    detail="; ".join(f"{s.file}:{s.line} `{s.symbol}`" for s in private[:3]),
                    weight=15,
                    provenance=Provenance.OBSERVED,
                )
            )
        patches = [s for s in usage_by_dist.get(dist, []) if s.kind == "monkeypatch"]
        if patches:
            ind.append(
                RiskIndicator(
                    code="MONKEYPATCH",
                    title="Project monkeypatches this library globally",
                    detail="; ".join(f"{s.file}:{s.line} `{s.snippet}`" for s in patches[:3]),
                    weight=10,
                    provenance=Provenance.OBSERVED,
                )
            )

        hangs = [s for s in usage_by_dist.get(dist, []) if s.kind == "no-timeout"]
        if hangs:
            ind.append(
                RiskIndicator(
                    code="NO_TIMEOUT",
                    title="Network calls without a timeout",
                    detail="; ".join(f"{s.file}:{s.line} `{s.snippet}`" for s in hangs[:3])
                    + ". The call can hang forever, timeout handlers are unreachable, and a client with a default "
                    "timeout (e.g. httpx, 5 s) changes behaviour on migration.",
                    weight=10,
                    provenance=Provenance.OBSERVED,
                )
            )

        ind = merge_python_variants(ind)
        score = min(100, sum(_dedupe_weights(ind)))
        verified_hard = any(i.provenance == Provenance.VERIFIED and i.weight >= 25 for i in ind)
        results.append(
            DependencyRisk(
                name=dist,
                declared=dist in declared,
                imported_modules=modules,
                score=score,
                severity=severity_for(score),
                at_risk=score >= AT_RISK_SCORE or verified_hard,
                indicators=ind,
            )
        )
    for module in unknown_imports:
        results.append(
            DependencyRisk(
                name=module,
                declared=False,
                imported_modules=[module],
                score=40,
                severity=Severity.HIGH,
                at_risk=True,
                indicators=[
                    RiskIndicator(
                        code="MISSING",
                        title="Imported but not installed by any declared dependency",
                        detail=f"`{module}` is imported in {', '.join(inputs.imported_top.get(module, [])[:4])}",
                        weight=40,
                        provenance=Provenance.OBSERVED,
                    )
                ],
            )
        )
    results.sort(key=lambda r: (-r.score, r.name))
    return results


def _dedupe_weights(indicators: list[RiskIndicator]) -> list[int]:
    """Count each indicator code once (the heaviest instance) so two Python versions don't double-score."""
    best: dict[str, int] = {}
    for i in indicators:
        best[i.code] = max(best.get(i.code, 0), i.weight)
    return list(best.values())


_PY_IN_TITLE = re.compile(r"Python (3\.\d+)")


def merge_python_variants(indicators: list[RiskIndicator]) -> list[RiskIndicator]:
    """One indicator per finding, listing every Python version it was seen on."""
    merged: dict[tuple[str, str], RiskIndicator] = {}
    versions: dict[tuple[str, str], list[str]] = {}
    for i in indicators:
        key = (i.code, _PY_IN_TITLE.sub("Python {py}", i.title))
        found = _PY_IN_TITLE.findall(i.title)
        if key not in merged:
            merged[key] = i.model_copy(deep=True)
            versions[key] = list(found)
            continue
        cur = merged[key]
        cur.evidence_ids = sorted(set(cur.evidence_ids) | set(i.evidence_ids))
        cur.weight = max(cur.weight, i.weight)
        versions[key] += [v for v in found if v not in versions[key]]
    out: list[RiskIndicator] = []
    for key, ind in merged.items():
        if versions[key]:
            ind.title = key[1].replace("{py}", ", ".join(versions[key]))
        out.append(ind)
    return out
