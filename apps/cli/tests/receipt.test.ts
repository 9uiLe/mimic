import { afterEach, expect, test, vi } from "vitest";
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
  loadOperatorTrustRoot,
  ReceiptAuthority,
  type OperatorTrust,
  type AcceptancePayload,
  type ReceiptPayload,
  type SignedReceipt,
  type TrustFileAccess,
} from "../src/receipt-authority.js";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
const { publicKey: attesterPublicKey, privateKey: attesterPrivateKey } =
  generateKeyPairSync("ed25519");
const trust: OperatorTrust = {
  version: 1,
  keys: [
    {
      id: "test-human-key",
      publicKeyPem: publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
      purposes: ["authorize"],
    },
    {
      id: "test-attester-key",
      publicKeyPem: attesterPublicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
      purposes: ["attest"],
    },
  ],
};
test("fixed-path loader checks every path component before accepting Ed25519 keys", async () => {
  const fixed =
    process.platform === "darwin"
      ? "/Library/Application Support/Mimic/trust.json"
      : "/etc/mimic/trust.json";
  const seen: string[] = [];
  const access: TrustFileAccess = {
    stat: async (file) => {
      seen.push(file);
      return {
        uid: 0,
        mode: 0o600,
        isSymbolicLink: () => false,
        isFile: () => file === fixed,
        isDirectory: () => file !== fixed,
      };
    },
    text: async (file) => {
      expect(file).toBe(fixed);
      return JSON.stringify(trust);
    },
  };
  expect(await loadOperatorTrustRoot(access)).toEqual(trust);
  expect(seen.at(-1)).toBe(fixed);
  await expect(
    loadOperatorTrustRoot({
      ...access,
      stat: async (file) => ({
        ...(await access.stat(file)),
        mode: 0o666,
      }),
    }),
  ).rejects.toThrow(/not protected/);
  await expect(
    loadOperatorTrustRoot({
      ...access,
      stat: async (file) => ({
        ...(await access.stat(file)),
        isSymbolicLink: () => file === fixed,
      }),
    }),
  ).rejects.toThrow(/not protected/);
});
function signed<T extends ReceiptPayload | AcceptancePayload>(
  payload: T,
): {
  payload: T;
  signature: string;
} {
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      payload.action === "attest-acceptance" ? attesterPrivateKey : privateKey,
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

test("mutable workspace history cannot revive an expired decision or commit receipt", async () => {
  const { dir, stage } = await setup();
  const ref = await stage("art_expiry", "packet_expiry", "proposal_expiry");
  const now = Date.now();
  const issuedAt = new Date(now - 240_000).toISOString();
  const at = new Date(now - 180_000).toISOString();
  const expiresAt = new Date(now - 120_000).toISOString();
  const decision: DecisionRecord = {
    id: "decision_expired",
    packetId: "packet_expiry",
    proposalId: "proposal_expiry",
    outcome: "deferred",
    actor: { kind: "human", id: "human_1" },
    at,
    rationale: "Past authorization",
  };
  const decisionReceipt = signed(
    payload(decision, ref, "nonce_expired_decision", issuedAt, expiresAt),
  );
  const workspaceFile = path.join(dir, ".mimic/workspace.json");
  const state = JSON.parse(await readFile(workspaceFile, "utf8"));
  state.registry.decisions[decision.id] = {
    ...decision,
    externalRefs: [`mimic-receipt:${hash(decisionReceipt)}`],
  };
  await writeFile(workspaceFile, JSON.stringify(state));
  await Promise.all([
    writeFile(path.join(dir, "decision.json"), JSON.stringify(decision)),
    writeFile(path.join(dir, "receipt.json"), JSON.stringify(decisionReceipt)),
  ]);
  const denied = await call(
    [
      "decide",
      "--root",
      dir,
      "--file",
      "decision.json",
      "--receipt",
      "receipt.json",
    ],
    { operatorTrust: trust },
  );
  expect(denied.code, denied.err.join("\n")).toBe(3);

  const commit = {
    id: "commit_expired",
    packetId: "packet_expiry",
    approvals: [{ proposalId: "proposal_expiry", decisionId: decision.id }],
    actor: decision.actor,
    at,
    reason: "Past authorization",
  };
  const commitReceipt = signed({
    version: 1,
    keyId: "test-human-key",
    action: "commit",
    actorId: decision.actor.id,
    runId: "run_receipt",
    scopeOwnerId: "org_local",
    packetId: commit.packetId,
    requestId: commit.id,
    requestDigest: hash(commit),
    nonce: "nonce_expired_commit",
    issuedAt,
    expiresAt,
    approvals: commit.approvals,
  });
  state.registry.commits[commit.id] = { request: commit };
  await writeFile(workspaceFile, JSON.stringify(state));
  const authority = new ReceiptAuthority(
    new FileWorkspaceStorage(workspaceFile),
    dir,
    trust,
  );
  await expect(authority.prepareCommit(commit, commitReceipt)).rejects.toThrow(
    /does not authorize exact request/,
  );
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
  const decisionEvent = stored.events.find(
    (event) =>
      event.action === "decision-approved" &&
      event.details?.decision?.id === decision.id,
  )!;
  const commitEvent = stored.events.find(
    (event) =>
      event.action === "commit-point-approve" &&
      event.details?.commit?.id === commit.id,
  )!;
  const acceptancePayload: AcceptancePayload = {
    version: 1,
    keyId: "test-attester-key",
    action: "attest-acceptance",
    actorId: decision.actor.id,
    runId: "run_receipt",
    scopeOwnerId: "org_local",
    decisionId: decision.id,
    decisionDigest: hash({
      ...decision,
      externalRefs: [`mimic-receipt:${hash(decisionReceipt)}`],
    }),
    authorizationDigest: hash(decisionReceipt),
    certifiedAt: at,
    decisionEvent: {
      sequence: decisionEvent.sequence,
      digest: hash(decisionEvent),
    },
    commit: {
      id: commit.id,
      digest: hash(commit),
      authorizationDigest: hash(commitReceipt),
      event: { sequence: commitEvent.sequence, digest: hash(commitEvent) },
    },
  };
  const acceptanceArgs = [
    "decide",
    "--root",
    dir,
    "--acceptance",
    "acceptance.json",
    "--json",
  ];
  const validAcceptance = signed(acceptancePayload);
  const unauthorizedAttestation = {
    payload: { ...acceptancePayload, keyId: "test-human-key" },
    signature: sign(
      null,
      Buffer.from(
        canonicalJson({ ...acceptancePayload, keyId: "test-human-key" }),
      ),
      privateKey,
    ).toString("base64url"),
  };
  await writeFile(
    path.join(dir, "acceptance.json"),
    JSON.stringify(unauthorizedAttestation),
  );
  expect((await call(acceptanceArgs, { operatorTrust: trust })).code).toBe(3);
  await writeFile(
    path.join(dir, "acceptance.json"),
    JSON.stringify({
      ...validAcceptance,
      signature: validAcceptance.signature.slice(0, -2) + "xx",
    }),
  );
  expect((await call(acceptanceArgs, { operatorTrust: trust })).code).toBe(3);
  await writeFile(
    path.join(dir, "acceptance.json"),
    JSON.stringify(
      signed({
        ...acceptancePayload,
        decisionEvent: {
          ...acceptancePayload.decisionEvent,
          digest: hash("other"),
        },
      }),
    ),
  );
  expect((await call(acceptanceArgs, { operatorTrust: trust })).code).toBe(3);
  await writeFile(
    path.join(dir, "acceptance.json"),
    JSON.stringify(validAcceptance),
  );
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(expiresAt) + 60_000);
  const verifier = new ReceiptAuthority(
    new FileWorkspaceStorage(path.join(dir, ".mimic/workspace.json")),
    dir,
    trust,
  );
  const storedDecision = stored.decisions[decision.id]!;
  const storedProposal =
    stored.runs.run_receipt!.proposals[decision.proposalId]!;
  expect(await verifier.verify(storedDecision, storedProposal)).toBe(false);
  const certified = await call(acceptanceArgs, { operatorTrust: trust });
  expect(certified.code, certified.err.join("\n")).toBe(0);
  const reopened = await call(["status", "--root", dir, "--json"], {
    operatorTrust: trust,
  });
  expect(reopened.code, reopened.err.join("\n")).toBe(0);
  expect(JSON.parse(reopened.out[0]!).canonical).toEqual([
    "art_receipt_commit@2",
  ]);
  expect(await verifier.verify(storedDecision, storedProposal)).toBe(true);
  await writeFile(
    path.join(dir, "reuse-tasks.json"),
    JSON.stringify([
      {
        id: "task_reuse",
        skillId: "skill.reuse",
        outputType: "design-system-asset",
        scopeOwnerId: "org_local",
        targetArtifactId: approvedRef.artifactId,
        intent: "use",
        authority: "AUTONOMOUS",
        inputs: { required: [], optional: [], alternatives: [] },
      },
    ]),
  );
  const reused = await call(
    [
      "run",
      "--root",
      dir,
      "--tasks",
      "reuse-tasks.json",
      "--id",
      "run_reuse",
      "--json",
    ],
    { operatorTrust: trust },
  );
  expect(reused.code, reused.err.join("\n")).toBe(0);
  expect(JSON.parse(reused.out[0]!).actions[0].action).toBe("USE");
});
