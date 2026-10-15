// Defensive reader for a DoxOps capsule.json (doxops/src/doxops/models.py: Capsule / DependencyCapsule).
// Only the fields the extension displays are read; everything is type-checked because the file
// comes from the user's disk and may be truncated, hand-edited, or from another tool.

import { parseRepoUrl } from "./repo.js";
import type { Provenance } from "./types.js";

export const CAPSULE_STATUSES = ["verified", "partially-verified", "unverified", "failed", "not-attempted"] as const;
export type CapsuleStatus = (typeof CAPSULE_STATUSES)[number];
const PROVENANCES: readonly Provenance[] = ["observed", "verified", "ai"];

export interface CapsuleDependency {
  dependency: string;
  status: CapsuleStatus;
  replacement: { text: string; provenance: Provenance } | null;
  rationale: string | null;
  score: number | null;
  severity: string | null;
}

export interface CapsuleSummary {
  source: string;
  commit: string | null;
  generatedAt: string | null;
  pythons: string[];
  dependencies: CapsuleDependency[];
  warnings: string[];
}

export type CapsuleParse = { ok: true; capsule: CapsuleSummary } | { ok: false; error: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export const MAX_CAPSULE_BYTES = 25 * 1024 * 1024;

export function parseCapsule(text: string): CapsuleParse {
  if (text.length > MAX_CAPSULE_BYTES) return { ok: false, error: "File is too large to be a capsule.json (over 25 MB)." };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not valid JSON." };
  }
  const root = obj(data);
  if (!root) return { ok: false, error: "Expected a JSON object at the top level." };
  if (root["tool"] !== "doxops") return { ok: false, error: "Not a DoxOps capsule (missing \"tool\": \"doxops\")." };
  const schema = str(root["schema_version"]);
  if (!schema || !/^1\./.test(schema)) return { ok: false, error: `Unsupported capsule schema_version '${schema ?? "?"}' (expected 1.x).` };
  const target = obj(root["target"]);
  const source = str(target?.["source"]);
  if (!target || !source) return { ok: false, error: "Capsule has no target.source." };
  const capsules = root["capsules"];
  if (!Array.isArray(capsules)) return { ok: false, error: "Capsule has no \"capsules\" list." };

  const warnings: string[] = [];
  const dependencies: CapsuleDependency[] = [];
  capsules.forEach((raw, idx) => {
    const c = obj(raw);
    const dependency = str(c?.["dependency"]);
    const status = str(c?.["status"]);
    if (!c || !dependency || !status || !(CAPSULE_STATUSES as readonly string[]).includes(status)) {
      warnings.push(`capsules[${idx}] skipped: missing dependency or unknown status`);
      return;
    }
    const pr = obj(c["proposed_replacement"]);
    const prText = str(pr?.["text"]);
    const prProv = str(pr?.["provenance"]);
    const replacement =
      pr && prText && prProv && (PROVENANCES as readonly string[]).includes(prProv)
        ? { text: prText, provenance: prProv as Provenance }
        : null;
    if (pr && !replacement) warnings.push(`capsules[${idx}] (${dependency}): malformed proposed_replacement ignored`);
    const risk = obj(c["risk"]);
    dependencies.push({
      dependency,
      status: status as CapsuleStatus,
      replacement,
      rationale: str(obj(c["rationale"])?.["text"]),
      score: typeof risk?.["score"] === "number" ? risk["score"] : null,
      severity: str(risk?.["severity"]),
    });
  });
  const pythons = Array.isArray(target["pythons"]) ? target["pythons"].filter((p): p is string => typeof p === "string") : [];
  return {
    ok: true,
    capsule: {
      source,
      commit: str(target["commit"]),
      generatedAt: str(root["generated_at"]),
      pythons,
      dependencies,
      warnings,
    },
  };
}

/** Does the capsule's target.source name this GitHub repository? Accepts https and git@ forms. */
export function capsuleMatchesRepo(capsule: CapsuleSummary, owner: string, repo: string): boolean {
  let source = capsule.source.trim();
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(source);
  if (ssh) source = `https://github.com/${ssh[1]}/${ssh[2]}`;
  const parsed = parseRepoUrl(source.replace(/\.git\/?$/i, ""));
  return parsed !== null && parsed.owner.toLowerCase() === owner.toLowerCase() && parsed.repo.toLowerCase() === repo.toLowerCase();
}
