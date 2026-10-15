from pathlib import Path

from doxops.manifests import read_manifests, runtime_requirement_names


def test_requirements_includes_comments_and_pins(demo_repo: Path) -> None:
    report = read_manifests(demo_repo)
    reqs = {(r.name, r.source_file): r for r in report.requirements}
    assert reqs[("toml", "requirements.txt")].pinned_version == "0.10.2"
    assert reqs[("requests", "requirements.txt")].line == 2
    assert reqs[("idna", "requirements-extra.txt")].pinned_version == "2.7"
    assert reqs[("pyyaml", "requirements.txt")].commented_out is True
    assert reqs[("six", "pyproject.toml")].section == "project.dependencies"
    assert "pyyaml" not in runtime_requirement_names(report)
    assert "setuptools" not in runtime_requirement_names(report)  # build backend only


def test_drift_between_files(demo_repo: Path) -> None:
    report = read_manifests(demo_repo)
    drifted = {d.name for d in report.drift}
    assert drifted == {"requests"}  # ==2.31.0 vs >=2


def test_python_constraints(demo_repo: Path) -> None:
    kinds = {(c.kind, c.value) for c in read_manifests(demo_repo).python_constraints}
    assert ("requires-python", ">=3.10") in kinds
    assert ("docker-image", "3.12") in kinds
    assert ("makefile", "3.12") in kinds
