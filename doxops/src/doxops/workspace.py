"""Get a pristine copy of the target repository and produce patches against it."""

from __future__ import annotations

import difflib
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

from .evidence import EvidenceLog

COPY_IGNORE = shutil.ignore_patterns(
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    "*.pyc",
    ".pytest_cache",
    ".doxops",
    "doxops-out",
    "node_modules",
    "*.egg-info",
)
_URL = re.compile(r"^(https?://|git@|ssh://)")


def _make_writable_and_retry(func, path, _exc) -> None:
    os.chmod(path, stat.S_IWRITE)  # git marks object files read-only on Windows
    func(path)


def force_rmtree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, onexc=_make_writable_and_retry)


def is_remote(source: str) -> bool:
    return bool(_URL.match(source))


def acquire(source: str, dest: Path, evidence: EvidenceLog, ref: str | None = None) -> tuple[Path, str | None]:
    """Clone a URL or copy a local folder into ``dest``. Returns (path, commit sha or None)."""
    force_rmtree(dest)
    if is_remote(source):
        cmd = ["git", "clone", "--depth", "1"]
        if ref:
            cmd += ["--branch", ref]
        cmd += [source, str(dest)]
        ev, out = evidence.run("git", cmd, dest.parent, timeout_s=300)
        if ev.exit_code != 0:
            raise RuntimeError(f"git clone failed ({ev.id}): {out.strip().splitlines()[-1:]}")
    else:
        src = Path(source).expanduser().resolve()
        if not src.is_dir():
            raise FileNotFoundError(f"target folder not found: {src}")
        shutil.copytree(src, dest, ignore=COPY_IGNORE)
        if (src / ".git").exists():
            sha = _git_sha(src)
            return dest, sha
        return dest, None
    return dest, _git_sha(dest)


def _git_sha(path: Path) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def fresh_copy(pristine: Path, dest: Path) -> Path:
    force_rmtree(dest)
    shutil.copytree(pristine, dest, ignore=COPY_IGNORE)
    return dest


def _text_files(root: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for path in root.rglob("*"):
        if path.is_file() and ".git" not in path.parts and "__pycache__" not in path.parts:
            out[path.relative_to(root).as_posix()] = path
    return out


def unified_patch(before: Path, after: Path) -> str:
    """A git-style patch (apply with ``git apply``) from the pristine tree to the migrated one."""
    a_files, b_files = _text_files(before), _text_files(after)
    chunks: list[str] = []
    for rel in sorted(set(a_files) | set(b_files)):
        try:
            a = a_files[rel].read_text(encoding="utf-8").splitlines(keepends=True) if rel in a_files else []
            b = b_files[rel].read_text(encoding="utf-8").splitlines(keepends=True) if rel in b_files else []
        except UnicodeDecodeError:
            continue
        if a == b:
            continue
        a = [ln if ln.endswith("\n") else ln + "\n" for ln in a]
        b = [ln if ln.endswith("\n") else ln + "\n" for ln in b]
        header = f"diff --git a/{rel} b/{rel}\n"
        if rel not in a_files:
            header += "new file mode 100644\n"
        elif rel not in b_files:
            header += "deleted file mode 100644\n"
        diff = difflib.unified_diff(
            a,
            b,
            fromfile=f"a/{rel}" if rel in a_files else "/dev/null",
            tofile=f"b/{rel}" if rel in b_files else "/dev/null",
        )
        chunks.append(header + "".join(diff))
    return "".join(chunks)
