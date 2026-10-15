import json
from pathlib import Path

import httpx
import pytest

from doxops.llm import OllamaProvider, Provider, StructuredLLM, extract_json, inline_refs
from doxops.models import MigrationPlan, ModelInfo

GOOD = {"analysis": "a", "replacement": {"strategy": "remove"}, "rationale": "r", "migration_steps": ["s"]}


class Scripted(Provider):
    name = "scripted"
    model = "m"

    def __init__(self, replies: list[str]) -> None:
        self.replies = replies
        self.prompts: list[str] = []

    def complete(self, system: str, user: str, schema: dict) -> str:
        self.prompts.append(user)
        return self.replies.pop(0)

    def info(self) -> ModelInfo:
        return ModelInfo(provider="s", model="m", license="x", access_method="x")


def test_extract_json_handles_fences_and_chatter() -> None:
    assert json.loads(extract_json('Sure!\n```json\n{"a": 1}\n```')) == {"a": 1}
    assert json.loads(extract_json('noise {"a": "}"} trailing')) == {"a": "}"}


def test_inline_refs_removes_defs() -> None:
    schema = inline_refs(MigrationPlan.model_json_schema())
    assert "$defs" not in json.dumps(schema) and "$ref" not in json.dumps(schema)


def test_structured_retry_on_invalid_output(tmp_path: Path) -> None:
    prov = Scripted(["not json at all", json.dumps(GOOD)])
    llm = StructuredLLM(prov, tmp_path / "llm")
    plan, call = llm.ask("sys", "user", MigrationPlan, "dep-plan")
    assert plan is not None and plan.replacement.strategy == "remove"
    assert call.ok and len(llm.calls) == 2 and "rejected" in prov.prompts[1]
    assert (tmp_path / call.prompt_path).is_file()


def test_ollama_request_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}

    def fake_post(url: str, json: dict, timeout: object) -> httpx.Response:
        seen.update(url=url, body=json)
        return httpx.Response(200, json={"message": {"content": '{"ok": true}'}}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    out = OllamaProvider("gemma4:e4b", host="localhost:11434").complete("s", "u", {"type": "object"})
    assert out == '{"ok": true}'
    assert seen["url"] == "http://localhost:11434/api/chat"
    assert seen["body"]["format"] == {"type": "object"} and seen["body"]["stream"] is False
