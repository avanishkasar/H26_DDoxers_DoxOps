"""Run commands and keep a tamper-evident record of each one."""

from __future__ import annotations

import hashlib
import os
import subprocess
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from .models import Evidence

EvidenceKind = Literal["install", "import-probe", "test-run", "pip-check", "git", "other"]

_EXCERPT_LINES = 25


def _excerpt(text: str) -> str:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return "\n".join(lines[-_EXCERPT_LINES:])


class EvidenceLog:
    """Thread-safe registry. Every executed command becomes an ``Evidence`` with a log file and hash."""

    def __init__(self, out_dir: Path) -> None:
        self.dir = out_dir / "evidence"
        self.dir.mkdir(parents=True, exist_ok=True)
        root = str(out_dir.resolve())
        home = str(Path.home())
        # longest first, both slash styles, so Windows and POSIX paths are rewritten alike
        self._redactions = sorted(
            {(root, "<out>"), (root.replace("\\", "/"), "<out>"), (home, "~"), (home.replace("\\", "/"), "~")},
            key=lambda pair: -len(pair[0]),
        )
        self._items: list[Evidence] = []
        self._lock = threading.Lock()

    @property
    def items(self) -> list[Evidence]:
        with self._lock:
            return list(self._items)

    def redact(self, text: str) -> str:
        """Replace the output folder and home directory so logs and reports never expose host paths."""
        for needle, label in self._redactions:
            if len(needle) > 1:
                text = text.replace(needle, label)
        return text

    def _next_id(self) -> str:
        return f"E{len(self._items) + 1:03d}"

    def run(
        self,
        kind: EvidenceKind,
        command: list[str],
        cwd: Path,
        *,
        python: str | None = None,
        timeout_s: float = 600.0,
        env: dict[str, str] | None = None,
    ) -> tuple[Evidence, str]:
        started = datetime.now(UTC)
        t0 = time.monotonic()
        merged_env = {**os.environ, **(env or {})}
        merged_env.setdefault("PYTHONIOENCODING", "utf-8")
        timed_out = False
        try:
            proc = subprocess.run(
                command,
                cwd=cwd,
                env=merged_env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_s,
                check=False,
            )
            output = proc.stdout + ("\n" if proc.stdout and proc.stderr else "") + proc.stderr
            exit_code: int | None = proc.returncode
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            out = exc.stdout or ""
            err = exc.stderr or ""
            if isinstance(out, bytes):
                out = out.decode("utf-8", "replace")
            if isinstance(err, bytes):
                err = err.decode("utf-8", "replace")
            output = f"{out}\n{err}\n[doxops] command timed out after {timeout_s:.0f}s"
            exit_code = None
        except FileNotFoundError as exc:
            output = f"[doxops] executable not found: {exc}"
            exit_code = 127
        duration = time.monotonic() - t0

        with self._lock:
            ev_id = self._next_id()
            log_path = self.dir / f"{ev_id}-{kind}.log"
            shown = [self.redact(part) for part in command]
            header = (
                f"$ {' '.join(shown)}\n# cwd: {self.redact(str(cwd))}\n# python: {python or '-'}\n"
                f"# started: {started.isoformat()}\n# exit: {exit_code}\n# duration_s: {duration:.2f}\n\n"
            )
            body = header + self.redact(output)
            log_path.write_text(body, encoding="utf-8")
            evidence = Evidence(
                id=ev_id,
                kind=kind,
                command=shown,
                cwd=self.redact(str(cwd)),
                python=python,
                exit_code=exit_code,
                timed_out=timed_out,
                duration_s=round(duration, 3),
                started_at=started,
                log_path=log_path.relative_to(self.dir.parent).as_posix(),
                log_sha256=hashlib.sha256(body.encode("utf-8")).hexdigest(),
                excerpt=_excerpt(self.redact(output)),
            )
            self._items.append(evidence)
        return evidence, output
