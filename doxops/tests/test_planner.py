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
            CodeEdit(file="conftest.py", find="", replace="collect_ignore_glob = ['*']"),
        ],
    )
    outcomes, syntax_ok = apply_edits(p, ctx_for(demo_repo, "toml"), demo_repo)
    errors = [o.error for o in outcomes]
    assert outcomes[0].applied is False and outcomes[0].error is None  # manifest edits are ours
    assert "integrity guard" in errors[1]
    assert errors[2] == "path escapes the repository"
    assert errors[3] == "find text not found in file"
    assert "integrity guard" in errors[5] and not (demo_repo / "conftest.py").exists()
    assert syntax_ok is False


def test_invalid_specifier_is_rejected(demo_repo: Path) -> None:
    with pytest.raises(ValueError):
        rewrite_manifests(plan("upgrade", "toml", ">>=1"), ctx_for(demo_repo, "toml"), demo_repo)


def test_archived_candidate_is_blocked() -> None:
    from doxops.models import CandidateVetting
    from doxops.planner import vetting_blocks

    v = CandidateVetting(package="old", exists_on_index=True, notes=["PyPI marks 'old' as archived."])
    assert vetting_blocks(v) == ["PyPI marks 'old' as archived."]


def test_untested_pythons() -> None:
    from doxops.planner import untested_pythons

    assert untested_pythons([">=3.10"], ["3.12", "3.13"]) == ["3.10", "3.11"]
    assert untested_pythons([">=3.12"], ["3.12", "3.13"]) == []
    assert untested_pythons([], ["3.12"]) == []


# ---------------------------------------------------------------- edits copied from the numbered listing

MAKEFILE = "PYTHON ?= python3.12\n\n.PHONY: test\n\ntest:\n\tnosetests tests/\n\techo done\n"


def _apply_one(repo: Path, file: str, find: str, replace: str, dist: str = "toml") -> list:
    p = plan("replace", "pytest", None, edits=[CodeEdit(file=file, find=find, replace=replace)])
    usage = [UsageSite(file=file, line=1, module=dist, kind="tool-command" if "Makefile" in file else "import")]
    outcomes, _ = apply_edits(p, ctx_for(repo, dist, usage), repo)
    return outcomes


def test_gutter_copied_into_python_edit_is_stripped(demo_repo: Path) -> None:
    outcomes = _apply_one(
        demo_repo,
        "demo/app.py",
        find="   8 | def load(path):\n   9 |     return toml.load(path)",
        replace=(
            "   8 | def load(path):\n   9 |     with open(path, 'rb') as fh:\n  10 |         return tomllib.load(fh)"
        ),
    )
    assert outcomes[0].applied, outcomes[0].error
    app = (demo_repo / "demo/app.py").read_text()
    assert "def load(path):\n    with open(path, 'rb') as fh:\n        return tomllib.load(fh)\n" in app
    assert " | " not in app


@pytest.mark.parametrize(
    ("find", "replace"),
    [
        ("    nosetests tests/", "    pytest tests/"),  # spaces where the file has a TAB
        ("  6 | \tnosetests tests/", "  6 | \tpytest tests/"),  # gutter copied, TAB kept
        ("   6 |     nosetests tests/", "    pytest tests/"),  # gutter and spaces in find only
        ("\tnosetests tests/", "    pytest tests/"),  # exact find, replacement written with spaces
        ("nosetests tests/", "pytest tests/"),  # mid-line match keeps the TAB in front of it
    ],
)
def test_makefile_recipe_keeps_its_tab(demo_repo: Path, find: str, replace: str) -> None:
    (demo_repo / "Makefile").write_text(MAKEFILE, encoding="utf-8")
    outcomes = _apply_one(demo_repo, "Makefile", find, replace, dist="nose")
    assert outcomes[0].applied, outcomes[0].error
    assert (demo_repo / "Makefile").read_text() == MAKEFILE.replace("nosetests tests/", "pytest tests/")


