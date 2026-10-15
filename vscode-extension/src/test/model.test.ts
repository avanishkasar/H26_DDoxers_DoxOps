import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  applyConfirmationDetail,
  buildCsp,
  buildDoctorArgs,
  buildRunArgs,
  buildScanArgs,
  CapsuleFormatError,
  checkedPatchPaths,
  countResults,
  declarationDiagnostic,
  dependencyFromMessage,
  diagnosticLevel,
  findDeclarationLine,
  injectCsp,
  isManifestFile,
  mapCapsulePath,
  mentionsLocation,
  normalizeName,
  outputDirInsideWorkspaceIsSafe,
  outputRelativePath,
  parseSummary,
  partialWarningDetail,
  patchFiles,
  patchHunks,
  provenanceLabel,
  redactSecrets,
  reducedContextAllowed,
  reducedReverseCheckConclusive,
  runTimestamp,
  selectCombinedPatch,
  selectPatch,
  severityIcon,
  skippedPatchPaths,
  sortCapsules,
  statusBarText,
  StreamRedactor,
  stripAnsi,
  topIndicator,
  uniqueUsageSites,
  usageDiagnostic,
  usageIndicator,
  validPythons,
  workspaceExecutableCandidates,
  type Capsule,
  type PathContext,
  type RunSummary,
} from "../model";

const fixtures = path.resolve(__dirname, "..", "..", "test", "fixtures");
const runText = readFileSync(path.join(fixtures, "capsule.json"), "utf8");
const scanText = readFileSync(path.join(fixtures, "scan.json"), "utf8");
const run = parseSummary(runText);
const scan = parseSummary(scanText);

function capsule(summary: RunSummary, name: string): Capsule {
  const c = summary.capsules.find((x) => x.dependency === name);
  assert.ok(c, `fixture has no capsule for ${name}`);
  return c;
}

const posixCtx: PathContext = { workspaceRoot: "/home/dev/linkwatch", homeDir: "/home/dev", caseInsensitive: false };
const winCtx: PathContext = { workspaceRoot: "C:\\Users\\dev\\linkwatch", homeDir: "C:\\Users\\dev", caseInsensitive: true };

describe("parseSummary (run output)", () => {
  it("reads the run summary and every capsule", () => {
    assert.equal(run.kind, "run");
    assert.equal(run.toolVersion.length > 0, true);
    assert.deepEqual(
      run.capsules.map((c) => c.dependency).sort(),
      ["appdirs", "certifi", "jinja2", "requests", "six", "toml"],
    );
    assert.equal(run.combinedPatch, "patches/combined.patch");
    assert.ok(run.model);
    assert.ok(run.combinedResults.length > 0);
  });

  it("keeps statuses, attempts and provenance", () => {
    const jinja = capsule(run, "jinja2");
    assert.equal(jinja.status, "verified");
    assert.equal(jinja.risk.severity, "critical");
    assert.equal(jinja.attempts[0]?.accepted, true);
    assert.equal(jinja.attempts[0]?.patchPath, "patches/jinja2-attempt1.patch");
    assert.equal(jinja.proposedReplacement?.provenance, "verified");
    assert.deepEqual(jinja.proposedReplacement?.evidenceIds, ["E020", "E021"]);
    assert.equal(jinja.attempts[0]?.proposal, "upgrade: jinja2 >=3.1.6,<4");

    const six = capsule(run, "six");
    assert.equal(six.attempts.length, 2);
    assert.equal(six.attempts[0]?.accepted, false);
    assert.equal(six.attempts[0]?.patchPath, null);
    assert.match(six.attempts[0]?.verdict ?? "", /does not exist on PyPI/);
    assert.equal(six.analysis?.provenance, "ai");

    const requests = capsule(run, "requests");
    assert.equal(requests.status, "not-attempted");
    assert.equal(requests.attempts.length, 0);
    assert.equal(requests.proposedReplacement, null);

    assert.equal(capsule(run, "certifi").declarations.length, 0);
  });

  it("rejects text that is not a DoxOps summary", () => {
    assert.throws(() => parseSummary("not json"), CapsuleFormatError);
    assert.throws(() => parseSummary("[]"), CapsuleFormatError);
    assert.throws(() => parseSummary("{}"), /no 'capsules' list/);
    assert.throws(() => parseSummary('{"schema_version":"2.0","capsules":[]}'), /schema_version/);
    assert.throws(() => parseSummary('{"capsules":[{"dependency":"x"}]}'), /no risk section/);
    assert.throws(() => parseSummary('{"capsules":[{"risk":{}}]}'), /no dependency name/);
  });

  it("accepts a UTF-8 BOM and treats unknown provenance as AI", () => {
    const s = parseSummary(
      "\ufeff" +
        JSON.stringify({
          capsules: [
            {
              dependency: "x",
              status: "weird",
              risk: { score: 5, severity: "low", indicators: [{ code: "A", title: "t", weight: 5, provenance: "rumour" }] },
            },
          ],
        }),
    );
    const c = s.capsules[0];
    assert.ok(c);
    assert.equal(c.status, "unverified");
    assert.equal(c.risk.atRisk, true);
    assert.equal(c.risk.indicators[0]?.provenance, "ai");
  });
});

