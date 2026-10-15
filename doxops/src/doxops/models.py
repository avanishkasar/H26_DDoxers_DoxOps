"""Typed data model for everything DoxOps observes, verifies, or asks the model for.

Every fact carries a ``Provenance`` so the capsule can keep three kinds of
information apart, as the challenge requires:

* ``observed``  - read directly from repository files or package-index metadata
* ``verified``  - proven by a command DoxOps actually executed (has evidence ids)
* ``ai``        - produced by the language model and not yet proven
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Provenance(StrEnum):
    OBSERVED = "observed"
    VERIFIED = "verified"
    AI = "ai"


class Severity(StrEnum):
    NONE = "none"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# --------------------------------------------------------------------------- evidence


class Evidence(_Model):
    """One executed command, with enough detail for a judge to re-run it."""

    id: str
    kind: Literal["install", "import-probe", "test-run", "pip-check", "git", "other"]
    command: list[str]
    cwd: str
    python: str | None = None
    exit_code: int | None
    timed_out: bool = False
    duration_s: float
    started_at: datetime
    log_path: str
    log_sha256: str
    excerpt: str = ""


# --------------------------------------------------------------------------- manifests


class Requirement(_Model):
    name: str  # canonical (PEP 503 normalised) distribution name
    raw: str
    specifier: str = ""
    pinned_version: str | None = None
    extras: list[str] = Field(default_factory=list)
    marker: str | None = None
    source_file: str
    line: int | None = None
    section: str = "dependencies"
    commented_out: bool = False


class ManifestDrift(_Model):
    name: str
    declarations: list[Requirement]
    description: str


class PythonConstraint(_Model):
    source_file: str
    line: int | None = None
    value: str
    kind: Literal["requires-python", "docker-image", "makefile", "classifier", "other"]


class ToolReference(_Model):
    """A command such as ``nosetests`` referenced from Makefile, Dockerfile, CI..."""

    tool: str
    source_file: str
    line: int
    text: str


class ManifestReport(_Model):
    requirements: list[Requirement]
    drift: list[ManifestDrift]
    python_constraints: list[PythonConstraint]
    tool_references: list[ToolReference]
    files_read: list[str]


# --------------------------------------------------------------------------- usage


class UsageSite(_Model):
    file: str
    line: int
    col: int = 0
    module: str
    symbol: str | None = None
    kind: Literal[
        "import",
        "from-import",
        "attribute",
        "call",
        "private-api",
        "monkeypatch",
        "tool-command",
        "runtime-call",
    ]
    snippet: str = ""
    provenance: Provenance = Provenance.OBSERVED


class RuntimeCall(_Model):
    """A call from project code into a dependency, recorded while tests ran."""

    module: str
    function: str
    caller_file: str
    caller_line: int
    count: int


# --------------------------------------------------------------------------- package index


class PackageMetadata(_Model):
    name: str
    found: bool
    latest_version: str | None = None
    latest_release_at: datetime | None = None
    pinned_version: str | None = None
    pinned_release_at: datetime | None = None
    pinned_yanked: bool = False
    pinned_yanked_reason: str | None = None
    requires_python: str | None = None
    pinned_requires_python: str | None = None
    classifiers: list[str] = Field(default_factory=list)
    python_classifiers: list[str] = Field(default_factory=list)
    project_status: str | None = None
    summary: str | None = None
    deprecation_phrases: list[str] = Field(default_factory=list)
    homepage: str | None = None
    repository: str | None = None
    release_count: int = 0
    error: str | None = None


# --------------------------------------------------------------------------- runs


TestOutcome = Literal["passed", "failed", "error", "skipped", "xfailed", "xpassed"]


class TestResult(_Model):
    __test__ = False  # not a pytest test class
    nodeid: str
    outcome: TestOutcome
    duration_s: float = 0.0
    message: str = ""
    failure_class: str | None = None
    frames: list[str] = Field(default_factory=list)


class WarningRecord(_Model):
    category: str
    message: str
    filename: str
    lineno: int
    attributed_to: str | None = None
    count: int = 1


class ImportProbe(_Model):
    distribution: str
    module: str
    ok: bool
    strict_ok: bool
    error: str | None = None
    strict_error: str | None = None
    evidence_ids: list[str] = Field(default_factory=list)


class SuiteRun(_Model):
    label: str
    python: str
    install_ok: bool
    install_evidence: str | None = None
    test_evidence: str | None = None
    collected: int = 0
    tests: list[TestResult] = Field(default_factory=list)
    warnings: list[WarningRecord] = Field(default_factory=list)
    runtime_calls: list[RuntimeCall] = Field(default_factory=list)
    import_probes: list[ImportProbe] = Field(default_factory=list)
    installed: dict[str, str] = Field(default_factory=dict)
    requires: dict[str, list[str]] = Field(default_factory=dict)
    pip_check_ok: bool | None = None
    pip_check_evidence: str | None = None
    error: str | None = None

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for t in self.tests:
            out[t.outcome] = out.get(t.outcome, 0) + 1
        return out


class TestDelta(_Model):
    __test__ = False
    nodeid: str
    python: str
    before: str
    after: str
    change: Literal["fixed", "regressed", "still-failing", "still-passing", "new", "removed"]
    after_message: str = ""
    failure_class: str | None = None
    explanation: str | None = None


class Comparison(_Model):
    python: str
    fixed: int = 0
    regressed: int = 0
    still_failing: int = 0
    still_passing: int = 0
    new: int = 0
    removed: int = 0
    deltas: list[TestDelta] = Field(default_factory=list)
    warnings_before: int = 0
    warnings_after: int = 0
    dependency_warnings_before: int = 0
    dependency_warnings_after: int = 0


# --------------------------------------------------------------------------- risk


class RiskIndicator(_Model):
    code: str
    title: str
    detail: str
    weight: int
    provenance: Provenance
    evidence_ids: list[str] = Field(default_factory=list)


class DependencyRisk(_Model):
    name: str
    declared: bool
    imported_modules: list[str]
    score: int
    severity: Severity
    at_risk: bool
    indicators: list[RiskIndicator]


# --------------------------------------------------------------------------- AI plan


class CodeEdit(BaseModel):
    """A minimal search-and-replace edit proposed by the model."""

    model_config = ConfigDict(extra="ignore")

    file: str = Field(description="Repository-relative path of the file to change")
    find: str = Field(description="Exact existing text to replace; must occur exactly once")
    replace: str = Field(description="Replacement text")
    reason: str = Field(default="", description="Why this edit is needed")


class ReplacementChoice(BaseModel):
    model_config = ConfigDict(extra="ignore")

    strategy: Literal["upgrade", "replace", "stdlib", "remove", "declare", "keep"] = Field(
        description="upgrade = same package newer version; replace = different package; "
        "stdlib = use the Python standard library; remove = delete unused dependency; "
        "declare = add a missing declaration; keep = no change recommended"
    )
    package: str | None = Field(
        default=None, description="Distribution name to depend on afterwards, null for stdlib/remove"
    )
    version_spec: str | None = Field(default=None, description="PEP 440 specifier, e.g. '>=3.1.6,<4'")
    stdlib_module: str | None = Field(default=None, description="Standard library module when strategy=stdlib")


class MigrationPlan(BaseModel):
    """Exactly what the model must return. Kept flat so small models can follow it."""

    model_config = ConfigDict(extra="ignore")

    analysis: str = Field(description="Two to five sentences: what is wrong and why it matters")
    replacement: ReplacementChoice
    rationale: str = Field(description="Why this replacement over the alternatives")
    alternatives_considered: list[str] = Field(default_factory=list)
    migration_steps: list[str] = Field(description="Ordered human-readable steps")
    edits: list[CodeEdit] = Field(default_factory=list)
    suggested_tests: list[str] = Field(default_factory=list)
    expected_compatibility_gaps: list[str] = Field(default_factory=list)
    confidence: Literal["low", "medium", "high"] = "medium"


class LLMCall(_Model):
    provider: str
    model: str
    purpose: str
    prompt_sha256: str
    prompt_path: str
    response_path: str
    latency_s: float
    ok: bool
    error: str | None = None
    attempt: int = 1


class EditOutcome(_Model):
    file: str
    applied: bool
    reason: str = ""
    error: str | None = None


class CandidateVetting(_Model):
    package: str
    exists_on_index: bool
    latest_version: str | None = None
    project_status: str | None = None
    supports_target_python: bool | None = None
    notes: list[str] = Field(default_factory=list)


class MigrationAttempt(_Model):
    attempt: int
    plan: MigrationPlan | None
    llm_call: LLMCall | None
    vetting: CandidateVetting | None = None
    edits: list[EditOutcome] = Field(default_factory=list)
    manifest_changes: list[str] = Field(default_factory=list)
    syntax_ok: bool = True
    runs: list[SuiteRun] = Field(default_factory=list)
    comparisons: list[Comparison] = Field(default_factory=list)
    accepted: bool = False
    verdict: str = ""
    patch_path: str | None = None


# --------------------------------------------------------------------------- capsule


class Fact(_Model):
    text: str
    provenance: Provenance
    evidence_ids: list[str] = Field(default_factory=list)


class DependencyCapsule(_Model):
    """The Dependency Exit Capsule for one dependency."""

    schema_version: Literal["1.0"] = "1.0"
    dependency: str
    declarations: list[Requirement]
    metadata: PackageMetadata | None
    risk: DependencyRisk
    usage: list[UsageSite]
    runtime_usage: list[RuntimeCall]
    proposed_replacement: Fact | None
    analysis: Fact | None
    migration_steps: list[Fact]
    suggested_tests: list[Fact]
    attempts: list[MigrationAttempt]
    executed_results: list[Comparison]
    compatibility_gaps: list[Fact]
    open_concerns: list[Fact]
    status: Literal["verified", "partially-verified", "unverified", "not-attempted", "failed"]


class ModelInfo(_Model):
    provider: str
    model: str
    details: dict[str, str] = Field(default_factory=dict)
    license: str
    access_method: str


class TargetInfo(_Model):
    source: str
    path: str
    commit: str | None
    pythons: list[str]


class RunSummary(_Model):
    schema_version: Literal["1.0"] = "1.0"
    tool: str
    tool_version: str
    generated_at: datetime
    target: TargetInfo
    model: ModelInfo | None
    manifest: ManifestReport
    baseline: list[SuiteRun]
    risks: list[DependencyRisk]
    capsules: list[DependencyCapsule]
    combined: list[SuiteRun] = Field(default_factory=list)
    combined_comparisons: list[Comparison] = Field(default_factory=list)
    combined_patch: str | None = None
    evidence: list[Evidence]
    llm_calls: list[LLMCall]
    limitations: list[str]
