/* global fetch, structuredClone */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { URLSearchParams } from "node:url";
import { request as httpRequest } from "node:http";
import {
  artifactDigest,
  FileWorkspaceStorage,
  createOrchestratorRuntime,
  loadSchemaDirectory,
} from "../packages/core/dist/index.js";
import { runCli } from "../apps/cli/dist/cli.js";
import { startDesign } from "./9ui225-start-design.mjs";
import { renderReviewHtml } from "./9ui197-harness.mjs";
import { renderUnselectedScreensHtml } from "./9ui197-real-screens.mjs";
import { startRevisionPrepUi } from "./9ui220-revision-ui.mjs";
import {
  commitWorkingChoice,
  loadWorkingChoices,
  startWorkingSelectionUi,
} from "./9ui236-selection-ui.mjs";

const input = {
  model: "test-model",
  systemContext: "テスト用の再現データ。実生成・実人選択ではない。",
  brief: {
    audience: "画面を比較する人",
    purpose: "試作を見て改稿する案を選ぶ",
    primaryAction: "実画面を比較する",
    requiredInformation: ["構造", "未検証事項"],
    brandCharacter: "未確定",
    content: [{ policy: "fixed-fact", text: "改稿は最大2回" }],
    references: [],
  },
};
const repo = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const humanActorId = "test_human";
const token = (html) => html.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
const post = (url, csrf, changes = {}, headers = {}) => {
  const origin = new URL(url).origin;
  return fetch(`${origin}/select`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams({
      csrf,
      choice: "0",
      confirm: "yes",
      reason: "再現データのテスト用作業ベース",
      ...changes,
    }),
  });
};
async function fixture(t) {
  const folder = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "mimic-selection-ui-")),
  );
  t.after(() => rm(folder, { recursive: true, force: true }));
  const workspace = path.join(folder, "design");
  const started = await startDesign(workspace, input);
  const storage = new FileWorkspaceStorage(
    path.join(workspace, ".mimic/workspace.json"),
  );
  const runtime = createOrchestratorRuntime(
    storage,
    await loadSchemaDirectory(path.join(repo, "schemas/artifacts")),
    [{ level: "organization", ownerId: "org_local" }],
  );
  const candidate = JSON.parse(
    await readFile(
      path.join(
        repo,
        "skills/s10-design-direction-generator/examples/directions.json",
      ),
      "utf8",
    ),
  ).candidate;
  candidate.origin.runId = started.runId;
  candidate.scope = { level: "organization", ownerId: "org_local" };
  const ref = {
    artifactId: candidate.meta.id,
    revision: candidate.meta.revision,
    lockDigest: artifactDigest(candidate),
  };
  const review = JSON.parse(
    await readFile(
      path.join(repo, "skills/s11-direction-evaluator/examples/decision.json"),
      "utf8",
    ),
  );
  review.origin.runId = started.runId;
  review.scope = candidate.scope;
  review.dependencies = [{ ...ref, onChange: "validate" }];
  const reviewRef = {
    artifactId: review.meta.id,
    revision: review.meta.revision,
    lockDigest: artifactDigest(review),
  };
  for (const [artifact, artifactRef, inputs, actor] of [
    [candidate, ref, [], "mimic.s10.design-direction-generator"],
    [review, reviewRef, [ref], "mimic.s11.direction-evaluator"],
  ]) {
    await runtime.artifacts.create(artifact);
    await runtime.registry.produce({
      runId: started.runId,
      ref: artifactRef,
      inputs,
      actor: { kind: "skill", id: actor },
      at: new Date().toISOString(),
      reason: "synthetic fixture; no model call",
    });
  }
  return { ...started, workspace, ref, reviewRef, runtime, storage };
}
async function uiFor(t, setup, overrides = {}) {
  const ui = await startWorkingSelectionUi({
    configPath: setup.config,
    humanActorId,
    ...overrides,
  });
  t.after(() => ui.close());
  const html = await (await fetch(ui.url)).text();
  return { ...ui, html, csrf: token(html) };
}

