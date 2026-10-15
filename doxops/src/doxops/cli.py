"""Command-line interface: ``doxops doctor | scan | run | schema | render``."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import click
import httpx
from rich.console import Console
from rich.table import Table

from . import __version__
from .llm import DEFAULT_GEMINI_MODEL, DEFAULT_OLLAMA_MODEL, LLMError, StructuredLLM, build_provider
from .models import DependencyCapsule, RunSummary
from .pipeline import Pipeline, RunOptions
from .report import write_outputs
from .settings import load_dotenv
from .workspace import force_rmtree

DEFAULT_TARGET = "https://github.com/rishrek/LinkWatch"
console = Console()


def _default_out() -> Path:
    return Path("doxops-out") / datetime.now().strftime("%Y%m%d-%H%M%S")


def _risk_table(summary: RunSummary) -> Table:
    table = Table(title="Dependency risk", show_lines=False)
    table.add_column("Dependency", style="bold")
    table.add_column("Score", justify="right")
    table.add_column("Severity")
    table.add_column("Top indicators")
    table.add_column("Capsule status")
    status = {c.dependency: c.status for c in summary.capsules}
    colours = {"critical": "red", "high": "red", "medium": "yellow", "low": "dim", "none": "dim"}
    for r in summary.risks:
        top = ", ".join(i.code for i in sorted(r.indicators, key=lambda i: -i.weight)[:4])
        sev = r.severity.value
        table.add_row(r.name, str(r.score), f"[{colours[sev]}]{sev}[/]", top or "-", status.get(r.name, "-"))
    return table


def _common(func):
    func = click.option(
        "--python",
        "pythons",
        multiple=True,
        default=("3.12", "3.13"),
        show_default=True,
        help="Python versions to verify on (repeatable).",
    )(func)
    func = click.option(
        "--out",
        "out_dir",
        type=click.Path(path_type=Path),
        default=None,
        help="Output folder (default: doxops-out/<timestamp>).",
    )(func)
    func = click.option(
        "--exclude",
        multiple=True,
        default=("doxops",),
        show_default=True,
        help="Top-level folders to ignore when scanning the target.",
    )(func)
    func = click.option("--ref", default=None, help="Branch or tag to clone when TARGET is a URL.")(func)
    func = click.option("--offline-index", is_flag=True, help="Use only cached PyPI metadata.")(func)
    func = click.option("--keep-envs", is_flag=True, help="Keep virtualenvs and attempt trees for inspection.")(func)
    func = click.argument("target", default=DEFAULT_TARGET)(func)
    return func


def _finish(summary: RunSummary, out: Path, fail_on: str | None) -> None:
    paths = write_outputs(summary, out)
    console.print(_risk_table(summary))
    console.print(f"\n[bold]Capsules written:[/] {paths['markdown']}  {paths['html']}  {paths['json']}")
    if fail_on:
        order = ["low", "medium", "high", "critical"]
        threshold = order.index(fail_on)
        worst = max((order.index(r.severity.value) for r in summary.risks if r.severity.value in order), default=-1)
        if worst >= threshold:
            console.print(f"[red]Failing: at least one dependency is {fail_on} risk or worse.[/]")
            sys.exit(3)


@click.group()
@click.version_option(__version__, prog_name="doxops")
def main() -> None:
    """DoxOps: find at-risk dependencies, plan their exit with Gemma 4, and prove it by running the tests."""
    load_dotenv(Path.cwd() / ".env", Path(__file__).resolve().parents[3] / ".env")


@main.command()
@_common
@click.option(
    "--fail-on",
    type=click.Choice(["low", "medium", "high", "critical"]),
    default=None,
    help="Exit with code 3 if any dependency reaches this severity (for CI).",
)
def scan(
    target: str,
    pythons: tuple[str, ...],
    out_dir: Path | None,
    exclude: tuple[str, ...],
    ref: str | None,
    offline_index: bool,
    keep_envs: bool,
    fail_on: str | None,
) -> None:
    """Observe and verify only: manifests, usage, PyPI signals, baseline tests, risk scores. No AI."""
    out = out_dir or _default_out()
    opts = RunOptions(
        target=target,
        out_dir=out,
        pythons=list(pythons),
        exclude_dirs=set(exclude),
        ref=ref,
        offline_index=offline_index,
        keep_envs=keep_envs,
        scan_only=True,
    )
    summary = _run_pipeline(opts)
    _finish(summary, out, fail_on)


def _run_pipeline(opts: RunOptions) -> RunSummary:
    """Run the pipeline, turning expected failures (bad target, missing uv, clone errors) into clean messages."""
    try:
        return Pipeline(opts, log=console.print).run()
    except (OSError, RuntimeError) as exc:
        if not opts.keep_envs:
            force_rmtree(opts.out_dir / "work")
        raise click.ClickException(f"{type(exc).__name__}: {exc}") from exc


def _ollama_problem(host: str, model: str) -> str | None:
    """None when Ollama answers and the model is pulled, otherwise a one-line fix for the user."""
    try:
        tags = httpx.get(f"{host}/api/tags", timeout=10).json().get("models", [])
    except (httpx.HTTPError, ValueError):
        return f"Ollama is not reachable at {host}; start it with 'ollama serve'"
    names = [m.get("name") for m in tags if m.get("name")]
    if model not in names and f"{model}:latest" not in names:
        return f"model {model} is not pulled (run 'ollama pull {model}'); available: {', '.join(names) or 'none'}"
    return None


@main.command()
@_common
@click.option(
    "--provider",
    type=click.Choice(["ollama", "gemini"]),
    default=lambda: os.environ.get("DOXOPS_PROVIDER", "ollama"),
    show_default="ollama",
    help="Where Gemma 4 runs: local Ollama or the Gemini API.",
)
@click.option("--model", default=None, help=f"Model id (default {DEFAULT_OLLAMA_MODEL} / {DEFAULT_GEMINI_MODEL}).")
@click.option("--max-repairs", default=2, show_default=True, help="Repair rounds after a failed verification.")
@click.option("--only", multiple=True, help="Only migrate these dependencies (repeatable).")
@click.option("--max-deps", type=int, default=None, help="Migrate at most N highest-risk dependencies.")
@click.option(
    "--fail-on",
    type=click.Choice(["low", "medium", "high", "critical"]),
    default=None,
    help="Exit with code 3 if any dependency reaches this severity (for CI).",
)
def run(
    target: str,
    pythons: tuple[str, ...],
    out_dir: Path | None,
    exclude: tuple[str, ...],
    ref: str | None,
    offline_index: bool,
    keep_envs: bool,
    provider: str,
    model: str | None,
    max_repairs: int,
    only: tuple[str, ...],
    max_deps: int | None,
    fail_on: str | None,
) -> None:
    """Full pipeline: scan, ask Gemma 4 for a plan per at-risk dependency, verify it, write capsules."""
    out = out_dir or _default_out()
    try:
        prov = build_provider(provider, model)
    except LLMError as exc:
        raise click.ClickException(str(exc)) from exc
    if provider == "ollama" and (problem := _ollama_problem(prov.host, prov.model)):  # type: ignore[attr-defined]
        raise click.ClickException(f"{problem}. Nothing was run; 'doxops scan' works without a model.")
    llm = StructuredLLM(prov, out / "llm")
    info = prov.info()
    console.print(f"Model: [bold]{info.model}[/] via {info.provider}")
    opts = RunOptions(
        target=target,
        out_dir=out,
        pythons=list(pythons),
        llm=llm,
        model_info=info,
        max_repairs=max_repairs,
        only=list(only),
        max_deps=max_deps,
        exclude_dirs=set(exclude),
        ref=ref,
        offline_index=offline_index,
        keep_envs=keep_envs,
    )
    summary = _run_pipeline(opts)
    _finish(summary, out, fail_on)


@main.command()
@click.option(
    "--provider", type=click.Choice(["ollama", "gemini"]), default=lambda: os.environ.get("DOXOPS_PROVIDER", "ollama")
)
@click.option("--model", default=None)
@click.option("--python", "pythons", multiple=True, default=("3.12", "3.13"))
def doctor(provider: str, model: str | None, pythons: tuple[str, ...]) -> None:
    """Check that uv, git, the Python versions and Gemma 4 are ready."""
    ok = True

    def line(good: bool, label: str, detail: str) -> None:
        nonlocal ok
        ok = ok and good
        console.print(f"{'[green]OK  [/]' if good else '[red]FAIL[/]'} {label}: {detail}")

    for tool in ("git", "uv"):
        path = shutil.which(tool)
        line(bool(path), tool, path or "not found on PATH")
    if shutil.which("uv"):
        for py in pythons:
            proc = subprocess.run(
                ["uv", "python", "find", py],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            found = proc.returncode == 0
            line(found, f"Python {py}", proc.stdout.strip() if found else f"missing: run 'uv python install {py}'")
    if provider == "ollama":
        prov = build_provider("ollama", model)
        problem = _ollama_problem(prov.host, prov.model)  # type: ignore[attr-defined]
        line(problem is None, "Ollama + model", problem or f"{prov.model} ready at {prov.host}")  # type: ignore[attr-defined]
    else:
        has_key = bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))
        line(has_key, "GEMINI_API_KEY", "set" if has_key else "missing (put it in .env)")
    sys.exit(0 if ok else 1)


@main.command()
@click.option("--out", "out_file", type=click.Path(path_type=Path), default=None)
def schema(out_file: Path | None) -> None:
    """Print the JSON Schema of a Dependency Exit Capsule (for reuse by other tools)."""
    text = json.dumps(DependencyCapsule.model_json_schema(), indent=2)
    if out_file:
        out_file.write_text(text + "\n", encoding="utf-8")
        console.print(f"Wrote {out_file}")
    else:
        click.echo(text)


@main.command()
@click.argument("out_dir", type=click.Path(exists=True, file_okay=False, path_type=Path))
def render(out_dir: Path) -> None:
    """Re-render Markdown and HTML from an existing capsule.json."""
    summary = RunSummary.model_validate_json((out_dir / "capsule.json").read_text(encoding="utf-8"))
    paths = write_outputs(summary, out_dir)
    console.print(f"Rendered {paths['markdown']} and {paths['html']}")


if __name__ == "__main__":
    main()
