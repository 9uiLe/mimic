import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  artifactDigest,
  type JsonValue,
} from "../../../packages/core/src/artifact-canonical.js";
import {
  type ArtifactSnapshot,
  type ScopeNode,
} from "../../../packages/core/src/artifact-store.js";
import { createOrchestratorRuntime } from "../../../packages/core/src/orchestrator/router.js";
import {
  type PrototypeModePlan,
  type ModeBinding,
} from "../../../packages/core/src/prototype-modes/index.js";
import {
  type PrototypeBuilderInput,
  type PrototypeNode,
} from "../../../packages/core/src/prototype-builder/index.js";
import { type ExactArtifactRef } from "../../../packages/core/src/runtime-engines/dependency.js";
import { loadSchemaDirectory } from "../../../packages/core/src/schema-registry.js";
import { FileWorkspaceStorage } from "../../../packages/core/src/workspace-transaction.js";
import { setupApprovedPrototypeFixture } from "../../prototypes/approved.js";

const repository = path.resolve(import.meta.dirname, "../../..");
export const at = "2026-10-07T12:00:00Z";
export const agent = {
  kind: "agent" as const,
  id: "agent_system_first_fixture",
};
export const syntheticHuman = {
  kind: "human" as const,
  id: "synthetic_human_fixture",
};
const seedApproval = {
  status: "approved" as const,
  decisionId: "synthetic_seed",
  actorId: syntheticHuman.id,
  at,
};
const product: ScopeNode = {
  level: "product",
  ownerId: "product_riverbend",
  parentId: "org_riverbend",
};
const triage: ScopeNode = {
  level: "domain",
  ownerId: "domain_triage",
  parentId: product.ownerId,
};
const scopes: ScopeNode[] = [
  { level: "organization", ownerId: "org_riverbend" },
  product,
  triage,
  { level: "domain", ownerId: "domain_dispatch", parentId: product.ownerId },
];
export const exact = (artifact: ArtifactSnapshot): ExactArtifactRef => ({
  artifactId: artifact.meta.id,
  revision: artifact.meta.revision,
  lockDigest: artifactDigest(artifact),
});
const linked = (ref: ExactArtifactRef) =>
  `${ref.artifactId}@${ref.revision}#${ref.lockDigest}`;

