"""Package-index metadata: release history, yanks, PEP 792 project status, Python support."""

from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import datetime
from pathlib import Path

import httpx
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version

from .models import PackageMetadata

INDEX = "https://pypi.org"
TIMEOUT = httpx.Timeout(20.0, connect=10.0)
MAX_CONCURRENCY = 8
RETRIES = 3

_DEPRECATION_PATTERNS = [
    r"\bno longer (?:being )?maintained\b",
    r"\bunmaintained\b",
    r"\bnot (?:actively )?maintained\b",
    r"\bthis (?:project|package|library) is deprecated\b",
    r"\bdeprecated in favou?r of\b",
    r"\bis deprecated\b",
    r"\bend[- ]of[- ]life\b",
    r"\bsuperseded by\b",
    r"\bhas been archived\b",
    r"\bis archived\b",
    r"\babandoned\b",
    r"\buse [\w.-]+ instead\b",
]
_DEPRECATION_RE = re.compile("|".join(_DEPRECATION_PATTERNS), re.IGNORECASE)


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def deprecation_phrases(summary: str | None, description: str | None) -> list[str]:
    """Phrases in the summary or the top of the long description that announce end of life."""
    found: list[str] = []
    for text in (summary or "", (description or "")[:2000]):
        for m in _DEPRECATION_RE.finditer(text):
            start, end = max(0, m.start() - 60), min(len(text), m.end() + 60)
            snippet = " ".join(text[start:end].split())
            if snippet not in found:
                found.append(snippet)
    return found[:5]


def python_supported(requires_python: str | None, python: str) -> bool | None:
    if not requires_python:
        return None
    try:
        return Version(python + ".0") in SpecifierSet(requires_python)
    except (InvalidSpecifier, InvalidVersion):
        return None


def _release_time(files: list[dict]) -> datetime | None:
    times = [t for f in files if (t := _parse_time(f.get("upload_time_iso_8601")))]
    return min(times) if times else None


def _latest_stable(releases: dict[str, list[dict]]) -> str | None:
    best: Version | None = None
    for raw, files in releases.items():
        try:
            v = Version(raw)
        except InvalidVersion:
            continue
        if v.is_prerelease or v.is_devrelease or not files or all(f.get("yanked") for f in files):
            continue
        if best is None or v > best:
            best = v
    return str(best) if best else None


