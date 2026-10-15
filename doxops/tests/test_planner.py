from pathlib import Path

import pytest

from doxops.manifests import read_manifests
from doxops.models import CodeEdit, DependencyRisk, MigrationPlan, ReplacementChoice, Severity, UsageSite
from doxops.planner import PlanContext, apply_edits, rewrite_manifests


def ctx_for(repo: Path, dist: str, usage: list[UsageSite] | None = None) -> PlanContext:
    report = read_manifests(repo)
    return PlanContext(
        dist=dist,
        risk=DependencyRisk(
            name=dist,
            declared=True,
            imported_modules=[dist],
            score=50,
            severity=Severity.HIGH,
            at_risk=True,
            indicators=[],
        ),
        metadata=None,
        declarations=[r for r in report.requirements if r.name == dist],
        usage=usage or [UsageSite(file="demo/app.py", line=2, module=dist, kind="import")],
        runtime=[],
        baseline=[],
        pythons=["3.12"],
        other_dependencies=[],
        tree=repo,
    )


def plan(strategy: str, package: str | None = None, spec: str | None = None, edits=()) -> MigrationPlan:
    return MigrationPlan(
        analysis="a",
        replacement=ReplacementChoice(strategy=strategy, package=package, version_spec=spec),
        rationale="r",
        migration_steps=["s"],
        edits=list(edits),
    )


def test_stdlib_migration_rewrites_code_and_manifests(demo_repo: Path) -> None:
    p = plan(
        "stdlib",
        edits=[
            CodeEdit(file="demo/app.py", find="import toml\n", replace="import tomllib\n"),
            CodeEdit(
                file="demo/app.py",
                find="return toml.load(path)",
                replace="with open(path, 'rb') as fh:\n    return tomllib.load(fh)",
            ),
        ],
    )
    ctx = ctx_for(demo_repo, "toml")
    changes = rewrite_manifests(p, ctx, demo_repo)
    outcomes, syntax_ok = apply_edits(p, ctx, demo_repo)
    assert syntax_ok and all(o.applied for o in outcomes)
    app = (demo_repo / "demo/app.py").read_text()
    assert "import tomllib" in app and "        return tomllib.load(fh)" in app  # re-indented into the function
    assert "toml==" not in (demo_repo / "requirements.txt").read_text()
    assert '"toml==0.10.2"' not in (demo_repo / "pyproject.toml").read_text()
    assert len(changes) == 2


def test_upgrade_rewrites_every_declaration(demo_repo: Path) -> None:
    changes = rewrite_manifests(plan("upgrade", "requests", ">=2.32.5,<3"), ctx_for(demo_repo, "requests"), demo_repo)
    assert "requests>=2.32.5,<3" in (demo_repo / "requirements.txt").read_text()
    assert '"requests>=2.32.5,<3"' in (demo_repo / "pyproject.toml").read_text()
    assert len(changes) == 2


def test_declare_adds_missing_dependency(demo_repo: Path) -> None:
    ctx = ctx_for(demo_repo, "certifi")
    rewrite_manifests(plan("declare", "certifi", ">=2024.8.30"), ctx, demo_repo)
    assert "certifi>=2024.8.30" in (demo_repo / "requirements.txt").read_text()
    assert '"certifi>=2024.8.30"' in (demo_repo / "pyproject.toml").read_text()


def test_guards(demo_repo: Path) -> None:
    p = plan(
        "upgrade",
        "toml",
        ">=0.10",
        edits=[
            CodeEdit(file="requirements.txt", find="toml", replace="x"),
            CodeEdit(file="tests/test_app.py", find="assert load", replace="pass"),
            CodeEdit(file="../outside.py", find="", replace="x"),
            CodeEdit(file="demo/app.py", find="does not exist", replace="x"),
            CodeEdit(file="demo/app.py", find="def load(path):", replace="def load(path:"),
        ],
    )
    outcomes, syntax_ok = apply_edits(p, ctx_for(demo_repo, "toml"), demo_repo)
    errors = [o.error for o in outcomes]
    assert outcomes[0].applied is False and outcomes[0].error is None  # manifest edits are ours
    assert "integrity guard" in errors[1]
    assert errors[2] == "path escapes the repository"
    assert errors[3] == "find text not found in file"
    assert syntax_ok is False


def test_invalid_specifier_is_rejected(demo_repo: Path) -> None:
    with pytest.raises(ValueError):
        rewrite_manifests(plan("upgrade", "toml", ">>=1"), ctx_for(demo_repo, "toml"), demo_repo)
