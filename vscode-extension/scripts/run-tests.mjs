// Runs every compiled test file with node:test. Passing explicit files works the same on
// Node 20 (which accepts directories) and Node 22+ (which expects files or globs) on every OS.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join("out", "test");
let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort().map((f) => join(dir, f));
} catch {
  files = [];
}
if (files.length === 0) {
  console.error(`No compiled tests found in ${dir}; run "npm run compile" first.`);
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
