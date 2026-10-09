import { createServer, type Server } from "node:http";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  artifactDigest,
  deriveRunState,
  type ArtifactSnapshot,
  type Run,
} from "@mimic/core";
import { FileSessionStore, sessionDigest } from "./agent/session.js";
import { sanitizeExecutionDiagnostics } from "./agent/executor.js";
import { monitorPage, monitorScript, previewPage } from "./monitor-ui.js";
import type { CliIO } from "./cli.js";

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const artifactIdPattern = /^art_[A-Za-z0-9_-]{1,255}$/;
const types = [
  "system-capability",
  "system-request",
  "problem-profile",
  "product-definition",
  "experience-domain",
  "user-task-model",
  "journey",
  "scenario",
  "brand",
  "design-direction",
  "reference-selection",
  "design-system-asset",
  "product-ui-contract",
  "evaluation",
  "validation",
  "decision",
] as const;
const stops = [
  "quota",
  "authentication",
  "billing-unconfirmed",
  "unsupported",
  "cancelled",
  "timeout",
  "unknown-outcome",
  "question",
  "approval",
  "waiting",
  "reservation-invalid",
  "iteration-limit",
];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid record");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value))
    throw new Error("Invalid ID");
  return value;
}
function artifactId(value: unknown): string {
  if (typeof value !== "string" || !artifactIdPattern.test(value))
    throw new Error("Invalid artifact ID");
  return value;
}
function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000)
    throw new Error("Invalid count");
  return value;
}
function ref(value: unknown) {
  const r = object(value);
  if (
    !Number.isSafeInteger(r.revision) ||
    Number(r.revision) < 1 ||
    typeof r.lockDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(r.lockDigest)
  )
    throw new Error("Invalid ref");
  return {
    artifactId: artifactId(r.artifactId),
    revision: Number(r.revision),
    lockDigest: r.lockDigest,
  };
}
function artifactType(value: unknown): string {
  return types.includes(value as (typeof types)[number])
    ? (value as string)
    : "unknown";
}
function stage(type: string): string {
  if (["system-capability", "system-request"].includes(type)) return "system";
  if (["problem-profile", "product-definition"].includes(type))
    return "product";
  if (
    ["experience-domain", "user-task-model", "journey", "scenario"].includes(
      type,
    )
  )
    return "experience";
  if (
    [
      "brand",
      "design-direction",
      "reference-selection",
      "design-system-asset",
      "product-ui-contract",
    ].includes(type)
  )
    return "design";
  if (["evaluation", "validation"].includes(type)) return "validation";
  return type === "decision" ? "review" : "unknown";
}
async function directory(root: string, relative: string): Promise<string> {
  let current = root;
  for (const part of relative.split("/")) {
    if (!part || part === "." || part === "..") throw new Error("Invalid path");
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid directory");
  }
  if ((await realpath(current)) !== current)
    throw new Error("Invalid directory");
  return current;
}
/** Fixed files only; bound bytes and validate the open inode and canonical path. */
async function textFile(
  root: string,
  relative: string,
  limit: number,
): Promise<string> {
  const parent = path.dirname(relative);
  const folder =
    parent === "."
      ? root
      : await directory(root, parent.split(path.sep).join("/"));
  const file = path.join(folder, path.basename(relative));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("Invalid file");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - bytes));
      const read = await handle.read(chunk);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > limit) throw new Error("File too large");
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const after = await lstat(file);
    if (
      after.isSymbolicLink() ||
      info.ino !== after.ino ||
      info.dev !== after.dev ||
      (await realpath(file)) !== file ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs
    )
      throw new Error("File changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    await handle.close();
  }
}
type Preview = { html: string; css: string; js: string };
async function loadPreview(selected?: string): Promise<Preview | undefined> {
  if (!selected) return undefined;
  const chosen = path.resolve(selected);
  const info = await lstat(chosen);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Invalid preview");
  const root = await realpath(chosen);
  const [html, css, js, rawManifest] = await Promise.all([
    textFile(root, "index.html", 2_000_000),
    textFile(root, "prototype.css", 1_000_000),
    textFile(root, "prototype.js", 2_000_000),
    textFile(root, "manifest.json", 1_000_000),
  ]);
  const manifest = object(JSON.parse(rawManifest));
  if (
    !["mimic-prototype-specification", "mimic-prototype-journey"].includes(
      String(manifest.kind),
    ) ||
    manifest.fixtures !== "synthetic" ||
    manifest.productionReady !== false ||
    typeof manifest.planDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(manifest.planDigest) ||
    !/<head>/i.test(html) ||
    !/<link rel="stylesheet" href="prototype\.css"\s*\/?\s*>/.test(html) ||
    !html.includes('<script type="module" src="prototype.js"></script>')
  )
    throw new Error("Invalid preview");
  return { html, css, js };
}

