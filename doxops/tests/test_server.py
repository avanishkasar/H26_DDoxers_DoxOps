from __future__ import annotations

import http.client
import json
import threading
import time
from pathlib import Path

import pytest

from doxops.server import (
    _RUN_FILE_RE,
    ValidationError,
    build_command,
    make_server,
    safe_child,
    validate_run_request,
)

CAPSULE = {
    "risks": [
        {
            "name": "nose",
            "score": 70,
            "severity": "high",
            "at_risk": True,
            "indicators": [{"code": "IMPORT_FAILS", "title": "import fails", "weight": 40, "provenance": "verified"}],
        },
        {"name": "six", "score": 0, "severity": "none", "at_risk": False, "indicators": []},
    ],
    "capsules": [
        {
            "dependency": "nose",
            "status": "verified",
            "proposed_replacement": {"text": "replace: pytest", "provenance": "verified", "evidence_ids": []},
        }
    ],
}


# ----- validation -----------------------------------------------------------------------------
def test_validate_github_and_local_targets(tmp_path: Path) -> None:
    spec = validate_run_request({"target": "https://github.com/rishrek/LinkWatch.git/"})
    assert spec["target"] == "https://github.com/rishrek/LinkWatch"
    assert spec["mode"] == "scan"
    assert spec["pythons"] == ["3.12", "3.13"]
    assert validate_run_request({"target": str(tmp_path)})["target"] == str(tmp_path)


@pytest.mark.parametrize(
    "target",
    [
        "",
        "   ",
        None,
        42,
        "http://github.com/a/b",
        "https://evil.example/a/b",
        "https://github.com/a",
        "https://github.com/a/b/c",
        "https://github.com/a/..",
        "https://github.com/a/b?x=1",
        "relative/path",
        "/definitely/not/here",
        "--help",
        "/tmp\nx",
    ],
)
def test_validate_rejects_bad_targets(target: object) -> None:
    with pytest.raises(ValidationError):
        validate_run_request({"target": target})


@pytest.mark.parametrize(
    "extra",
    [
        {"pythons": ["3.12; rm -rf /"]},
        {"pythons": ["2.7"]},
        {"pythons": "3.12"},
        {"pythons": []},
        {"provider": "openai"},
        {"mode": "doctor"},
        {"model": "--evil"},
        {"model": 3},
        {"max_deps": True},
        {"max_deps": 0},
        {"max_deps": "3"},
        {"unexpected": 1},
    ],
)
def test_validate_rejects_bad_fields(extra: dict) -> None:
    with pytest.raises(ValidationError):
        validate_run_request({"target": "https://github.com/a/b", **extra})


def test_build_command_run_mode(tmp_path: Path) -> None:
    spec = validate_run_request(
        {
            "target": "https://github.com/a/b",
            "mode": "run",
            "provider": "gemini",
            "model": "gemma-4-26b-a4b-it",
            "pythons": ["3.13"],
            "max_deps": 2,
        }
    )
    cmd = build_command(spec, tmp_path)
    assert cmd[1:6] == ["-m", "doxops", "run", "https://github.com/a/b", "--out"]
    assert cmd[cmd.index("--provider") + 1] == "gemini"
    assert cmd[cmd.index("--max-deps") + 1] == "2"
    assert cmd.count("--python") == 1


# ----- path traversal -------------------------------------------------------------------------
@pytest.mark.parametrize(
    "rel",
    ["../secret.json", "capsules/../../secret.json", "/etc/passwd", "patches/..%2f.patch", "capsules\\x.md", "x.py"],
)
def test_safe_child_rejects_traversal(tmp_path: Path, rel: str) -> None:
    (tmp_path / "secret.json").write_text("{}")
    run = tmp_path / "run"
    (run / "capsules").mkdir(parents=True)
    assert safe_child(run, rel, _RUN_FILE_RE) is None


def test_safe_child_rejects_symlink_escape(tmp_path: Path) -> None:
    (tmp_path / "outside.log").write_text("secret")
    run = tmp_path / "run"
    (run / "evidence").mkdir(parents=True)
    try:
        (run / "evidence" / "E001-x.log").symlink_to(tmp_path / "outside.log")
    except OSError:
        pytest.skip("symlinks not supported")
    assert safe_child(run, "evidence/E001-x.log", _RUN_FILE_RE) is None


