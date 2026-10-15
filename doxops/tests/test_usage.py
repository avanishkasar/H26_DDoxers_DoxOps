from pathlib import Path

from doxops.usage import find_tool_references, scan_repository


def test_static_usage_kinds(demo_repo: Path) -> None:
    report = scan_repository(demo_repo)
    assert report.third_party_top == {"toml", "requests"}
    assert "demo" in report.local
    kinds = {(s.module, s.kind, s.symbol) for s in report.sites}
    assert ("toml", "import", "toml") in kinds
    assert ("toml", "call", "toml.load") in kinds
    assert ("requests", "private-api", "requests.utils._parse_content_type_header") in kinds
    assert ("requests", "monkeypatch", "requests.Session.request") in kinds
    assert ("requests", "call", "requests.Session") in kinds  # aliased `S()`


def test_tool_references(demo_repo: Path) -> None:
    refs = find_tool_references(demo_repo, {"nosetests": "nose"})
    assert [(r.tool, r.source_file, r.line) for r in refs] == [("nosetests", "Makefile", 4)]
