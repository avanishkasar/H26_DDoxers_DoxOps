/**
 * Pure logic for the DoxOps extension: no `vscode` imports, so it can be unit-tested with node:test.
 *
 * It turns the CLI's `capsule.json` (a RunSummary) into a typed model, and holds every rule the UI
 * relies on: ordering, severity mapping, provenance labels, path mapping, patch selection and the
 * wording of diagnostics and confirmations.
 */

export type Provenance = "observed" | "verified" | "ai";
export type Severity = "none" | "low" | "medium" | "high" | "critical";
export type CapsuleStatus = "verified" | "partially-verified" | "unverified" | "not-attempted" | "failed";
export type DiagnosticLevel = "error" | "warning" | "information";
export type SeverityIcon = "error" | "warning" | "info" | "pass";
export type ResultsKind = "scan" | "run";

export interface Fact {
  readonly text: string;
  readonly provenance: Provenance;
  readonly evidenceIds: readonly string[];
}

export interface Indicator {
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly weight: number;
  readonly provenance: Provenance;
  readonly evidenceIds: readonly string[];
}

export interface Risk {
  readonly score: number;
  readonly severity: Severity;
  readonly atRisk: boolean;
  readonly indicators: readonly Indicator[];
}

export interface Declaration {
  readonly name: string;
  readonly raw: string;
  readonly sourceFile: string;
  readonly line: number | null;
  readonly commentedOut: boolean;
}

export interface UsageSite {
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly module: string;
  readonly symbol: string | null;
  readonly kind: string;
  readonly snippet: string;
  readonly provenance: Provenance;
}

export interface Comparison {
  readonly python: string;
  readonly fixed: number;
  readonly regressed: number;
  readonly stillFailing: number;
  readonly stillPassing: number;
  readonly added: number;
  readonly removed: number;
}

export interface Attempt {
  readonly attempt: number;
  readonly accepted: boolean;
  readonly verdict: string;
  readonly patchPath: string | null;
  /** The model's proposal as "strategy: package spec"; always AI output until verified. */
  readonly proposal: string | null;
  readonly confidence: string | null;
  readonly comparisons: readonly Comparison[];
}

export interface Capsule {
  readonly dependency: string;
  readonly status: CapsuleStatus;
  readonly risk: Risk;
  readonly declarations: readonly Declaration[];
  readonly usage: readonly UsageSite[];
  readonly proposedReplacement: Fact | null;
  readonly analysis: Fact | null;
  readonly rationale: Fact | null;
  readonly migrationSteps: readonly Fact[];
  readonly attempts: readonly Attempt[];
  readonly executedResults: readonly Comparison[];
  readonly compatibilityGaps: readonly Fact[];
  readonly openConcerns: readonly Fact[];
}

export interface RunSummary {
  readonly kind: ResultsKind;
  readonly toolVersion: string;
  readonly generatedAt: string;
  readonly targetSource: string;
  readonly targetCommit: string | null;
  readonly pythons: readonly string[];
  readonly model: { readonly provider: string; readonly model: string } | null;
  readonly capsules: readonly Capsule[];
  readonly combinedPatch: string | null;
  /** Test comparison of the original against every accepted migration applied together. */
  readonly combinedResults: readonly Comparison[];
  readonly limitations: readonly string[];
}

export class CapsuleFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapsuleFormatError";
  }
}

// ------------------------------------------------------------------------------------------ parsing

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === "string");
}

const PROVENANCES: readonly Provenance[] = ["observed", "verified", "ai"];
const SEVERITIES: readonly Severity[] = ["none", "low", "medium", "high", "critical"];
const STATUSES: readonly CapsuleStatus[] = ["verified", "partially-verified", "unverified", "not-attempted", "failed"];

function asProvenance(value: unknown): Provenance {
  // Anything unknown is treated as the least trusted label.
  return PROVENANCES.find((p) => p === value) ?? "ai";
}

function asSeverity(value: unknown): Severity {
  return SEVERITIES.find((s) => s === value) ?? "none";
}

function asStatus(value: unknown): CapsuleStatus {
  return STATUSES.find((s) => s === value) ?? "unverified";
}

function parseFact(value: unknown): Fact | null {
  if (!isObject(value) || typeof value["text"] !== "string") {
    return null;
  }
  return {
    text: value["text"],
    provenance: asProvenance(value["provenance"]),
    evidenceIds: asStringArray(value["evidence_ids"]),
  };
}

function parseFacts(value: unknown): Fact[] {
  return asArray(value)
    .map(parseFact)
    .filter((f): f is Fact => f !== null);
}

function parseIndicator(value: unknown): Indicator | null {
  if (!isObject(value) || typeof value["code"] !== "string") {
    return null;
  }
  return {
    code: value["code"],
    title: asString(value["title"], value["code"]),
    detail: asString(value["detail"]),
    weight: asNumber(value["weight"]),
    provenance: asProvenance(value["provenance"]),
    evidenceIds: asStringArray(value["evidence_ids"]),
  };
}

function parseComparison(value: unknown): Comparison | null {
  if (!isObject(value)) {
    return null;
  }
  return {
    python: asString(value["python"], "?"),
    fixed: asNumber(value["fixed"]),
    regressed: asNumber(value["regressed"]),
    stillFailing: asNumber(value["still_failing"]),
    stillPassing: asNumber(value["still_passing"]),
    added: asNumber(value["new"]),
    removed: asNumber(value["removed"]),
  };
}

