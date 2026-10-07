import { readFile } from "node:fs/promises";
import path from "node:path";
import { artifactDigest } from "../../../packages/core/src/artifact-canonical.js";
import {
  ArtifactStore,
  FileSnapshotStorage,
  type ArtifactSnapshot,
  type ScopeNode,
} from "../../../packages/core/src/artifact-store.js";
import { loadSchemaDirectory } from "../../../packages/core/src/schema-registry.js";
import type { ExactArtifactRef } from "../../../packages/core/src/runtime-engines/dependency.js";
import { setupApprovedPrototypeFixture } from "../../prototypes/approved.js";
import { authoredExperiencePlan } from "./plan.js";

const repository = path.resolve(import.meta.dirname, "../../..");
const at = "2026-10-07T00:00:00Z";
const approval = {
  status: "approved" as const,
  decisionId: "decision_fixture",
  actorId: "human_fixture",
  at,
};
const organization = { level: "organization", ownerId: "org_9uile" } as const;
const product = {
  level: "product",
  ownerId: "product_mimic",
  parentId: "org_9uile",
} as const;
const queue = {
  level: "domain",
  ownerId: "domain_queue",
  parentId: "product_mimic",
} as const;
const review = {
  level: "domain",
  ownerId: "domain_review",
  parentId: "product_mimic",
} as const;
export const scopes: readonly ScopeNode[] = [
  organization,
  product,
  queue,
  review,
];
export const exact = (artifact: ArtifactSnapshot): ExactArtifactRef => ({
  artifactId: artifact.meta.id,
  revision: artifact.meta.revision,
  lockDigest: artifactDigest(artifact),
});

