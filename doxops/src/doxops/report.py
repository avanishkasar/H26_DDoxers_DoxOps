"""Write the Dependency Exit Capsules: machine-readable JSON plus Markdown and HTML for people."""

from __future__ import annotations

import json
from pathlib import Path

from jinja2 import Environment, PackageLoader, select_autoescape

from .models import DependencyCapsule, Fact, Provenance, RunSummary

BADGE = {Provenance.OBSERVED: "OBSERVED", Provenance.VERIFIED: "VERIFIED", Provenance.AI: "AI"}


def _fact(f: Fact) -> str:
    ev = f" (evidence: {', '.join(f.evidence_ids)})" if f.evidence_ids else ""
    return f"- **[{BADGE[f.provenance]}]** {f.text}{ev}"


def _md_escape(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def capsule_markdown(c: DependencyCapsule, summary: RunSummary) -> str:
    m = c.metadata
    out: list[str] = [f"# Dependency Exit Capsule: `{c.dependency}`", ""]
    out += [
        f"**Status:** `{c.status}` · **Risk:** {c.risk.score}/100 ({c.risk.severity.value}) · "
        f"**Target:** {summary.target.source} @ `{(summary.target.commit or 'n/a')[:12]}`",
        "",
        "> Labels: **[OBSERVED]** read from the repository or PyPI · **[VERIFIED]** proven by a command DoxOps ran "
        "(see evidence ids) · **[AI]** Gemma 4 output that has not been proven.",
        "",
        "## 1. Dependency details",
        "",
    ]
    for d in c.declarations:
        flag = " (commented out)" if d.commented_out else ""
        out.append(f"- **[OBSERVED]** `{d.raw}` in `{d.source_file}:{d.line}` ({d.section}){flag}")
    if not c.declarations:
        out.append("- **[OBSERVED]** Not declared anywhere: only installed as a transitive dependency.")
    if m and m.found:
        out.append(
            f"- **[OBSERVED]** PyPI: pinned `{m.pinned_version or 'unpinned'}`"
            + (f" (released {m.pinned_release_at:%Y-%m-%d})" if m.pinned_release_at else "")
            + f", latest `{m.latest_version}`"
            + (f" (released {m.latest_release_at:%Y-%m-%d})" if m.latest_release_at else "")
            + f", status `{m.project_status or 'unknown'}`, {m.release_count} releases"
        )
        if m.summary:
            out.append(f"- **[OBSERVED]** Summary: {m.summary}")
    out += [
        "",
        "## 2. Risk indicators",
        "",
        "| Indicator | Weight | Provenance | Detail | Evidence |",
        "|---|---|---|---|---|",
    ]
    for i in c.risk.indicators:
        out.append(
            f"| {_md_escape(i.title)} | {i.weight} | {BADGE[i.provenance]} | {_md_escape(i.detail)[:220]} | "
            f"{', '.join(i.evidence_ids) or '-'} |"
        )
    out += ["", "## 3. Usage locations", ""]
    for s in c.usage[:80]:
        out.append(f"- **[OBSERVED]** `{s.file}:{s.line}` {s.kind} `{s.symbol or s.module}`: `{s.snippet[:120]}`")
    if not c.usage:
        out.append("- **[OBSERVED]** No direct import or tool reference found.")
    if c.runtime_usage:
        out += ["", "Runtime calls recorded while the original test suite ran:", ""]
        for r in c.runtime_usage[:40]:
            out.append(f"- **[VERIFIED]** `{r.caller_file}:{r.caller_line}` -> `{r.module}.{r.function}` x{r.count}")
    out += ["", "## 4. Proposed replacement", ""]
    out += [_fact(c.proposed_replacement)] if c.proposed_replacement else ["- No proposal (not attempted)."]
    if c.rationale:
        out += ["", "Rationale:", "", _fact(c.rationale)]
    if c.analysis:
        out += ["", "Analysis:", "", _fact(c.analysis)]
    out += ["", "## 5. Migration steps", ""]
    out += [f"{n}. **[{BADGE[f.provenance]}]** {f.text}" for n, f in enumerate(c.migration_steps, 1)] or ["- None."]
    out += ["", "## 6. Suggested tests", ""]
    out += [_fact(f) for f in c.suggested_tests] or ["- None."]
    out += ["", "## 7. Executed test results", ""]
    if c.executed_results:
        out += [
            "| Python | Fixed | Regressed | Still failing | Still passing | Dep. warnings before -> after |",
            "|---|---|---|---|---|---|",
        ]
        for comp in c.executed_results:
            out.append(
                f"| {comp.python} | {comp.fixed} | {comp.regressed} | {comp.still_failing} | {comp.still_passing} | "
                f"{comp.dependency_warnings_before} -> {comp.dependency_warnings_after} |"
            )
        out.append("")
        for comp in c.executed_results:
            for d in comp.deltas:
                if d.change in ("fixed", "regressed", "still-failing"):
                    out.append(
                        f"- **[VERIFIED]** py{comp.python} `{d.nodeid}`: {d.before} -> {d.after} ({d.change})"
                        + (f" [{d.failure_class}]" if d.failure_class else "")
                    )
    else:
        out.append("- No tests were executed for a migration.")
    out += ["", "### Attempts", ""]
    for a in c.attempts:
        llm = f"{a.llm_call.model} via {a.llm_call.provider}, {a.llm_call.latency_s}s" if a.llm_call else "-"
        out.append(
            f"- Attempt {a.attempt} ({llm}): {a.verdict or 'no verdict'}"
            + (f" · patch `{a.patch_path}`" if a.patch_path else "")
        )
        for ch in a.manifest_changes:
            out.append(f"  - manifest: {ch}")
        for e in a.edits:
            out.append(f"  - edit `{e.file}`: {'applied' if e.applied else 'NOT applied'} {e.error or e.reason}")
    if not c.attempts:
        out.append("- None.")
    out += ["", "## 8. Compatibility gaps", ""]
    out += [_fact(f) for f in c.compatibility_gaps] or ["- None observed in executed tests."]
    out += ["", "## 9. Open concerns and limitations", ""]
    out += [_fact(f) for f in c.open_concerns] or ["- None."]
    out.append("")
    return "\n".join(out)


def inventory(s: RunSummary) -> list[dict[str, object]]:
    """Every installed distribution in the baseline: version per Python, direct or transitive, and who pulls it in."""
    direct = {r.name for r in s.manifest.requirements if not r.commented_out and not r.section.startswith("build")}
    names: set[str] = set()
    for run in s.baseline:
        names |= set(run.installed)
    rows: list[dict[str, object]] = []
    for name in sorted(names):
        parents: set[str] = set()
        for run in s.baseline:
            parents |= {p for p, reqs in run.requires.items() if name in reqs}
        rows.append(
            {
                "name": name,
                "versions": {run.python: run.installed.get(name, "-") for run in s.baseline},
                "direct": name in direct,
                "required_by": sorted(parents),
            }
        )
    return rows


def next_actions(s: RunSummary) -> list[str]:
    out: list[str] = []
    for c in s.capsules:
        if c.status == "verified":
            out.append(f"Apply `{c.dependency}`: verified on every target Python (see `capsules/{c.dependency}.md`).")
        elif c.status == "partially-verified":
            out.append(f"Review `{c.dependency}`: accepted, but some failures it caused remain.")
        elif c.status in ("unverified", "failed"):
            out.append(f"Investigate `{c.dependency}` by hand: no attempt passed verification.")
        else:
            out.append(f"Run `doxops run --only {c.dependency}` to plan and verify `{c.dependency}`.")
    if s.combined_patch:
        out.append(f"All accepted migrations together: `git apply {s.combined_patch}` (re-run the tests afterwards).")
    return out


def summary_markdown(s: RunSummary) -> str:
    out = [
        "# DoxOps run report",
        "",
        f"- Target: {s.target.source} @ `{s.target.commit or 'n/a'}`",
        f"- Python versions: {', '.join(s.target.pythons)}",
        f"- Generated: {s.generated_at:%Y-%m-%d %H:%M UTC} by doxops {s.tool_version}",
    ]
    if s.model:
        out.append(f"- Model: `{s.model.model}` via {s.model.provider} ({s.model.license})")
    out += [
        "",
        "## Baseline (original dependencies)",
        "",
        "| Python | Install | Passed | Failed | Warnings | Evidence |",
        "|---|---|---|---|---|---|",
    ]
    for r in s.baseline:
        c = r.counts()
        out.append(
            f"| {r.python} | {'ok' if r.install_ok else 'failed'} | {c.get('passed', 0)} | "
            f"{c.get('failed', 0) + c.get('error', 0)} | {sum(w.count for w in r.warnings)} | "
            f"{r.install_evidence}, {r.test_evidence} |"
        )
    out += [
        "",
        "## Dependency risk ranking",
        "",
        "| Dependency | Score | Severity | At risk | Top indicators | Capsule |",
        "|---|---|---|---|---|---|",
    ]
    capsule_names = {c.dependency for c in s.capsules}
    for r in s.risks:
        top = "; ".join(i.code for i in sorted(r.indicators, key=lambda i: -i.weight)[:4]) or "-"
        link = f"[capsule](capsules/{r.name}.md)" if r.name in capsule_names else "-"
        out.append(f"| `{r.name}` | {r.score} | {r.severity.value} | {'yes' if r.at_risk else 'no'} | {top} | {link} |")
    out += ["", "## Migration outcomes", "", "| Dependency | Status | Proposal | Attempts |", "|---|---|---|---|"]
    for c in s.capsules:
        prop = (
            f"[{BADGE[c.proposed_replacement.provenance]}] {_md_escape(c.proposed_replacement.text)}"
            if c.proposed_replacement
            else "-"
        )
        out.append(f"| `{c.dependency}` | {c.status} | {prop} | {len(c.attempts)} |")
    if s.combined_comparisons:
        out += [
            "",
            "## All accepted migrations applied together",
            "",
            "| Python | Fixed | Regressed | Still failing | Still passing |",
            "|---|---|---|---|---|",
        ]
        for comp in s.combined_comparisons:
            out.append(
                f"| {comp.python} | {comp.fixed} | {comp.regressed} | {comp.still_failing} | {comp.still_passing} |"
            )
        out.append(f"\nPatch: `{s.combined_patch}` · migrated tree: `migrated-repo/`")
    inv = inventory(s)
    if inv:
        pys = [r.python for r in s.baseline]
        out += [
            "",
            "## Dependency inventory (baseline environment)",
            "",
            "| Package | " + " | ".join(f"py{p}" for p in pys) + " | Kind | Required by |",
            "|---|" + "---|" * len(pys) + "---|---|",
        ]
        for row in inv:
            vers = " | ".join(str(row["versions"].get(p, "-")) for p in pys)  # type: ignore[union-attr]
            kind = "direct" if row["direct"] else "transitive"
            req_by = ", ".join(row["required_by"]) or "-"  # type: ignore[arg-type]
            out.append(f"| `{row['name']}` | {vers} | {kind} | {req_by} |")
    out += ["", "## Limitations", ""] + [f"- {x}" for x in s.limitations]
    out += [
        "",
        f"Evidence: {len(s.evidence)} executed commands (logs + SHA-256 in `evidence/`), "
        f"{len(s.llm_calls)} model calls (prompts and raw replies in `llm/`).",
        "",
    ]
    return "\n".join(out)


def write_outputs(summary: RunSummary, out_dir: Path) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    cap_dir = out_dir / "capsules"
    cap_dir.mkdir(exist_ok=True)
    paths: dict[str, Path] = {}
    data = summary.model_dump(mode="json")
    (out_dir / "capsule.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
    paths["json"] = out_dir / "capsule.json"
    for c in summary.capsules:
        (cap_dir / f"{c.dependency}.json").write_text(c.model_dump_json(indent=2), encoding="utf-8")
        (cap_dir / f"{c.dependency}.md").write_text(capsule_markdown(c, summary), encoding="utf-8")
    (out_dir / "REPORT.md").write_text(summary_markdown(summary), encoding="utf-8")
    paths["markdown"] = out_dir / "REPORT.md"
    env = Environment(loader=PackageLoader("doxops", "templates"), autoescape=select_autoescape(["html", "j2"]))
    html = env.get_template("report.html.j2").render(
        s=summary, badge=BADGE, P=Provenance, inventory=inventory(summary), actions=next_actions(summary)
    )
    (out_dir / "report.html").write_text(html, encoding="utf-8")
    paths["html"] = out_dir / "report.html"
    return paths