function parseComparisons(value: unknown): Comparison[] {
  return asArray(value)
    .map(parseComparison)
    .filter((c): c is Comparison => c !== null);
}

function describeProposal(plan: unknown): { proposal: string | null; confidence: string | null } {
  if (!isObject(plan)) {
    return { proposal: null, confidence: null };
  }
  const replacement = plan["replacement"];
  let proposal: string | null = null;
  if (isObject(replacement)) {
    const strategy = asString(replacement["strategy"], "?");
    const target = asNullableString(replacement["package"]) ?? asNullableString(replacement["stdlib_module"]);
    const spec = asNullableString(replacement["version_spec"]);
    proposal = [strategy + ":", target, spec].filter((p): p is string => p !== null).join(" ");
  }
  return { proposal, confidence: asNullableString(plan["confidence"]) };
}

function parseAttempt(value: unknown, index: number): Attempt | null {
  if (!isObject(value)) {
    return null;
  }
  const { proposal, confidence } = describeProposal(value["plan"]);
  return {
    attempt: asPositiveInt(value["attempt"]) ?? index + 1,
    accepted: value["accepted"] === true,
    verdict: asString(value["verdict"]),
    patchPath: asNullableString(value["patch_path"]),
    proposal,
    confidence,
    comparisons: parseComparisons(value["comparisons"]),
  };
}

function parseDeclaration(value: unknown): Declaration | null {
  if (!isObject(value) || typeof value["source_file"] !== "string") {
    return null;
  }
  return {
    name: asString(value["name"]),
    raw: asString(value["raw"]),
    sourceFile: value["source_file"],
    line: asPositiveInt(value["line"]),
    commentedOut: value["commented_out"] === true,
  };
}

function parseUsage(value: unknown): UsageSite | null {
  if (!isObject(value) || typeof value["file"] !== "string") {
    return null;
  }
  const line = asPositiveInt(value["line"]);
  if (line === null) {
    return null;
  }
  return {
    file: value["file"],
    line,
    col: Math.max(0, Math.trunc(asNumber(value["col"]))),
    module: asString(value["module"]),
    symbol: asNullableString(value["symbol"]),
    kind: asString(value["kind"], "usage"),
    snippet: asString(value["snippet"]),
    provenance: asProvenance(value["provenance"]),
  };
}

function parseCapsule(value: unknown, index: number): Capsule {
  if (!isObject(value)) {
    throw new CapsuleFormatError(`capsules[${index}] is not an object`);
  }
  const dependency = value["dependency"];
  if (typeof dependency !== "string" || dependency.length === 0) {
    throw new CapsuleFormatError(`capsules[${index}] has no dependency name`);
  }
  const risk = value["risk"];
  if (!isObject(risk)) {
    throw new CapsuleFormatError(`capsule '${dependency}' has no risk section`);
  }
  const severity = asSeverity(risk["severity"]);
  return {
    dependency,
    status: asStatus(value["status"]),
    risk: {
      score: asNumber(risk["score"]),
      severity,
      atRisk: typeof risk["at_risk"] === "boolean" ? risk["at_risk"] : severity !== "none",
      indicators: asArray(risk["indicators"])
        .map(parseIndicator)
        .filter((i): i is Indicator => i !== null),
    },
    declarations: asArray(value["declarations"])
      .map(parseDeclaration)
      .filter((d): d is Declaration => d !== null),
    usage: asArray(value["usage"])
      .map(parseUsage)
      .filter((u): u is UsageSite => u !== null),
    proposedReplacement: parseFact(value["proposed_replacement"]),
    analysis: parseFact(value["analysis"]),
    rationale: parseFact(value["rationale"]),
    migrationSteps: parseFacts(value["migration_steps"]),
    attempts: asArray(value["attempts"])
      .map(parseAttempt)
      .filter((a): a is Attempt => a !== null),
    executedResults: parseComparisons(value["executed_results"]),
    compatibilityGaps: parseFacts(value["compatibility_gaps"]),
    openConcerns: parseFacts(value["open_concerns"]),
  };
}

