from pathlib import Path

from doxops.models import DependencyRisk, RuntimeCall, Severity, SuiteRun, UsageSite
from doxops.pipeline import Pipeline
from doxops.planner import PlanContext


def _ctx(tree: Path) -> PlanContext:
    risk = DependencyRisk(
        name="toml",
        declared=True,
        imported_modules=["toml"],
        score=30,
        severity=Severity.MEDIUM,
        at_risk=True,
        indicators=[],
    )
    usage = [UsageSite(file="pkg/config.py", line=4, module="toml", symbol="load", kind="call")]
    return PlanContext(
        dist="toml",
        risk=risk,
        metadata=None,
        declarations=[],
        usage=usage,
        runtime=[],
        baseline=[],
        pythons=["3.12"],
        other_dependencies=[],
        tree=tree,
    )


def test_reached_sites_follows_shifted_lines(tmp_path: Path) -> None:
    before, after = tmp_path / "before", tmp_path / "after"
    (before / "pkg").mkdir(parents=True)
    (after / "pkg").mkdir(parents=True)
    (before / "pkg" / "config.py").write_text("import toml\n\ndef load(p):\n    return toml.load(p)\n")
    (after / "pkg" / "config.py").write_text(
        "import tomli\n\n\ndef load(p):\n    with open(p, 'rb') as fh:\n        return tomli.load(fh)\n"
    )
    call = RuntimeCall(module="tomli", function="load", caller_file="pkg/config.py", caller_line=6, count=1)
    run = SuiteRun(label="x", python="3.12", install_ok=True, runtime_calls=[call])
    assert Pipeline._reached_sites(_ctx(before), before, after, [run]) == {("pkg/config.py", 4)}


def test_reached_sites_ignores_unrelated_calls(tmp_path: Path) -> None:
    for d in ("before", "after"):
        (tmp_path / d / "pkg").mkdir(parents=True)
        (tmp_path / d / "pkg" / "config.py").write_text("import toml\n\ndef load(p):\n    return toml.load(p)\n")
    call = RuntimeCall(module="toml", function="load", caller_file="pkg/other.py", caller_line=4, count=1)
    run = SuiteRun(label="x", python="3.12", install_ok=True, runtime_calls=[call])
    assert Pipeline._reached_sites(_ctx(tmp_path / "before"), tmp_path / "before", tmp_path / "after", [run]) == set()
