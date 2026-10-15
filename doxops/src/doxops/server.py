"""Local web dashboard for ``doxops serve``: a small JSON API plus one static page.

The server starts ``doxops scan`` / ``doxops run`` as subprocesses, and those execute the target
project's test suite. Treat it as dangerous: it binds to loopback by default, rejects foreign Host
headers (DNS rebinding) and cross-origin POSTs (CSRF), sends no CORS headers and never builds HTML
from user input. Only the standard library is used.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from . import __version__
from .llm import DEFAULT_GEMINI_MODEL, DEFAULT_OLLAMA_MODEL

WEB_DIR = Path(__file__).resolve().parent / "web"
MAX_BODY = 64 * 1024
LOG_TAIL = 200
DEFAULT_PYTHONS = ["3.12", "3.13"]
PROVIDERS = ("ollama", "gemini")
MODES = ("scan", "run")
ACTIVE = ("queued", "running")

_GITHUB_RE = re.compile(
    r"^https://github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]{1,100}?)(?:\.git)?/?$"
)
_PY_RE = re.compile(r"^3\.\d+$")
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$")
_RUN_ID_RE = r"[0-9a-f]{12}"
_RUN_FILE_RE = re.compile(
    r"^(?:report\.html|REPORT\.md|capsule\.json|web\.log"
    r"|capsules/[A-Za-z0-9._-]+\.(?:md|json)"
    r"|patches/[A-Za-z0-9._-]+\.patch"
    r"|evidence/[A-Za-z0-9._-]+\.log)$"
)
_STATIC_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:html|css|js|md|svg|png|ico)$")
_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".patch": "text/x-diff; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}
_PAGE_CSP = (
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)
# Generated run files (report.html, patches, logs) contain text from the scanned repository:
# serve them in an opaque-origin sandbox with no scripts, so they can never call the API.
_RUN_FILE_CSP = "sandbox allow-popups; default-src 'none'; style-src 'unsafe-inline'; img-src data:"


class ValidationError(ValueError):
    """A request field is missing or malformed. Messages never include the submitted value."""


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def default_provider() -> str:
    env = os.environ.get("DOXOPS_PROVIDER", "ollama")
    return env if env in PROVIDERS else "ollama"


def validate_target(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError("target is required: a https://github.com/owner/repo URL or an absolute folder path")
    target = value.strip()
    if len(target) > 500 or any(ch in target for ch in "\x00\r\n"):
        raise ValidationError("target is too long or contains control characters")
    if target.lower().startswith(("http://", "https://")):
        match = _GITHUB_RE.match(target)
        if not match or set(match.group(2)) <= {"."}:
            raise ValidationError("target URL must look like https://github.com/owner/repo")
        return f"https://github.com/{match.group(1)}/{match.group(2)}"
    path = Path(target)
    try:
        ok = path.is_absolute() and path.is_dir()
    except (OSError, ValueError):
        ok = False
    if not ok:
        raise ValidationError("target must be a GitHub URL or an existing absolute folder path")
    return str(path)


def validate_run_request(body: Any) -> dict[str, Any]:
    """Return a normalised run spec, or raise ValidationError."""
    if not isinstance(body, dict):
        raise ValidationError("request body must be a JSON object")
    allowed = {"target", "mode", "provider", "model", "pythons", "max_deps"}
    if set(body) - allowed:
        raise ValidationError(f"unknown field(s); allowed: {', '.join(sorted(allowed))}")
    target = validate_target(body.get("target"))
    mode = body.get("mode", "scan")
    if mode not in MODES:
        raise ValidationError("mode must be 'scan' or 'run'")
    provider = body.get("provider") or default_provider()
    if provider not in PROVIDERS:
        raise ValidationError("provider must be 'ollama' or 'gemini'")
    model = body.get("model")
    if model in (None, ""):
        model = None
    elif not isinstance(model, str) or not _MODEL_RE.match(model):
        raise ValidationError("model must be a model id such as gemma4:e4b (letters, digits, . _ : / -)")
    pythons = body.get("pythons")
    if pythons is None:
        pythons = list(DEFAULT_PYTHONS)
    if not isinstance(pythons, list) or not 1 <= len(pythons) <= 6:
        raise ValidationError('pythons must be a list of 1 to 6 versions such as "3.12"')
    if not all(isinstance(p, str) and _PY_RE.match(p) for p in pythons):
        raise ValidationError("each python version must look like 3.12")
    pythons = list(dict.fromkeys(pythons))
    max_deps = body.get("max_deps")
    if max_deps is not None and (
        isinstance(max_deps, bool) or not isinstance(max_deps, int) or not 1 <= max_deps <= 100
    ):
        raise ValidationError("max_deps must be null or an integer from 1 to 100")
    return {
        "target": target,
        "mode": mode,
        "provider": provider,
        "model": model,
        "pythons": pythons,
        "max_deps": max_deps,
    }


def build_command(spec: dict[str, Any], out_dir: Path) -> list[str]:
    cmd = [sys.executable, "-m", "doxops", spec["mode"], spec["target"], "--out", str(out_dir)]
    for py in spec["pythons"]:
        cmd += ["--python", py]
    if spec["mode"] == "run":
        cmd += ["--provider", spec["provider"]]
        if spec["model"]:
            cmd += ["--model", spec["model"]]
        if spec["max_deps"] is not None:
            cmd += ["--max-deps", str(spec["max_deps"])]
    return cmd


def safe_child(base: Path, relative: str, pattern: re.Pattern[str]) -> Path | None:
    """Resolve ``relative`` under ``base``; None unless it matches ``pattern`` and stays inside ``base``."""
    if not pattern.match(relative) or "\\" in relative or any(part in ("", ".", "..") for part in relative.split("/")):
        return None
    root = base.resolve()
    try:
        path = (root / relative).resolve()
    except (OSError, ValueError):
        return None
    if not path.is_relative_to(root) or not path.is_file():
        return None
    return path


def summarize_capsule(data: dict[str, Any]) -> dict[str, int]:
    risks = data.get("risks") or []
    capsules = data.get("capsules") or []
    statuses = Counter(c.get("status") for c in capsules if isinstance(c, dict))
    return {
        "dependencies": len(risks),
        "at_risk": sum(1 for r in risks if isinstance(r, dict) and r.get("at_risk")),
        "capsules": len(capsules),
        "verified": statuses["verified"],
        "partially_verified": statuses["partially-verified"],
        "unverified": statuses["unverified"] + statuses["failed"],
        "not_attempted": statuses["not-attempted"],
    }


@dataclass
class Run:
    id: str
    spec: dict[str, Any]
    out_dir: Path
    status: str = "queued"
    created: str = field(default_factory=_now)
    started: str | None = None
    finished: str | None = None
    exit_code: int | None = None
    cancel_requested: bool = False
    proc: subprocess.Popen[bytes] | None = field(default=None, repr=False)
    _summary_key: tuple[float, int] | None = field(default=None, repr=False)
    _summary: dict[str, int] | None = field(default=None, repr=False)

    @property
    def log_path(self) -> Path:
        return self.out_dir / "web.log"

    def summary(self) -> dict[str, int] | None:
        capsule = self.out_dir / "capsule.json"
        try:
            st = capsule.stat()
        except OSError:
            return None
        key = (st.st_mtime, st.st_size)
        if key != self._summary_key:
            try:
                self._summary = summarize_capsule(json.loads(capsule.read_text(encoding="utf-8")))
            except (OSError, ValueError, AttributeError):
                self._summary = None
            self._summary_key = key
        return self._summary

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "target": self.spec["target"],
            "mode": self.spec["mode"],
            "provider": self.spec["provider"] if self.spec["mode"] == "run" else None,
            "model": self.spec["model"],
            "pythons": self.spec["pythons"],
            "max_deps": self.spec["max_deps"],
            "status": self.status,
            "created": self.created,
            "started": self.started,
            "finished": self.finished,
            "exit_code": self.exit_code,
            "summary": self.summary(),
        }

    def files(self) -> list[str]:
        found = []
        root = self.out_dir
        for name in ("report.html", "REPORT.md", "capsule.json", "web.log"):
            if (root / name).is_file():
                found.append(name)
        for sub, suffixes in (("patches", (".patch",)), ("capsules", (".md", ".json"))):
            folder = root / sub
            if folder.is_dir():
                found += sorted(f"{sub}/{p.name}" for p in folder.iterdir() if p.is_file() and p.suffix in suffixes)
        return [f for f in found if _RUN_FILE_RE.match(f)]

    def log_tail(self, lines: int = LOG_TAIL) -> list[str]:
        try:
            with self.log_path.open("rb") as fh:
                fh.seek(0, os.SEEK_END)
                size = fh.tell()
                fh.seek(max(0, size - 256 * 1024))
                data = fh.read()
        except OSError:
            return []
        return data.decode("utf-8", errors="replace").splitlines()[-lines:]


Launcher = Callable[[Run, list[str]], int]


def terminate_tree(proc: subprocess.Popen[bytes]) -> None:
    """Stop the subprocess and everything it started (uv, pytest, git)."""
    if proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, check=False)
        else:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        proc.kill()


def subprocess_launcher(run: Run, cmd: list[str]) -> int:
    """Run the CLI in its own process group, streaming stdout and stderr into ``web.log``."""
    env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "NO_COLOR": "1", "COLUMNS": "140"}
    extra: dict[str, Any] = (
        {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    )
    with run.log_path.open("ab") as log:
        proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, **extra)
        run.proc = proc
        if run.cancel_requested:
            terminate_tree(proc)
        return proc.wait()


class RunManager:
    """Keeps the runs of this server process; at most one runs at a time."""

    def __init__(self, out_root: Path, launcher: Launcher = subprocess_launcher) -> None:
        self.out_root = out_root.resolve()
        self.launcher = launcher
        self.runs: dict[str, Run] = {}
        self.lock = threading.Lock()

    def busy(self) -> bool:
        return any(r.status in ACTIVE for r in self.runs.values())

    def start(self, spec: dict[str, Any]) -> Run | None:
        """Start a run, or return None when another one is still active."""
        with self.lock:
            if self.busy():
                return None
            run_id = uuid.uuid4().hex[:12]
            run = Run(id=run_id, spec=spec, out_dir=self.out_root / run_id)
            run.out_dir.mkdir(parents=True, exist_ok=True)
            self.runs[run_id] = run
        cmd = build_command(spec, run.out_dir)
        with run.log_path.open("a", encoding="utf-8") as log:
            log.write(f"$ doxops {spec['mode']} {spec['target']} (run {run_id})\n")
        threading.Thread(target=self._work, args=(run, cmd), name=f"doxops-run-{run_id}", daemon=True).start()
        return run

    def _work(self, run: Run, cmd: list[str]) -> None:
        with self.lock:
            if run.cancel_requested:
                run.status, run.finished = "cancelled", _now()
                return
            run.status, run.started = "running", _now()
        try:
            code = self.launcher(run, cmd)
        except Exception as exc:  # launcher failure (e.g. interpreter missing): record it, keep the server up
            code = -1
            with run.log_path.open("a", encoding="utf-8") as log:
                log.write(f"[dashboard] could not start the run: {type(exc).__name__}: {exc}\n")
        with self.lock:
            run.exit_code = code
            run.finished = _now()
            run.proc = None
            run.status = "cancelled" if run.cancel_requested else ("done" if code == 0 else "failed")

    def cancel(self, run_id: str) -> Run | None:
        with self.lock:
            run = self.runs.get(run_id)
            if run is None or run.status not in ACTIVE:
                return run
            run.cancel_requested = True
            proc = run.proc
        if proc is not None:
            terminate_tree(proc)
        return run

    def cancel_all(self) -> None:
        for run_id in list(self.runs):
            self.cancel(run_id)


class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, host: str, port: int, manager: RunManager, allow_remote: bool = False) -> None:
        if ":" in host:
            self.address_family = socket.AF_INET6
        super().__init__((host, port), DashboardHandler)
        self.manager = manager
        self.allow_remote = allow_remote
        self.port = self.server_address[1]
        shown = f"[{host}]" if ":" in host else host
        self.url = f"http://{shown}:{self.port}/"
        self.allowed_hosts = {f"{h}:{self.port}" for h in ("127.0.0.1", "localhost", "[::1]")}


class DashboardHandler(BaseHTTPRequestHandler):
    server: DashboardServer
    server_version = "doxops-dashboard"
    sys_version = ""

    def log_message(self, format: str, *args: Any) -> None:  # quiet: the UI polls every 2 s
        return

    # ----- response helpers -------------------------------------------------------------------
    def _headers(self, status: int, content_type: str, length: int, csp: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        if csp:
            self.send_header("Content-Security-Policy", csp)
        self.end_headers()

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(body))
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _file(self, path: Path, csp: str | None) -> None:
        data = path.read_bytes()
        ctype = _CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
        self._headers(200, ctype, len(data), csp)
        self.wfile.write(data)

    # ----- request checks ---------------------------------------------------------------------
    def _host_ok(self) -> bool:
        if self.server.allow_remote:
            return True
        host = (self.headers.get("Host") or "").strip().lower()
        if host in self.server.allowed_hosts:
            return True
        self._error(403, "forbidden host header (use http://127.0.0.1 or http://localhost)")
        return False

    def _post_ok(self) -> bool:
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            self._error(415, "Content-Type must be application/json")
            return False
        origin = self.headers.get("Origin")
        if origin is not None:
            expected = "http://" + (self.headers.get("Host") or "").strip().lower()
            if origin.strip().lower() != expected:
                self._error(403, "cross-origin request refused")
                return False
        return True

    def _read_json(self) -> tuple[bool, Any]:
        if self.headers.get("Transfer-Encoding"):
            self._error(411, "Content-Length is required")
            return False, None
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self._error(400, "bad Content-Length")
            return False, None
        if length < 0 or length > MAX_BODY:
            self._error(413, "request body too large (64 KB max)")
            return False, None
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return True, {}
        try:
            return True, json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self._error(400, "body is not valid JSON")
            return False, None

    # ----- routing ----------------------------------------------------------------------------
    def do_GET(self) -> None:
        if not self._host_ok():
            return
        path = urlsplit(self.path).path
        manager = self.server.manager
        if path in ("/", "/index.html"):
            self._file(WEB_DIR / "index.html", _PAGE_CSP)
            return
        if path.startswith("/static/"):
            target = safe_child(WEB_DIR, unquote(path[len("/static/") :]), _STATIC_RE)
            if target is None:
                self._error(404, "not found")
            else:
                self._file(target, _PAGE_CSP)
            return
        if path == "/api/health":
            self._json(
                200,
                {
                    "version": __version__,
                    "busy": manager.busy(),
                    "defaults": {
                        "provider": default_provider(),
                        "models": {"ollama": DEFAULT_OLLAMA_MODEL, "gemini": DEFAULT_GEMINI_MODEL},
                        "pythons": DEFAULT_PYTHONS,
                    },
                },
            )
            return
        if path == "/api/runs":
            with manager.lock:
                runs = sorted(manager.runs.values(), key=lambda r: r.created, reverse=True)
            self._json(200, {"runs": [r.public() for r in runs]})
            return
        match = re.fullmatch(rf"/api/runs/({_RUN_ID_RE})(?:/(capsule\.json|files/(.+)))?", path)
        run = manager.runs.get(match.group(1)) if match else None
        if run is None:
            self._error(404, "not found")
            return
        if match.group(2) is None:
            self._json(200, {**run.public(), "files": run.files(), "log": run.log_tail()})
            return
        relative = "capsule.json" if match.group(3) is None else unquote(match.group(3))
        target = safe_child(run.out_dir, relative, _RUN_FILE_RE)
        if target is None:
            self._error(404, "file not found")
            return
        self._file(target, _RUN_FILE_CSP)

    def do_POST(self) -> None:
        if not self._host_ok() or not self._post_ok():
            return
        ok, body = self._read_json()
        if not ok:
            return
        path = urlsplit(self.path).path
        manager = self.server.manager
        if path == "/api/runs":
            try:
                spec = validate_run_request(body)
            except ValidationError as exc:
                self._error(400, str(exc))
                return
            run = manager.start(spec)
            if run is None:
                self._error(409, "another run is still in progress; cancel it or wait")
                return
            self._json(202, {"id": run.id})
            return
        match = re.fullmatch(rf"/api/runs/({_RUN_ID_RE})/cancel", path)
        if match is None:
            self._error(404, "not found")
            return
        run = manager.cancel(match.group(1))
        if run is None:
            self._error(404, "not found")
        elif not run.cancel_requested:
            self._error(409, "run is not active")
        else:
            self._json(200, {"id": run.id, "status": run.status})


def make_server(
    host: str = "127.0.0.1",
    port: int = 8765,
    out_root: Path = Path("doxops-out/web"),
    *,
    allow_remote: bool = False,
    launcher: Launcher = subprocess_launcher,
) -> DashboardServer:
    if not is_loopback(host) and not allow_remote:
        raise ValueError("refusing to listen on a non-loopback address without allow_remote")
    return DashboardServer(host, port, RunManager(out_root, launcher), allow_remote=allow_remote)
