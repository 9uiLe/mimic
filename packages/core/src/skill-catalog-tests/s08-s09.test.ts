import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactDigest } from "../artifact-canonical.js";
import { parseArtifactYaml } from "../artifact-codec.js";
import type { ArtifactSnapshot, ScopeNode } from "../artifact-store.js";
import {
  profileTraitIds,
  referenceSelectionFromRetrieval,
  retrieveDesignReferences,
  type CaseAssessment,
  type DesignKnowledgeGraph,
  type RetrievalRequest,
} from "../design-knowledge/index.js";
import {
  createOrchestratorRuntime,
  type RoutedTask,
} from "../orchestrator/router.js";
import { loadSchemaDirectory } from "../schema-registry.js";
import { assessProvenance } from "../runtime-engines/provenance.js";
import {
  loadSkillPackage,
  runSkillPackage,
  type SkillPackage,
} from "../skill-runtime/index.js";
import { FileWorkspaceStorage } from "../workspace-transaction.js";

const repository = path.resolve(import.meta.dirname, "../../../..");
const schemaRoot = path.join(repository, "schemas");
const at = "2026-10-06T12:00:00Z";
const scopes: ScopeNode[] = [
  { level: "organization", ownerId: "org_9uile" },
  { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
];
const directories = [
  "s08-design-problem-profiler",
  "s09-design-space-explorer",
] as const;
const inventory: Record<(typeof directories)[number], string[]> = {
  "s08-design-problem-profiler": [
    "profile-trace",
    "missing-contract",
    "unknown-behavior",
    "exact-lock",
  ],
  "s09-design-space-explorer": [
    "portfolio",
    "far-fit",
    "wildcard-fit",
    "rejection-history",
    "disconnected",
    "dangling-edge",
    "deterministic",
    "no-viable",
    "diversity-and-history",
    "profile-map",
    "usage-order",
    "no-case-to-pattern",
    "rejected-graph-context",
    "conflicting-duplicate",
    "portfolio-limit",
    "contract-relevance",
    "blocked-runtime",
    "selected-edge-evidence",
    "exact-lock",
  ],
};
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});
const ref = (artifact: ArtifactSnapshot) => ({
  artifactId: artifact.meta.id,
  revision: artifact.meta.revision,
  lockDigest: artifactDigest(artifact),
});
const assessment = (
  caseId: string,
  role: CaseAssessment["role"],
  structuralFit: CaseAssessment["structuralFit"],
  contextDistance: CaseAssessment["contextDistance"],
  unconventional = false,
): CaseAssessment => ({
  caseId,
  role,
  structuralFit,
  contextDistance,
  unconventional,
  rationale: `The ${caseId} mechanism addresses a named trait; ${contextDistance} context distance is assessed separately from ${structuralFit} fit.`,
  evidenceRefs: [`fixture://assessment/${caseId}`],
});
const assessments: CaseAssessment[] = [
  assessment("case_near", "near", "high", "low"),
  assessment("case_adjacent", "adjacent", "medium", "medium"),
  assessment("case_far", "far", "high", "high"),
  assessment("case_wildcard", "wildcard", "medium", "high", true),
  assessment("case_anti", "anti-reference", "low", "low"),
];
const request: RetrievalRequest = {
  traitIds: ["trait_handoff", "trait_sequence"],
  assessments,
};
/** A fixture-specific contract comparison; it is not a universal fit model. */
function boundedAssessments(contract: ArtifactSnapshot): CaseAssessment[] {
  const entityContext = (contract.content as { entityContext: string[] })
    .entityContext;
  return entityContext.includes("Product ID")
    ? assessments
    : assessments.map((item) =>
        item.caseId === "case_near"
          ? { ...item, structuralFit: "low" as const }
          : item,
      );
}
const exactInput = (item: { ref: ReturnType<typeof ref> }) =>
  `${item.ref.artifactId}@${item.ref.revision}#${item.ref.lockDigest}`;

