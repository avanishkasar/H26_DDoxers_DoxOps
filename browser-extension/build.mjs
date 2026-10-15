// Build: bundles the extension into dist/ (and, with --test, the node tests into dist-test/).
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIcons } from "./scripts/icons.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const testMode = process.argv.includes("--test");

const common = { bundle: true, sourcemap: false, minify: false, legalComments: "none", logLevel: "warning" };

if (testMode) {
  const out = join(root, "dist-test");
  rmSync(out, { recursive: true, force: true });
  const entries = readdirSync(join(root, "test"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(root, "test", f));
  await build({
    ...common,
    entryPoints: entries,
    outdir: out,
    outExtension: { ".js": ".mjs" },
    format: "esm",
    platform: "node",
    target: "node20",
    packages: "external",
  });
  console.log(`built ${entries.length} test/smoke file(s) into dist-test/`);
} else {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const browser = { ...common, platform: "browser", target: ["chrome116"] };
  await build({ ...browser, entryPoints: [join(root, "src/background/index.ts")], outfile: join(dist, "background.js"), format: "esm" });
  await build({ ...browser, entryPoints: [join(root, "src/popup/index.ts")], outfile: join(dist, "popup.js"), format: "iife" });
  await build({ ...browser, entryPoints: [join(root, "src/content/index.ts")], outfile: join(dist, "content.js"), format: "iife" });
  for (const f of ["manifest.json", "popup.html", "popup.css"]) copyFileSync(join(root, "static", f), join(dist, f));
  writeIcons(join(dist, "icons"));
  console.log("built dist/ (background.js, popup.js, content.js, popup.html, manifest.json, icons)");
}
