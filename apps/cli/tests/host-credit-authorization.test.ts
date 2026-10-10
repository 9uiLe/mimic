import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HostCreditAuthorizationStore,
  frozenRunInputsSha256,
  type HumanCreditDecisionSource,
  type DelegatedCreditEvidence,
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

function delegatedEvidence(
  h: Awaited<ReturnType<typeof setup>>,
): DelegatedCreditEvidence {
  return {
    sourceThreadId: "thread_197",
    requestMessageId: "assistant_scoped_request",
    requestText: "Allow up to 9 calls for 24 hours for the guided Run.",
    delegationMessageId: "user_delegated_execution",
    delegationText: "Run it for me.",
    contextMessageId: "assistant_delegation_question",
    approvalMessageId: "user_approved_delegation",
    contextText:
      "Use the 197 guided Run with at most 9 calls for 24 hours; dot records the delegation.",
    approvalText: "OK",
    approverId: "person@example.com",
    delegateId: "dot",
    recordedBy: "dot",
    approvedAt: h.scope.expiresAt - 60_000,
    approvalTimePrecision: "millisecond",
    attestedScope: {
      workspace: h.workspace,
      runId: h.scope.runId,
      model: h.scope.model,
      executable: h.scope.executable,
      maxCalls: h.scope.maxCalls,
      durationMinutes: 1,
      inputsSha256: h.inputsSha256,
    },
  };
}

test("delegation records approver, executor, evidence and scope without rewriting direct approval", async () => {
  const h = await setup();
  const evidence = delegatedEvidence(h);
  const grantId = await h.store.recordDelegated(h.scope, evidence);
  const database = new DatabaseSync(
    path.join(h.root, "private", "grants.sqlite"),
    { readOnly: true },
  );
  try {
    const recorded = database
      .prepare(
        `
      SELECT g.actor_id, g.approved_at, g.max_calls, g.inputs_sha256,
             d.approver_id, d.delegate_id, d.recorded_by, d.evidence_json
      FROM grants g JOIN delegated_grants d ON d.grant_id = g.id WHERE g.id = ?
    `,
      )
      .get(grantId) as Record<string, unknown>;
    expect(recorded).toMatchObject({
      actor_id: evidence.approverId,
      approved_at: evidence.approvedAt,
      approver_id: evidence.approverId,
      delegate_id: "dot",
      recorded_by: "dot",
      max_calls: 1,
      inputs_sha256: h.inputsSha256,
    });
    expect(JSON.parse(recorded.evidence_json as string)).toEqual(evidence);
    expect(
      database
        .prepare("SELECT 1 FROM delegated_grants WHERE grant_id = ?")
        .get(h.grantId),
    ).toBeUndefined();
  } finally {
    database.close();
  }
  await expect(h.store.recordDelegated(h.scope, evidence)).rejects.toThrow(
    /already been recorded/,
  );
});

test("recording persists the validated evidence even if its caller mutates the source", async () => {
  const h = await setup();
  const evidence = delegatedEvidence(h);
  const expected = structuredClone(evidence);
  const pending = h.store.recordDelegated(h.scope, evidence);
  const mutable = evidence as {
    approverId: string;
    attestedScope: { runId: string };
  };
  mutable.approverId = "different-person";
  mutable.attestedScope.runId = "different_run";
  const grantId = await pending;
  const database = new DatabaseSync(
    path.join(h.root, "private", "grants.sqlite"),
    {
      readOnly: true,
    },
  );
  try {
    const row = database
      .prepare(
        `
      SELECT g.actor_id, d.evidence_json FROM grants g
      JOIN delegated_grants d ON d.grant_id = g.id WHERE g.id = ?
    `,
      )
      .get(grantId) as { actor_id: string; evidence_json: string };
    expect(row.actor_id).toBe(expected.approverId);
    expect(JSON.parse(row.evidence_json)).toEqual(expected);
  } finally {
    database.close();
  }
});

test("unsupported, expired, or altered delegation cannot authorize a Run", async () => {
  const h = await setup();
  const evidence = delegatedEvidence(h);
  await expect(
    h.store.recordDelegated(h.scope, undefined as never),
  ).rejects.toThrow(/Delegation evidence/);
  const invalid: DelegatedCreditEvidence[] = [
    { ...evidence, approvalText: "" },
    { ...evidence, approvalText: "No" },
    { ...evidence, approvalMessageId: evidence.delegationMessageId },
    {
      ...evidence,
      delegateId: evidence.approverId,
      recordedBy: evidence.approverId,
    },
    { ...evidence, recordedBy: "another-agent" },
    {
      ...evidence,
      attestedScope: { ...evidence.attestedScope, runId: "another_run" },
    },
    {
      ...evidence,
      attestedScope: { ...evidence.attestedScope, model: "another-model" },
    },
    { ...evidence, attestedScope: { ...evidence.attestedScope, maxCalls: 20 } },
    {
      ...evidence,
      attestedScope: {
        ...evidence.attestedScope,
        inputsSha256: "a".repeat(64),
      },
    },
    {
      ...evidence,
      attestedScope: { ...evidence.attestedScope, executable: "/other/codex" },
    },
    { ...evidence, approvedAt: Date.now() - 2 * 24 * 60 * 60_000 },
    { ...evidence, approvedAt: Date.now() + 60_000 },
    { ...evidence, approvalTimePrecision: "minute" },
  ];
  for (const item of invalid)
    await expect(h.store.recordDelegated(h.scope, item)).rejects.toThrow(
      /Delegation evidence/,
    );
  await expect(h.store.recordDelegated(h.scope, evidence)).resolves.toMatch(
    /^grant_/,
  );
});
