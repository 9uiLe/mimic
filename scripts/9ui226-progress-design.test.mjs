import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startDesign } from "./9ui225-start-design.mjs";
import {
  prepareProgress,
  progressDesign,
  recoverProgressLock,
  reconcileS10Candidate,
} from "./9ui226-progress-design.mjs";
import { sessionDigest } from "../apps/cli/dist/agent/session.js";
import { prepareCodexWorkEnvelope } from "../apps/cli/dist/agent/session-cli.js";

const input = {
  model: "gpt-6.1-sol",
  systemContext:
    "保存済み Run の候補を閲覧する既存画面がある。公開機能は未確認。",
  brief: {
    audience: "Mimic の画面を比較する利用者",
    purpose: "実画面を比較し改善案を選ぶ",
    primaryAction: "候補の構造差を見て一案を選ぶ",
    requiredInformation: ["主操作", "向く条件", "未確定事項"],
    brandCharacter: "ブランド色は未確定",
    content: [{ policy: "fixed-fact", text: "改訂は最大2回" }],
    references: [],
  },
};

async function fixture(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "mimic-226-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const workspace = path.join(folder, "design");
  const started = await startDesign(workspace, input);
  return { ...started, workspace };
}

const stages = ["s04", "s01", "s02", "s05", "s07", "s08", "s09", "s10", "s11"];
const next = (runId, stage, action = "GENERATE") => ({
  runId,
  state: action === "IGNORE" ? "review-ready" : "active",
  actions: stages.map((taskId) => ({
    taskId,
    action:
      action === "IGNORE" || stages.indexOf(taskId) < stages.indexOf(stage)
        ? "IGNORE"
        : taskId === stage
          ? "GENERATE"
          : "BLOCK",
  })),
});
const report = (runId, status = "generating", count = 0, reservations = 0) => ({
  runId,
  status,
  candidates: Array.from({ length: count }, (_, index) => ({
    ref: { artifactId: `art_${index}` },
  })),
  humanSelectionId: null,
  reviewPath: `/review-${runId}.html`,
  usage: { generationReservations: reservations },
});

test("rejected S10 raw output is reconciled without a new generation or erased rejection", async (t) => {
  const { config, runId, workspace } = await fixture(t);
  const sessionId = "session_progress_s10_exact";
  const example = JSON.parse(
    await readFile(
      path.join(
        workspace,
        "skills/s10-design-direction-generator/examples/directions.json",
      ),
      "utf8",
    ),
  );
  const artifact = JSON.parse(JSON.stringify(example.candidate));
  delete artifact.content.selectionStatus;
  const output = JSON.stringify({
    artifacts: [artifact],
    work: {
      result: {
        runId,
        taskId: "s10",
        skillId: "mimic.s10.design-direction-generator",
        inputRefs: [],
        outputRefs: [
          {
            artifactId: artifact.meta.id,
            revision: artifact.meta.revision,
            lockDigest: "host-derived",
          },
        ],
      },
    },
  });
  const binding = { taskId: "s10", inputRefs: [] };
  const oldWork = prepareCodexWorkEnvelope(output, binding, false);
  const originalDigest = sessionDigest(oldWork);
  const workPath = `.mimic/agent-work/${sessionId}-s10-${originalDigest}.json`;
  await mkdir(path.join(workspace, ".mimic/agent-work"), { recursive: true });
  await writeFile(path.join(workspace, workPath), JSON.stringify(oldWork));
  const rawPath = path.join(
    workspace,
    `.mimic/agent-work/${sessionId}-s10-${sessionDigest(output)}.raw.json`,
  );
  await writeFile(
    rawPath,
    JSON.stringify({
      version: 1,
      output,
      outputDigest: sessionDigest(output),
      normalizedDigest: originalDigest,
    }),
  );
  const journalFile = path.join(workspace, `.mimic/progress-${runId}.json`);
  await writeFile(
    journalFile,
    JSON.stringify({
      version: 1,
      runId,
      inFlight: { taskId: "s10", sessionId },
    }),
  );
  const checkpoint = {
    stop: "candidate-rejected",
    generationCount: 1,
    tasks: {
      s10: {
        phase: "rejected",
        rejectionReason: "static-validation",
        staticFailure: { reason: "candidate-validation" },
        work: { path: workPath, digest: originalDigest },
        binding,
      },
    },
  };
  let submissions = 0;
  const operations = {
    checkpoint: async () => checkpoint,
    submit: async (relative) => {
      submissions++;
      const derived = JSON.parse(
        await readFile(path.join(workspace, relative), "utf8"),
      );
      assert.equal(derived.artifacts[0].content.selectionStatus, "candidate");
      assert.notEqual(sessionDigest(derived), originalDigest);
    },
    next: async () => next(runId, "s10", "IGNORE"),
  };
  await assert.rejects(
    reconcileS10Candidate(config, "session_progress_s10_wrong", operations),
    /differs from the stopped Run/,
  );
  const originalRaw = await readFile(rawPath, "utf8");
  await writeFile(
    rawPath,
    JSON.stringify({ ...JSON.parse(originalRaw), output: "{}" }),
  );
  await assert.rejects(
    reconcileS10Candidate(config, sessionId, operations),
    /Original model output changed/,
  );
  assert.equal(submissions, 0);
  await writeFile(rawPath, originalRaw);
  const result = await reconcileS10Candidate(config, sessionId, operations);
  assert.equal(result.state, "reconciled-from-saved-output");
  assert.equal(result.modelCalls, 0);
  assert.equal(submissions, 1);
  assert.equal(JSON.parse(await readFile(journalFile, "utf8")).inFlight, null);
  assert.equal(JSON.parse(await readFile(rawPath, "utf8")).output, output);
  assert.equal(
    JSON.parse(await readFile(path.join(workspace, workPath), "utf8"))
      .artifacts[0].content.selectionStatus,
    undefined,
  );
  const receipt = JSON.parse(
    await readFile(
      path.join(workspace, `.mimic/reconciled-${sessionId}.json`),
      "utf8",
    ),
  );
  assert.equal(receipt.originalWorkDigest, originalDigest);
  assert.equal(receipt.rawFileName, path.basename(rawPath));
  assert.equal(receipt.rawOutputDigest, sessionDigest(output));
});

