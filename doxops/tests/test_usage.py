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


def test_http_calls_without_timeout(tmp_path: Path) -> None:
    (tmp_path / "net.py").write_text(
        "import requests\n"
        "from requests import Session as S\n"
        "\n"
        "def a(url):\n"
        "    s = S()\n"
        "    return s.get(url)\n"
        "\n"
        "def b(url):\n"
        "    return requests.post(url, timeout=5)\n"
        "\n"
        "def c(url, **kw):\n"
        "    return requests.get(url, **kw)\n"
        "\n"
        "def d(url):\n"
        "    with requests.Session() as sess:\n"
        "        return sess.head(url)\n"
        "\n"
        "def e(cache, url):\n"
        "    return cache.get(url)\n"
    )
    sites = scan_repository(tmp_path).sites
    hangs = sorted((s.line, s.symbol) for s in sites if s.kind == "no-timeout")
    assert hangs == [(6, "requests.Session.get"), (16, "requests.Session.head")]
