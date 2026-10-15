import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { checkConfirmApply } from "./apply";
import { computeDiagnostics, DoxOpsCodeActions } from "./diagnostics";
import {
  applyAllConfirmationDetail,
  applyConfirmationDetail,
  buildCsp,
  buildDoctorArgs,
  buildRunArgs,
  buildScanArgs,
  CapsuleFormatError,
  countResults,
  injectCsp,
  outputDirInsideWorkspaceIsSafe,
  partialWarningDetail,
  runTimestamp,
  selectCombinedPatch,
  selectPatch,
  statusBarText,
  truncate,
  validPythons,
  type Capsule,
  type CliSettings,
} from "./model";
import {
  COMBINED_CONFLICTS_FILE,
  fileExists,
  loadResults,
  outputFile,
  ResultsError,
  type LoadedResults,
} from "./results";
import { CLI_NOT_FOUND, ExecutableNotFoundError, resolveExecutable, runProcess, type ProcessResult } from "./runner";
import { DependencyTreeProvider, isDependencyNode, type Node } from "./tree";

const SECRET_KEY = "doxops.geminiApiKey";
const STATE_KEY = "doxops.lastResults";

interface PersistedResults {
  readonly outDir: string;
  readonly folder: string;
}

class DoxOpsExtension implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("DoxOps");
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("doxops");
  private readonly tree = new DependencyTreeProvider();
  private readonly treeView: vscode.TreeView<Node>;
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly disposables: vscode.Disposable[] = [];
  private results: LoadedResults | null = null;
  private running = false;
  private reportPanel: vscode.WebviewPanel | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.treeView = vscode.window.createTreeView("doxops.dependencies", {
      treeDataProvider: this.tree,
      showCollapseAll: true,
    });
    this.statusBar.command = "doxops.openReport";
    this.statusBar.tooltip = "DoxOps: open the report";
    this.disposables.push(
      this.output,
      this.diagnostics,
      this.tree,
      this.treeView,
      this.statusBar,
      vscode.languages.registerCodeActionsProvider(
        [{ scheme: "file" }],
        new DoxOpsCodeActions(() => this.results),
        { providedCodeActionKinds: DoxOpsCodeActions.kinds },
      ),
    );
    const commands: Record<string, (...args: unknown[]) => unknown> = {
      "doxops.scan": () => this.runCli("scan"),
      "doxops.run": () => this.runCli("run"),
      "doxops.loadResults": () => this.pickAndLoadResults(),
      "doxops.openReport": () => this.openReport(),
      "doxops.openReportInBrowser": () => this.openReportInBrowser(),
      "doxops.applyFix": (arg) => this.applyFix(arg),
      "doxops.applyAll": () => this.applyAll(),
      "doxops.showCapsule": (arg) => this.showCapsule(arg),
      "doxops.showOutput": () => this.output.show(),
      "doxops.doctor": () => this.doctor(),
      "doxops.setGeminiKey": () => this.setGeminiKey(),
      "doxops.clearResults": () => this.setResults(null),
    };
    for (const [id, handler] of Object.entries(commands)) {
      this.disposables.push(vscode.commands.registerCommand(id, (...args: unknown[]) => this.guard(id, () => handler(...args))));
    }
    void this.setContext("doxops.running", false);
    void this.setContext("doxops.hasResults", false);
    void this.setContext("doxops.hasCombinedPatch", false);
  }

  dispose(): void {
    this.reportPanel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private async guard(id: string, action: () => unknown): Promise<void> {
    try {
      await action();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[${id}] ${message}`);
      const choice = await vscode.window.showErrorMessage(`DoxOps: ${message}`, "Show Output");
      if (choice === "Show Output") {
        this.output.show(true);
      }
    }
  }

  private setContext(key: string, value: boolean): Thenable<unknown> {
    return vscode.commands.executeCommand("setContext", key, value);
  }

  // ---------------------------------------------------------------------------------- results

  async restore(): Promise<void> {
    const saved = this.context.workspaceState.get<PersistedResults>(STATE_KEY);
    if (!saved || typeof saved.outDir !== "string" || typeof saved.folder !== "string") {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.toString() === saved.folder);
    if (!folder || !(await fileExists(path.join(saved.outDir, "capsule.json")))) {
      return;
    }
    try {
      await this.setResults(await loadResults(saved.outDir, folder));
    } catch (err) {
      this.output.appendLine(`Could not restore the last DoxOps results: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async setResults(results: LoadedResults | null): Promise<void> {
    this.results = results;
    this.tree.setResults(results);
    this.diagnostics.clear();
    this.reportPanel?.dispose();
    await this.setContext("doxops.hasResults", results !== null);
    await this.setContext(
      "doxops.hasCombinedPatch",
      results !== null && selectCombinedPatch(results.summary, results.combinedConflicts).ok,
    );
    if (!results) {
      this.statusBar.hide();
      await this.context.workspaceState.update(STATE_KEY, undefined);
      return;
    }
    const counts = countResults(results.summary);
    this.statusBar.text = statusBarText(results.summary);
    this.statusBar.tooltip = `DoxOps ${results.summary.kind} results: ${counts.atRisk} at risk, ${counts.verified} verified, ${counts.partiallyVerified} partially verified. Click to open the report.`;
    this.statusBar.show();
    const persisted: PersistedResults = { outDir: results.outDir, folder: results.folder.uri.toString() };
    await this.context.workspaceState.update(STATE_KEY, persisted);
    const byFile = await computeDiagnostics(results);
    for (const [uri, diags] of byFile.values()) {
      this.diagnostics.set(uri, diags);
    }
    const skipped = results.sorted.reduce((n, c) => n + c.usage.filter((u) => !results.files.has(u.file)).length, 0);
    this.output.appendLine(
      `Loaded ${results.summary.kind} results from ${results.outDir}: ${results.summary.capsules.length} capsule(s), ` +
        `${[...byFile.values()].reduce((n, [, d]) => n + d.length, 0)} diagnostic(s)` +
        (skipped > 0 ? `, ${skipped} usage site(s) not found in ${results.folder.name}` : ""),
    );
  }

  private async loadInto(outDir: string, folder: vscode.WorkspaceFolder): Promise<LoadedResults | null> {
    try {
      const results = await loadResults(outDir, folder);
      await this.setResults(results);
      return results;
    } catch (err) {
      if (err instanceof ResultsError || err instanceof CapsuleFormatError) {
        void vscode.window.showErrorMessage(`DoxOps: ${err.message}`);
        return null;
      }
      throw err;
    }
  }

  private async pickFolder(purpose: string): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showWarningMessage("DoxOps: open a folder with a Python project first.");
      return undefined;
    }
    if (folders.length === 1) {
      return folders[0];
    }
    return vscode.window.showWorkspaceFolderPick({ placeHolder: purpose, ignoreFocusOut: true });
  }

  private async pickAndLoadResults(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Load DoxOps results",
      title: "Select a DoxOps output folder (contains capsule.json)",
    });
    const dir = picked?.[0];
    if (!dir) {
      return;
    }
    if (!(await fileExists(path.join(dir.fsPath, "capsule.json")))) {
      void vscode.window.showErrorMessage(`DoxOps: ${dir.fsPath} has no capsule.json; pick the folder a DoxOps run wrote.`);
      return;
    }
    const folder = await this.pickFolder("Which workspace folder did this DoxOps run scan?");
    if (!folder) {
      return;
    }
    const results = await this.loadInto(dir.fsPath, folder);
    if (results) {
      this.announce(results, "loaded");
    }
  }

  private announce(results: LoadedResults, verb: string): void {
    const counts = countResults(results.summary);
    const text =
      `DoxOps ${results.summary.kind} ${verb}: ${counts.atRisk} at risk, ${counts.verified} verified` +
      (counts.partiallyVerified > 0 ? `, ${counts.partiallyVerified} partially verified` : "") +
      (results.summary.kind === "scan" ? " (scan only: no AI plans)." : ".");
    void vscode.window.showInformationMessage(text, "Open Report").then((c) => {
      if (c === "Open Report") {
        void this.guard("doxops.openReport", () => this.openReport());
      }
    });
    void vscode.commands.executeCommand("workbench.view.extension.doxops");
  }

  // ---------------------------------------------------------------------------------- CLI

  private settings(folder: vscode.WorkspaceFolder): CliSettings & { executable: string; outputDirectory: string; ollamaHost: string } {
    const cfg = vscode.workspace.getConfiguration("doxops", folder.uri);
    const provider = cfg.get<string>("provider", "ollama") === "gemini" ? "gemini" : "ollama";
    const pythons = cfg.get<unknown>("pythons");
    const maxDeps = cfg.get<number>("maxDeps", 0);
    return {
      provider,
      model: cfg.get<string>("model", "") ?? "",
      pythons: Array.isArray(pythons) ? pythons.filter((p): p is string => typeof p === "string") : ["3.12", "3.13"],
      maxDeps: typeof maxDeps === "number" && Number.isFinite(maxDeps) ? maxDeps : 0,
      executable: cfg.get<string>("executable", "") ?? "",
      outputDirectory: cfg.get<string>("outputDirectory", "") ?? "",
      ollamaHost: cfg.get<string>("ollamaHost", "") ?? "",
    };
  }

  private async geminiKey(): Promise<string | undefined> {
    const fromEnv = process.env["GEMINI_API_KEY"];
    if (fromEnv && fromEnv.trim().length > 0) {
      return fromEnv;
    }
    return (await this.context.secrets.get(SECRET_KEY)) || undefined;
  }

  private async childEnv(ollamaHost: string): Promise<{ env: NodeJS.ProcessEnv; secrets: string[] }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      NO_COLOR: "1",
      COLUMNS: "160",
    };
    if (ollamaHost.trim().length > 0) {
      env["OLLAMA_HOST"] = ollamaHost.trim();
    }
    const key = await this.geminiKey();
    if (key) {
      env["GEMINI_API_KEY"] = key;
    }
    return { env, secrets: key ? [key] : [] };
  }

  /** A new, not yet existing run folder; null (after telling the user) when the setting is unusable. */
  private async newOutDir(folder: vscode.WorkspaceFolder, configured: string): Promise<string | null> {
    let base: string;
    if (configured.trim().length > 0) {
      const c = configured.trim();
      base = path.isAbsolute(c) ? c : path.resolve(folder.uri.fsPath, c);
      const [realRoot, realBase] = await Promise.all([realpathOrSelf(folder.uri.fsPath), realpathOrSelf(base)]);
      if (!outputDirInsideWorkspaceIsSafe(path.relative(realRoot, realBase))) {
        const choice = await vscode.window.showErrorMessage(
          `DoxOps: doxops.outputDirectory (${base}) is inside ${folder.name}. The CLI copies the workspace before testing it, ` +
            "so the copy would include its own output and never finish. Use a folder outside the workspace, or one under " +
            "'doxops-out' or '.doxops' (for example 'doxops-out'), which the CLI skips.",
          "Open Settings",
        );
        if (choice === "Open Settings") {
          await vscode.commands.executeCommand("workbench.action.openSettings", "doxops.outputDirectory");
        }
        return null;
      }
    } else {
      const storage = this.context.storageUri ?? this.context.globalStorageUri;
      base = path.join(storage.fsPath, "runs");
    }
    let out = path.join(base, runTimestamp(new Date()));
    for (let n = 2; await fs.stat(out).then(() => true, () => false); n += 1) {
      out = path.join(base, `${runTimestamp(new Date())}-${n}`);
    }
    await fs.mkdir(base, { recursive: true });
    return out;
  }

  private async resolveCli(folder: vscode.WorkspaceFolder, setting: string): Promise<string | null> {
    try {
      return await resolveExecutable(setting, folder.uri.fsPath);
    } catch (err) {
      if (err instanceof ExecutableNotFoundError) {
        await this.cliNotFound(err.message);
        return null;
      }
      throw err;
    }
  }

  private async cliNotFound(message: string): Promise<void> {
    this.output.appendLine(message);
    const choice = await vscode.window.showErrorMessage(message, "Open Settings", "Show Output");
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "doxops.executable");
    } else if (choice === "Show Output") {
      this.output.show(true);
    }
  }

  private async execute(
    exe: string,
    args: string[],
    folder: vscode.WorkspaceFolder,
    title: string,
    ollamaHost: string,
  ): Promise<ProcessResult | null> {
    if (this.running) {
      const c = await vscode.window.showWarningMessage("DoxOps is already running; wait for it or cancel it first.", "Show Output");
      if (c === "Show Output") {
        this.output.show(true);
      }
      return null;
    }
    this.running = true;
    await this.setContext("doxops.running", true);
    try {
      const { env, secrets } = await this.childEnv(ollamaHost);
      this.output.show(true);
      this.output.appendLine("");
      this.output.appendLine(`$ ${[exe, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
      this.output.appendLine(`  (in ${folder.uri.fsPath})`);
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (progress, token) =>
          runProcess(exe, args, {
            cwd: folder.uri.fsPath,
            env,
            secrets,
            output: { append: (t) => this.output.append(t) },
            cancel: token,
            onLine: (line) => progress.report({ message: truncate(line, 100) }),
          }),
      );
      this.output.appendLine(
        result.cancelled ? "[cancelled]" : `[exit ${result.code ?? `signal ${result.signal ?? "?"}`}]`,
      );
      return result;
    } catch (err) {
      if (err instanceof ExecutableNotFoundError) {
        await this.cliNotFound(CLI_NOT_FOUND);
        return null;
      }
      throw err;
    } finally {
      this.running = false;
      await this.setContext("doxops.running", false);
    }
  }

  private async runCli(mode: "scan" | "run"): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("DoxOps runs your project's tests, so it needs a trusted workspace.");
      return;
    }
    const folder = await this.pickFolder(mode === "scan" ? "Folder to scan" : "Folder to migrate with Gemma 4");
    if (!folder) {
      return;
    }
    const s = this.settings(folder);
    const { valid, invalid } = validPythons(s.pythons);
    if (invalid.length > 0) {
      void vscode.window.showWarningMessage(`DoxOps: ignoring invalid doxops.pythons entries: ${invalid.join(", ")} (use X.Y).`);
    }
    if (valid.length === 0) {
      void vscode.window.showErrorMessage("DoxOps: doxops.pythons has no valid version (for example \"3.12\").");
      return;
    }
    if (mode === "run" && s.provider === "gemini" && !(await this.geminiKey())) {
      const choice = await vscode.window.showWarningMessage(
        "DoxOps: the Gemini provider needs GEMINI_API_KEY. Set it now (stored in VS Code SecretStorage)?",
        { modal: true, detail: "Choose 'Run Anyway' if the key is in a .env file the CLI reads." },
        "Set Key",
        "Run Anyway",
      );
      if (choice === "Set Key") {
        if (!(await this.setGeminiKey())) {
          return;
        }
      } else if (choice !== "Run Anyway") {
        return;
      }
    }
    const exe = await this.resolveCli(folder, s.executable);
    if (!exe) {
      return;
    }
    const outDir = await this.newOutDir(folder, s.outputDirectory);
    if (!outDir) {
      return;
    }
    const target = folder.uri.fsPath;
    const args = mode === "scan" ? buildScanArgs(target, outDir, s) : buildRunArgs(target, outDir, s);
    const title =
      mode === "scan"
        ? `DoxOps: scanning ${folder.name} (no AI)`
        : `DoxOps: Gemma 4 plan + verify on ${folder.name} (${s.provider})`;
    const result = await this.execute(exe, args, folder, title, s.ollamaHost);
    if (!result) {
      return;
    }
    if (result.cancelled) {
      // The CLI cannot clean up after SIGTERM; its virtualenvs and repository copies live here.
      await this.discardRun(outDir);
      void vscode.window.showInformationMessage("DoxOps run cancelled; its partial output was deleted.");
      return;
    }
    if (await fileExists(path.join(outDir, "capsule.json"))) {
      const results = await this.loadInto(outDir, folder);
      if (results) {
        if (result.code !== 0) {
          void vscode.window.showWarningMessage(
            `DoxOps exited with code ${result.code ?? "?"} but wrote results; they are loaded (code 3 means a --fail-on threshold was reached).`,
          );
        }
        this.announce(results, "finished");
      }
      return;
    }
    await this.discardRun(outDir);
    const tail = (result.stderr || result.stdout).split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(" ");
    const choice = await vscode.window.showErrorMessage(
      `DoxOps ${mode} failed (exit ${result.code ?? result.signal ?? "?"}): ${truncate(tail, 300) || "no output"}`,
      "Show Output",
    );
    if (choice === "Show Output") {
      this.output.show(true);
    }
  }

  /** Delete a run folder this extension created that holds no results (cancelled or failed run). */
  private async discardRun(outDir: string): Promise<void> {
    try {
      await fs.rm(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    } catch (err) {
      this.output.appendLine(`Could not delete ${outDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async doctor(): Promise<void> {
    const folder = await this.pickFolder("Folder whose DoxOps settings to check");
    if (!folder) {
      return;
    }
    const s = this.settings(folder);
    const exe = await this.resolveCli(folder, s.executable);
    if (!exe) {
      return;
    }
    const result = await this.execute(exe, buildDoctorArgs(s), folder, "DoxOps: doctor", s.ollamaHost);
    if (!result || result.cancelled) {
      return;
    }
    this.output.show(true);
    if (result.code === 0) {
      void vscode.window.showInformationMessage("DoxOps doctor: everything is ready.");
    } else {
      void vscode.window.showWarningMessage("DoxOps doctor found problems; see the DoxOps output for the fixes.");
    }
  }

  private async setGeminiKey(): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      title: "DoxOps: Gemini API key",
      prompt: "Stored in VS Code SecretStorage and passed to the DoxOps CLI as GEMINI_API_KEY. Leave empty to remove it.",
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return false;
    }
    if (value.trim().length === 0) {
      await this.context.secrets.delete(SECRET_KEY);
      void vscode.window.showInformationMessage("DoxOps: Gemini API key removed.");
      return false;
    }
    await this.context.secrets.store(SECRET_KEY, value.trim());
    void vscode.window.showInformationMessage("DoxOps: Gemini API key saved.");
    return true;
  }

  // ---------------------------------------------------------------------------------- report

  private requireResults(): LoadedResults | null {
    if (!this.results) {
      void vscode.window
        .showInformationMessage("DoxOps: no results loaded yet.", "Scan", "Load Results")
        .then((c) => {
          if (c === "Scan") void vscode.commands.executeCommand("doxops.scan");
          if (c === "Load Results") void vscode.commands.executeCommand("doxops.loadResults");
        });
    }
    return this.results;
  }

  private async reportPath(): Promise<string | null> {
    const results = this.requireResults();
    if (!results) {
      return null;
    }
    const file = path.join(results.outDir, "report.html");
    if (!(await fileExists(file))) {
      void vscode.window.showErrorMessage(`DoxOps: ${file} is missing; re-render it with 'doxops render <out>'.`);
      return null;
    }
    return file;
  }

  private async openReport(): Promise<void> {
    const file = await this.reportPath();
    const results = this.results;
    if (!file || !results) {
      return;
    }
    const html = await fs.readFile(file, "utf8");
    if (this.reportPanel) {
      this.reportPanel.dispose();
    }
    const panel = vscode.window.createWebviewPanel("doxops.report", "DoxOps Report", vscode.ViewColumn.Active, {
      enableScripts: false,
      enableCommandUris: false,
      enableFindWidget: true,
      localResourceRoots: [vscode.Uri.file(results.outDir)],
    });
    panel.webview.html = injectCsp(html, buildCsp(panel.webview.cspSource));
    panel.onDidDispose(() => {
      if (this.reportPanel === panel) {
        this.reportPanel = null;
      }
    });
    this.reportPanel = panel;
    void vscode.window
      .showInformationMessage("DoxOps report opened (scripts disabled).", "Open in Browser")
      .then((c) => {
        if (c === "Open in Browser") {
          void vscode.env.openExternal(vscode.Uri.file(file));
        }
      });
  }

  private async openReportInBrowser(): Promise<void> {
    const file = await this.reportPath();
    if (file) {
      await vscode.env.openExternal(vscode.Uri.file(file));
    }
  }

  // ---------------------------------------------------------------------------------- capsules

  private capsuleFromArg(arg: unknown, results: LoadedResults): Capsule | undefined {
    if (isDependencyNode(arg)) {
      return results.summary.capsules.find((c) => c.dependency === arg.capsule.dependency);
    }
    if (typeof arg === "string") {
      return results.summary.capsules.find((c) => c.dependency === arg);
    }
    return undefined;
  }

  private async pickCapsule(results: LoadedResults, onlyApplicable: boolean): Promise<Capsule | undefined> {
    const candidates = results.sorted.filter((c) => !onlyApplicable || selectPatch(c).ok);
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(
        onlyApplicable
          ? results.summary.kind === "scan"
            ? "DoxOps: scan-only results have no verified fixes; run 'DoxOps: Run with Gemma 4'."
            : "DoxOps: no dependency has a verified or partially-verified patch."
          : "DoxOps: the results contain no dependencies.",
      );
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      candidates.map((c) => ({
        label: c.dependency,
        description: `${c.risk.score} · ${c.status}`,
        detail: c.proposedReplacement
          ? `${c.proposedReplacement.text} [${c.proposedReplacement.provenance.toUpperCase()}]`
          : undefined,
        capsule: c,
      })),
      { placeHolder: onlyApplicable ? "Dependency whose verified fix to apply" : "Dependency to show", matchOnDetail: true },
    );
    return pick?.capsule;
  }

  private async showCapsule(arg: unknown): Promise<void> {
    const results = this.requireResults();
    if (!results) {
      return;
    }
    const capsule = this.capsuleFromArg(arg, results) ?? (await this.pickCapsule(results, false));
    if (!capsule) {
      return;
    }
    const node = this.tree.nodeFor(capsule.dependency);
    if (node) {
      await vscode.commands.executeCommand("workbench.view.extension.doxops");
      await this.treeView.reveal(node, { select: true, focus: false, expand: true });
    }
    const md = outputFile(results, `capsules/${capsule.dependency}.md`);
    if (md && (await fileExists(md))) {
      await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(md));
    }
  }

  private async applyFix(arg: unknown): Promise<void> {
    const results = this.requireResults();
    if (!results) {
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("DoxOps applies patches only in a trusted workspace.");
      return;
    }
    const capsule = this.capsuleFromArg(arg, results) ?? (await this.pickCapsule(results, true));
    if (!capsule) {
      return;
    }
    const selection = selectPatch(capsule);
    if (!selection.ok) {
      void vscode.window.showWarningMessage(`DoxOps: ${selection.reason}.`);
      return;
    }
    const patchFile = outputFile(results, selection.patchPath);
    if (!patchFile) {
      void vscode.window.showErrorMessage(`DoxOps: refusing patch path outside the output folder: ${selection.patchPath}`);
      return;
    }
    const partial = capsule.status === "partially-verified";
    await checkConfirmApply({
      folder: results.folder,
      patchFile,
      output: this.output,
      title: `Apply the ${partial ? "PARTIALLY VERIFIED" : "VERIFIED"} DoxOps fix for ${capsule.dependency} to ${results.folder.name}?`,
      detail: (_text, files) => applyConfirmationDetail(capsule, selection, files),
      preConfirm: partial
        ? async () =>
            (await vscode.window.showWarningMessage(
              `${capsule.dependency}: only partially verified`,
              { modal: true, detail: partialWarningDetail(capsule) },
              "Continue",
            )) === "Continue"
        : undefined,
    });
  }

  private async applyAll(): Promise<void> {
    const results = this.requireResults();
    if (!results) {
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("DoxOps applies patches only in a trusted workspace.");
      return;
    }
    const selection = selectCombinedPatch(results.summary, results.combinedConflicts);
    if (!selection.ok) {
      const choice = await vscode.window.showWarningMessage(
        `DoxOps: ${selection.reason}.`,
        ...(results.combinedConflicts !== null ? ["Show Conflicts"] : []),
      );
      const conflicts = outputFile(results, COMBINED_CONFLICTS_FILE);
      if (choice === "Show Conflicts" && conflicts && (await fileExists(conflicts))) {
        await vscode.window.showTextDocument(vscode.Uri.file(conflicts), { preview: true });
      }
      return;
    }
    const patchFile = outputFile(results, selection.patchPath);
    if (!patchFile) {
      void vscode.window.showErrorMessage(`DoxOps: refusing patch path outside the output folder: ${selection.patchPath}`);
      return;
    }
    const partial = selection.included.filter((c) => c.status === "partially-verified");
    await checkConfirmApply({
      folder: results.folder,
      patchFile,
      output: this.output,
      title: `Apply combined.patch (${selection.included.length} dependencies) to ${results.folder.name}?`,
      detail: (_text, files) => applyAllConfirmationDetail(results.summary, selection.included, files),
      preConfirm:
        partial.length > 0
          ? async () =>
              (await vscode.window.showWarningMessage(
                `${partial.length} of these fixes are only partially verified`,
                { modal: true, detail: partial.map((c) => partialWarningDetail(c)).join("\n\n") },
                "Continue",
              )) === "Continue"
          : undefined,
    });
  }
}

async function realpathOrSelf(p: string): Promise<string> {
  // The output folder may not exist yet: resolve its nearest existing ancestor instead.
  let probe = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(probe), ...rest.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return path.resolve(p);
      }
      rest.push(path.basename(probe));
      probe = parent;
    }
  }
}

let instance: DoxOpsExtension | undefined;

export function activate(context: vscode.ExtensionContext): void {
  instance = new DoxOpsExtension(context);
  context.subscriptions.push(instance);
  void instance.restore();
}

export function deactivate(): void {
  instance = undefined;
}

