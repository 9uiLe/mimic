/* global fetch */
import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { URLSearchParams } from "node:url";
import { startRevisionPrepUi } from "./9ui220-revision-ui.mjs";

const ref = {
  artifactId: "art_test_direction",
  revision: 1,
  lockDigest: `sha256:${"a".repeat(64)}`,
};
const report = () => ({
  runId: "run_test_source",
  status: "selected",
  condition: "guided",
  selectedRef: { ...ref },
  humanSelectionId: "selection_test",
  revisionCount: 0,
  revisionBudget: 2,
  candidates: [
    {
      ref: { ...ref },
      summary: "案Aは一覧で確認する",
      mechanisms: ["共通項目を比較する"],
      rationale: ["短い材料に向く"],
      verification: { state: "UNVERIFIED" },
      evaluation: "UNVERIFIED",
    },
  ],
});
const originOf = (url) => new URL(url).origin;
const tokenOf = (html) => html.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
const fields = (csrf, runId, revisionRequest) =>
  new URLSearchParams({ csrf, runId, revisionRequest });
const post = (origin, body, headers = {}) =>
  fetch(`${origin}/prepare`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
    redirect: "manual",
  });
const rawStatus = (url, headers) =>
  new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once("error", reject);
    request.end();
  });
const browserFormPost = (origin, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const encoded = body.toString();
    const request = httpRequest(
      `${origin}/prepare`,
      {
        method: "POST",
        headers: {
          Origin: "null",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(encoded),
          ...headers,
        },
      },
      (response) => {
        response.resume();
        resolve(response);
      },
    );
    request.once("error", reject);
    request.end(encoded);
  });

async function fixture() {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "mimic-revision-ui-")),
  );
  let current = report();
  let prepares = 0;
  const load = async () => ({ workspace, report: current });
  const prepare = async (_config, request, expected) => {
    prepares++;
    assert.equal(expected.runId, current.runId);
    assert.deepEqual(expected.selectedRef, current.selectedRef);
    const config = {
      runId: request.runId,
      previousRunId: expected.runId,
      baseRef: expected.selectedRef,
      revisionRequest: request.revisionRequest,
    };
    const plan = "[]\n";
    await writeFile(
      path.join(workspace, `trial-config-${request.runId}.json`),
      JSON.stringify(config),
    );
    await writeFile(path.join(workspace, `tasks-${request.runId}.json`), plan);
    await writeFile(
      path.join(workspace, `trial-${request.runId}.json`),
      JSON.stringify({
        ...config,
        planDigest: `sha256:${createHash("sha256").update(plan).digest("hex")}`,
      }),
    );
  };
  return {
    workspace,
    load,
    prepare,
    get prepares() {
      return prepares;
    },
    change(next) {
      current = next;
    },
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  };
}

test("explicit save prepares once, survives reload and restart, and reports no generation", async () => {
  const f = await fixture();
  const ui = await startRevisionPrepUi({
    configPath: "test-only",
    load: f.load,
    prepare: f.prepare,
  });
  try {
    const origin = originOf(ui.url);
    const initial = await (await fetch(ui.url)).text();
    const csrf = tokenOf(initial);
    assert.ok(csrf);
    assert.match(initial, /課題を保存して改稿計画を準備/);
    assert.match(initial, /UNVERIFIED/);
    assert.match(initial, /id="candidate-0"/);
    const wrong = await post(
      origin,
      fields("0".repeat(64), ui.runId, "項目を直す"),
    );
    assert.equal(wrong.status, 403);
    assert.equal(f.prepares, 0);
    const saved = await browserFormPost(
      origin,
      fields(csrf, ui.runId, "比較表の必須状態を見やすくする"),
    );
    assert.equal(saved.statusCode, 303);
    assert.equal(f.prepares, 1);
    assert.equal(saved.headers.location, new URL(ui.url).pathname);
    const reloaded = await (await fetch(ui.url)).text();
    assert.match(reloaded, /この画面では AI 生成を開始していません/);
    assert.match(reloaded, /比較表の必須状態を見やすくする/);
    assert.equal(
      (
        await post(
          origin,
          fields(csrf, ui.runId, "比較表の必須状態を見やすくする"),
        )
      ).status,
      303,
    );
    assert.equal(f.prepares, 1);
    assert.equal(
      (await post(origin, fields(csrf, ui.runId, "違う改稿課題"))).status,
      409,
    );
    assert.equal(f.prepares, 1);
    await ui.close();
    const restarted = await startRevisionPrepUi({
      configPath: "test-only",
      load: f.load,
      prepare: f.prepare,
    });
    try {
      assert.equal(restarted.runId, ui.runId);
      assert.match(
        await (await fetch(restarted.url)).text(),
        /この画面では AI 生成を開始していません/,
      );
      f.change({ ...report(), humanSelectionId: "selection_changed" });
      const stale = await (await fetch(restarted.url)).text();
      assert.match(
        stale,
        /以前の計画が保存されていても現行の改稿計画として使えません/,
      );
      assert.doesNotMatch(stale, /この画面では AI 生成を開始していません/);
      assert.doesNotMatch(stale, /<form/);
      assert.equal(
        (
          await post(
            originOf(restarted.url),
            fields("0".repeat(64), ui.runId, "比較表の必須状態を見やすくする"),
          )
        ).status,
        409,
      );
    } finally {
      await restarted.close();
    }
    assert.deepEqual(
      (await readdir(f.workspace)).sort(),
      [
        `tasks-${ui.runId}.json`,
        `trial-${ui.runId}.json`,
        `trial-config-${ui.runId}.json`,
      ].sort(),
    );
    const config = JSON.parse(
      await readFile(
        path.join(f.workspace, `trial-config-${ui.runId}.json`),
        "utf8",
      ),
    );
    assert.deepEqual(config.baseRef, ref);
  } finally {
    if (ui.server.listening) await ui.close();
    await f.cleanup();
  }
});

