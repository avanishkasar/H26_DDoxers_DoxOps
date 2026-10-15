import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalizeName, parseRequirementString, parseRequirementsTxt } from "../src/core/requirements.js";

test("PEP 503 normalisation", () => {
  assert.equal(canonicalizeName("Jinja2"), "jinja2");
  assert.equal(canonicalizeName("python_dateutil"), "python-dateutil");
  assert.equal(canonicalizeName("Zope.Interface"), "zope-interface");
  assert.equal(canonicalizeName("a__-.b"), "a-b");
});

test("requirement strings: pins, ranges, extras, markers", () => {
  const r = parseRequirementString("Requests[socks,security] >= 2.0, <3 ; python_version >= '3.8'")!;
  assert.equal(r.name, "requests");
  assert.equal(r.specifier, "<3,>=2.0");
  assert.equal(r.pinnedVersion, null);
  assert.deepEqual(r.extras, ["security", "socks"]);
  assert.equal(r.marker, "python_version >= '3.8'");
  assert.equal(parseRequirementString("Jinja2==2.11.3")!.pinnedVersion, "2.11.3");
  assert.equal(parseRequirementString("foo===1.0")!.pinnedVersion, "1.0");
  assert.equal(parseRequirementString("foo==1.*")!.pinnedVersion, null);
  assert.equal(parseRequirementString("foo (>=1.0)")!.specifier, ">=1.0");
  assert.equal(parseRequirementString("six")!.specifier, "");
  assert.equal(parseRequirementString("foo ~= 1.4.2")!.specifier, "~=1.4.2");
});

test("requirement strings: VCS, URLs, paths and junk are skipped", () => {
  for (const s of [
    "git+https://github.com/a/b.git#egg=b",
    "https://example.com/pkg.whl",
    "pkg @ https://example.com/pkg.whl",
    "-e .",
    "./local/pkg",
    "/abs/path",
    "C:\\pkgs\\x.whl",
    "foo >>> 1",
    "foo[bad extra]",
    "",
  ]) {
    assert.equal(parseRequirementString(s), null, s);
  }
});

test("requirements.txt edge cases", () => {
  const text = [
    "# comment",
    "",
    "-r base.txt",
    "--index-url https://example.com/simple",
    "-c constraints.txt",
    "Flask==2.0.1  # pinned for reasons",
    "requests[socks]>=2.25 ; python_version>'3.6'",
    "git+https://github.com/x/y.git@main#egg=y",
    "-e git+https://github.com/x/z.git#egg=z",
    "numpy==1.26.4 \\",
    "    --hash=sha256:abcdef",
    "Django>=3.2,<4",
    "weird >= 1 2",
    "pkg @ https://example.com/pkg-1.0.tar.gz",
    "\tPyYAML == 5.4.1\r",
    "#   commented==1.0",
  ].join("\n");
  const warnings: string[] = [];
  const reqs = parseRequirementsTxt(text, "requirements.txt", warnings);
  assert.deepEqual(
    reqs.map((r) => [r.name, r.specifier, r.pinnedVersion, r.line]),
    [
      ["flask", "==2.0.1", "2.0.1", 6],
      ["requests", ">=2.25", null, 7],
      ["numpy", "==1.26.4", "1.26.4", 10],
      ["django", "<4,>=3.2", null, 12],
      ["pyyaml", "==5.4.1", "5.4.1", 15],
    ],
  );
  assert.deepEqual(reqs[1]!.extras, ["socks"]);
  assert.equal(reqs[1]!.marker, "python_version>'3.6'");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /requirements\.txt:13/);
});

test("requirements.txt with BOM and CRLF", () => {
  const reqs = parseRequirementsTxt("\uFEFFsix==1.16.0\r\ntoml\r\n", "requirements.txt");
  assert.deepEqual(reqs.map((r) => r.name), ["six", "toml"]);
});
