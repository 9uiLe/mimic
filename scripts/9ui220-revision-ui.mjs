#!/usr/bin/env node
/** Explicitly launched loopback UI for preparing one revision; no generation route. */
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URLSearchParams } from "node:url";
import {
  inspectRevisionBase,
  prepareNextFromInput,
  renderCandidateMatrix,
} from "./9ui197-harness.mjs";

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const sameRef = (left, right) =>
  left?.artifactId === right?.artifactId &&
  left?.revision === right?.revision &&
  left?.lockDigest === right?.lockDigest;
const matchesSelection = (report, expected) =>
  report.runId === expected.runId &&
  report.status === "selected" &&
  report.humanSelectionId === expected.humanSelectionId &&
  sameRef(report.selectedRef, expected.selectedRef) &&
  report.revisionCount < report.revisionBudget;
const sha256 = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const nextId = (expected) =>
  `run_revision_${createHash("sha256")
    .update(JSON.stringify(expected))
    .digest("hex")
    .slice(0, 20)}`;

async function regularText(file) {
  const info = await lstat(file);
  if (!info.isFile() || (await realpath(file)) !== file)
    throw new Error("Prepared file changed");
  return readFile(file, "utf8");
}

async function preparedState(workspace, runId, expected) {
  const configFile = path.join(workspace, `trial-config-${runId}.json`);
  let config;
  try {
    config = JSON.parse(await regularText(configFile));
  } catch (error) {
    if (error.code === "ENOENT") return { state: "empty", issue: "" };
    throw error;
  }
  if (
    config.runId !== runId ||
    config.previousRunId !== expected.runId ||
    !sameRef(config.baseRef, expected.selectedRef) ||
    typeof config.revisionRequest !== "string"
  )
    throw new Error("Prepared revision differs from selected base");
  const issue = config.revisionRequest;
  let tasksText;
  let manifest;
  try {
    tasksText = await regularText(path.join(workspace, `tasks-${runId}.json`));
    manifest = JSON.parse(
      await regularText(path.join(workspace, `trial-${runId}.json`)),
    );
  } catch (error) {
    if (error.code === "ENOENT") return { state: "partial", issue };
    throw error;
  }
  if (
    manifest.runId !== runId ||
    manifest.previousRunId !== expected.runId ||
    !sameRef(manifest.baseRef, expected.selectedRef) ||
    manifest.revisionRequest !== issue ||
    manifest.planDigest !== sha256(tasksText)
  )
    throw new Error("Prepared revision files disagree");
  return { state: "prepared", issue };
}

