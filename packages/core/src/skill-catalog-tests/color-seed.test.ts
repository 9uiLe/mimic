import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  checkColorRoleProposal,
  retrieveDesignReferences,
  validateDesignKnowledgeGraph,
  type ColorRoleContract,
  type ColorRoleProposal,
  type DesignKnowledgeGraph,
} from "../design-knowledge/index.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const read = <T>(name: string): T =>
  JSON.parse(
    readFileSync(path.join(root, "knowledge/seed", name), "utf8"),
  ) as T;
const contract = read<ColorRoleContract>("color-role-contract.json");
const graph = read<DesignKnowledgeGraph>("graph.json");
const spaces = read<{
  spaces: {
    category: string;
    problemTraits: string[];
    referenceCases: string[];
    transferHypothesisRefs: string[];
  }[];
}>("spaces.json").spaces;
const ledger = read<{
  evidence: {
    id: string;
    kind: string;
    author: string;
    sourceUrl: string;
    accessDate: string;
    claimLinkage: string[];
  }[];
}>("sources.json").evidence;

test("color reference paths are source-linked and retrievable as distinct mechanisms", () => {
  expect(() => validateDesignKnowledgeGraph(graph)).not.toThrow();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const evidence = new Map(ledger.map((entry) => [entry.id, entry]));
  expect(new Set(contract.sourceCaseIds).size).toBe(4);
  const selected = spaces.filter((space) =>
    contract.sourceCaseIds.includes(space.referenceCases[0]!),
  );
  expect(selected).toHaveLength(4);
  for (const space of selected) {
    const caseId = space.referenceCases[0]!;
    const suffix = caseId.slice(5);
    expect(nodes.get(caseId)?.kind).toBe("case");
    for (const [id, kind] of [
      [`obs:${suffix}`, "observation"],
      [`hyp:${suffix}`, "transfer-hypothesis"],
    ]) {
      const entry = evidence.get(id);
      expect(entry?.kind).toBe(kind);
      expect(entry?.author.trim()).toBeTruthy();
      expect(entry?.sourceUrl).toMatch(/^https:\/\//);
      expect(entry?.accessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry?.claimLinkage.length).toBeGreaterThan(0);
    }
  }
  const result = retrieveDesignReferences(graph, {
    traitIds: selected.flatMap((space) => space.problemTraits),
    assessments: selected.map((space) => ({
      caseId: space.referenceCases[0]!,
      role: "near" as const,
      structuralFit: "high" as const,
      contextDistance: "low" as const,
      rationale: `Assess ${space.category} on the same Mimic screens.`,
      evidenceRefs: space.transferHypothesisRefs,
    })),
  });
  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(result.selected).toHaveLength(4);
  expect(
    new Set(result.selected.flatMap((item) => item.mechanismIds)).size,
  ).toBe(4);
});

test("role proposal checker catches missing mappings, unknown sources and ambiguous state reuse", () => {
  expect(new Set(contract.requiredRoles).size).toBe(
    contract.requiredRoles.length,
  );
  expect(new Set(contract.requiredContexts).size).toBe(
    contract.requiredContexts.length,
  );
  expect(Object.keys(contract.requiredContextRoles).sort()).toEqual(
    [...contract.requiredContexts].sort(),
  );
  for (const roles of Object.values(contract.requiredContextRoles))
    expect(roles.every((role) => contract.requiredRoles.includes(role))).toBe(
      true,
    );
  const roles = Object.fromEntries(
    contract.requiredRoles.map((role, index) => [
      role,
      `candidate-value-${index}`,
    ]),
  );
  const contexts = Object.fromEntries(
    contract.requiredContexts.map((context) => [
      context,
      contract.requiredRoles,
    ]),
  );
  const valid: ColorRoleProposal = {
    intent: "Provisional restrained brand emphasis",
    sourceCaseIds: [contract.sourceCaseIds[0]!],
    roles,
    contexts,
  };
  expect(checkColorRoleProposal(contract, valid)).toEqual([]);
  const invalid: ColorRoleProposal = {
    ...valid,
    sourceCaseIds: ["case:uncited"],
    roles: {
      ...roles,
      "status.blocked": roles["brand.accent"]!,
      "text.primary": "",
      extra: "raw-color",
    },
  };
  expect(checkColorRoleProposal(contract, invalid)).toEqual(
    expect.arrayContaining([
      "unknown-source-case:case:uncited",
      "unmapped-role:text.primary",
      "undeclared-role:extra",
      "unexplained-shared-value:status.blocked:brand.accent",
    ]),
  );
  const stateInvalid: ColorRoleProposal = {
    ...valid,
    roles: {
      ...roles,
      "status.blocked": "#ABCDEF",
      "status.complete": "#abcdef",
    },
    contexts: {
      ...contexts,
      "blocked work": ["text.primary", "surface"],
    },
  };
  expect(checkColorRoleProposal(contract, stateInvalid)).toEqual(
    expect.arrayContaining([
      "missing-context-role:blocked work:status.blocked",
      "unexplained-shared-value:status.blocked:status.complete",
    ]),
  );
  expect(
    checkColorRoleProposal(contract, {
      ...valid,
      roles: {
        ...roles,
        "status.blocked": "#fff",
        "status.complete": "#FFFFFF",
      },
    }),
  ).toContain("unexplained-shared-value:status.blocked:status.complete");
});
