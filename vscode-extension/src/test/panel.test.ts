import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { cloneFolderName, panelSummary, parseSummary, parseTarget } from "../model";

const fixture = (name: string): string => readFileSync(path.join(__dirname, "..", "..", "test", "fixtures", name), "utf8");

describe("parseTarget", () => {
  it("treats empty input as the open workspace", () => {
    assert.deepEqual(parseTarget("   "), { kind: "workspace" });
  });

  it("accepts GitHub URLs in the usual forms", () => {
    for (const url of [
      "https://github.com/rishrek/LinkWatch",
      "https://github.com/rishrek/LinkWatch/",
      "https://github.com/rishrek/LinkWatch.git",
      "github.com/rishrek/LinkWatch",
      "https://www.github.com/rishrek/LinkWatch/tree/main/linkwatch",
      "https://github.com/rishrek/LinkWatch?tab=readme",
    ]) {
      assert.deepEqual(
        parseTarget(url),
        { kind: "github", owner: "rishrek", repo: "LinkWatch", cloneUrl: "https://github.com/rishrek/LinkWatch.git" },
        url,
      );
    }
  });

  it("accepts absolute folder paths on Windows and POSIX", () => {
    assert.deepEqual(parseTarget("D:\\code\\LinkWatch"), { kind: "path", path: "D:\\code\\LinkWatch" });
    assert.deepEqual(parseTarget("/home/me/LinkWatch"), { kind: "path", path: "/home/me/LinkWatch" });
  });

  it("rejects other URLs, relative paths and option-like names", () => {
    assert.equal(parseTarget("https://gitlab.com/a/b").kind, "invalid");
    assert.equal(parseTarget("LinkWatch").kind, "invalid");
    assert.equal(parseTarget("https://github.com/-evil/repo").kind, "invalid");
    assert.equal(parseTarget("https://github.com/owner/..").kind, "invalid");
  });

  it("builds a safe clone folder name", () => {
    assert.equal(cloneFolderName("rishrek", "LinkWatch"), "rishrek__LinkWatch");
  });
});

describe("panelSummary", () => {
  it("summarises a run for the panel with labelled reasons", () => {
    const s = panelSummary(parseSummary(fixture("capsule.json")));
    assert.equal(s.kind, "run");
    assert.ok(s.atRisk > 0 && s.dependencies.length === s.atRisk);
    assert.ok(s.dependencies.every((d, i, all) => i === 0 || all[i - 1]!.score >= d.score));
    assert.ok(s.dependencies.every((d) => !d.reason || ["OBSERVED", "VERIFIED", "AI"].includes(d.reasonLabel)));
    assert.equal(s.analysed, parseSummary(fixture("capsule.json")).capsules.length);
    assert.equal(JSON.parse(JSON.stringify(s)).atRisk, s.atRisk);
  });

  it("has no combined result for a scan", () => {
    const s = panelSummary(parseSummary(fixture("scan.json")));
    assert.equal(s.kind, "scan");
    assert.equal(s.fixedTogether, null);
    assert.equal(s.applicable, 0);
  });
});
