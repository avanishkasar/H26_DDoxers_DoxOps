import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { mapCapsulePath, parseSummary, sortCapsules, type Capsule, type RunSummary } from "./model";

export interface LoadedResults {
  readonly summary: RunSummary;
  readonly sorted: readonly Capsule[];
  /** Absolute path of the DoxOps output folder. */
  readonly outDir: string;
  /** The workspace folder the capsule paths are relative to. */
  readonly folder: vscode.WorkspaceFolder;
  /** Raw capsule path -> existing file inside the workspace folder. Missing key: not resolvable. */
  readonly files: ReadonlyMap<string, vscode.Uri>;
  /** Contents of patches/combined-conflicts.txt: accepted edits left out of combined.patch. */
  readonly combinedConflicts: string | null;
}

export const COMBINED_CONFLICTS_FILE = "patches/combined-conflicts.txt";

export class ResultsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultsError";
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

/**
 * Map a capsule path onto an existing file in the folder. Symlinks are resolved so a path can
 * never lead outside the workspace folder.
 */
export async function resolveWorkspaceFile(raw: string, folder: vscode.WorkspaceFolder): Promise<vscode.Uri | null> {
  const root = folder.uri.fsPath;
  const rel = mapCapsulePath(raw, { workspaceRoot: root, homeDir: os.homedir(), caseInsensitive });
  if (rel === null) {
    return null;
  }
  const candidate = path.join(root, ...rel.split("/"));
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
    if (!isInside(realFile, realRoot)) {
      return null;
    }
    const st = await fs.stat(realFile);
    return st.isFile() ? vscode.Uri.file(candidate) : null;
  } catch {
    return null;
  }
}

export async function loadResults(outDir: string, folder: vscode.WorkspaceFolder): Promise<LoadedResults> {
  const capsuleFile = path.join(outDir, "capsule.json");
  let text: string;
  try {
    text = await fs.readFile(capsuleFile, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ResultsError(
      code === "ENOENT"
        ? `${outDir} is not a DoxOps output folder (no capsule.json).`
        : `Cannot read ${capsuleFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const summary = parseSummary(text);
  const raw = new Set<string>();
  for (const c of summary.capsules) {
    c.usage.forEach((u) => raw.add(u.file));
    c.declarations.forEach((d) => raw.add(d.sourceFile));
  }
  const files = new Map<string, vscode.Uri>();
  await Promise.all(
    [...raw].map(async (r) => {
      const uri = await resolveWorkspaceFile(r, folder);
      if (uri) {
        files.set(r, uri);
      }
    }),
  );
  let combinedConflicts: string | null = null;
  try {
    combinedConflicts = await fs.readFile(path.join(outDir, ...COMBINED_CONFLICTS_FILE.split("/")), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Unreadable conflict notes must not let combined.patch look clean.
      combinedConflicts = `${COMBINED_CONFLICTS_FILE} exists but cannot be read: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { summary, sorted: sortCapsules(summary.capsules), outDir, folder, files, combinedConflicts };
}

/** Absolute path of a file recorded relative to the output folder, refusing anything outside it. */
export function outputFile(results: LoadedResults, relative: string): string | null {
  const full = path.join(results.outDir, ...relative.split("/"));
  return isInside(full, results.outDir) ? full : null;
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