function fixture<T>(source: string): T {
  return JSON.parse(source) as T;
}
function exactTask(skill: SkillPackage): RoutedTask {
  return {
    id: "target",
    skillId: skill.manifest.skillId,
    outputType: skill.manifest.outputs[0]!,
    scopeOwnerId: "product_mimic",
    intent: "create",
    authority: "AUTONOMOUS",
    inputs: {
      required: skill.manifest.inputs.required.map((item) => ({ ...item })),
      optional: skill.manifest.inputs.optional.map((item) => ({ ...item })),
      alternatives: skill.manifest.inputs.alternatives.map((group) => ({
        oneOf: group.oneOf.map((item) => ({ ...item })),
      })),
    },
    evidenceFiles: ["fixture://knowledge/graph"],
  };
}

for (const slug of directories)
  test(`${slug} loads complete scenarios and schema-valid example`, async () => {
    const skill = await loadSkillPackage(
      path.join(repository, "skills", slug),
      schemaRoot,
    );
    const schemas = await loadSchemaDirectory(
      path.join(schemaRoot, "artifacts"),
    );
    const scenarios = fixture<{ scenarios: { id: string }[] }>(
      skill.tests["tests/scenarios.json"]!,
    );
    expect(scenarios.scenarios.map((item) => item.id).sort()).toEqual(
      [...inventory[slug]].sort(),
    );
    expect(new Set(scenarios.scenarios.map((item) => item.id)).size).toBe(
      scenarios.scenarios.length,
    );
    expect(skill.instructions).toContain("Orchestrator");
    expect(skill.instructions).toContain("blocked");
    for (const source of Object.values(skill.examples)) {
      const artifact = fixture<ArtifactSnapshot>(source);
      expect(schemas.validate(artifact)).toEqual({
        valid: true,
        diagnostics: [],
      });
      expect(artifact.approval.status).toBe("pending");
    }
  });

test("S09 schema-valid duplicate provenance is rejected by Core", async () => {
  const skill = await loadSkillPackage(
    path.join(repository, "skills/s09-design-space-explorer"),
    schemaRoot,
  );
  expect(skill.instructions).toContain(
    "each exact `/content` path occurs at most once",
  );
  const example = fixture<ArtifactSnapshot>(
    skill.examples["examples/selection.json"]!,
  );
  const reproduction = fixture<{ provenance: ArtifactSnapshot["provenance"] }>(
    skill.tests["tests/provenance-duplicate.json"]!,
  );
  const rejected = { ...example, provenance: reproduction.provenance };
  const schemas = await loadSchemaDirectory(path.join(schemaRoot, "artifacts"));
  expect(schemas.validate(rejected).valid).toBe(true);
  await expect(assessProvenance(rejected)).rejects.toThrow(
    "Duplicate provenance pointer: /content/summary",
  );
  expect(await assessProvenance(example)).toHaveLength(3);
});

test("S08 scenarios trace traits, preserve unknowns, and block a missing contract", async () => {
  const skill = await loadSkillPackage(
    path.join(repository, "skills", directories[0]),
    schemaRoot,
  );
  const profile = fixture<ArtifactSnapshot>(
    skill.examples["examples/profile.json"]!,
  );
  const cases = fixture<{
    scenarios: {
      id: string;
      expected: string;
      traitPaths?: string[];
      requiredInputs?: string[];
      reason?: string;
      path?: string;
    }[];
  }>(skill.tests["tests/scenarios.json"]!).scenarios;
  for (const item of cases) {
    switch (item.id) {
      case "profile-trace":
        expect(item.expected).toBe(profile.lifecycle.status);
        expect(
          skill.manifest.inputs.required.map((input) => input.name),
        ).toEqual(item.requiredInputs);
        for (const pointer of item.traitPaths ?? []) {
          const index = Number(pointer.split("/").at(-1));
          expect(
            (profile.content as { traits: string[] }).traits[index],
          ).toBeTruthy();
          expect(
            (
              profile.provenance.find((entry) => entry.path === pointer)
                ?.inputRefs as string[] | undefined
            )?.length,
          ).toBeGreaterThan(0);
        }
        break;
      case "missing-contract":
        expect(item.expected).toBe("blocked");
        expect(item.reason).toContain(
          "Missing required product-ui-contract (product-ui-contract)",
        );
        break;
      case "unknown-behavior":
        expect(item.expected).toBe("unknown");
        expect(
          profile.provenance.find((entry) => entry.path === item.path)?.kind,
        ).toBe("unknown");
        break;
      case "exact-lock":
        expect(item.expected).toBe("preserved");
        expect(skill.instructions).toContain(
          "locked digest mismatch blocks use",
        );
        break;
      default:
        throw new Error(`Unhandled S08 scenario ${item.id}`);
    }
  }
});