describe("parseSummary (scan-only output)", () => {
  it("is recognised as scan output with nothing to apply", () => {
    assert.equal(scan.kind, "scan");
    assert.equal(scan.model, null);
    assert.equal(scan.combinedPatch, null);
    assert.ok(scan.capsules.every((c) => c.status === "not-attempted" && c.attempts.length === 0));
    assert.ok(scan.capsules.every((c) => !selectPatch(c).ok));
    const combined = selectCombinedPatch(scan);
    assert.equal(combined.ok, false);
    assert.match(combined.ok ? "" : combined.reason, /scan-only/);
    assert.equal(countResults(scan).verified, 0);
  });

  it("still yields diagnostics for scan results", () => {
    const jinja = capsule(scan, "jinja2");
    const spec = declarationDiagnostic(jinja);
    assert.ok(spec);
    assert.equal(spec.level, "error");
    assert.match(spec.message, /^DoxOps: jinja2 at risk \(score 85\): .+ \[VERIFIED\]$/);
  });
});

describe("ranking and labels", () => {
  it("sorts by risk score descending, then by name", () => {
    const names = sortCapsules(run.capsules).map((c) => `${c.risk.score}:${c.dependency}`);
    assert.deepEqual(names, ["85:jinja2", "40:requests", "30:appdirs", "30:toml", "20:certifi", "20:six"]);
  });

  it("maps severities to diagnostic levels and icons", () => {
    assert.equal(diagnosticLevel("critical"), "error");
    assert.equal(diagnosticLevel("high"), "error");
    assert.equal(diagnosticLevel("medium"), "warning");
    assert.equal(diagnosticLevel("low"), "information");
    assert.equal(diagnosticLevel("none"), null);
    assert.equal(severityIcon("critical"), "error");
    assert.equal(severityIcon("medium"), "warning");
    assert.equal(severityIcon("low"), "info");
    assert.equal(severityIcon("none"), "pass");
    assert.equal(provenanceLabel("observed"), "OBSERVED");
    assert.equal(provenanceLabel("verified"), "VERIFIED");
    assert.equal(provenanceLabel("ai"), "AI");
  });

  it("picks the heaviest indicator as the top one", () => {
    const top = topIndicator(capsule(run, "jinja2"));
    assert.equal(top?.code, "IMPORT_FAILS");
  });

  it("counts results for the status bar", () => {
    const counts = countResults(run);
    assert.equal(counts.atRisk, 6);
    assert.equal(counts.verified, 2);
    assert.equal(counts.partiallyVerified, 2);
    assert.equal(counts.applicable, 4);
    assert.equal(statusBarText(run), "$(shield) DoxOps: 6 at risk · 2 verified");
  });
});

