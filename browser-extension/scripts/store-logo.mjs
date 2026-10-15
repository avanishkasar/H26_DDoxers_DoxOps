// Writes store/logo-300.png, the 300x300 store logo Partner Center asks for. Same shield as the
// toolbar icon (scripts/icons.mjs), rendered at 300 px with node:zlib only.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "./icons.mjs";

const store = join(dirname(fileURLToPath(import.meta.url)), "..", "store");
mkdirSync(store, { recursive: true });
writeFileSync(join(store, "logo-300.png"), render(300));
console.log("wrote store/logo-300.png (300x300)");
