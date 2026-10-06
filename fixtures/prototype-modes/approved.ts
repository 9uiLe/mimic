import path from "node:path";
import {
  artifactDigest,
  type JsonValue,
} from "../../packages/core/src/artifact-canonical.js";
import {
  ArtifactStore,
  FileSnapshotStorage,
  type ArtifactSnapshot,
} from "../../packages/core/src/artifact-store.js";
import { loadSchemaDirectory } from "../../packages/core/src/schema-registry.js";
import type { ExactArtifactRef } from "../../packages/core/src/runtime-engines/dependency.js";
import type {
  PrototypeModePlan,
  ModeChoiceStatus,
  ModeBinding,
} from "../../packages/core/src/prototype-modes/index.js";
import { setupApprovedPrototypeFixture } from "../prototypes/approved.js";

const approval = {
  status: "approved" as const,
  decisionId: "decision_fixture",
  actorId: "human_fixture",
  at: "2026-10-06T12:00:00Z",
};
const rejection = {
  status: "rejected" as const,
  decisionId: "decision_fixture",
  actorId: "human_fixture",
  at: "2026-10-06T12:00:00Z",
};

export async function setupPrototypeModesFixture(
  options: {
    choiceStatus?: ModeChoiceStatus;
    requestStatus?: "approved" | "proposed" | "rejected";
    capabilityStatus?: "approved" | "proposed" | "rejected";
    staleContract?: boolean;
    requestChangeType?: "capability" | "token";
    laterRejectedDecision?: boolean;
  } = {},
) {
  const base = await setupApprovedPrototypeFixture();
  const schema = await loadSchemaDirectory(
    path.resolve(import.meta.dirname, "../../schemas/artifacts"),
  );
  const store = new ArtifactStore(
    new FileSnapshotStorage(path.join(base.root, "artifacts")),
    schema,
    [
      { level: "organization", ownerId: "org_9uile" },
      { level: "product", ownerId: "product_mimic", parentId: "org_9uile" },
      { level: "product", ownerId: "product_other", parentId: "org_9uile" },
    ],
    {
      async verifyApproval(value) {
        return (
          (value.status === "approved" || value.status === "rejected") &&
          value.decisionId === "decision_fixture" &&
          value.actorId === "human_fixture"
        );
      },
      async verifyDecision() {
        return false;
      },
    },
  );
  const scenario = (await store.read(base.refs.scenario.artifactId, 1))
    .artifact;
  async function add(
    id: string,
    type: string,
    content: JsonValue,
    status: "approved" | "proposed" | "rejected" = "approved",
    stale = false,
    dependencies: ArtifactSnapshot["dependencies"] = [],
    scope = scenario.scope,
    provenance: ArtifactSnapshot["provenance"] = [
      {
        path: "/content/summary",
        kind: "assumption",
        rationale: "Synthetic fixture only",
      },
    ],
  ) {
    const bare: ArtifactSnapshot = {
      ...scenario,
      scope,
      meta: {
        id,
        type,
        schemaVersion: "1.0.0",
        revision: 1,
        title: id,
        createdAt: scenario.meta.createdAt,
      },
      lifecycle: stale
        ? { status, freshness: "stale", freshnessReason: "Superseded fixture" }
        : { status, freshness: "valid" },
      approval:
        status === "approved"
          ? approval
          : status === "rejected"
            ? rejection
            : { status: "pending" },
      dependencies,
      provenance,
      content,
    };
    const artifact =
      status === "proposed"
        ? bare
        : {
            ...bare,
            meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
          };
    const created = await store.create(artifact);
    return {
      artifactId: id,
      revision: 1,
      lockDigest: created.digest,
    } satisfies ExactArtifactRef;
  }
  const current = await add(
    "art_mode_current",
    "system-capability",
    {
      summary: "Existing candidate list",
      capabilityId: "candidate-list",
      availability: "current",
      description: "List candidates",
      supportingEvidence: ["fixture:current-candidate-list"],
    },
    "approved",
    false,
    [],
    scenario.scope,
    [
      {
        path: "/content/description",
        kind: "fact",
        evidenceRefs: ["fixture:current-candidate-list"],
      },
    ],
  );
  const otherProduct = await add(
    "art_mode_other_current",
    "system-capability",
    {
      summary: "Other product list",
      capabilityId: "candidate-list",
      availability: "current",
      description: "List candidates in another product",
      supportingEvidence: ["fixture:other-product-list"],
    },
    "approved",
    false,
    [],
    { level: "product", ownerId: "product_other", parentId: "org_9uile" },
    [
      {
        path: "/content/description",
        kind: "fact",
        evidenceRefs: ["fixture:other-product-list"],
      },
    ],
  );
  const contract = await add(
    "art_mode_contract",
    "product-ui-contract",
    {
      summary: "Synthetic comparison",
      navigation: ["Candidates"],
      terminology: ["Candidate"],
      entityContext: ["Candidate ID"],
      accessibilityBaseline: "WCAG 2.2 AA",
    },
    "approved",
    options.staleContract ?? false,
    [{ ...current, onChange: "validate" }],
    scenario.scope,
    [
      {
        path: "/content/summary",
        kind: "derived",
        inputRefs: [
          `${current.artifactId}@${current.revision}#${current.lockDigest}`,
        ],
      },
    ],
  );
  const requestStatus = options.requestStatus ?? "proposed";
  const request = await add(
    "art_mode_request",
    "system-request",
    {
      summary: "Synthetic comparison request",
      changeType: options.requestChangeType ?? "capability",
      request: "Expose candidate comparison",
      rationale: "Support a design alternative",
    },
    requestStatus,
    false,
    [{ ...contract, onChange: "validate" }],
    scenario.scope,
    [
      {
        path: "/content/request",
        kind: "derived",
        inputRefs: [
          `${contract.artifactId}@${contract.revision}#${contract.lockDigest}`,
        ],
      },
    ],
  );
  const unlinkedRequest = await add(
    "art_mode_unlinked_request",
    "system-request",
    {
      summary: "Unrelated capability request",
      changeType: "capability",
      request: "Add unrelated reporting action",
      rationale: "Different task",
    },
    "proposed",
    false,
    [{ ...contract, onChange: "validate" }],
    scenario.scope,
    [
      {
        path: "/content/request",
        kind: "derived",
        inputRefs: [
          `${contract.artifactId}@${contract.revision}#${contract.lockDigest}`,
        ],
      },
    ],
  );
  const proposed = await add(
    "art_mode_proposed",
    "system-capability",
    {
      summary: "Candidate comparison",
      capabilityId: "candidate-compare",
      availability: "proposed",
      description: "Compare candidates",
    },
    options.capabilityStatus ?? "proposed",
    false,
    [{ ...request, onChange: "validate" }],
    scenario.scope,
    [
      {
        path: "/content/description",
        kind: "derived",
        inputRefs: [
          `${request.artifactId}@${request.revision}#${request.lockDigest}`,
        ],
      },
    ],
  );
  let decisionRequest = request;
  if (options.laterRejectedDecision) {
    const requestSnapshot = (
      await store.read(request.artifactId, request.revision)
    ).artifact;
    const { contentDigest: _priorDigest, ...requestMeta } =
      requestSnapshot.meta;
    void _priorDigest;
    const rejected: ArtifactSnapshot = {
      ...requestSnapshot,
      meta: { ...requestMeta, revision: 2, supersedesRevision: 1 },
      lifecycle: { status: "rejected", freshness: "valid" },
      approval: rejection,
    };
    const created = await store.create({
      ...rejected,
      meta: { ...rejected.meta, contentDigest: artifactDigest(rejected) },
    });
    decisionRequest = {
      artifactId: request.artifactId,
      revision: 2,
      lockDigest: created.digest,
    };
  }
  const { contentDigest: _oldDigest, ...priorMeta } = scenario.meta;
  void _oldDigest;
  const revisedScenario: ArtifactSnapshot = {
    ...scenario,
    meta: { ...priorMeta, revision: 2, supersedesRevision: 1 },
    dependencies: [
      ...scenario.dependencies,
      { ...contract, onChange: "validate" },
    ],
  };
  const revised = await store.create({
    ...revisedScenario,
    meta: {
      ...revisedScenario.meta,
      contentDigest: artifactDigest(revisedScenario),
    },
  });
  const scenarioRef = {
    artifactId: scenario.meta.id,
    revision: 2,
    lockDigest: revised.digest,
  } satisfies ExactArtifactRef;
  const currentRender = {
    ...base.input,
    scenario: scenarioRef,
    outputPath: "current",
  };
  const proposedRender = {
    ...base.input,
    scenario: scenarioRef,
    outputPath: "proposed",
    states: base.input.states.map((state) =>
      state.name === "success"
        ? {
            ...state,
            root: {
              ...state.root,
              children: [
                ...(state.root.children ?? []),
                {
                  tag: "section" as const,
                  children: [
                    { tag: "h2" as const, text: "Proposed comparison" },
                    { tag: "p" as const, fixtureKey: "comparisonScore" },
                    {
                      tag: "button" as const,
                      componentId: base.refs.component.artifactId,
                      text: "Compare candidates",
                      targetState: "disabled" as const,
                    },
                  ],
                },
              ],
            },
          }
        : state,
    ),
    fixtures: {
      ...base.input.fixtures,
      success: {
        ...base.input.fixtures.success,
        comparisonScore: "Synthetic score 98",
      },
    },
  };
  function bindings(
    render: typeof currentRender,
    proposedMode: boolean,
  ): ModeBinding[] {
    const result: ModeBinding[] = [];
    for (const state of render.states) {
      const visit = (node: typeof state.root, nodePath: number[]) => {
        const choiceId =
          proposedMode &&
          state.name === "success" &&
          nodePath[0] ===
            (base.input.states.find((item) => item.name === "success")!.root
              .children?.length ?? 0)
            ? "candidateCompare"
            : "candidateList";
        for (const field of [
          "text",
          "fixtureKey",
          "targetState",
          "href",
        ] as const)
          if (node[field] !== undefined)
            result.push({ state: state.name, nodePath, field, choiceId });
        node.children?.forEach((child, index) =>
          visit(child, [...nodePath, index]),
        );
      };
      visit(state.root, []);
    }
    return result;
  }
  const modePlan: PrototypeModePlan = {
    contract,
    choices: [
      { id: "candidateList", status: "current", capability: current },
      {
        id: "candidateCompare",
        status: options.choiceStatus ?? "proposed",
        capability: proposed,
        systemRequest: request,
      },
    ],
    currentUses: ["candidateList"],
    proposedUses: ["candidateList", "candidateCompare"],
    bindings: {
      current: bindings(currentRender, false),
      proposed: bindings(proposedRender, true),
    },
    decisionContext: { kind: "live", requests: [decisionRequest] },
    current: currentRender,
    proposed: proposedRender,
    comparisonPath: "comparison",
  };
  return {
    ...base,
    store,
    modePlan,
    modeRefs: {
      contract,
      current,
      proposed,
      request,
      unlinkedRequest,
      otherProduct,
      scenario: scenarioRef,
    },
  };
}
