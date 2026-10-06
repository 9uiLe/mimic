import { describe, expect, test } from "vitest";
import { jsonCopy } from "../artifact-canonical.js";
import type { ArtifactSnapshot } from "../artifact-store.js";
import type {
  ExactArtifactRef,
  SnapshotReader,
} from "../runtime-engines/dependency.js";
import {
  deriveRunState,
  FileRegistryStorage,
  RunRegistry,
  type DecisionRecord,
  type RegistryState,
  type TransactionalRegistryStorage,
} from "./registry.js";
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
  runs: {},
  packets: {},
  decisions: {},
  events: [],
});
class MemoryStorage implements TransactionalRegistryStorage {
  state = empty();
  private pending: Promise<void> = Promise.resolve();
  fail = false;
  read() {
    return Promise.resolve(jsonCopy(this.state));
  }
  transact<T>(change: (state: RegistryState) => Promise<T>): Promise<T> {
    const task = this.pending.then(async () => {
      const copy = jsonCopy(this.state);
      const result = await change(copy);
      if (this.fail) throw Error("simulated write failure");
      this.state = copy;
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
  const artifacts = new Map<
    string,
    { artifact: ArtifactSnapshot; digest: string }
  >();
  for (const [ref, status] of [
    [base, "approved"],
    [a2, "proposed"],
    [b1, "proposed"],
  ] as const)
    artifacts.set(`${ref.artifactId}@${ref.revision}`, {
      artifact: artifact(ref, status),
      digest: ref.lockDigest,
    });
  const reader: SnapshotReader = {
    async read(id, revision) {
      const snapshot = artifacts.get(`${id}@${revision}`);
      if (!snapshot) throw Error("missing");
      return jsonCopy(snapshot);
    },
  };
  const registry = new RunRegistry(storage, reader, {
    async verify() {
      return true;
    },
    async allowCommit() {
      return true;
    },
  });
  return { storage, artifacts, registry };
}
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
): DecisionRecord => ({
  id,
  packetId: "packet_1",
  proposalId,
  outcome,
  actor,
  at,
  rationale: "human choice",
});

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
      packetId: "packet_1",
      approvals: [{ proposalId: "proposal_0", decisionId: "decision_0" }],
      actor,
      at,
      reason: "approve A",
    });
    const snapshot = await registry.snapshot();
    expect(snapshot.canonical.art_a.ref).toEqual(a2);
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
    const { registry, storage, artifacts } = setup();
    await started(registry);
    await proposed(registry);
    await registry.decide(decision("proposal_0", "decision_0"));
    storage.state.canonical.art_a.ref = b1;
    await expect(
      registry.commit({
        packetId: "packet_1",
        approvals: [{ proposalId: "proposal_0", decisionId: "decision_0" }],
        actor,
        at,
        reason: "commit",
      }),
    ).rejects.toThrow();
    storage.state.canonical.art_a.ref = base;
    artifacts.get("art_a@2")!.digest = digest("d");
    await expect(
      registry.commit({
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
      packetId: "packet_1",
      approvals: [{ proposalId: "proposal_0", decisionId: "decision_0" }],
      actor,
      at,
      reason: "commit",
    };
    const first = registry.commit(input);
    input.approvals[0].proposalId = "other";
    const second = registry.commit({
      packetId: "packet_1",
      approvals: [{ proposalId: "proposal_0", decisionId: "decision_0" }],
      actor,
      at,
      reason: "commit",
    });
    const results = await Promise.allSettled([first, second]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await registry.snapshot()).canonical.art_a.ref).toEqual(a2);
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
      base: [a2],
      reused: [{ ref: a2, reason: "approved by registry decision" }],
      safeActions: ["explore"],
      actor: agent,
      at,
      reason: "new branch",
    });
    expect((await registry.run("run_2")).state).toBe("active");
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