test("explicit human choice uses real Core authority, survives reload/restart, and reaches existing revision preparation", async (t) => {
  const setup = await fixture(t);
  const before = await loadWorkingChoices(setup.config);
  assert.equal(before.report.status, "awaiting-human-selection");
  assert.deepEqual(before.choices, [
    { ref: setup.ref, reviewRef: setup.reviewRef },
  ]);
  const ui = await uiFor(t, setup);
  assert.match(ui.html, /最終採用・公開ではありません/);
  assert.match(ui.html, new RegExp(setup.reviewRef.lockDigest));
  assert.doesNotMatch(ui.html, / checked/);
  assert.equal(
    (await setup.runtime.registry.snapshot()).runs[setup.runId]
      .revisionSelection,
    undefined,
  );
  assert.equal((await post(ui.url, ui.csrf)).status, 303);
  const after = await loadWorkingChoices(setup.config);
  assert.equal(after.report.status, "selected");
  assert.equal(after.selection.actor.id, humanActorId);
  assert.deepEqual(after.selection.ref, setup.ref);
  assert.deepEqual(after.selection.reviewRef, setup.reviewRef);
  assert.equal(after.report.humanDecisionId, null);
  const saved = await (await fetch(ui.url)).text();
  assert.match(saved, /作業用選択を保存済み/);
  const prepUrl = saved.match(
    /href="(http:\/\/127\.0\.0\.1:\d+\/run\/[^"]+)"/,
  )?.[1];
  assert.ok(prepUrl);
  assert.match(await (await fetch(prepUrl)).text(), /AI生成は開始しません/);
  assert.equal((await post(ui.url, ui.csrf)).status, 303);
  assert.equal(
    (await post(ui.url, ui.csrf, { reason: "異なる案を試す" })).status,
    409,
  );
  const journal = JSON.parse(
    await readFile(
      path.join(
        setup.workspace,
        `.mimic/working-selection-ui/${setup.runId}.json`,
      ),
      "utf8",
    ),
  );
  assert.equal(journal.request.id, after.selection.id);
  let restartedPreparations = 0;
  const restarted = await startWorkingSelectionUi({
    configPath: setup.config,
    humanActorId,
    startPrep: async (options) => {
      restartedPreparations++;
      return startRevisionPrepUi(options);
    },
  });
  t.after(() => restarted.close());
  assert.equal(restartedPreparations, 1);
  assert.match(
    await (await fetch(restarted.url)).text(),
    /作業用選択を保存済み/,
  );
  assert.equal(restartedPreparations, 1);
  assert.equal(
    (await setup.runtime.registry.snapshot()).events.filter(
      (e) => e.action === "select-revision-base",
    ).length,
    1,
  );
});

