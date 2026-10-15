// Service worker: the only place that talks to the network. Content scripts and the popup send
// {type: "analyze", owner, repo, ref}; results are deduplicated per repository and cached in
// chrome.storage.session (cleared when the browser closes).

import { analyzeRepository } from "../core/analyze.js";
import { asAnalyzeRequest, type AnalyzeResponse } from "../core/messages.js";
import { CACHE_TTL_MS, PyPIClient, TtlCache, type StorageBackend } from "../core/pypi.js";
import { repoKey } from "../core/repo.js";
import type { AnalysisResult, ProjectLookup } from "../core/types.js";

/** Repository results are reused for a short while so the badge and popup agree without refetching. */
const RESULT_TTL_MS = 10 * 60 * 1000;

const sessionBackend: StorageBackend = {
  async get(key) {
    const items = await chrome.storage.session.get(key);
    return items[key];
  },
  async set(key, value) {
    await chrome.storage.session.set({ [key]: value });
  },
};

const pypi = new PyPIClient({ cache: new TtlCache<ProjectLookup>(sessionBackend, "pypi:", CACHE_TTL_MS) });
const results = new TtlCache<AnalysisResult>(sessionBackend, "repo:", RESULT_TTL_MS);
const inflight = new Map<string, Promise<AnalysisResult>>();

function trustedSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}/`;
  if (sender.url?.startsWith(extensionOrigin)) return true; // popup
  const pageUrl = sender.tab?.url ?? sender.url ?? "";
  try {
    return new URL(pageUrl).origin === "https://github.com"; // our content script on github.com
  } catch {
    return false;
  }
}

async function analyze(owner: string, repo: string, ref: string | null, force: boolean): Promise<AnalysisResult> {
  const key = repoKey({ owner, repo, ref });
  if (!force) {
    const cached = await results.get(key);
    if (cached) return cached;
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = analyzeRepository({ owner, repo, ref }, { pypi })
    .then(async (result) => {
      // Do not cache transient failures.
      if (result.status !== "error" && result.indexErrors.length === 0) await results.set(key, result);
      return result;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (r: AnalyzeResponse) => void) => {
  const req = asAnalyzeRequest(message);
  if (!req) return false;
  if (!trustedSender(sender)) {
    sendResponse({ ok: false, error: "Rejected: message did not come from this extension or github.com." });
    return false;
  }
  analyze(req.owner, req.repo, req.ref, req.force === true)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // keep the channel open for the async response
});

// Allow the session cache to be read only by the extension's own pages and worker.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => undefined);
});