describe("path mapping", () => {
  it("keeps plain repository-relative paths", () => {
    assert.equal(mapCapsulePath("linkwatch/report.py", posixCtx), "linkwatch/report.py");
    assert.equal(mapCapsulePath("./linkwatch/report.py", posixCtx), "linkwatch/report.py");
    assert.equal(mapCapsulePath("linkwatch\\report.py", winCtx), "linkwatch/report.py");
  });

  it("maps redacted output mirrors back onto the repository", () => {
    assert.equal(mapCapsulePath("<out>/work/target/linkwatch/cache.py", posixCtx), "linkwatch/cache.py");
    assert.equal(mapCapsulePath("<out>/work/attempts/six-2/requirements.txt", posixCtx), "requirements.txt");
    assert.equal(mapCapsulePath("<out>/migrated-repo/pyproject.toml", posixCtx), "pyproject.toml");
    assert.equal(mapCapsulePath("migrated-repo/linkwatch/config.py", posixCtx), "linkwatch/config.py");
    assert.equal(mapCapsulePath("<out>/work/target", posixCtx), null);
    assert.equal(mapCapsulePath("<out>/evidence/E001-git.log", posixCtx), null);
  });

  it("only accepts home or absolute paths inside the workspace", () => {
    assert.equal(mapCapsulePath("~/linkwatch/linkwatch/cli.py", posixCtx), "linkwatch/cli.py");
    assert.equal(mapCapsulePath("~/.local/bin/uv", posixCtx), null);
    assert.equal(mapCapsulePath("/home/dev/linkwatch/setup.py", posixCtx), "setup.py");
    assert.equal(mapCapsulePath("/etc/passwd", posixCtx), null);
    assert.equal(mapCapsulePath("/home/dev/linkwatch-other/x.py", posixCtx), null);
    assert.equal(mapCapsulePath("c:/users/DEV/LinkWatch/a.py", winCtx), "a.py");
    assert.equal(mapCapsulePath("D:\\elsewhere\\a.py", winCtx), null);
  });

  it("refuses traversal and empty paths", () => {
    assert.equal(mapCapsulePath("../secrets.txt", posixCtx), null);
    assert.equal(mapCapsulePath("linkwatch/../../x", posixCtx), null);
    assert.equal(mapCapsulePath("", posixCtx), null);
    assert.equal(mapCapsulePath("a\0b", posixCtx), null);
  });

  it("maps every evidence-free path in the fixture without escaping", () => {
    for (const c of run.capsules) {
      for (const u of c.usage) {
        const mapped = mapCapsulePath(u.file, posixCtx);
        assert.ok(mapped !== null && !mapped.startsWith("/") && !mapped.includes(".."), u.file);
      }
    }
  });

  it("resolves output-relative patch paths", () => {
    assert.equal(outputRelativePath("patches/six-attempt2.patch"), "patches/six-attempt2.patch");
    assert.equal(outputRelativePath("<out>/patches/combined.patch"), "patches/combined.patch");
    assert.equal(outputRelativePath("patches\\a.patch"), "patches/a.patch");
    assert.equal(outputRelativePath("/tmp/a.patch"), null);
    assert.equal(outputRelativePath("~/a.patch"), null);
    assert.equal(outputRelativePath("../a.patch"), null);
  });

  it("recognises manifest files", () => {
    for (const f of ["requirements.txt", "requirements-dev.txt", "sub/pyproject.toml", "setup.py", "Pipfile"]) {
      assert.equal(isManifestFile(f), true, f);
    }
    for (const f of ["Makefile", "setup.pyc", "Pipfile.lock", "requirements.in"]) {
      assert.equal(isManifestFile(f), false, f);
    }
  });
});