def test_makefile_multiline_replacement_is_rebased_on_the_tab(demo_repo: Path) -> None:
    (demo_repo / "Makefile").write_text(MAKEFILE, encoding="utf-8")
    outcomes = _apply_one(
        demo_repo,
        "Makefile",
        find="  6 |     nosetests tests/\n  7 |     echo done",
        replace="    python -m pytest \\\n        tests/\n    echo done",
        dist="nose",
    )
    assert outcomes[0].applied, outcomes[0].error
    text = (demo_repo / "Makefile").read_text()
    assert "test:\n\tpython -m pytest \\\n\t    tests/\n\techo done\n" in text


def test_real_pipe_in_code_is_not_taken_for_a_gutter(demo_repo: Path) -> None:
    from doxops.planner import _strip_gutter

    src = "FLAGS = (\n    1 | 2\n)\nmask = a | b\n"
    (demo_repo / "demo" / "flags.py").write_text(src, encoding="utf-8")
    outcomes = _apply_one(demo_repo, "demo/flags.py", find="    1 | 2", replace="    1 | 4")
    assert outcomes[0].applied, outcomes[0].error
    outcomes = _apply_one(demo_repo, "demo/flags.py", find="mask = a | b", replace="mask = a | b | c")
    assert outcomes[0].applied, outcomes[0].error
    assert (demo_repo / "demo" / "flags.py").read_text() == "FLAGS = (\n    1 | 4\n)\nmask = a | b | c\n"
    assert _strip_gutter("x = a | b") is None
    assert _strip_gutter("  3 | x = 1\ny = a | b") is None  # only some lines carry one: left alone
    assert _strip_gutter("  3 | x = 1\n\n  5 | y = a | b") == ("x = 1\n\ny = a | b", 3)
    assert _strip_gutter("  3 | x = 1\n  7 | y = 2") is None  # numbers that skip lines are not a listing
    assert _strip_gutter("  3 | x = 1\n  7 | y = 2", strict=False) == ("x = 1\ny = 2", 3)


@pytest.mark.parametrize(
    ("src", "find", "replace", "applied", "expected"),
    [
        # a stale find that only looks gutter-like must not shrink to a substring found elsewhere
        ("MODE = (\n    1 | 4\n)\nPORT = 8\n", "    1 | 8", "    1 | 16", False, None),
        # a gutter-free find keeps a replacement whose "1 | 2" is code, not line 1 of the listing
        ("FLAGS = (\n    A | B\n)\n", "    A | B", "    1 | 2", True, "FLAGS = (\n    1 | 2\n)\n"),
        # a real gutter copied into both find and replace, numbered like the listing
        ("x = 1\ny = old(2)\n", "   2 | y = old(2)", "   2 | y = new(2)", True, "x = 1\ny = new(2)\n"),
        # replacement copied with the listing's gutter, find without it: stripped (numbers start at the match)
        ("x = 1\ny = old(2)\n", "y = old(2)", "   2 | y = new(2)", True, "x = 1\ny = new(2)\n"),
        # gutter numbers that do not name the matched line are rejected rather than guessed at
        ("x = 1\ny = old(2)\n", "   5 | y = old(2)", "   5 | y = new(2)", False, None),
    ],
)
def test_gutter_numbers_must_name_the_matched_line(
    demo_repo: Path, src: str, find: str, replace: str, applied: bool, expected: str | None
) -> None:
    (demo_repo / "demo" / "flags.py").write_text(src, encoding="utf-8")
    outcomes = _apply_one(demo_repo, "demo/flags.py", find=find, replace=replace)
    assert outcomes[0].applied is applied, outcomes[0].error
    assert (demo_repo / "demo" / "flags.py").read_text() == (expected if applied else src)


def test_gutter_numbers_refer_to_the_file_before_earlier_edits(demo_repo: Path) -> None:
    (demo_repo / "demo" / "flags.py").write_text("a = old(1)\nb = 2\nc = old(3)\n", encoding="utf-8")
    p = plan(
        "replace",
        "pytest",
        None,
        edits=[
            CodeEdit(file="demo/flags.py", find="   1 | a = old(1)", replace="   1 | a = new(1)\n   2 | a2 = 0"),
            CodeEdit(file="demo/flags.py", find="   3 | c = old(3)", replace="   3 | c = new(3)"),  # now line 4
        ],
    )
    usage = [UsageSite(file="demo/flags.py", line=1, module="toml", kind="import")]
    outcomes, syntax_ok = apply_edits(p, ctx_for(demo_repo, "toml", usage), demo_repo)
    assert syntax_ok and all(o.applied for o in outcomes), [o.error for o in outcomes]
    assert (demo_repo / "demo" / "flags.py").read_text() == "a = new(1)\na2 = 0\nb = 2\nc = new(3)\n"


