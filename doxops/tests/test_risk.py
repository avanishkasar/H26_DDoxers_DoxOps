from datetime import UTC, datetime

from doxops.manifests import ManifestReport
from doxops.models import (
    ImportProbe,
    PackageMetadata,
    Provenance,
    Requirement,
    RiskIndicator,
    SuiteRun,
    TestResult,
    UsageSite,
)
from doxops.risk import RiskInputs, assess, blamed_dist, mentions_module, merge_python_variants


def req(name: str, raw: str, pinned: str | None = None) -> Requirement:
    return Requirement(name=name, raw=raw, pinned_version=pinned, source_file="requirements.txt", line=1)


def test_scores_are_explainable() -> None:
    manifest = ManifestReport(
        requirements=[req("jinja2", "Jinja2==2.11.3", "2.11.3"), req("six", "six")],
        drift=[],
        python_constraints=[],
        tool_references=[],
        files_read=[],
    )
    run = SuiteRun(
        label="baseline",
        python="3.12",
        install_ok=True,
        test_evidence="E002",
        tests=[
            TestResult(
                nodeid="t::a",
                outcome="failed",
                message="ImportError: soft_unicode",
                failure_class="ImportError",
                frames=["click", "jinja2", "markupsafe", "jinja2"],
            )
        ],
        import_probes=[
            ImportProbe(
                distribution="Jinja2",
                module="jinja2",
                ok=False,
                strict_ok=False,
                error="ImportError: cannot import name 'soft_unicode'",
                evidence_ids=["E001"],
            )
        ],
    )
    meta = {
        "jinja2": PackageMetadata(
            name="jinja2",
            found=True,
            pinned_version="2.11.3",
            latest_version="3.1.6",
            latest_release_at=datetime(2025, 3, 5, tzinfo=UTC),
        )
    }
    risks = {
        r.name: r
        for r in assess(
            RiskInputs(
                manifest=manifest,
                usage=[
                    UsageSite(file="app/report.py", line=3, module="jinja2", kind="from-import"),
                    UsageSite(file="app/x.py", line=1, module="certifi", kind="import"),
                ],
                imported_top={"jinja2": ["app/report.py"], "certifi": ["app/x.py"]},
                third_party_top={"jinja2", "certifi"},
                module_to_dist={
                    "jinja2": "jinja2",
                    "markupsafe": "markupsafe",
                    "click": "click",
                    "certifi": "certifi",
                    "six": "six",
                },
                metadata=meta,
                baseline=[run],
                tool_references=[],
                tool_commands={},
                pythons=["3.12"],
                now=datetime(2026, 10, 15, tzinfo=UTC),
            )
        )
    }
    codes = {i.code for i in risks["jinja2"].indicators}
    assert {"IMPORT_FAILS", "TESTS_FAIL", "OUTDATED_PIN"} <= codes
    assert all(i.provenance == Provenance.VERIFIED for i in risks["jinja2"].indicators if i.code == "IMPORT_FAILS")
    assert risks["jinja2"].at_risk and risks["jinja2"].severity.value == "critical"
    assert [i.code for i in risks["six"].indicators] == ["UNUSED"]
    assert [i.code for i in risks["certifi"].indicators] == ["UNDECLARED"]


def test_blame_goes_to_deepest_declared_frame() -> None:
    t = TestResult(nodeid="x", outcome="failed", frames=["click", "jinja2", "markupsafe"])
    assert (
        blamed_dist(t, {"click": "click", "jinja2": "jinja2", "markupsafe": "markupsafe"}, {"click", "jinja2"})
        == "jinja2"
    )


def test_module_mentions_ignore_paths() -> None:
    assert mentions_module("No module named 'nose'", "nose")
    assert not mentions_module("/site-packages/markupsafe/__init__.py", "py")
    assert not mentions_module("venvs/appdirs-1-py3.12/lib", "appdirs")


def test_merge_python_variants() -> None:
    a = RiskInputs  # noqa: F841 - keep import used
    merged = merge_python_variants(
        [
            RiskIndicator(
                code="X",
                title="fails on Python 3.12",
                detail="d",
                weight=10,
                provenance=Provenance.VERIFIED,
                evidence_ids=["E1"],
            ),
            RiskIndicator(
                code="X",
                title="fails on Python 3.13",
                detail="d",
                weight=10,
                provenance=Provenance.VERIFIED,
                evidence_ids=["E2"],
            ),
        ]
    )
    assert (
        len(merged) == 1 and merged[0].title == "fails on Python 3.12, 3.13" and merged[0].evidence_ids == ["E1", "E2"]
    )
