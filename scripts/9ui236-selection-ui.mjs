import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URLSearchParams } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  acceptedRun,
  inspectRevisionBase,
  renderCandidateMatrix,
} from "./9ui197-harness.mjs";
import { startRevisionPrepUi } from "./9ui220-revision-ui.mjs";

const same = isDeepStrictEqual;
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const validId = (value) => /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value ?? "");

export async function loadWorkingChoices(configPath) {
  const { workspace, report } = await inspectRevisionBase(configPath);
  const file = path.join(workspace, ".mimic/workspace.json");
  const before = await readFile(file, "utf8");
  const { run, artifacts } = await acceptedRun(workspace, report.runId);
  const { report: checked } = await inspectRevisionBase(configPath);
  if (before !== (await readFile(file, "utf8")) || !same(report, checked))
    throw new Error("Run changed during review");
  const choices = report.candidates.flatMap((candidate) =>
    report.proposedDecisions.flatMap((proposal) => {
      const review = artifacts.find(({ ref }) =>
        same(ref, proposal.ref),
      )?.artifact;
      return review?.dependencies.some((ref) =>
        same(
          {
            artifactId: ref.artifactId,
            revision: ref.revision,
            lockDigest: ref.lockDigest,
          },
          candidate.ref,
        ),
      )
        ? [{ ref: candidate.ref, reviewRef: proposal.ref }]
        : [];
    }),
  );
  return {
    workspace,
    report,
    choices,
    scope: run.scope,
    selection: run.revisionSelection ?? null,
  };
}

export async function commitWorkingChoice(workspace, request, confirmation) {
  const {
    createOrchestratorRuntime,
    FileWorkspaceStorage,
    loadSchemaDirectory,
  } = await import("../packages/core/dist/index.js");
  const { LocalRevisionSelectionAuthority } =
    await import("../apps/cli/dist/local-revision-selection.js");
  const config = JSON.parse(
    await readFile(path.join(workspace, ".mimic/config.json"), "utf8"),
  );
  const storage = new FileWorkspaceStorage(
    path.join(workspace, ".mimic/workspace.json"),
  );
  const authority = new LocalRevisionSelectionAuthority(workspace);
  const schemas = await loadSchemaDirectory(
    fileURLToPath(new URL("../schemas/artifacts", import.meta.url)),
  );
  const runtime = createOrchestratorRuntime(storage, schemas, config.scopes, {
    verifyRevisionSelection: (input, state) => authority.verify(input, state),
  });
  const marked = await authority.prepare(
    request,
    confirmation,
    await runtime.registry.snapshot(),
  );
  await runtime.registry.selectRevisionBase(marked);
}

async function journalPath(workspace, runId) {
  const folder = path.join(workspace, ".mimic/working-selection-ui");
  await mkdir(folder, { recursive: true });
  if (
    (await realpath(folder)) !== folder ||
    (await lstat(folder)).isSymbolicLink()
  )
    throw new Error("Selection journal escapes workspace");
  return path.join(folder, `${runId}.json`);
}

async function readJournal(file) {
  try {
    if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink())
      throw new Error("Invalid selection journal");
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function binding(current) {
  return {
    workspace: current.workspace,
    runId: current.report.runId,
    scope: current.scope,
    choices: current.choices,
    revisionCount: current.report.revisionCount,
    revisionBudget: current.report.revisionBudget,
  };
}

const isOwnSelection = (current, journal) =>
  journal &&
  current.selection?.id === journal.request.id &&
  same(current.selection.ref, journal.request.ref) &&
  same(current.selection.reviewRef, journal.request.reviewRef) &&
  same(current.selection.actor, journal.request.actor) &&
  ["selected", "revision-limit"].includes(current.report.status);

const canSelect = (current) =>
  current.report.status === "awaiting-human-selection" &&
  current.report.revisionCount < current.report.revisionBudget;

async function fieldsFrom(request) {
  if (Number(request.headers["content-length"]) > 16384)
    throw Object.assign(new Error("Request too long"), { status: 413 });
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384)
      throw Object.assign(new Error("Request too long"), { status: 413 });
    chunks.push(chunk);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  if ([...fields.keys()].sort().join(",") !== "choice,confirm,csrf,reason")
    throw Object.assign(new Error("Invalid fields"), { status: 400 });
  return Object.fromEntries(fields);
}

