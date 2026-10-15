// OBSERVED-only port of doxops/src/doxops/risk.py. Indicator codes, weights, thresholds and
// severity bands are the CLI's, so a browser score is the observed part of the CLI score.
//
// Not ported, because they need code execution or the full source tree:
//   IMPORT_FAILS (40), IMPORT_DEPRECATED (15), TESTS_FAIL (30), RUNTIME_DEPRECATION (10),
//   CONFLICT (20, pip check), TOOL_BROKEN (20)                 -> need installs and test runs
//   UNDECLARED (20), UNUSED (20), PRIVATE_API (15), MONKEYPATCH (10), NO_TIMEOUT (10),
//   MISSING (40)                                               -> need an AST scan of every source file
// risk.py has no hard-coded "known broken" package list, so none is used here either.
// DUPLICATE_DECLARATION is browser-only (the CLI's find_drift only compares different files).

import type { DependencyRisk, ManifestReport, PackageMetadata, RiskIndicator, Severity } from "./types.js";
import { majorOf, parseVersion, pythonSupported, compareVersions } from "./version.js";

export const STALE_YEARS = 3;
export const VERY_STALE_YEARS = 5;
export const AT_RISK_SCORE = 20;
/** The CLI's default verification targets (`--python 3.12 --python 3.13`). */
export const DEFAULT_PYTHONS = ["3.12", "3.13"];
const INACTIVE_STATUSES = new Set(["archived", "deprecated", "quarantined"]);
export const DUPLICATE_WEIGHT = 10;

export function severityFor(score: number): Severity {
  if (score >= 60) return "critical";
  if (score >= 40) return "high";
  if (score >= AT_RISK_SCORE) return "medium";
  if (score > 0) return "low";
  return "none";
}

const SEVERITY_RANK: Record<Severity, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

export function worstSeverity(risks: { severity: Severity }[]): Severity {
  let worst: Severity = "none";
  for (const r of risks) if (SEVERITY_RANK[r.severity] > SEVERITY_RANK[worst]) worst = r.severity;
  return worst;
}