test("S09 executes every graph scenario against independent expectations", async () => {
  const skill = await loadSkillPackage(
    path.join(repository, "skills", directories[1]),
    schemaRoot,
  );
  const graph = fixture<DesignKnowledgeGraph>(skill.tests["tests/graph.json"]!);
  const cases = fixture<{
    scenarios: {
      id: string;
      expected: string;
      caseIds?: string[];
      roles?: string[];
      caseId?: string;
      reason?: string;
      message?: string;
      firstCaseId?: string;
      gap?: string;
      traitIds?: string[];
      risk?: string;
      failureId?: string;
      evidenceRef?: string;
      outputCount?: number;
      evidenceRefs?: string[];
    }[];
  }>(skill.tests["tests/scenarios.json"]!).scenarios;
  for (const item of cases) {
    switch (item.id) {
      case "portfolio": {
        const result = retrieveDesignReferences(graph, request);
        expect(result.status).toBe(item.expected);
        expect(
          result.selected.map((candidate) => candidate.caseId).sort(),
        ).toEqual([...item.caseIds!].sort());
        expect(
          result.selected.map((candidate) => candidate.role).sort(),
        ).toEqual([...item.roles!].sort());
        expect(
          result.selected.every(
            (candidate) =>
              candidate.principleIds.length &&
              candidate.mechanismIds.length &&
              candidate.evidenceRefs.length &&
              candidate.doNotBorrow.length &&
              candidate.risks.length,
          ),
        ).toBe(true);
        expect(
          result.selected.find((candidate) => candidate.caseId === "case_far")
            ?.contextDistance,
        ).toBe("high");
        const projected = referenceSelectionFromRetrieval(result);
        const sample = fixture<ArtifactSnapshot>(
          skill.examples["examples/selection.json"]!,
        );
        expect(
          (sample.content as { references: unknown[] }).references.length,
        ).toBeGreaterThan(0);
        expect(
          (
            await loadSchemaDirectory(path.join(schemaRoot, "artifacts"))
          ).validate({
            ...sample,
            content: projected.content,
            provenance: projected.provenance,
          }).valid,
        ).toBe(true);
        expect(projected.provenance[0]?.rationale).toContain("Do not borrow");
        break;
      }
      case "far-fit":
      case "wildcard-fit": {
        const changed = assessments.map((a) =>
          a.caseId === item.caseId
            ? { ...a, structuralFit: "low" as const }
            : a,
        );
        const result = retrieveDesignReferences(graph, {
          ...request,
          assessments: changed,
        });
        expect(result.exclusions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              caseId: item.caseId,
              reason: item.reason,
            }),
          ]),
        );
        break;
      }
      case "rejection-history": {
        const result = retrieveDesignReferences(graph, {
          ...request,
          history: [
            {
              caseId: item.caseId!,
              rejected: true,
              usageCount: 4,
              reason: "Rejected by owner",
            },
          ],
        });
        expect(result.exclusions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              caseId: item.caseId,
              reason: item.reason,
            }),
          ]),
        );
        break;
      }
      case "disconnected": {
        const changed = {
          ...graph,
          edges: graph.edges.filter(
            (edge) =>
              !(edge.from === "case_anti" && edge.to === "mechanism_summary"),
          ),
        };
        const result = retrieveDesignReferences(changed, request);
        expect(result.exclusions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              caseId: item.caseId,
              reason: item.reason,
            }),
          ]),
        );
        break;
      }
      case "dangling-edge":
        expect(() =>
          retrieveDesignReferences(
            {
              ...graph,
              edges: [
                ...graph.edges,
                {
                  from: "missing",
                  to: "case_near",
                  rationale: "bad",
                  evidenceRefs: ["fixture://bad"],
                },
              ],
            },
            request,
          ),
        ).toThrow(item.message);
        break;
      case "deterministic": {
        const first = retrieveDesignReferences(graph, request);
        const second = retrieveDesignReferences(
          {
            nodes: [...graph.nodes].reverse(),
            edges: [...graph.edges].reverse(),
          },
          { ...request, assessments: [...assessments].reverse() },
        );
        expect(first).toEqual(second);
        break;
      }
      case "no-viable": {
        const result = retrieveDesignReferences(graph, {
          ...request,
          assessments: assessments.map((a) => ({
            ...a,
            structuralFit: "low" as const,
            role: "far" as const,
          })),
        });
        expect(result.status).toBe(item.expected);
        expect(result.selected).toEqual([]);
        if (result.status === "blocked")
          expect(result.reason).toBe(item.reason);
        expect(() => referenceSelectionFromRetrieval(result)).toThrow(
          "Blocked retrieval",
        );
        break;
      }
      case "diversity-and-history": {
        const result = retrieveDesignReferences(graph, {
          ...request,
          limit: 1,
          history: [{ caseId: "case_near", rejected: true, usageCount: 3 }],
        });
        expect(result.status).toBe(item.expected);
        expect(result.selected[0]?.caseId).toBe(item.firstCaseId);
        expect(result.gaps).toContain(item.gap);
        break;
      }
      case "profile-map": {
        const profile = fixture<ArtifactSnapshot>(
          (
            await loadSkillPackage(
              path.join(repository, "skills", directories[0]),
              schemaRoot,
            )
          ).examples["examples/profile.json"]!,
        );
        const traits = (profile.content as { traits: string[] }).traits;
        expect(item.expected).toBe("mapped");
        expect(profileTraitIds(graph, traits)).toEqual(item.traitIds);
        expect(() =>
          profileTraitIds(graph, [...traits, "Invented trait"]),
        ).toThrow("Unmapped profile trait: Invented trait");
        expect(
          retrieveDesignReferences(graph, {
            ...request,
            traitIds: profileTraitIds(graph, traits.slice(0, 1)),
          }).selected.every((candidate) =>
            candidate.principleIds.includes("principle_ownership"),
          ),
        ).toBe(true);
        break;
      }
      case "usage-order": {
        const extra = {
          ...graph.nodes.find((node) => node.id === "case_near")!,
          id: "case_near_extra",
          label: "Second incident console",
        };
        const variant = {
          ...graph,
          nodes: [...graph.nodes, extra],
          edges: [
            ...graph.edges,
            {
              from: "space_ops",
              to: extra.id,
              rationale: "Same coordination context",
              evidenceRefs: ["fixture://extra-space"],
            },
            {
              from: extra.id,
              to: "mechanism_timeline",
              rationale: "Same shared timeline",
              evidenceRefs: ["fixture://extra-mechanism"],
            },
          ],
        };
        const result = retrieveDesignReferences(variant, {
          traitIds: ["trait_handoff"],
          assessments: [
            assessments[0]!,
            assessment(extra.id, "near", "high", "low"),
          ],
          history: [
            { caseId: "case_near", usageCount: 7, rejected: false },
            { caseId: extra.id, usageCount: 1, rejected: false },
          ],
          limit: 1,
        });
        expect(result.selected[0]?.caseId).toBe(item.expected);
        break;
      }
      case "no-case-to-pattern":
        expect(() =>
          retrieveDesignReferences(
            {
              ...graph,
              edges: [
                ...graph.edges,
                {
                  from: "case_near",
                  to: "pattern_handoff",
                  rationale: "Copy UI",
                  evidenceRefs: ["fixture://bad-path"],
                },
              ],
            },
            request,
          ),
        ).toThrow(item.message);
        break;
      case "rejected-graph-context": {
        const result = retrieveDesignReferences(graph, {
          ...request,
          history: [
            {
              caseId: item.caseId!,
              usageCount: 1,
              rejected: true,
              reason: "Owner rejected this transfer",
            },
          ],
        });
        const rejected = result.exclusions.find(
          (entry) => entry.caseId === item.caseId,
        );
        expect(item.expected).toBe("excluded");
        expect(rejected?.risks).toContain(item.risk);
        expect(rejected?.failureIds).toContain(item.failureId);
        expect(rejected?.evidenceRefs).toContain(item.evidenceRef);
        const projected = referenceSelectionFromRetrieval(result);
        expect(projected.provenance.at(-1)?.rationale).toContain(
          item.failureId,
        );
        expect(projected.provenance.at(-1)?.evidenceRefs).toContain(
          item.evidenceRef,
        );
        break;
      }
      case "conflicting-duplicate": {
        const high = assessments[0]!;
        const low = {
          ...high,
          structuralFit: "low" as const,
          rationale: "Conflicting low fit judgment",
        };
        const first = retrieveDesignReferences(graph, {
          traitIds: request.traitIds,
          assessments: [high, low],
        });
        const reversed = retrieveDesignReferences(graph, {
          traitIds: request.traitIds,
          assessments: [low, high],
        });
        expect(first).toEqual(reversed);
        expect(first.status).toBe("blocked");
        expect(first.selected).toEqual([]);
        expect(first.exclusions).toEqual([
          expect.objectContaining({ caseId: item.caseId, reason: item.reason }),
        ]);
        break;
      }
      case "portfolio-limit": {
        const result = retrieveDesignReferences(graph, {
          traitIds: request.traitIds,
          assessments: [assessments[0]!, assessments[2]!],
          limit: 1,
        });
        expect(result.status).toBe("ready");
        expect(result.selected).toHaveLength(1);
        const accounted = [
          ...result.selected.map((candidate) => candidate.caseId),
          ...result.exclusions.map((entry) => entry.caseId),
        ].sort();
        expect(accounted).toEqual(["case_far", "case_near"]);
        const omitted = result.exclusions.find(
          (entry) => entry.reason === item.reason,
        );
        expect(omitted?.caseId).toBe(item.caseId);
        expect(omitted?.detail).toContain("Eligible but omitted at limit 1");
        break;
      }
      case "contract-relevance": {
        const contract = parseArtifactYaml(
          await readFile(
            path.join(
              repository,
              "fixtures/artifacts/valid/proposed-product-ui-contract.yaml",
            ),
            "utf8",
          ),
        ) as ArtifactSnapshot;
        const changed = {
          ...contract,
          content: {
            ...(contract.content as object),
            entityContext: ["Unrelated ephemeral note"],
          },
        };
        expect(
          retrieveDesignReferences(graph, {
            ...request,
            assessments: boundedAssessments(contract),
          }).selected.some((candidate) => candidate.caseId === item.caseId),
        ).toBe(true);
        const result = retrieveDesignReferences(graph, {
          ...request,
          assessments: boundedAssessments(changed),
        });
        expect(item.expected).toBe("excluded");
        expect(result.exclusions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              caseId: item.caseId,
              reason: item.reason,
            }),
          ]),
        );
        break;
      }
      case "blocked-runtime":
        expect(item.expected).toBe("blocked");
        expect(item.reason).toBe("no-defensible-candidate");
        expect(item.outputCount).toBe(0);
        break;
      case "selected-edge-evidence": {
        const result = retrieveDesignReferences(graph, request);
        const near = result.selected.find(
          (candidate) => candidate.caseId === item.caseId,
        );
        expect(item.expected).toBe("present");
        for (const source of item.evidenceRefs ?? [])
          expect(near?.evidenceRefs).toContain(source);
        break;
      }
      case "exact-lock":
        expect(item.expected).toBe("preserved");
        expect(skill.instructions).toContain("silently change a lock");
        break;
      default:
        throw new Error(`Unhandled S09 scenario ${item.id}`);
    }
  }
});

