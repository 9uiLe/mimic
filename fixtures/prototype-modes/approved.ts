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
  ) {
    const bare: ArtifactSnapshot = {
      ...scenario,
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
      dependencies: [],
      provenance: [
        {
          path: "/content/summary",
          kind: "assumption",
          rationale: "Synthetic fixture only",
        },
      ],
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
  );
  const current = await add("art_mode_current", "system-capability", {
    summary: "Existing candidate list",
    capabilityId: "candidate-list",
    availability: "current",
    description: "List candidates",
    supportingEvidence: ["fixture:current-candidate-list"],
  });
  const requestStatus = options.requestStatus ?? "proposed";
  const request = await add(
    "art_mode_request",
    "system-request",
    {
      summary: "Synthetic comparison request",
      changeType: "capability",
      request: "Expose candidate comparison",
      rationale: "Support a design alternative",
    },
    requestStatus,
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
  );
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
    current: { ...base.input, outputPath: "current" },
    proposed: { ...base.input, outputPath: "proposed" },
    comparisonPath: "comparison",
  };
  return {
    ...base,
    store,
    modePlan,
    modeRefs: { contract, current, proposed, request },
  };
}