/** Same arithmetic as the CLI: whole days between the dates, divided by 365.25. */
function years(from: Date | null, now: Date): number | null {
  if (!from) return null;
  const days = Math.floor((now.getTime() - from.getTime()) / 86_400_000);
  return days / 365.25;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function observed(code: string, title: string, detail: string, weight: number): RiskIndicator {
  return { code, title, detail, weight, provenance: "observed" };
}

export interface ScoreInputs {
  manifest: ManifestReport;
  metadata: Map<string, PackageMetadata>;
  pythons?: string[];
  now?: Date;
}

export function indicatorsFor(name: string, meta: PackageMetadata | undefined, inputs: ScoreInputs): RiskIndicator[] {
  const now = inputs.now ?? new Date();
  const pythons = inputs.pythons ?? DEFAULT_PYTHONS;
  const ind: RiskIndicator[] = [];

  if (meta && meta.found) {
    if (meta.projectStatus && INACTIVE_STATUSES.has(meta.projectStatus)) {
      ind.push(
        observed(
          "INDEX_STATUS",
          `PyPI marks the project '${meta.projectStatus}' (PEP 792)`,
          "The package index itself flags this project as no longer active.",
          35,
        ),
      );
    }
    if (meta.classifiers.some((c) => c.includes("Development Status :: 7 - Inactive"))) {
      ind.push(observed("INACTIVE_CLASSIFIER", "Maintainers declare it inactive", "Trove classifier 'Development Status :: 7 - Inactive'", 25));
    }
    if (meta.deprecationPhrases.length > 0) {
      ind.push(
        observed("DEPRECATION_NOTICE", "Project page announces deprecation or end of maintenance", meta.deprecationPhrases.slice(0, 2).join(" | "), 20),
      );
    }
    const age = years(meta.latestReleaseAt, now);
    if (age !== null && age >= STALE_YEARS && meta.latestReleaseAt) {
      ind.push(
        observed(
          "STALE_PROJECT",
          `No release for ${age.toFixed(1)} years`,
          `Latest release ${meta.latestVersion ?? "?"} on ${ymd(meta.latestReleaseAt)}`,
          age >= VERY_STALE_YEARS ? 25 : 15,
        ),
      );
    }
    if (meta.pinnedYanked) {
      ind.push(observed("YANKED_PIN", `Pinned version ${meta.pinnedVersion ?? "?"} was yanked`, meta.pinnedYankedReason ?? "no reason given", 30));
    }
    if (meta.pinnedVersion && meta.latestVersion && meta.pinnedVersion !== meta.latestVersion) {
      const pinMajor = majorOf(meta.pinnedVersion);
      const latestMajor = majorOf(meta.latestVersion);
      const behind = pinMajor !== null && latestMajor !== null ? latestMajor - pinMajor : 0;
      const pinAge = years(meta.pinnedReleaseAt, now);
      const ageTxt = pinAge !== null ? `, released ${pinAge.toFixed(1)} years ago` : "";
      ind.push(
        observed(
          "OUTDATED_PIN",
          behind > 0
            ? `Pinned ${meta.pinnedVersion} is ${behind} major version(s) behind ${meta.latestVersion}`
            : `Pinned ${meta.pinnedVersion}, latest is ${meta.latestVersion}`,
          `Exact pin blocks fixes${ageTxt}.`,
          behind >= 2 ? 20 : behind === 1 ? 15 : 5,
        ),
      );
    }
    const rp = meta.pinnedVersion ? meta.pinnedRequiresPython : meta.requiresPython;
    const unsupported = pythons.filter((py) => pythonSupported(rp, py) === false);
    if (unsupported.length > 0) {
      // The CLI emits one per Python and then merges them: one indicator listing every version.
      ind.push(observed("PYTHON_UNSUPPORTED", `Declares no support for Python ${unsupported.join(", ")}`, `requires_python '${rp ?? ""}'`, 20));
    }
    if (meta.pythonClassifiers.length > 0) {
      const top = topClassifier(meta.pythonClassifiers);
      const newest = newestPython(pythons);
      const topV = parseVersion(top);
      const newestV = parseVersion(newest);
      if (/^\d+\.\d+$/.test(top) && topV && newestV && compareVersions(topV, newestV) < 0) {
        ind.push(
          observed("PYTHON_CLASSIFIERS_OLD", `Latest release only advertises Python up to ${top}`, `Target runs Python ${pythons.join(", ")}`, 5),
        );
      }
    }
  } else if (meta && !meta.found && meta.error && meta.error.includes("not found")) {
    ind.push(
      observed(
        "NOT_ON_INDEX",
        "Not found on PyPI",
        "The declared name does not exist on the public index (typo, private package, or removed).",
        30,
      ),
    );
  }

  const drift = inputs.manifest.drift.find((d) => d.name === name);
  if (drift) ind.push(observed("MANIFEST_DRIFT", "Declared with conflicting constraints in different files", drift.description, 15));
  const dup = inputs.manifest.duplicates.find((d) => d.name === name);
  if (dup) ind.push(observed("DUPLICATE_DECLARATION", "Declared twice in one file with different constraints", dup.description, DUPLICATE_WEIGHT));
  return ind;
}

function topClassifier(values: string[]): string {
  // max() with the CLI's key: Version(v) when it looks like "3.x", otherwise Version("0").
  let best = values[0]!;
  let bestV = /^\d+\.\d+$/.test(best) ? parseVersion(best) : parseVersion("0");
  for (const v of values.slice(1)) {
    const pv = /^\d+\.\d+$/.test(v) ? parseVersion(v) : parseVersion("0");
    if (pv && bestV && compareVersions(pv, bestV) > 0) {
      best = v;
      bestV = pv;
    }
  }
  return best;
}

function newestPython(pythons: string[]): string {
  let best = pythons[0] ?? "3.13";
  for (const p of pythons) {
    const a = parseVersion(p);
    const b = parseVersion(best);
    if (a && b && compareVersions(a, b) > 0) best = p;
  }
  return best;
}

/** Each code counts once, at its heaviest weight (the CLI's _dedupe_weights). */
export function scoreOf(indicators: RiskIndicator[]): number {
  const best = new Map<string, number>();
  for (const i of indicators) best.set(i.code, Math.max(best.get(i.code) ?? 0, i.weight));
  let sum = 0;
  for (const w of best.values()) sum += w;
  return Math.min(100, sum);
}

/** Score every runtime-declared dependency, highest score first (ties by name), like the CLI. */
export function assess(inputs: ScoreInputs): DependencyRisk[] {
  const names = [...new Set(inputs.manifest.requirements.map((r) => r.name))].sort();
  const results: DependencyRisk[] = names.map((name) => {
    const decls = inputs.manifest.requirements.filter((r) => r.name === name);
    const meta = inputs.metadata.get(name);
    const indicators = indicatorsFor(name, meta, inputs);
    const score = scoreOf(indicators);
    return {
      name,
      declaredIn: [...new Set(decls.map((d) => `${d.sourceFile}${d.line ? `:${d.line}` : ""}`))],
      pinnedVersion: meta?.pinnedVersion ?? decls.find((d) => d.pinnedVersion)?.pinnedVersion ?? null,
      latestVersion: meta?.latestVersion ?? null,
      score,
      severity: severityFor(score),
      atRisk: score >= AT_RISK_SCORE,
      indicators,
    };
  });
  results.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return results;
}