# ----- live server ----------------------------------------------------------------------------
def _fake_launcher(run, cmd):
    assert cmd[3] in ("scan", "run")
    with run.log_path.open("a", encoding="utf-8") as log:
        log.write("fake run started\nfake run finished\n")
    (run.out_dir / "capsule.json").write_text(json.dumps(CAPSULE), encoding="utf-8")
    (run.out_dir / "report.html").write_text("<html><body>report</body></html>", encoding="utf-8")
    (run.out_dir / "patches").mkdir(exist_ok=True)
    (run.out_dir / "patches" / "nose.patch").write_text("--- a\n+++ b\n", encoding="utf-8")
    time.sleep(0.2)
    return 0


@pytest.fixture
def server(tmp_path: Path):
    srv = make_server("127.0.0.1", 0, tmp_path / "web", launcher=_fake_launcher)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def _request(srv, method: str, path: str, body: object = None, headers: dict | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=10)
    hdrs = {"Host": f"127.0.0.1:{srv.port}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    hdrs.update(headers or {})
    conn.request(method, path, body=data, headers=hdrs)
    res = conn.getresponse()
    raw = res.read()
    conn.close()
    return res.status, dict(res.getheaders()), raw


def test_health_and_index(server) -> None:
    status, headers, raw = _request(server, "GET", "/api/health")
    assert status == 200
    data = json.loads(raw)
    assert data["version"] and data["defaults"]["provider"] in ("ollama", "gemini")
    assert "Access-Control-Allow-Origin" not in headers
    status, headers, raw = _request(server, "GET", "/")
    assert status == 200 and headers["Content-Type"].startswith("text/html") and b"Find problems" in raw
    assert _request(server, "GET", "/static/index.html")[0] == 200
    assert _request(server, "GET", "/static/../server.py")[0] == 404
    assert _request(server, "GET", "/static/%2e%2e/server.py")[0] == 404


def test_host_and_origin_checks(server) -> None:
    assert _request(server, "GET", "/api/health", headers={"Host": "evil.example"})[0] == 403
    assert _request(server, "GET", "/api/health", headers={"Host": "127.0.0.1:1"})[0] == 403
    assert _request(server, "GET", "/api/health", headers={"Host": f"localhost:{server.port}"})[0] == 200
    body = {"target": "https://github.com/a/b"}
    assert _request(server, "POST", "/api/runs", body, {"Origin": "http://evil.example"})[0] == 403
    assert _request(server, "POST", "/api/runs", body, {"Content-Type": "text/plain"})[0] == 415
    status, _, _ = _request(server, "POST", "/api/runs", "x" * (70 * 1024))
    assert status == 413
    status, _, raw = _request(server, "POST", "/api/runs", {"target": "<script>alert(1)</script>"})
    assert status == 400 and b"<script>" not in raw


def test_end_to_end_run(server) -> None:
    origin = {"Origin": f"http://127.0.0.1:{server.port}"}
    status, _, raw = _request(server, "POST", "/api/runs", {"target": "https://github.com/a/b", "mode": "run"}, origin)
    assert status == 202
    run_id = json.loads(raw)["id"]
    busy = _request(server, "POST", "/api/runs", {"target": "https://github.com/a/b"}, origin)[0]
    assert busy in (202, 409)  # 409 while the first run is still active

    deadline = time.time() + 10
    detail = {}
    while time.time() < deadline:
        detail = json.loads(_request(server, "GET", f"/api/runs/{run_id}")[2])
        if detail["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert detail["status"] == "done" and detail["exit_code"] == 0
    assert "fake run finished" in detail["log"]
    assert detail["summary"]["at_risk"] == 1 and detail["summary"]["verified"] == 1
    assert "patches/nose.patch" in detail["files"]

    runs = json.loads(_request(server, "GET", "/api/runs")[2])["runs"]
    assert any(r["id"] == run_id for r in runs)

    status, headers, raw = _request(server, "GET", f"/api/runs/{run_id}/capsule.json")
    assert status == 200 and headers["Content-Type"].startswith("application/json")
    assert json.loads(raw)["capsules"][0]["dependency"] == "nose"
    status, headers, raw = _request(server, "GET", f"/api/runs/{run_id}/files/report.html")
    assert status == 200 and b"report" in raw and "sandbox" in headers["Content-Security-Policy"]
    assert _request(server, "GET", f"/api/runs/{run_id}/files/patches/nose.patch")[0] == 200
    assert _request(server, "GET", f"/api/runs/{run_id}/files/../capsule.json")[0] == 404
    assert _request(server, "GET", f"/api/runs/{run_id}/files/%2e%2e/%2e%2e/x.json")[0] == 404
    assert _request(server, "GET", "/api/runs/000000000000")[0] == 404
    assert _request(server, "POST", f"/api/runs/{run_id}/cancel", {}, origin)[0] == 409


def test_refuses_non_loopback(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        make_server("0.0.0.0", 0, tmp_path)
