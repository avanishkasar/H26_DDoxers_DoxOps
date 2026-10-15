/**
 * Child-process handling for the DoxOps CLI and git. Always spawn(file, args, {shell: false}):
 * no shell string is ever built, so paths and settings cannot inject commands.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { StreamRedactor, workspaceExecutableCandidates } from "./model";

export interface OutputSink {
  append(text: string): void;
}

export interface CancelSignal {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cancelled: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export class ExecutableNotFoundError extends Error {
  constructor(
    readonly executable: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutableNotFoundError";
  }
}

const MAX_CAPTURE = 2 * 1024 * 1024;

function appendCapped(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}

/** Kill the child and everything it started (uv, pytest, ...). */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { shell: false, windowsHide: true });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    // The child was started detached, so it leads its own process group.
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, 5000);
  timer.unref();
}

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly output?: OutputSink;
  readonly cancel?: CancelSignal;
  readonly onLine?: (line: string) => void;
  /** Values to mask if they ever appear in the streamed output. */
  readonly secrets?: readonly string[];
}

export function runProcess(executable: string, args: readonly string[], opts: SpawnOptions): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        shell: false,
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let pending = "";
    const secrets = opts.secrets ?? [];
    const redactors = { out: new StreamRedactor(secrets), err: new StreamRedactor(secrets) };
    const emit = (text: string, isErr: boolean): void => {
      if (text.length === 0) {
        return;
      }
      if (isErr) {
        stderr = appendCapped(stderr, text);
      } else {
        stdout = appendCapped(stdout, text);
      }
      opts.output?.append(text);
      if (opts.onLine) {
        pending += text;
        const lines = pending.split(/\r?\n|\r/);
        pending = lines.pop() ?? "";
        for (const l of lines) {
          if (l.trim().length > 0) {
            opts.onLine(l);
          }
        }
      }
    };
    // setEncoding decodes with a StringDecoder, so a multi-byte character split across two chunks
    // (Rich's box-drawing characters) is kept whole.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (t: string) => emit(redactors.out.push(t), false));
    child.stderr?.on("data", (t: string) => emit(redactors.err.push(t), true));
    const subscription = opts.cancel?.onCancellationRequested(() => {
      cancelled = true;
      killTree(child);
    });
    if (opts.cancel?.isCancellationRequested) {
      cancelled = true;
      killTree(child);
    }
    child.on("error", (err: NodeJS.ErrnoException) => {
      subscription?.dispose();
      if (err.code === "ENOENT") {
        reject(new ExecutableNotFoundError(executable, `${executable} was not found`));
      } else {
        reject(err);
      }
    });
    child.on("close", (code, signal) => {
      subscription?.dispose();
      emit(redactors.out.flush(), false);
      emit(redactors.err.flush(), true);
      if (pending.trim().length > 0 && opts.onLine) {
        opts.onLine(pending);
      }
      resolve({ code, signal, cancelled, stdout, stderr });
    });
  });
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      await fs.access(file, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/** Find a program on PATH without a shell. On Windows only .exe/.com, which spawn can run directly. */
export async function whichOnPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const pathVar = env["PATH"] ?? env["Path"] ?? "";
  const exts = process.platform === "win32" ? [".exe", ".com"] : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir.trim().length === 0) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export const CLI_NOT_FOUND =
  "DoxOps CLI not found; set doxops.executable or install with pip install -e ./doxops";

/**
 * Locate the CLI: the doxops.executable setting, then `doxops` on PATH, then the virtualenvs
 * `doxops/.venv` and `.venv` inside the workspace folder.
 */
export async function resolveExecutable(setting: string, workspaceRoot: string): Promise<string> {
  const configured = setting.trim();
  if (configured.length > 0) {
    const hasSeparator = configured.includes("/") || configured.includes("\\");
    if (!hasSeparator) {
      const found = await whichOnPath(configured);
      if (found) {
        return found;
      }
      throw new ExecutableNotFoundError(configured, `doxops.executable '${configured}' is not on PATH. ${CLI_NOT_FOUND}`);
    }
    const absolute = path.isAbsolute(configured) ? configured : path.resolve(workspaceRoot, configured);
    if (await isExecutableFile(absolute)) {
      return absolute;
    }
    throw new ExecutableNotFoundError(absolute, `doxops.executable '${absolute}' does not exist or is not executable. ${CLI_NOT_FOUND}`);
  }
  const onPath = await whichOnPath("doxops");
  if (onPath) {
    return onPath;
  }
  for (const candidate of workspaceExecutableCandidates(workspaceRoot, process.platform)) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  throw new ExecutableNotFoundError("doxops", CLI_NOT_FOUND);
}
