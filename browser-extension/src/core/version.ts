// A small PEP 440 subset: enough to order release versions, spot pre-releases, read the major
// number and evaluate requires_python specifiers. Anything unparseable returns null and callers
// treat it as "unknown", exactly like the CLI's InvalidVersion handling.

export interface ParsedVersion {
  epoch: number;
  release: number[];
  pre: [string, number] | null;
  post: number | null;
  dev: number | null;
  local: string | null;
}

const VERSION_RE =
  /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d+)?)?(?:(?:-(\d+))|(?:[-_.]?(post|rev|r)[-_.]?(\d+)?))?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

export function parseVersion(raw: string | null | undefined): ParsedVersion | null {
  if (!raw) return null;
  const m = VERSION_RE.exec(raw);
  if (!m) return null;
  const preTag = m[3]?.toLowerCase();
  let pre: [string, number] | null = null;
  if (preTag) {
    const norm = preTag === "alpha" ? "a" : preTag === "beta" ? "b" : ["c", "pre", "preview"].includes(preTag) ? "rc" : preTag;
    pre = [norm, Number(m[4] ?? 0)];
  }
  let post: number | null = null;
  if (m[5] !== undefined) post = Number(m[5]);
  else if (m[6] !== undefined) post = Number(m[7] ?? 0);
  return {
    epoch: Number(m[1] ?? 0),
    release: m[2]!.split(".").map(Number),
    pre,
    post,
    dev: m[8] !== undefined ? Number(m[9] ?? 0) : null,
    local: m[10] ?? null,
  };
}

export function isPrerelease(v: ParsedVersion): boolean {
  return v.pre !== null || v.dev !== null;
}

export function majorOf(raw: string | null | undefined): number | null {
  const v = parseVersion(raw);
  return v ? v.release[0]! : null;
}

const PRE_ORDER: Record<string, number> = { a: 0, b: 1, rc: 2 };

function cmpRelease(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  const r = cmpRelease(a.release, b.release);
  if (r !== 0) return r;
  // Ordering inside one release: dev < pre < final < post (dev-only releases sort before pre-releases).
  const key = (v: ParsedVersion): number[] => {
    const preRank = v.pre ? [0, PRE_ORDER[v.pre[0]] ?? 0, v.pre[1]] : v.dev !== null && v.post === null ? [-1, 0, 0] : [1, 0, 0];
    return [...preRank, v.post ?? -1, v.dev ?? Number.POSITIVE_INFINITY];
  };
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
  }
  return 0;
}

/** Does `version` satisfy one PEP 440 clause? Returns null when the clause cannot be evaluated. */
function satisfiesClause(version: ParsedVersion, clause: string): boolean | null {
  const m = /^\s*(~=|===|==|!=|<=|>=|<|>)\s*([^\s]+)\s*$/.exec(clause);
  if (!m) return null;
  const op = m[1]!;
  let target = m[2]!;
  if (op === "===") return null;
  if ((op === "==" || op === "!=") && target.endsWith(".*")) {
    target = target.slice(0, -2);
    const t = parseVersion(target);
    if (!t) return null;
    const prefix = version.release.slice(0, t.release.length);
    const padded = [...prefix, ...Array<number>(Math.max(0, t.release.length - prefix.length)).fill(0)];
    const eq = version.epoch === t.epoch && cmpRelease(padded, t.release) === 0;
    return op === "==" ? eq : !eq;
  }
  const t = parseVersion(target);
  if (!t) return null;
  const c = compareVersions(version, t);
  switch (op) {
    case "==":
      return c === 0;
    case "!=":
      return c !== 0;
    case "<=":
      return c <= 0;
    case ">=":
      return c >= 0;
    case "<":
      return c < 0;
    case ">":
      return c > 0;
    case "~=": {
      if (t.release.length < 2) return null;
      const upper = t.release.slice(0, -1);
      const prefix = version.release.slice(0, upper.length);
      return c >= 0 && cmpRelease(prefix, upper) === 0;
    }
    default:
      return null;
  }
}

/**
 * Port of the CLI's python_supported(): true/false when requires_python can be evaluated for
 * "<python>.0", null when it is missing or invalid.
 */
export function pythonSupported(requiresPython: string | null | undefined, python: string): boolean | null {
  if (!requiresPython || !requiresPython.trim()) return null;
  const v = parseVersion(`${python}.0`);
  if (!v) return null;
  for (const clause of requiresPython.split(",")) {
    if (!clause.trim()) continue;
    const ok = satisfiesClause(v, clause);
    if (ok === null) return null;
    if (!ok) return false;
  }
  return true;
}
