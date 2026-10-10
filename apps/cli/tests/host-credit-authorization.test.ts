import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HostCreditAuthorizationStore,
  frozenRunInputsSha256,
  type HumanCreditDecisionSource,
} from "../src/agent/host-credit-authorization.js";

const folders: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function setup(maxCalls = 1) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-host-auth-"));
  folders.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await mkdir(path.join(workspace, ".mimic", "runs"), { recursive: true });
  await mkdir(path.join(workspace, "skills", "s04"), { recursive: true });
  await writeFile(
    path.join(workspace, ".mimic", "config.json"),
    '{"scopes":[]}',
  );
  await writeFile(path.join(workspace, ".mimic", "runs", "run_197.json"), "[]");
  await writeFile(
    path.join(workspace, "skills", "s04", "SKILL.md"),
    "frozen instructions",
  );
  const canonicalWorkspace = await realpath(workspace);
  const store = new HostCreditAuthorizationStore(path.join(root, "private"));
  const scope = {
    workspace: canonicalWorkspace,
    runId: "run_197",
    model: "gpt-6.1-sol",
    executable: process.execPath,
    maxCalls,
    expiresAt: Date.now() + 60_000,
    packages: { s04: "skills/s04" },
  };
  const source: HumanCreditDecisionSource = {
    requestDecision: vi.fn(async () => ({
      decisionId: "1human-event-197",
      actorId: "person@example.com",
      approvedAt: Date.now(),
    })),
  };
  const grantId = await store.record(scope, source);
  const inputsSha256 = await frozenRunInputsSha256(
    canonicalWorkspace,
    scope.runId,
    scope.packages,
  );
  const expected = {
    requestId: "session_s04_a-1",
    workspace: canonicalWorkspace,
    model: scope.model,
    promptSha256: createHash("sha256")
      .update("frozen S04 prompt")
      .digest("hex"),
  };
  return {
    root,
    workspace: canonicalWorkspace,
    store,
    scope,
    source,
    grantId,
    expected,
    inputsSha256,
  };
}

test("a host decision is recorded once and consumed for one exact prompt", async () => {
  const h = await setup();
  expect(await h.store.executableFor(h.grantId, h.workspace)).toBe(
    process.execPath,
  );
  expect(h.source.requestDecision).toHaveBeenCalledWith({
    ...h.scope,
    workspace: h.workspace,
    inputsSha256: h.inputsSha256,
  });
  const port = h.store.port(
    h.grantId,
    h.scope.runId,
    h.expected,
    h.inputsSha256,
    h.scope.packages,
    h.scope.executable,
  );
  const receipt = await port.consumeUserDecision(h.expected);
  expect(receipt.decisionId).toMatch(/^use_[a-f0-9]{64}$/);
  expect(receipt.expiresAt).toBeGreaterThan(Date.now());
  await expect(port.consumeUserDecision(h.expected)).rejects.toThrow(
    /No current authorization/,
  );
  await expect(h.store.record(h.scope, h.source)).rejects.toThrow(
    /already been recorded/,
  );
});

test("the recorded grant keeps the exact scope displayed before confirmation", async () => {
  const h = await setup();
  const mutable = { ...h.scope };
  const grantId = await h.store.record(mutable, {
    requestDecision: async (displayed) => {
      expect(displayed.maxCalls).toBe(1);
      expect(displayed.model).toBe(h.scope.model);
      mutable.maxCalls = 20;
      mutable.expiresAt = Date.now() + 24 * 60 * 60_000;
      mutable.runId = "run_other";
      mutable.model = "other-model";
      return {
        decisionId: "human-event-mutable-source",
        actorId: "person@example.com",
        approvedAt: Date.now(),
      };
    },
  });
  const first = h.store.port(
    grantId,
    h.scope.runId,
    h.expected,
    h.inputsSha256,
    h.scope.packages,
    h.scope.executable,
  );
  await expect(first.consumeUserDecision(h.expected)).resolves.toBeDefined();
  const next = { ...h.expected, requestId: "session_next-1" };
  await expect(
    h.store
      .port(
        grantId,
        h.scope.runId,
        next,
        h.inputsSha256,
        h.scope.packages,
        h.scope.executable,
      )
      .consumeUserDecision(next),
  ).rejects.toThrow(/No current authorization/);
});

