import { afterEach, expect, test } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactDigest,
  canonicalJson,
  createOrchestratorRuntime,
  FileWorkspaceStorage,
  loadSchemaDirectory,
  type ArtifactSnapshot,
  type DecisionRecord,
  type ExactArtifactRef,
} from "@mimic/core";
import { runCli, type CliHost } from "../src/cli.js";
import {
  type OperatorTrust,
  type ReceiptPayload,
  type SignedReceipt,
} from "../src/receipt-authority.js";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
async function call(args: string[], host: CliHost = {}) {
  const out: string[] = [],
    err: string[] = [];
  const code = await runCli(
    args,
    { out: (v) => out.push(v), err: (v) => err.push(v) },
    host,
  );
  return { code, out, err };
}
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const trust: OperatorTrust = {
  version: 1,
  keys: [
    {
      id: "test-human-key",
      publicKeyPem: publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
  ],
};
function signed(payload: ReceiptPayload): SignedReceipt {
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey,
    ).toString("base64url"),
  };
}
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimic-receipt-"));
  roots.push(dir);
  expect((await call(["init", "--root", dir, "--json"])).code).toBe(0);
  const task = {
    id: "task_a",
    skillId: "skill.a",
    outputType: "design-system-asset",
    scopeOwnerId: "org_local",
    inputs: { required: [], optional: [], alternatives: [] },
    intent: "create",
    authority: "PROPOSE_ONLY",
  };
  await writeFile(path.join(dir, "tasks.json"), JSON.stringify([task]));
  expect(
    (
      await call([
        "run",
        "--root",
        dir,
        "--tasks",
        "tasks.json",
        "--id",
        "run_receipt",
        "--json",
      ])
    ).code,
  ).toBe(0);
  const workspace = new FileWorkspaceStorage(
    path.join(dir, ".mimic/workspace.json"),
  );
  const schemas = await loadSchemaDirectory(
    path.join(repo, "schemas/artifacts"),
  );
  const runtime = createOrchestratorRuntime(
    workspace,
    schemas,
    [{ level: "organization", ownerId: "org_local" }],
    {
      async verify() {
        return false;
      },
      async allowCommit() {
        return false;
      },
    },
  );
  const fixture = JSON.parse(
    await readFile(
      path.join(repo, "fixtures/artifacts/valid/design-system-asset.json"),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  async function stage(
    id: string,
    packetId: string,
    proposalId: string,
  ): Promise<ExactArtifactRef> {
    const artifact: ArtifactSnapshot = {
      ...fixture,
      meta: { ...fixture.meta, id },
      scope: { level: "organization", ownerId: "org_local" },
      lifecycle: { status: "proposed", freshness: "valid" },
      origin: { ...fixture.origin, runId: "run_receipt" },
    };
    const ref = {
      artifactId: id,
      revision: artifact.meta.revision,
      lockDigest: artifactDigest(artifact),
    };
    await runtime.artifacts.create(artifact);
    await runtime.registry.produce({
      runId: "run_receipt",
      ref,
      inputs: [],
      actor: { kind: "agent", id: "cli" },
      at: new Date().toISOString(),
      reason: "Stage review",
    });
    await runtime.registry.submit({
      runId: "run_receipt",
      packetId,
      proposals: [
        {
          id: proposalId,
          ref,
          alternatives: ["approve", "reject"],
          rationale: "Review",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: { kind: "agent", id: "cli" },
      at: new Date().toISOString(),
      reason: "Review",
    });
    return ref;
  }
  return { dir, stage, runtime };
}
function payload(
  record: DecisionRecord,
  ref: ExactArtifactRef,
  nonce: string,
  issuedAt: string,
  expiresAt: string,
): ReceiptPayload {
  return {
    version: 1,
    keyId: "test-human-key",
    action: "decide",
    actorId: record.actor.id,
    runId: "run_receipt",
    scopeOwnerId: "org_local",
    packetId: record.packetId,
    requestId: record.id,
    requestDigest: hash(record),
    nonce,
    issuedAt,
    expiresAt,
    proposalId: record.proposalId,
    outcome: record.outcome,
    candidate: ref,
  };
}

test("signed receipts bind human, exact proposal, scope, expiry, and replay with idempotent retry", async () => {
  const { dir, stage } = await setup();
  const ref = await stage("art_receipt_one", "packet_one", "proposal_one");
  const now = new Date();
  const issuedAt = new Date(now.getTime() - 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 600_000).toISOString();
  const record: DecisionRecord = {
    id: "decision_one",
    packetId: "packet_one",
    proposalId: "proposal_one",
    outcome: "deferred",
    actor: { kind: "human", id: "human_1" },
    at: now.toISOString(),
    rationale: "Wait for review",
  };
  const base = payload(record, ref, "nonce_receipt_0001", issuedAt, expiresAt);
  await writeFile(path.join(dir, "decision.json"), JSON.stringify(record));
  const args = [
    "decide",
    "--root",
    dir,
    "--file",
    "decision.json",
    "--receipt",
    "receipt.json",
    "--json",
  ];
  const tryReceipt = async (receipt: SignedReceipt) => {
    await writeFile(path.join(dir, "receipt.json"), JSON.stringify(receipt));
    return call(args, { operatorTrust: trust });
  };
  expect(
    (
      await tryReceipt({
        ...signed(base),
        signature: signed(base).signature.slice(0, -2) + "xx",
      })
    ).code,
  ).toBe(3);
  expect(
    (await tryReceipt(signed({ ...base, scopeOwnerId: "other" }))).code,
  ).toBe(3);
  expect((await tryReceipt(signed({ ...base, actorId: "human_2" }))).code).toBe(
    3,
  );
  expect((await tryReceipt(signed({ ...base, action: "commit" }))).code).toBe(
    3,
  );
  expect(
    (
      await tryReceipt(
        signed({ ...base, requestDigest: hash({ id: "other" }) }),
      )
    ).code,
  ).toBe(3);
  expect(
    (await tryReceipt(signed({ ...base, candidate: { ...ref, revision: 9 } })))
      .code,
  ).toBe(3);
  expect(
    (
      await tryReceipt(
        signed({ ...base, candidate: { ...ref, lockDigest: hash("other") } }),
      )
    ).code,
  ).toBe(3);
  expect(
    (
      await tryReceipt(
        signed({
          ...base,
          issuedAt: "2020-01-01T00:00:00Z",
          expiresAt: "2020-01-02T00:00:00Z",
        }),
      )
    ).code,
  ).toBe(3);
  const valid = signed(base);
  expect((await tryReceipt(valid)).code).toBe(0);
  expect((await tryReceipt(valid)).code).toBe(0);
  const secondRef = await stage(
    "art_receipt_two",
    "packet_two",
    "proposal_two",
  );
  const second: DecisionRecord = {
    ...record,
    id: "decision_two",
    packetId: "packet_two",
    proposalId: "proposal_two",
  };
  await writeFile(path.join(dir, "decision.json"), JSON.stringify(second));
  const replay = await tryReceipt(
    signed(payload(second, secondRef, base.nonce, issuedAt, expiresAt)),
  );
  expect(replay.code, replay.err.join("\n")).toBe(5);
  expect(
    (
      await call(["decisions", "run_receipt", "--root", dir, "--json"], {
        operatorTrust: trust,
      })
    ).code,
  ).toBe(0);
});

test("signed decision and commit receipts publish an exact approved revision and retry without duplicate effects", async () => {
  const { dir, stage, runtime } = await setup();
  const candidateRef = await stage(
    "art_receipt_commit",
    "packet_commit",
    "proposal_commit",
  );
  const candidate = (
    await runtime.artifacts.read(candidateRef.artifactId, candidateRef.revision)
  ).artifact;
  const at = new Date().toISOString();
  const bare: ArtifactSnapshot = {
    ...candidate,
    meta: { ...candidate.meta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "approved", freshness: "valid" },
    approval: {
      status: "approved",
      decisionId: "decision_commit",
      actorId: "human_1",
      at,
    },
  };
  const approved: ArtifactSnapshot = {
    ...bare,
    meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
  };
  const approvedRef = {
    artifactId: approved.meta.id,
    revision: approved.meta.revision,
    lockDigest: artifactDigest(approved),
  };
  const decision: DecisionRecord = {
    id: "decision_commit",
    packetId: "packet_commit",
    proposalId: "proposal_commit",
    outcome: "approved",
    actor: { kind: "human", id: "human_1" },
    at,
    rationale: "Approve exact candidate",
    output: { ref: approvedRef, artifact: approved },
  };
  const commit = {
    id: "commit_exact",
    packetId: "packet_commit",
    approvals: [
      { proposalId: "proposal_commit", decisionId: "decision_commit" },
    ],
    actor: decision.actor,
    at,
    reason: "Publish approved output",
  };
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const decisionReceipt = signed({
    ...payload(
      decision,
      candidateRef,
      "nonce_decision_commit",
      issuedAt,
      expiresAt,
    ),
    output: approvedRef,
  });
  const commitReceipt = signed({
    version: 1,
    keyId: "test-human-key",
    action: "commit",
    actorId: "human_1",
    runId: "run_receipt",
    scopeOwnerId: "org_local",
    packetId: "packet_commit",
    requestId: commit.id,
    requestDigest: hash(commit),
    nonce: "nonce_commit_exact",
    issuedAt,
    expiresAt,
    approvals: commit.approvals,
  });
  await Promise.all([
    writeFile(path.join(dir, "decision.json"), JSON.stringify(decision)),
    writeFile(path.join(dir, "receipt.json"), JSON.stringify(decisionReceipt)),
    writeFile(path.join(dir, "commit.json"), JSON.stringify(commit)),
    writeFile(
      path.join(dir, "commit-receipt.json"),
      JSON.stringify(commitReceipt),
    ),
  ]);
  const args = [
    "decide",
    "--root",
    dir,
    "--file",
    "decision.json",
    "--receipt",
    "receipt.json",
    "--commit",
    "commit.json",
    "--commit-receipt",
    "commit-receipt.json",
    "--json",
  ];
  const first = await call(args, { operatorTrust: trust });
  expect(first.code, first.err.join("\n")).toBe(0);
  const second = await call(args, { operatorTrust: trust });
  expect(second.code, second.err.join("\n")).toBe(0);
  const status = await call(["status", "--root", dir, "--json"], {
    operatorTrust: trust,
  });
  expect(status.code).toBe(0);
  expect(JSON.parse(status.out[0]!).canonical).toEqual([
    "art_receipt_commit@2",
  ]);
  const stored = await runtime.registry.snapshot();
  expect(Object.keys(stored.commits)).toEqual(["commit_exact"]);
  expect(stored.canonical.art_receipt_commit.ref).toEqual(approvedRef);
  const reopened = await call(["status", "--root", dir, "--json"], {
    operatorTrust: trust,
  });
  expect(reopened.code, reopened.err.join("\n")).toBe(0);
  expect(JSON.parse(reopened.out[0]!).canonical).toEqual([
    "art_receipt_commit@2",
  ]);
});
