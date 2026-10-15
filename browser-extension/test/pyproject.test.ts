import assert from "node:assert/strict";
import { test } from "node:test";
import { findDrift, parsePyproject, parseSetupPy, poetryToPep440, readManifests } from "../src/core/manifests.js";
import { parseToml } from "../src/core/toml.js";

test("PEP 621 dependencies, optional-dependencies and dependency-groups", () => {
  const text = `
[build-system]
requires = ["setuptools>=61", "wheel"]

[project]
name = "demo"
requires-python = ">=3.10"
dependencies = [
  "requests>=2.31",  # HTTP
  'Jinja2==2.11.3',
  "pkg @ https://example.com/pkg.whl",
  "tomli; python_version < '3.11'",
]

[project.optional-dependencies]
dev = ["pytest>=7", "nose==1.3.7",]
docs = []

[dependency-groups]
lint = ["ruff==0.4.0", {include-group = "dev"}]
`;
  const warnings: string[] = [];
  const r = parsePyproject(text, "pyproject.toml", warnings);
  assert.equal(r.requiresPython, ">=3.10");
  assert.deepEqual(
    r.requirements.map((x) => [x.name, x.specifier, x.section]),
    [
      ["requests", ">=2.31", "project.dependencies"],
      ["jinja2", "==2.11.3", "project.dependencies"],
      ["tomli", "", "project.dependencies"],
      ["pytest", ">=7", "project.optional-dependencies.dev"],
      ["nose", "==1.3.7", "project.optional-dependencies.dev"],
      ["ruff", "==0.4.0", "dependency-groups.lint"],
    ],
  );
  assert.equal(r.requirements[1]!.line, 10);
  assert.deepEqual(warnings, []);
});

test("Poetry dependencies, groups and constraint translation", () => {
  const text = `
[tool.poetry]
name = "demo"

[tool.poetry.dependencies]
python = "^3.9"
requests = "^2.28.1"
"Django" = { version = "~4.1", extras = ["argon2"] }
mylib = { path = "../mylib" }
fork = { git = "https://github.com/x/fork.git" }
pinned = "1.2.3"
anything = "*"
multi = [ { version = "<2", python = "<3.8" }, { version = ">=2", python = ">=3.8" } ]

[tool.poetry.group.dev.dependencies]
pytest = ">=7.0,<8"

[tool.poetry.dev-dependencies]
black = "==23.1.0"
`;
  const r = parsePyproject(text);
  assert.equal(r.requiresPython, ">=3.9,<4");
  const byName = Object.fromEntries(r.requirements.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(byName).sort(), ["anything", "black", "django", "multi", "pinned", "pytest", "requests"]);
  assert.equal(byName["requests"]!.specifier, "<3,>=2.28.1");
  assert.equal(byName["django"]!.specifier, "<4.2,>=4.1");
  assert.deepEqual(byName["django"]!.extras, ["argon2"]);
  assert.equal(byName["pinned"]!.pinnedVersion, "1.2.3");
  assert.equal(byName["anything"]!.specifier, "");
  assert.equal(byName["pytest"]!.section, "tool.poetry.group.dev.dependencies");
  assert.equal(byName["black"]!.pinnedVersion, "23.1.0");
  assert.equal(poetryToPep440("^0.2.3"), ">=0.2.3,<0.3");
  assert.equal(poetryToPep440("^0.0.3"), ">=0.0.3,<0.0.4");
  assert.equal(poetryToPep440("~1"), ">=1,<2");
  assert.equal(poetryToPep440("1.0 || 2.0"), null);
});

test("malformed TOML is reported and the rest still parses", () => {
  const text = `
[project]
name = "x
dependencies = ["six==1.16.0"]
broken = [1, 2
[project.optional-dependencies]
dev = ["pytest"]
`;
  const warnings: string[] = [];
  const r = parsePyproject(text, "pyproject.toml", warnings);
  assert.ok(warnings.length >= 1, "expected TOML warnings");
  assert.deepEqual(r.requirements.map((x) => x.name), ["six", "pytest"]);
});

test("TOML reader handles strings, inline tables and arrays of tables", () => {
  const { data, errors } = parseToml(`
a = """multi
line"""
b = 'C:\\path'
c = { d = 1, e.f = true }
[[tool.x]]
n = 1
[[tool.x]]
n = 2
date = 1979-05-27 07:32:00
"quoted key" = "\\u00e9\\t"
`);
  assert.deepEqual(errors, []);
  assert.equal(data["a"], "multi\nline");
  assert.equal(data["b"], "C:\\path");
  assert.deepEqual(data["c"], { d: 1, e: { f: true } });
  const tool = data["tool"] as { x: { n: number; "quoted key"?: string }[] };
  assert.deepEqual(tool.x.map((t) => t.n), [1, 2]);
  assert.equal(tool.x[1]!["quoted key"], "é\t");
});

test("setup.py install_requires (literal and via a name)", () => {
  assert.deepEqual(
    parseSetupPy(`setup(name="x", install_requires=["requests>=2", 'six==1.16.0'], extras_require={"dev": ["pytest"]})`).map(
      (r) => [r.name, r.specifier],
    ),
    [
      ["requests", ">=2"],
      ["six", "==1.16.0"],
    ],
  );
  const viaName = parseSetupPy(`REQUIRES = [\n  "click>=7",\n  "rich",\n]\nsetup(install_requires=REQUIRES)\n`);
  assert.deepEqual(viaName.map((r) => r.name), ["click", "rich"]);
  const warnings: string[] = [];
  assert.deepEqual(parseSetupPy(`setup(install_requires=open("r.txt").read().split())`, "setup.py", warnings), []);
  assert.equal(warnings.length, 1);
});

test("drift across files and duplicates within one file", () => {
  const report = readManifests([
    { path: "requirements.txt", text: "pydantic==1.10.13\nclick>=7\nclick>=8\n" },
    { path: "pyproject.toml", text: '[project]\ndependencies = ["pydantic>=2", "click>=7"]\n' },
  ]);
  assert.deepEqual(report.drift.map((d) => d.name), ["click", "pydantic"]);
  assert.match(report.drift[1]!.description, /requirements\.txt:1 '==1\.10\.13', pyproject\.toml:2 '>=2'/);
  assert.deepEqual(report.duplicates.map((d) => d.name), ["click"]);
  assert.deepEqual(findDrift([]), []);
});
