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
  submitInitial = true,
  extraSeeds?: (base: ArtifactSnapshot) => {
    artifacts: ArtifactSnapshot[];
    canonical: ArtifactSnapshot[];
  },
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
        (record.output?.ref.artifactId === proposal.ref.artifactId ||
          record.outcome === "deferred")
      );
    },
    async allowCommit() {
      return authorityAvailable;
    },
    async verifyResolutionDecision(decision, proposal, binding) {
      return (
        authorityAvailable &&
        decision.outcome === "approved" &&
        decision.output?.ref.artifactId === proposal.ref.artifactId &&
        decision.resolvesBlockers?.some(
          (item) =>
            item.runId === binding.runId &&
            item.blockerId === binding.blockerId &&
            item.blockerReason === binding.blockerReason &&
            item.conclusion === binding.conclusion,
        ) === true
      );
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
  const extras = extraSeeds?.(base);
  for (const artifact of extras?.artifacts ?? []) await store.create(artifact);
  const baseRef = exact(base),
    candidateRef = exact(candidate);
  await registry.seedCanonical([
    baseRef,
    ...(extras?.canonical.map(exact) ?? []),
  ]);
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
  if (submitInitial)
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
function seededApproved(
  source: ArtifactSnapshot,
  id: string,
  revision: number,
  dependencies: ArtifactSnapshot["dependencies"],
): ArtifactSnapshot {
  const candidate = newCandidate(source, id, revision, dependencies);
  const raw: ArtifactSnapshot = {
    ...candidate,
    lifecycle: { status: "approved", freshness: "valid" },
    approval: { status: "approved", decisionId: "seed", actorId: actor.id, at },
  };
  return { ...raw, meta: { ...raw.meta, contentDigest: artifactDigest(raw) } };
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
describe("reviewed Run contract regressions", () => {
  test("a newly selected output cannot conceal invalidated transitive historical locks", async () => {
    let historical!: ArtifactSnapshot;
    let current!: ArtifactSnapshot;
    const { registry, store, baseRef, candidate, makeDecision } = await setup(
      undefined,
      false,
      (base) => {
        historical = seededApproved(base, "art_nested_history", 1, [
          { ...exact(base), onChange: "invalidate" },
        ]);
        current = seededApproved(historical, historical.meta.id, 2, []);
        return { artifacts: [historical, current], canonical: [current] };
      },
    );
    const consumer = newCandidate(candidate, "art_nested_consumer");
    await store.create(consumer);
    await registry.produce({
      runId: "run_real",
      ref: exact(consumer),
      inputs: [baseRef],
      actor: agent,
      at,
      reason: "historical dependency",
    });
    await registry.submit({
      runId: "run_real",
      packetId: "packet_real",
      proposals: [
        {
          id: "proposal_real",
          ref: exact(candidate),
          expectedCanonical: baseRef,
          alternatives: ["adopt"],
          rationale: "replace upstream",
          evidenceLimits: [],
          dependents: [],
        },
        {
          id: "proposal_consumer",
          ref: exact(consumer),
          alternatives: ["adopt"],
          rationale: "use historical dependency",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at,
      reason: "joint review",
    });
    const upstream = makeDecision("approved");
    const downstream = decideFor(
      "packet_real",
      "proposal_consumer",
      consumer,
      "decision_consumer",
      [{ ...exact(historical), onChange: "none" }],
    );
    await registry.decide(upstream);
    await registry.decide(downstream);
    await expect(
      registry.commit({
        id: "commit_nested",
        packetId: "packet_real",
        approvals: [
          { proposalId: "proposal_real", decisionId: upstream.id },
          { proposalId: "proposal_consumer", decisionId: downstream.id },
        ],
        actor,
        at,
        reason: "reject transitive invalidation",
      }),
    ).rejects.toThrow();
    const state = await registry.snapshot();
    expect(state.canonical[baseRef.artifactId].ref).toEqual(baseRef);
    expect(state.canonical[current.meta.id].ref).toEqual(exact(current));
    expect(state.canonical[consumer.meta.id]).toBeUndefined();
    await expect(store.read(consumer.meta.id, 2)).rejects.toThrow();
  });

  test("an explicit none impact keeps a historical lock usable after canonical change", async () => {
    let historical!: ArtifactSnapshot;
    let current!: ArtifactSnapshot;
    const { registry, store, baseRef, candidate, makeDecision } = await setup(
      undefined,
      false,
      (base) => {
        historical = seededApproved(base, "art_compatible_history", 1, [
          { ...exact(base), onChange: "none" },
        ]);
        current = seededApproved(historical, historical.meta.id, 2, []);
        return { artifacts: [historical, current], canonical: [current] };
      },
    );
    const consumer = newCandidate(candidate, "art_compatible_consumer");
    await store.create(consumer);
    await registry.produce({
      runId: "run_real",
      ref: exact(consumer),
      inputs: [baseRef],
      actor: agent,
      at,
      reason: "compatible historical dependency",
    });
    await registry.submit({
      runId: "run_real",
      packetId: "packet_real",
      proposals: [
        {
          id: "proposal_real",
          ref: exact(candidate),
          expectedCanonical: baseRef,
          alternatives: ["adopt"],
          rationale: "replace upstream",
          evidenceLimits: [],
          dependents: [],
        },
        {
          id: "proposal_consumer",
          ref: exact(consumer),
          alternatives: ["adopt"],
          rationale: "use compatible history",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at,
      reason: "joint review",
    });
    const upstream = makeDecision("approved");
    const downstream = decideFor(
      "packet_real",
      "proposal_consumer",
      consumer,
      "decision_compatible",
      [{ ...exact(historical), onChange: "none" }],
    );
    await registry.decide(upstream);
    await registry.decide(downstream);
    await registry.commit({
      id: "commit_compatible",
      packetId: "packet_real",
      approvals: [
        { proposalId: "proposal_real", decisionId: upstream.id },
        { proposalId: "proposal_consumer", decisionId: downstream.id },
      ],
      actor,
      at,
      reason: "compatible historical lock",
    });
    const state = await registry.snapshot();
    expect(state.canonical[baseRef.artifactId].ref).toEqual(
      upstream.output!.ref,
    );
    expect(state.canonical[current.meta.id].ref).toEqual(exact(current));
    expect(state.canonical[consumer.meta.id].ref).toEqual(
      downstream.output!.ref,
    );
    expect(state.freshness[historical.meta.id]).toBeUndefined();
  });

  test("a later validate finding cannot downgrade an unresolved invalidation", async () => {
    let other!: ArtifactSnapshot;
    let dependent!: ArtifactSnapshot;
    const { registry, store, makeDecision } = await setup(
      undefined,
      true,
      (base) => {
        other = seededApproved(base, "art_other_root", 1, []);
        dependent = seededApproved(base, "art_dual_dependent", 1, [
          { ...exact(base), onChange: "invalidate" },
          { ...exact(other), onChange: "validate" },
        ]);
        return {
          artifacts: [other, dependent],
          canonical: [other, dependent],
        };
      },
    );
    const first = makeDecision("approved");
    await registry.decide(first);
    await registry.commit({
      ...commit,
      id: "commit_first_impact",
    });
    const firstAssessment = (await registry.snapshot()).freshness[
      dependent.meta.id
    ];
    expect(firstAssessment.status).toBe("blocked");
    const otherCandidate = newCandidate(other, other.meta.id, 2, []);
    await store.create(otherCandidate);
    await registry.start({
      id: "run_other",
      scope: "product_mimic",
      entryMode: "hybrid",
      base: [exact(other)],
      reused: [],
      safeActions: ["explore"],
      actor: agent,
      at,
      reason: "other root revision",
    });
    await registry.produce({
      runId: "run_other",
      ref: exact(otherCandidate),
      inputs: [exact(other)],
      actor: agent,
      at,
      reason: "other root candidate",
    });
    await registry.submit({
      runId: "run_other",
      packetId: "packet_other",
      proposals: [
        {
          id: "proposal_other",
          ref: exact(otherCandidate),
          expectedCanonical: exact(other),
          alternatives: ["adopt"],
          rationale: "other root change",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at,
      reason: "other review",
    });
    const next = decideFor(
      "packet_other",
      "proposal_other",
      otherCandidate,
      "decision_other",
    );
    await registry.decide(next);
    await registry.commit({
      id: "commit_second_impact",
      packetId: "packet_other",
      approvals: [{ proposalId: "proposal_other", decisionId: next.id }],
      actor,
      at,
      reason: "other root commit",
    });
    const assessment = (await registry.snapshot()).freshness[dependent.meta.id];
    expect(assessment.status).toBe("blocked");
    expect(assessment.reason).toContain(firstAssessment.reason);
    expect(assessment.reason).toContain(`${other.meta.id}@1`);
  });

  test("same-set output cannot keep an invalidated lock on another selected output", async () => {
    const { registry, store, baseRef, candidate, makeDecision } = await setup(
      undefined,
      false,
    );
    const downstream = newCandidate(candidate, "art_same_effect", 1, [
      { ...baseRef, onChange: "invalidate" },
    ]);
    await store.create(downstream);
    await registry.produce({
      runId: "run_real",
      ref: exact(downstream),
      inputs: [baseRef],
      actor: agent,
      at,
      reason: "dependent draft",
    });
    await registry.submit({
      runId: "run_real",
      packetId: "packet_real",
      proposals: [
        {
          id: "proposal_real",
          ref: exact(candidate),
          expectedCanonical: baseRef,
          alternatives: ["adopt"],
          rationale: "upstream",
          evidenceLimits: [],
          dependents: [],
        },
        {
          id: "proposal_downstream",
          ref: exact(downstream),
          alternatives: ["adopt"],
          rationale: "downstream",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at,
      reason: "joint review",
    });
    const upstreamDecision = makeDecision("approved");
    const downstreamDecision = decideFor(
      "packet_real",
      "proposal_downstream",
      downstream,
      "decision_downstream",
    );
    await registry.decide(upstreamDecision);
    await registry.decide(downstreamDecision);
    await expect(
      registry.commit({
        id: "commit_effect",
        packetId: "packet_real",
        approvals: [
          { proposalId: "proposal_real", decisionId: upstreamDecision.id },
          {
            proposalId: "proposal_downstream",
            decisionId: downstreamDecision.id,
          },
        ],
        actor,
        at,
        reason: "joint commit",
      }),
    ).rejects.toThrow();
    expect(
      (await registry.snapshot()).canonical[baseRef.artifactId].ref,
    ).toEqual(baseRef);
    expect(
      (await registry.snapshot()).canonical[downstream.meta.id],
    ).toBeUndefined();
  });
  test("an unrelated human decision cannot clear another blocker", async () => {
    const { registry, makeDecision } = await setup();
    await registry.decide(makeDecision("approved"));
    await registry.setWork({
      runId: "run_real",
      safeActions: [],
      blockers: { capability: "production capability unknown" },
      actor: agent,
      at,
      reason: "blocked",
    });
    await expect(
      registry.setWork({
        runId: "run_real",
        safeActions: ["continue"],
        blockers: {},
        resolutions: { capability: { decisionId: "decision_approved" } },
        actor: agent,
        at,
        reason: "unrelated decision",
      }),
    ).rejects.toThrow();
    expect((await registry.run("run_real")).run.blockers.capability).toBe(
      "production capability unknown",
    );
  });
  test("superseding a deferred decision removes only its old review hold", async () => {
    const { registry, store, candidate, baseRef } = await setup();
    const deferred: DecisionRecord = {
      id: "decision_defer",
      packetId: "packet_real",
      proposalId: "proposal_real",
      outcome: "deferred",
      actor,
      at,
      rationale: "review later",
    };
    await registry.decide(deferred);
    const revised = newCandidate(candidate, candidate.meta.id, 3);
    await store.create(revised);
    await registry.produce({
      runId: "run_real",
      ref: exact(revised),
      inputs: [baseRef],
      actor: agent,
      at,
      reason: "revised draft",
    });
    await registry.submit({
      runId: "run_real",
      packetId: "packet_revised",
      proposals: [
        {
          id: "proposal_revised",
          ref: exact(revised),
          expectedCanonical: baseRef,
          alternatives: ["adopt"],
          rationale: "new decision",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at,
      reason: "revised review",
    });
    await registry.setWork({
      runId: "run_real",
      safeActions: [],
      blockers: { "decision:proposal_real": "Human decision deferred" },
      actor: agent,
      at,
      reason: "exploration complete",
    });
    const approved = {
      ...decideFor(
        "packet_revised",
        "proposal_revised",
        revised,
        "decision_revised",
      ),
      supersedesDecisionId: deferred.id,
    };
    await registry.decide(approved);
    expect(
      (await registry.run("run_real")).run.blockers["decision:proposal_real"],
    ).toBeUndefined();
    await registry.commit({
      id: "commit_revised",
      packetId: "packet_revised",
      approvals: [{ proposalId: "proposal_revised", decisionId: approved.id }],
      actor,
      at,
      reason: "new approved revision",
    });
    expect((await registry.run("run_real")).state).toBe("closed");
    expect((await registry.snapshot()).decisions[deferred.id].outcome).toBe(
      "deferred",
    );
  });
  test("a bound human conclusion clears only its subject while authority remains valid", async () => {
    const { registry, makeDecision, setAuthority } = await setup();
    await registry.setWork({
      runId: "run_real",
      safeActions: [],
      blockers: {
        capability: "production capability unknown",
        other: "separate fact",
      },
      actor: agent,
      at,
      reason: "two blockers",
    });
    const bound: DecisionRecord = {
      ...makeDecision("approved"),
      resolvesBlockers: [
        {
          runId: "run_real",
          blockerId: "capability",
          blockerReason: "production capability unknown",
          conclusion: "Human verified capability status",
        },
      ],
    };
    await registry.decide(bound);
    setAuthority(false);
    await expect(
      registry.setWork({
        runId: "run_real",
        safeActions: [],
        blockers: { other: "separate fact" },
        resolutions: { capability: { decisionId: bound.id } },
        actor: agent,
        at,
        reason: "authority unavailable",
      }),
    ).rejects.toThrow();
    setAuthority(true);
    await expect(
      registry.setWork({
        runId: "run_real",
        safeActions: [],
        blockers: { capability: "production capability unknown" },
        resolutions: { other: { decisionId: bound.id } },
        actor: agent,
        at,
        reason: "wrong subject",
      }),
    ).rejects.toThrow();
    await registry.setWork({
      runId: "run_real",
      safeActions: [],
      blockers: { other: "separate fact" },
      resolutions: { capability: { decisionId: bound.id } },
      actor: agent,
      at,
      reason: "bound conclusion",
    });
    expect((await registry.run("run_real")).run.blockers).toEqual({
      other: "separate fact",
    });
    expect(
      (await registry.snapshot()).events.findLast(
        (e) => e.action === "set-work",
      )?.details,
    ).toEqual({ resolutions: { capability: { decisionId: bound.id } } });
  });
  test("superseding a stale proposal clears only its stale review hold", async () => {
    const { registry, store, baseRef, candidate, makeDecision } = await setup();
    const oldDecision = makeDecision("approved");
    await registry.decide(oldDecision);
    const competing = newCandidate(candidate, candidate.meta.id, 3);
    await store.create(competing);
    await registry.start({
      id: "run_competitor",
      scope: "product_mimic",
      entryMode: "hybrid",
      base: [baseRef],
      reused: [],
      safeActions: ["explore"],
      actor: agent,
      at,
      reason: "other branch",
    });
    await registry.produce({
      runId: "run_competitor",
      ref: exact(competing),
      inputs: [baseRef],
      actor: agent,
      at,
      reason: "other draft",
    });
    await registry.submit({
      runId: "run_competitor",
      packetId: "packet_competitor",
      proposals: [
        {
          id: "proposal_competitor",
          ref: exact(competing),
          expectedCanonical: baseRef,
          alternatives: ["adopt"],
          rationale: "other",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at,
      reason: "other review",
    });
    const otherDecision = decideFor(
      "packet_competitor",
      "proposal_competitor",
      competing,
      "decision_competitor",
    );
    await registry.decide(otherDecision);
    await registry.commit({
      id: "commit_competitor",
      packetId: "packet_competitor",
      approvals: [
        { proposalId: "proposal_competitor", decisionId: otherDecision.id },
      ],
      actor,
      at,
      reason: "other commit",
    });
    expect(
      (await registry.run("run_real")).run.blockers["proposal:proposal_real"],
    ).toBeDefined();
    const revised = newCandidate(candidate, candidate.meta.id, 5);
    await store.create(revised);
    await registry.produce({
      runId: "run_real",
      ref: exact(revised),
      inputs: [baseRef],
      actor: agent,
      at,
      reason: "new draft",
    });
    await registry.submit({
      runId: "run_real",
      packetId: "packet_stale_revision",
      proposals: [
        {
          id: "proposal_stale_revision",
          ref: exact(revised),
          expectedCanonical: otherDecision.output!.ref,
          alternatives: ["adopt"],
          rationale: "explicit revision",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at,
      reason: "new review",
    });
    await registry.setWork({
      runId: "run_real",
      safeActions: [],
      blockers: {
        "proposal:proposal_real":
          "Canonical selection moved since proposal submission",
      },
      actor: agent,
      at,
      reason: "await new decision",
    });
    const renewed = {
      ...decideFor(
        "packet_stale_revision",
        "proposal_stale_revision",
        revised,
        "decision_stale_revision",
      ),
      supersedesDecisionId: oldDecision.id,
    };
    await registry.decide(renewed);
    expect(
      (await registry.run("run_real")).run.blockers["proposal:proposal_real"],
    ).toBeUndefined();
    await registry.commit({
      id: "commit_stale_revision",
      packetId: "packet_stale_revision",
      approvals: [
        { proposalId: "proposal_stale_revision", decisionId: renewed.id },
      ],
      actor,
      at,
      reason: "new exact revision",
    });
    expect((await registry.run("run_real")).state).toBe("closed");
    expect((await registry.snapshot()).decisions[oldDecision.id].outcome).toBe(
      "approved",
    );
  });
  test("a new Run must cite the latest rejection when renewing the same artifact", async () => {
    const { registry, store, baseRef, candidate, makeDecision } = await setup();
    const rejected = makeDecision("rejected");
    await registry.decide(rejected);
    const renewed = newCandidate(candidate, candidate.meta.id, 4);
    await store.create(renewed);
    await registry.start({
      id: "run_renew",
      scope: "product_mimic",
      entryMode: "hybrid",
      base: [baseRef],
      reused: [],
      safeActions: ["explore"],
      actor: agent,
      at,
      reason: "renew after rejection",
    });
    await registry.produce({
      runId: "run_renew",
      ref: exact(renewed),
      inputs: [baseRef],
      actor: agent,
      at,
      reason: "new revision",
    });
    const proposal = {
      id: "proposal_renew",
      ref: exact(renewed),
      expectedCanonical: baseRef,
      alternatives: ["adopt"],
      rationale: "explicit renewal",
      evidenceLimits: [],
      dependents: [],
    };
    await expect(
      registry.submit({
        runId: "run_renew",
        packetId: "packet_renew",
        proposals: [proposal],
        actor: agent,
        at,
        reason: "missing rejection history",
      }),
    ).rejects.toThrow();
    await registry.submit({
      runId: "run_renew",
      packetId: "packet_renew",
      proposals: [{ ...proposal, priorRejectionId: rejected.id }],
      actor: agent,
      at,
      reason: "cites rejection",
    });
    expect(
      (await registry.snapshot()).runs.run_renew.proposals.proposal_renew
        .priorRejectionId,
    ).toBe(rejected.id);
  });
});
describe("shared artifact and Run transaction", () => {
  test("registry verifier gives authority callbacks copies of session state", async () => {
    const { backend, registry, makeDecision } = await setup();
    const decision = makeDecision("approved");
    await registry.decide(decision);
    await registry.commit(commit);
    const before = await backend.read();
    const authority: RegistryAuthority = {
      async verify(record, proposal) {
        Object.assign(record, { rationale: "mutated by callback" });
        Object.assign(proposal, { rationale: "mutated by callback" });
        return true;
      },
      async allowCommit() {
        return false;
      },
    };
    const verifier = new RegistryAuthorityVerifier(backend, authority);
    const verified = await backend.snapshots.withReadSession!(() =>
      verifier.verifyApproval(
        decision.output!.artifact.approval,
        decision.output!.artifact,
      ),
    );
    expect(verified).toBe(true);
    expect(await backend.read()).toEqual(before);
  });
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