/** Parse the text of `capsule.json`. Throws CapsuleFormatError when it is not a DoxOps run summary. */
export function parseSummary(text: string): RunSummary {
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new CapsuleFormatError(`capsule.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(data)) {
    throw new CapsuleFormatError("capsule.json is not a JSON object");
  }
  if (!Array.isArray(data["capsules"])) {
    throw new CapsuleFormatError("capsule.json has no 'capsules' list; is this a DoxOps output folder?");
  }
  const schemaVersion = data["schema_version"];
  if (schemaVersion !== undefined && schemaVersion !== "1.0") {
    throw new CapsuleFormatError(`unsupported capsule schema_version ${JSON.stringify(schemaVersion)} (expected "1.0")`);
  }
  const capsules = data["capsules"].map(parseCapsule);
  const target = isObject(data["target"]) ? data["target"] : {};
  const modelRaw = data["model"];
  const model = isObject(modelRaw)
    ? { provider: asString(modelRaw["provider"], "?"), model: asString(modelRaw["model"], "?") }
    : null;
  const combinedPatch = asNullableString(data["combined_patch"]);
  const anyAttempt = capsules.some((c) => c.attempts.length > 0);
  return {
    kind: model === null && !anyAttempt && combinedPatch === null ? "scan" : "run",
    toolVersion: asString(data["tool_version"], "?"),
    generatedAt: asString(data["generated_at"]),
    targetSource: asString(target["source"]),
    targetCommit: asNullableString(target["commit"]),
    pythons: asStringArray(target["pythons"]),
    model,
    capsules,
    combinedPatch,
    combinedResults: parseComparisons(data["combined_comparisons"]),
    limitations: asStringArray(data["limitations"]),
  };
}

// ------------------------------------------------------------------------------------------ ranking

/** Highest risk first; ties broken by name so the order is stable. */
export function sortCapsules(capsules: readonly Capsule[]): Capsule[] {
  return [...capsules].sort((a, b) => b.risk.score - a.risk.score || a.dependency.localeCompare(b.dependency));
}

export function diagnosticLevel(severity: Severity): DiagnosticLevel | null {
  switch (severity) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
      return "information";
    case "none":
      return null;
  }
}

export function severityIcon(severity: Severity): SeverityIcon {
  switch (severity) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
      return "info";
    case "none":
      return "pass";
  }
}

export function provenanceLabel(provenance: Provenance): "OBSERVED" | "VERIFIED" | "AI" {
  switch (provenance) {
    case "observed":
      return "OBSERVED";
    case "verified":
      return "VERIFIED";
    case "ai":
      return "AI";
  }
}

/** "[VERIFIED E020, E021]" style badge; evidence ids make a VERIFIED label checkable. */
export function provenanceBadge(fact: { provenance: Provenance; evidenceIds: readonly string[] }): string {
  const label = provenanceLabel(fact.provenance);
  return fact.evidenceIds.length > 0 ? `[${label} ${fact.evidenceIds.join(", ")}]` : `[${label}]`;
}

/** The indicator that contributes most to the score (verified beats observed beats AI on a tie). */
export function topIndicator(capsule: Capsule): Indicator | null {
  const rank: Record<Provenance, number> = { verified: 2, observed: 1, ai: 0 };
  let best: Indicator | null = null;
  for (const ind of capsule.risk.indicators) {
    if (
      best === null ||
      ind.weight > best.weight ||
      (ind.weight === best.weight && rank[ind.provenance] > rank[best.provenance])
    ) {
      best = ind;
    }
  }
  return best;
}

export function isAtRisk(capsule: Capsule): boolean {
  return capsule.risk.atRisk && capsule.risk.severity !== "none";
}

export interface ResultsCounts {
  readonly atRisk: number;
  readonly verified: number;
  readonly partiallyVerified: number;
  readonly applicable: number;
}

export function countResults(summary: RunSummary): ResultsCounts {
  let atRisk = 0;
  let verified = 0;
  let partiallyVerified = 0;
  let applicable = 0;
  for (const c of summary.capsules) {
    if (isAtRisk(c)) {
      atRisk += 1;
    }
    if (c.status === "verified") {
      verified += 1;
    } else if (c.status === "partially-verified") {
      partiallyVerified += 1;
    }
    if (selectPatch(c).ok) {
      applicable += 1;
    }
  }
  return { atRisk, verified, partiallyVerified, applicable };
}

export function statusBarText(summary: RunSummary): string {
  const counts = countResults(summary);
  return `$(shield) DoxOps: ${counts.atRisk} at risk · ${counts.verified} verified`;
}

// ------------------------------------------------------------------------------------------ paths

export interface PathContext {
  /** Absolute path of the workspace folder that was scanned. */
  readonly workspaceRoot: string;
  /** Absolute home directory, used to expand the "~" redaction. */
  readonly homeDir: string;
  /** True on Windows and macOS default file systems. */
  readonly caseInsensitive: boolean;
}

function toSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function isAbsoluteLike(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

/** Collapse "." segments; returns null on any ".." so a capsule can never point outside its root. */
function cleanRelative(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      return null;
    }
    parts.push(seg);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function stripRoot(absolute: string, root: string, caseInsensitive: boolean): string | null {
  const a = toSlashes(absolute);
  const r = toSlashes(root).replace(/\/+$/, "");
  const aCmp = caseInsensitive ? a.toLowerCase() : a;
  const rCmp = caseInsensitive ? r.toLowerCase() : r;
  if (aCmp.startsWith(rCmp + "/")) {
    return a.slice(r.length + 1);
  }
  return null;
}

/** Folders inside a DoxOps output directory whose contents mirror the target repository. */
const REPO_MIRRORS: readonly RegExp[] = [
  /^work\/target\//,
  /^work\/combined\//,
  /^work\/attempts\/[^/]+\//,
  /^migrated-repo\//,
];

/**
 * Map a path recorded in a capsule onto the scanned workspace folder.
 *
 * Capsule paths are relative to the target repository root, but may also be written with the
 * "<out>" or "~" redactions, point into the output folder's mirrors of the repository
 * ("migrated-repo/...", "<out>/work/target/..."), be absolute, or use Windows separators.
 * Returns a clean POSIX path relative to the workspace root, or null when the path does not
 * belong to the workspace. The caller still has to check that the file exists.
 */
export function mapCapsulePath(raw: string, ctx: PathContext): string | null {
  let p = toSlashes(raw.trim());
  if (p.length === 0 || p.includes("\0")) {
    return null;
  }
  if (p === "~" || p.startsWith("~/")) {
    p = toSlashes(ctx.homeDir).replace(/\/+$/, "") + p.slice(1);
  }
  if (p === "<out>" || p.startsWith("<out>/")) {
    const rest = p.slice("<out>/".length);
    const mirror = REPO_MIRRORS.find((re) => re.test(rest));
    return mirror ? cleanRelative(rest.replace(mirror, "")) : null;
  }
  if (isAbsoluteLike(p)) {
    const rel = stripRoot(p, ctx.workspaceRoot, ctx.caseInsensitive);
    return rel === null ? null : cleanRelative(rel);
  }
  if (p.startsWith("./")) {
    p = p.slice(2);
  }
  const mirror = REPO_MIRRORS.find((re) => re.test(p));
  if (mirror) {
    p = p.replace(mirror, "");
  }
  return cleanRelative(p);
}

/**
 * Resolve a path recorded relative to the DoxOps output folder (patch_path, combined_patch).
 * Accepts "patches/x.patch" and "<out>/patches/x.patch"; refuses absolute paths and "..".
 */
export function outputRelativePath(raw: string): string | null {
  let p = toSlashes(raw.trim());
  if (p.startsWith("<out>/")) {
    p = p.slice("<out>/".length);
  }
  if (p.length === 0 || isAbsoluteLike(p) || p.startsWith("~") || p.includes("\0")) {
    return null;
  }
  return cleanRelative(p);
}

const MANIFEST_PATTERNS: readonly RegExp[] = [
  /^requirements.*\.txt$/i,
  /^pyproject\.toml$/i,
  /^setup\.py$/i,
  /^setup\.cfg$/i,
  /^Pipfile$/,
];

export function isManifestFile(fileName: string): boolean {
  const base = toSlashes(fileName).split("/").pop() ?? "";
  return MANIFEST_PATTERNS.some((re) => re.test(base));
}

/** PEP 503 name normalisation. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * 1-based line on which `dependency` is declared in a manifest's text, or null.
 * Handles requirements files, pyproject/setup.py string lists and Pipfile keys.
 */
export function findDeclarationLine(text: string, dependency: string): number | null {
  const wanted = normalizeName(dependency);
  const lines = text.split(/\r?\n/);
  const leading = /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/;
  const quoted = /["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@,"']|$)/g;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const lead = leading.exec(line);
    if (lead && lead[1] !== undefined && normalizeName(lead[1]) === wanted) {
      const after = line.slice(lead[0].length).trimStart();
      // A requirement name is followed by a specifier, extras, marker, separator or nothing.
      if (after === "" || /^(?:[<>=!~;@,\["'#]|\\)/.test(after)) {
        return i + 1;
      }
    }
    quoted.lastIndex = 0;
    for (let m = quoted.exec(line); m !== null; m = quoted.exec(line)) {
      if (m[1] !== undefined && normalizeName(m[1]) === wanted) {
        return i + 1;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------ patches

export const APPLICABLE_STATUSES: readonly CapsuleStatus[] = ["verified", "partially-verified"];

export type PatchSelection =
  | { readonly ok: true; readonly attempt: Attempt; readonly patchPath: string }
  | { readonly ok: false; readonly reason: string };

/** The patch DoxOps accepted for this dependency, if it is allowed to be applied. */
export function selectPatch(capsule: Capsule): PatchSelection {
  if (!APPLICABLE_STATUSES.includes(capsule.status)) {
    return {
      ok: false,
      reason: `${capsule.dependency} is '${capsule.status}'; only verified or partially-verified fixes can be applied`,
    };
  }
  const accepted = capsule.attempts.filter((a) => a.accepted && a.patchPath !== null);
  const attempt = accepted[accepted.length - 1];
  if (attempt === undefined || attempt.patchPath === null) {
    return { ok: false, reason: `${capsule.dependency} has no accepted attempt with a patch` };
  }
  const patchPath = outputRelativePath(attempt.patchPath);
  if (patchPath === null) {
    return { ok: false, reason: `the patch path '${attempt.patchPath}' is not inside the DoxOps output folder` };
  }
  return { ok: true, attempt, patchPath };
}

export type CombinedSelection =
  | { readonly ok: true; readonly patchPath: string; readonly included: readonly Capsule[] }
  | { readonly ok: false; readonly reason: string };

/**
 * combined.patch holds every accepted migration. It may only be applied when each dependency it
 * contains is verified or partially-verified, the combined test run regressed nothing, and no
 * accepted edit was dropped because it conflicted (`conflicts` is patches/combined-conflicts.txt).
 */
export function selectCombinedPatch(summary: RunSummary, conflicts: string | null = null): CombinedSelection {
  if (summary.combinedPatch === null) {
    return {
      ok: false,
      reason:
        summary.kind === "scan"
          ? "these are scan-only results; run 'DoxOps: Run with Gemma 4' to get verified patches"
          : "this run has no combined patch (no migration was accepted)",
    };
  }
  const patchPath = outputRelativePath(summary.combinedPatch);
  if (patchPath === null) {
    return { ok: false, reason: `the combined patch path '${summary.combinedPatch}' is not inside the DoxOps output folder` };
  }
  const withAccepted = summary.capsules.filter((c) => c.attempts.some((a) => a.accepted));
  const blocked = withAccepted.filter((c) => !APPLICABLE_STATUSES.includes(c.status));
  if (blocked.length > 0) {
    const names = blocked.map((c) => `${c.dependency} (${c.status})`).join(", ");
    return { ok: false, reason: `combined.patch includes changes that are not verified: ${names}. Apply verified fixes one by one instead.` };
  }
  if (withAccepted.length === 0) {
    return { ok: false, reason: "no dependency has an accepted migration" };
  }
  const regressed = summary.combinedResults.filter((r) => r.regressed > 0);
  if (regressed.length > 0) {
    const where = regressed.map((r) => `Python ${r.python}: ${r.regressed} regressed`).join(", ");
    return {
      ok: false,
      reason: `applying all migrations together regressed tests (${where}) [VERIFIED]. Apply verified fixes one by one instead`,
    };
  }
  if (conflicts !== null && conflicts.trim().length > 0) {
    return {
      ok: false,
      reason: `some accepted edits conflicted and were left out of combined.patch (patches/combined-conflicts.txt: ${truncate(conflicts, 240)}). Apply verified fixes one by one instead`,
    };
  }
  return { ok: true, patchPath, included: sortCapsules(withAccepted) };
}

export function applyAllConfirmationDetail(summary: RunSummary, included: readonly Capsule[], files: readonly string[]): string {
  const lines: string[] = ["Dependencies in combined.patch:"];
  for (const c of included) {
    const repl = c.proposedReplacement ? `${c.proposedReplacement.text} ${provenanceBadge(c.proposedReplacement)}` : "(no replacement recorded)";
    lines.push(`- ${c.dependency} [${c.status.toUpperCase()}]: ${repl}`);
  }
  if (summary.combinedResults.length > 0) {
    lines.push("", "All migrations together:");
    for (const r of summary.combinedResults) {
      lines.push(`  ${describeComparison(r)} [VERIFIED]`);
    }
  }
  const partial = included.filter((c) => c.status === "partially-verified");
  if (partial.length > 0) {
    lines.push("", "Partially verified, open concerns:");
    for (const c of partial) {
      for (const f of c.openConcerns) {
        lines.push(`- ${c.dependency}: ${f.text} ${provenanceBadge(f)}`);
      }
    }
  }
  if (files.length > 0) {
    lines.push("", `Changes ${files.length} file(s): ${files.join(", ")}`);
  }
  lines.push("", "VERIFIED = proven by commands DoxOps executed; OBSERVED = read from files or PyPI; AI = model output not proven on its own.");
  return lines.join("\n");
}

/** Files touched by a unified git diff, from its "diff --git a/X b/Y" headers. */
export function patchFiles(patchText: string): string[] {
  const files = new Set<string>();
  for (const m of patchText.matchAll(/^diff --git a\/(\S+) b\/(\S+)\s*$/gm)) {
    if (m[2] !== undefined) {
      files.add(m[2]);
    }
  }
  return [...files];
}

/**
 * Files git will touch, from the "Checking patch <path>..." lines of `git apply --check -v`. Unlike
 * patchFiles() this also covers sections without a "diff --git" header, which git applies too.
 * `prefix` is the --directory value, stripped so paths stay relative to the workspace folder.
 */
export function checkedPatchPaths(gitOutput: string, prefix = ""): string[] {
  const files = new Set<string>();
  const strip = prefix.length > 0 ? `${prefix.replace(/\/+$/, "")}/` : "";
  for (const m of gitOutput.matchAll(/^Checking patch (.+?)\.\.\.\s*$/gm)) {
    let name = m[1] ?? "";
    const arrow = name.indexOf(" => ");
    if (arrow >= 0) {
      name = name.slice(arrow + " => ".length);
    }
    if (strip.length > 0 && name.startsWith(strip)) {
      name = name.slice(strip.length);
    }
    if (name.length > 0) {
      files.add(name);
    }
  }
  return [...files];
}

export interface HunkShape {
  /** Context lines before the first added or removed line. */
  readonly leading: number;
  /** Context lines after the last added or removed line. */
  readonly trailing: number;
  readonly added: number;
  readonly removed: number;
}

/** Shape of every hunk in a unified diff. */
export function patchHunks(patchText: string): HunkShape[] {
  const hunks: HunkShape[] = [];
  const lines = patchText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i] ?? "");
    if (!header) {
      continue;
    }
    let oldLeft = header[1] === undefined ? 1 : Number(header[1]);
    let newLeft = header[2] === undefined ? 1 : Number(header[2]);
    const kinds: string[] = [];
    while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
      const line = lines[i + 1] ?? "";
      const tag = line.charAt(0);
      if (tag === "\\") {
        i += 1;
        continue;
      }
      if (tag === "+") {
        newLeft -= 1;
      } else if (tag === "-") {
        oldLeft -= 1;
      } else if (tag === " " || line.length === 0) {
        oldLeft -= 1;
        newLeft -= 1;
      } else {
        break;
      }
      kinds.push(tag === "+" || tag === "-" ? tag : " ");
      i += 1;
    }
    const first = kinds.findIndex((k) => k !== " ");
    const last = kinds.length - 1 - [...kinds].reverse().findIndex((k) => k !== " ");
    hunks.push({
      leading: first < 0 ? kinds.length : first,
      trailing: first < 0 ? 0 : kinds.length - 1 - last,
      added: kinds.filter((k) => k === "+").length,
      removed: kinds.filter((k) => k === "-").length,
    });
  }
  return hunks;
}

/**
 * Whether a patch may be retried with reduced context (git apply -C1). A hunk made only of added
 * lines has no context to anchor it, so git would place it by line number alone.
 */
export function reducedContextAllowed(patchText: string): boolean {
  const hunks = patchHunks(patchText);
  return hunks.length > 0 && hunks.every((h) => !(h.removed === 0 && h.leading === 0 && h.trailing === 0));
}

/**
 * Whether a reverse check with reduced context proves the patch is already applied: only when every
 * hunk adds lines, because those lines must then be present next to their context. A hunk that only
 * removes lines would match its bare context whether or not it was applied.
 */
export function reducedReverseCheckConclusive(patchText: string): boolean {
  const hunks = patchHunks(patchText);
  return hunks.length > 0 && hunks.every((h) => h.added > 0);
}

/** Lines of `git apply -v` output that mean a file was silently skipped (path outside the cwd). */
export function skippedPatchPaths(gitOutput: string): string[] {
  return [...gitOutput.matchAll(/^Skipped patch '([^']+)'/gm)].map((m) => m[1] ?? "").filter((s) => s.length > 0);
}

export function describeComparison(c: Comparison): string {
  return `Python ${c.python}: ${c.fixed} fixed, ${c.regressed} regressed, ${c.stillFailing} still failing, ${c.stillPassing} still passing`;
}

/** Text of the modal shown before a single-dependency patch is applied. */
export function applyConfirmationDetail(capsule: Capsule, selection: { attempt: Attempt; patchPath: string }, files: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`Dependency: ${capsule.dependency} (risk ${capsule.risk.score}, ${capsule.risk.severity})`);
  lines.push(`Status: ${capsule.status.toUpperCase()}`);
  if (capsule.proposedReplacement) {
    lines.push(`Replacement: ${capsule.proposedReplacement.text} ${provenanceBadge(capsule.proposedReplacement)}`);
  } else if (selection.attempt.proposal) {
    lines.push(`Replacement: ${selection.attempt.proposal} [AI]`);
  }
  lines.push(`Accepted attempt #${selection.attempt.attempt}: ${selection.attempt.verdict} [VERIFIED]`);
  for (const c of capsule.executedResults) {
    lines.push(`  ${describeComparison(c)} [VERIFIED]`);
  }
  if (capsule.analysis) {
    lines.push(`Analysis: ${truncate(capsule.analysis.text, 240)} ${provenanceBadge(capsule.analysis)}`);
  }
  lines.push(`Patch: ${selection.patchPath}`);
  if (files.length > 0) {
    lines.push(`Changes ${files.length} file(s): ${files.join(", ")}`);
  }
  if (capsule.status === "partially-verified" && capsule.openConcerns.length > 0) {
    lines.push("");
    lines.push("Open concerns (not proven by the tests):");
    for (const f of capsule.openConcerns) {
      lines.push(`- ${f.text} ${provenanceBadge(f)}`);
    }
  }
  lines.push("");
  lines.push("VERIFIED = proven by commands DoxOps executed; OBSERVED = read from files or PyPI; AI = model output not proven on its own.");
  return lines.join("\n");
}

export function partialWarningDetail(capsule: Capsule): string {
  const concerns = capsule.openConcerns.length > 0 ? capsule.openConcerns : capsule.compatibilityGaps;
  const lines = [
    `The fix for ${capsule.dependency} is only PARTIALLY VERIFIED: the tests passed, but these points are not proven:`,
    ...concerns.map((f) => `- ${f.text} ${provenanceBadge(f)}`),
  ];
  if (concerns.length === 0) {
    lines.push("- (no concerns were recorded; treat untested code paths as unverified)");
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------ diagnostics

const USAGE_KIND_TO_INDICATOR: Readonly<Record<string, string>> = {
  "no-timeout": "NO_TIMEOUT",
  "private-api": "PRIVATE_API",
  monkeypatch: "MONKEYPATCH",
  "tool-command": "TOOL_BROKEN",
};

const SITE_SPECIFIC_CODES = new Set(Object.values(USAGE_KIND_TO_INDICATOR));

export interface UsageExplanation {
  readonly indicator: Indicator;
  /** True when the indicator is about this very site (names its file:line or matches its kind). */
  readonly specific: boolean;
}

/**
 * Whether `text` names the location `file:line` exactly: "a.py:1" does not match "a.py:14" or
 * "xa.py:1", but does match "/abs/path/a.py:1" and "a.py:1:5".
 */
export function mentionsLocation(text: string, loc: string): boolean {
  if (loc.length === 0) {
    return false;
  }
  for (let at = text.indexOf(loc); at >= 0; at = text.indexOf(loc, at + 1)) {
    const before = at > 0 ? text.charAt(at - 1) : "";
    const after = text.charAt(at + loc.length);
    if (!/[A-Za-z0-9_.-]/.test(before) && !/[0-9]/.test(after)) {
      return true;
    }
  }
  return false;
}

/**
 * The indicator that best explains one usage site: one naming its file:line, then one matching its
 * kind (no-timeout, private-api, ...), else the heaviest indicator about the dependency as a whole.
 */
export function usageIndicator(capsule: Capsule, site: UsageSite): UsageExplanation | null {
  const loc = `${toSlashes(site.file)}:${site.line}`;
  const byLocation = capsule.risk.indicators.find((i) => mentionsLocation(i.detail, loc) || mentionsLocation(i.title, loc));
  if (byLocation) {
    return { indicator: byLocation, specific: true };
  }
  const code = USAGE_KIND_TO_INDICATOR[site.kind];
  const byKind = code ? capsule.risk.indicators.find((i) => i.code === code) : undefined;
  if (byKind) {
    return { indicator: byKind, specific: true };
  }
  const general = capsule.risk.indicators.filter((i) => !SITE_SPECIFIC_CODES.has(i.code));
  const top = topIndicator({ ...capsule, risk: { ...capsule.risk, indicators: general.length > 0 ? general : capsule.risk.indicators } });
  return top ? { indicator: top, specific: false } : null;
}

export interface DiagnosticSpec {
  readonly message: string;
  readonly code: string;
  readonly level: DiagnosticLevel;
}

export function declarationDiagnostic(capsule: Capsule): DiagnosticSpec | null {
  const level = diagnosticLevel(capsule.risk.severity);
  if (level === null || !isAtRisk(capsule)) {
    return null;
  }
  const top = topIndicator(capsule);
  const reason = top ? `${top.title} [${provenanceLabel(top.provenance)}]` : "no indicator recorded";
  return {
    message: `DoxOps: ${capsule.dependency} at risk (score ${capsule.risk.score}): ${reason}`,
    code: top?.code ?? "AT_RISK",
    level,
  };
}

export function usageDiagnostic(capsule: Capsule, site: UsageSite): DiagnosticSpec | null {
  const level = diagnosticLevel(capsule.risk.severity);
  if (level === null || !isAtRisk(capsule)) {
    return null;
  }
  const explained = usageIndicator(capsule, site);
  const what = site.symbol ? `${site.kind} of ${site.symbol}` : site.kind;
  let reason = "at-risk dependency";
  if (explained) {
    const ind = explained.indicator;
    const detail = explained.specific && ind.detail ? ` (${truncate(ind.detail, 160)})` : "";
    reason = `${ind.title}${detail} [${provenanceLabel(ind.provenance)}]`;
  }
  return {
    message: `DoxOps: ${capsule.dependency} ${what} here [${provenanceLabel(site.provenance)}]: ${reason}`,
    code: explained?.indicator.code ?? "AT_RISK",
    level,
  };
}

/** Dependency name from a DoxOps diagnostic message ("DoxOps: <dep> ..."). */
export function dependencyFromMessage(message: string): string | null {
  const m = /^DoxOps: ([A-Za-z0-9][A-Za-z0-9._-]*) /.exec(message);
  return m && m[1] !== undefined ? m[1] : null;
}

/** One entry per file:line so repeated symbols on an import line produce one diagnostic. */
export function uniqueUsageSites(sites: readonly UsageSite[]): UsageSite[] {
  const seen = new Map<string, UsageSite>();
  const rank = (s: UsageSite): number => (USAGE_KIND_TO_INDICATOR[s.kind] ? 1 : 0);
  for (const s of sites) {
    const key = `${toSlashes(s.file)}:${s.line}`;
    const prev = seen.get(key);
    if (prev === undefined || rank(s) > rank(prev)) {
      seen.set(key, s);
    }
  }
  return [...seen.values()];
}

// ------------------------------------------------------------------------------------------ CLI

export interface CliSettings {
  readonly provider: "ollama" | "gemini";
  readonly model: string;
  readonly pythons: readonly string[];
  readonly maxDeps: number;
}

export function validPythons(pythons: readonly string[]): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of pythons) {
    const v = p.trim();
    if (/^\d+\.\d+$/.test(v)) {
      if (!valid.includes(v)) {
        valid.push(v);
      }
    } else {
      invalid.push(p);
    }
  }
  return { valid, invalid };
}

function pythonArgs(pythons: readonly string[]): string[] {
  return validPythons(pythons).valid.flatMap((p) => ["--python", p]);
}

export function buildScanArgs(target: string, outDir: string, settings: CliSettings): string[] {
  return ["scan", target, "--out", outDir, ...pythonArgs(settings.pythons)];
}

export function buildRunArgs(target: string, outDir: string, settings: CliSettings): string[] {
  const args = ["run", target, "--out", outDir, "--provider", settings.provider];
  const model = settings.model.trim();
  if (model.length > 0) {
    args.push("--model", model);
  }
  args.push(...pythonArgs(settings.pythons));
  if (Number.isFinite(settings.maxDeps) && settings.maxDeps >= 1) {
    args.push("--max-deps", String(Math.floor(settings.maxDeps)));
  }
  return args;
}

export function buildDoctorArgs(settings: CliSettings): string[] {
  const args = ["doctor", "--provider", settings.provider];
  const model = settings.model.trim();
  if (model.length > 0) {
    args.push("--model", model);
  }
  return [...args, ...pythonArgs(settings.pythons)];
}

/** Workspace-local places the CLI is commonly installed, in the order they are tried. */
export function workspaceExecutableCandidates(workspaceRoot: string, platform: string): string[] {
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const sep = platform === "win32" ? "\\" : "/";
  const join = (...parts: string[]): string => [root, ...parts].join(sep);
  const venvs = [
    ["doxops", ".venv"],
    [".venv"],
  ];
  const out: string[] = [];
  for (const v of venvs) {
    if (platform === "win32") {
      out.push(join(...v, "Scripts", "doxops.exe"));
    }
    out.push(join(...v, "bin", "doxops"));
  }
  return out;
}

/**
 * Folder names the CLI never copies when it snapshots the target (workspace.COPY_IGNORE). An
 * output folder inside the scanned workspace must sit under one of them, or the CLI's copy of the
 * workspace would recurse into its own output.
 */
export const COPY_IGNORED_OUTPUT_DIRS: readonly string[] = ["doxops-out", ".doxops"];

/**
 * Whether an output folder, given relative to the scanned workspace folder ("" is the folder
 * itself), is safe for the CLI. Paths outside the workspace ("../x") are always safe.
 */
export function outputDirInsideWorkspaceIsSafe(relative: string): boolean {
  const parts = toSlashes(relative)
    .split("/")
    .filter((p) => p.length > 0 && p !== ".");
  if (parts.length === 0) {
    return false;
  }
  if (parts[0] === "..") {
    return true;
  }
  return parts.some((p) => COPY_IGNORED_OUTPUT_DIRS.includes(p));
}

/** "20261015-083012" (local time), the CLI's own folder naming. */
export function runTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Remove values that must never reach a log, e.g. an API key echoed by a child process. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 6) {
      out = out.split(s).join("***");
    }
  }
  return out;
}