for (const slug of directories)
  test(`${slug} runs through the Orchestrator with exact locks and provenance`, async () => {
    const skill = await loadSkillPackage(
      path.join(repository, "skills", slug),
      schemaRoot,
    );
    const schemas = await loadSchemaDirectory(
      path.join(schemaRoot, "artifacts"),
    );
    const root = await mkdtemp(path.join(os.tmpdir(), `mimic-${slug}-`));
    temporary.push(root);
    const runtime = createOrchestratorRuntime(
      new FileWorkspaceStorage(path.join(root, "workspace.json")),
      schemas,
      scopes,
      {
        async verify() {
          return false;
        },
        async allowCommit() {
          return false;
        },
      },
    );
    const target = exactTask(skill);
    const artifactNeeds = skill.manifest.inputs.required.filter(
      (item) => item.kind === "artifact",
    );
    const blockedTask =
      slug === directories[1] ? { ...target, id: "blocked" } : undefined;
    const tasks: RoutedTask[] = [
      ...artifactNeeds.map((item) => ({
        id: `seed-${item.name}`,
        skillId: "mimic.fixture.producer",
        outputType: item.artifactType,
        scopeOwnerId: "product_mimic",
        intent: "create" as const,
        authority: "AUTONOMOUS" as const,
        inputs: { required: [], optional: [], alternatives: [] },
      })),
      target,
      ...(blockedTask ? [blockedTask] : []),
    ];
    const runId = `run_${slug.slice(0, 3)}`;
    await runtime.orchestrator.start({
      id: runId,
      scopeOwnerId: "product_mimic",
      entryMode: "hybrid",
      actor: { kind: "agent", id: "agent_1" },
      at,
      tasks,
    });
    const seeded: ArtifactSnapshot[] = [];
    for (const item of artifactNeeds) {
      const source =
        item.artifactType === "problem-profile"
          ? fixture<ArtifactSnapshot>(
              (
                await loadSkillPackage(
                  path.join(repository, "skills", directories[0]),
                  schemaRoot,
                )
              ).examples["examples/profile.json"]!,
            )
          : item.artifactType === "experience-domain"
            ? fixture<ArtifactSnapshot>(
                await readFile(
                  path.join(
                    repository,
                    "skills/s07-experience-architecture/examples/candidate.json",
                  ),
                  "utf8",
                ),
              )
            : (parseArtifactYaml(
                await readFile(
                  path.join(
                    repository,
                    "fixtures/artifacts/valid",
                    item.artifactType === "product-ui-contract"
                      ? "proposed-product-ui-contract.yaml"
                      : `${item.artifactType}.json`,
                  ),
                  "utf8",
                ),
              ) as ArtifactSnapshot);
      const artifact: ArtifactSnapshot = {
        ...source,
        meta: {
          ...source.meta,
          id: `art_seed_${item.name.replaceAll("-", "_")}`,
        },
        origin: {
          actorKind: "skill",
          actorId: "mimic.fixture.producer",
          runId,
          createdAt: at,
        },
        lifecycle: { status: "provisional", freshness: "valid" },
        approval: { status: "pending" },
        dependencies: [],
      };
      await runtime.artifacts.create(artifact);
      await runtime.registry.produce({
        runId,
        ref: ref(artifact),
        inputs: [],
        actor: { kind: "skill", id: "mimic.fixture.producer" },
        at,
        reason: "Fixture input",
      });
      seeded.push(artifact);
    }
    await runtime.registry.setWork({
      runId,
      safeActions: blockedTask ? ["target", "blocked"] : ["target"],
      blockers: {},
      actor: { kind: "agent", id: "agent_1" },
      at,
      reason: "Inputs ready",
    });
    const graph =
      slug === directories[1]
        ? fixture<DesignKnowledgeGraph>(skill.tests["tests/graph.json"]!)
        : undefined;
    const work = await runSkillPackage({
      orchestrator: runtime.orchestrator,
      package: skill,
      runId,
      tasks,
      taskId: "target",
      at,
      executor: async ({ invocation, inputs, gaps }) => {
        expect(inputs.map((input) => input.ref)).toEqual(invocation.inputRefs);
        expect(inputs.map((input) => input.name)).toEqual(
          artifactNeeds.map((item) => item.name),
        );
        expect(gaps).toContain(
          slug === directories[0] ? "journey" : "experience-domain",
        );
        const example = fixture<ArtifactSnapshot>(
          skill.examples[
            slug === directories[0]
              ? "examples/profile.json"
              : "examples/selection.json"
          ]!,
        );
        const profile = inputs.find(
          (input) => input.artifact.meta.type === "problem-profile",
        )?.artifact;
        const traitIds =
          graph && profile
            ? profileTraitIds(
                graph,
                (profile.content as { traits: string[] }).traits,
              )
            : [];
        const contract = inputs.find(
          (input) => input.artifact.meta.type === "product-ui-contract",
        )?.artifact;
        const projection =
          graph && contract
            ? referenceSelectionFromRetrieval(
                retrieveDesignReferences(graph, {
                  ...request,
                  traitIds,
                  assessments: boundedAssessments(contract),
                }),
              )
            : undefined;
        const sourceRefs = new Map([
          [
            "art_user_task@1",
            inputs.find((input) => input.name === "user-task-model"),
          ],
          [
            "art_ui_contract@1",
            inputs.find((input) => input.name === "product-ui-contract"),
          ],
          [
            "art_domain@1",
            inputs.find((input) => input.name === "experience-domain"),
          ],
        ]);
        const profileProvenance = projection
          ? example.provenance
          : example.provenance.map((entry) =>
              entry.kind === "derived"
                ? {
                    ...entry,
                    inputRefs: (entry.inputRefs as string[]).map((label) => {
                      const input = sourceRefs.get(label);
                      if (!input)
                        throw new Error(`Unbound profile provenance: ${label}`);
                      return exactInput(input);
                    }),
                  }
                : entry,
            );
        const output: ArtifactSnapshot = {
          ...example,
          meta: { ...example.meta, id: `art_output_${slug.slice(0, 3)}` },
          origin: {
            actorKind: "skill",
            actorId: skill.manifest.skillId,
            runId,
            createdAt: at,
          },
          dependencies: inputs.map((input) => ({
            ...input.ref,
            onChange: "validate" as const,
          })),
          ...(projection
            ? { content: projection.content, provenance: projection.provenance }
            : { provenance: profileProvenance }),
        };
        await runtime.artifacts.create(output);
        return {
          result: {
            runId: invocation.runId,
            taskId: invocation.taskId,
            skillId: invocation.skillId,
            inputRefs: invocation.inputRefs,
            outputRefs: [ref(output)],
          },
        };
      },
    });
    expect(work.result.inputRefs).toEqual(seeded.map(ref));
    expect(work.result.outputRefs).toHaveLength(1);
    const stored = await runtime.artifacts.read(
      work.result.outputRefs[0]!.artifactId,
      1,
    );
    expect(
      stored.artifact.dependencies.map(
        ({ artifactId, revision, lockDigest }) => ({
          artifactId,
          revision,
          lockDigest,
        }),
      ),
    ).toEqual(seeded.map(ref));
    expect((await runtime.registry.run(runId)).run.artifacts).toContainEqual(
      work.result.outputRefs[0],
    );
    if (slug === directories[0]) {
      const exactSources = new Set(
        seeded.map(
          (artifact) =>
            `${artifact.meta.id}@${artifact.meta.revision}#${ref(artifact).lockDigest}`,
        ),
      );
      for (const entry of stored.artifact.provenance.filter(
        (entry) => entry.kind === "derived",
      )) {
        const refs = entry.inputRefs as string[];
        expect(refs.length).toBeGreaterThan(0);
        for (const source of refs) expect(exactSources.has(source)).toBe(true);
      }
    }
    if (blockedTask && graph) {
      const artifactCountBefore = (await runtime.registry.run(runId)).run
        .artifacts.length;
      const blocked = await runSkillPackage({
        orchestrator: runtime.orchestrator,
        package: skill,
        runId,
        tasks,
        taskId: "blocked",
        at,
        executor: async ({ invocation, inputs }) => {
          const profile = inputs.find(
            (input) => input.name === "problem-profile",
          )!.artifact;
          const result = retrieveDesignReferences(graph, {
            traitIds: profileTraitIds(
              graph,
              (profile.content as { traits: string[] }).traits,
            ),
            assessments: assessments.map((item) => ({
              ...item,
              structuralFit: "low" as const,
              role: "far" as const,
            })),
          });
          if (result.status !== "blocked")
            throw new Error("Expected blocked graph retrieval");
          return {
            result: {
              runId: invocation.runId,
              taskId: invocation.taskId,
              skillId: invocation.skillId,
              inputRefs: invocation.inputRefs,
              outputRefs: [],
              blocked: {
                reason: result.reason,
                affectedTaskIds: [invocation.taskId],
              },
            },
          };
        },
      });
      expect(blocked.result.outputRefs).toEqual([]);
      expect((await runtime.registry.run(runId)).run.artifacts).toHaveLength(
        artifactCountBefore,
      );
      expect((await runtime.registry.run(runId)).run.blockers.blocked).toBe(
        "no-defensible-candidate",
      );
    }
    const wrong = {
      ...stored.artifact,
      meta: { ...stored.artifact.meta, id: `art_bad_${slug.slice(0, 3)}` },
      dependencies: [
        {
          ...stored.artifact.dependencies[0]!,
          lockDigest: "sha256:" + "0".repeat(64),
        },
      ],
    };
    await expect(runtime.artifacts.create(wrong)).rejects.toThrow(
      "Dependency lock digest mismatch",
    );
  });