export async function setupExperienceFirst(
  options: { rejectedRequest?: boolean; withModes?: boolean } = {},
) {
  const base = await setupApprovedPrototypeFixture();
  const schema = await loadSchemaDirectory(
    path.join(repository, "schemas/artifacts"),
  );
  // Same snapshot storage as the prototype fixture; widened scope tree makes sibling
  // domains observable while ArtifactStore still rejects sibling-scope locks.
  const store = new ArtifactStore(
    new FileSnapshotStorage(path.join(base.root, "artifacts")),
    schema,
    scopes,
    {
      verifyApproval: async (item) =>
        (item.status === "approved" || item.status === "rejected") &&
        item.decisionId === approval.decisionId &&
        item.actorId === approval.actorId,
      verifyDecision: async (id) => id === approval.decisionId,
    },
  );
  const caseData = JSON.parse(
    await readFile(new URL("./case.json", import.meta.url), "utf8"),
  ) as {
    desiredBehavior: string;
    primaryGoal: string;
    domains: {
      id: string;
      primaryGoal: string;
      interactionModel: string;
      informationStructure: string;
      temporalBehavior: string;
      riskModel: string;
      sessionModel: string;
    }[];
    journey: {
      caseId: string;
      terminology: string;
      navigation: string;
      returnPath: string;
      draftState: string;
      steps: string[];
    };
  };
  const template = JSON.parse(
    await readFile(
      path.join(
        repository,
        "fixtures/artifacts/valid/design-system-asset.json",
      ),
      "utf8",
    ),
  ) as ArtifactSnapshot;
  async function add(
    id: string,
    type: string,
    scope: ScopeNode,
    content: ArtifactSnapshot["content"],
    dependencies: readonly ExactArtifactRef[] = [],
    provenance: ArtifactSnapshot["provenance"] = [
      {
        path: "/content",
        kind: "assumption",
        rationale: "Synthetic dogfood input; fixture authority only.",
      },
    ],
    status: "approved" | "proposed" | "rejected" = "approved",
  ) {
    const bare: ArtifactSnapshot = {
      ...template,
      meta: { ...template.meta, id, type, title: id, revision: 1 },
      scope,
      lifecycle: { status, freshness: "valid" },
      approval:
        status === "approved"
          ? approval
          : status === "rejected"
            ? { ...approval, status: "rejected" as const }
            : { status: "pending" as const },
      origin: {
        actorKind: "agent",
        actorId: "agent_dogfood",
        runId: "run_experience_fixture",
        createdAt: at,
      },
      dependencies: dependencies.map((ref) => ({
        ...ref,
        onChange: "validate",
      })),
      provenance,
      content,
    };
    const artifact: ArtifactSnapshot = {
      ...bare,
      meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
    };
    return {
      artifact,
      ref: exact(artifact),
      saved: await store.create(artifact),
    };
  }
  const productDefinition = await add(
    "art_exp_product",
    "product-definition",
    product,
    {
      summary: caseData.desiredBehavior,
      vision: "Keep case context during review",
      goals: [caseData.primaryGoal],
      nonGoals: ["Production decision execution"],
    },
  );
  const userTask = await add(
    "art_exp_task",
    "user-task-model",
    product,
    {
      summary: "Operator scans then assesses a case",
      users: ["Synthetic operator"],
      tasks: ["Find next case", "Assess evidence", "Return with context"],
    },
    [productDefinition.ref],
  );
  const currentCapability = options.withModes
    ? await add(
        "art_exp_current_case_context",
        "system-capability",
        product,
        {
          summary: "Synthetic local journey runtime behavior",
          capabilityId: "case-context",
          availability: "current",
          description:
            "Locally filter, select and return to synthetic cases while preserving uncommitted entity-keyed drafts and semantic status in this specification prototype",
          supportingEvidence: ["fixture:9UI-148-generated-browser-checks"],
        },
        [],
        [
          {
            path: "/content/description",
            kind: "fact",
            evidenceRefs: ["fixture:9UI-148-generated-browser-checks"],
          },
        ],
      )
    : undefined;
  const contract = await add(
    "art_exp_contract",
    "product-ui-contract",
    product,
    {
      summary: "Experience-first case context and explicit review boundary",
      navigation: ["Queue", "Review", caseData.journey.returnPath],
      terminology: [caseData.journey.terminology],
      entityContext: [caseData.journey.caseId, caseData.journey.draftState],
      accessibilityBaseline: "WCAG 2.2 AA",
    },
    currentCapability
      ? [productDefinition.ref, userTask.ref, currentCapability.ref]
      : [productDefinition.ref, userTask.ref],
    currentCapability
      ? [
          {
            path: "/content/summary",
            kind: "derived",
            inputRefs: [
              `${currentCapability.ref.artifactId}@${currentCapability.ref.revision}#${currentCapability.ref.lockDigest}`,
            ],
            rationale:
              "Synthetic current case context used by the shared Product UI Contract",
          },
        ]
      : undefined,
  );
  const request = options.withModes
    ? await add(
        "art_exp_proposed_request",
        "system-request",
        product,
        {
          summary: "Synthetic proposed review assist",
          changeType: "capability",
          request: "Preview noncommitting review assistance",
          rationale: "Keep a proposal separate from Current capability",
        },
        [contract.ref],
        [
          {
            path: "/content/request",
            kind: "derived",
            inputRefs: [
              `${contract.ref.artifactId}@${contract.ref.revision}#${contract.ref.lockDigest}`,
            ],
            rationale: "Proposal against the exact shared contract",
          },
        ],
        options.rejectedRequest ? "rejected" : "proposed",
      )
    : undefined;
  const proposedCapability = options.withModes
    ? await add(
        "art_exp_proposed_assist",
        "system-capability",
        product,
        {
          summary: "Synthetic proposed review assistance",
          capabilityId: "review-assist",
          availability: "proposed",
          description: "Local noncommitting review assistance preview",
        },
        [request!.ref],
        [
          {
            path: "/content/description",
            kind: "derived",
            inputRefs: [
              `${request!.ref.artifactId}@${request!.ref.revision}#${request!.ref.lockDigest}`,
            ],
            rationale: "Proposed capability from exact System Request",
          },
        ],
        "proposed",
      )
    : undefined;
  const domains = await Promise.all(
    caseData.domains.map((domain) =>
      add(
        `art_exp_${domain.id}`,
        "experience-domain",
        domain.id === "queue" ? queue : review,
        {
          summary: `${domain.primaryGoal}: ${domain.interactionModel}`,
          primaryGoal: domain.primaryGoal,
          interactionModel: domain.interactionModel,
          informationStructure: domain.informationStructure,
          temporalBehavior: domain.temporalBehavior,
          riskModel: domain.riskModel,
          sessionModel: domain.sessionModel,
        },
        [contract.ref],
      ),
    ),
  );
  const journey = await add(
    "art_exp_journey",
    "journey",
    product,
    {
      summary: caseData.desiredBehavior,
      domains: ["queue", "review"],
      steps: caseData.journey.steps,
      preservedContext: [
        "entity",
        "terminology",
        "navigation",
        "return-path",
        "state",
      ],
    },
    [contract.ref],
  );
  const orgAsset = await add(
    "art_exp_org_governance",
    "design-system-asset",
    organization,
    {
      summary: "Organization case identity policy",
      assetKind: "pattern",
      name: "Case identity",
      definition: { caseIdentity: caseData.journey.caseId, policy: "locked" },
      usageRules: ["Preserve case identity"],
      antiUsageRules: ["Never silently replace case identity"],
    },
  );
  const productAsset = await add(
    "art_exp_product_context",
    "design-system-asset",
    product,
    {
      summary: "Product review context",
      assetKind: "pattern",
      name: "Review context",
      definition: {
        parent: { ...orgAsset.ref },
        navigation: caseData.journey.navigation,
      },
      usageRules: ["Show return path"],
      antiUsageRules: ["Do not imply approval"],
    },
    [orgAsset.ref],
  );
  const domainAsset = await add(
    "art_exp_review_context",
    "design-system-asset",
    review,
    {
      summary: "Review domain context",
      assetKind: "pattern",
      name: "Review case context",
      definition: {
        parent: { ...productAsset.ref },
        caseIdentity: caseData.journey.caseId,
      },
      usageRules: ["Retain case identity and return path"],
      antiUsageRules: ["Do not commit decisions"],
    },
    [productAsset.ref],
  );
  const sourceRefs = [
    base.refs.pattern,
    base.refs.layout,
    base.refs.component,
    base.refs.responsiveRule,
    base.refs.accessibilityRule,
    base.refs.token,
  ];
  const scenario = await add(
    "art_exp_scenario",
    "scenario",
    review,
    {
      summary: caseData.desiredBehavior,
      actor: "Synthetic case operator",
      context: `Review ${caseData.journey.caseId} after filtering the queue`,
      steps: caseData.journey.steps,
      expectedOutcome: caseData.primaryGoal,
    },
    [
      ...sourceRefs,
      contract.ref,
      domains[1]!.ref,
      journey.ref,
      domainAsset.ref,
    ],
    [
      {
        path: "/content/steps",
        kind: "derived",
        inputRefs: sourceRefs
          .slice(0, 3)
          .map((ref) => `${ref.artifactId}@${ref.revision}#${ref.lockDigest}`),
        rationale:
          "Task → pattern → layout → component: case context precedes review actions",
      },
    ],
  );
  const queueScenario = await add(
    "art_exp_queue_scenario",
    "scenario",
    queue,
    {
      summary: "Filter the synthetic queue and select a case for review",
      actor: "Synthetic case operator",
      context: "Queue of uncommitted synthetic cases",
      steps: ["Filter cases", "Select one case", "Return to the same filter"],
      expectedOutcome: "Open an exact case without committing a decision",
    },
    [
      ...sourceRefs,
      contract.ref,
      domains[0]!.ref,
      journey.ref,
      productAsset.ref,
    ],
    [
      {
        path: "/content/steps",
        kind: "derived",
        inputRefs: sourceRefs
          .slice(0, 3)
          .map((ref) => `${ref.artifactId}@${ref.revision}#${ref.lockDigest}`),
        rationale:
          "Queue task → selected pattern → layout → component with exact composition links",
      },
    ],
  );
  const input = authoredExperiencePlan(
    base,
    scenario.ref,
    caseData.journey.caseId,
  );
  return {
    ...base,
    store,
    input,
    caseData,
    productDefinition,
    userTask,
    contract,
    domains,
    journey,
    orgAsset,
    productAsset,
    domainAsset,
    scenario,
    queueScenario,
    currentCapability,
    request,
    proposedCapability,
  };
}
