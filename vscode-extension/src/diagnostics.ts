import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  declarationDiagnostic,
  dependencyFromMessage,
  findDeclarationLine,
  isAtRisk,
  isManifestFile,
  normalizeName,
  selectPatch,
  uniqueUsageSites,
  usageDiagnostic,
  type DiagnosticLevel,
  type DiagnosticSpec,
} from "./model";
import { resolveWorkspaceFile, type LoadedResults } from "./results";

export const DIAGNOSTIC_SOURCE = "DoxOps";

function toSeverity(level: DiagnosticLevel): vscode.DiagnosticSeverity {
  switch (level) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "information":
      return vscode.DiagnosticSeverity.Information;
  }
}

class TextCache {
  private readonly cache = new Map<string, Promise<string[] | null>>();

  lines(uri: vscode.Uri): Promise<string[] | null> {
    let entry = this.cache.get(uri.fsPath);
    if (!entry) {
      entry = fs
        .readFile(uri.fsPath, "utf8")
        .then((t) => t.split(/\r?\n/))
        .catch(() => null);
      this.cache.set(uri.fsPath, entry);
    }
    return entry;
  }
}

function lineRange(lines: string[], line: number, col: number): vscode.Range | null {
  const text = lines[line - 1];
  if (text === undefined) {
    return null;
  }
  const firstNonBlank = text.length - text.trimStart().length;
  const start = col > 0 && col < text.length ? col : firstNonBlank;
  return new vscode.Range(line - 1, start, line - 1, Math.max(start + 1, text.length));
}

function makeDiagnostic(range: vscode.Range, spec: DiagnosticSpec): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, spec.message, toSeverity(spec.level));
  d.source = DIAGNOSTIC_SOURCE;
  d.code = spec.code;
  return d;
}

async function rootManifests(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
  try {
    const entries = await fs.readdir(folder.uri.fsPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && isManifestFile(e.name))
      .map((e) => vscode.Uri.file(path.join(folder.uri.fsPath, e.name)));
  } catch {
    return [];
  }
}

/** Build every DoxOps diagnostic for the loaded results, keyed by file. */
export async function computeDiagnostics(results: LoadedResults): Promise<Map<string, [vscode.Uri, vscode.Diagnostic[]]>> {
  const out = new Map<string, [vscode.Uri, vscode.Diagnostic[]]>();
  const seen = new Set<string>();
  const texts = new TextCache();
  const add = (uri: vscode.Uri, range: vscode.Range, spec: DiagnosticSpec, dep: string): void => {
    const key = `${uri.fsPath}:${range.start.line}:${dep}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const entry = out.get(uri.fsPath) ?? [uri, []];
    entry[1].push(makeDiagnostic(range, spec));
    out.set(uri.fsPath, entry);
  };
  const manifests = await rootManifests(results.folder);

  for (const capsule of results.sorted) {
    if (!isAtRisk(capsule)) {
      continue;
    }
    const declSpec = declarationDiagnostic(capsule);
    if (declSpec) {
      const declared = capsule.declarations.filter((d) => !d.commentedOut);
      let placed = false;
      for (const decl of declared) {
        const uri = results.files.get(decl.sourceFile) ?? (await resolveWorkspaceFile(decl.sourceFile, results.folder));
        if (!uri) {
          continue;
        }
        const lines = await texts.lines(uri);
        if (!lines) {
          continue;
        }
        // Trust the recorded line only while it still names the dependency (the file may have changed).
        const recorded = decl.line !== null ? lines[decl.line - 1] : undefined;
        const stillThere =
          recorded !== undefined && normalizeName(recorded).includes(normalizeName(capsule.dependency));
        const line = stillThere ? decl.line : findDeclarationLine(lines.join("\n"), capsule.dependency);
        const range = line !== null ? lineRange(lines, line, 0) : null;
        if (range) {
          add(uri, range, declSpec, capsule.dependency);
          placed = true;
        }
      }
      if (!placed) {
        for (const uri of manifests) {
          const lines = await texts.lines(uri);
          const line = lines ? findDeclarationLine(lines.join("\n"), capsule.dependency) : null;
          const range = lines && line !== null ? lineRange(lines, line, 0) : null;
          if (range) {
            add(uri, range, declSpec, capsule.dependency);
          }
        }
      }
    }
    for (const site of uniqueUsageSites(capsule.usage)) {
      const uri = results.files.get(site.file);
      const spec = usageDiagnostic(capsule, site);
      if (!uri || !spec) {
        continue;
      }
      const lines = await texts.lines(uri);
      const range = lines ? lineRange(lines, site.line, site.col) : null;
      if (range) {
        add(uri, range, spec, capsule.dependency);
      }
    }
  }
  return out;
}

export class DoxOpsCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly getResults: () => LoadedResults | null) {}

  provideCodeActions(
    _document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const results = this.getResults();
    if (!results) {
      return [];
    }
    const actions: vscode.CodeAction[] = [];
    const done = new Set<string>();
    for (const diag of context.diagnostics) {
      if (diag.source !== DIAGNOSTIC_SOURCE) {
        continue;
      }
      const dep = dependencyFromMessage(diag.message);
      if (dep === null || done.has(dep)) {
        continue;
      }
      done.add(dep);
      const capsule = results.summary.capsules.find((c) => c.dependency === dep);
      if (!capsule) {
        continue;
      }
      if (selectPatch(capsule).ok) {
        const fix = new vscode.CodeAction(`DoxOps: apply verified fix for ${dep}`, vscode.CodeActionKind.QuickFix);
        fix.command = { command: "doxops.applyFix", title: fix.title, arguments: [dep] };
        fix.diagnostics = [diag];
        actions.push(fix);
      }
      const show = new vscode.CodeAction(`DoxOps: show capsule for ${dep}`, vscode.CodeActionKind.QuickFix);
      show.command = { command: "doxops.showCapsule", title: show.title, arguments: [dep] };
      show.diagnostics = [diag];
      actions.push(show);
    }
    return actions;
  }
}
