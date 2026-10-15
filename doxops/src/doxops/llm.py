"""Gemma 4 access: local Ollama (default) or the Gemini API, with schema-validated JSON output."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from .models import LLMCall, ModelInfo

T = TypeVar("T", bound=BaseModel)

GEMMA_LICENSE = "Gemma 4 is released under the Apache License 2.0 (open weights)."
DEFAULT_OLLAMA_MODEL = "gemma4:e4b"
DEFAULT_GEMINI_MODEL = "gemma-4-26b-a4b-it"
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class LLMError(RuntimeError):
    pass


def extract_json(text: str) -> str:
    """Pull the first JSON object out of a reply that may include fences or chatter."""
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        return fenced.group(1)
    start = text.find("{")
    if start < 0:
        raise LLMError("model reply contains no JSON object")
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise LLMError("model reply contains an unterminated JSON object")


class Provider(ABC):
    name: str
    model: str

    @abstractmethod
    def complete(self, system: str, user: str, schema: dict) -> str: ...

    @abstractmethod
    def info(self) -> ModelInfo: ...


class OllamaProvider(Provider):
    name = "ollama"

    def __init__(self, model: str, host: str | None = None, timeout_s: float = 900.0, num_ctx: int = 16384) -> None:
        self.model = model
        self.host = (host or os.environ.get("OLLAMA_HOST") or "http://localhost:11434").rstrip("/")
        if not self.host.startswith("http"):
            self.host = "http://" + self.host
        self.timeout = httpx.Timeout(timeout_s, connect=10.0)
        self.num_ctx = num_ctx
        self._think_supported = True

    def complete(self, system: str, user: str, schema: dict) -> str:
        body: dict = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "stream": False,
            "format": schema,
            "options": {"temperature": 0.2, "num_ctx": self.num_ctx},
        }
        if self._think_supported:
            body["think"] = False
        try:
            resp = httpx.post(f"{self.host}/api/chat", json=body, timeout=self.timeout)
            if resp.status_code == 400 and "think" in resp.text.lower() and self._think_supported:
                self._think_supported = False
                body.pop("think", None)
                resp = httpx.post(f"{self.host}/api/chat", json=body, timeout=self.timeout)
        except httpx.ConnectError as exc:
            raise LLMError(f"cannot reach Ollama at {self.host}: start it with 'ollama serve'") from exc
        except httpx.TimeoutException as exc:
            raise LLMError(f"Ollama timed out after {self.timeout.read:.0f}s") from exc
        except httpx.HTTPError as exc:  # dropped connection, protocol error...
            raise LLMError(f"Ollama connection failed: {exc}") from exc
        if resp.status_code == 404:
            raise LLMError(f"model '{self.model}' is not pulled: run 'ollama pull {self.model}'")
        if resp.status_code >= 400:
            raise LLMError(f"Ollama error {resp.status_code}: {resp.text[:300]}")
        try:
            return resp.json().get("message", {}).get("content", "")
        except ValueError as exc:
            raise LLMError(f"Ollama returned a non-JSON reply: {resp.text[:200]}") from exc

    def info(self) -> ModelInfo:
        details: dict[str, str] = {"host": self.host}
        try:
            resp = httpx.post(f"{self.host}/api/show", json={"model": self.model}, timeout=15.0)
            if resp.status_code == 200:
                data = resp.json()
                for key, value in (data.get("details") or {}).items():
                    if isinstance(value, str | int | float):
                        details[key] = str(value)
                if data.get("modified_at"):
                    details["modified_at"] = str(data["modified_at"])
            tags = httpx.get(f"{self.host}/api/tags", timeout=15.0)
            if tags.status_code == 200:
                for m in tags.json().get("models", []):
                    if m.get("name") == self.model or m.get("model") == self.model:
                        details["digest"] = str(m.get("digest", ""))[:19]
                        details["size_bytes"] = str(m.get("size", ""))
            version = httpx.get(f"{self.host}/api/version", timeout=15.0)
            if version.status_code == 200:
                details["ollama_version"] = str(version.json().get("version", ""))
        except httpx.HTTPError:
            details["note"] = "Ollama not reachable when model details were collected"
        return ModelInfo(
            provider="ollama",
            model=self.model,
            details=details,
            license=GEMMA_LICENSE,
            access_method=f"Local inference through Ollama REST API ({self.host}/api/chat) with JSON-schema "
            "constrained output; no data leaves the machine.",
        )


class GeminiProvider(Provider):
    name = "gemini"

    def __init__(self, model: str, api_key: str | None = None, timeout_s: float = 300.0) -> None:
        self.model = model
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not self.api_key:
            raise LLMError("GEMINI_API_KEY is not set (put it in .env, never in the repo)")
        self.timeout = httpx.Timeout(timeout_s, connect=10.0)
        self._json_mode = True

    def complete(self, system: str, user: str, schema: dict) -> str:
        prompt = f"{user}\n\nReturn only one JSON object matching this JSON Schema:\n{json.dumps(schema)}"
        body: dict = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2},
        }
        if self._json_mode:
            body["generationConfig"]["responseMimeType"] = "application/json"
        url = GEMINI_ENDPOINT.format(model=self.model)
        headers = {"x-goog-api-key": self.api_key, "Content-Type": "application/json"}
        delay = 2.0
        for attempt in range(4):
            try:
                resp = httpx.post(url, json=body, headers=headers, timeout=self.timeout)
            except httpx.HTTPError as exc:
                if attempt == 3:
                    raise LLMError(f"Gemini API unreachable: {exc}") from exc
                time.sleep(delay)
                delay *= 2
                continue
            if resp.status_code == 400 and self._json_mode:
                self._json_mode = False
                body["generationConfig"].pop("responseMimeType", None)
                continue
            if resp.status_code in (429, 500, 503) and attempt < 3:
                time.sleep(delay)
                delay *= 2
                continue
            if resp.status_code >= 400:
                raise LLMError(f"Gemini API error {resp.status_code}: {resp.text[:300]}")
            try:
                parts = (resp.json().get("candidates") or [{}])[0].get("content", {}).get("parts", [])
            except ValueError as exc:
                raise LLMError(f"Gemini API returned a non-JSON reply: {resp.text[:200]}") from exc
            return "".join(p.get("text", "") for p in parts if not p.get("thought"))
        raise LLMError("Gemini API kept failing after retries")

    def info(self) -> ModelInfo:
        return ModelInfo(
            provider="gemini-api",
            model=self.model,
            details={"endpoint": GEMINI_ENDPOINT.format(model=self.model)},
            license=GEMMA_LICENSE + " Hosted access is subject to the Gemini API Terms of Service.",
            access_method="Hosted Gemma 4 through the Gemini API (generateContent REST endpoint).",
        )


def inline_refs(schema: dict) -> dict:
    """Resolve local ``$ref``s so grammar-constrained decoders (Ollama/llama.cpp) get a flat schema."""
    defs = schema.get("$defs", {})

    def walk(node: object) -> object:
        if isinstance(node, dict):
            if "$ref" in node and node["$ref"].startswith("#/$defs/"):
                target = defs[node["$ref"].split("/")[-1]]
                merged = {**target, **{k: v for k, v in node.items() if k != "$ref"}}
                return walk(merged)
            return {k: walk(v) for k, v in node.items() if k != "$defs"}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(schema)  # type: ignore[return-value]


class StructuredLLM:
    """Wraps a provider: logs every prompt/response, validates against a Pydantic model, retries on bad JSON."""

    def __init__(self, provider: Provider, log_dir: Path, max_format_retries: int = 2) -> None:
        self.provider = provider
        self.log_dir = log_dir
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.max_format_retries = max_format_retries
        self.calls: list[LLMCall] = []

    def ask(
        self, system: str, user: str, model_type: type[T], purpose: str, attempt: int = 1
    ) -> tuple[T | None, LLMCall]:
        schema = inline_refs(model_type.model_json_schema())
        prompt = user
        last_error = ""
        call: LLMCall | None = None
        for fmt_try in range(self.max_format_retries + 1):
            if last_error:
                prompt = (
                    f"{user}\n\nYour previous reply was rejected: {last_error}\n"
                    "Reply again with one valid JSON object that matches the schema exactly."
                )
            digest = hashlib.sha256((system + "\n\n" + prompt).encode("utf-8")).hexdigest()
            stem = f"{len(self.calls) + 1:03d}-{purpose}"
            prompt_path = self.log_dir / f"{stem}.prompt.md"
            response_path = self.log_dir / f"{stem}.response.txt"
            prompt_path.write_text(f"# system\n\n{system}\n\n# user\n\n{prompt}\n", encoding="utf-8")
            t0 = time.monotonic()
            try:
                raw = self.provider.complete(system, prompt, schema)
                error = None
            except LLMError as exc:
                raw, error = "", str(exc)
            latency = time.monotonic() - t0
            response_path.write_text(raw or f"[error] {error}", encoding="utf-8")
            call = LLMCall(
                provider=self.provider.name,
                model=self.provider.model,
                purpose=purpose,
                prompt_sha256=digest,
                prompt_path=prompt_path.relative_to(self.log_dir.parent).as_posix(),
                response_path=response_path.relative_to(self.log_dir.parent).as_posix(),
                latency_s=round(latency, 2),
                ok=False,
                error=error,
                attempt=attempt,
            )
            self.calls.append(call)
            if error:
                return None, call  # transport errors are not fixed by re-asking
            try:
                parsed = model_type.model_validate_json(extract_json(raw))
            except (LLMError, ValidationError, ValueError) as exc:
                last_error = str(exc).splitlines()[0][:400]
                call.error = f"invalid output (format retry {fmt_try}): {last_error}"
                continue
            call.ok = True
            return parsed, call
        assert call is not None
        return None, call


def build_provider(provider: str, model: str | None) -> Provider:
    if provider == "ollama":
        return OllamaProvider(model or os.environ.get("DOXOPS_MODEL") or DEFAULT_OLLAMA_MODEL)
    if provider in ("gemini", "gemini-api"):
        return GeminiProvider(model or os.environ.get("DOXOPS_GEMINI_MODEL") or DEFAULT_GEMINI_MODEL)
    raise LLMError(f"unknown provider '{provider}' (use ollama or gemini)")
