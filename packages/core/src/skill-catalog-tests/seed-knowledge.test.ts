import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  profileTraitIds,
  retrieveDesignReferences,
  validateDesignKnowledgeGraph,
  type DesignKnowledgeGraph,
  type CaseAssessment,
} from "../design-knowledge/index.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const read = <T>(name: string): T =>
  JSON.parse(
    readFileSync(path.join(root, "knowledge/seed", name), "utf8"),
  ) as T;
const graph = read<DesignKnowledgeGraph>("graph.json");
interface Space {
  id: string;
  category: string;
  label: string;
  problemTraits: string[];
  principles: string[];
  transferableMechanisms: string[];
  referenceCases: string[];
  goodFit: string[];
  poorFit: string[];
  failureModes: string[];
  superficialDoNotBorrow: string[];
  observedClaimRefs: string[];
  transferHypothesisRefs: string[];
}
interface Evidence {
  id: string;
  kind: "observation" | "transfer-hypothesis";
  sourceUrl: string;
  sourceTitle: string;
  relevantSection: string;
  accessDate: string;
  claim: string;
  claimLinkage: string[];
  rightsStrategy: string;
}
const spaces = read<{ version: number; spaces: Space[] }>("spaces.json").spaces;
const evidence = read<{ version: number; evidence: Evidence[] }>(
  "sources.json",
).evidence;
const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
const ledger = new Map(evidence.map((item) => [item.id, item]));
const edges = (from: string, to: string) =>
  graph.edges.some((edge) => edge.from === from && edge.to === to);

test("public seed is a valid typed graph with no dangling or duplicate edges", () => {
  expect(() => validateDesignKnowledgeGraph(graph)).not.toThrow();
  expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(
    graph.nodes.length,
  );
  expect(
    new Set(graph.edges.map((edge) => `${edge.from}\0${edge.to}`)).size,
  ).toBe(graph.edges.length);
  expect(
    graph.edges.every((edge) => nodes.has(edge.from) && nodes.has(edge.to)),
  ).toBe(true);
  const wrong = {
    ...graph,
    edges: [
      ...graph.edges,
      {
        ...graph.edges[0]!,
        from: graph.nodes.find((n) => n.kind === "case")!.id,
        to: graph.nodes.find((n) => n.kind === "trait")!.id,
      },
    ],
  };
  expect(() => validateDesignKnowledgeGraph(wrong)).toThrow(/Invalid edge/);
  expect(() =>
    validateDesignKnowledgeGraph({
      ...graph,
      edges: [...graph.edges, graph.edges[0]!],
    }),
  ).toThrow(/Duplicate edge/);
  expect(() =>
    validateDesignKnowledgeGraph({
      ...graph,
      edges: [...graph.edges, { ...graph.edges[0]!, to: "absent" }],
    }),
  ).toThrow(/Dangling edge/);
});