/**
 * Redacts a stream that arrives in chunks. A secret split across two chunks is still caught: the
 * last (longest secret - 1) characters are held back until the next chunk or flush().
 */
export class StreamRedactor {
  private carry = "";
  private readonly secrets: readonly string[];
  private readonly hold: number;

  constructor(secrets: readonly string[]) {
    this.secrets = secrets.filter((s) => s.length >= 6);
    this.hold = this.secrets.reduce((max, s) => Math.max(max, s.length - 1), 0);
  }

  /** Text that is safe to emit now. */
  push(chunk: string): string {
    const text = redactSecrets(stripAnsi(this.carry + chunk), this.secrets);
    const cut = Math.max(0, text.length - this.hold);
    this.carry = text.slice(cut);
    return text.slice(0, cut);
  }

  /** Everything still held back; call once the stream has ended. */
  flush(): string {
    const rest = redactSecrets(stripAnsi(this.carry), this.secrets);
    this.carry = "";
    return rest;
  }
}

// ------------------------------------------------------------------------------------------ report

export function buildCsp(cspSource: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    "script-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Put our CSP first in <head>. A CSP already in the page stays: browsers enforce every policy
 * present, so the page can only become stricter, never looser, than ours.
 */
export function injectCsp(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + "\n" + meta + html.slice(at);
  }
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + `\n<head>${meta}</head>` + html.slice(at);
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)) + "…";
}

