import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactDigest } from "../artifact-canonical.js";
import {
  ArtifactStore,
  type ArtifactSnapshot,
  type AuthorityVerifier,
} from "../artifact-store.js";
import { loadSchemaDirectory } from "../schema-registry.js";
import { FileWorkspaceStorage } from "../workspace-transaction.js";
import {
  ArtifactStorePublication,
  RegistryAuthorityVerifier,
} from "./publication.js";
import {
  RunRegistry,
  type DecisionRecord,
  type RegistryAuthority,
} from "./registry.js";

const at = "2026-10-06T12:00:00Z";
const actor = { kind: "human" as const, id: "human_1" };
const agent = { kind: "agent" as const, id: "agent_1" };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const repository = path.resolve(import.meta.dirname, "../../../..");
const schemasPath = path.join(repository, "schemas/artifacts");
const fixturePath = path.join(
  repository,
  "fixtures/artifacts/valid/product-definition.json",
);
function withoutDigest(
  meta: ArtifactSnapshot["meta"],
): ArtifactSnapshot["meta"] {
  const copy = { ...meta };
  delete copy.contentDigest;
  return copy;
}
function exact(artifact: ArtifactSnapshot) {
  return {
    artifactId: artifact.meta.id,
    revision: artifact.meta.revision,
    lockDigest: artifactDigest(artifact),
  };
}
function approvedOutput(
  candidate: ArtifactSnapshot,
  decisionId: string,
  status: "approved" | "rejected",
): ArtifactSnapshot {
  const meta = withoutDigest(candidate.meta);
  const raw: ArtifactSnapshot = {
    ...candidate,
    meta: {
      ...meta,
      revision: candidate.meta.revision + 1,
      supersedesRevision: candidate.meta.revision,
    },
    lifecycle: { status, freshness: "valid" },
    approval: { status, decisionId, actorId: actor.id, at },
  };
  return { ...raw, meta: { ...raw.meta, contentDigest: artifactDigest(raw) } };
}
async function setup(
  failpoint?: (phase: "before-rename" | "after-rename") => void,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-atomic-"));
  roots.push(root);
  const backend = new FileWorkspaceStorage(
    path.join(root, "workspace.json"),
    failpoint,
  );
  const schemas = await loadSchemaDirectory(schemasPath);
  const scopes = [
    { level: "organization" as const, ownerId: "org_9uile" },
    {
      level: "product" as const,
      ownerId: "product_mimic",
      parentId: "org_9uile",
    },
  ];
  let authorityAvailable = true;
  const authority: RegistryAuthority = {
    async verify(record, proposal) {
      return (
        authorityAvailable &&
        record.actor.id === actor.id &&
        record.output?.ref.artifactId === proposal.ref.artifactId
      );
    },
    async allowCommit() {
      return authorityAvailable;
    },
  };
  const seedAuthority: AuthorityVerifier = {
    async verifyApproval(approval) {
      return approval.decisionId === "seed" && approval.actorId === actor.id;
    },
    async verifyDecision(id) {
      return id === "seed";
    },
  };
  const store = new ArtifactStore(
    backend.snapshots,
    schemas,
    scopes,
    new RegistryAuthorityVerifier(backend, authority, seedAuthority),
  );
  const publisher = new ArtifactStorePublication(store, authority);
  const registry = new RunRegistry(backend, store, authority, publisher);
  const fixture = JSON.parse(
    await readFile(fixturePath, "utf8"),
  ) as ArtifactSnapshot;
  const initial: ArtifactSnapshot = {
    ...fixture,
    lifecycle: { status: "approved", freshness: "valid" },
    approval: { status: "approved", decisionId: "seed", actorId: actor.id, at },
  };
  const base: ArtifactSnapshot = {
    ...initial,
    meta: { ...initial.meta, contentDigest: artifactDigest(initial) },
  };
  await store.create(base);
  const meta = withoutDigest(base.meta);
  const candidate: ArtifactSnapshot = {
    ...base,
    meta: { ...meta, revision: 2, supersedesRevision: 1 },
    lifecycle: { status: "proposed", freshness: "valid" },
    approval: { status: "pending" },
    content: {
      ...(base.content as Record<string, unknown>),
      summary: "Explicit alternative",
    },
  };
  await store.create(candidate);
  const baseRef = exact(base),
    candidateRef = exact(candidate);
  await registry.seedCanonical([baseRef]);
  await registry.start({
    id: "run_real",
    scope: "product_mimic",
    entryMode: "hybrid",
    base: [baseRef],
    reused: [{ ref: baseRef, reason: "approved starting point" }],
    safeActions: ["critique"],
    actor: agent,
    at,
    reason: "begin",
  });
  await registry.produce({
    runId: "run_real",
    ref: candidateRef,
    inputs: [baseRef],
    actor: agent,
    at,
    reason: "draft",
  });
  await registry.submit({
    runId: "run_real",
    packetId: "packet_real",
    proposals: [
      {
        id: "proposal_real",
        ref: candidateRef,
        expectedCanonical: baseRef,
        alternatives: ["adopt", "retain"],
        rationale: "review exact candidate",
        evidenceLimits: [],
        dependents: [],
      },
    ],
    actor: agent,
    at,
    reason: "review",
  });
  const makeDecision = (
    outcome: "approved" | "rejected",
    id = `decision_${outcome}`,
  ): DecisionRecord => {
    const output = approvedOutput(candidate, id, outcome);
    return {
      id,
      packetId: "packet_real",
      proposalId: "proposal_real",
      outcome,
      actor,
      at,
      rationale: "human decision",
      output: { ref: exact(output), artifact: output },
    };
  };
  return {
    root,
    backend,
    store,
    publisher,
    registry,
    base,
    candidate,
    baseRef,
    candidateRef,
    makeDecision,
    setAuthority(value: boolean) {
      authorityAvailable = value;
    },
  };
}
const commit = {
  id: "commit_real",
  packetId: "packet_real",
  approvals: [{ proposalId: "proposal_real", decisionId: "decision_approved" }],
  actor,
  at,
  reason: "approve exact revision",
};

