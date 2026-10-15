import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("src/core is pure: no chrome.* APIs and no DOM access", () => {
  const dir = new URL("../src/core/", import.meta.url);
  for (const f of readdirSync(dir)) {
    const text = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(text, /\bchrome\./, f);
    assert.doesNotMatch(text, /\bdocument\.|\bwindow\./, f);
  }
});

test("no innerHTML, eval or remote code in extension sources", () => {
  const dirs = ["background", "content", "popup", "ui", "core"];
  for (const d of dirs) {
    const dir = new URL(`../src/${d}/`, import.meta.url);
    for (const f of readdirSync(dir)) {
      const text = readFileSync(new URL(f, dir), "utf8");
      assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function\(/, `${d}/${f}`);
    }
  }
});
