"""The end-to-end DoxOps run: observe -> verify baseline -> score -> plan (AI) -> verify plan -> capsule."""

from __future__ import annotations

import ast
import difflib
import os
import shutil
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from packaging.utils import canonicalize_name

from . import __version__
from .compare import compare
from .evidence import EvidenceLog
from .llm import StructuredLLM
from .manifests import read_manifests, runtime_requirement_names
from .models import (
    Comparison,
    DependencyCapsule,
    Fact,
    MigrationAttempt,
    MigrationPlan,
    ModelInfo,
    PackageMetadata,
    Provenance,
    RunSummary,
    RuntimeCall,
    SuiteRun,
    TargetInfo,
    UsageSite,
)
from .planner import (
    SYSTEM_PROMPT,
    PlanContext,
    apply_edits,
    build_prompt,
    build_repair_prompt,
    failure_excerpts,
    normalize_plan,
    rewrite_manifests,
    summarise_problems,
    untested_pythons,
    vet_candidate,
    vetting_blocks,
)
from .pypi import PyPIClient
from .risk import RiskInputs, assess, blamed_dist
from .sandbox import EnvInfo, Sandbox
from .usage import find_tool_references, scan_repository
from .workspace import acquire, force_rmtree, fresh_copy, unified_patch

Log = Callable[[str], None]


def _cache_dir() -> Path:
    """Per-user cache shared by runs, so --offline-index can reuse metadata fetched earlier."""
    if env := os.environ.get("DOXOPS_CACHE_DIR"):
        base = Path(env)
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "doxops"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "doxops"
    base.mkdir(parents=True, exist_ok=True)
    return base


@dataclass
class RunOptions:
    target: str
    out_dir: Path
    pythons: list[str] = field(default_factory=lambda: ["3.12", "3.13"])
    llm: StructuredLLM | None = None
    model_info: ModelInfo | None = None
    max_repairs: int = 2
    only: list[str] = field(default_factory=list)
    max_deps: int | None = None
    exclude_dirs: set[str] = field(default_factory=set)
    offline_index: bool = False
    keep_envs: bool = False
    ref: str | None = None
    scan_only: bool = False


@dataclass
class _Baseline:
    tree: Path
    commit: str | None
    runs: list[SuiteRun]
    envs: list[EnvInfo]
    module_to_dist: dict[str, str]