test("scope reads the actual saved Run and never starts generation", async (t) => {
  const { config, runId, workspace } = await fixture(t);
  const first = await prepareProgress(config);
  const second = await prepareProgress(config);
  assert.deepEqual(second, first);
  const saved = JSON.parse(await readFile(first.scopeConfig, "utf8"));
  assert.equal(saved.runId, runId);
  assert.equal(saved.model, input.model);
  assert.equal(Object.keys(saved.packages).length, 9);
  assert.equal(first.generation, "not-started");
  assert.equal(
    (
      await readFile(path.join(workspace, ".mimic/workspace.json"), "utf8")
    ).includes("revisionSelection"),
    false,
  );
  await assert.rejects(progressDesign(config, "", 1), /grant ID/);
  await assert.rejects(progressDesign(config, "grant_test", 0), /call cap/);
});

test("each accepted official session advances once and renders the selection-waiting review", async (t) => {
  const { config, runId, workspace } = await fixture(t);
  const canonicalWorkspace = await realpath(workspace);
  let stage = "s04";
  const called = [];
  const result = await progressDesign(config, "grant_test", 2, {
    preflight: async () => {},
    next: async () =>
      next(runId, stage, stage === "done" ? "IGNORE" : "GENERATE"),
    review: async () =>
      report(
        runId,
        stage === "done" ? "awaiting-human-selection" : "generating",
        stage === "done" ? 3 : 0,
      ),
    candidateScreens: async () => ({
      previewPath: path.join(
        canonicalWorkspace,
        `candidate-screens-${runId}.html`,
      ),
    }),
    runHost: async (sessionFile, grantId) => {
      const session = JSON.parse(await readFile(sessionFile, "utf8"));
      const owner = JSON.parse(
        await readFile(
          path.join(path.dirname(sessionFile), `.mimic/progress-${runId}.lock`),
          "utf8",
        ),
      );
      assert.equal(owner.pid, process.pid);
      called.push({ session, grantId });
      stage = stage === "s04" ? "s01" : "done";
      return {
        sessionId: session.sessionId,
        executionPolicy: "authorized-existing-credit-risk-once",
        tasks: [{ taskId: stage === "s01" ? "s04" : "s01", phase: "accepted" }],
      };
    },
  });
  assert.equal(result.state, "review-ready");
  assert.equal(result.calls, 2);
  assert.equal(result.candidates, 3);
  assert.equal(result.humanSelectionId, null);
  assert.equal(
    result.candidateScreensPath,
    path.join(canonicalWorkspace, `candidate-screens-${runId}.html`),
  );
  assert.equal(called.length, 2);
  assert.notEqual(called[0].session.sessionId, called[1].session.sessionId);
  assert.ok(called.every(({ grantId }) => grantId === "grant_test"));
});

