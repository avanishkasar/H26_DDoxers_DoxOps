import * as vscode from "vscode";
import {
  describeComparison,
  outputRelativePath,
  provenanceBadge,
  provenanceLabel,
  selectPatch,
  severityIcon,
  topIndicator,
  truncate,
  type Capsule,
  type Fact,
  type Provenance,
} from "./model";
import { outputFile, type LoadedResults } from "./results";

type GroupKind = "indicators" | "usage" | "replacement" | "attempts" | "results" | "concerns";

export interface DependencyNode {
  readonly type: "dependency";
  readonly capsule: Capsule;
}

interface GroupNode {
  readonly type: "group";
  readonly group: GroupKind;
  readonly parent: DependencyNode;
}

interface LeafNode {
  readonly type: "leaf";
  readonly item: vscode.TreeItem;
  readonly parent: GroupNode;
}

export type Node = DependencyNode | GroupNode | LeafNode;

export function isDependencyNode(value: unknown): value is DependencyNode {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "dependency";
}

const SEVERITY_COLOR: Record<string, string> = {
  error: "problemsErrorIcon.foreground",
  warning: "problemsWarningIcon.foreground",
  info: "problemsInfoIcon.foreground",
  pass: "testing.iconPassed",
};

function provenanceIcon(p: Provenance): vscode.ThemeIcon {
  switch (p) {
    case "verified":
      return new vscode.ThemeIcon("verified");
    case "observed":
      return new vscode.ThemeIcon("eye");
    case "ai":
      return new vscode.ThemeIcon("lightbulb");
  }
}

function factItem(label: string, fact: Fact): vscode.TreeItem {
  const item = new vscode.TreeItem(`${label}${truncate(fact.text, 90)}`);
  item.description = provenanceBadge(fact);
  item.tooltip = new vscode.MarkdownString().appendText(`${fact.text}\n\n${provenanceBadge(fact)}`);
  item.iconPath = provenanceIcon(fact.provenance);
  return item;
}