describe("declaration lines", () => {
  it("finds requirements.txt and pyproject.toml declarations", () => {
    const req = "# deps\ntoml==0.10.2\nappdirs==1.4.4\nJinja2==2.11.3\npydantic>=2\n";
    assert.equal(findDeclarationLine(req, "jinja2"), 4);
    assert.equal(findDeclarationLine(req, "appdirs"), 3);
    assert.equal(findDeclarationLine(req, "six"), null);
    const pyproject = '[project]\nname = "linkwatch"\ndependencies = [\n    "toml==0.10.2",\n    "Jinja2==2.11.3",\n]\n';
    assert.equal(findDeclarationLine(pyproject, "jinja2"), 5);
    assert.equal(findDeclarationLine(pyproject, "toml"), 4);
  });

  it("handles normalisation, extras, setup.py lists and Pipfile keys", () => {
    assert.equal(normalizeName("Python_Dateutil"), "python-dateutil");
    assert.equal(findDeclarationLine("python-dateutil>=2\n", "python_dateutil"), 1);
    assert.equal(findDeclarationLine("requests[socks] >= 2.31 ; python_version>'3.8'\n", "requests"), 1);
    assert.equal(findDeclarationLine('setup(\n  install_requires=["six", "requests>=2"],\n)\n', "requests"), 2);
    assert.equal(findDeclarationLine('[packages]\nrequests = "*"\n', "requests"), 2);
    assert.equal(findDeclarationLine("# requests is great\nrequests-toolbelt\n", "requests"), null);
  });
});

