import assert from "node:assert/strict";
import { test } from "node:test";
import { capsuleMatchesRepo, parseCapsule } from "../src/core/capsule.js";
import { asAnalyzeRequest } from "../src/core/messages.js";
import { fixture } from "./helpers.js";

test("reads the trimmed LinkWatch capsule produced by the CLI", () => {
  const parsed = parseCapsule(fixture("capsule-linkwatch.json"));
  assert.ok(parsed.ok);
  const c = parsed.capsule;
  assert.equal(c.source, "https://github.com/rishrek/LinkWatch");
  assert.deepEqual(c.pythons, ["3.12", "3.13"]);
  const by = Object.fromEntries(c.dependencies.map((d) => [d.dependency, d]));
  assert.equal(by["jinja2"]!.status, "verified");
  assert.deepEqual(by["jinja2"]!.replacement, { text: "upgrade: jinja2 >=3.1.6,<4", provenance: "verified" });
  assert.equal(by["appdirs"]!.status, "partially-verified");
  assert.equal(by["pydantic"]!.status, "not-attempted");
  assert.equal(by["pydantic"]!.replacement, null);
  assert.equal(by["jinja2"]!.score, 85);
  assert.deepEqual(c.warnings, []);
  assert.ok(capsuleMatchesRepo(c, "rishrek", "linkwatch"));
  assert.ok(!capsuleMatchesRepo(c, "rishrek", "other"));
});

test("rejects things that are not capsules", () => {
  assert.equal(parseCapsule("{").ok, false);
  assert.equal(parseCapsule("[]").ok, false);
  assert.equal(parseCapsule(JSON.stringify({ tool: "other" })).ok, false);
  assert.equal(parseCapsule(JSON.stringify({ tool: "doxops", schema_version: "2.0", target: { source: "x" }, capsules: [] })).ok, false);
  assert.equal(parseCapsule(JSON.stringify({ tool: "doxops", schema_version: "1.0", target: {}, capsules: [] })).ok, false);
  assert.equal(parseCapsule(JSON.stringify({ tool: "doxops", schema_version: "1.0", target: { source: "s" } })).ok, false);
});

test("skips malformed entries instead of failing", () => {
  const parsed = parseCapsule(
    JSON.stringify({
      tool: "doxops",
      schema_version: "1.0",
      target: { source: "git@github.com:rishrek/LinkWatch.git", pythons: ["3.12", 7] },
      capsules: [
        null,
        { dependency: "x", status: "weird" },
        { dependency: "ok", status: "failed", proposed_replacement: { text: 5, provenance: "ai" } },
        { dependency: "ai-one", status: "unverified", proposed_replacement: { text: "replace: y", provenance: "ai" } },
      ],
    }),
  );
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.capsule.dependencies.map((d) => [d.dependency, d.status, d.replacement?.provenance ?? null]), [
    ["ok", "failed", null],
    ["ai-one", "unverified", "ai"],
  ]);
  assert.equal(parsed.capsule.warnings.length, 3);
  assert.deepEqual(parsed.capsule.pythons, ["3.12"]);
  assert.ok(capsuleMatchesRepo(parsed.capsule, "rishrek", "LinkWatch"));
});

test("runtime messages are validated", () => {
  assert.deepEqual(asAnalyzeRequest({ type: "analyze", owner: "a", repo: "b", ref: null }), { type: "analyze", owner: "a", repo: "b", ref: null, force: false });
  assert.equal(asAnalyzeRequest({ type: "analyze", owner: "a/../x", repo: "b", ref: null }), null);
  assert.equal(asAnalyzeRequest({ type: "analyze", owner: "a", repo: "b", ref: "../../etc" }), null);
  assert.equal(asAnalyzeRequest({ type: "other" }), null);
  assert.equal(asAnalyzeRequest("analyze"), null);
});