// ------------------------------------------------------------------------------------------ targets

export type ScanTarget =
  | { readonly kind: "workspace" }
  | { readonly kind: "github"; readonly owner: string; readonly repo: string; readonly cloneUrl: string }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "invalid"; readonly reason: string };

const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/**
 * What the user typed in the DoxOps panel: empty means the open workspace, a GitHub repository
 * URL (https, optionally ending in .git or a /tree/... path) means clone it, and an absolute
 * path means that folder on disk. Anything else is rejected rather than guessed.
 */
export function parseTarget(input: string): ScanTarget {
  const text = input.trim();
  if (text.length === 0) {
    return { kind: "workspace" };
  }
  const gh = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/[^\s]*)?\/?(?:[#?][^\s]*)?$/i.exec(text);
  if (gh) {
    const owner = gh[1] ?? "";
    const repo = gh[2] ?? "";
    if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo) || repo === "." || repo === "..") {
      return { kind: "invalid", reason: `"${text}" is not a valid GitHub repository URL.` };
    }
    return { kind: "github", owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return { kind: "invalid", reason: "Only GitHub repository URLs (https://github.com/owner/repo) can be cloned." };
  }
  const isAbsolute = text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\");
  if (!isAbsolute) {
    return { kind: "invalid", reason: "Enter a GitHub URL (https://github.com/owner/repo) or an absolute folder path." };
  }
  return { kind: "path", path: text };
}