export async function startWorkingSelectionUi({
  configPath,
  humanActorId,
  port = 0,
  prepPort = 0,
  load = loadWorkingChoices,
  commit = commitWorkingChoice,
  startPrep = startRevisionPrepUi,
}) {
  if (
    !validId(humanActorId) ||
    ![port, prepPort].every((v) => Number.isInteger(v) && v >= 0 && v <= 65535)
  )
    throw new Error("A human actor ID and valid ports are required");
  const initial = await load(configPath);
  const { workspace, report } = initial;
  if (!path.isAbsolute(workspace) || !validId(report.runId))
    throw new Error("Invalid workspace or Run");
  const journalFile = await journalPath(workspace, report.runId);
  const readOwnJournal = async () => {
    const saved = await readJournal(journalFile);
    if (
      saved &&
      (saved.request?.actor?.kind !== "human" ||
        saved.request?.actor?.id !== humanActorId ||
        saved.confirmation?.humanActorId !== humanActorId ||
        saved.expected?.runId !== report.runId)
    )
      throw new Error("Selection journal belongs to a different human or Run");
    return saved;
  };
  let journal = await readOwnJournal();
  if (
    !isOwnSelection(initial, journal) &&
    (initial.selection || !canSelect(initial) || !initial.choices.length)
  )
    throw new Error(
      "A reviewed, unselected Run is required; use the existing revision UI for selected Runs",
    );
  const expected = journal?.expected ?? binding(initial);
  if (!initial.selection && !same(expected, binding(initial)))
    throw new Error("Selection journal is stale");
  const csrf = randomBytes(32).toString("hex");
  const route = `/run/${report.runId}`;
  let origin = "";
  let inFlight = false;
  let prep;
  const page = (
    current,
    { stale = false, error = "", reason = "", choice = "" } = {},
  ) => {
    const saved = isOwnSelection(current, journal);
    if (journal) {
      reason ||= journal.request.reason;
      choice ||= String(
        expected.choices.findIndex(
          (item) =>
            same(item.ref, journal.request.ref) &&
            same(item.reviewRef, journal.request.reviewRef),
        ),
      );
    }
    const options = expected.choices
      .map((item, index) => {
        const candidate = current.report.candidates.find(({ ref }) =>
          same(ref, item.ref),
        );
        const review = current.report.proposedDecisions.find(({ ref }) =>
          same(ref, item.reviewRef),
        );
        return `<div class="option"><label><input type="radio" name="choice" value="${index}" required${choice === String(index) ? " checked" : ""}> ${escape(candidate?.summary ?? item.ref.artifactId)}</label><p>S11 の提案（人の選択ではありません）: ${escape(review?.summary ?? "UNVERIFIED")}</p><details><summary>候補と S11 の正確な参照</summary><pre>${escape(JSON.stringify(item, null, 2))}</pre></details></div>`;
      })
      .join("");
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>改稿の作業用ベースを選ぶ · Mimic</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#172d28;background:#f4f6f3;margin:0}main{max-width:1100px;margin:auto;padding:24px;overflow-wrap:anywhere}section,.option{display:block;background:white;border:1px solid #d9e4da;padding:18px;margin:16px 0}a{color:#075c4b}.matrix-scroll{overflow-x:auto}table{border-collapse:collapse;min-width:700px;width:100%;table-layout:fixed}th,td{border:1px solid #cad8cf;padding:12px;text-align:left;vertical-align:top}thead{background:#e5eee8}pre{white-space:pre-wrap;overflow-wrap:anywhere}textarea{box-sizing:border-box;display:block;width:100%;min-height:110px;font:inherit;padding:10px}button{font:inherit;background:#075c4b;color:white;border:0;padding:12px 20px;margin-top:18px;cursor:pointer}.error{background:#fff1e8;padding:12px}@media(max-width:700px){main{padding:16px}}</style></head><body><main><h1>改稿の作業用ベースを選ぶ</h1><p>目的: 比較した案のうち、次に改善する案を人が記録します。最終採用・公開ではありません。</p><p>現在: ${saved ? "作業用選択を保存済み。AI 生成は未実行。" : stale ? "保存状態が変わりました。この画面からは保存できません。" : "人の選択待ち。AI の推奨は人の判断ではありません。"}</p>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}${saved ? `<section><h2>次の操作</h2><p>選んだ案: ${escape(current.report.candidates.find(({ ref }) => same(ref, current.selection.ref))?.summary ?? current.selection.ref.artifactId)}</p>${prep ? `<a href="${escape(prep.url)}">修正課題を入力して次 Run の計画を保存する →</a>` : current.report.status === "revision-limit" ? "<p>改稿上限に達しています。選択は保存済みですが、次の改稿計画は準備しません。最終採用は別途人が判断します。</p>" : `<p>選択は保存済みです。改稿準備画面を起動できませんでした。ポートと Run を確認して再読み込みしてください。</p>`}</section>` : stale ? "<p>再読み込み、または対象 Run で画面を再起動してください。既存の選択を上書きしません。</p>" : `<section><h2>次に改善する案</h2><p>実画面の比較結果と、下の S11 評価を確認してから選んでください。変更は既存 CLI の supersession 契約で別途行います。</p><form method="post" action="/select"><input type="hidden" name="csrf" value="${csrf}">${options}<label>選ぶ理由（1〜2000文字）<textarea name="reason" required maxlength="2000">${escape(reason)}</textarea></label><p><label><input type="checkbox" name="confirm" value="yes" required> 私（${escape(humanActorId)}）は候補と S11 評価を確認し、改稿の作業用ベースとして記録します。最終採用ではありません。</label></p><button type="submit">作業用ベースを確定して改稿へ進む</button></form></section>`}${renderCandidateMatrix(current.report)}${current.report.candidates.map((candidate, index) => `<details id="candidate-${index}"><summary>${escape(candidate.summary)}</summary><p>${escape(candidate.mechanisms.join("; "))}</p><p>${escape(candidate.rationale.join("; ") || "UNVERIFIED")}</p></details>`).join("")}<details><summary>Run と操作範囲</summary><p>${escape(report.runId)} · 保存者: ${escape(humanActorId)}</p><p>別途明示起動したローカル操作画面です。通常モニターは読み取り専用。モデル実行・許可登録・最終採用は行いません。</p></details></main></body></html>`;
  };
  const ensurePrep = async (current) => {
    if (
      isOwnSelection(current, journal) &&
      current.report.status === "selected" &&
      !prep
    ) {
      try {
        prep = await startPrep({ configPath, port: prepPort });
      } catch {
        /* The selection remains durable; retry on reload. */
      }
    }
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    const reject = (status, text) => {
      response.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end(text);
    };
    const navigation =
      request.method === "GET" &&
      request.url === route &&
      request.headers.origin === undefined &&
      request.headers["sec-fetch-site"] === "same-site" &&
      request.headers["sec-fetch-mode"] === "navigate" &&
      request.headers["sec-fetch-dest"] === "document";
    const opaque =
      request.headers.origin === "null" &&
      request.headers["sec-fetch-site"] === "same-origin" &&
      request.headers["sec-fetch-mode"] === "navigate" &&
      request.headers["sec-fetch-dest"] === "document";
    if (
      request.headers.host !== origin.slice(7) ||
      request.rawHeaders.filter(
        (v, i) => i % 2 === 0 && v.toLowerCase() === "host",
      ).length !== 1 ||
      (request.headers["sec-fetch-site"] !== undefined &&
        !["same-origin", "none"].includes(request.headers["sec-fetch-site"]) &&
        !navigation) ||
      (request.method === "POST" &&
        ((request.headers.origin !== origin && !opaque) ||
          request.headers["sec-fetch-site"] === "none")) ||
      (request.method === "GET" &&
        request.headers.origin !== undefined &&
        request.headers.origin !== origin)
    )
      return reject(403, "Forbidden");
    if (request.url !== route && request.url !== "/select")
      return reject(404, "Not found");
    if (
      (request.url === route && request.method !== "GET") ||
      (request.url === "/select" && request.method !== "POST")
    )
      return reject(405, "Method not allowed");
    if (
      request.method === "POST" &&
      !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(
        String(request.headers["content-type"] ?? ""),
      )
    )
      return reject(415, "Unsupported content type");
    const send = (status, current, data) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(page(current, data));
    };
    if (inFlight) return reject(409, "Another selection is in progress");
    inFlight = true;
    try {
      let current = await load(configPath);
      journal = await readOwnJournal();
      const stale =
        !isOwnSelection(current, journal) &&
        (current.selection !== null ||
          !canSelect(current) ||
          !same(binding(current), expected));
      if (request.method === "GET") {
        await ensurePrep(current);
        return send(200, current, { stale });
      }
      const fields = await fieldsFrom(request);
      if (
        !/^[a-f0-9]{64}$/.test(fields.csrf) ||
        !timingSafeEqual(Buffer.from(fields.csrf), Buffer.from(csrf))
      )
        return reject(
          403,
          "確認情報が無効か、古くなっています。選択画面へ戻って再読み込みし、保存状態を確認してください。",
        );
      if (stale) return send(409, current, { stale: true });
      const reason = fields.reason.trim();
      const choice = /^(0|[1-9][0-9]*)$/.test(fields.choice)
        ? expected.choices[Number(fields.choice)]
        : undefined;
      if (
        !choice ||
        fields.confirm !== "yes" ||
        !reason ||
        reason.length > 2000
      )
        return send(422, current, {
          error: "候補・選ぶ理由・確認チェックを入力してください。",
          reason: fields.reason,
          choice: fields.choice,
        });
      if (
        journal &&
        (!same(choice.ref, journal.request.ref) ||
          !same(choice.reviewRef, journal.request.reviewRef) ||
          reason !== journal.request.reason ||
          !same(journal.expected, expected))
      )
        return send(409, current, {
          stale: true,
          error:
            "この Run の確認済み入力は変更できません。同じ入力で再試行してください。",
        });
      if (!journal) {
        const { canonicalJson } =
          await import("../packages/core/dist/index.js");
        const { atomicCreateJson } =
          await import("../apps/cli/dist/atomic-file.js");
        const at = new Date().toISOString();
        const input = {
          id: `selection_${randomUUID().replaceAll("-", "")}`,
          runId: report.runId,
          ...choice,
          actor: { kind: "human", id: humanActorId },
          at,
          reason,
        };
        const confirmed = {
          version: 1,
          action: "select-revision-base",
          hostId: "mimic-local-working-selection-ui",
          humanActorId,
          confirmedAt: at,
          runId: report.runId,
          scopeOwnerId: expected.scope,
          requestId: input.id,
          requestDigest: `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`,
          candidate: input.ref,
          review: input.reviewRef,
        };
        const pending = { expected, request: input, confirmation: confirmed };
        if (!(await atomicCreateJson(journalFile, pending)))
          return reject(409, "Another selection was confirmed; reload");
        journal = pending;
      }
      if (!isOwnSelection(current, journal))
        await commit(workspace, journal.request, journal.confirmation);
      current = await load(configPath);
      if (!isOwnSelection(current, journal))
        return send(409, current, { stale: true });
      await ensurePrep(current);
      response.writeHead(303, { Location: route });
      response.end();
    } catch (error) {
      if ([400, 413].includes(error.status))
        return reject(error.status, error.message);
      try {
        const current = await load(configPath);
        return send(409, current, {
          stale: true,
          error:
            "選択を完了できませんでした。Run の状態を確認し、同じ入力で再試行するには画面を再読み込みしてください。",
        });
      } catch {
        reject(409, "Run verification failed; restart the selection UI");
      }
    } finally {
      inFlight = false;
    }
  });
  await ensurePrep(initial);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await prep?.close();
    throw error;
  }
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    url: `${origin}${route}`,
    close: async () => {
      await prep?.close();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [configPath, humanActorId, port = "0", prepPort = "0", ...extra] =
    process.argv.slice(2);
  if (!configPath || !humanActorId || extra.length) {
    console.error(
      "Usage: node scripts/9ui236-selection-ui.mjs <config.json> <human-actor-id> [port] [prep-port]",
    );
    process.exitCode = 1;
  } else
    startWorkingSelectionUi({
      configPath,
      humanActorId,
      port: Number(port),
      prepPort: Number(prepPort),
    })
      .then(({ url }) => console.log(`Working selection UI: ${url}`))
      .catch((error) => {
        console.error(`Cannot start selection UI: ${error.message}`);
        process.exitCode = 1;
      });
}
