import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
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
import { designReviewPage, designReviewScript } from "./design-review-ui.js";
import type { TrialReviews } from "./trial-review-ui.js";
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
  "candidate-rejected",
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
async function boundedFile(
  root: string,
  relative: string,
  limit: number,
): Promise<Buffer> {
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
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}
async function textFile(root: string, relative: string, limit: number) {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await boundedFile(root, relative, limit),
  );
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

type TrialReviewSnapshot = {
  html: string;
  captures: Buffer[];
  stopped: boolean;
};
async function loadTrialReview(
  selected: string | undefined,
  kind: "current" | "stopped" | "replay",
): Promise<TrialReviewSnapshot | undefined> {
  if (!selected) return undefined;
  const chosen = path.resolve(selected);
  const folder = await realpath(path.dirname(chosen));
  const html = await textFile(folder, path.basename(chosen), 2_000_000);
  const state = html.match(
    /<p>Run ([A-Za-z][A-Za-z0-9_-]{0,79}) · ([^<]+) · ([^<]+)<\/p>/,
  );
  const runId = state?.[1];
  const condition = state?.[2];
  const status = state?.[3];
  const stopped = status === "stopped" || status === "partial-stopped";
  if (
    !html.startsWith('<!doctype html><html lang="ja">') ||
    !html.includes("<title>Mimic 候補レビュー</title>") ||
    !html.includes('<meta http-equiv="Content-Security-Policy"') ||
    /<script\b/i.test(html) ||
    !runId ||
    !condition ||
    !status ||
    (kind === "current" && condition === "historical-replay") ||
    (kind === "stopped" && (!stopped || condition === "historical-replay")) ||
    (kind === "replay" && condition !== "historical-replay")
  )
    throw new Error("Invalid trial review");
  const matches = [
    ...html.matchAll(/<a href="([^"]+)">実画面の撮影を開く<\/a>/g),
  ];
  if (matches.length > 8) throw new Error("Too many captures");
  const captureRecord = matches.length
    ? object(
        JSON.parse(await textFile(folder, `capture-${runId}.json`, 2_000_000)),
      )
    : undefined;
  if (captureRecord && captureRecord.runId !== runId)
    throw new Error("Invalid capture record");
  const observations = captureRecord
    ? Object.values(object(captureRecord.observations)).map(object)
    : [];
  const captures = await Promise.all(
    matches.map(async ([, name]) => {
      if (
        !/^capture-[A-Za-z0-9_-]+\.png$/.test(name) ||
        !name.startsWith(`capture-${runId}-`)
      )
        throw new Error("Invalid capture name");
      const pixels = await boundedFile(folder, name, 5_000_000);
      if (!pixels.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
        throw new Error("Invalid capture image");
      const digest = `sha256:${createHash("sha256").update(pixels).digest("hex")}`;
      if (
        !observations.some(
          (entry) =>
            entry.screenshot === name && entry.screenshotDigest === digest,
        )
      )
        throw new Error("Capture digest mismatch");
      return pixels;
    }),
  );
  let index = 0;
  return {
    html: html.replace(
      /<a href="[^"]+">実画面の撮影を開く<\/a>/g,
      () =>
        `<a href="/trial-review/${kind}/capture/${index++}">実画面の撮影を開く</a>`,
    ),
    captures,
    stopped,
  };
}

