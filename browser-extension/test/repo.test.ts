import assert from "node:assert/strict";
import { test } from "node:test";
import { cliCommand, parseRepoUrl, repoKey, vscodeCloneLink } from "../src/core/repo.js";

test("detects owner/repo on repository pages", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/rishrek/LinkWatch"), { owner: "rishrek", repo: "LinkWatch", ref: null });
  assert.deepEqual(parseRepoUrl("https://github.com/rishrek/LinkWatch/"), { owner: "rishrek", repo: "LinkWatch", ref: null });
  assert.deepEqual(parseRepoUrl("https://github.com/rishrek/LinkWatch/issues/3?q=1#x"), { owner: "rishrek", repo: "LinkWatch", ref: null });
  assert.deepEqual(parseRepoUrl("https://github.com/pallets/jinja.git"), { owner: "pallets", repo: "jinja", ref: null });
  assert.deepEqual(parseRepoUrl("https://www.github.com/a-b/c.d_e"), { owner: "a-b", repo: "c.d_e", ref: null });
});

test("extracts the ref from /tree and /blob URLs", () => {
  assert.equal(parseRepoUrl("https://github.com/o/r/tree/main")?.ref, "main");
  assert.equal(parseRepoUrl("https://github.com/o/r/tree/v1.2.3/src")?.ref, "v1.2.3");
  assert.equal(parseRepoUrl("https://github.com/o/r/blob/dev/requirements.txt")?.ref, "dev");
  assert.equal(parseRepoUrl("https://github.com/o/r/blob/0123abcd/a/b.py")?.ref, "0123abcd");
  assert.equal(parseRepoUrl("https://github.com/o/r/pulls")?.ref, null);
  assert.equal(parseRepoUrl("https://github.com/o/r/tree")?.ref, null);
});

test("ignores reserved paths, profiles, other hosts and garbage", () => {
  for (const url of [
    "https://github.com/settings/profile",
    "https://github.com/orgs/python/repositories",
    "https://github.com/marketplace/actions",
    "https://github.com/topics/python",
    "https://github.com/explore",
    "https://github.com/notifications",
    "https://github.com/login",
    "https://github.com/sponsors/someone",
    "https://github.com/rishrek",
    "https://github.com/",
    "https://gist.github.com/a/b",
    "https://gitlab.com/a/b",
    "ftp://github.com/a/b",
    "not a url",
    "https://github.com/-bad/repo",
    "https://github.com/o/..",
  ]) {
    assert.equal(parseRepoUrl(url), null, url);
  }
});

test("links and keys", () => {
  assert.equal(cliCommand("rishrek", "LinkWatch"), "doxops run https://github.com/rishrek/LinkWatch");
  assert.equal(vscodeCloneLink("rishrek", "LinkWatch"), "vscode://vscode.git/clone?url=https%3A%2F%2Fgithub.com%2Frishrek%2FLinkWatch.git");
  assert.equal(repoKey({ owner: "A", repo: "B", ref: null }), "a/b@HEAD");
});