export class DependencyTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private results: LoadedResults | null = null;
  private nodes = new Map<string, DependencyNode>();

  setResults(results: LoadedResults | null): void {
    this.results = results;
    this.nodes = new Map((results?.sorted ?? []).map((c) => [c.dependency, { type: "dependency", capsule: c }]));
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.changed.dispose();
  }

  nodeFor(dependency: string): DependencyNode | undefined {
    return this.nodes.get(dependency);
  }

  getParent(node: Node): Node | undefined {
    return node.type === "dependency" ? undefined : node.parent;
  }

  getChildren(node?: Node): Node[] {
    if (!this.results) {
      return [];
    }
    if (node === undefined) {
      return [...this.nodes.values()];
    }
    if (node.type === "dependency") {
      return this.groupsFor(node);
    }
    if (node.type === "group") {
      return this.leavesFor(node).map((item) => ({ type: "leaf", item, parent: node }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === "leaf") {
      return node.item;
    }
    if (node.type === "group") {
      return this.groupItem(node);
    }
    return this.dependencyItem(node.capsule);
  }

  private dependencyItem(c: Capsule): vscode.TreeItem {
    const item = new vscode.TreeItem(c.dependency, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `dep:${c.dependency}`;
    item.description = `${c.risk.score} · ${c.status}`;
    const icon = severityIcon(c.risk.severity);
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(SEVERITY_COLOR[icon] ?? "foreground"));
    const applicable = selectPatch(c).ok;
    item.contextValue = applicable ? "doxops.dependency.applicable" : "doxops.dependency";
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${c.dependency}** — risk ${c.risk.score} (${c.risk.severity}), status **${c.status}**\n\n`);
    const top = topIndicator(c);
    if (top) {
      md.appendText(`Top indicator: ${top.title} [${provenanceLabel(top.provenance)}]\n\n`);
    }
    if (c.proposedReplacement) {
      md.appendText(`Replacement: ${c.proposedReplacement.text} ${provenanceBadge(c.proposedReplacement)}\n\n`);
    }
    if (c.analysis) {
      md.appendText(`Analysis: ${truncate(c.analysis.text, 300)} ${provenanceBadge(c.analysis)}\n\n`);
    }
    md.appendText(`${c.usage.length} usage site(s), ${c.attempts.length} attempt(s), ${c.openConcerns.length} open concern(s)`);
    if (applicable) {
      md.appendText("\n\nA verified patch is available: right-click > Apply Verified Fix.");
    }
    item.tooltip = md;
    return item;
  }

  private groupsFor(node: DependencyNode): GroupNode[] {
    const c = node.capsule;
    const groups: GroupKind[] = [];
    if (c.risk.indicators.length > 0) groups.push("indicators");
    if (c.usage.length > 0) groups.push("usage");
    groups.push("replacement");
    if (c.attempts.length > 0) groups.push("attempts");
    if (c.executedResults.length > 0) groups.push("results");
    if (c.openConcerns.length > 0 || c.compatibilityGaps.length > 0) groups.push("concerns");
    return groups.map((group) => ({ type: "group", group, parent: node }));
  }

  private groupItem(node: GroupNode): vscode.TreeItem {
    const c = node.parent.capsule;
    const spec: Record<GroupKind, [string, number | null, string]> = {
      indicators: ["Indicators", c.risk.indicators.length, "pulse"],
      usage: ["Usage sites", c.usage.length, "references"],
      replacement: ["Proposed replacement", null, "arrow-swap"],
      attempts: ["Attempts", c.attempts.length, "history"],
      results: ["Executed results", c.executedResults.length, "beaker"],
      concerns: ["Open concerns", c.openConcerns.length + c.compatibilityGaps.length, "warning"],
    };
    const [label, count, icon] = spec[node.group];
    const expanded = node.group === "indicators" || node.group === "replacement";
    const item = new vscode.TreeItem(
      label,
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `dep:${c.dependency}:${node.group}`;
    if (count !== null) {
      item.description = String(count);
    }
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }

  private leavesFor(node: GroupNode): vscode.TreeItem[] {
    const c = node.parent.capsule;
    const results = this.results;
    if (!results) {
      return [];
    }
    switch (node.group) {
      case "indicators":
        return [...c.risk.indicators]
          .sort((a, b) => b.weight - a.weight)
          .map((ind) => {
            const item = new vscode.TreeItem(ind.title);
            item.description = `${provenanceLabel(ind.provenance)} · +${ind.weight} · ${ind.code}`;
            item.tooltip = new vscode.MarkdownString().appendText(
              `${ind.code} (+${ind.weight})\n\n${ind.detail}\n\n${provenanceBadge(ind)}`,
            );
            item.iconPath = provenanceIcon(ind.provenance);
            return item;
          });
      case "usage":
        return c.usage.map((u) => {
          const item = new vscode.TreeItem(`${u.file}:${u.line}`);
          const uri = results.files.get(u.file);
          const what = u.symbol ? `${u.kind} · ${u.symbol}` : u.kind;
          item.description = `${what} · ${provenanceLabel(u.provenance)}${uri ? "" : " · not in workspace"}`;
          item.tooltip = new vscode.MarkdownString().appendCodeblock(u.snippet || `${u.module}`, "python");
          item.iconPath = new vscode.ThemeIcon(uri ? "go-to-file" : "circle-slash");
          if (uri) {
            const pos = new vscode.Position(u.line - 1, u.col);
            item.command = {
              command: "vscode.open",
              title: "Open usage site",
              arguments: [uri, { selection: new vscode.Range(pos, pos), preview: true }],
            };
            item.resourceUri = uri;
          }
          return item;
        });
      case "replacement": {
        const items: vscode.TreeItem[] = [];
        if (c.proposedReplacement) {
          items.push(factItem("", c.proposedReplacement));
        } else {
          const none = new vscode.TreeItem(
            c.status === "not-attempted" ? "No replacement proposed (not attempted)" : "No verified replacement",
          );
          none.iconPath = new vscode.ThemeIcon("circle-slash");
          items.push(none);
        }
        if (c.analysis) items.push(factItem("Analysis: ", c.analysis));
        if (c.rationale) items.push(factItem("Rationale: ", c.rationale));
        c.migrationSteps.forEach((s, i) => items.push(factItem(`Step ${i + 1}: `, s)));
        return items;
      }
      case "attempts":
        return c.attempts.map((a) => {
          const item = new vscode.TreeItem(`#${a.attempt} ${a.accepted ? "accepted" : "rejected"}`);
          item.description = truncate(a.verdict, 120);
          const md = new vscode.MarkdownString();
          if (a.proposal) {
            md.appendText(`Proposal: ${a.proposal} [AI${a.confidence ? `, confidence ${a.confidence}` : ""}]\n\n`);
          }
          md.appendText(`Verdict: ${a.verdict} [VERIFIED]\n\n`);
          a.comparisons.forEach((cmp) => md.appendText(`${describeComparison(cmp)}\n\n`));
          if (a.patchPath) {
            md.appendText(`Patch: ${a.patchPath}`);
          }
          item.tooltip = md;
          item.iconPath = new vscode.ThemeIcon(
            a.accepted ? "pass" : "error",
            new vscode.ThemeColor(a.accepted ? "testing.iconPassed" : "testing.iconFailed"),
          );
          const rel = a.patchPath ? outputRelativePath(a.patchPath) : null;
          if (rel) {
            const full = outputFile(results, rel);
            if (full) {
              item.command = { command: "vscode.open", title: "Open patch", arguments: [vscode.Uri.file(full)] };
            }
          }
          return item;
        });
      case "results":
        return c.executedResults.map((r) => {
          const item = new vscode.TreeItem(`Python ${r.python}`);
          item.description = `${r.fixed} fixed · ${r.regressed} regressed · ${r.stillFailing} still failing · VERIFIED`;
          item.tooltip = describeComparison(r);
          item.iconPath = new vscode.ThemeIcon(r.regressed > 0 ? "error" : "beaker");
          return item;
        });
      case "concerns":
        return [
          ...c.openConcerns.map((f) => factItem("", f)),
          ...c.compatibilityGaps.map((f) => factItem("Gap: ", f)),
        ];
    }
  }
}