type WorkingPreview = { html: string; csp: string };
function embeddedRecord(html: string): Record<string, unknown> {
  const pre = html.match(/<pre>([\s\S]*?)<\/pre>/)?.[1];
  if (!pre) throw new Error("Missing preview provenance");
  return object(
    JSON.parse(
      pre
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&"),
    ),
  );
}
async function loadWorkingPreview(
  selected: string | undefined,
  expectedDigest: string | undefined,
  review: TrialReviewSnapshot | undefined,
): Promise<WorkingPreview | undefined> {
  if (!selected || !review || !expectedDigest) return undefined;
  const chosen = path.resolve(selected);
  const folder = await realpath(path.dirname(chosen));
  const html = await textFile(folder, path.basename(chosen), 2_000_000);
  if (
    !/^sha256:[a-f0-9]{64}$/.test(expectedDigest) ||
    `sha256:${createHash("sha256").update(html).digest("hex")}` !==
      expectedDigest
  )
    throw new Error("Working preview digest mismatch");
  const current = review.html.match(
    /<p>Run ([A-Za-z][A-Za-z0-9_-]{0,79}) · [^<]+ · (?:selected|revision-limit)<\/p>/,
  );
  const selectedRef = review.html.match(
    /改訂作業のために人が選んだ案: (art_[A-Za-z0-9_-]{1,255}) · 最終採用\/公開: 未承認/,
  );
  const working = html.match(
    /<p>Run ([A-Za-z][A-Za-z0-9_-]{0,79}) · 親 Run: [^<]+ · 現在の作業用ベース: (art_[A-Za-z0-9_-]{1,255})@([1-9]\d*) · 最終採用: 未承認<\/p>/,
  );
  const script = html.match(/<script>([\s\S]*?)<\/script>/i);
  const scriptHash = script
    ? createHash("sha256").update(script[1]!).digest("base64")
    : "";
  const cards = [...review.html.matchAll(/<article>([\s\S]*?)<\/article>/g)]
    .map((match) => match[1]!)
    .filter((card) =>
      selectedRef ? card.includes(`<p>${selectedRef[1]}@`) : false,
    );
  const reviewProvenance = [
    ...review.html.matchAll(/<pre>([\s\S]*?)<\/pre>/g),
  ].at(-1);
  const chosenCard = cards.length === 1 ? embeddedRecord(cards[0]!) : undefined;
  const workingProvenance = embeddedRecord(html);
  const reviewCandidates = [
    ...review.html.matchAll(/<article>([\s\S]*?)<\/article>/g),
  ].map((match) => {
    const record = embeddedRecord(match[1]!);
    return { ref: ref(record.ref), verification: record.verification };
  });
  const workingCandidates = Array.isArray(workingProvenance.candidates)
    ? workingProvenance.candidates.map((value) => {
        const record = object(value);
        return { ref: ref(record.ref), verification: record.verification };
      })
    : [];
  const reviewSelection = reviewProvenance
    ? embeddedRecord(reviewProvenance[0])
    : undefined;
  const chosenRef = chosenCard ? ref(chosenCard.ref) : undefined;
  const workingRef = ref(workingProvenance.selectedRef);
  if (
    !html.startsWith('<!doctype html><html lang="ja">') ||
    !html.includes("<title>作業用プレビュー · ") ||
    !html.includes('<main data-working-preview="unapproved">') ||
    !html.includes("下の選択・改訂操作は画面内の試用で、保存しません") ||
    !current ||
    !selectedRef ||
    !working ||
    current[1] !== working[1] ||
    selectedRef[1] !== working[2] ||
    !chosenRef ||
    chosenRef.artifactId !== workingRef.artifactId ||
    chosenRef.revision !== workingRef.revision ||
    chosenRef.lockDigest !== workingRef.lockDigest ||
    chosenRef.artifactId !== selectedRef[1] ||
    chosenRef.revision !== Number(working[3]) ||
    chosenRef.artifactId !== working[2] ||
    reviewCandidates.length === 0 ||
    JSON.stringify(reviewCandidates) !== JSON.stringify(workingCandidates) ||
    !reviewSelection ||
    typeof reviewSelection.humanSelectionId !== "string" ||
    reviewSelection.humanSelectionId.length === 0 ||
    reviewSelection.humanSelectionId !== workingProvenance.humanSelectionId ||
    !review.html.includes('<div class="grid">') ||
    (html.match(/<script\b/gi)?.length ?? 0) !== 1 ||
    !script ||
    !html.includes(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`,
    ) ||
    /<(?:iframe|object|embed|form|base)\b/i.test(html) ||
    /\b(?:href|src)="(?:https?:|\/\/|data:)/i.test(html)
  )
    throw new Error("Invalid working preview");
  return {
    html,
    csp: `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox allow-scripts; frame-ancestors 'none'`,
  };
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
      const phases = new Set<string>(
        observed.map((session) => {
          const saved = session.tasks.find((task) => task.taskId === taskId)!;
          return saved.phase === "accepted" || session.status !== "stopped"
            ? saved.phase
            : (session.stop ?? "stopped");
        }),
      );
      if (safeActions.includes(taskId) && phases.has("accepted"))
        phases.add("runnable");
      const phase =
        phases.size > 1
          ? "multiple-sessions"
          : phases.size === 1
            ? [...phases][0]!
            : safeActions.includes(taskId)
              ? "runnable"
              : "recorded";
      return {
        taskId,
        outputType,
        stage: stage(outputType),
        phase,
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
  reviewCurrent?: string;
  reviewStopped?: string;
  reviewReplay?: string;
  workingPreview?: string;
  workingPreviewDigest?: string;
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
  const [reviewCurrent, reviewStopped, reviewReplay] = await Promise.all([
    loadTrialReview(options.reviewCurrent, "current").catch(() => undefined),
    loadTrialReview(options.reviewStopped, "stopped").catch(() => undefined),
    loadTrialReview(options.reviewReplay, "replay").catch(() => undefined),
  ]);
  const workingPreview = await loadWorkingPreview(
    options.workingPreview,
    options.workingPreviewDigest,
    reviewCurrent,
  ).catch(() => undefined);
  if (reviewCurrent) {
    reviewCurrent.html = reviewCurrent.html.replace(
      /<p><a href="working-preview-[A-Za-z0-9_-]+\.html">人が選んだ案の作業用操作プレビューを開く（未承認）<\/a><\/p>/g,
      "",
    );
  }
  if (workingPreview && reviewCurrent) {
    reviewCurrent.html = reviewCurrent.html.replace(
      '<div class="grid">',
      '<p><a href="/trial-review/working-preview" target="_blank" rel="noopener noreferrer">選択済み案の未承認の作業用操作画面を別タブで試す →</a>（画面内の試用のみ・保存なし）</p><div class="grid">',
    );
  }
  const reviews: TrialReviews = {
    current: reviewCurrent
      ? reviewCurrent.stopped
        ? "stopped"
        : "available"
      : options.reviewCurrent
        ? "unavailable"
        : "not-selected",
    stopped: reviewStopped
      ? "available"
      : options.reviewStopped
        ? "unavailable"
        : "not-selected",
    replay: reviewReplay
      ? "available"
      : options.reviewReplay
        ? "unavailable"
        : "not-selected",
  };
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
        (request.url === "/preview" && preview) ||
        request.url === "/design-review"
      ) {
        const page =
          request.url === "/"
            ? monitorPage(reviews)
            : request.url === "/design-review"
              ? designReviewPage(reviews)
              : previewPage(preview!);
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": page.csp,
        });
        response.end(page.html);
      } else if (
        (request.url === "/trial-review/current" && reviewCurrent) ||
        (request.url === "/trial-review/stopped" && reviewStopped) ||
        (request.url === "/trial-review/replay" && reviewReplay)
      ) {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        response.end(
          request.url === "/trial-review/current"
            ? reviewCurrent!.html
            : request.url === "/trial-review/stopped"
              ? reviewStopped!.html
              : reviewReplay!.html,
        );
      } else if (
        request.url === "/trial-review/working-preview" &&
        workingPreview
      ) {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": workingPreview.csp,
        });
        response.end(workingPreview.html);
      } else if (
        /^\/trial-review\/(current|stopped|replay)\/capture\/[0-7]$/.test(
          request.url ?? "",
        )
      ) {
        const [, , kind, , index] = request.url!.split("/");
        const snapshot =
          kind === "current"
            ? reviewCurrent
            : kind === "stopped"
              ? reviewStopped
              : reviewReplay;
        const pixels = snapshot?.captures[Number(index)];
        if (!pixels) return reject(404, "not-found");
        response.writeHead(200, {
          "Content-Type": "image/png",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'none'; frame-ancestors 'none'",
        });
        response.end(pixels);
      } else if (request.url === "/monitor.js") {
        response.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
        });
        response.end(monitorScript);
      } else if (request.url === "/design-review.js") {
        response.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
        });
        response.end(designReviewScript);
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
        ![
          "--root",
          "--port",
          "--preview",
          "--review-current",
          "--review-stopped",
          "--review-replay",
          "--working-preview",
          "--working-preview-digest",
        ].includes(flag) ||
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
      reviewCurrent: values["--review-current"],
      reviewStopped: values["--review-stopped"],
      reviewReplay: values["--review-replay"],
      workingPreview: values["--working-preview"],
      workingPreviewDigest: values["--working-preview-digest"],
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