test("input, CSRF, cross-origin, Host, arbitrary routes, and oversized bodies cannot save a choice", async (t) => {
  const setup = await fixture(t);
  const ui = await uiFor(t, setup);
  for (const changes of [
    { choice: "100" },
    { reason: " " },
    { reason: "x".repeat(2001) },
    { confirm: "no" },
  ])
    assert.equal((await post(ui.url, ui.csrf, changes)).status, 422);
  const expired = await post(ui.url, "a".repeat(64));
  assert.equal(expired.status, 403);
  assert.match(await expired.text(), /選択画面へ戻って再読み込み/);
  assert.equal(
    (await post(ui.url, ui.csrf, {}, { Origin: "https://foreign.example" }))
      .status,
    403,
  );
  assert.equal(
    (await post(ui.url, ui.csrf, {}, { "Sec-Fetch-Site": "cross-site" }))
      .status,
    403,
  );
  assert.equal(
    (await post(ui.url, ui.csrf, {}, { "Content-Type": "application/json" }))
      .status,
    415,
  );
  assert.equal(
    (await post(ui.url, ui.csrf, { extra: "unexpected" })).status,
    400,
  );
  assert.equal(
    (await post(ui.url, ui.csrf, { reason: "x".repeat(17000) })).status,
    413,
  );
  assert.equal((await fetch(`${new URL(ui.url).origin}/select`)).status, 405);
  assert.equal(
    (await fetch(`${new URL(ui.url).origin}/arbitrary`)).status,
    404,
  );
  assert.equal(
    await new Promise((resolve, reject) => {
      const r = httpRequest(
        ui.url,
        { headers: { Host: "foreign.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      r.on("error", reject);
      r.end();
    }),
    403,
  );
  assert.equal(
    (await setup.runtime.registry.snapshot()).runs[setup.runId]
      .revisionSelection,
    undefined,
  );
});

test("changed candidate/review bindings, workspace, and an external selection reject stale screens", async (t) => {
  const setup = await fixture(t);
  let current = await loadWorkingChoices(setup.config);
  let calls = 0;
  const ui = await uiFor(t, setup, {
    load: async () => current,
    commit: async () => {
      calls++;
    },
  });
  const original = structuredClone(current);
  for (const change of [
    (c) => {
      c.choices[0].ref.revision++;
    },
    (c) => {
      c.choices[0].reviewRef.lockDigest = `sha256:${"b".repeat(64)}`;
    },
    (c) => {
      c.workspace += "-other";
    },
    (c) => {
      c.selection = { id: "external" };
      c.report.status = "selected";
    },
  ]) {
    current = structuredClone(original);
    change(current);
    assert.equal((await post(ui.url, ui.csrf)).status, 409);
    assert.doesNotMatch(await (await fetch(ui.url)).text(), /<form/);
  }
  assert.equal(calls, 0);
});

test("interrupted confirmation retries the same durable request after restart; concurrent requests do not replace it", async (t) => {
  const setup = await fixture(t);
  let fail = true;
  let unblock;
  let begun;
  const started = new Promise((resolve) => {
    begun = resolve;
  });
  const block = new Promise((resolve) => {
    unblock = resolve;
  });
  const ui = await uiFor(t, setup, {
    commit: async (...args) => {
      begun();
      await block;
      if (fail) throw new Error("test interruption");
      return commitWorkingChoice(...args);
    },
  });
  const first = post(ui.url, ui.csrf);
  await started;
  assert.equal((await post(ui.url, ui.csrf)).status, 409);
  unblock();
  assert.equal((await first).status, 409);
  const journalPath = path.join(
    setup.workspace,
    `.mimic/working-selection-ui/${setup.runId}.json`,
  );
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  fail = false;
  const restarted = await uiFor(t, setup);
  assert.match(restarted.html, /再現データのテスト用作業ベース/);
  assert.equal((await post(restarted.url, restarted.csrf)).status, 303);
  assert.equal(
    (await loadWorkingChoices(setup.config)).selection.id,
    journal.request.id,
  );
  assert.equal(
    await readFile(journalPath, "utf8"),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
  assert.equal((await post(ui.url, ui.csrf)).status, 303);
});

test("a pending action never supersedes an external human selection, even across process restarts", async (t) => {
  const setup = await fixture(t);
  const failed = await uiFor(t, setup, {
    commit: async () => {
      throw new Error("interrupted");
    },
  });
  assert.equal((await post(failed.url, failed.csrf)).status, 409);
  const saved = JSON.parse(
    await readFile(
      path.join(
        setup.workspace,
        `.mimic/working-selection-ui/${setup.runId}.json`,
      ),
      "utf8",
    ),
  );
  await setup.storage.transact(async (state) => {
    state.runs[setup.runId].revisionSelection = {
      ...saved.request,
      id: "external_choice",
    };
  });
  assert.equal((await post(failed.url, failed.csrf)).status, 409);
  await assert.rejects(
    () => startWorkingSelectionUi({ configPath: setup.config, humanActorId }),
    /Unverified human revision selection/,
  );
});

test("selection journals reject symlinks and different actors; a confirmed but uncommitted action is not silently changed", async (t) => {
  const setup = await fixture(t);
  const ui = await uiFor(t, setup, {
    commit: async () => {
      throw new Error("interrupted");
    },
  });
  assert.equal((await post(ui.url, ui.csrf)).status, 409);
  assert.equal(
    (await post(ui.url, ui.csrf, { reason: "changed" })).status,
    409,
  );
  await assert.rejects(
    () =>
      startWorkingSelectionUi({
        configPath: setup.config,
        humanActorId: "other_human",
      }),
    /different human/,
  );
  const file = path.join(
    setup.workspace,
    `.mimic/working-selection-ui/${setup.runId}.json`,
  );
  const other = path.join(setup.workspace, "outside-journal.json");
  await writeFile(other, await readFile(file));
  await rm(file);
  await symlink(other, file);
  await assert.rejects(
    () => startWorkingSelectionUi({ configPath: setup.config, humanActorId }),
    /Invalid selection journal/,
  );
});

test("Core refuses a stale exact candidate even if a service bypasses its read-time checks", async (t) => {
  const setup = await fixture(t);
  const ui = await uiFor(t, setup, {
    commit: async (workspace, request, confirmation) => {
      await setup.storage.transact(async (state) => {
        state.freshness[setup.ref.artifactId] = {
          state: "stale",
          reason: "synthetic invalidation",
        };
      });
      return commitWorkingChoice(workspace, request, confirmation);
    },
  });
  assert.equal((await post(ui.url, ui.csrf)).status, 409);
  assert.equal(
    (await setup.runtime.registry.snapshot()).runs[setup.runId]
      .revisionSelection,
    undefined,
  );
});

test("an already running UI cannot submit another human's pending confirmation", async (t) => {
  const setup = await fixture(t);
  const first = await uiFor(t, setup, {
    commit: async () => {
      throw new Error("interrupted");
    },
  });
  let commits = 0;
  const second = await uiFor(t, setup, {
    humanActorId: "another_human",
    commit: async (...args) => {
      commits++;
      return commitWorkingChoice(...args);
    },
  });
  assert.equal((await post(first.url, first.csrf)).status, 409);
  assert.equal((await post(second.url, second.csrf)).status, 409);
  assert.equal(commits, 0);
  assert.equal((await loadWorkingChoices(setup.config)).selection, null);
  assert.doesNotMatch(await (await fetch(second.url)).text(), /<form/);
});

test("the final allowed child selection remains saved at the revision limit, without starting preparation", async (t) => {
  const setup = await fixture(t);
  const load = async () => {
    const current = await loadWorkingChoices(setup.config);
    current.report.revisionCount = current.selection ? 2 : 1;
    current.report.revisionBudget = 2;
    if (current.selection) current.report.status = "revision-limit";
    return current;
  };
  let starts = 0;
  const overrides = {
    load,
    startPrep: async () => {
      starts++;
      throw new Error("must not start");
    },
  };
  const ui = await uiFor(t, setup, overrides);
  assert.equal((await post(ui.url, ui.csrf)).status, 303);
  const saved = await (await fetch(ui.url)).text();
  assert.match(saved, /作業用選択を保存済み/);
  assert.match(saved, /改稿上限に達しています/);
  assert.equal((await post(ui.url, ui.csrf)).status, 303);
  assert.match(
    (await uiFor(t, setup, overrides)).html,
    /改稿上限に達しています/,
  );
  assert.equal(starts, 0);
  const empty = await fixture(t);
  await assert.rejects(
    () =>
      startWorkingSelectionUi({
        configPath: empty.config,
        humanActorId,
        load: async () => {
          const c = await loadWorkingChoices(empty.config);
          c.report.revisionBudget = 0;
          return c;
        },
      }),
    /unselected Run is required/,
  );
});

test("the monitor serves the existing unselected renderer with exact provenance and no writes", async (t) => {
  const setup = await fixture(t);
  const report = (await loadWorkingChoices(setup.config)).report;
  const mechanisms = [
    "候補を列、共通判断項目を行にして全体を比べる",
    "二つの比較枠で候補の違いを深く読む",
    "項目単位で確認し、最後に全体へ戻る",
  ];
  report.candidates = mechanisms.map((mechanism, index) => ({
    ...report.candidates[0],
    ref: {
      artifactId: `art_layout_${index}`,
      revision: 1,
      lockDigest: `sha256:${String(index + 1).repeat(64)}`,
    },
    summary: `案${["A", "B", "C"][index]} ${mechanism}`,
    mechanisms: [mechanism],
    evaluation: ["比較のしやすさ", "次の操作"].map((criterion) => ({
      criterion,
      reason: "テスト用、実画面は未検証",
      state: "UNVERIFIED",
    })),
  }));
  const brief = {
    ...input.brief,
    brandCharacter: "ブランドの具体的特徴と配色は未確定。確認まで創作しない",
    content: [
      { policy: "fixed-fact", text: "改訂の初期予算は最大2回" },
      { policy: "fixed-copy", text: "候補を比較" },
      { policy: "confirm", text: "どの案の違いがブランドに合うか" },
    ],
    references: [],
    audience: "Mimic で画面設計を進める利用者",
    purpose: "目的を入力して実デザイン案を比較し、改善する案を選べるようにする",
    primaryAction: "候補を比較し、改善に使う案を明示的に選ぶ",
    requiredInformation: [
      "候補ごとの主操作と構造上の違い",
      "向く条件、利点、失うもの",
      "未検証事項と次の操作",
    ],
  };
  const screens = renderUnselectedScreensHtml(report, brief);
  const screenFile = path.join(setup.workspace, "candidate-screens.html");
  const reviewFile = path.join(setup.workspace, "review.html");
  await writeFile(
    reviewFile,
    renderReviewHtml(report, {
      candidateScreensHref: `candidate-screens-${setup.runId}.html`,
    }),
  );
  const { startMonitor } = await import("../apps/cli/dist/monitor.js");
  const { createHash } = await import("node:crypto");
  const before = await readFile(
    path.join(setup.workspace, ".mimic/workspace.json"),
    "utf8",
  );
  for (const [html, expected] of [
    [screens, 200],
    [
      screens.replace(
        `data-run-id="${setup.runId}"`,
        'data-run-id="run_other"',
      ),
      404,
    ],
    [
      screens.replace(
        report.candidates[0].ref.lockDigest,
        `sha256:${"9".repeat(64)}`,
      ),
      404,
    ],
  ]) {
    await writeFile(screenFile, html);
    const monitor = await startMonitor({
      root: setup.workspace,
      port: 0,
      reviewCurrent: reviewFile,
      realScreens: screenFile,
      realScreensDigest: `sha256:${createHash("sha256").update(html).digest("hex")}`,
    });
    t.after(() => monitor.close());
    const review = await (
      await fetch(`${monitor.url}/trial-review/current`)
    ).text();
    assert.doesNotMatch(review, /href="candidate-screens-/);
    if (expected === 200) {
      const home = await (await fetch(monitor.url)).text();
      assert.doesNotMatch(home, /Aは人が選んだ改訂用/);
      assert.match(home, /作業用の選択状態は現在の候補レビューで確認/);
      assert.match(review, /3案とも人の作業用選択前/);
      assert.match(review, /href="\/design-review\/real-screens"/);
      assert.doesNotMatch(review, /Aは人が選んだ改訂用/);
    }
    const response = await fetch(`${monitor.url}/design-review/real-screens`);
    assert.equal(response.status, expected);
    if (expected === 200) {
      assert.equal(await response.text(), screens);
      assert.match(
        response.headers.get("content-security-policy"),
        /sandbox allow-scripts/,
      );
    }
    assert.equal(
      (
        await fetch(`${monitor.url}/design-review/real-screens`, {
          method: "POST",
        })
      ).status,
      405,
    );
  }
  assert.equal(
    await readFile(path.join(setup.workspace, ".mimic/workspace.json"), "utf8"),
    before,
  );
});

test("the real CLI accepts opt-in selection links while the monitor stays read-only", async (t) => {
  const setup = await fixture(t);
  const state = await loadWorkingChoices(setup.config);
  const reviewPath = path.join(setup.workspace, "review.html");
  await writeFile(reviewPath, renderReviewHtml(state.report));
  const { startMonitor } = await import("../apps/cli/dist/monitor.js");
  const monitor = await startMonitor({
    root: setup.workspace,
    port: 0,
    reviewCurrent: reviewPath,
    workingSelectionPort: 4320,
  });
  t.after(() => monitor.close());
  const review = await (
    await fetch(`${new URL(monitor.url).origin}/trial-review/current`)
  ).text();
  assert.match(review, new RegExp(`http://127.0.0.1:4320/run/${setup.runId}`));
  assert.equal(
    (
      await fetch(`${new URL(monitor.url).origin}/trial-review/current`, {
        method: "POST",
      })
    ).status,
    405,
  );
  const errors = [];
  assert.notEqual(
    await runCli(
      ["monitor", "--root", setup.workspace, "--working-selection-port", "0"],
      { out: () => {}, err: (e) => errors.push(e) },
    ),
    0,
  );
  assert.ok(errors.length);
});
