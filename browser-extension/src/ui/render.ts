// DOM rendering shared by the popup and the in-page panel. Elements are built with
// createElement/textContent only: fetched data (package names, PyPI text, capsule text) is
// never interpreted as HTML.

import type { CapsuleSummary } from "../core/capsule.js";
import type { AnalysisResult, DependencyRisk, RiskIndicator } from "../core/types.js";

export const FOOTER_NOTE = "Browser scan only. Run DoxOps locally to verify fixes with tests.";

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function badge(provenance: string): HTMLSpanElement {
  const p = ["observed", "verified", "ai"].includes(provenance) ? provenance : "observed";
  return el("span", `dx-badge dx-badge-${p}`, p.toUpperCase());
}

export function summaryLine(result: AnalysisResult): string {
  const deps = `${result.dependencyCount} ${result.dependencyCount === 1 ? "dependency" : "dependencies"}`;
  return `${deps}, ${result.atRiskCount} at risk`;
}

function indicatorItem(i: RiskIndicator): HTMLLIElement {
  return el(
    "li",
    null,
    badge(i.provenance),
    el("span", "dx-ind-title", `${i.title} (+${i.weight})`),
    i.detail ? el("span", "dx-ind-detail", i.detail) : null,
  );
}

function versionText(r: DependencyRisk): string {
  if (r.pinnedVersion && r.latestVersion && r.pinnedVersion !== r.latestVersion) return `${r.pinnedVersion} → ${r.latestVersion}`;
  if (r.pinnedVersion) return `==${r.pinnedVersion}`;
  if (r.latestVersion) return `latest ${r.latestVersion}`;
  return "";
}

export interface ListOptions {
  /** Hide dependencies with no indicators (the in-page panel stays short). */
  onlyFlagged?: boolean;
  limit?: number;
}

export function riskList(result: AnalysisResult, opts: ListOptions = {}): HTMLElement {
  let risks = [...result.risks].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  if (opts.onlyFlagged) risks = risks.filter((r) => r.indicators.length > 0);
  const hidden = opts.limit !== undefined && risks.length > opts.limit ? risks.length - opts.limit : 0;
  if (opts.limit !== undefined) risks = risks.slice(0, opts.limit);
  const list = el("ul", "dx-list");
  for (const r of risks) {
    const head = el(
      "div",
      "dx-dep-head",
      el("span", "dx-name", r.name),
      el("span", "dx-ver", versionText(r)),
      el("span", `dx-score dx-sev-${r.severity}`, `${r.score} ${r.severity}`),
    );
    const item = el("li", `dx-dep dx-sev-${r.severity}`, head);
    item.title = `Declared in ${r.declaredIn.join(", ")}`;
    if (r.indicators.length > 0) {
      const ul = el("ul", "dx-ind");
      for (const i of r.indicators) ul.append(indicatorItem(i));
      item.append(ul);
    }
    list.append(item);
  }
  const wrap = el("div", null, list);
  if (risks.length === 0) wrap.append(el("div", "dx-msg", "No observed risk indicators."));
  if (hidden > 0) wrap.append(el("div", "dx-warn", `${hidden} more not shown.`));
  return wrap;
}

/** Summary, status message, list and notes for one analysis result. */
export function resultView(result: AnalysisResult, opts: ListOptions = {}): HTMLElement {
  const root = el("div", "dx-result");
  if (result.status !== "ok") {
    root.append(el("div", "dx-msg", result.message ?? "Nothing to show."));
    for (const w of result.warnings) root.append(el("div", "dx-warn", w));
    return root;
  }
  const summary = el("div", "dx-summary");
  summary.append(el("strong", null, summaryLine(result)));
  if (result.filesRead.length > 0) summary.append(el("div", "dx-warn", `Read ${result.filesRead.join(", ")} @ ${result.ref}`));
  root.append(summary);
  if (result.message) root.append(el("div", "dx-msg", result.message));
  root.append(riskList(result, opts));
  const notes = [...result.warnings, ...result.indexErrors];
  for (const w of notes.slice(0, 6)) root.append(el("div", "dx-warn", w));
  if (notes.length > 6) root.append(el("div", "dx-warn", `${notes.length - 6} more note(s).`));
  return root;
}

export function footerNote(): HTMLElement {
  return el("div", "dx-note", FOOTER_NOTE);
}

export function loadingView(text: string): HTMLElement {
  return el("div", "dx-msg", el("span", "dx-spinner"), text);
}

export function capsuleView(capsule: CapsuleSummary): HTMLElement {
  const root = el("div", "dx-capsule");
  const meta = [
    capsule.commit ? `commit ${capsule.commit.slice(0, 10)}` : null,
    capsule.pythons.length ? `Python ${capsule.pythons.join(", ")}` : null,
    capsule.generatedAt ? `generated ${capsule.generatedAt.slice(0, 16).replace("T", " ")}` : null,
  ].filter((x): x is string => x !== null);
  root.append(el("h2", null, "DoxOps capsule"));
  if (meta.length) root.append(el("div", "dx-warn", meta.join(" · ")));
  const list = el("ul", "dx-list");
  const order = ["verified", "partially-verified", "unverified", "failed", "not-attempted"];
  const deps = [...capsule.dependencies].sort(
    (a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.dependency.localeCompare(b.dependency),
  );
  for (const d of deps) {
    const head = el(
      "div",
      "dx-dep-head",
      el("span", "dx-name", d.dependency),
      el("span", `dx-status dx-status-${d.status}`, d.status),
    );
    const item = el("li", "dx-dep dx-sev-none", head);
    if (d.status === "failed" || d.status === "unverified") item.className = "dx-dep dx-sev-high";
    if (d.status === "not-attempted") item.className = "dx-dep dx-sev-low";
    if (d.replacement) item.append(el("div", "dx-repl", badge(d.replacement.provenance), d.replacement.text));
    if (d.rationale) item.append(el("span", "dx-ind-detail", d.rationale));
    list.append(item);
  }
  root.append(list);
  for (const w of capsule.warnings.slice(0, 5)) root.append(el("div", "dx-warn", w));
  return root;
}

export function styleElement(css: string): HTMLStyleElement {
  const s = document.createElement("style");
  s.textContent = css;
  return s;
}