def test_find_matching_twice_is_still_rejected(demo_repo: Path) -> None:
    text = "a:\n\tnosetests tests/\n\nb:\n\tnosetests tests/\n"
    (demo_repo / "Makefile").write_text(text, encoding="utf-8")
    for find in ("  2 | \tnosetests tests/", "    nosetests tests/", "\tnosetests tests/"):
        outcomes = _apply_one(demo_repo, "Makefile", find, "\tpytest tests/", dist="nose")
        assert not outcomes[0].applied
        assert outcomes[0].error == "find text occurs 2 times; it must be unique"
    assert (demo_repo / "Makefile").read_text() == text


# ---------------------------------------------------------------- repair prompts carry the real error

BINARY_MODE = "TypeError: File must be opened in binary mode, e.g. use `open('foo.toml', 'rb')`"


def _failed_attempt(nodeid: str = "tests/test_config.py::test_sites_file_loads"):
    from doxops.models import Comparison, SuiteRun, TestDelta, TestResult

    trace = "\n".join(
        [
            "linkwatch/config.py:37: in load_sites",
            "    data = tomli.load(open(path, 'r'))",
            "site-packages/tomli/_parser.py:63: TypeError",
            ">           raise TypeError(",
            f"E           {BINARY_MODE}",
        ]
    )
    runs, comps = [], []
    for py in ("3.12", "3.13"):
        runs.append(
            SuiteRun(
                label="toml-1",
                python=py,
                install_ok=True,
                tests=[
                    TestResult(
                        nodeid=nodeid,
                        outcome="failed",
                        message=BINARY_MODE,
                        failure_class="TypeError",
                        traceback=trace,
                    )
                ],
            )
        )
        comps.append(
            Comparison(
                python=py,
                regressed=1,
                deltas=[
                    TestDelta(
                        nodeid=nodeid,
                        python=py,
                        before="passed",
                        after="failed",
                        change="regressed",
                        after_message=BINARY_MODE,
                        failure_class="TypeError",
                    )
                ],
            )
        )
    return runs, comps


def test_repair_prompt_shows_the_failing_test_error(demo_repo: Path) -> None:
    from doxops.planner import build_repair_prompt, failure_excerpts, summarise_problems

    runs, comps = _failed_attempt()
    previous = plan(
        "replace",
        "tomli",
        ">=2.0.1",
        edits=[CodeEdit(file="demo/app.py", find="return toml.load(path)", replace="return tomli.load(open(path))")],
    )
    diff = (
        "--- a/demo/app.py\n+++ b/demo/app.py\n@@ -9 +9 @@\n"
        "-    return toml.load(path)\n+    return tomli.load(open(path))\n"
    )
    failures = failure_excerpts(runs, comps)
    prompt = build_repair_prompt(
        ctx_for(demo_repo, "toml"),
        previous,
        summarise_problems([], runs, comps, []),
        failures=failures,
        applied_diff=diff,
    )
    assert len(failures) == 1  # the same failure on 3.12 and 3.13 is shown once
    assert "tests/test_config.py::test_sites_file_loads - regressed on Python 3.12, 3.13 [TypeError]" in prompt
    assert "File must be opened in binary mode" in prompt
    assert "data = tomli.load(open(path, 'r'))" in prompt  # the project line that made the bad call
    assert "+    return tomli.load(open(path))" in prompt  # the exact change that was applied
    assert "ORIGINAL files" in prompt


def test_failure_excerpt_falls_back_to_the_comparison_message() -> None:
    from doxops.planner import failure_excerpts

    _, comps = _failed_attempt()
    failures = failure_excerpts([], comps)  # no run details: the comparison's message is still shown
    assert len(failures) == 1 and "File must be opened in binary mode" in failures[0]