export async function setupSystemFirst() {
  const base = await setupApprovedPrototypeFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "mimic-system-first-"));
  const story = JSON.parse(
    await readFile(path.join(import.meta.dirname, "case.json"), "utf8"),
  ) as {
    caseId: string;
    system: { evidence: { id: string }[]; sampleOrders: { id: string }[] };
    task: string;
    currentCapability: string;
    proposedCapability: string;
    contract: {
      navigation: string[];
      terminology: string[];
      entityContext: string[];
      accessibilityBaseline: string;
    };
    domains: {
      name: string;
      goal: string;
      interaction: string;
      time: string;
    }[];
    directions: { id: string; mechanism: string; risk: string }[];
    referenceSpace: {
      case: string;
      classification: string;
      structuralRelevance: string;
      contextDistance: string;
      mechanism: string;
    };
  };
  const schemas = await loadSchemaDirectory(
    path.join(repository, "schemas/artifacts"),
  );
  const workspace = new FileWorkspaceStorage(path.join(root, "workspace.json"));
  const runtime = createOrchestratorRuntime(
    workspace,
    schemas,
    scopes,
    {
      verify: async (record, proposal) =>
        record.actor.id === syntheticHuman.id &&
        record.output?.ref.artifactId === proposal.ref.artifactId,
      allowCommit: async () => true,
    },
    {
      verifyApproval: async (approval) =>
        approval.decisionId === seedApproval.decisionId &&
        approval.actorId === syntheticHuman.id,
      verifyDecision: async () => false,
    },
  );
  async function add(
    id: string,
    type: string,
    content: JsonValue,
    dependencies: ExactArtifactRef[] = [],
    options: {
      scope?: ScopeNode;
      status?: "approved" | "proposed";
      provenance?: ArtifactSnapshot["provenance"];
    } = {},
  ) {
    const status = options.status ?? "approved";
    const bare: ArtifactSnapshot = {
      meta: {
        id,
        type,
        schemaVersion: "1.0.0",
        revision: 1,
        title: id,
        createdAt: at,
      },
      scope: options.scope ?? product,
      lifecycle: { status, freshness: "valid" },
      origin: {
        actorKind: "agent",
        actorId: agent.id,
        runId: "run_system_first_fixture",
        createdAt: at,
      },
      dependencies: dependencies.map((ref) => ({
        ...ref,
        onChange: "validate" as const,
      })),
      approval: status === "approved" ? seedApproval : { status: "pending" },
      provenance: options.provenance ?? [
        {
          path: "/content",
          kind: "assumption",
          rationale: "Authored synthetic case; no field observation",
        },
      ],
      content,
    };
    const artifact =
      status === "approved"
        ? {
            ...bare,
            meta: { ...bare.meta, contentDigest: artifactDigest(bare) },
          }
        : bare;
    const saved = await runtime.artifacts.create(artifact);
    return {
      artifact,
      ref: {
        artifactId: id,
        revision: 1,
        lockDigest: saved.digest,
      } satisfies ExactArtifactRef,
    };
  }
  try {
    const assets = [];
    for (const ref of [
      base.refs.pattern,
      base.refs.layout,
      base.refs.component,
      base.refs.responsiveRule,
      base.refs.accessibilityRule,
      base.refs.token,
    ]) {
      const source = (await base.store.read(ref.artifactId, ref.revision))
        .artifact;
      const copy = await add(
        `art_rb_${source.meta.id.slice(4)}`,
        "design-system-asset",
        source.content,
      );
      assets.push(copy.ref);
    }
    const [
      pattern,
      layout,
      component,
      responsiveRule,
      accessibilityRule,
      token,
    ] = assets as [
      ExactArtifactRef,
      ExactArtifactRef,
      ExactArtifactRef,
      ExactArtifactRef,
      ExactArtifactRef,
      ExactArtifactRef,
    ];
    const current = await add(
      "art_rb_current_list",
      "system-capability",
      {
        summary: story.currentCapability,
        capabilityId: "work-order-list",
        availability: "current",
        description: story.currentCapability,
        supportingEvidence: [story.system.evidence[0]!.id],
      },
      [],
      {
        provenance: [
          {
            path: "/content/description",
            kind: "fact",
            evidenceRefs: [story.system.evidence[0]!.id],
          },
        ],
      },
    );
    const productDefinition = await add(
      "art_rb_product",
      "product-definition",
      {
        summary: "Synthetic water-leak repair dispatch desk",
        vision: "Make existing work-order decisions traceable",
        goals: [story.task],
        nonGoals: ["Automatic crew assignment", "Production deployment"],
      },
      [current.ref],
    );
    const users = await add(
      "art_rb_user_tasks",
      "user-task-model",
      {
        summary: "Dispatcher work-order triage",
        users: ["Repair dispatcher"],
        tasks: [story.task],
      },
      [productDefinition.ref],
    );
    const contract = await add(
      "art_rb_contract",
      "product-ui-contract",
      {
        summary:
          "Current list and detail navigation; comparison remains proposed",
        ...story.contract,
      },
      [current.ref, productDefinition.ref, users.ref],
      {
        provenance: [
          {
            path: "/content/summary",
            kind: "derived",
            inputRefs: [linked(current.ref), linked(users.ref)],
          },
        ],
      },
    );
    const domains = [];
    for (const entry of story.domains) {
      domains.push(
        await add(
          `art_rb_domain_${entry.name.toLowerCase()}`,
          "experience-domain",
          {
            summary: `${entry.name} domain for ${entry.goal}`,
            primaryGoal: entry.goal,
            interactionModel: entry.interaction,
            informationStructure:
              "Work-order ID, zone, severity, age, and assignment state",
            temporalBehavior: entry.time,
            riskModel:
              "Never mistake proposed comparison for current capability",
            sessionModel: "Return to the same work-order ID",
          },
          [contract.ref],
        ),
      );
    }
    const journey = await add(
      "art_rb_journey",
      "journey",
      {
        summary: "Triage to dispatch on one exact work order",
        domains: ["Triage", "Dispatch"],
        steps: [
          "Inspect queue and severity",
          "Open same work-order ID",
          "Assign a crew",
          "Return to queue",
        ],
        preservedContext: [
          "entity",
          "terminology",
          "navigation",
          "return-path",
          "state",
        ],
      },
      [contract.ref, ...domains.map((entry) => entry.ref)],
    );
    const profile = await add(
      "art_rb_profile",
      "problem-profile",
      {
        summary: "Risk-aware comparison and identity continuity",
        traits: [
          "Several orders compete for one crew",
          "Severity and age both matter",
          "Assignment is consequential",
        ],
        principles: [
          "Keep work-order identity persistent",
          "Show uncertainty before commitment",
        ],
        risks: [
          "A proposed comparison may look operational",
          "Mobile may hide assignment context",
        ],
      },
      [contract.ref, users.ref, domains[0]!.ref, journey.ref],
    );
    const references = await add(
      "art_rb_references",
      "reference-selection",
      {
        summary: "Transfer structure, not incident-domain visual details",
        references: [
          {
            reference: story.referenceSpace.case,
            classification: story.referenceSpace.classification,
            structuralRelevance: story.referenceSpace.structuralRelevance,
            contextDistance: story.referenceSpace.contextDistance,
            transferableMechanisms: [story.referenceSpace.mechanism],
          },
        ],
      },
      [profile.ref, contract.ref],
    );
    const directionA = await add(
      "art_rb_direction_queue",
      "design-direction",
      {
        summary: story.directions[0]!.id,
        principles: ["Preserve exact entity identity"],
        mechanisms: [story.directions[0]!.mechanism],
        selectionStatus: "candidate",
      },
      [profile.ref, contract.ref, references.ref],
    );
    const directionB = await add(
      "art_rb_direction_pair",
      "design-direction",
      {
        summary: story.directions[1]!.id,
        principles: ["Make competing priorities explicit"],
        mechanisms: [story.directions[1]!.mechanism],
        selectionStatus: "candidate",
      },
      [profile.ref, contract.ref, references.ref],
      { status: "proposed" },
    );
    const request = await add(
      "art_rb_compare_request",
      "system-request",
      {
        summary: "Comparison is absent from the constructed current inventory",
        changeType: "capability",
        request: story.proposedCapability,
        rationale:
          "A dispatcher needs explicit side-by-side evidence before choosing one order",
      },
      [contract.ref],
      {
        status: "proposed",
        provenance: [
          {
            path: "/content/request",
            kind: "derived",
            inputRefs: [linked(contract.ref)],
          },
        ],
      },
    );
    const proposed = await add(
      "art_rb_proposed_compare",
      "system-capability",
      {
        summary: story.proposedCapability,
        capabilityId: "work-order-compare",
        availability: "proposed",
        description: story.proposedCapability,
      },
      [request.ref],
      {
        status: "proposed",
        provenance: [
          {
            path: "/content/description",
            kind: "derived",
            inputRefs: [linked(request.ref)],
          },
        ],
      },
    );
    const scenario = await add(
      "art_rb_scenario",
      "scenario",
      {
        summary: "Synthetic work-order triage",
        actor: "Repair dispatcher",
        context: `Inspect ${story.system.sampleOrders[0]!.id} and ${story.system.sampleOrders[1]!.id} before assignment`,
        steps: [
          "Open work-order queue",
          "Inspect severity and age",
          "Keep work-order ID visible",
          "Choose one order for crew assignment",
        ],
        expectedOutcome:
          "Identify the work order for a crew without losing its ID",
      },
      [
        pattern,
        layout,
        component,
        responsiveRule,
        accessibilityRule,
        token,
        contract.ref,
        journey.ref,
      ],
      {
        scope: triage,
        provenance: [
          {
            path: "/content/steps",
            kind: "derived",
            inputRefs: [
              linked(pattern),
              linked(layout),
              linked(component),
              linked(contract.ref),
            ],
            rationale:
              "Task → pattern → layout → components; preserve list/detail entity context",
          },
        ],
      },
    );
    await runtime.registry.seedCanonical([
      current.ref,
      productDefinition.ref,
      users.ref,
      contract.ref,
      ...domains.map((entry) => entry.ref),
      journey.ref,
      profile.ref,
      references.ref,
      directionA.ref,
      scenario.ref,
      ...assets,
    ]);
    const states = base.input.states.map((state) => {
      const root = structuredClone(state.root) as PrototypeNode;
      const rewrite = (node: PrototypeNode): PrototypeNode => ({
        ...node,
        ...(node.text
          ? {
              text: node.text
                .replaceAll("candidate", "work order")
                .replaceAll("Candidate", "Work order")
                .replace(
                  "Synthetic work order A; uncertainty visible",
                  "WO-1042 · North · urgent · 3h · unassigned",
                ),
            }
          : {}),
        ...(node.componentId ? { componentId: component.artifactId } : {}),
        ...(node.children ? { children: node.children.map(rewrite) } : {}),
      });
      return { ...state, root: rewrite(root) };
    });
    const currentRender: PrototypeBuilderInput = {
      ...base.input,
      scenario: scenario.ref,
      selection: {
        pattern,
        layout,
        components: [component],
        responsiveRule,
        accessibilityRule,
      },
      tokenSources: [token],
      title: "Riverbend Repairs — synthetic work-order triage",
      states,
      fixtures: Object.fromEntries(
        Object.entries(base.input.fixtures).map(([name, values]) => [
          name,
          Object.fromEntries(
            Object.entries(values ?? {}).map(([key, value]) => [
              key,
              value
                .replaceAll("candidate", "work order")
                .replaceAll("Candidate", "Work order"),
            ]),
          ),
        ]),
      ),
      outputPath: "current",
    };
    const proposedRender: PrototypeBuilderInput = {
      ...currentRender,
      outputPath: "proposed",
      states: currentRender.states.map((state) =>
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
                      {
                        tag: "h2" as const,
                        text: "Proposed two-order inspection",
                      },
                      { tag: "p" as const, fixtureKey: "comparison" },
                      {
                        tag: "button" as const,
                        componentId: component.artifactId,
                        text: "Compare work orders",
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
        ...currentRender.fixtures,
        success: {
          ...currentRender.fixtures.success,
          comparison:
            "Synthetic WO-1042 and WO-1043 comparison; no endpoint implemented",
        },
      },
    };
    function bindings(
      render: PrototypeBuilderInput,
      proposal: boolean,
    ): ModeBinding[] {
      const out: ModeBinding[] = [];
      for (const state of render.states) {
        const visit = (node: PrototypeNode, nodePath: number[]) => {
          const proposedNode =
            proposal &&
            state.name === "success" &&
            nodePath[0] ===
              currentRender.states.find((entry) => entry.name === "success")!
                .root.children!.length;
          for (const field of [
            "text",
            "fixtureKey",
            "targetState",
            "href",
          ] as const)
            if (node[field] !== undefined)
              out.push({
                state: state.name,
                nodePath,
                field,
                choiceId: proposedNode ? "compare" : "list",
              });
          node.children?.forEach((child, index) =>
            visit(child, [...nodePath, index]),
          );
        };
        visit(state.root, []);
      }
      return out;
    }
    const modePlan: PrototypeModePlan = {
      contract: contract.ref,
      choices: [
        { id: "list", status: "current", capability: current.ref },
        {
          id: "compare",
          status: "proposed",
          capability: proposed.ref,
          systemRequest: request.ref,
        },
      ],
      currentUses: ["list"],
      proposedUses: ["list", "compare"],
      bindings: {
        current: bindings(currentRender, false),
        proposed: bindings(proposedRender, true),
      },
      decisionContext: { kind: "live", requests: [request.ref] },
      current: currentRender,
      proposed: proposedRender,
      comparisonPath: "comparison",
    };
    return {
      root,
      runtime,
      story,
      refs: {
        current: current.ref,
        product: productDefinition.ref,
        users: users.ref,
        contract: contract.ref,
        domains: domains.map((entry) => entry.ref),
        journey: journey.ref,
        profile: profile.ref,
        references: references.ref,
        directionA: directionA.ref,
        directionB: directionB.ref,
        request: request.ref,
        proposed: proposed.ref,
        scenario: scenario.ref,
        assets,
      },
      modePlan,
      close: async () => {
        await rm(root, { recursive: true, force: true });
      },
    };
  } finally {
    await rm(base.root, { recursive: true, force: true });
  }
}
