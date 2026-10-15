"""End-to-end run on the real LinkWatch repo with a scripted model in place of Gemma 4.

Needs git, uv, Python 3.12 and network access to GitHub and PyPI, so it only runs when
DOXOPS_E2E=1 is set:  DOXOPS_E2E=1 python -m pytest tests/test_e2e_scripted.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from doxops.llm import Provider, StructuredLLM
from doxops.models import ModelInfo, Provenance
from doxops.pipeline import Pipeline, RunOptions
from doxops.report import write_outputs

pytestmark = pytest.mark.skipif(os.environ.get("DOXOPS_E2E") != "1", reason="set DOXOPS_E2E=1 to run")

JINJA2_PLAN = {
    "analysis": "Jinja2 2.11 imports soft_unicode, which MarkupSafe 2.1 removed.",
    "replacement": {"strategy": "upgrade", "package": "jinja2", "version_spec": ">=3.1.6,<4"},
    "rationale": "Environment, FileSystemLoader and select_autoescape keep their API in 3.x.",
    "migration_steps": ["Raise the Jinja2 pin to 3.1.6 or later."],
    "edits": [],
    "suggested_tests": ["Render the HTML report for two sites."],
    "expected_compatibility_gaps": [],
    "confidence": "high",
}
REMOVE_PLAN = {
    "analysis": "Declared but never imported.",
    "replacement": {"strategy": "remove"},
    "rationale": "Nothing in the project uses it.",
    "migration_steps": ["Delete the declaration."],
    "edits": [],
}
HALLUCINATED = {**REMOVE_PLAN, "replacement": {"strategy": "replace", "package": "surely-not-a-real-pkg-zz9"}}


class ScriptedProvider(Provider):
    """Answers like Gemma would, but deterministically; the first plan for `six` names a package that does not exist."""

    name = "scripted"
    model = "scripted"

    def __init__(self) -> None:
        self.calls: dict[str, int] = {}

    def complete(self, system: str, user: str, schema: dict) -> str:
        dep = json.loads(user.split("```json\n", 1)[1].split("\n```", 1)[0])["dependency"]
        self.calls[dep] = self.calls.get(dep, 0) + 1
        if dep == "jinja2":
            return json.dumps(JINJA2_PLAN)
        if dep == "six" and self.calls[dep] == 1:
            return json.dumps(HALLUCINATED)
        return json.dumps(REMOVE_PLAN)

    def info(self) -> ModelInfo:
        return ModelInfo(provider="scripted", model="scripted", license="n/a", access_method="test double")


def test_linkwatch_end_to_end(tmp_path: Path) -> None:
    out = tmp_path / "out"
    llm = StructuredLLM(ScriptedProvider(), out / "llm")
    opts = RunOptions(
        target="https://github.com/rishrek/LinkWatch",
        out_dir=out,
        pythons=["3.12"],
        llm=llm,
        model_info=llm.provider.info(),
        only=["jinja2", "six"],
        max_repairs=1,
    )
    summary = Pipeline(opts, log=lambda *_: None).run()
    write_outputs(summary, out)

    capsules = {c.dependency: c for c in summary.capsules}
    assert {r.name for r in summary.risks if r.at_risk} <= set(capsules)  # every flagged dependency has a capsule

    jinja2 = capsules["jinja2"]
    assert jinja2.status == "verified"
    assert jinja2.proposed_replacement and jinja2.proposed_replacement.provenance == Provenance.VERIFIED
    assert jinja2.rationale and jinja2.rationale.provenance == Provenance.AI
    assert sum(c.fixed for c in jinja2.executed_results) >= 1

    six = capsules["six"]
    assert "does not exist on PyPI" in six.attempts[0].verdict
    assert six.attempts[-1].accepted

    assert summary.combined_comparisons and all(c.regressed == 0 for c in summary.combined_comparisons)
    assert (out / "patches" / "combined.patch").is_file() and (out / "report.html").is_file()
    assert str(Path.home()) not in (out / "capsule.json").read_text(encoding="utf-8")
