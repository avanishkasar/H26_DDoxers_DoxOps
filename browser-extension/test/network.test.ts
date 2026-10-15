import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeRepository } from "../src/core/analyze.js";
import { fetchManifests } from "../src/core/github.js";
import { httpGet, HttpError, Limiter } from "../src/core/http.js";
import { MemoryBackend, PyPIClient, TtlCache } from "../src/core/pypi.js";
import type { ProjectLookup } from "../src/core/types.js";
import { fakeFetch, noSleep, pypiProject } from "./helpers.js";

test("timeouts abort the request and surface as HttpError", async () => {
  const hanging = (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  await assert.rejects(httpGet("https://pypi.org/pypi/x/json", {}, { fetchImpl: hanging, timeoutMs: 30 }), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.match(err.message, /timed out/);
    return true;
  });
});

test("one retry on 429 (honouring Retry-After) then success; persistent 5xx fails", async () => {
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => void delays.push(ms);
  const f = fakeFetch({ "https://x/a": [{ status: 429, headers: { "Retry-After": "2" } }, { status: 200, body: "ok" }] });
  const r = await httpGet("https://x/a", {}, { fetchImpl: f, sleep });
  assert.equal(r.text, "ok");
  assert.deepEqual(delays, [2000]);
  const g = fakeFetch({ "https://x/b": { status: 503 } });
  await assert.rejects(httpGet("https://x/b", {}, { fetchImpl: g, sleep: noSleep }), /server error \(HTTP 503\)/);
  assert.equal(g.calls.length, 2);
});

test("the limiter never runs more than its maximum at once", async () => {
  const limiter = new Limiter(6);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 20 }, () =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    ),
  );
  assert.equal(peak, 6);
});

test("PyPI lookups are cached (found and 404) and deduplicated; errors are not cached", async () => {
  const f = fakeFetch({
    "https://pypi.org/pypi/six/json": { status: 200, body: pypiProject({ latest: "1.17.0", releases: [{ version: "1.17.0", uploaded: "2024-12-04T00:00:00Z" }] }) },
    "https://pypi.org/pypi/flaky/json": { status: 500 },
  });
  let clock = 0;
  const cache = new TtlCache<ProjectLookup>(new MemoryBackend(), "pypi:", 3_600_000, () => clock);
  const client = new PyPIClient({ fetchImpl: f, sleep: noSleep, cache });
  const [a, b] = await Promise.all([client.lookup("six"), client.lookup("six")]);
  assert.equal(a.kind, "found");
  assert.strictEqual(a, b);
  assert.equal((await client.lookup("nope")).kind, "not-found");
  await client.lookup("six");
  await client.lookup("nope");
  assert.equal(f.calls.filter((u) => u.includes("/pypi/six/json")).length, 1);
  assert.equal(f.calls.filter((u) => u.includes("/pypi/nope/json")).length, 1);
  const flaky = await client.lookup("flaky");
  assert.equal(flaky.kind, "error");
  await client.lookup("flaky");
  assert.equal(f.calls.filter((u) => u.includes("/pypi/flaky/json")).length, 4); // 2 attempts x 2 lookups
  clock = 3_600_001; // one hour later the cache expires
  await client.lookup("six");
  assert.equal(f.calls.filter((u) => u.includes("/pypi/six/json")).length, 2);
});

test("private or missing repository: every manifest 404s and the API says 404", async () => {
  const f = fakeFetch({});
  const result = await analyzeRepository({ owner: "acme", repo: "secret", ref: null }, { fetchImpl: f, sleep: noSleep });
  assert.equal(result.status, "private-or-missing");
  assert.match(result.message!, /private or does not exist/);
  assert.ok(f.calls.includes("https://api.github.com/repos/acme/secret"));
});

test("public repository without Python manifests", async () => {
  const f = fakeFetch({ "https://api.github.com/repos/acme/web": { status: 200, body: { language: "TypeScript", private: false } } });
  const result = await analyzeRepository({ owner: "acme", repo: "web", ref: null }, { fetchImpl: f, sleep: noSleep });
  assert.equal(result.status, "no-python-manifests");
  assert.match(result.message!, /main language: TypeScript/);
  assert.equal(result.dependencyCount, 0);
});

test("GitHub API rate limit still yields a plain no-manifest answer", async () => {
  const f = fakeFetch({ "https://api.github.com/repos/acme/web": { status: 403, body: { message: "API rate limit exceeded" } } });
  const result = await analyzeRepository({ owner: "acme", repo: "web", ref: null }, { fetchImpl: f, sleep: noSleep });
  assert.equal(result.status, "no-python-manifests");
});

test("a ref that resolves to nothing falls back to the default branch", async () => {
  const f = fakeFetch({ "https://raw.githubusercontent.com/acme/app/HEAD/requirements.txt": { status: 200, body: "six\n" } });
  const fetched = await fetchManifests("acme", "app", "feature", { fetchImpl: f, sleep: noSleep });
  assert.equal(fetched.ref, "HEAD");
  assert.equal(fetched.files.length, 1);
  assert.match(fetched.notes[0]!, /ref 'feature'/);
});

test("PyPI outage: dependencies are still listed, with an explanatory message", async () => {
  const f = fakeFetch({
    "https://raw.githubusercontent.com/acme/app/HEAD/requirements.txt": { status: 200, body: "six==1.0\n" },
    "https://pypi.org/pypi/six/json": { status: 502 },
  });
  const result = await analyzeRepository({ owner: "acme", repo: "app", ref: null }, { fetchImpl: f, sleep: noSleep });
  assert.equal(result.status, "ok");
  assert.equal(result.dependencyCount, 1);
  assert.equal(result.indexErrors.length, 1);
  assert.match(result.message!, /PyPI could not be reached for 1 package/);
});

test("manifest fetch failures (not 404) are reported as an error, not as 'not Python'", async () => {
  const f = fakeFetch({
    "https://raw.githubusercontent.com/acme/app/HEAD/requirements.txt": { status: 500 },
  });
  const result = await analyzeRepository({ owner: "acme", repo: "app", ref: null }, { fetchImpl: f, sleep: noSleep });
  assert.equal(result.status, "error");
});
