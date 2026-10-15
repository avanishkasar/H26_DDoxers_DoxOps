import assert from "node:assert/strict";
import { test } from "node:test";
import { readManifests } from "../src/core/manifests.js";
import { fixture } from "./helpers.js";

test("LinkWatch's real manifests (fetched from GitHub) parse as the CLI sees them", () => {
  const report = readManifests([
    { path: "requirements.txt", text: fixture("linkwatch/requirements.txt") },
    { path: "requirements-dev.txt", text: fixture("linkwatch/requirements-dev.txt") },
    { path: "pyproject.toml", text: fixture("linkwatch/pyproject.toml") },
  ]);
  const names = new Set(report.requirements.map((r) => r.name));
  for (const n of ["jinja2", "nose", "pydantic", "toml", "appdirs", "six", "requests"]) assert.ok(names.has(n), `missing ${n}`);
  const jinja = report.requirements.find((r) => r.name === "jinja2" && r.sourceFile === "requirements.txt")!;
  assert.equal(jinja.raw, "Jinja2==2.11.3");
  assert.equal(jinja.pinnedVersion, "2.11.3");
  assert.equal(report.requirements.find((r) => r.name === "nose")!.pinnedVersion, "1.3.7");
  // The commented-out "# PyYAML==5.1" is not a dependency.
  assert.ok(!names.has("pyyaml"));
  // requirements.txt pins pydantic==1.10.13 while pyproject.toml says pydantic>=2.
  const drift = report.drift.find((d) => d.name === "pydantic");
  assert.ok(drift, "pydantic drift not detected");
  assert.match(drift.description, /requirements\.txt:5 '==1\.10\.13'/);
  assert.match(drift.description, /pyproject\.toml:\d+ '>=2'/);
  assert.equal(report.drift.length, 1);
  assert.equal(report.requiresPython, ">=3.10");
  assert.deepEqual(report.warnings, []);
});
