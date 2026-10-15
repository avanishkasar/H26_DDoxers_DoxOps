import { canonicalizeName, parseRequirementString, parseRequirementsTxt, truncate } from "./requirements.js";
import { isTable, parseToml, type TomlValue } from "./toml.js";
import type { ManifestDrift, ManifestFile, ManifestReport, Requirement } from "./types.js";

/** Root files the extension reads, in the order the CLI would see them (sorted requirement files first). */
export const MANIFEST_PATHS = ["requirements-dev.txt", "requirements.txt", "pyproject.toml", "setup.py"] as const;

function lineOf(text: string, needle: string): number | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(needle)) return i + 1;
  return null;
}

function strings(value: TomlValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export interface PyprojectResult {
  requirements: Requirement[];
  requiresPython: string | null;
}

/** PEP 621 [project], PEP 735 [dependency-groups] and Poetry [tool.poetry.*dependencies]. */
export function parsePyproject(text: string, sourceFile = "pyproject.toml", warnings: string[] = []): PyprojectResult {
  const { data, errors } = parseToml(text);
  for (const e of errors.slice(0, 5)) warnings.push(`${sourceFile}: ${e}`);
  if (errors.length > 5) warnings.push(`${sourceFile}: ${errors.length - 5} more TOML error(s)`);

  const reqs: Requirement[] = [];
  const add = (items: string[], section: string): void => {
    for (const item of items) {
      const parsed = parseRequirementString(item);
      if (parsed) reqs.push({ ...parsed, sourceFile, line: lineOf(text, item), section });
      else if (!/@|:\/\//.test(item)) warnings.push(`${sourceFile}: could not parse '${truncate(item, 80)}' in ${section}`);
    }
  };

  const project = isTable(data["project"]) ? data["project"] : {};
  add(strings(project["dependencies"]), "project.dependencies");
  const optional = project["optional-dependencies"];
  if (isTable(optional)) {
    for (const [extra, items] of Object.entries(optional)) add(strings(items), `project.optional-dependencies.${extra}`);
  }
  const groups = data["dependency-groups"];
  if (isTable(groups)) {
    for (const [group, items] of Object.entries(groups)) add(strings(items), `dependency-groups.${group}`);
  }

  const tool = isTable(data["tool"]) ? data["tool"] : {};
  const poetry = isTable(tool["poetry"]) ? tool["poetry"] : null;
  let requiresPython = typeof project["requires-python"] === "string" ? project["requires-python"] : null;
  if (poetry) {
    const sections: [string, TomlValue | undefined][] = [
      ["tool.poetry.dependencies", poetry["dependencies"]],
      ["tool.poetry.dev-dependencies", poetry["dev-dependencies"]],
    ];
    const group = poetry["group"];
    if (isTable(group)) {
      for (const [name, g] of Object.entries(group)) {
        if (isTable(g)) sections.push([`tool.poetry.group.${name}.dependencies`, g["dependencies"]]);
      }
    }
    for (const [section, table] of sections) {
      if (!isTable(table)) continue;
      for (const [rawName, constraint] of Object.entries(table)) {
        if (rawName.toLowerCase() === "python") {
          if (!requiresPython && typeof constraint === "string") requiresPython = poetryToPep440(constraint);
          continue;
        }
        const req = poetryRequirement(rawName, constraint, sourceFile, section, text);
        if (req) reqs.push(req);
      }
    }
  }
  return { requirements: reqs, requiresPython };
}

/** Translate a Poetry constraint (^1.2, ~1.2, 1.2.*, 1.2.3, >=1,<2 ...) to a PEP 440 specifier. */
export function poetryToPep440(constraint: string): string | null {
  const parts: string[] = [];
  for (const piece of constraint.split(",")) {
    const c = piece.trim();
    if (!c || c === "*") continue;
    if (c.includes("||")) return null; // alternatives cannot be expressed as one specifier set
    const caret = /^\^\s*(\d+(?:\.\d+)*)$/.exec(c);
    if (caret) {
      const nums = caret[1]!.split(".").map(Number);
      const idx = nums.findIndex((n) => n !== 0);
      const bumpAt = idx < 0 ? nums.length - 1 : idx;
      const upper = nums.slice(0, bumpAt + 1);
      upper[bumpAt] = upper[bumpAt]! + 1;
      parts.push(`>=${caret[1]}`, `<${upper.join(".")}`);
      continue;
    }
    const tilde = /^~(?!=)\s*(\d+(?:\.\d+)*)$/.exec(c);
    if (tilde) {
      const nums = tilde[1]!.split(".").map(Number);
      const upper = nums.length >= 2 ? nums.slice(0, 2) : nums.slice(0, 1);
      upper[upper.length - 1] = upper[upper.length - 1]! + 1;
      parts.push(`>=${tilde[1]}`, `<${upper.join(".")}`);
      continue;
    }
    if (/^\d[\w.*+!-]*$/.test(c)) {
      parts.push(`==${c}`);
      continue;
    }
    const op = /^(~=|===|==|!=|<=|>=|<|>)\s*(\S+)$/.exec(c);
    if (!op) return null;
    parts.push(`${op[1]}${op[2]}`);
  }
  return parts.join(",");
}

function poetryRequirement(
  rawName: string,
  constraint: TomlValue,
  sourceFile: string,
  section: string,
  text: string,
): Requirement | null {
  let version: string | null = null;
  let extras: string[] = [];
  let marker: string | null = null;
  const pick = Array.isArray(constraint) ? constraint.find(isTable) ?? null : constraint;
  if (typeof pick === "string") version = pick;
  else if (isTable(pick)) {
    if ("git" in pick || "path" in pick || "url" in pick) return null; // VCS / local / URL source
    version = typeof pick["version"] === "string" ? pick["version"] : "*";
    extras = strings(pick["extras"]);
    marker = typeof pick["markers"] === "string" ? pick["markers"] : null;
  } else return null;
  const spec = poetryToPep440(version);
  if (spec === null) return null;
  const clauses = spec ? spec.split(",").sort() : [];
  const single = clauses.length === 1 ? /^(==|===)([^*]+)$/.exec(clauses[0]!) : null;
  return {
    name: canonicalizeName(rawName),
    raw: `${rawName} = ${typeof constraint === "string" ? JSON.stringify(constraint) : "{...}"}`,
    specifier: clauses.join(","),
    pinnedVersion: single ? single[2]! : null,
    extras: extras.sort(),
    marker,
    sourceFile,
    line: lineOf(text, rawName),
    section,
  };
}

/** Best effort: the literal list passed to install_requires= (directly or through a module-level name). */
export function parseSetupPy(text: string, sourceFile = "setup.py", warnings: string[] = []): Requirement[] {
  let body: string | null = null;
  const direct = /install_requires\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (direct) body = direct[1]!;
  else {
    const named = /install_requires\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
    if (named) {
      const assign = new RegExp(`^${named[1]}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m").exec(text);
      if (assign) body = assign[1]!;
    }
  }
  if (body === null) {
    if (/install_requires/.test(text)) warnings.push(`${sourceFile}: install_requires is computed at runtime; not read`);
    return [];
  }
  const out: Requirement[] = [];
  const literal = /(['"])((?:\\.|(?!\1).)*?)\1/g;
  for (const m of body.matchAll(literal)) {
    const item = m[2]!;
    const parsed = parseRequirementString(item);
    if (parsed) out.push({ ...parsed, sourceFile, line: lineOf(text, item), section: "install_requires" });
  }
  return out;
}

/** Same rule as the CLI's find_drift: one name, several files, different constraints. */
export function findDrift(requirements: Requirement[]): ManifestDrift[] {
  const byName = groupByName(requirements);
  const drift: ManifestDrift[] = [];
  for (const [name, decls] of [...byName.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const files = new Set(decls.map((d) => d.sourceFile));
    const specs = new Set(decls.map((d) => d.specifier));
    if (files.size > 1 && specs.size > 1) {
      drift.push({ name, declarations: decls, description: `${name} is declared with different constraints: ${describe(decls)}` });
    }
  }
  return drift;
}

/** Browser-only check: the same file and section declares a name twice with different constraints. */
export function findDuplicates(requirements: Requirement[]): ManifestDrift[] {
  const out: ManifestDrift[] = [];
  const byKey = new Map<string, Requirement[]>();
  for (const r of requirements) {
    const key = `${r.name}\u0000${r.sourceFile}\u0000${r.section}`;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  for (const decls of byKey.values()) {
    if (decls.length > 1 && new Set(decls.map((d) => d.specifier)).size > 1) {
      out.push({
        name: decls[0]!.name,
        declarations: decls,
        description: `${decls[0]!.name} is declared ${decls.length} times in ${decls[0]!.sourceFile}: ${describe(decls)}`,
      });
    }
  }
  return out;
}

function describe(decls: Requirement[]): string {
  return decls.map((d) => `${d.sourceFile}:${d.line ?? "?"} '${d.specifier || "any"}'`).join(", ");
}

function groupByName(requirements: Requirement[]): Map<string, Requirement[]> {
  const m = new Map<string, Requirement[]>();
  for (const r of requirements) m.set(r.name, [...(m.get(r.name) ?? []), r]);
  return m;
}

/** Parse whichever manifests were found. Unknown paths are ignored. */
export function readManifests(files: ManifestFile[]): ManifestReport {
  const warnings: string[] = [];
  const requirements: Requirement[] = [];
  let requiresPython: string | null = null;
  const sorted = [...files].sort((a, b) => MANIFEST_PATHS.indexOf(a.path as never) - MANIFEST_PATHS.indexOf(b.path as never));
  for (const f of sorted) {
    if (/(^|\/)requirements[^/]*\.txt$/.test(f.path)) requirements.push(...parseRequirementsTxt(f.text, f.path, warnings));
    else if (f.path.endsWith("pyproject.toml")) {
      const r = parsePyproject(f.text, f.path, warnings);
      requirements.push(...r.requirements);
      requiresPython = r.requiresPython;
    } else if (f.path.endsWith("setup.py")) requirements.push(...parseSetupPy(f.text, f.path, warnings));
  }
  return {
    requirements,
    drift: findDrift(requirements),
    duplicates: findDuplicates(requirements),
    filesRead: sorted.map((f) => f.path),
    requiresPython,
    warnings,
  };
}

/** Distinct names, first pinned version wins (same rule as the CLI pipeline's pin selection). */
export function pinsByName(requirements: Requirement[]): Map<string, string | null> {
  const pins = new Map<string, string | null>();
  for (const r of requirements) {
    if (!pins.has(r.name)) pins.set(r.name, r.pinnedVersion);
    else if (r.pinnedVersion && !pins.get(r.name)) pins.set(r.name, r.pinnedVersion);
  }
  return pins;
}

