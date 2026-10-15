// Not shipped and not part of `npm test`: runs the real browser-scan core against a live
// repository over the network and prints the ranked list. Usage: node dist-test/smoke.mjs owner/repo
import { analyzeRepository } from "../src/core/analyze.js";

const arg = process.argv[2] ?? "rishrek/LinkWatch";
const [owner, repo] = arg.split("/");
if (!owner || !repo) {
  console.error("usage: node dist-test/smoke.mjs owner/repo");
  process.exit(2);
}
const started = Date.now();
const result = await analyzeRepository({ owner, repo, ref: null });
console.log(`${owner}/${repo} @ ${result.ref}: status=${result.status} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (result.message) console.log(`message: ${result.message}`);
console.log(`files: ${result.filesRead.join(", ")}`);
console.log(`${result.dependencyCount} dependencies, ${result.atRiskCount} at risk, worst=${result.worstSeverity}`);
for (const r of result.risks) {
  const codes = r.indicators.map((i) => `${i.code}(${i.weight})`).join(" ");
  console.log(`${String(r.score).padStart(3)} ${r.severity.padEnd(8)} ${r.name.padEnd(16)} ${(r.pinnedVersion ?? "-").padEnd(9)} -> ${(r.latestVersion ?? "-").padEnd(9)} ${codes}`);
}
for (const w of [...result.warnings, ...result.indexErrors]) console.log(`note: ${w}`);
