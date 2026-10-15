import { capsuleMatchesRepo, MAX_CAPSULE_BYTES, parseCapsule } from "../core/capsule.js";
import type { AnalyzeRequest, AnalyzeResponse } from "../core/messages.js";
import { cliCommand, parseRepoUrl, vscodeCloneLink } from "../core/repo.js";
import type { RepoRef } from "../core/types.js";
import { capsuleView, el, footerNote, loadingView, resultView, styleElement } from "../ui/render.js";
import { CSS } from "../ui/styles.js";

const app = document.getElementById("app") as HTMLDivElement;
document.head.append(styleElement(CSS));

/** popup.html?owner=..&repo=..[&ref=..] scans a given repository (used for testing and screenshots). */
function targetFromQuery(): RepoRef | null {
  const q = new URLSearchParams(location.search);
  const owner = q.get("owner");
  const repo = q.get("repo");
  if (!owner || !repo) return null;
  return parseRepoUrl(`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${q.get("ref") ? `/tree/${encodeURIComponent(q.get("ref")!)}` : ""}`);
}

async function targetFromActiveTab(): Promise<RepoRef | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url ? parseRepoUrl(tab.url) : null;
  } catch {
    return null;
  }
}

function header(target: RepoRef | null): HTMLElement {
  const icon = el("img");
  icon.src = "icons/icon48.png";
  icon.alt = "";
  const titles = el(
    "div",
    "dx-titles",
    el("h1", null, "DoxOps for GitHub"),
    target ? el("div", "dx-repo", `${target.owner}/${target.repo}${target.ref ? ` @ ${target.ref}` : ""}`) : null,
  );
  return el("div", "dx-header", icon, titles);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function sendAnalyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  return chrome.runtime.sendMessage<AnalyzeRequest, AnalyzeResponse>(req).then(
    (r) => r ?? { ok: false, error: "No response from the background worker." },
    (err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
}

async function main(): Promise<void> {
  const target = targetFromQuery() ?? (await targetFromActiveTab());
  app.replaceChildren(header(target));
  if (!target) {
    app.append(el("div", "dx-msg", "Open a GitHub repository page, then click the DoxOps icon to scan its Python dependencies."));
    app.append(footerNote());
    return;
  }

  const toast = el("div", "dx-toast");
  const fix = el("button", "dx-primary", "Fix in VS Code");
  fix.title = "Open this repository in VS Code (it clones it). Then use the DoxOps Start panel: Find problems, or Find and fix";
  fix.addEventListener("click", () => {
    void chrome.tabs.create({ url: vscodeCloneLink(target.owner, target.repo) });
  });
  const copy = el("button", null, "Copy CLI command");
  const command = cliCommand(target.owner, target.repo);
  copy.title = command;
  copy.addEventListener("click", () => {
    void copyText(command).then((ok) => {
      toast.textContent = ok ? `Copied: ${command}` : `Copy failed. Command: ${command}`;
    });
  });
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.hidden = true;
  const fileLabel = el("label", "dx-file-label", "Load capsule.json", fileInput);
  const rescan = el("button", null, "Rescan");

  const resultBox = el("div");
  const capsuleBox = el("div");
  app.append(el("div", "dx-actions", fix, copy, fileLabel, rescan), toast, capsuleBox, resultBox, footerNote());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (file.size > MAX_CAPSULE_BYTES) {
      capsuleBox.replaceChildren(el("div", "dx-msg", "That file is too large to be a capsule.json."));
      return;
    }
    void file.text().then(
      (text) => {
        const parsed = parseCapsule(text);
        if (!parsed.ok) {
          capsuleBox.replaceChildren(el("div", "dx-msg", `Could not load capsule: ${parsed.error}`));
          return;
        }
        if (!capsuleMatchesRepo(parsed.capsule, target.owner, target.repo)) {
          capsuleBox.replaceChildren(
            el("div", "dx-msg", `This capsule is for ${parsed.capsule.source}, not ${target.owner}/${target.repo}.`),
          );
          return;
        }
        capsuleBox.replaceChildren(capsuleView(parsed.capsule));
      },
      () => capsuleBox.replaceChildren(el("div", "dx-msg", "Could not read that file.")),
    );
  });

  const run = async (force: boolean): Promise<void> => {
    rescan.disabled = true;
    resultBox.replaceChildren(el("h2", null, "Browser scan"), loadingView("Reading manifests and PyPI metadata…"));
    const resp = await sendAnalyze({ type: "analyze", owner: target.owner, repo: target.repo, ref: target.ref, force });
    rescan.disabled = false;
    if (!resp.ok) {
      resultBox.replaceChildren(el("h2", null, "Browser scan"), el("div", "dx-msg", `Scan failed: ${resp.error}`));
      return;
    }
    resultBox.replaceChildren(el("h2", null, "Browser scan (observed)"), resultView(resp.result));
  };
  rescan.addEventListener("click", () => void run(true));
  await run(false);
}

void main();
