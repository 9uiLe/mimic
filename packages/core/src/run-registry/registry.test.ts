import { describe, expect, test } from "vitest";
import { artifactDigest, jsonCopy } from "../artifact-canonical.js";
import type { ArtifactSnapshot, SnapshotStorage } from "../artifact-store.js";
import type {
  ExactArtifactRef,
  SnapshotReader,
} from "../runtime-engines/dependency.js";
import {
  deriveRunState,
  FileRegistryStorage,
  RunRegistry,
  type DecisionRecord,
  type RevisionBaseSelection,
  type RegistryState,
} from "./registry.js";
import type { AtomicRegistryStorage } from "../workspace-transaction.js";
import type { TransactionalArtifactPublisher } from "./publication.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const base = { artifactId: "art_a", revision: 1, lockDigest: digest("a") };
const a2 = { artifactId: "art_a", revision: 2, lockDigest: digest("b") };
const b1 = { artifactId: "art_b", revision: 1, lockDigest: digest("c") };
const actor = { kind: "human" as const, id: "person_1" };
const agent = { kind: "agent" as const, id: "agent_1" };
const at = "2026-10-06T12:00:00Z";
const empty = (): RegistryState => ({
  canonical: {},
  freshness: {},
  runs: {},
  packets: {},
  decisions: {},
  commits: {},
  events: [],
});
class MemoryStorage implements AtomicRegistryStorage {
  state = empty();
  records = new Map<string, { artifact: ArtifactSnapshot; digest: string }>();
  private pending: Promise<void> = Promise.resolve();
  fail = false;
  readonly snapshots: SnapshotStorage = {
    read: async (id, revision) => {
      const record = this.records.get(`${id}@${revision}`);
      return record && JSON.stringify(record);
    },
    revisions: async (id) =>
      [...this.records.keys()]
        .filter((k) => k.startsWith(`${id}@`))
        .map((k) => Number(k.split("@")[1]))
        .sort((a, b) => a - b),
    writeIfAbsent: (id, revision, record) =>
      this.transactWorkspace(async (_state, snapshots) =>
        snapshots.writeIfAbsent(id, revision, record),
      ),
  };
  read() {
    return Promise.resolve(jsonCopy(this.state));
  }
  transact<T>(change: (state: RegistryState) => Promise<T>): Promise<T> {
    return this.transactWorkspace(async (state) => change(state));
  }
  transactWorkspace<T>(
    change: (state: RegistryState, snapshots: SnapshotStorage) => Promise<T>,
  ): Promise<T> {
    const task = this.pending.then(async () => {
      const copy = jsonCopy(this.state);
      const records = new Map(
        [...this.records].map(([k, v]) => [k, jsonCopy(v)]),
      );
      const snapshots: SnapshotStorage = {
        read: async (id, revision) => {
          const record = records.get(`${id}@${revision}`);
          return record && JSON.stringify(record);
        },
        revisions: async (id) =>
          [...records.keys()]
            .filter((k) => k.startsWith(`${id}@`))
            .map((k) => Number(k.split("@")[1]))
            .sort((a, b) => a - b),
        writeIfAbsent: async (id, revision, record) => {
          const key = `${id}@${revision}`;
          if (records.has(key)) return false;
          records.set(key, JSON.parse(record));
          return true;
        },
      };
      const result = await change(copy, snapshots);
      if (this.fail) throw Error("simulated write failure");
      this.state = copy;
      this.records = records;
      return result;
    });
    this.pending = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
function artifact(
  ref: ExactArtifactRef,
  status: "approved" | "proposed" = "proposed",
  dependencies: ArtifactSnapshot["dependencies"] = [],
): ArtifactSnapshot {
  return {
    meta: {
      id: ref.artifactId,
      revision: ref.revision,
      type: "product-definition",
      schemaVersion: "1.0.0",
    },
    scope: { level: "organization", ownerId: "org" },
    lifecycle: { status, freshness: "valid" },
    approval: { status: status === "approved" ? "approved" : "pending" },
    dependencies,
    provenance: [],
    content: { summary: "test" },
  };
}
function setup() {
  const storage = new MemoryStorage();
  const artifacts = storage.records;
  for (const [ref, status] of [
    [base, "approved"],
    [a2, "proposed"],
    [b1, "proposed"],
  ] as const)
    artifacts.set(`${ref.artifactId}@${ref.revision}`, {
      artifact: artifact(ref, status),
      digest: ref.lockDigest,
    });
  const readerFor = (snapshots: SnapshotStorage): SnapshotReader => ({
    async read(id, revision) {
      const raw = await snapshots.read(id, revision);
      if (!raw) throw Error("missing");
      return JSON.parse(raw);
    },
  });
  const publisher: TransactionalArtifactPublisher = {
    sourceStorage: storage.snapshots,
    reader: readerFor,
    async publish(snapshots, _state, output) {
      const digest = artifactDigest(output);
      const created = await snapshots.writeIfAbsent(
        output.meta.id,
        output.meta.revision,
        JSON.stringify({ artifact: output, digest }),
      );
      if (!created) throw Error("revision conflict");
      return { artifact: output, digest };
    },
  };
  const registry = new RunRegistry(
    storage,
    readerFor(storage.snapshots),
    {
      async verify() {
        return true;
      },
      async allowCommit() {
        return true;
      },
      async verifyRevisionSelection() {
        return true; // Synthetic host assertion in this fixture only.
      },
      async verifyResolution(_id, refs) {
        return refs.includes("evidence:verified");
      },
      async verifyEvidence(_proposal, _dependency, refs) {
        return refs.includes("evidence:verified");
      },
    },
    publisher,
  );
  return { storage, artifacts, registry };
}
test("only the fresh exact S10 choice from a committed human S11 decision can start a revision Run", async () => {
  const { storage, artifacts, registry } = setup();
  const direction = {
    artifactId: "art_direction",
    revision: 1,
    lockDigest: digest("d"),
  };
  const decisionProposal = {
    artifactId: "art_choice",
    revision: 1,
    lockDigest: digest("e"),
  };
  const decisionOutput = {
    artifactId: "art_choice",
    revision: 2,
    lockDigest: digest("f"),
  };
  const selection = {
    ref: direction,
    sourceRunId: "run_source",
    decisionId: "decision_choice",
  };
  artifacts.set("art_direction@1", {
    artifact: {
      ...artifact(direction),
      meta: { ...artifact(direction).meta, type: "design-direction" },
      lifecycle: { status: "provisional", freshness: "valid" },
      origin: {
        actorKind: "skill",
        actorId: "mimic.s10.design-direction-generator",
        runId: "run_source",
      },
    },
    digest: direction.lockDigest,
  });
  const chosen = `${direction.artifactId}@${direction.revision}#${direction.lockDigest}`;
  const approvedChoice: ArtifactSnapshot = {
    ...artifact(decisionOutput, "approved"),
    meta: { ...artifact(decisionOutput).meta, type: "decision" },
    origin: {
      actorKind: "skill",
      actorId: "mimic.s11.direction-evaluator",
      runId: "run_source",
    },
    content: { chosenAlternative: chosen },
    approval: {
      status: "approved",
      decisionId: selection.decisionId,
      actorId: actor.id,
      at,
    },
  };
  artifacts.set("art_choice@2", {
    artifact: approvedChoice,
    digest: decisionOutput.lockDigest,
  });
  storage.state.runs.run_source = {
    id: "run_source",
    scope: "product",
    entryMode: "hybrid",
    base: [],
    reused: [],
    artifacts: [direction, decisionProposal],
    blockers: {},
    safeActions: [],
    proposals: {
      proposal_choice: {
        id: "proposal_choice",
        ref: decisionProposal,
        packetId: "packet_choice",
        alternatives: ["choose", "wait"],
        rationale: "review",
        evidenceLimits: [],
        dependents: [],
        status: "merged",
        readiness: "ready",
      },
    },
  };
  storage.state.packets.packet_choice = {
    id: "packet_choice",
    runId: "run_source",
    proposalIds: ["proposal_choice"],
    createdAt: at,
    reason: "review",
  };
  storage.state.decisions.decision_choice = {
    id: "decision_choice",
    packetId: "packet_choice",
    proposalId: "proposal_choice",
    outcome: "approved",
    actor,
    at,
    rationale: "choose this direction",
    output: { ref: decisionOutput, artifact: approvedChoice },
  };
  storage.state.canonical.art_choice = {
    ref: decisionOutput,
    decisionId: selection.decisionId,
  };
  const start = (id: string, revisionBase: RevisionBaseSelection = selection) =>
    registry.start({
      id,
      scope: "product",
      entryMode: "hybrid",
      base: [decisionOutput, direction],
      reused: [
        { ref: decisionOutput, reason: "approved decision" },
        { ref: direction, reason: "selected revision source" },
      ],
      revisionBase,
      safeActions: ["revise"],
      actor: agent,
      at,
      reason: "revise selected direction",
    });
  await expect(start("run_before_commit")).rejects.toThrow(
    /committed human choice/,
  );
  storage.state.commits.commit_choice = {
    request: {
      id: "commit_choice",
      packetId: "packet_choice",
      actor,
      at,
      reason: "select revision base",
      approvals: [
        { proposalId: "proposal_choice", decisionId: "decision_choice" },
      ],
    },
    outputs: [decisionOutput],
  };
  await expect(
    start("run_wrong_ref", {
      ...selection,
      ref: { ...direction, lockDigest: digest("a") },
    }),
  ).rejects.toThrow();
  await expect(
    start("run_wrong_decision", { ...selection, decisionId: "missing" }),
  ).rejects.toThrow(/committed human choice/);
  await expect(start("run_selected")).resolves.toMatchObject({
    revisionBase: selection,
  });
  const reviewRef = {
    artifactId: "art_s11_review",
    revision: 1,
    lockDigest: digest("9"),
  };
  storage.records.set("art_s11_review@1", {
    artifact: {
      ...artifact(reviewRef),
      meta: { ...artifact(reviewRef).meta, type: "decision" },
      lifecycle: { status: "provisional", freshness: "valid" },
      origin: {
        actorKind: "skill",
        actorId: "mimic.s11.direction-evaluator",
        runId: "run_source",
      },
      content: { summary: "Compare directions", outcome: "proposed" },
      dependencies: [{ ...direction, onChange: "validate" }],
    },
    digest: reviewRef.lockDigest,
  });
  storage.state.runs.run_source = {
    ...storage.state.runs.run_source,
    artifacts: [...storage.state.runs.run_source.artifacts, reviewRef],
  };
  const working = {
    ref: direction,
    sourceRunId: "run_source",
    selectionId: "selection_one",
  };
  await expect(start("run_before_selection", working)).rejects.toThrow(
    /committed human choice/,
  );
  const request = {
    id: working.selectionId,
    runId: working.sourceRunId,
    ref: direction,
    reviewRef,
    actor,
    at,
    reason: "Use this direction only for the next revision",
  };
  await expect(
    registry.selectRevisionBase({ ...request, ref: b1 }),
  ).rejects.toThrow(/reviewed by S11/);
  await registry.selectRevisionBase(request);
  await expect(start("run_working_selection", working)).resolves.toMatchObject({
    revisionBase: working,
  });
  expect(storage.state.canonical.art_direction).toBeUndefined();
  await expect(
    registry.selectRevisionBase({
      ...request,
      id: "selection_changed",
      ref: b1,
    }),
  ).rejects.toThrow();
  storage.state.runs.run_source = {
    ...storage.state.runs.run_source,
    artifacts: [
      ...storage.state.runs.run_source.artifacts,
      { ...direction, revision: 2 },
    ],
  };
  await expect(registry.assertRevisionBase(selection)).rejects.toThrow(
    /no longer/,
  );
});
async function started(registry: RunRegistry) {
  await registry.seedCanonical([base]);
  await registry.start({
    id: "run_1",
    scope: "product",
    entryMode: "hybrid",
    base: [base],
    reused: [{ ref: base, reason: "applicable" }],
    safeActions: ["explore"],
    actor: agent,
    at,
    reason: "start",
  });
}
async function proposed(
  registry: RunRegistry,
  refs: ExactArtifactRef[] = [a2],
) {
  for (const ref of refs)
    await registry.produce({
      runId: "run_1",
      ref,
      inputs: [base],
      actor: agent,
      at,
      reason: "draft",
    });
  await registry.submit({
    runId: "run_1",
    packetId: "packet_1",
    proposals: refs.map((ref, i) => ({
      id: `proposal_${i}`,
      ref,
      ...(ref.artifactId === base.artifactId
        ? { expectedCanonical: base }
        : {}),
      alternatives: ["adopt", "retain"],
      rationale: "review",
      evidenceLimits: [],
      dependents: [],
    })),
    actor: agent,
    at,
    reason: "review",
  });
}
const decision = (
  proposalId: string,
  id: string,
  outcome: DecisionRecord["outcome"] = "approved",
  ref: ExactArtifactRef = proposalId === "proposal_1" ? b1 : a2,
  packetId = "packet_1",
): DecisionRecord => {
  const record: DecisionRecord = {
    id,
    packetId,
    proposalId,
    outcome,
    actor,
    at,
    rationale: "human choice",
  };
  if (outcome !== "approved" && outcome !== "rejected") return record;
  const output: ArtifactSnapshot = {
    ...artifact(ref),
    meta: {
      ...artifact(ref).meta,
      revision: ref.revision + 1,
      supersedesRevision: ref.revision,
    },
    lifecycle: { status: outcome, freshness: "valid" },
    approval: { status: outcome, decisionId: id, actorId: actor.id, at },
  };
  const lockDigest = artifactDigest(output);
  return {
    ...record,
    output: {
      ref: {
        artifactId: ref.artifactId,
        revision: ref.revision + 1,
        lockDigest,
      },
      artifact: {
        ...output,
        meta: { ...output.meta, contentDigest: lockDigest },
      },
    },
  };
};

describe("Run registry", () => {
  test("review-ready takes precedence over safe work and blockers; partial approval leaves siblings pending", async () => {
    const { registry } = setup();
    await started(registry);
    await proposed(registry, [a2, b1]);
    await registry.setWork({
      runId: "run_1",
      safeActions: ["prototype"],
      blockers: { flow: "missing fact" },
      actor: agent,
      at,
      reason: "triage",
    });
    expect((await registry.run("run_1")).state).toBe("review-ready");
    await registry.decide(decision("proposal_0", "decision_0"));
    await registry.commit({
      id: "commit_1",
      packetId: "packet_1",
      approvals: [{ proposalId: "proposal_0", decisionId: "decision_0" }],
      actor,
      at,
      reason: "approve A",
    });
    const snapshot = await registry.snapshot();
    expect(snapshot.canonical.art_a.ref).toEqual(
      decision("proposal_0", "decision_0").output!.ref,
    );
    expect(snapshot.canonical.art_b).toBeUndefined();
    expect((await registry.run("run_1")).state).toBe("review-ready");
    expect(snapshot.runs.run_1.proposals.proposal_1.status).toBe("pending");
  });
  test("rejection is immutable, idempotent, and cannot replay a rejected revision", async () => {
    const { registry } = setup();
    await started(registry);
    await proposed(registry);
    const rejected = decision("proposal_0", "decision_reject", "rejected");
    await registry.decide(rejected);
    await registry.decide(rejected);
    await expect(
      registry.decide({ ...rejected, outcome: "approved" }),
    ).rejects.toThrow();
    await expect(
      registry.submit({
        runId: "run_1",
        packetId: "packet_2",
        proposals: [
          {
            id: "proposal_replay",
            ref: a2,
            expectedCanonical: base,
            alternatives: ["adopt"],
            rationale: "retry",
            evidenceLimits: [],
            dependents: [],
          },
        ],
        actor: agent,
        at,
        reason: "retry",
      }),
    ).rejects.toThrow();
    expect((await registry.snapshot()).canonical.art_a.ref).toEqual(base);
  });
  test("stale selection, wrong lock, and lost commit authority fail closed", async () => {
    const { registry, storage } = setup();
    await started(registry);
    await proposed(registry);
    await registry.decide(decision("proposal_0", "decision_0"));
    storage.state.canonical.art_a.ref = b1;
    await expect(
      registry.commit({
        id: "commit_1",
        packetId: "packet_1",
        approvals: [{ proposalId: "proposal_0", decisionId: "decision_0" }],
        actor,
        at,
        reason: "commit",
      }),
    ).rejects.toThrow();
    storage.state.canonical.art_a.ref = base;
    storage.records.get("art_a@2")!.digest = digest("d");
    await expect(
      registry.commit({
        id: "commit_1",
        packetId: "packet_1",
        approvals: [{ proposalId: "proposal_0", decisionId: "decision_0" }],
        actor,
        at,
        reason: "commit",
      }),
    ).rejects.toThrow();
    expect(storage.state.runs.run_1.proposals.proposal_0.status).toBe(
      "pending",
    );
  });
  test("transaction failure rolls back selection, proposal fate, and audit together", async () => {
    const { registry, storage } = setup();
    await started(registry);
    await proposed(registry);
    await registry.decide(decision("proposal_0", "decision_0"));
    const before = await registry.snapshot();
    storage.fail = true;
    await expect(
      registry.commit({
        id: "commit_1",
        packetId: "packet_1",
        approvals: [{ proposalId: "proposal_0", decisionId: "decision_0" }],
        actor,
        at,
        reason: "commit",
      }),
    ).rejects.toThrow("simulated");
    expect(await registry.snapshot()).toEqual(before);
  });
  test("concurrent commit cannot double-apply and inputs are copied before awaits", async () => {
    const { registry } = setup();
    await started(registry);
    await proposed(registry);
    await registry.decide(decision("proposal_0", "decision_0"));
    const input = {
      id: "commit_1",
      packetId: "packet_1",
      approvals: [{ proposalId: "proposal_0", decisionId: "decision_0" }],
      actor,
      at,
      reason: "commit",
    };
    const first = registry.commit(input);
    input.approvals[0].proposalId = "other";
    const second = registry.commit({
      id: "commit_1",
      packetId: "packet_1",
      approvals: [{ proposalId: "proposal_0", decisionId: "decision_0" }],
      actor,
      at,
      reason: "commit",
    });
    const results = await Promise.allSettled([first, second]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect(
      (await registry.snapshot()).events.filter(
        (e) => e.action === "commit-point-approve",
      ),
    ).toHaveLength(1);
    expect((await registry.snapshot()).canonical.art_a.ref).toEqual(
      decision("proposal_0", "decision_0").output!.ref,
    );
  });
  test("discard retains decision history and closes branch permanently", async () => {
    const { registry } = setup();
    await started(registry);
    await proposed(registry, [a2, b1]);
    await registry.decide(
      decision("proposal_0", "decision_reject", "rejected"),
    );
    await registry.discard({ runId: "run_1", actor, at, reason: "stop" });
    const { run, state } = await registry.run("run_1");
    expect(state).toBe("closed");
    expect(run.closed?.fates).toEqual({
      proposal_0: "rejected",
      proposal_1: "discarded",
    });
    expect((await registry.snapshot()).decisions.decision_reject.outcome).toBe(
      "rejected",
    );
    await expect(
      registry.produce({
        runId: "run_1",
        ref: b1,
        inputs: [],
        actor: agent,
        at,
        reason: "again",
      }),
    ).rejects.toThrow();
  });
  test("file transaction serializes writers and keeps a valid state after failure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mimic-registry-"));
    try {
      const store = new FileRegistryStorage(path.join(dir, "registry.json"));
      await expect(
        store.transact(async (state) => {
          state.events.push({
            sequence: 1,
            runId: "x",
            action: "x",
            actor: agent,
            at,
            reason: "x",
            inputs: [],
            outputs: [],
            canonicalAfter: {},
            freshnessAfter: {},
            runAfter: {
              id: "x",
              scope: "p",
              entryMode: "hybrid",
              base: [],
              reused: [],
              artifacts: [],
              proposals: {},
              blockers: {},
              safeActions: [],
            },
          });
          throw Error("fail");
        }),
      ).rejects.toThrow();
      expect((await store.read()).events).toEqual([]);
      await store.transact(async (state) => {
        state.events.push({
          sequence: 1,
          runId: "x",
          action: "x",
          actor: agent,
          at,
          reason: "x",
          inputs: [],
          outputs: [],
          canonicalAfter: {},
          freshnessAfter: {},
          runAfter: {
            id: "x",
            scope: "p",
            entryMode: "hybrid",
            base: [],
            reused: [],
            artifacts: [],
            proposals: {},
            blockers: {},
            safeActions: [],
          },
        });
      });
      expect((await store.read()).events).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("completed branch closes and a new Run can use its committed exact selection", async () => {
    const { registry } = setup();
    await started(registry);
    await proposed(registry);
    await registry.decide(decision("proposal_0", "decision_0"));
    await registry.setWork({
      runId: "run_1",
      safeActions: [],
      blockers: {},
      actor: agent,
      at,
      reason: "exploration complete",
    });
    await registry.commit({
      id: "commit_1",
      packetId: "packet_1",
      approvals: [{ proposalId: "proposal_0", decisionId: "decision_0" }],
      actor,
      at,
      reason: "approve",
    });
    const closed = await registry.run("run_1");
    expect(closed.state).toBe("closed");
    expect(closed.run.closed?.fates.proposal_0).toBe("merged");
    await expect(
      registry.discard({ runId: "run_1", actor, at, reason: "reopen" }),
    ).rejects.toThrow();
    await registry.start({
      id: "run_2",
      scope: "product",
      entryMode: "system-first",
      base: [decision("proposal_0", "decision_0").output!.ref],
      reused: [
        {
          ref: decision("proposal_0", "decision_0").output!.ref,
          reason: "approved by registry decision",
        },
      ],
      safeActions: ["explore"],
      actor: agent,
      at,
      reason: "new branch",
    });
    expect((await registry.run("run_2")).state).toBe("active");
  });
  test("one exact revision cannot have two proposal identities", async () => {
    const { registry } = setup();
    await started(registry);
    await registry.produce({
      runId: "run_1",
      ref: a2,
      inputs: [base],
      actor: agent,
      at,
      reason: "draft",
    });
    await expect(
      registry.submit({
        runId: "run_1",
        packetId: "packet_alias",
        proposals: [0, 1].map((i) => ({
          id: `alias_${i}`,
          ref: a2,
          expectedCanonical: base,
          alternatives: ["adopt"],
          rationale: "alias",
          evidenceLimits: [],
          dependents: [],
        })),
        actor: agent,
        at,
        reason: "two names",
      }),
    ).rejects.toThrow();
  });
  test("commit rejects a legacy alias after its exact candidate was rejected", async () => {
    const { registry, storage } = setup();
    await started(registry);
    await proposed(registry);
    storage.state.runs.run_1.proposals.alias = {
      ...jsonCopy(storage.state.runs.run_1.proposals.proposal_0),
      id: "alias",
      status: "pending",
    };
    Object.assign(storage.state.packets.packet_1, {
      proposalIds: ["proposal_0", "alias"],
    });
    await registry.decide(
      decision("proposal_0", "decision_reject", "rejected"),
    );
    await registry.decide(decision("alias", "decision_alias"));
    await expect(
      registry.commit({
        id: "commit_1",
        packetId: "packet_1",
        approvals: [{ proposalId: "alias", decisionId: "decision_alias" }],
        actor,
        at,
        reason: "alias commit",
      }),
    ).rejects.toThrow();
    expect((await registry.snapshot()).canonical.art_a.ref).toEqual(base);
  });
  test("proposal identity is scoped by packet across Runs", async () => {
    const { registry } = setup();
    await started(registry);
    await proposed(registry);
    await registry.start({
      id: "run_2",
      scope: "product",
      entryMode: "hybrid",
      base: [base],
      reused: [],
      safeActions: ["explore"],
      actor: agent,
      at,
      reason: "second",
    });
    await registry.produce({
      runId: "run_2",
      ref: b1,
      inputs: [base],
      actor: agent,
      at,
      reason: "draft B",
    });
    await registry.submit({
      runId: "run_2",
      packetId: "packet_2",
      proposals: [
        {
          id: "proposal_0",
          ref: b1,
          alternatives: ["adopt"],
          rationale: "review B",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at,
      reason: "review B",
    });
    await registry.decide(decision("proposal_0", "decision_1"));
    await expect(
      registry.decide({
        ...decision("proposal_0", "decision_2", "approved", b1, "packet_2"),
      }),
    ).resolves.toBeUndefined();
  });
  test("work events capture enough data to reconstruct blockers and state", async () => {
    const { registry } = setup();
    await started(registry);
    await registry.setWork({
      runId: "run_1",
      safeActions: [],
      blockers: { flow: "capability unverified" },
      actor: agent,
      at,
      reason: "triage",
    });
    const snapshot = await registry.snapshot();
    const workEvent = snapshot.events.findLast((e) => e.action === "set-work");
    expect(workEvent?.runAfter?.blockers).toEqual({
      flow: "capability unverified",
    });
    expect(workEvent?.runAfter && deriveRunState(workEvent.runAfter)).toBe(
      "blocked",
    );
    await registry.setWork({
      runId: "run_1",
      safeActions: ["critique"],
      blockers: { flow: "capability unverified" },
      actor: agent,
      at,
      reason: "safe alternative",
    });
    expect(
      (await registry.snapshot()).events.findLast(
        (e) => e.action === "set-work",
      )?.runAfter?.safeActions,
    ).toEqual(["critique"]);
  });
  test("blocked work needs a verified resolution before production resumes", async () => {
    const { registry } = setup();
    await started(registry);
    await registry.produce({
      runId: "run_1",
      ref: a2,
      inputs: [base],
      actor: agent,
      at,
      reason: "draft",
    });
    await registry.setWork({
      runId: "run_1",
      safeActions: [],
      blockers: { fact: "missing capability evidence" },
      actor: agent,
      at,
      reason: "blocked",
    });
    await expect(
      registry.submit({
        runId: "run_1",
        packetId: "packet_blocked",
        proposals: [
          {
            id: "proposal_blocked",
            ref: a2,
            expectedCanonical: base,
            alternatives: ["adopt"],
            rationale: "review",
            evidenceLimits: [],
            dependents: [],
          },
        ],
        actor: agent,
        at,
        reason: "premature",
      }),
    ).rejects.toThrow();
    await expect(
      registry.setWork({
        runId: "run_1",
        safeActions: ["continue"],
        blockers: {},
        actor: agent,
        at,
        reason: "unsupported resolution",
      }),
    ).rejects.toThrow();
    await registry.setWork({
      runId: "run_1",
      safeActions: ["continue"],
      blockers: {},
      resolutions: { fact: { evidenceRefs: ["evidence:verified"] } },
      actor: agent,
      at,
      reason: "verified evidence",
    });
    expect((await registry.run("run_1")).state).toBe("active");
    expect(
      (await registry.snapshot()).events.findLast(
        (e) => e.action === "set-work",
      )?.details,
    ).toEqual({
      resolutions: { fact: { evidenceRefs: ["evidence:verified"] } },
    });
  });
  test("a new exact revision and human decision can supersede an uncommitted approval", async () => {
    const { registry, storage } = setup();
    await started(registry);
    await proposed(registry);
    await registry.decide(decision("proposal_0", "decision_old"));
    const next = { artifactId: "art_a", revision: 3, lockDigest: digest("e") };
    storage.records.set("art_a@3", {
      artifact: artifact(next),
      digest: next.lockDigest,
    });
    await registry.produce({
      runId: "run_1",
      ref: next,
      inputs: [base],
      actor: agent,
      at,
      reason: "new revision",
    });
    await registry.submit({
      runId: "run_1",
      packetId: "packet_new",
      proposals: [
        {
          id: "proposal_new",
          ref: next,
          expectedCanonical: base,
          alternatives: ["adopt"],
          rationale: "revised",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      actor: agent,
      at,
      reason: "new review",
    });
    const updated = {
      ...decision(
        "proposal_new",
        "decision_new",
        "approved",
        next,
        "packet_new",
      ),
      supersedesDecisionId: "decision_old",
    };
    await registry.decide(updated);
    expect(
      (await registry.snapshot()).runs.run_1.proposals.proposal_0.status,
    ).toBe("superseded");
    await expect(
      registry.commit({
        id: "commit_old",
        packetId: "packet_1",
        approvals: [{ proposalId: "proposal_0", decisionId: "decision_old" }],
        actor,
        at,
        reason: "old",
      }),
    ).rejects.toThrow();
    await registry.commit({
      id: "commit_new",
      packetId: "packet_new",
      approvals: [{ proposalId: "proposal_new", decisionId: "decision_new" }],
      actor,
      at,
      reason: "new",
    });
    expect((await registry.snapshot()).canonical.art_a.ref).toEqual(
      updated.output!.ref,
    );
  });
  test("a blocked registry freshness assessment prevents committing a dependent output", async () => {
    const { registry, storage } = setup();
    await started(registry);
    await proposed(registry, [b1]);
    const original = decision("proposal_0", "decision_dep", "approved", b1);
    const output = {
      ...original.output!.artifact,
      dependencies: [{ ...base, onChange: "none" }],
    };
    const meta = { ...output.meta };
    delete meta.contentDigest;
    const raw = { ...output, meta };
    const final = {
      ...raw,
      meta: { ...raw.meta, contentDigest: artifactDigest(raw) },
    };
    const bound = {
      ...original,
      output: {
        ref: {
          artifactId: b1.artifactId,
          revision: 2,
          lockDigest: artifactDigest(final),
        },
        artifact: final,
      },
    };
    await registry.decide(bound);
    storage.state.freshness.art_a = {
      ref: base,
      status: "blocked",
      reason: "upstream invalidation",
    };
    await expect(
      registry.commit({
        id: "commit_dep",
        packetId: "packet_1",
        approvals: [{ proposalId: "proposal_0", decisionId: bound.id }],
        actor,
        at,
        reason: "dependent",
      }),
    ).rejects.toThrow("blocked registry freshness");
    expect((await registry.snapshot()).canonical.art_b).toBeUndefined();
  });
  test("deferred decision leaves safe exploration active and needs a later human decision", async () => {
    const { registry } = setup();
    await started(registry);
    await proposed(registry);
    await registry.decide(decision("proposal_0", "decision_defer", "deferred"));
    expect((await registry.run("run_1")).state).toBe("active");
    await registry.setWork({
      runId: "run_1",
      safeActions: [],
      blockers: { "decision:proposal_0": "Human decision deferred" },
      actor: agent,
      at,
      reason: "safe work complete",
    });
    await registry.refreshReadiness({ actor: agent, at });
    expect((await registry.run("run_1")).state).toBe("blocked");
    await expect(
      registry.setWork({
        runId: "run_1",
        safeActions: [],
        blockers: {},
        actor: agent,
        at,
        reason: "silently clear",
      }),
    ).rejects.toThrow();
    await registry.decide(decision("proposal_0", "decision_later"));
    expect((await registry.run("run_1")).state).toBe("review-ready");
  });
  test("Linear references remain exportable data with no connector side effect", async () => {
    const { registry } = setup();
    await started(registry);
    await registry.produce({
      runId: "run_1",
      ref: a2,
      inputs: [base],
      actor: agent,
      at,
      reason: "draft",
    });
    await registry.submit({
      runId: "run_1",
      packetId: "packet_linear",
      proposals: [
        {
          id: "proposal_linear",
          ref: a2,
          expectedCanonical: base,
          alternatives: ["adopt"],
          rationale: "review",
          evidenceLimits: [],
          dependents: [],
        },
      ],
      externalRefs: ["https://linear.app/9uile/issue/9UI-99/example"],
      actor: agent,
      at,
      reason: "review",
    });
    expect(
      (await registry.snapshot()).packets.packet_linear.externalRefs,
    ).toEqual(["https://linear.app/9uile/issue/9UI-99/example"]);
  });
  test("another human identity cannot replay a named approval", async () => {
    const { registry } = setup();
    await started(registry);
    await proposed(registry);
    await registry.decide(decision("proposal_0", "decision_0"));
    await expect(
      registry.commit({
        id: "commit_other",
        packetId: "packet_1",
        approvals: [{ proposalId: "proposal_0", decisionId: "decision_0" }],
        actor: { kind: "human", id: "other" },
        at,
        reason: "replay",
      }),
    ).rejects.toThrow();
    expect((await registry.snapshot()).canonical.art_a.ref).toEqual(base);
  });
  test("state precedence is explicit", () => {
    const run = {
      id: "x",
      scope: "p",
      entryMode: "hybrid" as const,
      base: [],
      reused: [],
      artifacts: [],
      proposals: {},
      blockers: {},
      safeActions: [],
    };
    expect(deriveRunState(run)).toBe("closed");
    expect(deriveRunState({ ...run, blockers: { x: "reason" } })).toBe(
      "blocked",
    );
    expect(
      deriveRunState({
        ...run,
        safeActions: ["safe"],
        blockers: { x: "reason" },
      }),
    ).toBe("active");
  });
});
