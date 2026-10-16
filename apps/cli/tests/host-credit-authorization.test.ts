import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HostCreditAuthorizationStore,
  frozenRunInputsSha256,
  type HumanCreditDecisionSource,
  type DelegatedCreditEvidence,
} from "../src/agent/host-credit-authorization.js";
import {
  FileSessionStore,
  type SessionCheckpoint,
} from "../src/agent/session.js";

const folders: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function setup(maxCalls = 1, runId = "run_197") {
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
  await writeFile(
    path.join(workspace, ".mimic", "runs", `${runId}.json`),
    "[]",
  );
  await writeFile(
    path.join(workspace, "skills", "s04", "SKILL.md"),
    "frozen instructions",
  );
  const canonicalWorkspace = await realpath(workspace);
  const store = new HostCreditAuthorizationStore(path.join(root, "private"));
  const scope = {
    workspace: canonicalWorkspace,
    runId,
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

test("read-only preflight checks the full frozen Run scope and remaining calls", async () => {
  const h = await setup();
  const check = (runId = h.scope.runId, model = h.scope.model) =>
    h.store.availableForRun(
      h.grantId,
      h.workspace,
      runId,
      model,
      h.scope.packages,
    );
  await expect(check()).resolves.toBe(process.execPath);
  await expect(check(h.scope.runId, "other-model")).rejects.toThrow(
    /No current authorization/,
  );
  await writeFile(path.join(h.workspace, ".mimic/runs/run_other.json"), "[]");
  await expect(check("run_other")).rejects.toThrow(/No current authorization/);
  await writeFile(path.join(h.workspace, "skills/s04/SKILL.md"), "changed");
  await expect(check()).rejects.toThrow(/No current authorization/);
  await writeFile(
    path.join(h.workspace, "skills/s04/SKILL.md"),
    "frozen instructions",
  );
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
  await expect(check()).rejects.toThrow(/No current authorization/);
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
    { ...evidence, approvalText: "OK, GPTのクレジットは使わないでください。" },
    {
      ...evidence,
      approvalText:
        "OK, GPTのクレジットは自由に使って構いません。追加購入もして。",
    },
    {
      ...evidence,
      approvalText: "それならどれだけ使ってもいいよ。追加購入もして。",
    },
    { ...evidence, approvalText: "それなら使わないで" },
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

test.each([
  "OK, GPTのクレジットは自由に使って構いません。",
  "それならどれだけ使ってもいいよ",
])(
  "delegation preserves the owner's exact credit approval: %s",
  async (approvalText) => {
    const h = await setup();
    const grantId = await h.store.recordDelegated(h.scope, {
      ...delegatedEvidence(h),
      approvalText,
    });
    const database = new DatabaseSync(
      path.join(h.root, "private", "grants.sqlite"),
      { readOnly: true },
    );
    try {
      const row = database
        .prepare(
          "SELECT evidence_json FROM delegated_grants WHERE grant_id = ?",
        )
        .get(grantId) as { evidence_json: string };
      expect(JSON.parse(row.evidence_json).approvalText).toBe(approvalText);
    } finally {
      database.close();
    }
  },
);

async function referenceContinuation() {
  const original = {
    model: "gpt-6.1-sol",
    budget: { maxGenerations: 15 },
    systemContext: "Mimic comparison",
    brief: {
      audience: "Mimic designers",
      purpose: "Compare directions and select one",
      primaryAction: "Select a direction",
      references: [] as {
        source: string;
        reason: string;
        appliesWhen: string;
        doNotBorrow: string;
      }[],
    },
  };
  const runId = (value: typeof original) =>
    `run_design_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
  const referenceFile = (value: typeof original) =>
    `# References supplied by the user\n\n${value.brief.references.length ? value.brief.references.map((item) => `- Source: ${item.source}\n  Reason: ${item.reason}\n  Applies when: ${item.appliesWhen}\n  Do not borrow: ${item.doNotBorrow}`).join("\n") : "No references were supplied. Do not infer or invent a source."}\n`;
  const h = await setup(2, runId(original));
  await mkdir(path.join(h.workspace, "inputs"));
  await writeFile(
    path.join(h.workspace, "intake-source.json"),
    JSON.stringify(original),
  );
  await writeFile(
    path.join(h.workspace, "inputs/references.md"),
    referenceFile(original),
  );
  const evidence = {
    ...delegatedEvidence(h),
    approvalText: "それならどれだけ使ってもいいよ",
    attestedScope: {
      ...delegatedEvidence(h).attestedScope,
      maxCalls: 2,
    },
  };
  const priorGrantId = await h.store.recordDelegated(h.scope, evidence);
  const workspace = path.join(h.root, "sourced-workspace");
  await mkdir(path.join(workspace, ".mimic/runs"), { recursive: true });
  await mkdir(path.join(workspace, "skills/s04"), { recursive: true });
  await mkdir(path.join(workspace, "inputs"));
  await writeFile(path.join(workspace, ".mimic/config.json"), '{"scopes":[]}');
  await writeFile(
    path.join(workspace, "skills/s04/SKILL.md"),
    "frozen instructions",
  );
  const references = [
    {
      source:
        "SmartHR https://smarthr.design/products/design-patterns/smarthr-table/",
      reason: "Comparable rows and actions",
      appliesWhen: "Directions share criteria",
      doNotBorrow: "The SmartHR visual style",
    },
  ];
  const next = { ...original, brief: { ...original.brief, references } };
  await writeFile(
    path.join(workspace, `.mimic/runs/${runId(next)}.json`),
    "[]",
  );
  await writeFile(
    path.join(workspace, "intake-source.json"),
    JSON.stringify(next),
  );
  const referenceText = referenceFile(next);
  await writeFile(path.join(workspace, "inputs/references.md"), referenceText);
  const scope = {
    ...h.scope,
    workspace: await realpath(workspace),
    runId: runId(next),
  };
  const inputsSha256 = await frozenRunInputsSha256(
    scope.workspace,
    scope.runId,
    scope.packages,
  );
  const nextEvidence: DelegatedCreditEvidence = {
    ...evidence,
    attestedScope: {
      ...evidence.attestedScope,
      workspace: scope.workspace,
      runId: scope.runId,
      inputsSha256,
    },
    continuation: {
      priorGrantId,
      referenceSha256: `sha256:${createHash("sha256").update(referenceText).digest("hex")}`,
      changeSummary: "Added the source-linked comparison reference",
    },
  };
  return {
    ...h,
    priorGrantId,
    workspace: scope.workspace,
    scope,
    nextEvidence,
  };
}

test("one broad delegated decision can authorize a reference-only continuation with separate consumption", async () => {
  const h = await referenceContinuation();
  const continuedGrantId = await h.store.recordDelegated(
    h.scope,
    h.nextEvidence,
  );
  const database = new DatabaseSync(
    path.join(h.root, "private/grants.sqlite"),
    {
      readOnly: true,
    },
  );
  try {
    const rows = database
      .prepare(
        "SELECT id, decision_id, continuation_of FROM grants WHERE id IN (?, ?)",
      )
      .all(h.priorGrantId, continuedGrantId) as {
      id: string;
      decision_id: string;
      continuation_of: string | null;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.decision_id).toBe(rows[1]?.decision_id);
    expect(
      rows.find((row) => row.id === continuedGrantId)?.continuation_of,
    ).toBe(h.priorGrantId);
  } finally {
    database.close();
  }
  const expected = {
    ...h.expected,
    workspace: h.workspace,
    requestId: "continued-s04",
  };
  const hash = await frozenRunInputsSha256(
    h.workspace,
    h.scope.runId,
    h.scope.packages,
  );
  await h.store
    .port(
      continuedGrantId,
      h.scope.runId,
      expected,
      hash,
      h.scope.packages,
      h.scope.executable,
    )
    .consumeUserDecision(expected);
  await expect(
    h.store.availableForRun(
      continuedGrantId,
      h.workspace,
      h.scope.runId,
      h.scope.model,
      h.scope.packages,
    ),
  ).resolves.toBe(process.execPath);
  await expect(
    h.store.recordDelegated(h.scope, h.nextEvidence),
  ).rejects.toThrow(/already been recorded for this Run/);
  await writeFile(path.join(h.workspace, "inputs/references.md"), "changed");
  await expect(
    h.store.availableForRun(
      continuedGrantId,
      h.workspace,
      h.scope.runId,
      h.scope.model,
      h.scope.packages,
    ),
  ).rejects.toThrow(/No current authorization/);
});

test("a broad decision continues only to the exact selected revision in the same workspace", async () => {
  const h = await setup(2, "run_parent");
  const ref = {
    artifactId: "art_selected",
    revision: 1,
    lockDigest: `sha256:${"a".repeat(64)}`,
  };
  const revisionBase = {
    ref,
    sourceRunId: h.scope.runId,
    selectionId: "selection_exact",
  };
  const childId = "run_revision";
  const intervention =
    "Design intervention: choose information and structure from the user's task and primary action. Do not add impressive but irrelevant statistics, claims or sections.";
  const common = `Saved guided comparison brief\n${intervention}`;
  const content = { mechanisms: ["list and detail"], summary: "Selected B" };
  const suffix = `\nHuman-selected prior direction: ${ref.artifactId}@${ref.revision}#${ref.lockDigest} from Run ${h.scope.runId}. Its accepted content is ${JSON.stringify(content)}. Address only this requested issue: Reduce the comparison memory burden. Retain the prior direction unless the issue requires a change. This is revision of the selected direction; do not imply a new human choice.`;
  const priorPlan = [
    { id: "s04", humanBrief: common },
    {
      id: "s10",
      intent: "create",
      humanBrief: `${common}\nStart with three distinct structural candidates when they are defensible; this is an initial budget, not a quota. Compare information priority, primary action and comparison unit. Keep a conventional structure if it fits. State each option's conditions, benefits and costs. Do not claim human selection.`,
      inputs: {
        required: [],
        optional: [{ name: "prior-direction", kind: "artifact" }],
      },
    },
    {
      id: "s11",
      humanBrief: `${common}\nCritique unnecessary information, generic structure and reference misuse by screen location and reason. Keep untested operation and human preference UNVERIFIED. Give a recommendation and trade-offs, never an AI-likeness score or a ban on purple, rounded corners or a font. Human selection is pending.`,
    },
  ];
  await writeFile(
    path.join(h.workspace, `.mimic/runs/${h.scope.runId}.json`),
    JSON.stringify(priorPlan),
  );
  const evidence = {
    ...delegatedEvidence(h),
    approvalText: "それならどれだけ使ってもいいよ",
    attestedScope: {
      ...delegatedEvidence(h).attestedScope,
      inputsSha256: await frozenRunInputsSha256(
        h.workspace,
        h.scope.runId,
        h.scope.packages,
      ),
    },
  };
  const priorGrantId = await h.store.recordDelegated(h.scope, evidence);
  const plan = [
    priorPlan[0],
    {
      ...priorPlan[1],
      intent: "revise",
      targetArtifactId: ref.artifactId,
      revisionBase,
      humanBrief: `${common.replace(intervention, `Revise only the human-selected direction once; do not create alternative directions.\n${intervention}`)}\nImprove the selected direction against the stated issue. Preserve its useful structure and explain the change and its cost; do not generate new options or claim another human selection.${suffix}`,
      inputs: {
        required: [],
        optional: [{ name: "prior-direction", kind: "artifact", refs: [ref] }],
      },
    },
    {
      ...priorPlan[2],
      humanBrief: `${common}\nCritique unnecessary information, generic structure and reference misuse by screen location and reason. Keep untested operation and human preference UNVERIFIED. Give a recommendation and trade-offs, never an AI-likeness score or a ban on purple, rounded corners or a font. Human selection is pending.${suffix}`,
    },
  ];
  const planText = `${JSON.stringify(plan)}\n`;
  const planDigest = `sha256:${createHash("sha256").update(planText).digest("hex")}`;
  const frozen = {
    condition: "guided",
    model: h.scope.model,
    budget: { maxGenerations: 15 },
    brief: { purpose: "Compare Mimic directions" },
    referenceFile: "inputs/references.md",
    referenceDigest: "sha256:references",
    evidenceFiles: { s04: ["inputs/system.md"] },
    evidenceDigests: { "inputs/system.md": "sha256:system" },
    skillTreeDigest: "sha256:skill",
    schemaTreeDigest: "sha256:schema",
    templateDigest: "sha256:template",
    revisionBudget: 2,
  };
  const prior = { ...frozen, runId: h.scope.runId };
  const child = {
    ...frozen,
    runId: childId,
    previousRunId: h.scope.runId,
    revisionRequest: "Reduce the comparison memory burden",
    baseRef: ref,
    planDigest,
  };
  const state = {
    registry: {
      runs: {
        [h.scope.runId]: {
          revisionSelection: {
            id: revisionBase.selectionId,
            runId: h.scope.runId,
            ref,
            actor: { kind: "human" },
            externalRefs: ["mimic-local-revision-selection:sha256:exact"],
          },
        },
        [childId]: { revisionBase },
      },
    },
    snapshots: {
      [`${ref.artifactId}@${ref.revision}`]: JSON.stringify({
        digest: ref.lockDigest,
        artifact: { content },
      }),
    },
  };
  const write = (name: string, value: unknown) =>
    writeFile(path.join(h.workspace, name), `${JSON.stringify(value)}\n`);
  await mkdir(path.join(h.workspace, "inputs"));
  const references = "# Saved references\n";
  await writeFile(path.join(h.workspace, "inputs/references.md"), references);
  await write(`trial-${h.scope.runId}.json`, prior);
  await write(`trial-${childId}.json`, child);
  await write(".mimic/workspace.json", state);
  await writeFile(
    path.join(h.workspace, `.mimic/runs/${childId}.json`),
    planText,
  );
  await writeFile(path.join(h.workspace, `tasks-${childId}.json`), planText);
  const scope = { ...h.scope, runId: childId };
  const childEvidence: DelegatedCreditEvidence = {
    ...evidence,
    attestedScope: {
      ...evidence.attestedScope,
      runId: childId,
      inputsSha256: await frozenRunInputsSha256(
        h.workspace,
        childId,
        scope.packages,
      ),
    },
    continuation: {
      kind: "selected-revision",
      priorGrantId,
      referenceSha256: `sha256:${createHash("sha256").update(references).digest("hex")}`,
      changeSummary: "Revise only the saved human-selected B direction",
    },
  };
  await write(".mimic/workspace.json", {
    registry: { runs: { ...state.registry.runs, [h.scope.runId]: {} } },
  });
  await expect(h.store.recordDelegated(scope, childEvidence)).rejects.toThrow(
    /Continuation changes more than/,
  );
  await write(".mimic/workspace.json", state);
  const childGrant = await h.store.recordDelegated(scope, childEvidence);
  expect(childGrant).toMatch(/^grant_/);
  const extraPlan = [
    ...plan,
    { id: "s12", humanBrief: "Unrelated generation" },
  ];
  const extraText = `${JSON.stringify(extraPlan)}\n`;
  await writeFile(
    path.join(h.workspace, `.mimic/runs/${childId}.json`),
    extraText,
  );
  await writeFile(path.join(h.workspace, `tasks-${childId}.json`), extraText);
  await write(`trial-${childId}.json`, {
    ...child,
    planDigest: `sha256:${createHash("sha256").update(extraText).digest("hex")}`,
  });
  await expect(
    h.store.recordDelegated(scope, {
      ...childEvidence,
      attestedScope: {
        ...childEvidence.attestedScope,
        inputsSha256: await frozenRunInputsSha256(
          h.workspace,
          childId,
          scope.packages,
        ),
      },
    }),
  ).rejects.toThrow(/Continuation changes more than/);
  await writeFile(
    path.join(h.workspace, `.mimic/runs/${childId}.json`),
    planText,
  );
  await writeFile(path.join(h.workspace, `tasks-${childId}.json`), planText);
  await write(`trial-${childId}.json`, child);
  const instructionPlan = plan.map((task) =>
    task.id === "s10"
      ? {
          ...task,
          humanBrief: `${task.humanBrief} Extra unrelated instructions.`,
        }
      : task,
  );
  const instructionText = `${JSON.stringify(instructionPlan)}\n`;
  await writeFile(
    path.join(h.workspace, `.mimic/runs/${childId}.json`),
    instructionText,
  );
  await writeFile(
    path.join(h.workspace, `tasks-${childId}.json`),
    instructionText,
  );
  await write(`trial-${childId}.json`, {
    ...child,
    planDigest: `sha256:${createHash("sha256").update(instructionText).digest("hex")}`,
  });
  await expect(
    h.store.recordDelegated(scope, {
      ...childEvidence,
      attestedScope: {
        ...childEvidence.attestedScope,
        inputsSha256: await frozenRunInputsSha256(
          h.workspace,
          childId,
          scope.packages,
        ),
      },
    }),
  ).rejects.toThrow(/Continuation changes more than/);
  await writeFile(
    path.join(h.workspace, `.mimic/runs/${childId}.json`),
    planText,
  );
  await writeFile(path.join(h.workspace, `tasks-${childId}.json`), planText);
  await write(`trial-${childId}.json`, {
    ...child,
    brief: { purpose: "Unrelated work" },
  });
  await expect(h.store.recordDelegated(scope, childEvidence)).rejects.toThrow(
    /Continuation changes more than/,
  );
});

test("one exhausted broad delegated grant can add one same-Run retry call", async () => {
  const h = await setup();
  await mkdir(path.join(h.workspace, "inputs"));
  const references = "# Saved references\n";
  await writeFile(path.join(h.workspace, "inputs/references.md"), references);
  const evidence = {
    ...delegatedEvidence(h),
    approvalText: "それならどれだけ使ってもいいよ",
  };
  const parent = await h.store.recordDelegated(h.scope, evidence);
  const topupEvidence: DelegatedCreditEvidence = {
    ...evidence,
    continuation: {
      kind: "same-run-retry",
      priorGrantId: parent,
      rejectedSessionId: "session_s04_a",
      referenceSha256: `sha256:${createHash("sha256").update(references).digest("hex")}`,
      changeSummary:
        "One rejected generation used the bounded call cap; finish the frozen evaluator",
    },
  };
  await expect(h.store.recordDelegated(h.scope, topupEvidence)).rejects.toThrow(
    /lacks a saved static candidate rejection/,
  );
  await h.store
    .port(
      parent,
      h.scope.runId,
      h.expected,
      h.inputsSha256,
      h.scope.packages,
      h.scope.executable,
    )
    .consumeUserDecision(h.expected);
  const saveRejected = async (sessionId: string) => {
    const result: SessionCheckpoint = {
      version: 1,
      sessionId,
      binding: {
        runId: h.scope.runId,
        planDigest: "a".repeat(64),
        settings: {
          provider: "codex",
          billingMode: "subscription-only",
          model: h.scope.model,
        },
      },
      generationCount: 1,
      tasks: {
        s04: {
          binding: {
            taskId: "s04",
            inputRefs: [],
            inputDigest: "a".repeat(64),
            packageDigest: "b".repeat(64),
            contextDigest: "c".repeat(64),
            packageVersion: "0.1.0",
          },
          phase: "rejected",
          rejectionReason: "static-validation",
          staticFailure: {
            exitCode: 3,
            candidate: true,
            reason: "proposal-authority-mismatch",
            stderrSha256: "d".repeat(64),
          },
          diagnostics: {
            version: 1,
            stage: "generation",
            backendReach: "unknown",
            processKind: "generation",
            process: {
              spawned: true,
              settled: true,
              exitCode: 0,
              signal: null,
              stdoutBytes: 1,
              stderrBytes: 0,
              errorCode: "none",
              failure: "none",
            },
            decoder: {
              threadStarted: true,
              turnStarted: true,
              outputObserved: true,
              terminalObserved: true,
              finished: true,
              failed: false,
              failure: "none",
            },
          },
        },
      },
      status: "stopped",
      stop: "candidate-rejected",
      questionIds: [],
      executionPolicy: "authorized-existing-credit-risk-once",
    };
    await new FileSessionStore(h.workspace).write(result);
    return result;
  };
  const rejected = await saveRejected("session_s04_a");
  await expect(h.store.recordDelegated(h.scope, topupEvidence)).rejects.toThrow(
    /lacks a host-recorded rejection/,
  );
  await h.store.recordAuthorizedCandidateRejection(
    parent,
    h.workspace,
    rejected,
  );
  const topup = await h.store.recordDelegated(h.scope, topupEvidence);
  expect(topup).toMatch(/^grant_/);
  await expect(h.store.recordDelegated(h.scope, topupEvidence)).rejects.toThrow(
    /requires one exhausted grant/,
  );
  const secondRequest = { ...h.expected, requestId: "session_s04_b-1" };
  await h.store
    .port(
      topup,
      h.scope.runId,
      secondRequest,
      h.inputsSha256,
      h.scope.packages,
      h.scope.executable,
    )
    .consumeUserDecision(secondRequest);
  await saveRejected("session_s04_b");
  await expect(
    h.store.recordDelegated(h.scope, {
      ...topupEvidence,
      continuation: {
        ...topupEvidence.continuation!,
        priorGrantId: topup,
        rejectedSessionId: "session_s04_b",
      },
    }),
  ).rejects.toThrow(/continuation differs from the original decision/);
  await writeFile(
    path.join(h.workspace, ".mimic/runs", `${h.scope.runId}.json`),
    "[{}]",
  );
  await expect(
    h.store.availableForRun(
      topup,
      h.workspace,
      h.scope.runId,
      h.scope.model,
      h.scope.packages,
    ),
  ).rejects.toThrow(/No current authorization/);
});

test("revoking the original decision also revokes its continuation", async () => {
  const h = await referenceContinuation();
  const child = await h.store.recordDelegated(h.scope, h.nextEvidence);
  await h.store.revoke(h.priorGrantId, path.join(h.root, "workspace"));
  await expect(
    h.store.availableForRun(
      child,
      h.workspace,
      h.scope.runId,
      h.scope.model,
      h.scope.packages,
    ),
  ).rejects.toThrow(/No current authorization/);
  await expect(h.store.executableFor(child, h.workspace)).rejects.toThrow(
    /No current authorization/,
  );
});

test("continuation binds the original intake and generated references", async () => {
  const h = await referenceContinuation();
  const originalFile = path.join(h.root, "workspace/intake-source.json");
  const original = JSON.parse(await readFile(originalFile, "utf8"));
  await writeFile(
    originalFile,
    JSON.stringify({ ...original, systemContext: "Changed after approval" }),
  );
  await expect(
    h.store.recordDelegated(h.scope, h.nextEvidence),
  ).rejects.toThrow(/changes more than/);
  await writeFile(originalFile, JSON.stringify(original));
  const altered =
    "# References supplied by the user\n\nUnrelated model guidance\n";
  await writeFile(path.join(h.workspace, "inputs/references.md"), altered);
  await expect(
    h.store.recordDelegated(h.scope, {
      ...h.nextEvidence,
      continuation: {
        ...h.nextEvidence.continuation!,
        referenceSha256: `sha256:${createHash("sha256").update(altered).digest("hex")}`,
      },
    }),
  ).rejects.toThrow(/changes more than/);
});

test("continuation cannot extend the original grant expiry", async () => {
  const h = await referenceContinuation();
  await expect(
    h.store.recordDelegated(
      { ...h.scope, expiresAt: h.scope.expiresAt + 60_000 },
      {
        ...h.nextEvidence,
        attestedScope: {
          ...h.nextEvidence.attestedScope,
          durationMinutes: 2,
        },
      },
    ),
  ).rejects.toThrow(/differs from the original decision/);
});

test("continuation rejects changed purpose, model, approval, and unsupported lineage", async () => {
  const h = await referenceContinuation();
  for (const evidence of [
    { ...h.nextEvidence, approvalText: "OK" },
    { ...h.nextEvidence, contextText: "Different context" },
    {
      ...h.nextEvidence,
      continuation: {
        ...h.nextEvidence.continuation!,
        priorGrantId: h.grantId,
      },
    },
    {
      ...h.nextEvidence,
      continuation: {
        ...h.nextEvidence.continuation!,
        referenceSha256: `sha256:${"0".repeat(64)}`,
      },
    },
  ])
    await expect(h.store.recordDelegated(h.scope, evidence)).rejects.toThrow();
  await writeFile(
    path.join(h.workspace, "intake-source.json"),
    JSON.stringify({
      model: h.scope.model,
      systemContext: "Different purpose",
      brief: {
        references: [
          {
            source: "https://example.com",
            reason: "x",
            appliesWhen: "y",
            doNotBorrow: "z",
          },
        ],
      },
    }),
  );
  await expect(
    h.store.recordDelegated(h.scope, h.nextEvidence),
  ).rejects.toThrow(/changes more than/);
  await expect(
    h.store.recordDelegated(
      { ...h.scope, model: "other-model" },
      {
        ...h.nextEvidence,
        attestedScope: {
          ...h.nextEvidence.attestedScope,
          model: "other-model",
        },
      },
    ),
  ).rejects.toThrow();
});

test("an existing one-decision database migrates without losing grant or consumption", async () => {
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
  const file = path.join(h.root, "private/grants.sqlite");
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE grants_legacy (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, run_id TEXT NOT NULL,
        model TEXT NOT NULL, executable TEXT NOT NULL,
        max_calls INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        inputs_sha256 TEXT NOT NULL,
        decision_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL,
        approved_at INTEGER NOT NULL, revoked_at INTEGER
      );
      INSERT INTO grants_legacy
        SELECT id, workspace, run_id, model, executable, max_calls,
               expires_at, inputs_sha256, decision_id, actor_id,
               approved_at, revoked_at FROM grants;
      DROP TABLE grants;
      ALTER TABLE grants_legacy RENAME TO grants;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    legacy.close();
  }
  await expect(
    h.store.availableForRun(
      h.grantId,
      h.workspace,
      h.scope.runId,
      h.scope.model,
      h.scope.packages,
    ),
  ).resolves.toBe(process.execPath);
  const migrated = new DatabaseSync(file, { readOnly: true });
  try {
    expect(
      migrated.prepare("SELECT COUNT(*) AS count FROM consumed").get(),
    ).toEqual({ count: 1 });
    expect(
      migrated.prepare("SELECT id FROM grants WHERE id = ?").get(h.grantId),
    ).toEqual({ id: h.grantId });
    expect(migrated.prepare("PRAGMA foreign_key_check").get()).toBeUndefined();
  } finally {
    migrated.close();
  }
});
