import type { Requirement } from "./types.js";

/** PEP 503 name normalisation (same as packaging.utils.canonicalize_name). */
export function canonicalizeName(name: string): string {
  return name.trim().replace(/[-_.]+/g, "-").toLowerCase();
}

const NAME_RE = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[([^\]]*)\])?\s*(.*)$/s;
const CLAUSE_RE = /^(~=|===|==|!=|<=|>=|<|>)\s*([A-Za-z0-9*+!._-]+)$/;
const SKIP_PREFIXES = ["-", "http://", "https://", "file:", "git+", "hg+", "svn+", "bzr+", ".", "/", "\\"];

export interface ParsedRequirement {
  name: string;
  raw: string;
  specifier: string;
  pinnedVersion: string | null;
  extras: string[];
  marker: string | null;
}

/**
 * Parse one PEP 508 requirement string. Returns null for anything that is not a plain index
 * requirement: options (-r, -e, --hash ...), local paths, VCS and URL requirements (including
 * "name @ url" direct references) and malformed lines.
 */
export function parseRequirementString(input: string): ParsedRequirement | null {
  const candidate = input.trim();
  if (!candidate) return null;
  const lower = candidate.toLowerCase();
  if (SKIP_PREFIXES.some((p) => lower.startsWith(p))) return null;
  if (/^[a-z]:[\\/]/i.test(candidate)) return null; // Windows path

  const m = NAME_RE.exec(candidate);
  if (!m) return null;
  const name = m[1]!;
  const extras = (m[2] ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (extras.some((e) => !/^[A-Za-z0-9._-]+$/.test(e))) return null;
  let rest = m[3]!.trim();

  let marker: string | null = null;
  const semi = rest.indexOf(";");
  if (semi >= 0) {
    marker = rest.slice(semi + 1).trim() || null;
    rest = rest.slice(0, semi).trim();
  }
  if (rest.startsWith("@")) return null; // direct URL reference
  if (rest.startsWith("(") && rest.endsWith(")")) rest = rest.slice(1, -1).trim();

  const clauses: string[] = [];
  if (rest) {
    for (const part of rest.split(",")) {
      const clause = part.trim();
      const cm = CLAUSE_RE.exec(clause);
      if (!cm) return null;
      clauses.push(`${cm[1]}${cm[2]}`);
    }
  }
  clauses.sort();
  let pinnedVersion: string | null = null;
  if (clauses.length === 1) {
    const only = CLAUSE_RE.exec(clauses[0]!)!;
    // Wildcard pins (==1.*) are ranges, not pins.
    if ((only[1] === "==" || only[1] === "===") && !only[2]!.includes("*")) pinnedVersion = only[2]!;
  }
  return {
    name: canonicalizeName(name),
    raw: candidate,
    specifier: clauses.join(","),
    pinnedVersion,
    extras: extras.sort(),
    marker,
  };
}

/**
 * Parse a requirements*.txt file. Comments, blank lines, options and includes (-r/-c) are
 * ignored, backslash continuations are joined, trailing "--hash=..." options are dropped and
 * VCS/URL/path requirements are skipped. Malformed lines are reported in `warnings`.
 */
export function parseRequirementsTxt(
  text: string,
  sourceFile: string,
  warnings: string[] = [],
): Requirement[] {
  const out: Requirement[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let buffer = "";
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (!buffer) startLine = i + 1;
    if (/\\\s*$/.test(line) && i < lines.length - 1) {
      buffer += line.replace(/\\\s*$/, " ");
      continue;
    }
    line = buffer + line;
    buffer = "";
    let stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    // Inline comment: pip requires whitespace before '#'.
    stripped = stripped.split(/\s#/, 1)[0]!.trim();
    // Per-requirement options (--hash, --global-option ...) follow the requirement.
    stripped = stripped.split(/\s--?[a-z]/i, 1)[0]!.trim();
    if (!stripped || stripped.startsWith("-")) continue;
    const parsed = parseRequirementString(stripped);
    if (!parsed) {
      const lower = stripped.toLowerCase();
      const intentionallySkipped =
        SKIP_PREFIXES.some((p) => lower.startsWith(p)) || /\s@\s|^[a-z0-9._-]+@/i.test(stripped) || /:\/\//.test(stripped);
      if (!intentionallySkipped) warnings.push(`${sourceFile}:${startLine}: could not parse '${truncate(stripped, 80)}'`);
      continue;
    }
    out.push({ ...parsed, sourceFile, line: startLine, section: "requirements" });
  }
  return out;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
