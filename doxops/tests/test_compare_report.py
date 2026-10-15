from datetime import UTC, datetime
from pathlib import Path

from doxops.compare import compare
from doxops.manifests import ManifestReport
from doxops.models import RunSummary, SuiteRun, TargetInfo, TestResult
from doxops.report import write_outputs


def run(py: str, outcomes: dict[str, str]) -> SuiteRun:
    return SuiteRun(
        label="x",
        python=py,
        install_ok=True,
        tests=[
            TestResult(
                nodeid=k,
                outcome=v,
                message="AttributeError: x" if v == "failed" else "",
                failure_class="AttributeError" if v == "failed" else None,
            )
            for k, v in outcomes.items()
        ],
    )


def test_compare_classifies_changes() -> None:
    comp = compare(
        run("3.12", {"a": "failed", "b": "passed", "c": "passed"}),
        run("3.12", {"a": "passed", "b": "failed", "d": "passed"}),
    )
    changes = {d.nodeid: d.change for d in comp.deltas}
    assert changes == {"a": "fixed", "b": "regressed", "c": "regressed", "d": "new"}
    assert comp.fixed == 1 and comp.regressed == 2
    assert next(d for d in comp.deltas if d.nodeid == "c").failure_class == "Vanished"
    assert next(d for d in comp.deltas if d.nodeid == "b").explanation.startswith("An attribute")


def test_skipping_a_passing_test_is_a_regression() -> None:
    comp = compare(
        run("3.12", {"ran": "passed", "broken": "failed", "skip": "skipped"}),
        run("3.12", {"ran": "skipped", "broken": "skipped", "skip": "skipped"}),
    )
    changes = {d.nodeid: d.change for d in comp.deltas}
    assert changes == {"ran": "regressed", "broken": "still-failing", "skip": "still-passing"}
    assert next(d for d in comp.deltas if d.nodeid == "ran").failure_class == "Skipped"


def test_outputs_render(tmp_path: Path) -> None:
    summary = RunSummary(
        tool="doxops",
        tool_version="0",
        generated_at=datetime.now(UTC),
        target=TargetInfo(source="x", path="x", commit=None, pythons=["3.12"]),
        model=None,
        manifest=ManifestReport(requirements=[], drift=[], python_constraints=[], tool_references=[], files_read=[]),
        baseline=[run("3.12", {"a": "passed"})],
        risks=[],
        capsules=[],
        evidence=[],
        llm_calls=[],
        limitations=["l"],
    )
    paths = write_outputs(summary, tmp_path)
    assert "DoxOps run report" in paths["markdown"].read_text()
    assert "<html" in paths["html"].read_text()
    assert RunSummary.model_validate_json(paths["json"].read_text()).tool == "doxops"