/** A fresh bounded snapshot each poll. Recorded facts are not authority proof. */
export async function readMonitorState(root: string) {
  const raw = await textFile(root, ".mimic/workspace.json", 32 * 1024 * 1024);
  const document = object(JSON.parse(raw));
  if (document.version !== 1) throw new Error("Invalid workspace");
  const registry = object(document.registry),
    snapshots = object(document.snapshots);
  const sessions = [];
  try {
    const folder = await directory(root, ".mimic/agent-sessions");
    const files = await readdir(folder);
    if (files.length > 1000) throw new Error("Too many sessions");
    for (const file of files.sort()) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}\.json$/.test(file)) continue;
      const sessionId = file.slice(0, -5);
      const relative = `.mimic/agent-sessions/${file}`;
      const before = await textFile(root, relative, 2_000_000);
      const checkpoint = await new FileSessionStore(root).read(sessionId);
      if (
        !checkpoint ||
        sessionDigest(checkpoint) !==
          sessionDigest(object(JSON.parse(before)).checkpoint) ||
        before !== (await textFile(root, relative, 2_000_000))
      )
        throw new Error("Checkpoint changed");
      if (checkpoint.stop !== undefined && !stops.includes(checkpoint.stop))
        throw new Error("Invalid stop");
      sessions.push({
        sessionId: id(sessionId),
        runId: id(checkpoint.binding.runId),
        status: checkpoint.status,
        ...(checkpoint.stop ? { stop: checkpoint.stop } : {}),
        tasks: Object.values(checkpoint.tasks).map((task) => {
          const diagnostic = sanitizeExecutionDiagnostics(task.diagnostics);
          return {
            taskId: id(task.binding.taskId),
            phase: task.phase,
            ...(diagnostic ? { stage: diagnostic.stage } : {}),
          };
        }),
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entries = Object.entries(object(registry.runs));
  if (entries.length > 500) throw new Error("Too many Runs");
  const latest = new Map<string, number>();
  if (Array.isArray(registry.events))
    for (const value of registry.events) {
      const event = object(value);
      if (
        typeof event.runId === "string" &&
        idPattern.test(event.runId) &&
        Number.isSafeInteger(event.sequence) &&
        Number(event.sequence) >= 0
      )
        latest.set(
          event.runId,
          Math.max(latest.get(event.runId) ?? 0, Number(event.sequence)),
        );
    }
  const runs = [];
  for (const [key, rawRun] of entries.sort(
    ([a], [b]) =>
      (latest.get(b) ?? 0) - (latest.get(a) ?? 0) || a.localeCompare(b),
  )) {
    const run = object(rawRun);
    if (
      id(run.id) !== id(key) ||
      !Array.isArray(run.safeActions) ||
      !Array.isArray(run.artifacts) ||
      run.safeActions.length > 1000 ||
      run.artifacts.length > 5000
    )
      throw new Error("Invalid Run");
    const safeActions = run.safeActions;
    const runSessions = sessions.filter((session) => session.runId === key);
    const taskTypes = new Map<string, string>();
    try {
      const plan = JSON.parse(
        await textFile(root, `.mimic/runs/${key}.json`, 2_000_000),
      );
      if (!Array.isArray(plan) || plan.length > 1000)
        throw new Error("Invalid plan");
      for (const task of plan)
        taskTypes.set(
          id(object(task).id),
          artifactType(object(task).outputType),
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Core safeActions are also allowed to be private human-readable work.
    // Only plans/checkpoints establish task IDs; never expose action text.
    for (const session of runSessions)
      for (const task of session.tasks)
        if (!taskTypes.has(task.taskId)) taskTypes.set(task.taskId, "unknown");
    const tasks = [...taskTypes].map(([taskId, outputType]) => {
      const observed = runSessions.filter((s) =>
        s.tasks.some((t) => t.taskId === taskId),
      );
      const phases = new Set(
        observed.map((s) =>
          s.status === "stopped"
            ? (s.stop ?? "stopped")
            : s.tasks.find((t) => t.taskId === taskId)!.phase,
        ),
      );
      return {
        taskId,
        outputType,
        stage: stage(outputType),
        phase:
          phases.size === 1
            ? [...phases][0]!
            : phases.size > 1
              ? "multiple-sessions"
              : safeActions.includes(taskId)
                ? "runnable"
                : "recorded",
      };
    });
    const stageCounts: Record<string, number> = {};
    for (const task of tasks)
      stageCounts[task.stage] = count((stageCounts[task.stage] ?? 0) + 1);
    const artifacts = run.artifacts.map((value) => {
      const exact = ref(value);
      let type = "unknown";
      const saved = snapshots[`${exact.artifactId}@${exact.revision}`];
      if (typeof saved === "string") {
        const artifact = object(JSON.parse(saved)).artifact as ArtifactSnapshot;
        if (
          artifact?.meta?.id === exact.artifactId &&
          artifact.meta.revision === exact.revision &&
          artifactDigest(artifact) === exact.lockDigest
        )
          type = artifactType(artifact.meta.type);
      }
      return { ref: exact, type };
    });
    const proposals = object(run.proposals),
      blockers = object(run.blockers);
    // Only the closed Core state is exposed; reasons, proposals and contents stay private.
    const state = deriveRunState(run as unknown as Run);
    runs.push({
      runId: key,
      state,
      safeWorkCount: count(safeActions.length),
      blockerCount: count(Object.keys(blockers).length),
      proposalCount: count(Object.keys(proposals).length),
      tasks,
      stageCounts,
      artifacts,
      sessions: runSessions,
    });
  }
  if (raw !== (await textFile(root, ".mimic/workspace.json", 32 * 1024 * 1024)))
    throw new Error("Workspace changed");
  return {
    version: 1,
    readOnly: true,
    observedAt: Date.now(),
    runs,
    counts: {
      artifacts: count(
        runs.reduce((total, run) => total + run.artifacts.length, 0),
      ),
      sessions: count(sessions.length),
      decisions: count(Object.keys(object(registry.decisions)).length),
      commits: count(Object.keys(object(registry.commits)).length),
    },
  };
}

export async function startMonitor(options: {
  root: string;
  port: number;
  preview?: string;
}): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  )
    throw new Error("Invalid port");
  const root = await realpath(path.resolve(options.root));
  if (!(await lstat(root)).isDirectory()) throw new Error("Invalid workspace");
  let preview: Preview | undefined;
  try {
    preview = await loadPreview(options.preview);
  } catch {
    /* Show unavailable, with no paths/messages. */
  }
  let origin = "";
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const reject = (status: number, error: string) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      });
      response.end(JSON.stringify({ error }));
    };
    if (
      request.headers.host !== origin.slice(7) ||
      request.rawHeaders.filter(
        (value, index) => index % 2 === 0 && value.toLowerCase() === "host",
      ).length !== 1 ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin) ||
      (request.headers["sec-fetch-site"] !== undefined &&
        !["same-origin", "none"].includes(
          String(request.headers["sec-fetch-site"]),
        ))
    )
      return reject(403, "forbidden");
    if (request.method !== "GET") return reject(405, "method-not-allowed");
    try {
      if (request.url === "/api/state") {
        if (
          (request.headers["sec-fetch-dest"] !== undefined &&
            request.headers["sec-fetch-dest"] !== "empty") ||
          (request.headers["sec-fetch-site"] !== undefined &&
            request.headers["sec-fetch-site"] !== "same-origin")
        )
          return reject(403, "forbidden");
        const state = await readMonitorState(root);
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Security-Policy":
            "default-src 'none'; frame-ancestors 'none'",
        });
        response.end(
          JSON.stringify({
            ...state,
            preview: {
              state: preview
                ? "available"
                : options.preview
                  ? "unavailable"
                  : "not-selected",
            },
          }),
        );
      } else if (
        request.url === "/" ||
        (request.url === "/preview" && preview)
      ) {
        const page =
          request.url === "/" ? monitorPage() : previewPage(preview!);
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": page.csp,
        });
        response.end(page.html);
      } else if (request.url === "/monitor.js") {
        response.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
        });
        response.end(monitorScript);
      } else reject(404, "not-found");
    } catch {
      reject(503, "workspace-unavailable");
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Invalid address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    url: origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

export async function runMonitorCli(
  argv: readonly string[],
  io: CliIO,
): Promise<number> {
  try {
    const values: Record<string, string> = {};
    for (let i = 0; i < argv.length; i += 2) {
      const flag = argv[i];
      const value = argv[i + 1];
      if (
        !flag ||
        !["--root", "--port", "--preview"].includes(flag) ||
        !value ||
        value.startsWith("--") ||
        values[flag] !== undefined
      )
        throw new Error("Invalid options");
      values[flag] = value;
    }
    if (
      !values["--root"] ||
      !values["--port"] ||
      !/^\d{1,5}$/.test(values["--port"]!)
    )
      throw new Error("Invalid options");
    const monitor = await startMonitor({
      root: values["--root"],
      port: Number(values["--port"]),
      preview: values["--preview"],
    });
    io.out(monitor.url);
    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void monitor.close().finally(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      monitor.server.once("close", () => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        resolve();
      });
    });
    return 0;
  } catch {
    io.err(
      "MIMIC_2: Monitor could not start; check root, port and fixed bundle options.",
    );
    return 2;
  }
}
