import json
from pathlib import Path

from click.testing import CliRunner

from doxops.cli import _ollama_problem, main
from doxops.models import DependencyCapsule

SCHEMA = Path(__file__).resolve().parents[1] / "schema" / "capsule.schema.json"


def test_published_schema_matches_model() -> None:
    assert json.loads(SCHEMA.read_text(encoding="utf-8")) == DependencyCapsule.model_json_schema()


def test_schema_command_writes_file(tmp_path: Path) -> None:
    out = tmp_path / "s.json"
    result = CliRunner().invoke(main, ["schema", "--out", str(out)])
    assert result.exit_code == 0, result.output
    assert json.loads(out.read_text(encoding="utf-8"))["title"] == "DependencyCapsule"


def test_ollama_problem_when_unreachable() -> None:
    problem = _ollama_problem("http://127.0.0.1:9", "gemma4:e4b")
    assert problem is not None and "not reachable" in problem
