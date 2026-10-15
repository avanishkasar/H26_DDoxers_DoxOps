// In-page badge on github.com repository pages. Lives in a closed shadow root so GitHub's CSS
// and scripts cannot reach it; shows nothing at all on non-repo pages or non-Python repos.

import type { AnalyzeRequest, AnalyzeResponse } from "../core/messages.js";
import { parseRepoUrl, repoKey } from "../core/repo.js";
import type { AnalysisResult, RepoRef } from "../core/types.js";
import { el, footerNote, resultView, styleElement, summaryLine } from "../ui/render.js";
import { CONTENT_CSS, CSS } from "../ui/styles.js";

const HOST_ID = "doxops-for-github-root";
const DEBOUNCE_MS = 400;

interface Mounted {
  host: HTMLElement;
  key: string;
}

let mounted: Mounted | null = null;
let currentKey: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastUrl = location.href;

function unmount(): void {
  mounted?.host.remove();
  mounted = null;
  document.getElementById(HOST_ID)?.remove();
}

function render(result: AnalysisResult, key: string): void {
  unmount();
  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.append(styleElement(CSS + CONTENT_CSS));

  const atRisk = result.atRiskCount;
  const severity = atRisk > 0 ? result.worstSeverity : "none";
  const pill = el("button", "dx-pill", el("span", `dx-dot dx-sev-${severity}`), `DoxOps: ${atRisk} at risk`);
  pill.setAttribute("aria-expanded", "false");
  pill.title = `${summaryLine(result)} (browser scan, observed only)`;

  const close = el("button", "dx-close", "×");
  close.setAttribute("aria-label", "Close");
  const panel = el(
    "div",
    "dx-panel",
    el("div", "dx-panel-head", el("h1", null, `${result.owner}/${result.repo}`), close),
    resultView(result, { onlyFlagged: true, limit: 12 }),
    footerNote(),
  );
  panel.hidden = true;
  const toggle = (open: boolean): void => {
    panel.hidden = !open;
    pill.setAttribute("aria-expanded", String(open));
  };
  pill.addEventListener("click", () => toggle(panel.hidden));
  close.addEventListener("click", () => toggle(false));

  shadow.append(el("div", "dx dx-auto dx-fab", panel, pill));
  document.documentElement.append(host);
  mounted = { host, key };
}

function request(target: RepoRef): Promise<AnalyzeResponse> {
  const msg: AnalyzeRequest = { type: "analyze", owner: target.owner, repo: target.repo, ref: target.ref };
  return chrome.runtime.sendMessage<AnalyzeRequest, AnalyzeResponse>(msg).then(
    (r) => r ?? { ok: false, error: "no response" },
    (err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
}

async function check(): Promise<void> {
  const target = parseRepoUrl(location.href);
  if (!target) {
    currentKey = null;
    unmount();
    return;
  }
  const key = repoKey(target);
  if (key === currentKey && (mounted?.key === key || mounted === null)) return; // same repo: nothing to do
  currentKey = key;
  if (mounted && mounted.key !== key) unmount();
  const resp = await request(target);
  if (currentKey !== key) return; // the user navigated away while we were scanning
  // Show nothing rather than noise: no badge for errors, private repos, or non-Python repos.
  if (!resp.ok || resp.result.status !== "ok" || resp.result.dependencyCount === 0) {
    unmount();
    return;
  }
  render(resp.result, key);
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void check().catch(() => unmount());
  }, DEBOUNCE_MS);
}

function onPossibleNavigation(): void {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  schedule();
}

function init(): void {
  // GitHub is a single-page app: watch Turbo navigation, history changes and title changes.
  document.addEventListener("turbo:load", onPossibleNavigation);
  window.addEventListener("popstate", onPossibleNavigation);
  const titleObserver = new MutationObserver(onPossibleNavigation);
  const title = document.querySelector("head > title");
  if (title) titleObserver.observe(title, { childList: true, characterData: true, subtree: true });
  if (document.head) titleObserver.observe(document.head, { childList: true });
  schedule();
}

// Guard against double injection (the same isolated world can run this file twice after updates).
const flags = window as unknown as Record<string, unknown>;
if (!flags["__doxopsForGithubLoaded"]) {
  flags["__doxopsForGithubLoaded"] = true;
  init();
}
