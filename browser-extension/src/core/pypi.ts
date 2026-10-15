// PyPI reader, ported from doxops/src/doxops/pypi.py: release history, yanks, PEP 792 project
// status (Simple API JSON), Python support, and deprecation phrases on the project page.

import { HttpError, httpGet, type HttpOptions } from "./http.js";
import type { PackageMetadata, ProjectInfo, ProjectLookup, ReleaseSummary } from "./types.js";
import { compareVersions, isPrerelease, parseVersion, type ParsedVersion } from "./version.js";

export const INDEX = "https://pypi.org";
export const CACHE_TTL_MS = 60 * 60 * 1000;

const DEPRECATION_PATTERNS = [
  String.raw`\bno longer (?:being )?maintained\b`,
  String.raw`\bunmaintained\b`,
  String.raw`\bnot (?:actively )?maintained\b`,
  String.raw`\bthis (?:project|package|library) is deprecated\b`,
  String.raw`\bdeprecated in favou?r of\b`,
  String.raw`\bis deprecated\b`,
  String.raw`\bend[- ]of[- ]life\b`,
  String.raw`\bsuperseded by\b`,
  String.raw`\bhas been archived\b`,
  String.raw`\bis archived\b`,
  String.raw`\babandoned\b`,
  String.raw`\buse [\w.-]+ instead\b`,
];
const DEPRECATION_RE = new RegExp(DEPRECATION_PATTERNS.join("|"), "gi");

/** Phrases in the summary or the top of the long description that announce end of life. */
export function deprecationPhrases(summary: string | null, description: string | null): string[] {
  const found: string[] = [];
  for (const text of [summary ?? "", (description ?? "").slice(0, 2000)]) {
    for (const m of text.matchAll(DEPRECATION_RE)) {
      const start = Math.max(0, m.index - 60);
      const end = Math.min(text.length, m.index + m[0].length + 60);
      const snippet = text.slice(start, end).split(/\s+/).filter(Boolean).join(" ");
      if (!found.includes(snippet)) found.push(snippet);
    }
  }
  return found.slice(0, 5);
}

// ---------------------------------------------------------------- cache

export interface StorageBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export class MemoryBackend implements StorageBackend {
  private readonly m = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.m.get(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.m.set(key, value);
  }
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

export class TtlCache<T> {
  constructor(
    private readonly backend: StorageBackend,
    private readonly prefix: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<T | undefined> {
    try {
      const raw = (await this.backend.get(this.prefix + key)) as CacheEntry<T> | undefined;
      if (!raw || typeof raw !== "object" || typeof raw.at !== "number") return undefined;
      if (this.now() - raw.at > this.ttlMs) return undefined;
      return raw.value;
    } catch {
      return undefined; // a broken cache must never break the scan
    }
  }

  async set(key: string, value: T): Promise<void> {
    try {
      await this.backend.set(this.prefix + key, { at: this.now(), value } satisfies CacheEntry<T>);
    } catch {
      // Storage quota or unavailable storage: carry on uncached.
    }
  }
}

// ---------------------------------------------------------------- index client

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}
function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Reduce the release files of /pypi/<name>/json to what the scoring needs (keeps the cache small). */
export function compactProject(name: string, project: unknown, simple: unknown): ProjectInfo {
  const p = asObj(project) ?? {};
  const info = asObj(p["info"]) ?? {};
  const releasesRaw = asObj(p["releases"]) ?? {};
  const releases: Record<string, ReleaseSummary> = {};
  for (const [version, filesRaw] of Object.entries(releasesRaw)) {
    const files = Array.isArray(filesRaw) ? filesRaw.map(asObj).filter((f): f is Json => f !== null) : [];
    const times = files.map((f) => asStr(f["upload_time_iso_8601"])).filter((t): t is string => t !== null);
    times.sort((a, b) => Date.parse(a) - Date.parse(b));
    releases[version] = {
      fileCount: files.length,
      firstUpload: times[0] ?? null,
      allYanked: files.length > 0 && files.every((f) => f["yanked"] === true),
      yankedReason: files.map((f) => asStr(f["yanked_reason"])).find((r) => r !== null) ?? null,
      requiresPython: files.map((f) => asStr(f["requires_python"])).find((r) => r !== null) ?? null,
    };
  }
  const status = asObj(asObj(simple)?.["project-status"])?.["status"];
  const classifiers = Array.isArray(info["classifiers"]) ? info["classifiers"].filter((c): c is string => typeof c === "string") : [];
  return {
    name,
    infoVersion: asStr(info["version"]),
    summary: asStr(info["summary"]),
    descriptionHead: asStr(info["description"])?.slice(0, 2000) ?? null,
    requiresPython: asStr(info["requires_python"]),
    classifiers,
    releases,
    projectStatus: typeof status === "string" ? status : null,
  };
}

export interface PyPIClientOptions extends HttpOptions {
  cache?: TtlCache<ProjectLookup>;
}

export class PyPIClient {
  private readonly cache: TtlCache<ProjectLookup>;
  private readonly inflight = new Map<string, Promise<ProjectLookup>>();