describe("patch selection", () => {
  it("offers the accepted patch of verified and partially-verified capsules", () => {
    const jinja = selectPatch(capsule(run, "jinja2"));
    assert.equal(jinja.ok, true);
    assert.equal(jinja.ok && jinja.patchPath, "patches/jinja2-attempt1.patch");

    const six = selectPatch(capsule(run, "six"));
    assert.equal(six.ok && six.attempt.attempt, 2, "the rejected first attempt is never applied");
    assert.equal(six.ok && six.patchPath, "patches/six-attempt2.patch");

    const appdirs = selectPatch(capsule(run, "appdirs"));
    assert.equal(appdirs.ok, true);
  });

  it("refuses capsules that were not attempted or have no patch", () => {
    const requests = selectPatch(capsule(run, "requests"));
    assert.equal(requests.ok, false);
    assert.match(requests.ok ? "" : requests.reason, /not-attempted/);
    const noPatch: Capsule = { ...capsule(run, "jinja2"), attempts: [] };
    assert.match(selectPatch(noPatch).ok ? "" : (selectPatch(noPatch) as { reason: string }).reason, /no accepted attempt/);
    const failed: Capsule = { ...capsule(run, "jinja2"), status: "failed" };
    assert.equal(selectPatch(failed).ok, false);
    const escaping: Capsule = {
      ...capsule(run, "jinja2"),
      attempts: [{ ...capsule(run, "jinja2").attempts[0]!, patchPath: "../../etc/x.patch" }],
    };
    assert.equal(selectPatch(escaping).ok, false);
  });

  it("selects combined.patch only when every included fix is verified", () => {
    const combined = selectCombinedPatch(run);
    assert.equal(combined.ok, true);
    assert.deepEqual(combined.ok && combined.included.map((c) => c.dependency), ["jinja2", "appdirs", "toml", "six"]);
    const tampered: RunSummary = {
      ...run,
      capsules: run.capsules.map((c) => (c.dependency === "six" ? { ...c, status: "unverified" } : c)),
    };
    const blocked = selectCombinedPatch(tampered);
    assert.equal(blocked.ok, false);
    assert.match(blocked.ok ? "" : blocked.reason, /six \(unverified\)/);
  });

  it("refuses combined.patch when the combined run regressed or edits conflicted", () => {
    const regressed: RunSummary = {
      ...run,
      combinedResults: run.combinedResults.map((r) => ({ ...r, regressed: 3 })),
    };
    const r = selectCombinedPatch(regressed);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /regressed tests \(Python 3\.12: 3 regressed\)/);
    const c = selectCombinedPatch(run, "six: linkwatch/compat.py: edit did not apply\n");
    assert.equal(c.ok, false);
    assert.match(c.ok ? "" : c.reason, /combined-conflicts\.txt: six: linkwatch\/compat\.py/);
    assert.equal(selectCombinedPatch(run, "  \n").ok, true, "an empty conflicts file blocks nothing");
  });

  it("lists every file git will touch, including sections without a diff --git header", () => {
    const out =
      "Checking patch sub/requirements.txt...\nChecking patch sub/.vscode/settings.json...\nApplied patch sub/requirements.txt cleanly.\n";
    assert.deepEqual(checkedPatchPaths(out, "sub"), ["requirements.txt", ".vscode/settings.json"]);
    assert.deepEqual(checkedPatchPaths("Checking patch a.txt => b.txt...\n"), ["b.txt"]);
    assert.deepEqual(checkedPatchPaths("error: patch failed\n"), []);
  });

  it("only relaxes context for anchored hunks and trusts reverse checks that see added lines", () => {
    const append = "diff --git a/r.txt b/r.txt\n--- a/r.txt\n+++ b/r.txt\n@@ -1,3 +1,4 @@\n requests\n click\n idna\n+certifi>=2024.2\n";
    assert.deepEqual(patchHunks(append), [{ leading: 3, trailing: 0, added: 1, removed: 0 }]);
    assert.equal(reducedContextAllowed(append), true);
    assert.equal(reducedReverseCheckConclusive(append), true);
    const removal = "@@ -1,3 +1,2 @@\n requests\n click\n-six\n";
    assert.equal(reducedReverseCheckConclusive(removal), false, "bare context proves nothing");
    const bare = "@@ -0,0 +1,2 @@\n+a\n+b\n";
    assert.equal(reducedContextAllowed(bare), false);
    const twoHunks = "@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -10 +10,2 @@\n x\n+y\n\\ No newline at end of file\n";
    assert.deepEqual(patchHunks(twoHunks), [
      { leading: 1, trailing: 0, added: 1, removed: 1 },
      { leading: 1, trailing: 0, added: 1, removed: 0 },
    ]);
    assert.equal(reducedContextAllowed(""), false);
  });

  it("lists the files in a git diff and detects skipped paths", () => {
    const diff = "diff --git a/linkwatch/cache.py b/linkwatch/cache.py\n--- a/x\n+++ b/x\ndiff --git a/pyproject.toml b/pyproject.toml\n";
    assert.deepEqual(patchFiles(diff), ["linkwatch/cache.py", "pyproject.toml"]);
    assert.deepEqual(skippedPatchPaths("Skipped patch 'pkg/a.txt'.\nChecking patch b\n"), ["pkg/a.txt"]);
    assert.deepEqual(skippedPatchPaths("Checking patch b\n"), []);
  });

  it("builds a confirmation that labels VERIFIED and AI content", () => {
    const jinja = capsule(run, "jinja2");
    const sel = selectPatch(jinja);
    assert.ok(sel.ok);
    const text = applyConfirmationDetail(jinja, sel, ["pyproject.toml", "requirements.txt"]);
    assert.match(text, /Dependency: jinja2 \(risk 85, critical\)/);
    assert.match(text, /Status: VERIFIED/);
    assert.match(text, /Replacement: upgrade: jinja2 >=3\.1\.6,<4 \[VERIFIED E020, E021\]/);
    assert.match(text, /Analysis: .+\[AI\]/);
    assert.match(text, /Changes 2 file\(s\)/);

    const appdirs = capsule(run, "appdirs");
    const psel = selectPatch(appdirs);
    assert.ok(psel.ok);
    assert.match(applyConfirmationDetail(appdirs, psel, []), /Open concerns/);
    assert.match(partialWarningDetail(appdirs), /PARTIALLY VERIFIED[\s\S]*not reached by the test suite/);
  });
});

