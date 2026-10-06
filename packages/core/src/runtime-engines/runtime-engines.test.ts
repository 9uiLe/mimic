import { describe, expect, test } from "vitest";
import { jsonCopy } from "../artifact-canonical.js";
import {
  ArtifactStoreError,
  type ArtifactSnapshot,
} from "../artifact-store.js";
import {
  DependencyGraph,
  RuntimeEngineError,
  type ExactArtifactRef,
  type SnapshotReader,
} from "./dependency.js";
import { assessProvenance } from "./provenance.js";
import { evaluatePropertyPolicy, guardArtifactRevision } from "./policy.js";
import { ExecutionAuditLog } from "./audit.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const ref = (id: string, revision = 1): ExactArtifactRef => ({
  artifactId: `art_${id}`,
  revision,
  lockDigest: digest(id[0] ?? "a"),
});
function snapshot(
  id: string,
  dependencies: readonly {
    artifactId: string;
    revision: number;
    lockDigest: string;
    onChange: string;
  }[] = [],
): ArtifactSnapshot {
  return {
    meta: {
      id: `art_${id}`,
      type: "design-system-asset",
      schemaVersion: "1.0.0",
      revision: 1,
    },
    scope: { level: "organization", ownerId: "org" },
    lifecycle: { status: "approved", freshness: "valid" },
    approval: {
      status: "approved",
      decisionId: "decision_1",
      actorId: "human_1",
    },
    dependencies,
    provenance: [
      { path: "/content/claim", kind: "unknown", rationale: "Not checked" },
    ],
    content: { claim: "Example" },
  };
}
function candidate(id: string): ArtifactSnapshot {
  const original = snapshot(id);
  return {
    ...original,
    meta: { ...original.meta, revision: 2, supersedesRevision: 1 },
  };
}
function edge(id: string, onChange: string) {
  return { ...ref(id), onChange };
}
function reader(values: Record<string, ArtifactSnapshot>): SnapshotReader {
  return {
    async read(id, revision) {
      const artifact = values[`${id}@${revision}`];
      if (!artifact)
        throw new ArtifactStoreError("UNAVAILABLE", "Missing exact snapshot");
      return { artifact: jsonCopy(artifact), digest: digest(id.slice(4, 5)) };
    },
  };
}

