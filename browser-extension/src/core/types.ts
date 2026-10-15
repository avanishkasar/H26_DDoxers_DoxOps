// Shared data model for the browser scan. Field names follow the DoxOps CLI capsule
// (doxops/src/doxops/models.py) where an equivalent exists, in camelCase.

export type Severity = "none" | "low" | "medium" | "high" | "critical";

/** The browser can only read, so every indicator it produces is OBSERVED. */
export type Provenance = "observed" | "verified" | "ai";

export interface RepoRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit from the page URL; null means the default branch (HEAD). */
  ref: string | null;
}

export interface Requirement {
  /** PEP 503 normalised distribution name. */
  name: string;
  raw: string;
  /** Normalised specifier list, e.g. ">=1.2,<2" (sorted, comma separated, no spaces). */
  specifier: string;
  pinnedVersion: string | null;
  extras: string[];
  marker: string | null;
  sourceFile: string;
  line: number | null;
  section: string;
}

export interface ManifestDrift {
  name: string;
  declarations: Requirement[];
  description: string;
}

export interface ManifestFile {
  path: string;
  text: string;
}

export interface ManifestReport {
  requirements: Requirement[];
  drift: ManifestDrift[];
  /** Same file + same section declares a package twice with different constraints. */
  duplicates: ManifestDrift[];
  filesRead: string[];
  requiresPython: string | null;
  /** Problems found while parsing (malformed TOML, unreadable lines). Never fatal. */
  warnings: string[];
}

/** One release, reduced to what the CLI reads from its files. */
export interface ReleaseSummary {
  fileCount: number;
  /** Earliest upload time of the release's files (ISO 8601). */
  firstUpload: string | null;
  /** True when the release has files and every file is yanked. */
  allYanked: boolean;
  yankedReason: string | null;
  requiresPython: string | null;
}

/** Compact, cacheable view of https://pypi.org/pypi/<name>/json plus the Simple API status. */
export interface ProjectInfo {
  name: string;
  infoVersion: string | null;
  summary: string | null;
  /** First 2000 characters of the long description (enough for deprecation phrases). */
  descriptionHead: string | null;
  requiresPython: string | null;
  classifiers: string[];
  releases: Record<string, ReleaseSummary>;
  projectStatus: string | null;
}

export type ProjectLookup =
  | { kind: "found"; info: ProjectInfo }
  | { kind: "not-found" }
  | { kind: "error"; error: string };

/** Mirrors the CLI's PackageMetadata. */
export interface PackageMetadata {
  name: string;
  found: boolean;
  latestVersion: string | null;
  latestReleaseAt: Date | null;
  pinnedVersion: string | null;
  pinnedReleaseAt: Date | null;
  pinnedYanked: boolean;
  pinnedYankedReason: string | null;
  requiresPython: string | null;
  pinnedRequiresPython: string | null;
  classifiers: string[];
  pythonClassifiers: string[];
  projectStatus: string | null;
  summary: string | null;
  deprecationPhrases: string[];
  error: string | null;
}

export interface RiskIndicator {
  code: string;
  title: string;
  detail: string;
  weight: number;
  provenance: Provenance;
}

export interface DependencyRisk {
  name: string;
  declaredIn: string[];
  pinnedVersion: string | null;
  latestVersion: string | null;
  score: number;
  severity: Severity;
  atRisk: boolean;
  indicators: RiskIndicator[];
}

export type AnalysisStatus = "ok" | "no-python-manifests" | "private-or-missing" | "error";

export interface AnalysisResult {
  owner: string;
  repo: string;
  /** Ref the manifests were actually read from ("HEAD" = default branch). */
  ref: string;
  status: AnalysisStatus;
  /** Human readable explanation for any non-"ok" status, or notes for "ok". */
  message: string | null;
  filesRead: string[];
  dependencyCount: number;
  atRiskCount: number;
  worstSeverity: Severity;
  risks: DependencyRisk[];
  /** Packages whose index lookup failed (network/timeout/rate limit); scored without index data. */
  indexErrors: string[];
  warnings: string[];
  pythonTargets: string[];
  analyzedAt: string;
}