class Pipeline:
    def __init__(self, opts: RunOptions, log: Log = print) -> None:
        self.o = opts
        self.log = log
        self.out = opts.out_dir.resolve()
        self.out.mkdir(parents=True, exist_ok=True)
        self.work = self.out / "work"
        self.work.mkdir(exist_ok=True)
        self.evidence = EvidenceLog(self.out)
        self.sandbox = Sandbox(self.work, self.evidence)
        self.pypi = PyPIClient(_cache_dir() / "pypi-cache.json", offline=opts.offline_index)
        self._commands: dict[str, str] = {}
        self._declared: list[str] = []
        self._reached_after: dict[str, set[tuple[str, int]]] = {}
        self._crashed: dict[str, str] = {}

    # ------------------------------------------------------------------ helpers

    def _envs_and_tests(
        self, tree: Path, label: str, dists: list[str], modules: list[str]
    ) -> tuple[list[EnvInfo], list[SuiteRun]]:
        needs_pytest = True

        def one(py: str) -> tuple[EnvInfo, SuiteRun]:
            env = self.sandbox.create_env(tree, py, label, needs_pytest)
            if env.install_ok:
                env = self.sandbox.introspect(env, tree, dists, modules)
            run = self.sandbox.run_tests(env, tree, label)
            if not self.o.keep_envs and not label.startswith("baseline"):
                shutil.rmtree(env.venv, ignore_errors=True)
            return env, run

        with ThreadPoolExecutor(max_workers=len(self.o.pythons)) as pool:
            results = list(pool.map(one, self.o.pythons))
        return [r[0] for r in results], [r[1] for r in results]

    @staticmethod
    def _module_map(envs: list[EnvInfo]) -> dict[str, str]:
        m2d: dict[str, str] = {}
        for env in envs:
            for module, dists in env.packages_distributions.items():
                if dists and module not in m2d and not module.startswith("_") and "." not in module:
                    m2d[module] = canonicalize_name(dists[0])
        return m2d

    # ------------------------------------------------------------------ stages

    def baseline(self) -> tuple[_Baseline, object, object]:
        o = self.o
        self.log(f"[1/6] Fetching target {o.target}")
        tree, commit = acquire(o.target, self.work / "target", self.evidence, ref=o.ref)
        self.log(f"      commit {commit or 'n/a'}")
        self.log("[2/6] Reading manifests and scanning code (observed)")
        manifest = read_manifests(tree)
        usage = scan_repository(tree, o.exclude_dirs)
        declared = runtime_requirement_names(manifest)
        self.log(
            f"      {len(manifest.requirements)} declarations, {len(usage.sites)} usage sites, "
            f"{len(usage.third_party_top)} third-party imports"
        )
        self.log(f"[3/6] Baseline: installing and running tests on Python {', '.join(o.pythons)} (verified)")
        envs, runs = self._envs_and_tests(tree, "baseline", declared, sorted(usage.third_party_top))
        for run in runs:
            c = run.counts()
            self.log(
                f"      py{run.python}: install {'ok' if run.install_ok else 'FAILED'}, "
                f"{c.get('passed', 0)} passed, {c.get('failed', 0) + c.get('error', 0)} failed"
            )
        m2d = self._module_map(envs)
        commands = {
            script: canonicalize_name(dist)
            for env in envs
            for dist, scripts in env.console_scripts.items()
            if canonicalize_name(dist) in declared
            for script in scripts
        }
        manifest.tool_references = find_tool_references(tree, commands, o.exclude_dirs)
        self._commands = commands
        self._declared = declared
        return _Baseline(tree, commit, runs, envs, m2d), manifest, (usage, commands)

    def run(self) -> RunSummary:
        o = self.o
        base, manifest, extra = self.baseline()
        usage, commands = extra  # type: ignore[misc]
        declared = runtime_requirement_names(manifest)  # type: ignore[arg-type]

        self.log("[4/6] Package-index metadata and risk scoring (observed + verified)")
        pins: dict[str, str | None] = {}
        for req in manifest.requirements:  # type: ignore[attr-defined]
            if not req.commented_out and not req.section.startswith("build-system"):
                pins.setdefault(req.name, req.pinned_version)
                if req.pinned_version and not pins[req.name]:
                    pins[req.name] = req.pinned_version
        for module in usage.third_party_top:
            if dist := base.module_to_dist.get(module):
                pins.setdefault(dist, None)
        metadata = self.pypi.fetch(pins)
        risks = assess(
            RiskInputs(
                manifest=manifest,  # type: ignore[arg-type]
                usage=usage.sites,
                imported_top=usage.imported_top,
                third_party_top=usage.third_party_top,
                module_to_dist=base.module_to_dist,
                metadata=metadata,
                baseline=base.runs,
                tool_references=manifest.tool_references,  # type: ignore[attr-defined]
                tool_commands=commands,
                pythons=o.pythons,
                evidence=self.evidence.items,
            )
        )
        at_risk = [r for r in risks if r.at_risk]
        if o.only:
            wanted = {canonicalize_name(n) for n in o.only}
            at_risk = [r for r in risks if r.name in wanted]
        if o.max_deps:
            at_risk = at_risk[: o.max_deps]
        self.log(f"      {len(at_risk)} of {len(risks)} dependencies selected: {', '.join(r.name for r in at_risk)}")

        capsules: list[DependencyCapsule] = []
        accepted: list[tuple[PlanContext, MigrationPlan]] = []
        for idx, risk in enumerate(at_risk, start=1):
            ctx = self._context(risk, base, manifest, usage, commands, metadata, declared)
            if o.scan_only or o.llm is None:
                capsules.append(self._capsule(ctx, metadata.get(risk.name), [], base))
                continue
            self.log(f"[5/6] ({idx}/{len(at_risk)}) Planning and verifying {risk.name} (score {risk.score})")
            try:
                attempts = self._migrate(ctx, base)
            except Exception as exc:  # keep every other capsule even if one migration crashes
                self._crashed[risk.name] = f"{type(exc).__name__}: {exc}"
                self.log(f"      migration crashed: {self._crashed[risk.name]}")
                attempts = []
            capsules.append(self._capsule(ctx, metadata.get(risk.name), attempts, base))
            best = next((a for a in attempts if a.accepted and a.plan), None)
            if best and best.plan:
                accepted.append((ctx, best.plan))

        selected = {r.name for r in at_risk}
        for risk in risks:  # every flagged dependency gets a capsule, even when this run skipped it
            if risk.at_risk and risk.name not in selected:
                ctx = self._context(risk, base, manifest, usage, commands, metadata, declared)
                capsules.append(self._capsule(ctx, metadata.get(risk.name), [], base))

        combined_runs: list[SuiteRun] = []
        combined_comps: list[Comparison] = []
        combined_patch: str | None = None
        if accepted:
            self.log(f"[6/6] Applying all {len(accepted)} accepted migrations together and re-testing")
            combined_runs, combined_comps, combined_patch = self._combined(accepted, base, declared)

        summary = RunSummary(
            tool="doxops",
            tool_version=__version__,
            generated_at=datetime.now(UTC),
            target=TargetInfo(
                source=o.target,
                path=self._display_path(base.tree) if o.keep_envs else "migrated-repo" if accepted else "-",
                commit=base.commit,
                pythons=o.pythons,
            ),
            model=o.model_info,
            manifest=manifest,  # type: ignore[arg-type]
            baseline=base.runs,
            risks=risks,
            capsules=capsules,
            combined=combined_runs,
            combined_comparisons=combined_comps,
            combined_patch=combined_patch,
            evidence=self.evidence.items,
            llm_calls=o.llm.calls if o.llm else [],
            limitations=self._limitations(capsules, base) + self._combined_notes(combined_comps),
        )
        if not o.keep_envs:  # work/ holds clones, venvs and raw probe files: big and full of host paths
            force_rmtree(self.work)
        return summary

    @staticmethod
    def _inside_function(tree: Path, file: str, line: int) -> bool:
        """True when the line sits in a function body. Module, class-body and decorator lines run on import,
        so the call trace cannot tell whether a test reached them and they are not counted as unreached."""
        try:
            module = ast.parse((tree / file).read_text(encoding="utf-8", errors="replace"))
        except (OSError, SyntaxError, ValueError):
            return True
        for node in ast.walk(module):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                body = node.body if isinstance(node.body, list) else [node.body]
                if body and body[0].lineno <= line <= (node.end_lineno or node.lineno):
                    return True
        return False

    def _display_path(self, path: Path) -> str:
        """Paths inside the output folder are stored relative to it, so reports never leak host paths."""
        try:
            return path.resolve().relative_to(self.out).as_posix()
        except ValueError:
            return path.name

    # ------------------------------------------------------------------ per dependency

    def _context(self, risk, base, manifest, usage, commands, metadata, declared) -> PlanContext:
        modules = set(risk.imported_modules)
        sites: list[UsageSite] = [s for s in usage.sites if s.module in modules]
        for ref in manifest.tool_references:
            if commands.get(ref.tool) == risk.name:
                sites.append(
                    UsageSite(
                        file=ref.source_file,
                        line=ref.line,
                        module=ref.tool,
                        symbol=ref.tool,
                        kind="tool-command",
                        snippet=ref.text,
                    )
                )
        runtime: dict[tuple, RuntimeCall] = {}
        for run in base.runs:
            for call in run.runtime_calls:
                if call.module in modules:
                    key = (call.module, call.function, call.caller_file, call.caller_line)
                    if key not in runtime or runtime[key].count < call.count:
                        runtime[key] = call
        return PlanContext(
            dist=risk.name,
            risk=risk,
            metadata=metadata.get(risk.name),
            declarations=[r for r in manifest.requirements if r.name == risk.name],
            usage=sites,
            runtime=sorted(runtime.values(), key=lambda c: (c.caller_file, c.caller_line)),
            baseline=base.runs,
            pythons=self.o.pythons,
            other_dependencies=[d for d in declared if d != risk.name],
            tree=base.tree,
            requires_python=[c.value for c in manifest.python_constraints if c.kind == "requires-python"],
        )

    def _relevant(self, comps: list[Comparison], ctx: PlanContext) -> list[Comparison]:
        """For repair prompts: regressions and new failures (a module that no longer imports shows up as a new
        ``<collection>`` error) always matter; pre-existing failures only if about this dependency."""
        modules = set(ctx.risk.imported_modules) | {ctx.dist}
        out: list[Comparison] = []
        for comp in comps:
            c = comp.model_copy(deep=True)
            c.deltas = [
                d
                for d in comp.deltas
                if d.change == "regressed"
                or (d.change == "new" and d.after in ("failed", "error"))
                or (d.change == "still-failing" and any(m in d.after_message for m in modules))
            ]
            out.append(c)
        return out

    def _migrate(self, ctx: PlanContext, base: _Baseline) -> list[MigrationAttempt]:
        assert self.o.llm is not None
        attempts: list[MigrationAttempt] = []
        plan: MigrationPlan | None = None
        problems: list[str] = []
        failures: list[str] = []  # tracebacks of the tests the previous attempt broke
        applied_diff = ""  # what DoxOps actually changed for the previous attempt
        for n in range(1, self.o.max_repairs + 2):
            prompt = (
                build_prompt(ctx)
                if plan is None
                else build_repair_prompt(ctx, plan, problems, failures=failures, applied_diff=applied_diff)
            )
            purpose = f"{ctx.dist}-plan" if n == 1 else f"{ctx.dist}-repair{n - 1}"
            new_plan, call = self.o.llm.ask(SYSTEM_PROMPT, prompt, MigrationPlan, purpose, attempt=n)
            attempt = MigrationAttempt(attempt=n, plan=new_plan, llm_call=call)
            attempts.append(attempt)
            if new_plan is None:
                attempt.verdict = f"model gave no usable plan: {call.error}"
                self.log(f"      attempt {n}: {attempt.verdict}")
                if call.error and "invalid output" not in call.error:
                    break  # transport/config problem: re-asking will not help
                continue
            plan = normalize_plan(new_plan, ctx.dist)
            failures, applied_diff = [], ""  # this new plan has not been tested yet
            attempt.plan = plan
            if plan.replacement.strategy == "keep" and not plan.edits:
                attempt.verdict = "model recommends keeping the dependency as is"
                attempt.accepted = False
                break
            attempt.vetting = vet_candidate(plan, ctx, self.pypi)
            blocks = vetting_blocks(attempt.vetting)
            if blocks:
                problems = blocks
                attempt.verdict = "rejected before install: " + "; ".join(blocks)
                self.log(f"      attempt {n}: {attempt.verdict}")
                continue
            tree = fresh_copy(base.tree, self.work / "attempts" / f"{ctx.dist}-{n}")
            try:
                attempt.manifest_changes = rewrite_manifests(plan, ctx, tree)
            except ValueError as exc:  # includes InvalidSpecifier
                problems = [f"could not apply replacement choice: {exc}"]
                attempt.verdict = problems[0]
                continue
            attempt.edits, attempt.syntax_ok = apply_edits(plan, ctx, tree)
            failed_edits = [e for e in attempt.edits if not e.applied and e.error]
            if not attempt.syntax_ok:
                problems = summarise_problems(attempt.edits, [], [], [])
                applied_diff = unified_patch(base.tree, tree)
                attempt.verdict = "edits produced invalid Python"
                self.log(f"      attempt {n}: {attempt.verdict}")
                continue
            installs = plan.replacement.strategy in ("upgrade", "replace", "declare")
            new_pkg = canonicalize_name(plan.replacement.package or ctx.dist) if installs else None
            residual = self._residual_usage(ctx, plan, tree)
            _, runs = self._envs_and_tests(tree, f"{ctx.dist}-{n}", [new_pkg] if new_pkg else [], [])
            attempt.runs = runs
            by_py = {r.python: r for r in base.runs}
            attempt.comparisons = [compare(by_py[r.python], r, base.module_to_dist) for r in runs if r.python in by_py]
            patch = unified_patch(base.tree, tree)
            patch_dir = self.out / "patches"
            patch_dir.mkdir(exist_ok=True)
            patch_path = patch_dir / f"{ctx.dist}-attempt{n}.patch"
            patch_path.write_text(patch, encoding="utf-8", newline="\n")
            attempt.patch_path = patch_path.relative_to(self.out).as_posix()
            install_ok = all(r.install_ok and not r.error for r in runs)
            regressions = sum(c.regressed for c in attempt.comparisons)
            fixed = sum(c.fixed for c in attempt.comparisons)
            new_import_fail = [
                p for r in runs for p in r.import_probes if not p.ok and canonicalize_name(p.distribution) == new_pkg
            ]
            attempt.accepted = (
                install_ok and regressions == 0 and not new_import_fail and not failed_edits and not residual
            )
            attempt.verdict = (
                f"{'ACCEPTED' if attempt.accepted else 'REJECTED'}: install {'ok' if install_ok else 'failed'}, "
                f"{fixed} fixed, {regressions} regressed across {len(runs)} Python version(s), "
                f"{len(failed_edits)} edit(s) not applied"
                + (f", {len(residual)} leftover use(s) of the old dependency" if residual else "")
            )
            self.log(f"      attempt {n}: {attempt.verdict}")
            if attempt.accepted:
                self._reached_after[ctx.dist] = self._reached_sites(ctx, base.tree, tree, runs)
            if not self.o.keep_envs:
                shutil.rmtree(tree, ignore_errors=True)
            if attempt.accepted:
                break
            relevant = self._relevant(attempt.comparisons, ctx)
            problems = summarise_problems(
                attempt.edits,
                runs,
                relevant,
                attempt.vetting.notes if attempt.vetting else [],
            )
            failures = failure_excerpts(runs, relevant)
            applied_diff = patch
        return attempts

    @staticmethod
    def _reached_sites(ctx: PlanContext, before: Path, after: Path, runs: list[SuiteRun]) -> set[tuple[str, int]]:
        """Original usage lines whose (possibly edited) code called into a third-party package during the
        migrated test run. Lines are mapped through the edit diff so shifted code still counts."""
        called = {(c.caller_file, c.caller_line) for r in runs for c in r.runtime_calls}
        reached: set[tuple[str, int]] = set()
        for file in {s.file for s in ctx.usage}:
            old_path, new_path = before / file, after / file
            if not (old_path.is_file() and new_path.is_file()):
                continue
            old_lines = old_path.read_text(encoding="utf-8", errors="replace").splitlines()
            new_lines = new_path.read_text(encoding="utf-8", errors="replace").splitlines()
            line_map: dict[int, list[int]] = {}
            matcher = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)
            for tag, i1, i2, j1, j2 in matcher.get_opcodes():
                for i in range(i1, i2):
                    if tag == "equal":
                        line_map[i + 1] = [j1 + (i - i1) + 1]
                    elif tag == "replace":
                        line_map[i + 1] = list(range(j1 + 1, j2 + 1))
            for site in ctx.usage:
                if site.file == file and any((file, ln) in called for ln in line_map.get(site.line, [])):
                    reached.add((file, site.line))
        return reached

    def _residual_usage(self, ctx: PlanContext, plan: MigrationPlan, tree: Path) -> list[str]:
        """After replace/stdlib/remove, the old dependency must be gone from code and build tooling."""
        if plan.replacement.strategy not in ("replace", "stdlib", "remove"):
            return []
        old = set(ctx.risk.imported_modules)
        leftovers = [
            f"{s.file}:{s.line} still uses {s.module}: `{s.snippet}`"
            for s in scan_repository(tree, self.o.exclude_dirs).sites
            if s.module in old
        ]
        old_cmds = {cmd: d for cmd, d in self._commands.items() if d == ctx.dist}
        leftovers += [
            f"{r.source_file}:{r.line} still calls `{r.tool}` from {ctx.dist}"
            for r in find_tool_references(tree, old_cmds, self.o.exclude_dirs)
        ]
        return leftovers

    def _combined(self, accepted, base: _Baseline, declared: list[str]):
        tree = fresh_copy(base.tree, self.work / "combined")
        notes: list[str] = []
        for ctx, plan in accepted:
            ctx_here = PlanContext(**{**ctx.__dict__, "tree": tree})
            rewrite_manifests(plan, ctx_here, tree)
            outcomes, _ = apply_edits(plan, ctx_here, tree)
            notes += [f"{ctx.dist}: {e.file}: {e.error}" for e in outcomes if not e.applied and e.error]
        new = {canonicalize_name(p.replacement.package or c.dist) for c, p in accepted if p.replacement.package}
        removed = {c.dist for c, p in accepted if p.replacement.strategy in ("stdlib", "remove", "replace")}
        dists = sorted((set(declared) - removed) | new)
        _, runs = self._envs_and_tests(tree, "combined", dists, [])
        by_py = {r.python: r for r in base.runs}
        comps = [compare(by_py[r.python], r, base.module_to_dist) for r in runs if r.python in by_py]
        patch = unified_patch(base.tree, tree)
        (self.out / "patches").mkdir(exist_ok=True)
        (self.out / "patches" / "combined.patch").write_text(patch, encoding="utf-8", newline="\n")
        migrated = self.out / "migrated-repo"
        fresh_copy(tree, migrated)
        if notes:
            (self.out / "patches" / "combined-conflicts.txt").write_text(
                "\n".join(notes), encoding="utf-8", newline="\n"
            )
        return runs, comps, "patches/combined.patch"

    # ------------------------------------------------------------------ capsule assembly

    def _capsule(
        self, ctx: PlanContext, meta: PackageMetadata | None, attempts: list[MigrationAttempt], base: _Baseline
    ) -> DependencyCapsule:
        best = next((a for a in attempts if a.accepted), None)
        last_with_plan = next((a for a in reversed(attempts) if a.plan), None)
        chosen = best or last_with_plan
        plan = chosen.plan if chosen else None
        verified_ids = sorted({r.test_evidence for r in (best.runs if best else []) if r.test_evidence})

        proposed = analysis = rationale = None
        steps: list[Fact] = []
        tests: list[Fact] = []
        gaps: list[Fact] = []
        concerns: list[Fact] = []
        if plan:
            ch = plan.replacement
            target = ch.stdlib_module if ch.strategy == "stdlib" else (ch.package or ctx.dist)
            proposed = Fact(
                text=f"{ch.strategy}: {target or '-'} {ch.version_spec or ''}".strip(),
                provenance=Provenance.VERIFIED if best else Provenance.AI,
                evidence_ids=verified_ids,
            )
            rationale = Fact(text=plan.rationale, provenance=Provenance.AI) if plan.rationale else None
            analysis = Fact(text=plan.analysis, provenance=Provenance.AI)
            steps = [Fact(text=s, provenance=Provenance.AI) for s in plan.migration_steps]
            tests = [Fact(text=s, provenance=Provenance.AI) for s in plan.suggested_tests]
            gaps += [
                Fact(text=f"Model expects: {g}", provenance=Provenance.AI) for g in plan.expected_compatibility_gaps
            ]
        if chosen:
            for comp in chosen.comparisons:
                ev = next((r.test_evidence for r in chosen.runs if r.python == comp.python and r.test_evidence), None)
                for d in comp.deltas:
                    if d.change == "regressed":
                        gaps.append(
                            Fact(
                                text=f"Python {comp.python}: {d.nodeid} passes before but fails after migration "
                                f"[{d.failure_class or 'failure'}] {d.explanation or ''} {d.after_message[:200]}",
                                provenance=Provenance.VERIFIED,
                                evidence_ids=[ev] if ev else [],
                            )
                        )
            for e in chosen.edits:
                if not e.applied and e.error:
                    concerns.append(
                        Fact(
                            text=f"Proposed edit to {e.file} was not applied: {e.error}", provenance=Provenance.OBSERVED
                        )
                    )
            if chosen.vetting:
                for note in chosen.vetting.notes:
                    concerns.append(Fact(text=note, provenance=Provenance.OBSERVED))
        # coverage of the dependency's usage by tests (dynamic vs static)
        static_lines = {
            (s.file, s.line)
            for s in ctx.usage
            if s.kind in ("call", "attribute", "monkeypatch", "private-api")
            and not s.file.startswith("tests/")
            and self._inside_function(base.tree, s.file, s.line)  # module-level lines run on import
        }
        runtime_lines = {(c.caller_file, c.caller_line) for c in ctx.runtime}
        runtime_lines |= self._reached_after.get(ctx.dist, set()) if best else set()
        uncovered = sorted(static_lines - runtime_lines)
        unproven = bool(best and static_lines and len(uncovered) == len(static_lines))
        stdlib = bool(plan and plan.replacement.strategy == "stdlib")
        older = untested_pythons(ctx.requires_python, ctx.pythons) if best and stdlib else []
        if older:
            concerns.append(
                Fact(
                    text=f"The project declares requires-python {', '.join(ctx.requires_python)} but this migration "
                    f"was verified only on Python {', '.join(ctx.pythons)}; the standard-library replacement may not "
                    f"exist on Python {', '.join(older)} (raise requires-python or keep a fallback).",
                    provenance=Provenance.OBSERVED,
                )
            )
            unproven = True
        if static_lines and uncovered:
            run_ids = [r.test_evidence for r in [*base.runs, *(best.runs if best else [])] if r.test_evidence]
            concerns.append(
                Fact(
                    text=f"{len(uncovered)} of {len(static_lines)} code sites using {ctx.dist} were not reached by the "
                    f"test suite before or after migration (e.g. {', '.join(f'{f}:{ln}' for f, ln in uncovered[:4])})"
                    "; tests cannot prove the migration there.",
                    provenance=Provenance.VERIFIED,
                    evidence_ids=run_ids,
                )
            )
        if ctx.dist in self._crashed:
            concerns.append(
                Fact(text=f"The migration run crashed: {self._crashed[ctx.dist]}", provenance=Provenance.OBSERVED)
            )
        elif not attempts:
            concerns.append(
                Fact(
                    text="No migration was attempted in this run (scan-only, AI disabled, or left out by --only / "
                    "--max-deps); re-run with `doxops run --only " + ctx.dist + "`.",
                    provenance=Provenance.OBSERVED,
                )
            )
        elif not best:
            concerns.append(
                Fact(
                    text="No attempt passed verification; the proposal remains unproven.",
                    provenance=Provenance.VERIFIED,
                    evidence_ids=sorted({r.test_evidence for a in attempts for r in a.runs if r.test_evidence}),
                )
            )
        if plan and plan.confidence == "low":
            concerns.append(Fact(text="The model reported low confidence in this plan.", provenance=Provenance.AI))

        if ctx.dist in self._crashed:
            status = "failed"
        elif not attempts:
            status = "not-attempted"
        elif best and not unproven and not self._still_blamed(ctx, best, base):
            status = "verified"
        elif best:
            status = "partially-verified"
        elif plan:
            status = "unverified"
        else:
            status = "failed"
        return DependencyCapsule(
            dependency=ctx.dist,
            declarations=ctx.declarations,
            metadata=meta,
            risk=ctx.risk,
            usage=ctx.usage,
            runtime_usage=ctx.runtime,
            proposed_replacement=proposed,
            rationale=rationale,
            analysis=analysis,
            migration_steps=steps,
            suggested_tests=tests,
            attempts=attempts,
            executed_results=best.comparisons if best else (chosen.comparisons if chosen else []),
            compatibility_gaps=gaps,
            open_concerns=concerns,
            status=status,  # type: ignore[arg-type]
        )

    def _still_blamed(self, ctx: PlanContext, attempt: MigrationAttempt, base: _Baseline) -> list[str]:
        """Tests that failed because of this dependency before and still fail after its migration."""
        declared = set(self._declared)
        blamed = {
            t.nodeid
            for r in base.runs
            for t in r.tests
            if t.outcome in ("failed", "error") and blamed_dist(t, base.module_to_dist, declared) == ctx.dist
        }
        return [
            d.nodeid
            for c in attempt.comparisons
            for d in c.deltas
            if d.change == "still-failing" and d.nodeid in blamed
        ]

    def _combined_notes(self, comps: list[Comparison]) -> list[str]:
        notes = [
            f"Python {c.python}: applying all accepted migrations together regressed {c.regressed} test result(s) "
            "that passed when each migration was applied alone."
            for c in comps
            if c.regressed
        ]
        if (self.out / "patches" / "combined-conflicts.txt").is_file():
            notes.append("Some accepted edits conflicted when combined; see patches/combined-conflicts.txt.")
        return notes

    def _limitations(self, capsules: list[DependencyCapsule], base: _Baseline) -> list[str]:
        lim = [
            "Usage discovery combines static AST analysis with a runtime call trace of the test suite; dynamic imports "
            "(importlib, __import__, plugins loaded by entry points) can still be missed.",
            "Test-based verification is only as strong as the target's test suite: code paths the tests never reach "
            "are reported as open concerns rather than claimed as verified.",
            "Model output is non-deterministic; each AI suggestion stays labelled 'ai' until DoxOps has executed "
            "it, and rejected attempts are kept in the capsule.",
            "Package-index signals (release age, classifiers, deprecation wording, PEP 792 status) are heuristics, not "
            "proof of abandonment.",
            "Security vulnerabilities are out of scope for this challenge and are not scored.",
        ]
        failed_installs = [r.python for r in base.runs if not r.install_ok]
        if failed_installs:
            lim.append(
                f"Baseline installation failed on Python {', '.join(failed_installs)}; comparisons there are limited."
            )
        if any(c.status == "unverified" for c in capsules):
            lim.append("Some proposals could not be verified; they are marked 'unverified' in their capsules.")
        return lim