test("failed session is not retried and an accepted crash boundary resumes without another call", async (t) => {
  const { config, runId, workspace } = await fixture(t);
  let sessionId;
  const first = await progressDesign(config, "grant_test", 2, {
    preflight: async () => {},
    next: async () => next(runId, "s04"),
    review: async () => report(runId),
    runHost: async (sessionFile) => {
      sessionId = JSON.parse(await readFile(sessionFile, "utf8")).sessionId;
      throw Error("unknown official outcome");
    },
  });
  assert.equal(first.state, "needs-reconciliation");
  assert.equal(first.calls, 0);
  let repeated = false;
  const unresolved = await progressDesign(config, "grant_test", 1, {
    next: async () => next(runId, "s04"),
    checkpoint: async () => ({ tasks: { s04: { phase: "accepted" } } }),
    runHost: async () => {
      repeated = true;
    },
  });
  assert.equal(unresolved.state, "needs-reconciliation");
  assert.equal(repeated, false);
  const resumed = await progressDesign(config, "grant_test", 1, {
    next: async () => next(runId, "done", "IGNORE"),
    checkpoint: async () => ({ tasks: { s04: { phase: "accepted" } } }),
    review: async () => report(runId, "awaiting-human-selection", 3),
    runHost: async () => {
      repeated = true;
    },
  });
  assert.equal(resumed.state, "review-ready");
  assert.equal(resumed.calls, 0);
  assert.equal(repeated, false);
  const journal = JSON.parse(
    await readFile(
      path.join(workspace, `.mimic/progress-${runId}.json`),
      "utf8",
    ),
  );
  assert.equal(journal.inFlight, null);
  assert.ok(sessionId);
});

test("explicit retry preserves a rejected UPDATE and uses one fresh authorized session", async (t) => {
  const { config, runId, workspace } = await fixture(t);
  let firstSession;
  await progressDesign(config, "grant_test", 1, {
    preflight: async () => {},
    next: async () => next(runId, "s10", "UPDATE"),
    review: async () => report(runId),
    runHost: async (file) => {
      firstSession = JSON.parse(await readFile(file, "utf8")).sessionId;
      return {
        sessionId: firstSession,
        executionPolicy: "authorized-existing-credit-risk-once",
        tasks: [{ taskId: "s10", phase: "rejected" }],
      };
    },
  });
  let retriedSession;
  const retried = await progressDesign(config, "grant_test", 1, {
    allowRejectedRetry: true,
    preflight: async () => {},
    next: async () => next(runId, "s10", "UPDATE"),
    review: async () => report(runId),
    checkpoint: async () => ({
      sessionId: firstSession,
      status: "stopped",
      stop: "candidate-rejected",
      executionPolicy: "authorized-existing-credit-risk-once",
      tasks: { s10: { phase: "rejected", staticFailure: { candidate: true } } },
    }),
    runHost: async (file) => {
      retriedSession = JSON.parse(await readFile(file, "utf8")).sessionId;
      return {
        sessionId: retriedSession,
        executionPolicy: "authorized-existing-credit-risk-once",
        tasks: [{ taskId: "s10", phase: "rejected" }],
      };
    },
  });
  assert.equal(retried.state, "needs-reconciliation");
  assert.equal(retried.calls, 1);
  assert.notEqual(retriedSession, firstSession);
  const journal = JSON.parse(
    await readFile(
      path.join(workspace, `.mimic/progress-${runId}.json`),
      "utf8",
    ),
  );
  assert.deepEqual(journal.rejectedAttempts, [
    { taskId: "s10", sessionId: firstSession },
  ]);
  assert.equal(journal.inFlight.sessionId, retriedSession);
});

test("selected revision UPDATE is routed through the authorized host", async (t) => {
  const { config, runId } = await fixture(t);
  let invoked = false;
  const result = await progressDesign(config, "grant_test", 1, {
    preflight: async () => {},
    next: async () => next(runId, "s10", "UPDATE"),
    review: async () => report(runId),
    runHost: async (file) => {
      invoked = true;
      const { sessionId } = JSON.parse(await readFile(file, "utf8"));
      return {
        sessionId,
        executionPolicy: "authorized-existing-credit-risk-once",
        tasks: [{ taskId: "s10", phase: "rejected" }],
      };
    },
  });
  assert.equal(invoked, true);
  assert.equal(result.taskId, "s10");
  assert.equal(result.state, "needs-reconciliation");
});