/** Folder name used for a clone kept in the extension's storage. */
export function cloneFolderName(owner: string, repo: string): string {
  return `${owner}__${repo}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

export interface PanelDependency {
  readonly name: string;
  readonly score: number;
  readonly severity: Severity;
  readonly status: CapsuleStatus;
  readonly reason: string;
  readonly reasonLabel: string;
  readonly replacement: string;
  readonly replacementLabel: string;
  readonly applicable: boolean;
}

export interface PanelSummary {
  readonly kind: ResultsKind;
  readonly target: string;
  readonly model: string;
  readonly pythons: readonly string[];
  readonly analysed: number;
  readonly atRisk: number;
  readonly verified: number;
  readonly partiallyVerified: number;
  readonly unverified: number;
  readonly applicable: number;
  readonly fixedTogether: number | null;
  readonly regressedTogether: number | null;
  readonly dependencies: readonly PanelDependency[];
}

/** A plain, JSON-safe digest of the results for the DoxOps panel (it renders text only). */
export function panelSummary(summary: RunSummary): PanelSummary {
  const counts = countResults(summary);
  const dependencies = sortCapsules(summary.capsules)
    .filter((c) => isAtRisk(c))
    .map((c): PanelDependency => {
      const top = topIndicator(c);
      return {
        name: c.dependency,
        score: c.risk.score,
        severity: c.risk.severity,
        status: c.status,
        reason: top ? top.title : "",
        reasonLabel: top ? provenanceLabel(top.provenance) : "",
        replacement: c.proposedReplacement ? c.proposedReplacement.text : "",
        replacementLabel: c.proposedReplacement ? provenanceLabel(c.proposedReplacement.provenance) : "",
        applicable: selectPatch(c).ok,
      };
    });
  const combined = summary.combinedResults;
  return {
    kind: summary.kind,
    target: summary.targetSource,
    model: summary.model ? `${summary.model.model} via ${summary.model.provider}` : "",
    pythons: summary.pythons,
    analysed: summary.capsules.length,
    atRisk: counts.atRisk,
    verified: counts.verified,
    partiallyVerified: counts.partiallyVerified,
    unverified: summary.capsules.filter((c) => c.status === "unverified" || c.status === "failed").length,
    applicable: counts.applicable,
    fixedTogether: combined.length > 0 ? Math.max(...combined.map((r) => r.fixed)) : null,
    regressedTogether: combined.length > 0 ? Math.max(...combined.map((r) => r.regressed)) : null,
    dependencies,
  };
}