describe("diagnostic messages", () => {
  it("formats the declaration message", () => {
    const appdirs = capsule(run, "appdirs");
    const spec = declarationDiagnostic(appdirs);
    assert.ok(spec);
    assert.equal(spec.level, "warning");
    const top = topIndicator(appdirs);
    assert.ok(top);
    assert.equal(spec.code, top.code);
    assert.equal(
      spec.message,
      `DoxOps: appdirs at risk (score 30): ${top.title} [${provenanceLabel(top.provenance)}]`,
    );
    assert.equal(dependencyFromMessage(spec.message), "appdirs");
  });

  it("explains usage sites with the indicator that names them", () => {
    const requests = capsule(run, "requests");
    const site = requests.usage.find((u) => u.kind === "no-timeout");
    assert.ok(site);
    assert.equal(usageIndicator(requests, site)?.indicator.code, "NO_TIMEOUT");
    assert.equal(usageIndicator(requests, site)?.specific, true);
    const plainImport = requests.usage.find((u) => u.kind === "import");
    assert.ok(plainImport);
    const general = usageIndicator(requests, plainImport);
    assert.equal(general?.specific, false);
    assert.ok(general && !["NO_TIMEOUT", "PRIVATE_API", "MONKEYPATCH"].includes(general.indicator.code));
    const spec = usageDiagnostic(requests, site);
    assert.ok(spec);
    assert.equal(spec.code, "NO_TIMEOUT");
    assert.match(spec.message, /^DoxOps: requests no-timeout/);
    assert.match(spec.message, /\[OBSERVED\]/);
    assert.equal(dependencyFromMessage(spec.message), "requests");
    assert.equal(dependencyFromMessage("Something else"), null);
  });

  it("matches an indicator's file:line exactly, not as a prefix", () => {
    assert.equal(mentionsLocation("linkwatch/http_patch.py:14 `x`", "linkwatch/http_patch.py:1"), false);
    assert.equal(mentionsLocation("linkwatch/http_patch.py:14 `x`", "linkwatch/http_patch.py:14"), true);
    assert.equal(mentionsLocation("see /abs/linkwatch/a.py:3:5", "linkwatch/a.py:3"), true);
    assert.equal(mentionsLocation("xlinkwatch/a.py:3", "linkwatch/a.py:3"), false);
    assert.equal(mentionsLocation("a.py:30 and a.py:3.", "a.py:3"), true);
    const requests = capsule(run, "requests");
    const importLine = { ...requests.usage.find((u) => u.kind === "import")!, file: "linkwatch/http_patch.py", line: 1 };
    const explained = usageIndicator(requests, importLine);
    assert.equal(explained?.specific, false);
    assert.notEqual(explained?.indicator.code, "MONKEYPATCH");
  });

  it("collapses repeated sites on one line", () => {
    const jinja = capsule(run, "jinja2");
    const lines = jinja.usage.map((u) => `${u.file}:${u.line}`);
    const unique = uniqueUsageSites(jinja.usage);
    assert.equal(unique.length, new Set(lines).size);
    assert.ok(unique.length < jinja.usage.length);
  });

  it("emits nothing for dependencies that are not at risk", () => {
    const safe: Capsule = { ...capsule(run, "six"), risk: { score: 0, severity: "none", atRisk: false, indicators: [] } };
    assert.equal(declarationDiagnostic(safe), null);
    assert.equal(usageDiagnostic(safe, { ...capsule(run, "jinja2").usage[0]! }), null);
  });
});

describe("output folder location", () => {
  it("allows folders the CLI does not copy, and folders outside the workspace", () => {
    assert.equal(outputDirInsideWorkspaceIsSafe("results"), false);
    assert.equal(outputDirInsideWorkspaceIsSafe(""), false, "the workspace folder itself");
    assert.equal(outputDirInsideWorkspaceIsSafe("."), false);
    assert.equal(outputDirInsideWorkspaceIsSafe("doxops-out"), true);
    assert.equal(outputDirInsideWorkspaceIsSafe("build/.doxops/runs"), true);
    assert.equal(outputDirInsideWorkspaceIsSafe("..\\elsewhere"), true);
    assert.equal(outputDirInsideWorkspaceIsSafe("../elsewhere"), true);
  });
});

