#!/usr/bin/env node
/** Advance one prepared guided Run through its existing authorized host path. */
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  link,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { designInputs } from "./9ui225-start-design.mjs";
import { approvedHistory, makePlan } from "./9ui197-harness.mjs";

const execFile = promisify(execFileCallback);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};

async function regularFile(file) {
  const info = await lstat(file);
  assert(
    info.isFile() && (await realpath(file)) === file,
    `Changed file: ${file}`,
  );
  return readFile(file, "utf8");
}

async function treeHash(folder) {
  const entries = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      assert(!entry.isSymbolicLink(), "Package tree contains a link");
      if (entry.isDirectory()) await visit(file);
      else {
        assert(entry.isFile(), "Package tree contains a non-file");
        entries.push([path.relative(folder, file), sha(await readFile(file))]);
      }
    }
  }
  await visit(folder);
  return sha(
    JSON.stringify(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

export async function preparedDesign(configPath) {
  const file = await realpath(configPath);
  const config = JSON.parse(await regularFile(file));
  assert(config?.condition === "guided", "Only a guided Run is supported");
  assert(/^run_[A-Za-z0-9_-]+$/.test(config.runId ?? ""), "Invalid Run ID");
  const workspace = await realpath(config.workspace);
  assert(
    config.workspace === workspace &&
      file.startsWith(`${workspace}${path.sep}`),
    "Config must be in its canonical workspace",
  );
  if (!config.previousRunId) {
    const source = JSON.parse(
      await regularFile(path.join(workspace, "intake-source.json")),
    );
    const expected = designInputs(source, workspace);
    assert(expected.runId === config.runId, "Run differs from intake");
    for (const [name, contents] of Object.entries(expected.files))
      assert(
        (await regularFile(path.join(workspace, name))) === contents,
        `Intake changed: ${name}`,
      );
  }
  const planText = await regularFile(
    path.join(workspace, `tasks-${config.runId}.json`),
  );
  assert(
    planText ===
      (await regularFile(
        path.join(workspace, `.mimic/runs/${config.runId}.json`),
      )),
    "Core Run plan changed",
  );
  const plan = JSON.parse(planText);
  const manifest = JSON.parse(
    await regularFile(path.join(workspace, `trial-${config.runId}.json`)),
  );
  const templateText = await regularFile(
    path.join(repo, "docs/dogfood/9ui183/plan-template.json"),
  );
  assert(
    manifest.templateDigest === sha(templateText),
    "Plan template changed",
  );
  const history = await approvedHistory(workspace, manifest);
  const planConfig = config.previousRunId
    ? {
        ...config,
        selectedBase: history.baseContent,
        selectedSelectionId: history.baseSelectionId,
      }
    : config;
  assert(
    planText === json(makePlan(JSON.parse(templateText), planConfig)),
    "Plan differs from the brief and template or selected base",
  );
  for (const [key, value] of Object.entries(config))
    assert(
      JSON.stringify(manifest[key]) === JSON.stringify(value),
      `Manifest differs: ${key}`,
    );
  assert(manifest.planDigest === sha(planText), "Plan digest differs");
  assert(
    manifest.skillTreeDigest ===
      (await treeHash(path.join(workspace, "skills"))),
    "Skill package changed",
  );
  assert(
    manifest.schemaTreeDigest ===
      (await treeHash(path.join(workspace, "schemas"))),
    "Schema package changed",
  );
  assert(
    manifest.referenceDigest ===
      sha(await regularFile(path.join(workspace, config.referenceFile))),
    "Reference evidence changed",
  );
  for (const [name, digest] of Object.entries(manifest.evidenceDigests ?? {}))
    assert(
      digest === sha(await regularFile(path.join(workspace, name))),
      `Evidence changed: ${name}`,
    );
  assert(Array.isArray(plan) && plan.length > 0, "No planned tasks");
  const skillById = new Map();
  for (const entry of await readdir(path.join(workspace, "skills"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const text = await regularFile(
      path.join(workspace, "skills", entry.name, "manifest.yaml"),
    );
    const id = text.match(/^\s*"skillId":\s*"([^"]+)"/m)?.[1];
    assert(id && !skillById.has(id), "Invalid Skill mapping");
    skillById.set(id, `skills/${entry.name}`);
  }
  const packages = Object.create(null);
  for (const task of plan) {
    assert(
      typeof task.id === "string" &&
        !packages[task.id] &&
        skillById.has(task.skillId),
      "Plan Skill mapping changed",
    );
    packages[task.id] = skillById.get(task.skillId);
  }
  return { config, workspace, plan, packages };
}

async function writeSame(file, value) {
  try {
    await writeFile(file, json(value), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert(
      (await regularFile(file)) === json(value),
      "Prepared progress scope differs",
    );
  }
}

export async function prepareProgress(configPath) {
  const { config, workspace, packages } = await preparedDesign(configPath);
  const file = path.join(workspace, `progress-scope-${config.runId}.json`);
  await writeSame(file, {
    workspace,
    runId: config.runId,
    sessionId: `session_scope_${config.runId}`,
    model: config.model,
    timeoutMs: config.budget.timeoutMs,
    maxGenerations: 1,
    maxOutputBytes: 4_000_000,
    packages,
  });
  return {
    runId: config.runId,
    scopeConfig: file,
    model: config.model,
    packages,
    generation: "not-started",
  };
}

async function command(binary, args) {
  const { stdout } = await execFile(process.execPath, [binary, ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function cliNext(workspace, runId) {
  return command(path.join(repo, "apps/cli/dist/main.js"), [
    "next",
    runId,
    "--root",
    workspace,
    "--json",
  ]);
}

async function review(configPath) {
  return command(path.join(repo, "scripts/9ui197-harness.mjs"), [
    "review",
    configPath,
  ]);
}

async function candidateScreens(configPath) {
  return command(path.join(repo, "scripts/9ui197-harness.mjs"), [
    "candidate-screens",
    configPath,
  ]);
}

async function revisionScreen(configPath) {
  return command(path.join(repo, "scripts/9ui197-harness.mjs"), [
    "revision-screen",
    configPath,
  ]);
}

async function runHost(sessionFile, grantId) {
  return command(path.join(repo, "apps/cli/dist/agent/host-credit-cli.js"), [
    "run",
    sessionFile,
    grantId,
  ]);
}

async function checkpoint(workspace, sessionId) {
  const { FileSessionStore } =
    await import("../apps/cli/dist/agent/session.js");
  return new FileSessionStore(workspace).read(sessionId);
}

async function preflightGrant(workspace, grantId, config, packages) {
  const { HostCreditAuthorizationStore } =
    await import("../apps/cli/dist/agent/host-credit-authorization.js");
  const store = new HostCreditAuthorizationStore(
    path.join(os.homedir(), ".local/share/mimic/credit-authorizations"),
  );
  await store.availableForRun(
    grantId,
    workspace,
    config.runId,
    config.model,
    packages,
  );
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

/** Only a verified, exited owner can release an abandoned runner lock. */
export async function recoverProgressLock(configPath, operations = {}) {
  const { config, workspace } = await preparedDesign(configPath);
  const lock = path.join(workspace, ".mimic", `progress-${config.runId}.lock`);
  const recovery = `${lock}.recovery`;
  await mkdir(recovery, { mode: 0o700 });
  try {
    const owner = JSON.parse(await regularFile(lock));
    assert(
      owner.runId === config.runId &&
        owner.host === os.hostname() &&
        Number.isSafeInteger(owner.pid) &&
        owner.pid > 0 &&
        /^\d{4}-\d\d-\d\dT/.test(owner.startedAt ?? ""),
      "Lock owner evidence is invalid; inspect manually",
    );
    assert(
      !(operations.processAlive ?? processAlive)(owner.pid),
      "Progress owner is still alive",
    );
    const abandoned = `${lock}.${randomUUID()}.abandoned`;
    await rename(lock, abandoned);
    await unlink(abandoned);
    return {
      runId: config.runId,
      releasedOwner: owner,
      next: "Run again; any in-flight session still requires checkpoint reconciliation",
    };
  } finally {
    await rm(recovery, { recursive: true, force: true });
  }
}

async function writeJournal(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, json(value), { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

/** Re-submit one rejected S10 raw output after deriving only the machine-owned
 * candidate state. The original raw, prepared work, and rejected checkpoint
 * remain unchanged; Core still performs the authoritative static validation. */
export async function reconcileS10Candidate(
  configPath,
  sessionId,
  operations = {},
) {
  const { config, workspace, packages } = await preparedDesign(configPath);
  assert(
    /^session_progress_s10_[A-Za-z0-9]+$/.test(sessionId ?? ""),
    "Invalid S10 session ID",
  );
  const lock = path.join(workspace, ".mimic", `progress-${config.runId}.lock`);
  const pending = `${lock}.${randomUUID()}.tmp`;
  await writeFile(
    pending,
    json({
      runId: config.runId,
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
    }),
    { flag: "wx", mode: 0o600 },
  );
  try {
    await link(pending, lock);
  } catch (error) {
    await unlink(pending);
    if (error.code === "EEXIST")
      throw Error("Progress is already running or needs lock reconciliation");
    throw error;
  }
  await unlink(pending);
  try {
    const journalFile = path.join(
      workspace,
      `.mimic/progress-${config.runId}.json`,
    );
    const journal = JSON.parse(await regularFile(journalFile));
    assert(
      journal.version === 1 &&
        journal.runId === config.runId &&
        journal.inFlight?.taskId === "s10" &&
        journal.inFlight.sessionId === sessionId,
      "Reconciliation differs from the stopped Run",
    );
    const saved = await (operations.checkpoint ?? checkpoint)(
      workspace,
      sessionId,
    );
    const task = saved?.tasks?.s10;
    assert(
      saved?.stop === "candidate-rejected" &&
        saved?.generationCount === 1 &&
        task?.phase === "rejected" &&
        task.rejectionReason === "static-validation" &&
        task.staticFailure?.reason === "candidate-validation" &&
        task.work?.path?.startsWith(`.mimic/agent-work/${sessionId}-s10-`) &&
        /^[a-f0-9]{64}$/.test(task.work.digest ?? ""),
      "Only an exact rejected S10 candidate can be reconciled",
    );
    const { sessionDigest } = await import("../apps/cli/dist/agent/session.js");
    const { prepareCodexWorkEnvelope } =
      await import("../apps/cli/dist/agent/session-cli.js");
    const original = JSON.parse(
      await regularFile(path.join(workspace, task.work.path)),
    );
    assert(
      sessionDigest(original) === task.work.digest,
      "Rejected work changed",
    );
    const folder = path.join(workspace, ".mimic/agent-work");
    const candidates = [];
    for (const name of await readdir(folder)) {
      if (!name.startsWith(`${sessionId}-s10-`) || !name.endsWith(".raw.json"))
        continue;
      const raw = JSON.parse(await regularFile(path.join(folder, name)));
      if (raw.normalizedDigest === task.work.digest)
        candidates.push({ name, raw });
    }
    assert(candidates.length === 1, "Original model output is ambiguous");
    const { name: rawFileName, raw } = candidates[0];
    assert(
      typeof raw.output === "string" &&
        raw.outputDigest === sessionDigest(raw.output),
      "Original model output changed",
    );
    const legacy = prepareCodexWorkEnvelope(raw.output, task.binding, false);
    assert(
      sessionDigest(legacy) === task.work.digest,
      "Rejected work does not match the original model output",
    );
    const derived = prepareCodexWorkEnvelope(raw.output, task.binding);
    assert(
      Array.isArray(derived.artifacts) &&
        derived.artifacts.length > 0 &&
        derived.artifacts.every(
          (artifact) =>
            artifact.meta?.type === "design-direction" &&
            artifact.content?.selectionStatus === "candidate",
        ),
      "Candidate state cannot be derived for this output",
    );
    const digest = sessionDigest(derived);
    assert(digest !== task.work.digest, "No missing candidate state to derive");
    const relative = `.mimic/agent-work/${sessionId}-s10-${digest}.reconciled.json`;
    await writeSame(path.join(workspace, relative), derived);
    await (
      operations.submit ??
      ((relativeWork) =>
        command(path.join(repo, "apps/cli/dist/main.js"), [
          "submit",
          config.runId,
          "--task",
          "s10",
          "--package",
          packages.s10,
          "--work",
          relativeWork,
          "--root",
          workspace,
          "--json",
        ]))
    )(relative);
    const next = await (operations.next ?? cliNext)(workspace, config.runId);
    assert(
      next.actions?.some(
        (action) => action.taskId === "s10" && action.action === "IGNORE",
      ),
      "Core did not accept the reconciled candidate",
    );
    await writeSame(
      path.join(workspace, `.mimic/reconciled-${sessionId}.json`),
      {
        version: 1,
        runId: config.runId,
        sessionId,
        rawFileName,
        rawOutputDigest: raw.outputDigest,
        originalWorkDigest: task.work.digest,
        derivedWorkDigest: digest,
        derivation: "missing-s10-selection-status-candidate",
      },
    );
    await writeJournal(journalFile, { ...journal, inFlight: null });
    return {
      runId: config.runId,
      taskId: "s10",
      state: "reconciled-from-saved-output",
      modelCalls: 0,
      originalWorkDigest: task.work.digest,
      derivedWorkDigest: digest,
    };
  } finally {
    await unlink(lock);
  }
}

/** A provided grant is consumed only by the existing trusted host command. */
export async function progressDesign(
  configPath,
  grantId,
  maxCalls,
  operations = {},
) {
  assert(
    /^grant_[A-Za-z0-9_-]+$/.test(grantId ?? ""),
    "A previously authorized grant ID is required",
  );
  assert(
    Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 20,
    "Explicit call cap must be 1–20",
  );
  const { config, workspace, plan, packages } =
    await preparedDesign(configPath);
  const scope = await prepareProgress(configPath);
  const lock = path.join(workspace, ".mimic", `progress-${config.runId}.lock`);
  const recovery = `${lock}.recovery`;
  const pending = `${lock}.${randomUUID()}.tmp`;
  try {
    await lstat(recovery);
    throw new Error("Progress lock recovery is active");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(
    pending,
    json({
      runId: config.runId,
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
    }),
    { flag: "wx", mode: 0o600 },
  );
  try {
    await link(pending, lock);
  } catch (error) {
    await unlink(pending);
    if (error.code === "EEXIST")
      throw new Error(
        "Progress is already running or needs lock reconciliation",
      );
    throw error;
  }
  await unlink(pending);
  const journalFile = path.join(
    workspace,
    `.mimic/progress-${config.runId}.json`,
  );
  let calls = 0;
  try {
    let journal;
    try {
      journal = JSON.parse(await regularFile(journalFile));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      journal = { version: 1, runId: config.runId, inFlight: null };
    }
    assert(
      journal.version === 1 && journal.runId === config.runId,
      "Progress journal changed",
    );
    for (;;) {
      const next = await (operations.next ?? cliNext)(workspace, config.runId);
      assert(
        next.runId === config.runId && Array.isArray(next.actions),
        "Core next differs from Run",
      );
      if (journal.inFlight) {
        const prior = journal.inFlight;
        const saved = await (operations.checkpoint ?? checkpoint)(
          workspace,
          prior.sessionId,
        );
        const completedInCore = next.actions.some(
          (action) =>
            action.taskId === prior.taskId && action.action === "IGNORE",
        );
        if (
          operations.allowRejectedRetry === true &&
          saved?.sessionId === prior.sessionId &&
          saved.status === "stopped" &&
          saved.stop === "candidate-rejected" &&
          saved.executionPolicy === "authorized-existing-credit-risk-once" &&
          saved.tasks?.[prior.taskId]?.phase === "rejected" &&
          saved.tasks[prior.taskId].staticFailure?.candidate === true &&
          next.actions.some(
            (action) =>
              action.taskId === prior.taskId &&
              ["GENERATE", "UPDATE"].includes(action.action),
          ) &&
          !(journal.rejectedAttempts ?? []).some(
            (attempt) => attempt.taskId === prior.taskId,
          )
        ) {
          journal = {
            ...journal,
            inFlight: null,
            rejectedAttempts: [
              ...(journal.rejectedAttempts ?? []),
              { taskId: prior.taskId, sessionId: prior.sessionId },
            ],
          };
          await (operations.writeJournal ?? writeJournal)(journalFile, journal);
          continue;
        }
        if (
          saved?.tasks?.[prior.taskId]?.phase !== "accepted" ||
          !completedInCore
        )
          return {
            runId: config.runId,
            state: "needs-reconciliation",
            taskId: prior.taskId,
            sessionId: prior.sessionId,
            calls,
            generation: "no-new-call",
          };
        journal = { ...journal, inFlight: null };
        await (operations.writeJournal ?? writeJournal)(journalFile, journal);
      }
      const report = await (operations.review ?? review)(configPath);
      assert(report.runId === config.runId, "Review differs from Run");
      const runnable = next.actions.filter((action) =>
        ["GENERATE", "UPDATE"].includes(action.action),
      );
      if (!runnable.length) {
        const result = {
          runId: config.runId,
          state:
            next.state === "review-ready" &&
            plan.every((task) =>
              next.actions.some(
                (action) =>
                  action.taskId === task.id && action.action === "IGNORE",
              ),
            ) &&
            report.candidates.length &&
            [
              "awaiting-human-selection",
              "awaiting-working-selection",
              "selected",
              "revision-limit",
            ].includes(report.status)
              ? "review-ready"
              : "blocked",
          reviewStatus: report.status,
          reviewPath: report.reviewPath,
          candidates: report.candidates.length,
          calls,
          humanSelectionId: report.humanSelectionId,
        };
        if (result.state === "review-ready" && !result.humanSelectionId) {
          try {
            const isRevision = !!config.previousRunId;
            const preview = await (isRevision
              ? (operations.revisionScreen ?? revisionScreen)(configPath)
              : (operations.candidateScreens ?? candidateScreens)(configPath));
            assert(
              isRevision
                ? preview.previewPath ===
                    path.join(
                      workspace,
                      `revision-screen-${config.runId}.html`,
                    ) &&
                    JSON.stringify(preview.baseRef) ===
                      JSON.stringify(config.baseRef) &&
                    JSON.stringify(preview.revisionRef) ===
                      JSON.stringify(report.candidates[0]?.ref)
                : preview.previewPath?.startsWith(`${workspace}${path.sep}`),
              "Design screen path differs from Run",
            );
            const linked = await (operations.review ?? review)(configPath);
            assert(
              linked.runId === config.runId,
              "Linked review differs from Run",
            );
            result.reviewPath = linked.reviewPath;
            if (isRevision) result.revisionScreenPath = preview.previewPath;
            else result.candidateScreensPath = preview.previewPath;
          } catch (error) {
            if (config.previousRunId)
              result.revisionScreenUnavailable = error.message;
            else result.candidateScreensUnavailable = error.message;
          }
        }
        return result;
      }
      if (
        calls >= maxCalls ||
        report.usage.generationReservations >= config.budget.maxGenerations
      )
        return {
          runId: config.runId,
          state: "call-limit",
          nextTaskId: runnable[0].taskId,
          reviewPath: report.reviewPath,
          calls,
        };
      const taskId = plan.find((task) =>
        runnable.some((action) => action.taskId === task.id),
      )?.id;
      assert(
        taskId && packages[taskId],
        "Runnable task is outside the frozen plan",
      );
      const sessionId = `session_progress_${taskId}_${randomUUID().replaceAll("-", "")}`;
      const sessionFile = path.join(workspace, `progress-${sessionId}.json`);
      try {
        await (operations.preflight ?? preflightGrant)(
          workspace,
          grantId,
          config,
          packages,
        );
      } catch (error) {
        if (!/No current authorization/.test(error.message)) throw error;
        return {
          runId: config.runId,
          state: "authorization-needed",
          nextTaskId: taskId,
          calls,
          generation: "no-new-call",
        };
      }
      await writeSame(sessionFile, {
        ...JSON.parse(await regularFile(scope.scopeConfig)),
        sessionId,
      });
      journal = { ...journal, inFlight: { taskId, sessionId } };
      await (operations.writeJournal ?? writeJournal)(journalFile, journal);
      let result;
      try {
        result = await (operations.runHost ?? runHost)(sessionFile, grantId);
      } catch {
        return {
          runId: config.runId,
          state: "needs-reconciliation",
          taskId,
          sessionId,
          calls,
          generation: "outcome-unknown",
        };
      }
      calls += 1;
      const accepted =
        result.sessionId === sessionId &&
        result.executionPolicy === "authorized-existing-credit-risk-once" &&
        result.tasks?.some(
          (task) => task.taskId === taskId && task.phase === "accepted",
        );
      const after = await (operations.next ?? cliNext)(workspace, config.runId);
      if (
        !accepted ||
        after.runId !== config.runId ||
        !after.actions?.some(
          (action) => action.taskId === taskId && action.action === "IGNORE",
        )
      )
        return {
          runId: config.runId,
          state: "needs-reconciliation",
          taskId,
          sessionId,
          calls,
          generation: "stopped-or-unaccepted",
        };
      journal = { ...journal, inFlight: null };
      await (operations.writeJournal ?? writeJournal)(journalFile, journal);
    }
  } finally {
    await unlink(lock);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [, , action, configPath, grantId, cap] = process.argv;
  try {
    if (action === "scope" && configPath && process.argv.length === 4)
      console.log(json(await prepareProgress(configPath)));
    else if (
      action === "reconcile-s10" &&
      configPath &&
      grantId &&
      process.argv.length === 5
    )
      console.log(json(await reconcileS10Candidate(configPath, grantId)));
    else if (
      action === "recover-lock" &&
      configPath &&
      process.argv.length === 4
    )
      console.log(json(await recoverProgressLock(configPath)));
    else if (
      action === "retry-rejected" &&
      configPath &&
      grantId &&
      cap &&
      process.argv.length === 6
    )
      console.log(
        json(
          await progressDesign(configPath, grantId, Number(cap), {
            allowRejectedRetry: true,
          }),
        ),
      );
    else if (
      action === "run" &&
      configPath &&
      grantId &&
      cap &&
      process.argv.length === 6
    )
      console.log(json(await progressDesign(configPath, grantId, Number(cap))));
    else
      throw new Error(
        "Usage: node scripts/9ui226-progress-design.mjs scope <trial-config.json> | run <trial-config.json> <existing-grant-id> <max-calls> | retry-rejected <trial-config.json> <existing-grant-id> <max-calls> | reconcile-s10 <trial-config.json> <stopped-session-id> | recover-lock <trial-config.json>",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