function newCandidate(
  source: ArtifactSnapshot,
  id: string,
  revision = 1,
  dependencies: ArtifactSnapshot["dependencies"] = [],
): ArtifactSnapshot {
  const withoutPrevious = Object.fromEntries(
    Object.entries(withoutDigest(source.meta)).filter(
      ([key]) => key !== "supersedesRevision",
    ),
  ) as ArtifactSnapshot["meta"];
  return {
    ...source,
    meta: {
      ...withoutPrevious,
      id,
      revision,
      ...(revision > 1 ? { supersedesRevision: revision - 1 } : {}),
    },
    lifecycle: { status: "proposed", freshness: "valid" },
    approval: { status: "pending" },
    dependencies,
    content: {
      ...(source.content as Record<string, unknown>),
      summary: `${id} candidate`,
    },
  };
}
function decideFor(
  packetId: string,
  proposalId: string,
  candidate: ArtifactSnapshot,
  id: string,
  dependencies: ArtifactSnapshot["dependencies"] = candidate.dependencies,
): DecisionRecord {
  const outputBase = approvedOutput(candidate, id, "approved");
  const meta = withoutDigest(outputBase.meta);
  const raw = { ...outputBase, meta, dependencies };
  const output: ArtifactSnapshot = {
    ...raw,
    meta: { ...raw.meta, contentDigest: artifactDigest(raw) },
  };
  return {
    id,
    packetId,
    proposalId,
    outcome: "approved",
    actor,
    at,
    rationale: "exact output",
    output: { ref: exact(output), artifact: output },
  };
}
describe("shared artifact and Run transaction", () => {
  test("approved revision and canonical selection become visible together; old snapshots stay immutable", async () => {
    const { store, registry, base, candidate, makeDecision } = await setup();
    const decision = makeDecision("approved");
    await registry.decide(decision);
    await registry.commit(commit);
    expect((await registry.snapshot()).canonical[base.meta.id].ref).toEqual(
      decision.output!.ref,
    );
    const approved = await store.read(base.meta.id, 3);
    expect(approved.artifact.lifecycle.status).toBe("approved");
    expect(approved.artifact.approval.decisionId).toBe(decision.id);
    expect((await store.read(base.meta.id, 1)).artifact).toEqual(base);
    expect((await store.read(base.meta.id, 2)).artifact).toEqual(candidate);
    await registry.start({
      id: "run_next",
      scope: "product_mimic",
      entryMode: "system-first",
      base: [decision.output!.ref],
      reused: [],
      safeActions: ["explore"],
      actor: agent,
      at,
      reason: "new branch",
    });
    expect((await registry.run("run_next")).state).toBe("active");
    await registry.commit(commit);
    expect(
      (await registry.snapshot()).events.filter(
        (e) => e.action === "commit-point-approve",
      ),
    ).toHaveLength(1);
  });
  test("an approved decision cannot authorize direct artifact publication before its commit point", async () => {
    const { registry, store, backend, publisher, baseRef, makeDecision } =
      await setup();
    const decision = makeDecision("approved");
    await registry.decide(decision);
    await expect(store.create(decision.output!.artifact)).rejects.toThrow();
    const state = await registry.snapshot();
    expect(() =>
      publisher.publish(backend.snapshots, state, decision.output!.artifact),
    ).toThrow();
    expect(
      (await registry.snapshot()).canonical[baseRef.artifactId].ref,
    ).toEqual(baseRef);
    await expect(store.read(baseRef.artifactId, 3)).rejects.toThrow();
  });
  test("rejection publishes an immutable rejected revision and leaves canonical selection intact", async () => {
    const { registry, store, baseRef, makeDecision } = await setup();
    const decision = makeDecision("rejected");
    await registry.decide(decision);
    expect(
      (await store.read(baseRef.artifactId, 3)).artifact.lifecycle.status,
    ).toBe("rejected");
    expect(
      (await registry.snapshot()).canonical[baseRef.artifactId].ref,
    ).toEqual(baseRef);
    await expect(registry.commit(commit)).rejects.toThrow();
  });
  test("authority loss and failed publication leave approved output invisible", async () => {
    const { registry, store, baseRef, makeDecision, setAuthority } =
      await setup();
    await registry.decide(makeDecision("approved"));
    setAuthority(false);
    await expect(registry.commit(commit)).rejects.toThrow();
    expect(
      (await registry.snapshot()).canonical[baseRef.artifactId].ref,
    ).toEqual(baseRef);
    await expect(store.read(baseRef.artifactId, 3)).rejects.toThrow();
  });
  test("historical approved lock remains usable and a same-set dependency is published in order", async () => {
    const { registry, store, baseRef, candidate, makeDecision } = await setup();
    await registry.decide(makeDecision("approved"));
    await registry.commit(commit);
    const historical = newCandidate(candidate, "art_historical", 1, [
      { ...baseRef, onChange: "none" },
    ]);
    await store.create(historical);
    await registry.produce({
      runId: "run_real",
      ref: exact(historical),
      inputs: [baseRef],
      actor: agent,
      at,
      reason: "historical lock",
    });
    await registry.submit({
      runId: "run_real",
      packetId: "packet_history",
      proposals: [
        {
          id: "proposal_history",
          ref: exact(historical),
          alternatives: ["adopt"],
          rationale: "historical approved lock",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at,
      reason: "review",
    });
    const historyDecision = decideFor(
      "packet_history",
      "proposal_history",
      historical,
      "decision_history",
    );
    await registry.decide(historyDecision);
    await registry.commit({
      id: "commit_history",
      packetId: "packet_history",
      approvals: [
        { proposalId: "proposal_history", decisionId: historyDecision.id },
      ],
      actor,
      at,
      reason: "approve old exact lock",
    });
    expect(
      (await store.read(historical.meta.id, 2)).artifact.dependencies[0]
        .revision,
    ).toBe(1);

    const upstream = newCandidate(candidate, "art_set_upstream");
    const downstream = newCandidate(candidate, "art_set_downstream");
    await store.create(upstream);
    await store.create(downstream);
    for (const item of [upstream, downstream])
      await registry.produce({
        runId: "run_real",
        ref: exact(item),
        inputs: [baseRef],
        actor: agent,
        at,
        reason: "same set",
      });
    await registry.submit({
      runId: "run_real",
      packetId: "packet_set",
      proposals: [upstream, downstream].map((item, i) => ({
        id: `proposal_set_${i}`,
        ref: exact(item),
        alternatives: ["adopt"],
        rationale: "same set",
        evidenceLimits: [],
        dependents: [],
      })),
      actor: agent,
      at,
      reason: "review set",
    });
    const upDecision = decideFor(
      "packet_set",
      "proposal_set_0",
      upstream,
      "decision_set_up",
    );
    const downDecision = decideFor(
      "packet_set",
      "proposal_set_1",
      downstream,
      "decision_set_down",
      [{ ...upDecision.output!.ref, onChange: "invalidate" }],
    );
    await registry.decide(upDecision);
    await registry.decide(downDecision);
    await registry.commit({
      id: "commit_set",
      packetId: "packet_set",
      approvals: [
        { proposalId: "proposal_set_1", decisionId: downDecision.id },
        { proposalId: "proposal_set_0", decisionId: upDecision.id },
      ],
      actor,
      at,
      reason: "approve dependent set",
    });
    expect(
      (await store.read(downstream.meta.id, 2)).artifact.dependencies[0]
        .lockDigest,
    ).toBe(upDecision.output!.ref.lockDigest);
  });
  test("a late schema failure rolls back every artifact and canonical effect in the batch", async () => {
    const { registry, store, baseRef, candidate } = await setup();
    const first = newCandidate(candidate, "art_batch_first"),
      second = newCandidate(candidate, "art_batch_second");
    await store.create(first);
    await store.create(second);
    for (const item of [first, second])
      await registry.produce({
        runId: "run_real",
        ref: exact(item),
        inputs: [baseRef],
        actor: agent,
        at,
        reason: "batch draft",
      });
    await registry.submit({
      runId: "run_real",
      packetId: "packet_batch",
      proposals: [first, second].map((item, i) => ({
        id: `proposal_batch_${i}`,
        ref: exact(item),
        alternatives: ["adopt"],
        rationale: "batch",
        evidenceLimits: [],
        dependents: [],
      })),
      actor: agent,
      at,
      reason: "batch review",
    });
    const good = decideFor(
      "packet_batch",
      "proposal_batch_0",
      first,
      "decision_batch_good",
    );
    const badOriginal = decideFor(
      "packet_batch",
      "proposal_batch_1",
      second,
      "decision_batch_bad",
    );
    const meta = withoutDigest(badOriginal.output!.artifact.meta);
    const invalid = {
      ...badOriginal.output!.artifact,
      meta,
      content: { summary: "missing required fields" },
    };
    const badArtifact: ArtifactSnapshot = {
      ...invalid,
      meta: { ...invalid.meta, contentDigest: artifactDigest(invalid) },
    };
    const bad: DecisionRecord = {
      ...badOriginal,
      output: { ref: exact(badArtifact), artifact: badArtifact },
    };
    await registry.decide(good);
    await registry.decide(bad);
    await expect(
      registry.commit({
        id: "commit_batch",
        packetId: "packet_batch",
        approvals: [
          { proposalId: "proposal_batch_0", decisionId: good.id },
          { proposalId: "proposal_batch_1", decisionId: bad.id },
        ],
        actor,
        at,
        reason: "all or none",
      }),
    ).rejects.toThrow();
    await expect(store.read(first.meta.id, 2)).rejects.toThrow();
    await expect(store.read(second.meta.id, 2)).rejects.toThrow();
    const state = await registry.snapshot();
    expect(state.canonical[first.meta.id]).toBeUndefined();
    expect(state.canonical[second.meta.id]).toBeUndefined();
    expect(state.runs.run_real.proposals.proposal_batch_0.status).toBe(
      "pending",
    );
  });
  test("later canonical commit marks a competing pending proposal stale and blocked", async () => {
    const { registry, store, baseRef, candidate, makeDecision } = await setup();
    await registry.setWork({
      runId: "run_real",
      safeActions: [],
      blockers: {},
      actor: agent,
      at,
      reason: "awaiting review",
    });
    const competing = newCandidate(candidate, candidate.meta.id, 3);
    await store.create(competing);
    await registry.start({
      id: "run_competing",
      scope: "product_mimic",
      entryMode: "hybrid",
      base: [baseRef],
      reused: [],
      safeActions: ["explore"],
      actor: agent,
      at,
      reason: "competing branch",
    });
    await registry.produce({
      runId: "run_competing",
      ref: exact(competing),
      inputs: [baseRef],
      actor: agent,
      at,
      reason: "competing draft",
    });
    await registry.submit({
      runId: "run_competing",
      packetId: "packet_competing",
      proposals: [
        {
          id: "proposal_competing",
          ref: exact(competing),
          expectedCanonical: baseRef,
          alternatives: ["adopt"],
          rationale: "competing",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at,
      reason: "competing review",
    });
    const decision = decideFor(
      "packet_competing",
      "proposal_competing",
      competing,
      "decision_competing",
    );
    await registry.decide(decision);
    await registry.commit({
      id: "commit_competing",
      packetId: "packet_competing",
      approvals: [
        { proposalId: "proposal_competing", decisionId: decision.id },
      ],
      actor,
      at,
      reason: "choose competing",
    });
    const stale = await registry.run("run_real");
    expect(stale.state).toBe("blocked");
    expect(stale.run.proposals.proposal_real.readiness).toBe("stale");
    expect(stale.run.blockers["proposal:proposal_real"]).toContain(
      "Canonical selection moved",
    );
    await expect(registry.decide(makeDecision("approved"))).rejects.toThrow();
    await expect(registry.commit(commit)).rejects.toThrow();
  });
  test("two file-backed writers cannot publish partial concurrent states", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mimic-writers-"));
    roots.push(root);
    const file = path.join(root, "workspace.json");
    const first = new FileWorkspaceStorage(file),
      second = new FileWorkspaceStorage(file);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writer = first.transactWorkspace(async (registry) => {
      registry.canonical.art_first = {
        ref: {
          artifactId: "art_first",
          revision: 1,
          lockDigest: `sha256:${"a".repeat(64)}`,
        },
      };
      entered();
      await gate;
    });
    await started;
    await expect(
      second.transactWorkspace(async (registry) => {
        registry.canonical.art_second = {
          ref: {
            artifactId: "art_second",
            revision: 1,
            lockDigest: `sha256:${"b".repeat(64)}`,
          },
        };
      }),
    ).rejects.toThrow("lock held");
    expect((await second.read()).canonical.art_first).toBeUndefined();
    release();
    await writer;
    expect((await second.read()).canonical.art_first).toBeDefined();
    expect((await second.read()).canonical.art_second).toBeUndefined();
  });
  test("pre-publish failure rolls back; post-publish lost response is recovered by stable commit ID", async () => {
    let phase: "before-rename" | "after-rename" | undefined;
    const { registry, store, baseRef, makeDecision } = await setup((p) => {
      if (p === phase) throw Error(`injected ${p}`);
    });
    const decision = makeDecision("approved");
    await registry.decide(decision);
    phase = "before-rename";
    await expect(registry.commit(commit)).rejects.toThrow(
      "injected before-rename",
    );
    expect(
      (await registry.snapshot()).canonical[baseRef.artifactId].ref,
    ).toEqual(baseRef);
    await expect(store.read(baseRef.artifactId, 3)).rejects.toThrow();
    phase = "after-rename";
    await expect(registry.commit(commit)).rejects.toThrow(
      "injected after-rename",
    );
    phase = undefined;
    expect((await store.read(baseRef.artifactId, 3)).digest).toBe(
      decision.output!.ref.lockDigest,
    );
    expect(
      (await registry.snapshot()).canonical[baseRef.artifactId].ref,
    ).toEqual(decision.output!.ref);
    await registry.commit(commit);
    await expect(
      registry.commit({ ...commit, reason: "different request" }),
    ).rejects.toThrow();
  });
});