test("S08 router reports the exact missing Product UI Contract", async () => {
  const skill = await loadSkillPackage(
    path.join(repository, "skills", directories[0]),
    schemaRoot,
  );
  const schemas = await loadSchemaDirectory(path.join(schemaRoot, "artifacts"));
  const root = await mkdtemp(
    path.join(os.tmpdir(), "mimic-s08-missing-contract-"),
  );
  temporary.push(root);
  const runtime = createOrchestratorRuntime(
    new FileWorkspaceStorage(path.join(root, "workspace.json")),
    schemas,
    scopes,
    {
      async verify() {
        return false;
      },
      async allowCommit() {
        return false;
      },
    },
  );
  const target = exactTask(skill);
  const seedTypes = ["user-task-model", "experience-domain"];
  const tasks: RoutedTask[] = [
    ...seedTypes.map((type) => ({
      id: `seed-${type}`,
      skillId: "mimic.fixture.producer",
      outputType: type,
      scopeOwnerId: "product_mimic",
      intent: "create" as const,
      authority: "AUTONOMOUS" as const,
      inputs: { required: [], optional: [], alternatives: [] },
    })),
    target,
  ];
  const runId = "run_s08_missing";
  await runtime.orchestrator.start({
    id: runId,
    scopeOwnerId: "product_mimic",
    entryMode: "hybrid",
    actor: { kind: "agent", id: "agent_1" },
    at,
    tasks,
  });
  for (const type of seedTypes) {
    const source = fixture<ArtifactSnapshot>(
      await readFile(
        path.join(
          repository,
          type === "user-task-model"
            ? "fixtures/artifacts/valid/user-task-model.json"
            : "skills/s07-experience-architecture/examples/candidate.json",
        ),
        "utf8",
      ),
    );
    const artifact: ArtifactSnapshot = {
      ...source,
      meta: { ...source.meta, id: `art_missing_${type.replaceAll("-", "_")}` },
      origin: {
        actorKind: "skill",
        actorId: "mimic.fixture.producer",
        runId,
        createdAt: at,
      },
      lifecycle: { status: "provisional", freshness: "valid" },
      approval: { status: "pending" },
      dependencies: [],
    };
    await runtime.artifacts.create(artifact);
    await runtime.registry.produce({
      runId,
      ref: ref(artifact),
      inputs: [],
      actor: { kind: "skill", id: "mimic.fixture.producer" },
      at,
      reason: "Fixture input",
    });
  }
  const action = (await runtime.orchestrator.next(runId, tasks)).actions.find(
    (item) => item.taskId === "target",
  );
  const caseData = fixture<{ scenarios: { id: string; reason?: string }[] }>(
    skill.tests["tests/scenarios.json"]!,
  ).scenarios.find((item) => item.id === "missing-contract");
  expect(action?.action).toBe("BLOCK");
  expect(action?.reason).toBe(caseData?.reason);
});