describe("dependency and freshness engines", () => {
  test("traverses deterministically and assesses only affected paths with strongest impact", async () => {
    const values = {
      "art_a@1": snapshot("a"),
      "art_a@2": candidate("a"),
      "art_b@1": snapshot("b", [edge("a", "validate")]),
      "art_c@1": snapshot("c", [edge("a", "revise")]),
      "art_d@1": snapshot("d", [
        edge("c", "validate"),
        edge("b", "invalidate"),
      ]),
      "art_e@1": snapshot("e", [edge("a", "none")]),
    };
    const original = jsonCopy(values);
    const graph = await DependencyGraph.load(reader(values), [
      ref("e"),
      ref("d"),
    ]);
    expect(graph.order.map((item) => item.artifactId)).toEqual([
      "art_a",
      "art_b",
      "art_c",
      "art_d",
      "art_e",
    ]);
    expect(graph.directImpacts(ref("a")).map((edge) => edge.onChange)).toEqual([
      "validate",
      "revise",
      "none",
    ]);
    const findings = await graph.assessChanges([
      {
        artifactId: "art_a",
        fromRevision: 1,
        candidateRevision: 2,
        candidateDigest: digest("a"),
      },
    ]);
    expect(
      findings.map(({ artifact, impact, freshness, paths }) => [
        artifact.artifactId,
        impact,
        freshness,
        paths.length,
      ]),
    ).toEqual([
      ["art_b", "validate", "stale", 1],
      ["art_c", "revise", "stale", 1],
      ["art_d", "invalidate", "blocked", 2],
    ]);
    expect(graph.get(ref("b"))?.artifact.dependencies[0]?.revision).toBe(1);
    expect(values).toEqual(original);
    expect(
      findings[2]?.paths.map((path) =>
        path.map((part) => part.dependent.artifactId),
      ),
    ).toEqual([
      ["art_b", "art_d"],
      ["art_c", "art_d"],
    ]);
  });

  test("rejects a wrong digest on cached lookups", async () => {
    const graph = await DependencyGraph.load(
      reader({ "art_a@1": snapshot("a") }),
      [ref("a")],
    );
    expect(() =>
      graph.get({ ...ref("a"), lockDigest: digest("f") }),
    ).toThrowError(expect.objectContaining({ code: "INTEGRITY" }));
  });

  test("caller root mutation cannot change graph edges or freshness", async () => {
    const root = { ...ref("b") };
    const graph = await DependencyGraph.load(
      reader({
        "art_a@1": snapshot("a"),
        "art_a@2": candidate("a"),
        "art_b@1": snapshot("b", [edge("a", "invalidate")]),
      }),
      [root],
    );
    root.revision = 2;
    root.lockDigest = digest("f");
    const findings = await graph.assessChanges([
      {
        artifactId: "art_a",
        fromRevision: 1,
        candidateRevision: 2,
        candidateDigest: digest("a"),
      },
    ]);
    expect(
      findings.map(({ artifact, impact, freshness }) => [
        artifact.artifactId,
        artifact.revision,
        impact,
        freshness,
      ]),
    ).toEqual([["art_b", 1, "invalidate", "blocked"]]);
    expect(graph.order.at(-1)).toEqual(ref("b"));
  });

  test("blocks cycles, missing locks, conflicting digests and invalid input", async () => {
    const cycle = reader({
      "art_a@1": snapshot("a", [edge("b", "validate")]),
      "art_b@1": snapshot("b", [edge("a", "validate")]),
    });
    await expect(DependencyGraph.load(cycle, [ref("a")])).rejects.toMatchObject(
      { code: "CYCLE" },
    );
    await expect(
      DependencyGraph.load(
        reader({ "art_a@1": snapshot("a", [edge("b", "validate")]) }),
        [ref("a")],
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(
      DependencyGraph.load(reader({ "art_a@1": snapshot("a") }), [
        { ...ref("a"), lockDigest: digest("f") },
      ]),
    ).rejects.toMatchObject({ code: "INTEGRITY" });
    await expect(
      DependencyGraph.load(reader({ "art_a@1": snapshot("a") }), []),
    ).rejects.toMatchObject({ code: "INVALID" });
    const graph = await DependencyGraph.load(
      reader({ "art_a@1": snapshot("a"), "art_a@2": candidate("a") }),
      [ref("a")],
    );
    await expect(
      graph.assessChanges([
        {
          artifactId: "art_a",
          fromRevision: 1,
          candidateRevision: 1,
          candidateDigest: digest("a"),
        },
      ]),
    ).rejects.toThrow(RuntimeEngineError);
    await expect(
      graph.assessChanges([
        {
          artifactId: "art_a",
          fromRevision: 1,
          candidateRevision: 2,
          candidateDigest: digest("f"),
        },
      ]),
    ).rejects.toMatchObject({ code: "INTEGRITY" });
  });
});

describe("provenance", () => {
  test("keeps claims qualified until references or decisions are verified", async () => {
    const artifact = {
      ...snapshot("a"),
      content: {
        fact: 1,
        decision: 2,
        assumption: 3,
        hypothesis: 4,
        derived: 5,
        unknown: 6,
      },
      provenance: [
        { path: "/content/fact", kind: "fact", evidenceRefs: ["evidence:1"] },
        {
          path: "/content/decision",
          kind: "human-decision",
          decisionId: "decision_1",
        },
        {
          path: "/content/assumption",
          kind: "assumption",
          rationale: "Awaiting data",
        },
        {
          path: "/content/hypothesis",
          kind: "hypothesis",
          rationale: "To test",
        },
        { path: "/content/derived", kind: "derived", inputRefs: ["art_a@1"] },
        { path: "/content/unknown", kind: "unknown", rationale: "No source" },
      ],
    } as ArtifactSnapshot;
    const original = jsonCopy(artifact);
    expect(
      (await assessProvenance(artifact)).map((finding) => finding.status),
    ).toEqual([
      "DECLARED",
      "UNVERIFIED",
      "UNVERIFIED",
      "UNVERIFIED",
      "DECLARED",
      "UNKNOWN",
    ]);
    const verified = await assessProvenance(artifact, {
      verifyEvidence: async () => true,
      verifyInput: async () => true,
      verifyDecision: async () => true,
    });
    expect(
      verified.filter((finding) => finding.status === "VERIFIED"),
    ).toHaveLength(3);
    expect(artifact).toEqual(original);
    await expect(
      assessProvenance({
        ...artifact,
        provenance: [
          { path: "/content/missing", kind: "fact", evidenceRefs: ["e"] },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await expect(
      assessProvenance({
        ...artifact,
        provenance: [{ path: "/content/fact", kind: "fact" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("policy and audit", () => {
  const parent = ref("a");
  const baseRule = {
    parent,
    path: "/content/definition/density",
    value: "comfortable",
  } as const;
  const baseSelection = {
    parent,
    path: baseRule.path,
    value: "compact",
    rationale: "Dense table",
    intent: "commit",
  } as const;

  test("enforces locked, bounded configurable and approved override values", async () => {
    expect(
      await evaluatePropertyPolicy(
        { ...baseRule, policy: "locked" },
        baseSelection,
      ),
    ).toMatchObject({ allowed: false });
    expect(
      await evaluatePropertyPolicy(
        {
          ...baseRule,
          policy: "configurable",
          allowedValues: ["comfortable", "compact"],
        },
        baseSelection,
      ),
    ).toMatchObject({ allowed: true, effect: "configure" });
    expect(
      await evaluatePropertyPolicy(
        { ...baseRule, policy: "configurable", allowedValues: ["comfortable"] },
        baseSelection,
      ),
    ).toMatchObject({ allowed: false });
    expect(
      await evaluatePropertyPolicy(
        {
          parent,
          path: baseRule.path,
          policy: "configurable",
          value: 1,
          allowedValues: [1, 2],
          numericRange: { minimum: 10, maximum: 20 },
        },
        { ...baseSelection, value: 15 },
      ),
    ).toMatchObject({ allowed: false, effect: "blocked" });
    expect(
      await evaluatePropertyPolicy(
        { ...baseRule, policy: "overridable" },
        baseSelection,
      ),
    ).toMatchObject({ allowed: false });
    expect(
      await evaluatePropertyPolicy(
        { ...baseRule, policy: "overridable" },
        { ...baseSelection, intent: "propose" },
      ),
    ).toMatchObject({ allowed: true });
    expect(
      await evaluatePropertyPolicy(
        { ...baseRule, policy: "overridable" },
        { ...baseSelection, approvalDecisionId: "decision_1" },
        { verifyApproval: async () => true },
      ),
    ).toMatchObject({ allowed: true, effect: "override" });
    await expect(
      evaluatePropertyPolicy(
        { ...baseRule, policy: "locked" },
        { ...baseSelection, parent: ref("b") },
      ),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  test("requires new approved revision and records ordered defensive-copy audit events", async () => {
    const previous = snapshot("a");
    const next = {
      ...previous,
      meta: { ...previous.meta, revision: 2, supersedesRevision: 1 },
      lifecycle: { status: "proposed" as const, freshness: "valid" },
      approval: { status: "pending" as const },
    };
    expect(
      (
        await guardArtifactRevision({
          previous,
          next: previous,
          action: "propose",
        })
      ).allowed,
    ).toBe(false);
    expect(
      (await guardArtifactRevision({ previous, next, action: "propose" }))
        .allowed,
    ).toBe(true);
    expect(
      (
        await guardArtifactRevision({
          previous,
          next: {
            ...next,
            lifecycle: { status: "approved", freshness: "valid" },
            approval: { status: "approved" },
          },
          action: "approve",
        })
      ).allowed,
    ).toBe(false);
    const saved: number[] = [];
    const log = new ExecutionAuditLog({
      append: async (event) => {
        saved.push(event.sequence);
      },
    });
    const input = {
      runId: "run_1",
      actor: { kind: "agent" as const, id: "agent_1" },
      at: "2026-10-06T00:00:00Z",
      action: "propose",
      outcome: "allowed" as const,
      reason: "New revision",
      inputs: [ref("a")],
      outputs: [ref("a", 2)],
    };
    const first = await log.record(input);
    await log.record({ ...input, action: "review", outcome: "blocked" });
    await Promise.all([
      log.record({ ...input, action: "concurrent-a" }),
      log.record({ ...input, action: "concurrent-b" }),
    ]);
    (first.inputs as ExactArtifactRef[])[0] = ref("b");
    expect(log.events().map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(log.events()[0]?.inputs[0]?.artifactId).toBe("art_a");
    expect(saved).toEqual([1, 2, 3, 4]);
  });
});
