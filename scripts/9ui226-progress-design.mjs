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
import { makePlan } from "./9ui197-harness.mjs";

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
  assert(
    config?.condition === "guided",
    "Only an initial guided Run is supported",
  );
  assert(/^run_[A-Za-z0-9_-]+$/.test(config.runId ?? ""), "Invalid Run ID");
  const workspace = await realpath(config.workspace);
  assert(
    config.workspace === workspace &&
      file.startsWith(`${workspace}${path.sep}`),
    "Config must be in its canonical workspace",
  );
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
  assert(
    planText === json(makePlan(JSON.parse(templateText), config)),
    "Plan differs from the brief and template",
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
      const runnable = next.actions.filter(
        (action) => action.action === "GENERATE",
      );
      if (!runnable.length)
        return {
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
      action === "recover-lock" &&
      configPath &&
      process.argv.length === 4
    )
      console.log(json(await recoverProgressLock(configPath)));
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
        "Usage: node scripts/9ui226-progress-design.mjs scope <trial-config.json> | run <trial-config.json> <existing-grant-id> <max-calls> | recover-lock <trial-config.json>",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