class PyPIClient:
    def __init__(self, cache_file: Path | None = None, offline: bool = False) -> None:
        self.cache_file = cache_file
        self.offline = offline
        self._stored: dict[str, dict] = {}
        if cache_file and cache_file.is_file():
            try:
                self._stored = json.loads(cache_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                self._stored = {}
        # online runs always fetch fresh metadata; the stored copy only serves --offline-index
        self._cache: dict[str, dict] = dict(self._stored) if offline else {}

    def _save(self) -> None:
        if not self.cache_file:
            return
        self._stored.update(self._cache)
        tmp = self.cache_file.with_suffix(f".{os.getpid()}.tmp")
        try:
            tmp.write_text(json.dumps(self._stored), encoding="utf-8")
            os.replace(tmp, self.cache_file)  # atomic, so concurrent runs never read half a file
        except OSError:
            tmp.unlink(missing_ok=True)

    async def _get(self, client: httpx.AsyncClient, url: str, headers: dict[str, str] | None = None) -> dict | None:
        if url in self._cache:
            return self._cache[url]
        if self.offline:
            return None
        delay = 1.0
        for attempt in range(RETRIES):
            try:
                resp = await client.get(url, headers=headers)
            except httpx.HTTPError:
                if attempt == RETRIES - 1:
                    raise
                await asyncio.sleep(delay)
                delay *= 2
                continue
            if resp.status_code == 404:
                self._cache[url] = {}
                return {}
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < RETRIES - 1:
                await asyncio.sleep(float(resp.headers.get("Retry-After", delay)))
                delay *= 2
                continue
            resp.raise_for_status()
            data = resp.json()
            self._cache[url] = data
            return data
        return None

    async def _fetch_one(
        self, client: httpx.AsyncClient, sem: asyncio.Semaphore, name: str, pinned: str | None
    ) -> PackageMetadata:
        async with sem:
            try:
                project = await self._get(client, f"{INDEX}/pypi/{name}/json")
                if project is None:
                    return PackageMetadata(
                        name=name, found=False, pinned_version=pinned, error="offline: no cached data"
                    )
                if not project:
                    return PackageMetadata(name=name, found=False, pinned_version=pinned, error="not found on PyPI")
                simple = await self._get(
                    client, f"{INDEX}/simple/{name}/", headers={"Accept": "application/vnd.pypi.simple.v1+json"}
                )
            except httpx.HTTPError as exc:
                return PackageMetadata(name=name, found=False, pinned_version=pinned, error=f"index error: {exc}")

        info = project.get("info", {})
        releases: dict[str, list[dict]] = project.get("releases", {})
        latest = _latest_stable(releases) or info.get("version")
        pinned_files = releases.get(pinned, []) if pinned else []
        pinned_rp = next((f.get("requires_python") for f in pinned_files if f.get("requires_python")), None)
        urls = info.get("project_urls") or {}
        repo = next(
            (u for k, u in urls.items() if k.lower() in {"source", "source code", "repository", "code", "github"}),
            None,
        )
        status = None
        if simple:
            status = (simple.get("project-status") or {}).get("status")
        classifiers: list[str] = info.get("classifiers") or []
        return PackageMetadata(
            name=name,
            found=True,
            latest_version=latest,
            latest_release_at=_release_time(releases.get(latest or "", [])),
            pinned_version=pinned,
            pinned_release_at=_release_time(pinned_files),
            pinned_yanked=bool(pinned_files) and all(f.get("yanked") for f in pinned_files),
            pinned_yanked_reason=next((f.get("yanked_reason") for f in pinned_files if f.get("yanked_reason")), None),
            requires_python=info.get("requires_python") or None,
            pinned_requires_python=pinned_rp,
            classifiers=classifiers,
            python_classifiers=[
                c.rsplit("::", 1)[1].strip()
                for c in classifiers
                if c.startswith("Programming Language :: Python :: 3.")
            ],
            project_status=status,
            summary=info.get("summary"),
            deprecation_phrases=deprecation_phrases(info.get("summary"), info.get("description")),
            homepage=info.get("home_page") or urls.get("Homepage"),
            repository=repo,
            release_count=sum(1 for files in releases.values() if files),
        )

    async def fetch_many(self, wanted: dict[str, str | None]) -> dict[str, PackageMetadata]:
        sem = asyncio.Semaphore(MAX_CONCURRENCY)
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": "doxops (+dependency-exit-capsule)"}) as c:
            results = await asyncio.gather(*(self._fetch_one(c, sem, n, p) for n, p in wanted.items()))
        self._save()
        return {m.name: m for m in results}

    def fetch(self, wanted: dict[str, str | None]) -> dict[str, PackageMetadata]:
        return asyncio.run(self.fetch_many(wanted))


def available_versions(client: PyPIClient, name: str) -> list[str] | None:
    """Release versions with at least one non-yanked file, from cache or the index (sync)."""
    url = f"{INDEX}/pypi/{name}/json"
    data = client._cache.get(url)
    if data is None and not client.offline:
        try:
            resp = httpx.get(url, timeout=TIMEOUT, headers={"User-Agent": "doxops (+dependency-exit-capsule)"})
        except httpx.HTTPError:
            return None
        data = resp.json() if resp.status_code == 200 else {}
        client._cache[url] = data
        client._save()
    if data is None:
        return None
    return [v for v, files in (data.get("releases") or {}).items() if files and not all(f.get("yanked") for f in files)]