test("foreign requests, invalid input, stale selection and concurrent submission cannot prepare", async () => {
  const f = await fixture();
  let finish;
  let entered;
  const waitForPrepare = new Promise((resolve) => {
    entered = resolve;
  });
  const blocker = new Promise((resolve) => {
    finish = resolve;
  });
  const ui = await startRevisionPrepUi({
    configPath: "test-only",
    load: f.load,
    prepare: async (...args) => {
      entered();
      await blocker;
      return f.prepare(...args);
    },
  });
  try {
    const origin = originOf(ui.url);
    const csrf = tokenOf(await (await fetch(ui.url)).text());
    assert.equal((await fetch(`${origin}/arbitrary-file`)).status, 404);
    assert.equal(
      await rawStatus(ui.url, {
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      }),
      200,
    );
    assert.equal(
      (await fetch(ui.url, { headers: { "Sec-Fetch-Site": "cross-site" } }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(ui.url, { method: "POST", headers: { Origin: origin } }))
        .status,
      405,
    );
    assert.equal(
      (
        await post(origin, fields(csrf, ui.runId, "直す"), {
          Origin: "http://evil.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(origin, fields(csrf, ui.runId, "直す"), {
          "Sec-Fetch-Site": "cross-site",
        })
      ).status,
      403,
    );
    for (const headers of [
      { Origin: "null" },
      {
        Origin: "null",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
      {
        Origin: "null",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "document",
      },
    ]) {
      assert.equal(
        (await post(origin, fields(csrf, ui.runId, "直す"), headers)).status,
        403,
      );
    }
    assert.equal(
      (await browserFormPost(origin, fields("0".repeat(64), ui.runId, "直す")))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await post(origin, fields(csrf, ui.runId, "直す"), {
          "Content-Type": "text/plain",
        })
      ).status,
      415,
    );
    assert.equal((await post(origin, fields(csrf, ui.runId, " "))).status, 422);
    assert.equal(
      (await post(origin, fields(csrf, "wrong", "直す"))).status,
      422,
    );
    assert.equal(
      (
        await post(
          origin,
          `${fields(csrf, ui.runId, "直す")}&revisionRequest=重複`,
        )
      ).status,
      400,
    );
    assert.equal(
      (await post(origin, fields(csrf, ui.runId, "x".repeat(2001)))).status,
      422,
    );
    assert.equal(
      (await post(origin, fields(csrf, ui.runId, "x".repeat(40000)))).status,
      413,
    );
    assert.equal(f.prepares, 0);
    const first = post(origin, fields(csrf, ui.runId, "一つだけ準備"));
    await waitForPrepare;
    assert.equal(
      (await post(origin, fields(csrf, ui.runId, "二重送信"))).status,
      409,
    );
    finish();
    assert.equal((await first).status, 303);
    assert.equal(f.prepares, 1);
    f.change({ ...report(), selectedRef: { ...ref, revision: 2 } });
    assert.match(
      await (await fetch(ui.url)).text(),
      /現行の改稿計画として使えません/,
    );
    assert.equal(
      (await post(origin, fields(csrf, ui.runId, "一つだけ準備"))).status,
      409,
    );
    assert.equal(f.prepares, 1);
  } finally {
    finish();
    await ui.close();
    await f.cleanup();
  }
});

test("a stopped preparation keeps the issue visible and retries the same plan", async () => {
  const f = await fixture();
  let attempts = 0;
  const ui = await startRevisionPrepUi({
    configPath: "test-only",
    load: f.load,
    prepare: async (configPath, request, expected) => {
      attempts++;
      if (attempts === 1) {
        await writeFile(
          path.join(f.workspace, `trial-config-${request.runId}.json`),
          JSON.stringify({
            runId: request.runId,
            previousRunId: expected.runId,
            baseRef: expected.selectedRef,
            revisionRequest: request.revisionRequest,
          }),
        );
        throw new Error("Interrupted after writing config");
      }
      return f.prepare(configPath, request, expected);
    },
  });
  try {
    const origin = originOf(ui.url);
    const csrf = tokenOf(await (await fetch(ui.url)).text());
    const issue = "途中失敗した主操作検査の表示を直す";
    assert.equal(
      (await post(origin, fields(csrf, ui.runId, issue))).status,
      422,
    );
    const partial = await (await fetch(ui.url)).text();
    assert.match(partial, /前回の準備が途中で止まりました/);
    assert.match(partial, new RegExp(issue));
    assert.doesNotMatch(partial, /計画は保存済みです/);
    assert.equal(
      (await post(origin, fields(csrf, ui.runId, issue))).status,
      303,
    );
    assert.equal(attempts, 2);
    assert.equal(f.prepares, 1);
    assert.match(await (await fetch(ui.url)).text(), /計画は保存済みです/);
  } finally {
    await ui.close();
    await f.cleanup();
  }
});

test("a spoofed Host is refused before reading a saved Run", async () => {
  const f = await fixture();
  const ui = await startRevisionPrepUi({
    configPath: "test-only",
    load: f.load,
    prepare: f.prepare,
  });
  try {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(
        ui.url,
        { headers: { Host: "evil.invalid" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.once("error", reject);
      request.end();
    });
    assert.equal(status, 403);
    assert.equal(f.prepares, 0);
  } finally {
    await ui.close();
    await f.cleanup();
  }
});
