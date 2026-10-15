import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeRepository } from "../src/core/analyze.js";
import { Limiter } from "../src/core/http.js";
import { readManifests } from "../src/core/manifests.js";
import { compactProject, PyPIClient, toMetadata } from "../src/core/pypi.js";
import { assess, scoreOf, severityFor } from "../src/core/risk.js";
import type { PackageMetadata } from "../src/core/types.js";
import { fakeFetch, noSleep, pypiProject } from "./helpers.js";

const NOW = new Date("2026-10-15T00:00:00Z");

const OLD_TWO_MAJORS = pypiProject({
  latest: "3.1.6",
  releases: [
    { version: "1.0.0", uploaded: "2019-01-01T00:00:00Z", requiresPython: ">=2.7" },
    { version: "2.11.3", uploaded: "2021-01-31T16:33:07Z", requiresPython: ">=2.7, !=3.0.*, !=3.1.*" },
    { version: "3.1.6", uploaded: "2025-03-05T20:05:00Z", requiresPython: ">=3.7" },
    { version: "4.0.0rc1", uploaded: "2026-09-01T00:00:00Z" },
  ],
  classifiers: ["Programming Language :: Python :: 3.12", "Programming Language :: Python :: 3.13"],
});

const YANKED = pypiProject({
  latest: "2.0.1",
  releases: [
    { version: "2.0.0", uploaded: "2026-01-10T00:00:00Z", yanked: true, yankedReason: "broken wheel" },
    { version: "2.0.1", uploaded: "2026-01-12T00:00:00Z" },
  ],
  classifiers: ["Programming Language :: Python :: 3.10"],
});

const ARCHIVED = pypiProject({
  latest: "1.3.7",
  releases: [{ version: "1.3.7", uploaded: "2015-06-02T09:12:32Z" }],
  classifiers: ["Development Status :: 7 - Inactive"],
  summary: "nose extends unittest; this project is no longer maintained",
});

function meta(name: string, pinned: string | null, project: unknown, status: string | null = null): PackageMetadata {
  return toMetadata(name, pinned, { kind: "found", info: compactProject(name, project, status ? { "project-status": { status } } : null) });
}

test("severity bands match the CLI", () => {
  assert.equal(severityFor(0), "none");
  assert.equal(severityFor(5), "low");
  assert.equal(severityFor(20), "medium");
  assert.equal(severityFor(40), "high");
  assert.equal(severityFor(60), "critical");
  assert.equal(scoreOf([
    { code: "A", title: "", detail: "", weight: 70, provenance: "observed" },
    { code: "A", title: "", detail: "", weight: 10, provenance: "observed" },
    { code: "B", title: "", detail: "", weight: 50, provenance: "observed" },
  ]), 100);
});

test("scoring with fixed PyPI data: old pin, yanked pin, archived project, missing package", () => {
  const manifest = readManifests([
    { path: "requirements.txt", text: "jinja2==2.11.3\nyanky==2.0.0\nnose==1.3.7\nnot-a-real-pkg==0.1\n" },
  ]);
  const metadata = new Map<string, PackageMetadata>([
    ["jinja2", meta("jinja2", "2.11.3", OLD_TWO_MAJORS)],
    ["yanky", meta("yanky", "2.0.0", YANKED)],
    ["nose", meta("nose", "1.3.7", ARCHIVED, "archived")],
    ["not-a-real-pkg", toMetadata("not-a-real-pkg", "0.1", { kind: "not-found" })],
  ]);
  const risks = assess({ manifest, metadata, now: NOW });
  const by = Object.fromEntries(risks.map((r) => [r.name, r]));

  // One major behind -> OUTDATED_PIN 15; the 4.0.0rc1 pre-release is not "latest".
  const j = by["jinja2"]!;
  assert.equal(j.latestVersion, "3.1.6");
  assert.deepEqual(j.indicators.map((i) => [i.code, i.weight]), [["OUTDATED_PIN", 15]]);
  assert.equal(j.indicators[0]!.title, "Pinned 2.11.3 is 1 major version(s) behind 3.1.6");
  assert.equal(j.indicators[0]!.detail, "Exact pin blocks fixes, released 5.7 years ago.");
  assert.equal(j.severity, "low");

  const y = by["yanky"]!;
  assert.deepEqual(y.indicators.map((i) => [i.code, i.weight]).sort(), [["OUTDATED_PIN", 5], ["PYTHON_CLASSIFIERS_OLD", 5], ["YANKED_PIN", 30]]);
  assert.equal(y.indicators.find((i) => i.code === "YANKED_PIN")!.detail, "broken wheel");
  assert.equal(y.score, 40);
  assert.equal(y.severity, "high");

  const n = by["nose"]!;
  assert.deepEqual(n.indicators.map((i) => i.code).sort(), ["DEPRECATION_NOTICE", "INACTIVE_CLASSIFIER", "INDEX_STATUS", "STALE_PROJECT"]);
  assert.equal(n.indicators.find((i) => i.code === "STALE_PROJECT")!.weight, 25);
  assert.equal(n.indicators.find((i) => i.code === "STALE_PROJECT")!.title, "No release for 11.4 years");
  assert.equal(n.score, 100);
  assert.equal(n.severity, "critical");

  const missing = by["not-a-real-pkg"]!;
  assert.deepEqual(missing.indicators.map((i) => [i.code, i.weight]), [["NOT_ON_INDEX", 30]]);
  assert.equal(missing.severity, "medium");
  assert.ok(missing.atRisk);

  for (const r of risks) for (const i of r.indicators) assert.equal(i.provenance, "observed");
  assert.deepEqual(risks.map((r) => r.name), ["nose", "yanky", "not-a-real-pkg", "jinja2"]);
});

