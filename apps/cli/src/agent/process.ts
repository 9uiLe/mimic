import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ExecutorFailure, type StopReason } from "./executor.js";

export interface OfficialProcessRequest {
  /** Absolute path to an unmodified official runtime executable. */
  executable: string;
  args: readonly string[];
  workspace: string;
  input?: string;
  /** Explicit environment only. No process.env inheritance or API credentials. */
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes?: number;
  /** Internal stdout bytes after the shared size bound. May split UTF-8/JSONL.
   * Callback exceptions stop the whole process group with unknown-outcome. */
  onStdout?: (chunk: Buffer) => void;
}
/** Internal runtime protocol data. Never expose raw stderr as diagnostics. */
export interface OfficialProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface OfficialProcessHandle {
  result: Promise<OfficialProcessResult>;
  cancel(): Promise<void>;
}

export async function executeOfficialProcess(
  request: OfficialProcessRequest,
): Promise<OfficialProcessHandle> {
  if (
    !path.isAbsolute(request.executable) ||
    request.executable.includes("\0") ||
    !path.isAbsolute(request.workspace) ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 3_600_000 ||
    !request.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))
  )
    throw new ExecutorFailure("unsupported");
  const environmentKeys = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "CODEX_HOME",
    "TERM",
    "NO_COLOR",
  ]);
  if (
    request.input !== undefined &&
    (typeof request.input !== "string" ||
      Buffer.byteLength(request.input) > 16 * 1024 * 1024)
  )
    throw new ExecutorFailure("unsupported");
  for (const [key, value] of Object.entries(request.env)) {
    if (
      !environmentKeys.has(key) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) ||
      typeof value !== "string" ||
      value.includes("\0")
    )
      throw new ExecutorFailure("unsupported");
  }
  const limit = request.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024)
    throw new ExecutorFailure("unsupported");
  let cwd: string;
  try {
    cwd = await realpath(request.workspace);
    if (!(await stat(cwd)).isDirectory()) throw new Error("Not a directory");
  } catch {
    throw new ExecutorFailure("unsupported");
  }
  const grouped = process.platform !== "win32";
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(request.executable, [...request.args], {
      cwd,
      env: { ...request.env },
      shell: false,
      detached: grouped,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new ExecutorFailure("unknown-outcome");
  }
  let stop: StopReason | undefined;
  let closed = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (closed) return;
    try {
      if (grouped && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* process may have already exited */
    }
  };
  const stopProcess = (reason: StopReason) => {
    stop ??= reason;
    kill("SIGTERM");
    forceTimer ??= setTimeout(() => kill("SIGKILL"), 250);
  };
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  const collect = (chunks: Buffer[], chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > limit) {
      stopProcess("unknown-outcome");
      return;
    }
    chunks.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    collect(stdout, chunk);
    if (stop) return;
    try {
      request.onStdout?.(Buffer.from(chunk));
    } catch {
      stopProcess("unknown-outcome");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
  const timeout = setTimeout(() => stopProcess("timeout"), request.timeoutMs);
  const result = new Promise<OfficialProcessResult>((resolve, reject) => {
    child.on("error", () => {
      stop ??= "unknown-outcome";
    });
    child.stdin.on("error", () => {
      stop ??= "unknown-outcome";
    });
    child.on("close", (code) => {
      // The leader may exit on SIGTERM while descendants ignore it. Kill the
      // existing group immediately at close, before dropping its timer/identity;
      // never schedule a late group signal against a possibly reused PID.
      if (stop) kill("SIGKILL");
      closed = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (stop || code === null)
        reject(new ExecutorFailure(stop ?? "unknown-outcome"));
      else
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
  });
  child.stdin.end(request.input ?? "");
  return {
    result,
    cancel: async () => {
      if (!closed) stopProcess("cancelled");
      try {
        await result;
      } catch {
        /* caller receives normalized result failure */
      }
    },
  };
}
