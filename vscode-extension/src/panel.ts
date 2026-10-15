import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { PanelSummary } from "./model";

/** Everything the DoxOps panel shows. Plain JSON: the webview renders it as text only. */
export interface PanelState {
  readonly running: boolean;
  readonly target: string;
  readonly workspaceName: string | null;
  readonly provider: "ollama" | "gemini";
  readonly model: string;
  readonly pythons: readonly string[];
  readonly executable: string;
  readonly summary: PanelSummary | null;
  /** Folder the loaded results belong to, when it is not open in this window. */
  readonly openableFolder: string | null;
}

export type PanelMessage =
  | { readonly type: "ready" }
  | { readonly type: "scan" | "run"; readonly target: string }
  | { readonly type: "load" | "report" | "doctor" | "browseCli" | "setKey" | "openFolder" | "applyAll" | "output" }
  | { readonly type: "apply" | "capsule"; readonly dependency: string }
  | { readonly type: "settings"; readonly provider: string; readonly model: string; readonly pythons: readonly string[] };

const MESSAGE_TYPES = new Set([
  "ready", "scan", "run", "load", "report", "doctor", "browseCli", "setKey", "openFolder", "applyAll", "output", "apply", "capsule", "settings",
]);

/** Accept only well-formed messages; the webview is ours, but its input is still user text. */
export function parsePanelMessage(raw: unknown): PanelMessage | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const m = raw as Record<string, unknown>;
  if (typeof m["type"] !== "string" || !MESSAGE_TYPES.has(m["type"])) {
    return null;
  }
  const type = m["type"];
  if (type === "scan" || type === "run") {
    return typeof m["target"] === "string" && m["target"].length <= 2048 ? { type, target: m["target"] } : null;
  }
  if (type === "apply" || type === "capsule") {
    return typeof m["dependency"] === "string" && m["dependency"].length <= 200 ? { type, dependency: m["dependency"] } : null;
  }
  if (type === "settings") {
    const pythons = Array.isArray(m["pythons"]) ? m["pythons"].filter((p): p is string => typeof p === "string").slice(0, 8) : [];
    return typeof m["provider"] === "string" && typeof m["model"] === "string" && m["model"].length <= 200
      ? { type, provider: m["provider"], model: m["model"], pythons }
      : null;
  }
  return { type } as PanelMessage;
}

