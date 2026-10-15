// Read root manifests straight from raw.githubusercontent.com (no token, no API quota) and use
// the public REST API only to explain an empty result (private repo vs. not a Python project).

import { HttpError, httpGet, type HttpOptions } from "./http.js";
import { MANIFEST_PATHS } from "./manifests.js";
import type { ManifestFile } from "./types.js";

export const RAW_HOST = "https://raw.githubusercontent.com";
export const API_HOST = "https://api.github.com";
/** Larger files are not manifests we can reason about (and protect the worker's memory). */
const MAX_MANIFEST_BYTES = 512 * 1024;

export interface ManifestFetch {
  files: ManifestFile[];
  /** Ref the files were read from. */
  ref: string;
  /** True when no manifest was found at all (every path returned 404). */
  allMissing: boolean;
  /** Files that could not be read for reasons other than 404 (timeouts, rate limits). */
  errors: string[];
  notes: string[];
}

function rawUrl(owner: string, repo: string, ref: string, path: string): string {
  const seg = (s: string): string => encodeURIComponent(s);
  return `${RAW_HOST}/${seg(owner)}/${seg(repo)}/${ref.split("/").map(seg).join("/")}/${path}`;
}

async function fetchAt(owner: string, repo: string, ref: string, opts: HttpOptions): Promise<ManifestFetch> {
  const files: ManifestFile[] = [];
  const errors: string[] = [];
  let missing = 0;
  await Promise.all(
    MANIFEST_PATHS.map(async (path) => {
      try {
        const r = await httpGet(rawUrl(owner, repo, ref, path), { Accept: "text/plain" }, opts);
        if (r.status === 404) {
          missing++;
          return;
        }
        if (r.status !== 200) {
          errors.push(`${path}: HTTP ${r.status}`);
          return;
        }
        if (r.text.length > MAX_MANIFEST_BYTES) {
          errors.push(`${path}: larger than ${MAX_MANIFEST_BYTES / 1024} KB, skipped`);
          return;
        }
        files.push({ path, text: r.text });
      } catch (err) {
        errors.push(`${path}: ${err instanceof HttpError ? err.message : String(err)}`);
      }
    }),
  );
  return { files, ref, allMissing: missing === MANIFEST_PATHS.length, errors, notes: [] };
}

/**
 * Fetch requirements.txt, requirements-dev.txt, pyproject.toml and setup.py at `ref`
 * (or the default branch). When a ref from the page URL resolves to nothing, it may be a branch
 * name containing slashes, so the default branch is tried instead and a note says so.
 */
export async function fetchManifests(owner: string, repo: string, ref: string | null, opts: HttpOptions = {}): Promise<ManifestFetch> {
  const first = await fetchAt(owner, repo, ref ?? "HEAD", opts);
  if (ref && ref !== "HEAD" && first.allMissing) {
    const fallback = await fetchAt(owner, repo, "HEAD", opts);
    if (!fallback.allMissing) {
      fallback.notes.push(`No manifests found at ref '${ref}'; showing the default branch instead.`);
      return fallback;
    }
  }
  return first;
}

export type RepoVisibility =
  | { kind: "public"; language: string | null; archived: boolean }
  | { kind: "missing-or-private" }
  | { kind: "unknown"; reason: string };

/** One unauthenticated API call to tell "private or missing" apart from "public but not Python". */
export async function probeRepository(owner: string, repo: string, opts: HttpOptions = {}): Promise<RepoVisibility> {
  try {
    const r = await httpGet(
      `${API_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      opts,
    );
    if (r.status === 404) return { kind: "missing-or-private" };
    if (r.status === 403) return { kind: "unknown", reason: "GitHub API rate limit reached" };
    if (r.status !== 200) return { kind: "unknown", reason: `GitHub API HTTP ${r.status}` };
    const body = JSON.parse(r.text) as { language?: unknown; archived?: unknown; private?: unknown };
    if (body.private === true) return { kind: "missing-or-private" };
    return {
      kind: "public",
      language: typeof body.language === "string" ? body.language : null,
      archived: body.archived === true,
    };
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
}
