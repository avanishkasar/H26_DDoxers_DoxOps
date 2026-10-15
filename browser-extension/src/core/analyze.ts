import { fetchManifests, probeRepository } from "./github.js";
import type { HttpOptions } from "./http.js";
import { pinsByName, readManifests } from "./manifests.js";
import { PyPIClient, toMetadata } from "./pypi.js";
import { assess, DEFAULT_PYTHONS, worstSeverity } from "./risk.js";
import type { AnalysisResult, PackageMetadata, RepoRef } from "./types.js";

export interface AnalyzeOptions extends HttpOptions {
  pypi?: PyPIClient;
  pythons?: string[];
  now?: () => Date;
}

/** At most this many distinct packages are looked up per repository (protects PyPI and the worker). */
export const MAX_PACKAGES = 150;

function base(target: RepoRef, ref: string, now: Date, pythons: string[]): AnalysisResult {
  return {
    owner: target.owner,
    repo: target.repo,
    ref,
    status: "ok",
    message: null,
    filesRead: [],
    dependencyCount: 0,
    atRiskCount: 0,
    worstSeverity: "none",
    risks: [],
    indexErrors: [],
    warnings: [],
    pythonTargets: pythons,
    analyzedAt: now.toISOString(),
  };
}

/** Full browser scan of one repository: manifests -> PyPI metadata -> OBSERVED risk scores. */
export async function analyzeRepository(target: RepoRef, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const now = (opts.now ?? (() => new Date()))();
  const pythons = opts.pythons ?? DEFAULT_PYTHONS;
  const fetched = await fetchManifests(target.owner, target.repo, target.ref, opts);
  const result = base(target, fetched.ref, now, pythons);
  result.warnings.push(...fetched.notes, ...fetched.errors.map((e) => `Could not read ${e}`));

  if (fetched.files.length === 0) {
    if (fetched.errors.length > 0 && !fetched.allMissing) {
      result.status = "error";
      result.message = `Could not read the repository's manifests (${fetched.errors.join("; ")}). Try again later.`;
      return result;
    }
    const probe = await probeRepository(target.owner, target.repo, opts);
    if (probe.kind === "missing-or-private") {
      result.status = "private-or-missing";
      result.message =
        "This repository is private or does not exist. The browser scan only reads public files; run DoxOps locally on a clone instead.";
    } else {
      result.status = "no-python-manifests";
      const lang = probe.kind === "public" && probe.language ? ` (main language: ${probe.language})` : "";
      result.message = `No requirements.txt, requirements-dev.txt, pyproject.toml or setup.py at the repository root${lang}. Nothing to scan.`;
    }
    return result;
  }

  const manifest = readManifests(fetched.files);
  result.filesRead = manifest.filesRead;
  result.warnings.push(...manifest.warnings);
  const pins = pinsByName(manifest.requirements);
  if (pins.size === 0) {
    result.status = "no-python-manifests";
    result.message = `Read ${manifest.filesRead.join(", ")} but found no installable dependencies declared in them.`;
    return result;
  }

  const client = opts.pypi ?? new PyPIClient(opts);
  const names = [...pins.keys()];
  if (names.length > MAX_PACKAGES) {
    result.warnings.push(`Only the first ${MAX_PACKAGES} of ${names.length} dependencies were looked up on PyPI.`);
  }
  const metadata = new Map<string, PackageMetadata>();
  await Promise.all(
    names.slice(0, MAX_PACKAGES).map(async (name) => {
      const lookup = await client.lookup(name);
      const meta = toMetadata(name, pins.get(name) ?? null, lookup);
      if (lookup.kind === "error") result.indexErrors.push(`${name}: ${lookup.error}`);
      metadata.set(name, meta);
    }),
  );
  result.indexErrors.sort();

  result.risks = assess({ manifest, metadata, pythons, now });
  result.dependencyCount = result.risks.length;
  result.atRiskCount = result.risks.filter((r) => r.atRisk).length;
  result.worstSeverity = worstSeverity(result.risks);
  if (result.indexErrors.length > 0) {
    result.message = `PyPI could not be reached for ${result.indexErrors.length} package(s); their scores only use repository data.`;
  }
  return result;
}