def test_failure_excerpts_are_bounded() -> None:
    from doxops.models import TestResult
    from doxops.planner import MAX_FAILURE_CHARS, failure_excerpts

    runs, comps = _failed_attempt()
    long_trace = "\n".join(f"frame {i}: " + "x" * 200 for i in range(60)) + f"\nE   {BINARY_MODE}"
    for k in range(10):
        nodeid = f"tests/test_x.py::test_{k}"
        runs[0].tests.append(TestResult(nodeid=nodeid, outcome="failed", message=BINARY_MODE, traceback=long_trace))
        comps[0].deltas.append(comps[0].deltas[0].model_copy(update={"nodeid": nodeid}))
    failures = failure_excerpts(runs, comps)
    assert sum(len(f) for f in failures) <= MAX_FAILURE_CHARS + 200
    assert all(f.count("frame ") <= 25 for f in failures)
    truncated = failures[1]  # failures[0] is the short original trace; this one is cut to fit the budget
    assert "\n```\n..." in truncated
    assert truncated.endswith(f"{BINARY_MODE}\n```")  # the end of a traceback (the error line) survives
    assert "frame 59" in truncated and "frame 0:" not in truncated
    assert failures[-1].endswith("omitted to keep the prompt short)")


def _collection_break():
    """A migration that broke the import of a test module: the probe records the module's collection error."""
    from doxops.compare import compare
    from doxops.models import SuiteRun, TestResult

    error = "ImportError while importing test module 'tests/test_config.py'."
    trace = "\n".join(
        [
            "pkg/config.py:1: in <module>",
            ">   from tomllib import loadz",
            "E   ImportError: cannot import name 'loadz' from 'tomllib'",
        ]
    )
    tests = ["tests/test_config.py::test_load", "tests/test_config.py::test_load2", "tests/test_other.py::test_ok"]
    base = SuiteRun(
        label="base", python="3.12", install_ok=True, tests=[TestResult(nodeid=t, outcome="passed") for t in tests]
    )
    cand = SuiteRun(
        label="toml-1",
        python="3.12",
        install_ok=True,
        tests=[
            TestResult(nodeid="tests/test_other.py::test_ok", outcome="passed"),
            TestResult(
                nodeid="tests/test_config.py::<collection>",
                outcome="error",
                message=error,
                failure_class="ImportError",
                traceback=trace,
            ),
        ],
    )
    return [cand], [compare(base, cand)]


def test_vanished_tests_show_the_import_error_that_stopped_them(demo_repo: Path, tmp_path: Path) -> None:
    from doxops.pipeline import Pipeline, RunOptions
    from doxops.planner import failure_excerpts, summarise_problems

    runs, comps = _collection_break()
    pipeline = Pipeline(RunOptions(target=str(demo_repo), out_dir=tmp_path / "out"), log=lambda *_: None)
    relevant = pipeline._relevant(comps, ctx_for(demo_repo, "toml"))
    assert any(d.nodeid.endswith("::<collection>") for d in relevant[0].deltas)  # kept for the repair prompt
    failures = failure_excerpts(runs, relevant)
    assert len(failures) == 1  # one block for the module, not one placeholder per vanished test
    assert "tests/test_config.py::<collection> - new failure on Python 3.12 [ImportError]" in failures[0]
    assert "cannot import name 'loadz' from 'tomllib'" in failures[0]
    assert "tests/test_config.py::test_load, tests/test_config.py::test_load2" in failures[0]
    assert "no error text was captured" not in failures[0]
    problems = summarise_problems([], runs, relevant, [])
    assert any("ImportError while importing test module" in p for p in problems)
    assert any("2 test(s) that passed before did not run" in p for p in problems)


def test_tests_that_did_not_run_without_a_collection_error_share_one_block() -> None:
    from doxops.compare import compare
    from doxops.models import SuiteRun, TestResult
    from doxops.planner import failure_excerpts

    tests = [f"tests/test_x.py::test_{k}" for k in range(40)]
    base = SuiteRun(
        label="base", python="3.12", install_ok=True, tests=[TestResult(nodeid=t, outcome="passed") for t in tests]
    )
    cand = SuiteRun(label="toml-1", python="3.12", install_ok=False, error="dependency installation failed")
    failures = failure_excerpts([cand], [compare(base, cand)])
    assert len(failures) == 1
    assert "40 test(s) that passed before did not run on Python 3.12" in failures[0]
    assert "dependency installation failed" in failures[0]
    assert "(+32 more)" in failures[0]