test("request, prompt, workspace, model, and Run scope cannot drift", async () => {
  const h = await setup();
  const port = h.store.port(
    h.grantId,
    h.scope.runId,
    h.expected,
    h.inputsSha256,
    h.scope.packages,
    h.scope.executable,
  );
  for (const actual of [
    { ...h.expected, requestId: "session_other-1" },
    { ...h.expected, promptSha256: "b".repeat(64) },
    { ...h.expected, workspace: h.root },
    { ...h.expected, model: "gpt-other" },
  ])
    await expect(port.consumeUserDecision(actual)).rejects.toThrow(
      /differs from approved/,
    );
  await expect(
    h.store
      .port(
        h.grantId,
        "run_other",
        h.expected,
        h.inputsSha256,
        h.scope.packages,
        h.scope.executable,
      )
      .consumeUserDecision(h.expected),
  ).rejects.toThrow();
  await expect(
    h.store
      .port(
        h.grantId,
        h.scope.runId,
        h.expected,
        h.inputsSha256,
        h.scope.packages,
        "/different-host-binary",
      )
      .consumeUserDecision(h.expected),
  ).rejects.toThrow(/No current authorization/);
  await expect(port.consumeUserDecision(h.expected)).resolves.toBeDefined();
});

test("a changed saved plan or Skill package invalidates the approved Run snapshot", async () => {
  const h = await setup();
  const port = h.store.port(
    h.grantId,
    h.scope.runId,
    h.expected,
    h.inputsSha256,
    h.scope.packages,
    h.scope.executable,
  );
  await writeFile(
    path.join(h.workspace, "skills", "s04", "SKILL.md"),
    "changed instructions",
  );
  const changed = await frozenRunInputsSha256(
    h.workspace,
    h.scope.runId,
    h.scope.packages,
  );
  expect(changed).not.toBe(h.inputsSha256);
  await expect(port.consumeUserDecision(h.expected)).rejects.toThrow(
    /Frozen Run inputs changed/,
  );
});

test("equivalent package mappings have one stable Run snapshot", async () => {
  const h = await setup();
  await mkdir(path.join(h.workspace, "skills", "s05"));
  await writeFile(
    path.join(h.workspace, "skills", "s05", "SKILL.md"),
    "second Skill",
  );
  const forward = await frozenRunInputsSha256(h.workspace, h.scope.runId, {
    s04: "skills/s04",
    s05: "skills/s05",
  });
  const reverse = await frozenRunInputsSha256(h.workspace, h.scope.runId, {
    s05: "skills/s05",
    s04: "skills/s04",
  });
  expect(reverse).toBe(forward);
});

test("a deeply nested Skill tree cannot stall authorization", async () => {
  const h = await setup();
  await mkdir(
    path.join(h.workspace, "skills", "s04", ...Array(31).fill("nested")),
    { recursive: true },
  );
  await expect(
    frozenRunInputsSha256(h.workspace, h.scope.runId, h.scope.packages),
  ).rejects.toThrow(/tree exceeds host limit/);
});