function page({ report, expected, runId, csrf, saved, issue, error, stale }) {
  const selected = report.candidates.find(({ ref }) =>
    sameRef(ref, expected.selectedRef),
  );
  const headline = stale
    ? '<p role="alert" class="error">この画面の選択または改稿上限が変わりました。以前の計画が保存されていても現行の改稿計画として使えません。正しい Run で画面を起動し直してください。</p>'
    : saved.state === "prepared"
      ? `<p role="status" class="success"><strong>改稿計画を保存しました。</strong> 次 Run ${escapeHtml(runId)} の計画は保存済みです。この画面では AI 生成を開始していません。実行状態は Run 本体で確認してください。選択や最終採用も変更していません。</p>`
      : saved.state === "partial"
        ? '<p role="status">前回の準備が途中で止まりました。同じ課題で再送すると再開できます。</p>'
        : "<p>課題を入力し、保存ボタンで次 Run の計画を準備します。AI生成は開始しません。</p>";
  const form = stale
    ? ""
    : saved.state === "prepared"
      ? `<p>保存した課題: ${escapeHtml(saved.issue)}</p>`
      : `<form method="post" action="/prepare"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="runId" value="${escapeHtml(runId)}"><label for="revision-request">修正したい画面箇所と理由</label><textarea id="revision-request" name="revisionRequest" required maxlength="2000" rows="6">${escapeHtml(issue)}</textarea><button type="submit">課題を保存して改稿計画を準備</button></form>`;
  const details = report.candidates
    .map(
      (candidate, index) =>
        `<article id="candidate-${index}"><h3>${escapeHtml(candidate.summary)}</h3><p>${escapeHtml(candidate.ref.artifactId)}@${candidate.ref.revision}</p><p>向く条件・利点・失うもの: ${escapeHtml(candidate.rationale.join("; ") || "UNVERIFIED")}</p></article>`,
    )
    .join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>改稿計画の準備 · Mimic</title><style>body{font:16px/1.55 system-ui,sans-serif;color:#172d28;background:#f4f6f3;margin:0}main{max-width:1200px;margin:auto;padding:24px;overflow-wrap:anywhere}h1{line-height:1.25}section,article{background:#fff;border:1px solid #d9e4da;border-radius:8px;padding:18px;margin:16px 0}.matrix-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:700px;table-layout:fixed}th,td{border:1px solid #d9e4da;padding:12px;text-align:left;vertical-align:top;overflow-wrap:anywhere;font-size:13px}thead th{background:#e5eee8}tbody th{background:#f0f5ef}a{color:#075c4b}textarea{display:block;box-sizing:border-box;width:100%;max-width:800px;font:inherit;padding:10px;margin:8px 0 16px;border:1px solid #628477}button{font:inherit;background:#075c4b;color:white;border:0;padding:10px 16px;cursor:pointer}.error{background:#fff1e8;border:2px solid #a33d1c;padding:12px}.success{background:#e4f3e9;padding:12px}a:focus-visible,textarea:focus-visible,button:focus-visible{outline:3px solid #075c4b;outline-offset:2px}@media(max-width:700px){main{padding:16px}th,td{min-width:200px}tbody th{min-width:120px}}</style></head><body><main><h1>A 型の候補比較から改稿を準備</h1><p>Run ${escapeHtml(expected.runId)} · 改稿用の作業ベース: ${escapeHtml(selected?.summary ?? expected.selectedRef.artifactId)} · ${escapeHtml(expected.selectedRef.artifactId)}@${expected.selectedRef.revision}</p><p>人が記録した選択を使います。AI の推奨は人間の選択ではありません。</p>${renderCandidateMatrix(report)}<section><h2>選んだ案を改善する</h2>${headline}${error ? `<p role="alert" class="error">${escapeHtml(error)}</p>` : ""}${form}<p>現在 ${report.revisionCount} / ${report.revisionBudget} 回改稿済み。最終採用・公開は未承認です。</p></section><section><h2>候補の詳細</h2>${details}</section><small>出典は現在の保存済み Run と exact artifact。固定情報・操作など未検証の項目は UNVERIFIED と示します。</small></main></body></html>`;
}

function equalToken(actual, expected) {
  if (!/^[a-f0-9]{64}$/.test(actual ?? "")) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function readBody(request) {
  const length = Number(request.headers["content-length"]);
  if (Number.isFinite(length) && length > 32768)
    throw Object.assign(new Error("Request too long"), { status: 413 });
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32768)
      throw Object.assign(new Error("Request too long"), { status: 413 });
    chunks.push(chunk);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  if ([...fields.keys()].sort().join(",") !== "csrf,revisionRequest,runId")
    throw Object.assign(new Error("Invalid fields"), { status: 400 });
  return Object.fromEntries(fields);
}

export async function startRevisionPrepUi({
  configPath,
  port = 0,
  load = inspectRevisionBase,
  prepare = prepareNextFromInput,
}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port");
  const initial = await load(configPath);
  const { workspace, report } = initial;
  if (
    !path.isAbsolute(workspace) ||
    report.status !== "selected" ||
    !report.humanSelectionId ||
    !report.selectedRef ||
    report.revisionCount >= report.revisionBudget
  )
    throw new Error(
      "A confirmed working base with revision budget is required",
    );
  const expected = {
    runId: report.runId,
    selectedRef: report.selectedRef,
    humanSelectionId: report.humanSelectionId,
    revisionCount: report.revisionCount,
  };
  const runId = nextId(expected);
  const csrf = randomBytes(32).toString("hex");
  const route = `/run/${report.runId}`;
  let origin = "";
  let inFlight = false;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    const reject = (status, message) => {
      response.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      });
      response.end(message);
    };
    const monitorNavigation =
      request.method === "GET" &&
      request.url === route &&
      request.headers.origin === undefined &&
      request.headers["sec-fetch-site"] === "same-site" &&
      request.headers["sec-fetch-mode"] === "navigate" &&
      request.headers["sec-fetch-dest"] === "document";
    const opaqueSameOriginForm =
      request.method === "POST" &&
      request.headers.origin === "null" &&
      request.headers["sec-fetch-site"] === "same-origin" &&
      request.headers["sec-fetch-mode"] === "navigate" &&
      request.headers["sec-fetch-dest"] === "document";
    if (
      request.headers.host !== origin.slice(7) ||
      request.rawHeaders.filter(
        (value, index) => index % 2 === 0 && value.toLowerCase() === "host",
      ).length !== 1 ||
      (request.headers["sec-fetch-site"] !== undefined &&
        !["same-origin", "none"].includes(
          String(request.headers["sec-fetch-site"]),
        ) &&
        !monitorNavigation)
    )
      return reject(403, "Forbidden");
    if (request.url !== route && request.url !== "/prepare")
      return reject(404, "Not found");
    if (
      (request.method === "GET" &&
        request.headers.origin !== undefined &&
        request.headers.origin !== origin) ||
      (request.method === "POST" &&
        ((request.headers.origin !== origin && !opaqueSameOriginForm) ||
          request.headers["sec-fetch-site"] === "none"))
    )
      return reject(403, "Forbidden");
    if (
      (request.url === route && request.method !== "GET") ||
      (request.url === "/prepare" && request.method !== "POST")
    )
      return reject(405, "Method not allowed");
    if (
      request.method === "POST" &&
      !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(
        String(request.headers["content-type"] ?? ""),
      )
    )
      return reject(415, "Unsupported content type");
    const sendPage = (status, data) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(page({ ...data, expected, runId, csrf }));
    };
    if (request.method === "POST") {
      if (inFlight) return reject(409, "Another preparation is in progress");
      inFlight = true;
    }
    let submittedIssue = "";
    try {
      const current = await load(configPath);
      const stale = !matchesSelection(current.report, expected);
      const saved = await preparedState(workspace, runId, expected);
      if (request.method === "GET")
        return sendPage(200, {
          report: current.report,
          saved,
          issue: saved.issue,
          stale,
        });
      if (stale)
        return sendPage(409, {
          report: current.report,
          saved,
          issue: saved.issue,
          stale,
        });
      const fields = await readBody(request);
      if (!equalToken(fields.csrf, csrf)) return reject(403, "Forbidden");
      const issue = fields.revisionRequest?.trim() ?? "";
      submittedIssue = fields.revisionRequest ?? "";
      if (fields.runId !== runId || !issue || issue.length > 2000)
        return sendPage(422, {
          report: current.report,
          saved,
          issue: fields.revisionRequest ?? "",
          stale,
          error: "改稿課題を1〜2000文字で入力してください。",
        });
      if (saved.state === "prepared") {
        if (issue !== saved.issue)
          return sendPage(409, {
            report: current.report,
            saved,
            issue,
            stale,
            error:
              "この選択の改稿計画は既に保存済みです。課題は変更されていません。",
          });
        response.writeHead(303, { Location: route });
        return response.end();
      }
      await prepare(configPath, { runId, revisionRequest: issue }, expected);
      response.writeHead(303, { Location: route });
      response.end();
    } catch (error) {
      if (error.status === 413 || error.status === 400)
        return reject(
          error.status,
          error.status === 413 ? "Request too long" : "Invalid fields",
        );
      const conflict = /changed|differs|exhausted|Existing prepared file/.test(
        error.message ?? "",
      );
      try {
        const current = await load(configPath);
        const saved = await preparedState(workspace, runId, expected);
        sendPage(conflict ? 409 : 422, {
          report: current.report,
          saved,
          issue: submittedIssue || saved.issue,
          stale: !matchesSelection(current.report, expected),
          error: conflict
            ? "選択または保存済み計画が変わりました。再読み込みして確認してください。"
            : "改稿計画を保存できませんでした。入力と Run の状態を確認してください。",
        });
      } catch {
        reject(409, "Run verification failed; restart the preparation UI");
      }
    } finally {
      if (request.method === "POST") inFlight = false;
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    url: `${origin}${route}`,
    runId,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const configPath = args[0];
  const port = args.length === 2 ? Number(args[1]) : 0;
  if (!configPath || args.length > 2 || !Number.isInteger(port)) {
    console.error(
      "Usage: node scripts/9ui220-revision-ui.mjs <current-config.json> [port]",
    );
    process.exitCode = 1;
  } else {
    startRevisionPrepUi({ configPath, port })
      .then(({ url }) => console.log(`Revision preparation UI: ${url}`))
      .catch((error) => {
        console.error(`Cannot start revision preparation UI: ${error.message}`);
        process.exitCode = 1;
      });
  }
}