export class DoxOpsPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "doxops.home";
  private view: vscode.WebviewView | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getState: () => PanelState,
    private readonly onMessage: (message: PanelMessage) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] };
    view.webview.html = panelHtml(view.webview.cspSource, randomBytes(16).toString("base64"));
    this.disposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parsePanelMessage(raw);
        if (message?.type === "ready") {
          this.refresh();
        } else if (message) {
          this.onMessage(message);
        }
      }),
      view.onDidDispose(() => {
        this.view = null;
      }),
    );
  }

  refresh(): void {
    if (this.view) {
      void this.view.webview.postMessage({ type: "state", state: this.getState() });
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function panelHtml(cspSource: string, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource}`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { padding: 0 12px 16px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  h2 { font-size: 1.05em; margin: 14px 0 6px; }
  p.hint { color: var(--vscode-descriptionForeground); margin: 4px 0 8px; line-height: 1.4; }
  label { display: block; margin: 8px 0 3px; color: var(--vscode-descriptionForeground); }
  input[type=text], select { width: 100%; box-sizing: border-box; padding: 4px 6px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  input[type=text]:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  button { width: 100%; margin: 4px 0; padding: 6px; border: none; border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .row { display: flex; gap: 6px; } .row > * { flex: 1; }
  .checks { display: flex; gap: 12px; } .checks label { display: inline-flex; gap: 4px; margin: 0; color: var(--vscode-foreground); }
  .kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 8px 0; }
  .kpi { padding: 6px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
  .kpi b { display: block; font-size: 1.4em; }
  .dep { padding: 6px 0; border-top: 1px solid var(--vscode-panel-border); }
  .dep-head { display: flex; justify-content: space-between; gap: 6px; align-items: baseline; }
  .dep-name { font-weight: 600; font-family: var(--vscode-editor-font-family); }
  .muted { color: var(--vscode-descriptionForeground); }
  .badge { display: inline-block; padding: 0 5px; margin-right: 4px; border-radius: 3px; font-size: 0.8em; font-weight: 600; border: 1px solid; }
  .b-OBSERVED { color: var(--vscode-charts-blue); } .b-VERIFIED { color: var(--vscode-charts-green); } .b-AI { color: var(--vscode-charts-purple); }
  .s-critical, .s-high { color: var(--vscode-errorForeground); } .s-medium { color: var(--vscode-charts-yellow); } .s-low { color: var(--vscode-descriptionForeground); }
  .links { display: flex; gap: 10px; margin-top: 4px; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; } a:hover { text-decoration: underline; }
  .busy { padding: 6px; margin: 8px 0; border-left: 3px solid var(--vscode-progressBar-background); }
  .hidden { display: none; }
</style>
</head>
<body>
  <h2>1. Choose a repository</h2>
  <label for="target">GitHub URL or folder path</label>
  <input id="target" type="text" placeholder="https://github.com/rishrek/LinkWatch" spellcheck="false">
  <p class="hint" id="targetHint">Leave empty to use the open folder. A GitHub URL is cloned into DoxOps' own storage first.</p>

  <h2>2. Find or fix</h2>
  <button id="scan">Find problems (scan, no AI)</button>
  <button id="run">Find and fix with Gemma 4</button>
  <p class="hint">Fixing plans each migration with Gemma 4, applies it to a throwaway copy and re-runs the tests on every Python below. Only proven fixes can be applied.</p>
  <div id="busy" class="busy hidden">DoxOps is running. Progress is in the notification and the DoxOps output.</div>

  <details>
    <summary>Settings</summary>
    <label for="provider">Model provider</label>
    <select id="provider">
      <option value="ollama">Ollama (local Gemma 4)</option>
      <option value="gemini">Gemini API (hosted Gemma 4)</option>
    </select>
    <label for="model">Model id (empty: default)</label>
    <input id="model" type="text" placeholder="gemma4:e4b" spellcheck="false">
    <label>Verify on Python</label>
    <div class="checks">
      <label><input type="checkbox" class="py" value="3.12"> 3.12</label>
      <label><input type="checkbox" class="py" value="3.13"> 3.13</label>
    </div>
    <label>DoxOps CLI</label>
    <p class="hint" id="cli"></p>
    <div class="row">
      <button class="secondary" id="browseCli">Choose CLI…</button>
      <button class="secondary" id="doctor">Check setup</button>
    </div>
    <button class="secondary" id="setKey">Set Gemini API key…</button>
  </details>

  <h2>3. Results</h2>
  <div id="empty">
    <p class="hint">No results yet. Scan or fix a repository, or load a folder from an earlier run.</p>
  </div>
  <div id="results" class="hidden">
    <p class="hint" id="resTarget"></p>
    <div class="kpis">
      <div class="kpi"><b id="kAtRisk">0</b>at risk of <span id="kAnalysed">0</span></div>
      <div class="kpi"><b id="kVerified">0</b>fixes verified</div>
      <div class="kpi"><b id="kPartial">0</b>partially verified</div>
      <div class="kpi"><b id="kUnverified">0</b>not verified</div>
    </div>
    <p class="hint" id="together"></p>
    <div class="row">
      <button id="report">Open report</button>
      <button class="secondary" id="applyAll">Apply all fixes</button>
    </div>
    <button class="secondary hidden" id="openFolder">Open this repository in a new window</button>
    <div id="deps"></div>
  </div>
  <button class="secondary" id="load">Load results folder…</button>
  <button class="secondary" id="output">Show DoxOps output</button>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const saved = vscode.getState() || {};
  let state = null;

  function send(msg) { vscode.postMessage(msg); }
  function settings() {
    const pythons = Array.from(document.querySelectorAll(".py")).filter((c) => c.checked).map((c) => c.value);
    send({ type: "settings", provider: $("provider").value, model: $("model").value, pythons });
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function link(text, onClick) { const a = el("a", "", text); a.addEventListener("click", onClick); return a; }

  $("target").value = saved.target || "";
  $("target").addEventListener("input", () => vscode.setState({ ...(vscode.getState() || {}), target: $("target").value }));
  $("scan").addEventListener("click", () => send({ type: "scan", target: $("target").value }));
  $("run").addEventListener("click", () => send({ type: "run", target: $("target").value }));
  for (const id of ["load", "report", "doctor", "browseCli", "setKey", "openFolder", "applyAll", "output"]) {
    $(id).addEventListener("click", () => send({ type: id }));
  }
  $("provider").addEventListener("change", settings);
  $("model").addEventListener("change", settings);
  document.querySelectorAll(".py").forEach((c) => c.addEventListener("change", settings));

  function render() {
    if (!state) return;
    $("scan").disabled = state.running;
    $("run").disabled = state.running;
    $("busy").classList.toggle("hidden", !state.running);
    $("targetHint").textContent = state.workspaceName
      ? "Leave empty to use the open folder (" + state.workspaceName + "). A GitHub URL is cloned into DoxOps' own storage first."
      : "No folder is open: paste a GitHub URL or an absolute folder path.";
    $("provider").value = state.provider;
    if (document.activeElement !== $("model")) $("model").value = state.model;
    document.querySelectorAll(".py").forEach((c) => { c.checked = state.pythons.includes(c.value); });
    $("cli").textContent = state.executable ? state.executable : "Auto-detect: doxops on PATH, then doxops/.venv in the folder.";

    const s = state.summary;
    $("empty").classList.toggle("hidden", !!s);
    $("results").classList.toggle("hidden", !s);
    $("openFolder").classList.toggle("hidden", !state.openableFolder);
    if (!s) return;
    $("resTarget").textContent = (s.kind === "scan" ? "Scan of " : "Fix run on ") + s.target +
      (s.model ? " · " + s.model : "") + (s.pythons.length ? " · Python " + s.pythons.join(", ") : "");
    $("kAtRisk").textContent = String(s.atRisk);
    $("kAnalysed").textContent = String(s.analysed);
    $("kVerified").textContent = String(s.verified);
    $("kPartial").textContent = String(s.partiallyVerified);
    $("kUnverified").textContent = String(s.unverified);
    $("together").textContent = s.fixedTogether === null ? (s.kind === "scan" ? "Scan only: run \\"Find and fix\\" for verified fixes." : "")
      : "All accepted fixes together: " + s.fixedTogether + " failing test(s) fixed, " + s.regressedTogether + " regressed.";
    $("applyAll").disabled = s.applicable === 0;
    const deps = $("deps");
    deps.replaceChildren();
    for (const d of s.dependencies) {
      const box = el("div", "dep");
      const head = el("div", "dep-head");
      head.append(el("span", "dep-name", d.name), el("span", "s-" + d.severity, d.score + " " + d.severity));
      box.append(head);
      const status = el("div", "muted", "status: " + d.status);
      box.append(status);
      if (d.reason) {
        const r = el("div");
        r.append(el("span", "badge b-" + d.reasonLabel, d.reasonLabel), document.createTextNode(d.reason));
        box.append(r);
      }
      if (d.replacement) {
        const r = el("div");
        r.append(el("span", "badge b-" + d.replacementLabel, d.replacementLabel), document.createTextNode(d.replacement));
        box.append(r);
      }
      const links = el("div", "links");
      links.append(link("Details", () => send({ type: "capsule", dependency: d.name })));
      if (d.applicable) links.append(link("Apply fix", () => send({ type: "apply", dependency: d.name })));
      box.append(links);
      deps.append(box);
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.type === "state") { state = msg.state; render(); }
    if (msg && msg.type === "setTarget" && typeof msg.target === "string") { $("target").value = msg.target; }
  });
  send({ type: "ready" });
})();
</script>
</body>
</html>`;
}