test("two majors behind scores 20 and unsupported Python is reported once", () => {
  const manifest = readManifests([{ path: "requirements.txt", text: "oldlib==1.0.0\n" }]);
  const project = pypiProject({
    latest: "3.0.0",
    releases: [
      { version: "1.0.0", uploaded: "2024-01-01T00:00:00Z", requiresPython: ">=3.6,<3.12" },
      { version: "3.0.0", uploaded: "2026-01-01T00:00:00Z" },
    ],
  });
  const [r] = assess({ manifest, metadata: new Map([["oldlib", meta("oldlib", "1.0.0", project)]]), now: NOW });
  assert.deepEqual(r!.indicators.map((i) => [i.code, i.weight]), [["OUTDATED_PIN", 20], ["PYTHON_UNSUPPORTED", 20]]);
  assert.equal(r!.indicators[0]!.title, "Pinned 1.0.0 is 2 major version(s) behind 3.0.0");
  assert.equal(r!.indicators[1]!.title, "Declares no support for Python 3.12, 3.13");
  assert.equal(r!.score, 40);
});

test("end to end with a fake network: 404 package, archived project, drift", async () => {
  const fetchImpl = fakeFetch({
    "https://raw.githubusercontent.com/acme/app/HEAD/requirements.txt": { status: 200, body: "nose==1.3.7\nghost-pkg\npydantic==1.10.13\n" },
    "https://raw.githubusercontent.com/acme/app/HEAD/pyproject.toml": { status: 200, body: '[project]\ndependencies = ["pydantic>=2"]\n' },
    "https://pypi.org/pypi/nose/json": { status: 200, body: ARCHIVED },
    "https://pypi.org/simple/nose/": { status: 200, body: { "project-status": { status: "archived" } } },
    "https://pypi.org/pypi/pydantic/json": {
      status: 200,
      body: pypiProject({ latest: "2.9.0", releases: [{ version: "1.10.13", uploaded: "2023-09-27T00:00:00Z" }, { version: "2.9.0", uploaded: "2026-08-01T00:00:00Z" }] }),
    },
  });
  const opts = { fetchImpl, sleep: noSleep, limiter: new Limiter(6) };
  const result = await analyzeRepository({ owner: "acme", repo: "app", ref: null }, { ...opts, pypi: new PyPIClient(opts), now: () => NOW });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.filesRead, ["requirements.txt", "pyproject.toml"]);
  assert.equal(result.dependencyCount, 3);
  const by = Object.fromEntries(result.risks.map((r) => [r.name, r]));
  assert.ok(by["nose"]!.indicators.some((i) => i.code === "INDEX_STATUS"));
  assert.deepEqual(by["ghost-pkg"]!.indicators.map((i) => i.code), ["NOT_ON_INDEX"]);
  assert.deepEqual(by["pydantic"]!.indicators.map((i) => [i.code, i.weight]), [["OUTDATED_PIN", 15], ["MANIFEST_DRIFT", 15]]);
  assert.equal(by["pydantic"]!.severity, "medium");
  assert.equal(result.atRiskCount, 3);
  assert.equal(result.worstSeverity, "critical");
  assert.deepEqual(result.indexErrors, []);
});