test("simultaneous and repeated calls cannot consume one grant twice", async () => {
  const h = await setup();
  const results = await Promise.allSettled([
    h.store
      .port(
        h.grantId,
        h.scope.runId,
        h.expected,
        h.inputsSha256,
        h.scope.packages,
        h.scope.executable,
      )
      .consumeUserDecision(h.expected),
    h.store
      .port(
        h.grantId,
        h.scope.runId,
        h.expected,
        h.inputsSha256,
        h.scope.packages,
        h.scope.executable,
      )
      .consumeUserDecision(h.expected),
  ]);
  expect(results.map((item) => item.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
});

test("an interrupted database writer releases its transaction without consuming a grant", async () => {
  const h = await setup();
  const interrupted = spawnSync(process.execPath, [
    "-e",
    `const { DatabaseSync } = require('node:sqlite');
       const database = new DatabaseSync(process.argv[1]);
       database.exec('BEGIN IMMEDIATE');
       process.exit(0);`,
    path.join(h.root, "private", "grants.sqlite"),
  ]);
  expect(interrupted.status).toBe(0);
  await expect(
    h.store
      .port(
        h.grantId,
        h.scope.runId,
        h.expected,
        h.inputsSha256,
        h.scope.packages,
        h.scope.executable,
      )
      .consumeUserDecision(h.expected),
  ).resolves.toBeDefined();
});

test("one Run approval can cover a bounded series, never an unlimited call", async () => {
  const h = await setup(2);
  await h.store
    .port(
      h.grantId,
      h.scope.runId,
      h.expected,
      h.inputsSha256,
      h.scope.packages,
      h.scope.executable,
    )
    .consumeUserDecision(h.expected);
  const next = { ...h.expected, requestId: "session_s05_a-1" };
  await h.store
    .port(
      h.grantId,
      h.scope.runId,
      next,
      h.inputsSha256,
      h.scope.packages,
      h.scope.executable,
    )
    .consumeUserDecision(next);
  const third = { ...h.expected, requestId: "session_s10_a-1" };
  await expect(
    h.store
      .port(
        h.grantId,
        h.scope.runId,
        third,
        h.inputsSha256,
        h.scope.packages,
        h.scope.executable,
      )
      .consumeUserDecision(third),
  ).rejects.toThrow(/No current authorization/);
});

test("revocation, expiration, cancellation, and absent approval fail closed", async () => {
  const h = await setup();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    h.store
      .port(
        h.grantId,
        h.scope.runId,
        h.expected,
        h.inputsSha256,
        h.scope.packages,
        h.scope.executable,
      )
      .consumeUserDecision(h.expected, cancelled.signal),
  ).rejects.toThrow(/cancelled/);
  await h.store.revoke(h.grantId, h.workspace);
  await expect(
    h.store
      .port(
        h.grantId,
        h.scope.runId,
        h.expected,
        h.inputsSha256,
        h.scope.packages,
        h.scope.executable,
      )
      .consumeUserDecision(h.expected),
  ).rejects.toThrow(/No current authorization/);
  const fresh = await setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(fresh.scope.expiresAt + 1);
  await expect(
    fresh.store
      .port(
        fresh.grantId,
        fresh.scope.runId,
        fresh.expected,
        fresh.inputsSha256,
        fresh.scope.packages,
        fresh.scope.executable,
      )
      .consumeUserDecision(fresh.expected),
  ).rejects.toThrow(/No current authorization/);
  vi.useRealTimers();
  await expect(
    fresh.store.record(fresh.scope, { requestDecision: async () => null }),
  ).rejects.toThrow(/No fresh human authorization/);
});

test("the host cannot recycle a prior answer or record an already expired approval", async () => {
  const h = await setup();
  await expect(
    h.store.record(h.scope, {
      requestDecision: async () => ({
        decisionId: "older-unrecorded-answer",
        actorId: "person@example.com",
        approvedAt: Date.now() - 1000,
      }),
    }),
  ).rejects.toThrow(/No fresh human authorization/);

  vi.useFakeTimers({ toFake: ["Date"] });
  const expiresAt = Date.now() + 1000;
  await expect(
    h.store.record(
      { ...h.scope, expiresAt },
      {
        requestDecision: async () => {
          vi.setSystemTime(expiresAt + 1);
          return {
            decisionId: "delayed-host-answer",
            actorId: "person@example.com",
            approvedAt: Date.now(),
          };
        },
      },
    ),
  ).rejects.toThrow(/expired during confirmation/);
});

test("host storage is private and outside the model workspace", async () => {
  const h = await setup();
  await expect(
    new HostCreditAuthorizationStore(path.join(h.workspace, "grants")).record(
      h.scope,
      h.source,
    ),
  ).rejects.toThrow(/cannot be inside/);
});