describe("CLI arguments", () => {
  const settings = { provider: "ollama" as const, model: "", pythons: ["3.12", "3.13"], maxDeps: 0 };

  it("builds scan, run and doctor argument arrays", () => {
    assert.deepEqual(buildScanArgs("/ws", "/out", settings), [
      "scan", "/ws", "--out", "/out", "--python", "3.12", "--python", "3.13",
    ]);
    assert.deepEqual(buildRunArgs("/ws", "/out", settings), [
      "run", "/ws", "--out", "/out", "--provider", "ollama", "--python", "3.12", "--python", "3.13",
    ]);
    assert.deepEqual(
      buildRunArgs("/w s", "/o", { provider: "gemini", model: " gemma-4-26b-a4b-it ", pythons: ["3.13", "bad", "3.13"], maxDeps: 4.7 }),
      ["run", "/w s", "--out", "/o", "--provider", "gemini", "--model", "gemma-4-26b-a4b-it", "--python", "3.13", "--max-deps", "4"],
    );
    assert.deepEqual(buildDoctorArgs({ ...settings, model: "gemma4:e4b" }), [
      "doctor", "--provider", "ollama", "--model", "gemma4:e4b", "--python", "3.12", "--python", "3.13",
    ]);
    assert.deepEqual(validPythons(["3.12", " 3.13 ", "3", "x.y"]), { valid: ["3.12", "3.13"], invalid: ["3", "x.y"] });
  });

  it("lists workspace virtualenv candidates per platform", () => {
    assert.deepEqual(workspaceExecutableCandidates("/ws/", "linux"), ["/ws/doxops/.venv/bin/doxops", "/ws/.venv/bin/doxops"]);
    assert.deepEqual(workspaceExecutableCandidates("C:\\ws", "win32"), [
      "C:\\ws\\doxops\\.venv\\Scripts\\doxops.exe",
      "C:\\ws\\doxops\\.venv\\bin\\doxops",
      "C:\\ws\\.venv\\Scripts\\doxops.exe",
      "C:\\ws\\.venv\\bin\\doxops",
    ]);
  });

  it("formats timestamps and cleans output", () => {
    assert.equal(runTimestamp(new Date(2026, 9, 15, 8, 3, 9)), "20261015-080309");
    assert.equal(stripAnsi("\u001b[1;32mOK\u001b[0m done"), "OK done");
    assert.equal(redactSecrets("key=abcdef123 and abcdef123", ["abcdef123"]), "key=*** and ***");
    assert.equal(redactSecrets("short", ["abc"]), "short");
  });

  it("redacts a secret split across stream chunks", () => {
    const key = "AIzaSyExampleKey0123456789";
    const r = new StreamRedactor([key]);
    const streamed = r.push(`key=${key.slice(0, 10)}`) + r.push(`${key.slice(10)} done\n`) + r.flush();
    assert.equal(streamed, "key=*** done\n");
    const plain = new StreamRedactor([]);
    assert.equal(plain.push("abc"), "abc", "nothing is held back without secrets");
    assert.equal(plain.flush(), "");
  });
});

describe("report CSP", () => {
  const csp = buildCsp("vscode-webview://abc");

  it("is strict", () => {
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
  });

  it("is injected first in <head> and keeps an existing policy", () => {
    const html = '<!doctype html><html lang="en"><HEAD data-x="1"><meta http-equiv="Content-Security-Policy" content="img-src *"><title>t</title></head><body></body></html>';
    const out = injectCsp(html, csp);
    const ours = out.indexOf(`content="${csp.replace(/'/g, "'")}"`);
    const theirs = out.indexOf('content="img-src *"');
    assert.ok(ours > 0 && theirs > ours, "our policy comes first and theirs is kept, so both apply");
    assert.equal(injectCsp("<p>x</p>", csp).startsWith("<!doctype html><html><head><meta"), true);
    assert.match(injectCsp("<html><body></body></html>", csp), /^<html>\n<head><meta http-equiv/);
  });

  it("works on the real report.html shape", () => {
    const out = injectCsp('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">', csp);
    assert.match(out, /<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  });
});