test("call cap, Run budget, and incomplete S11 cannot report a ready comparison", async (t) => {
  const { config, runId } = await fixture(t);
  const noCall = async () => {
    throw Error("should not generate");
  };
  const budget = await progressDesign(config, "grant_test", 2, {
    next: async () => next(runId, "s04"),
    review: async () => report(runId, "generating", 0, 15),
    runHost: noCall,
  });
  assert.equal(budget.state, "call-limit");
  assert.equal(budget.calls, 0);
  const partial = await progressDesign(config, "grant_test", 1, {
    next: async () => ({
      ...next(runId, "s11"),
      actions: next(runId, "s11").actions.map((item) => ({
        ...item,
        action: "BLOCK",
      })),
    }),
    review: async () => report(runId, "awaiting-human-selection", 3),
    runHost: noCall,
  });
  assert.equal(partial.state, "blocked");
  assert.equal(partial.calls, 0);
});

test("rejected grant before a call leaves no in-flight session and permits a new grant", async (t) => {
  const { config, runId, workspace } = await fixture(t);
  let called = false;
  const rejected = await progressDesign(config, "grant_expired", 1, {
    next: async () => next(runId, "s04"),
    review: async () => report(runId),
    preflight: async () => {
      throw Error("No current authorization");
    },
    runHost: async () => {
      called = true;
    },
  });
  assert.equal(rejected.state, "authorization-needed");
  assert.equal(called, false);
  await assert.rejects(
    readFile(path.join(workspace, `.mimic/progress-${runId}.json`)),
    { code: "ENOENT" },
  );
  const resumed = await progressDesign(config, "grant_new", 1, {
    next: async () => next(runId, "s04"),
    review: async () => report(runId),
    preflight: async () => {},
    runHost: async (sessionFile) => {
      const session = JSON.parse(await readFile(sessionFile, "utf8"));
      called = true;
      return {
        sessionId: session.sessionId,
        executionPolicy: "authorized-existing-credit-risk-once",
        tasks: [],
      };
    },
  });
  assert.equal(resumed.state, "needs-reconciliation");
  assert.equal(called, true);
});

test("a dead runner's owned lock can be released without clearing its journal", async (t) => {
  const { config, runId, workspace } = await fixture(t);
  const lock = path.join(workspace, ".mimic", `progress-${runId}.lock`);
  await writeFile(
    lock,
    `${JSON.stringify({ runId, pid: 12345, host: os.hostname(), startedAt: new Date().toISOString() })}\n`,
  );
  await assert.rejects(
    recoverProgressLock(config, { processAlive: () => true }),
    /still alive/,
  );
  const journalFile = path.join(workspace, `.mimic/progress-${runId}.json`);
  await writeFile(
    journalFile,
    `${JSON.stringify({ version: 1, runId, inFlight: { taskId: "s04", sessionId: "session_unknown" } })}\n`,
  );
  const recovered = await recoverProgressLock(config, {
    processAlive: () => false,
  });
  assert.equal(recovered.runId, runId);
  assert.match(await readFile(journalFile, "utf8"), /session_unknown/);
  await assert.rejects(readFile(lock), {
    code: "ENOENT",
  });
  await writeFile(lock, "occupied\n");
  const recovery = `${lock}.recovery`;
  await mkdir(recovery);
  await assert.rejects(
    progressDesign(config, "grant_test", 1),
    /recovery is active/,
  );
  await rm(recovery, { recursive: true });
  await rm(lock);
});

test("changed plan or concurrent runner fails before an authorized model call", async (t) => {
  const { config, runId, workspace } = await fixture(t);
  const lock = path.join(workspace, ".mimic", `progress-${runId}.lock`);
  await writeFile(lock, "occupied\n");
  await assert.rejects(
    progressDesign(config, "grant_test", 1),
    /already running/,
  );
  await rm(lock);
  const file = path.join(workspace, `tasks-${runId}.json`);
  await writeFile(file, `${(await readFile(file, "utf8")).trimEnd()} `);
  await assert.rejects(prepareProgress(config), /Core Run plan changed/);
  const altered = await readFile(file, "utf8");
  await writeFile(path.join(workspace, `.mimic/runs/${runId}.json`), altered);
  const manifestFile = path.join(workspace, `trial-${runId}.json`);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.planDigest = `sha256:${createHash("sha256").update(altered).digest("hex")}`;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    prepareProgress(config),
    /Plan differs from the brief and template/,
  );
});