  constructor(private readonly opts: PyPIClientOptions = {}) {
    this.cache = opts.cache ?? new TtlCache<ProjectLookup>(new MemoryBackend(), "pypi:", CACHE_TTL_MS);
  }

  lookup(name: string): Promise<ProjectLookup> {
    const pending = this.inflight.get(name);
    if (pending) return pending;
    const p = this.lookupUncached(name).finally(() => this.inflight.delete(name));
    this.inflight.set(name, p);
    return p;
  }

  private async lookupUncached(name: string): Promise<ProjectLookup> {
    const cached = await this.cache.get(name);
    if (cached) return cached;
    const enc = encodeURIComponent(name);
    let result: ProjectLookup;
    try {
      const project = await httpGet(`${INDEX}/pypi/${enc}/json`, { Accept: "application/json" }, this.opts);
      if (project.status === 404) {
        result = { kind: "not-found" };
      } else if (project.status !== 200) {
        return { kind: "error", error: `index error: HTTP ${project.status}` };
      } else {
        const projectJson = safeJson(project.text);
        if (projectJson === undefined) return { kind: "error", error: "index error: invalid JSON from PyPI" };
        let simpleJson: unknown = null;
        try {
          const simple = await httpGet(`${INDEX}/simple/${enc}/`, { Accept: "application/vnd.pypi.simple.v1+json" }, this.opts);
          if (simple.status === 200) simpleJson = safeJson(simple.text) ?? null;
        } catch {
          // Project status is optional; the JSON API data is still useful without it.
        }
        result = { kind: "found", info: compactProject(name, projectJson, simpleJson) };
      }
    } catch (err) {
      return { kind: "error", error: err instanceof HttpError ? `index error: ${err.message}` : `index error: ${String(err)}` };
    }
    await this.cache.set(name, result);
    return result;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- metadata (port of _fetch_one)

function latestStable(releases: Record<string, ReleaseSummary>): string | null {
  let best: { raw: string; v: ParsedVersion } | null = null;
  for (const [raw, rel] of Object.entries(releases)) {
    const v = parseVersion(raw);
    if (!v || isPrerelease(v) || rel.fileCount === 0 || rel.allYanked) continue;
    if (!best || compareVersions(v, best.v) > 0) best = { raw, v };
  }
  return best ? best.raw : null;
}

function date(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}

export function toMetadata(name: string, pinned: string | null, lookup: ProjectLookup): PackageMetadata {
  const empty: PackageMetadata = {
    name,
    found: false,
    latestVersion: null,
    latestReleaseAt: null,
    pinnedVersion: pinned,
    pinnedReleaseAt: null,
    pinnedYanked: false,
    pinnedYankedReason: null,
    requiresPython: null,
    pinnedRequiresPython: null,
    classifiers: [],
    pythonClassifiers: [],
    projectStatus: null,
    summary: null,
    deprecationPhrases: [],
    error: null,
  };
  if (lookup.kind === "not-found") return { ...empty, error: "not found on PyPI" };
  if (lookup.kind === "error") return { ...empty, error: lookup.error };
  const info = lookup.info;
  const latest = latestStable(info.releases) ?? info.infoVersion;
  const pinnedRel = pinned ? info.releases[pinned] : undefined;
  const pinnedHasFiles = pinnedRel !== undefined && pinnedRel.fileCount > 0;
  return {
    ...empty,
    found: true,
    latestVersion: latest,
    latestReleaseAt: date(latest ? info.releases[latest]?.firstUpload : null),
    pinnedReleaseAt: date(pinnedRel?.firstUpload),
    pinnedYanked: pinnedHasFiles && pinnedRel.allYanked,
    pinnedYankedReason: pinnedRel?.yankedReason ?? null,
    requiresPython: info.requiresPython,
    pinnedRequiresPython: pinnedRel?.requiresPython ?? null,
    classifiers: info.classifiers,
    pythonClassifiers: info.classifiers
      .filter((c) => c.startsWith("Programming Language :: Python :: 3."))
      .map((c) => c.slice(c.lastIndexOf("::") + 2).trim()),
    projectStatus: info.projectStatus,
    summary: info.summary,
    deprecationPhrases: deprecationPhrases(info.summary, info.descriptionHead),
  };
}