test("every graph claim resolves to a specific observation or transfer hypothesis", () => {
  expect(new Set(evidence.map((item) => item.id)).size).toBe(evidence.length);
  for (const item of evidence) {
    expect(item.sourceUrl).toMatch(/^https:\/\//);
    expect(item.sourceTitle.trim()).not.toBe("");
    expect(item.relevantSection.trim()).not.toBe("");
    expect(item.accessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(item.claim.trim()).not.toBe("");
    expect(item.rightsStrategy.trim()).not.toBe("");
    expect(item.claimLinkage.length).toBeGreaterThan(0);
    for (const id of item.claimLinkage) expect(nodes.has(id)).toBe(true);
  }
  for (const node of graph.nodes) {
    for (const ref of node.evidenceRefs) expect(ledger.has(ref)).toBe(true);
    if (node.kind === "case")
      expect(
        node.evidenceRefs.every(
          (ref) => ledger.get(ref)?.kind === "observation",
        ),
      ).toBe(true);
  }
  for (const edge of graph.edges)
    for (const ref of edge.evidenceRefs) expect(ledger.has(ref)).toBe(true);
});

test("all eight reference spaces carry fit boundaries and complete retrievable paths", () => {
  expect(new Set(spaces.map((space) => space.category))).toEqual(
    new Set([
      "digital-interfaces",
      "editorial-information",
      "physical-operations",
      "instruments-tools",
      "games-simulation",
      "commerce-service",
      "communication",
      "spatial-conceptual-systems",
    ]),
  );
  expect(spaces.length).toBe(8);
  for (const space of spaces) {
    expect(nodes.get(space.id)?.kind).toBe("space");
    const trait = nodes.get(space.problemTraits[0]!);
    expect(profileTraitIds(graph, [trait!.label])).toEqual([trait!.id]);
    for (const value of [
      space.goodFit,
      space.poorFit,
      space.superficialDoNotBorrow,
    ])
      expect(
        value.every((text) => text.trim().length > 0) && value.length > 0,
      ).toBe(true);
    for (const value of [
      space.problemTraits,
      space.principles,
      space.transferableMechanisms,
      space.referenceCases,
      space.failureModes,
    ])
      expect(value.length).toBeGreaterThan(0);
    expect(
      space.observedClaimRefs.every(
        (ref) => ledger.get(ref)?.kind === "observation",
      ),
    ).toBe(true);
    expect(
      space.transferHypothesisRefs.every(
        (ref) => ledger.get(ref)?.kind === "transfer-hypothesis",
      ),
    ).toBe(true);
    for (const trait of space.problemTraits)
      for (const principle of space.principles)
        for (const caseId of space.referenceCases)
          for (const mechanism of space.transferableMechanisms) {
            expect(edges(trait, principle)).toBe(true);
            expect(edges(principle, space.id)).toBe(true);
            expect(edges(space.id, caseId)).toBe(true);
            expect(edges(caseId, mechanism)).toBe(true);
            expect(edges(mechanism, principle)).toBe(true);
            for (const failure of space.failureModes)
              expect(edges(principle, failure)).toBe(true);
          }
  }
});

test("problem-specific assessments retrieve diverse mechanisms, with honest exclusions", () => {
  const [journey, operations, editorial] = [
    "digital-interfaces",
    "physical-operations",
    "editorial-information",
  ].map((category) => spaces.find((space) => space.category === category)!);
  const assessments: CaseAssessment[] = [
    {
      caseId: journey.referenceCases[0]!,
      role: "near",
      structuralFit: "high",
      contextDistance: "low",
      rationale: "Ordered tasks span service boundaries in this problem.",
      evidenceRefs: journey.transferHypothesisRefs,
    },
    {
      caseId: operations.referenceCases[0]!,
      role: "far",
      structuralFit: "high",
      contextDistance: "high",
      rationale:
        "Exception handoff is structurally relevant despite a factory context.",
      evidenceRefs: operations.transferHypothesisRefs,
    },
    {
      caseId: editorial.referenceCases[0]!,
      role: "anti-reference",
      structuralFit: "low",
      contextDistance: "medium",
      rationale: "Version diffs do not coordinate urgent response.",
      evidenceRefs: editorial.transferHypothesisRefs,
    },
  ];
  const result = retrieveDesignReferences(graph, {
    traitIds: [
      journey.problemTraits[0]!,
      operations.problemTraits[0]!,
      editorial.problemTraits[0]!,
    ],
    assessments,
    limit: 2,
  });
  expect(result.status).toBe("ready");
  expect(result.selected.map((item) => item.caseId)).toEqual(
    expect.arrayContaining([
      journey.referenceCases[0],
      operations.referenceCases[0],
    ]),
  );
  expect(
    new Set(result.selected.flatMap((item) => item.mechanismIds)).size,
  ).toBeGreaterThan(1);
  expect(result.exclusions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        caseId: editorial.referenceCases[0],
        reason: "portfolio-limit",
      }),
    ]),
  );
  expect(result.gaps).toContain(
    `uncovered-principle:${editorial.principles[0]}`,
  );
  const changed = retrieveDesignReferences(graph, {
    traitIds: operations.problemTraits,
    assessments: [
      {
        ...assessments[1]!,
        role: "near",
        contextDistance: "low",
        rationale: "In this problem factory operations are the local context.",
      },
    ],
  });
  expect(changed.selected[0]?.role).toBe("near");
  const rejected = retrieveDesignReferences(graph, {
    traitIds: operations.problemTraits,
    assessments: [assessments[1]!],
    history: [
      {
        caseId: operations.referenceCases[0]!,
        rejected: true,
        usageCount: 0,
        reason: "Known mismatch for this project.",
      },
    ],
  });
  expect(rejected.status).toBe("blocked");
  expect(rejected.exclusions[0]?.reason).toBe("previously-rejected");
  expect(rejected.exclusions[0]?.doNotBorrow.length).toBeGreaterThan(0);
  expect(rejected.exclusions[0]?.failureIds.length).toBeGreaterThan(0);
});
