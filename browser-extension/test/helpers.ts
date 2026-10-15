import { readFileSync } from "node:fs";
import type { FetchLike } from "../src/core/http.js";

export function fixture(path: string): string {
  return readFileSync(new URL(`../test/fixtures/${path}`, import.meta.url), "utf8");
}

export interface FakeRelease {
  version: string;
  uploaded: string;
  yanked?: boolean;
  yankedReason?: string;
  requiresPython?: string;
}

export function pypiProject(opts: {
  latest: string;
  releases: FakeRelease[];
  classifiers?: string[];
  summary?: string;
  description?: string;
  requiresPython?: string;
}): unknown {
  const releases: Record<string, unknown[]> = {};
  for (const r of opts.releases) {
    releases[r.version] = [
      {
        upload_time_iso_8601: r.uploaded,
        yanked: r.yanked ?? false,
        yanked_reason: r.yankedReason ?? null,
        requires_python: r.requiresPython ?? null,
      },
    ];
  }
  return {
    info: {
      version: opts.latest,
      summary: opts.summary ?? "",
      description: opts.description ?? "",
      requires_python: opts.requiresPython ?? null,
      classifiers: opts.classifiers ?? [],
    },
    releases,
  };
}

export type Route = { status: number; body?: unknown; headers?: Record<string, string> } | (() => Promise<Response>);

/** A fetch stand-in that serves fixed routes and records every request. */
export function fakeFetch(routes: Record<string, Route | Route[]>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const counters = new Map<string, number>();
  const fn = (async (url: string): Promise<Response> => {
    calls.push(url);
    const entry = routes[url];
    if (entry === undefined) return new Response("Not Found", { status: 404 });
    let route: Route;
    if (Array.isArray(entry)) {
      const n = counters.get(url) ?? 0;
      counters.set(url, n + 1);
      route = entry[Math.min(n, entry.length - 1)]!;
    } else route = entry;
    if (typeof route === "function") return route();
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body ?? {});
    return new Response(body, { status: route.status, headers: route.headers ?? {} });
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export const noSleep = async (): Promise<void> => undefined;
