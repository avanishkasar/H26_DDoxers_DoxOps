import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import {
  checkedPatchPaths,
  patchFiles,
  reducedContextAllowed,
  reducedReverseCheckConclusive,
  skippedPatchPaths,
  truncate,
} from "./model";
import { ExecutableNotFoundError, runProcess, type ProcessResult } from "./runner";

export interface ApplyRequest {
  readonly folder: vscode.WorkspaceFolder;
  /** Absolute path of the .patch file inside the DoxOps output folder. */
  readonly patchFile: string;
  readonly title: string;
  /** Builds the modal text once the patch is known to apply; `files` are the paths git will change. */
  readonly detail: (patchText: string, files: readonly string[]) => string;
  /** Extra confirmation shown before the main one (partially verified fixes). */
  readonly preConfirm?: () => Promise<boolean>;
  readonly output: vscode.OutputChannel;
}

function errorLines(text: string, n: number): string {
  const errors = text.split(/\r?\n/).filter((l) => l.startsWith("error:") && !l.includes("while searching for"));
  return errors.length > 0 ? errors.slice(0, n).join(" ") : lastLines(text, n);
}

function lastLines(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(-n)
    .join("\n");
}

async function git(args: readonly string[], cwd: string, output: vscode.OutputChannel): Promise<ProcessResult> {
  output.appendLine(`$ git ${args.join(" ")}   (in ${cwd})`);
  const result = await runProcess("git", args, { cwd, env: process.env, output });
  output.appendLine(`[exit ${result.code ?? result.signal ?? "?"}]`);
  return result;
}

/**
 * Paths in DoxOps patches are relative to the scanned folder. When that folder is a subfolder of a
 * git repository, git apply would read them relative to the repository root and silently skip
 * them, so the folder's prefix is passed with --directory.
 */
async function gitDirectoryPrefix(cwd: string): Promise<string> {
  const result = await runProcess("git", ["rev-parse", "--show-prefix"], { cwd, env: process.env });
  return result.code === 0 ? result.stdout.trim().replace(/\/+$/, "") : "";
}

function cleanCheck(result: ProcessResult): boolean {
  return result.code === 0 && skippedPatchPaths(result.stdout + result.stderr).length === 0;
}

/** `git apply --check`, confirm, `git apply`. Returns true when the patch was applied. */
export async function checkConfirmApply(req: ApplyRequest): Promise<boolean> {
  let patchText: string;
  try {
    const st = await fs.stat(req.patchFile);
    if (!st.isFile()) {
      throw new Error("not a file");
    }
    patchText = await fs.readFile(req.patchFile, "utf8");
  } catch {
    void vscode.window.showErrorMessage(`DoxOps: the patch file is missing (${req.patchFile}). Refusing to apply.`);
    return false;
  }
  if (patchText.trim().length === 0) {
    void vscode.window.showErrorMessage(`DoxOps: the patch file is empty (${req.patchFile}). Nothing to apply.`);
    return false;
  }
  const cwd = req.folder.uri.fsPath;
  try {
    const prefix = await gitDirectoryPrefix(cwd);
    const dirArgs = prefix.length > 0 ? [`--directory=${prefix}`] : [];
    let base = ["apply", "-v", "--whitespace=nowarn", ...dirArgs, req.patchFile];
    let check = await git(["apply", "--check", ...base.slice(1)], cwd, req.output);
    let reducedContext = false;
    if (check.code !== 0 && skippedPatchPaths(check.stdout + check.stderr).length === 0) {
      // A patch that is already in the tree no longer applies forwards. Reducing context would then
      // drop git's start/end-of-file anchors and apply it a second time (for example a duplicated
      // requirement line), so detect that first: the patch then applies in reverse.
      let alreadyApplied = cleanCheck(await git(["apply", "--check", "--reverse", ...base.slice(1)], cwd, req.output));
      if (!alreadyApplied && reducedReverseCheckConclusive(patchText)) {
        // Already applied, and another fix has since changed lines next to it.
        alreadyApplied = cleanCheck(await git(["apply", "--check", "--reverse", "-C1", ...base.slice(1)], cwd, req.output));
      }
      if (alreadyApplied) {
        void vscode.window.showInformationMessage(
          `DoxOps: this patch is already applied to ${req.folder.name}; nothing was changed.`,
        );
        return false;
      }
      // Patches are made against the original tree; after another DoxOps fix touched neighbouring
      // lines (same requirements file), only the nearest context line still matches.
      if (reducedContextAllowed(patchText)) {
        const relaxed = ["apply", "-v", "--whitespace=nowarn", "-C1", ...dirArgs, req.patchFile];
        const retry = await git(["apply", "--check", ...relaxed.slice(1)], cwd, req.output);
        if (cleanCheck(retry)) {
          base = relaxed;
          check = retry;
          reducedContext = true;
        }
      }
    }
    const skipped = skippedPatchPaths(check.stdout + check.stderr);
    if (check.code !== 0 || skipped.length > 0) {
      const why =
        skipped.length > 0
          ? `git would skip ${skipped.join(", ")} (paths do not match this folder)`
          : errorLines(check.stderr || check.stdout, 3);
      const choice = await vscode.window.showErrorMessage(
        `DoxOps: the patch does not apply cleanly to ${req.folder.name}, so nothing was changed. The files it changes were edited since the run. ${truncate(why, 300)}`,
        "Show Output",
      );
      if (choice === "Show Output") {
        req.output.show(true);
      }
      return false;
    }
    if (req.preConfirm && !(await req.preConfirm())) {
      return false;
    }
    const checked = checkedPatchPaths(check.stdout + check.stderr, prefix);
    const declared = patchFiles(patchText);
    const files = checked.length > 0 ? checked : declared;
    const undeclared = checked.filter((f) => !declared.includes(f));
    const confirm = await vscode.window.showWarningMessage(
      req.title,
      {
        modal: true,
        detail:
          req.detail(patchText, files) +
          (undeclared.length > 0
            ? `\n\nWARNING: the patch also changes ${undeclared.join(", ")} in sections without a "diff --git" header. DoxOps never writes such sections; inspect ${req.patchFile} before applying.`
            : "") +
          (reducedContext
            ? "\n\nNote: this patch is not applied yet, but lines next to the change differ from the run (for example another DoxOps fix touched the same file), so git matches with 1 line of context (git apply -C1). Review the diff afterwards."
            : ""),
      },
      "Apply Patch",
    );
    if (confirm !== "Apply Patch") {
      return false;
    }
    const applied = await git(base, cwd, req.output);
    if (applied.code !== 0) {
      void vscode.window.showErrorMessage(`DoxOps: git apply failed: ${truncate(errorLines(applied.stderr, 3), 300)}`);
      return false;
    }
    const next = await vscode.window.showInformationMessage(
      "DoxOps: patch applied. Review the changes before committing.",
      "Open Source Control",
    );
    if (next === "Open Source Control") {
      await vscode.commands.executeCommand("workbench.view.scm");
    }
    return true;
  } catch (err) {
    if (err instanceof ExecutableNotFoundError) {
      void vscode.window.showErrorMessage("DoxOps: git was not found on PATH; install git to apply patches.");
      return false;
    }
    throw err;
  }
}
