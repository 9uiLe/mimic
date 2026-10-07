import type {
  PrototypeBuilderInput,
  PrototypeNode,
} from "../../packages/core/src/prototype-builder/index.js";
import type { PrototypeJourneyInput } from "../../packages/core/src/prototype-journey/index.js";
import type { setupExperienceFirst } from "../dogfood/experience-first/setup.js";

type Fixture = Awaited<ReturnType<typeof setupExperienceFirst>>;
const button = (
  id: string,
  text: string,
  componentId: string,
): PrototypeNode => ({ tag: "button", id, text, componentId });

export function authoredJourneyPlan(fixture: Fixture): PrototypeJourneyInput {
  const componentId = fixture.input.selection.components[0]!.artifactId;
  const queueSuccess: PrototypeNode = {
    tag: "main",
    id: "queue-root",
    children: [
      {
        tag: "section",
        id: "queue-tools",
        children: [
          { tag: "h2", text: "Case queue" },
          {
            tag: "p",
            text: "Synthetic cases. Filter by status before choosing a case.",
          },
          {
            tag: "input",
            id: "queue-filter",
            inputKind: "search",
            ariaLabel: "Filter cases by status",
          },
        ],
      },
      {
        tag: "section",
        id: "queue-cases",
        children: [
          { tag: "h2", text: "Matching cases" },
          {
            tag: "article",
            id: "row-c204",
            children: [
              { tag: "h3", text: "C-204 · Riverside intake" },
              { tag: "p", text: "needs-review · uncommitted" },
              button("open-c204", "Open C-204", componentId),
            ],
          },
          {
            tag: "article",
            id: "row-c205",
            children: [
              { tag: "h3", text: "C-205 · Market intake" },
              { tag: "p", text: "needs-review · uncommitted" },
              button("open-c205", "Open C-205", componentId),
            ],
          },
          {
            tag: "article",
            id: "row-c206",
            children: [
              { tag: "h3", text: "C-206 · Closed intake" },
              { tag: "p", text: "complete · uncommitted" },
              button("open-c206", "Open C-206", componentId),
            ],
          },
          { tag: "p", id: "queue-no-results", text: "No matching cases" },
          {
            tag: "button",
            id: "queue-show-error",
            componentId,
            text: "Show queue error",
            targetState: "error",
          },
        ],
      },
    ],
  };
  const { responsive: _reviewResponsive, ...baseInput } = fixture.input;
  const neutralReviewText = (text: string): string =>
    text
      .replaceAll("Case C-204", "Selected case")
      .replaceAll("C-204 ·", "Case review ·")
      .replaceAll("for C-204", "for the selected case");
  const neutralReviewNode = (node: PrototypeNode): PrototypeNode => ({
    ...node,
    ...(node.text ? { text: neutralReviewText(node.text) } : {}),
    ...(node.children
      ? { children: node.children.map(neutralReviewNode) }
      : {}),
  });
  const queue: PrototypeBuilderInput = {
    ...baseInput,
    scenario: fixture.queueScenario.ref,
    title: "Synthetic case queue",
    initialState: "success",
    requiredStates: ["success", "error"],
    states: [
      { name: "success", root: queueSuccess },
      {
        name: "error",
        root: {
          tag: "main",
          children: [
            {
              tag: "section",
              children: [
                { tag: "h2", text: "Queue error" },
                { tag: "p", text: "Synthetic queue recovery is available" },
                {
                  tag: "button",
                  componentId,
                  text: "Show success",
                  targetState: "success",
                },
              ],
            },
          ],
        },
      },
    ],
    fixtures: { success: {}, error: {} },
    outputPath: "queue-view",
  };
  const review: PrototypeBuilderInput = {
    ...fixture.input,
    title: "Synthetic case review",
    initialState: "success",
    states: fixture.input.states.map((state) => {
      if (state.name !== "success")
        return {
          ...state,
          root: {
            ...neutralReviewNode(state.root),
            children: [
              ...(state.root.children ?? []).map(neutralReviewNode),
              {
                tag: "section",
                children: [
                  { tag: "h2", text: "Return context" },
                  button(
                    "return-" + state.name,
                    "Return to filtered queue",
                    componentId,
                  ),
                ],
              },
            ],
          },
        };
      return {
        ...state,
        root: {
          ...neutralReviewNode(state.root),
          children: (state.root.children ?? []).map((source) => {
            const child = neutralReviewNode(source);
            if (child.id !== "review-decision") return child;
            return {
              ...child,
              children: [
                ...(child.children ?? []),
                {
                  tag: "input",
                  id: "draft-note",
                  inputKind: "text",
                  ariaLabel: "Uncommitted review draft",
                },
                { tag: "p", id: "draft-preview", text: "Draft preview" },
                { tag: "p", text: "Approval status" },
                { tag: "p", id: "approval-state", text: "pending" },
                { tag: "p", text: "Committed decision" },
                { tag: "p", id: "decision-state", text: "none" },
                button("discard-note", "Discard draft", componentId),
                button(
                  "return-success",
                  "Return to filtered queue",
                  componentId,
                ),
              ],
            };
          }),
        },
      };
    }),
    responsive: {
      ...fixture.input.responsive!,
      states: fixture.input.responsive!.states.map((entry) => ({
        ...entry,
        operations: entry.operations.map((operation) =>
          operation.kind === "replace"
            ? { ...operation, with: neutralReviewNode(operation.with) }
            : operation,
        ),
      })),
    },
    outputPath: "review-view",
  };
  return {
    version: 1,
    contract: fixture.contract.ref,
    journey: fixture.journey.ref,
    views: [
      {
        id: "queue",
        route: "#queue",
        domainId: "queue",
        domain: fixture.domains[0]!.ref,
        render: queue,
      },
      {
        id: "review",
        route: "#review",
        domainId: "review",
        domain: fixture.domains[1]!.ref,
        render: review,
      },
    ],
    initialViewId: "queue",
    initialEntityId: null,
    filterField: "status",
    initialFilter: "",
    filterEmpty: { viewId: "queue", nodeId: "queue-no-results" },
    draftFields: ["note"],
    entities: [
      {
        id: "C-204",
        fields: {
          status: "needs-review",
          title: "Riverside intake",
          approvalStatus: "pending",
          committedDecision: "none",
        },
        drafts: { note: "" },
      },
      {
        id: "C-205",
        fields: {
          status: "needs-review",
          title: "Market intake",
          approvalStatus: "pending",
          committedDecision: "none",
        },
        drafts: { note: "" },
      },
      {
        id: "C-206",
        fields: {
          status: "complete",
          title: "Closed intake",
          approvalStatus: "pending",
          committedDecision: "none",
        },
        drafts: { note: "" },
      },
    ],
    controls: [
      {
        viewId: "queue",
        nodeId: "queue-filter",
        action: { kind: "set-filter", field: "status" },
      },
      ...(["C-204", "C-205", "C-206"] as const).map((entityId) => ({
        viewId: "queue",
        nodeId: "open-" + entityId.toLowerCase().replace("-", ""),
        action: {
          kind: "select" as const,
          entityId,
          viewId: "review",
          returnFocusId: "queue-filter",
        },
      })),
      {
        viewId: "review",
        nodeId: "draft-note",
        action: { kind: "edit-draft", field: "note" },
      },
      {
        viewId: "review",
        nodeId: "discard-note",
        action: { kind: "discard-draft" },
      },
      ...review.requiredStates.map((state) => ({
        viewId: "review",
        nodeId: "return-" + state,
        action: { kind: "return" as const },
      })),
    ],
    rows: [
      { viewId: "queue", nodeId: "row-c204", entityId: "C-204" },
      { viewId: "queue", nodeId: "row-c205", entityId: "C-205" },
      { viewId: "queue", nodeId: "row-c206", entityId: "C-206" },
    ],
    texts: [
      {
        viewId: "review",
        nodeId: "case-identity",
        source: "selected-field",
        field: "id",
      },
      {
        viewId: "review",
        nodeId: "mobile-case-identity",
        source: "selected-field",
        field: "id",
      },
      {
        viewId: "review",
        nodeId: "draft-preview",
        source: "selected-draft",
        field: "note",
      },
      {
        viewId: "review",
        nodeId: "approval-state",
        source: "selected-field",
        field: "approvalStatus",
      },
      {
        viewId: "review",
        nodeId: "decision-state",
        source: "selected-field",
        field: "committedDecision",
      },
    ],
    retention: {
      filter: "session",
      drafts: "per-entity-until-discard",
      returnContext: "source-view-and-focus",
      status: "per-view",
    },
    outputPath: "journey-generated",
  };
}

/** A valid alternate mobile return control used to verify DOM replacement lifecycle. */
export function authoredReplacementReturnPlan(
  source: PrototypeJourneyInput,
): PrototypeJourneyInput {
  return {
    ...source,
    outputPath: "journey-replacement",
    views: source.views.map((view) =>
      view.id !== "review"
        ? view
        : {
            ...view,
            render: {
              ...view.render,
              states: view.render.states.map((state) =>
                state.name !== "success"
                  ? state
                  : {
                      ...state,
                      root: {
                        ...state.root,
                        children: state.root.children?.map((node) =>
                          node.id !== "review-decision"
                            ? node
                            : {
                                ...node,
                                children: [
                                  ...(node.children ?? []),
                                  {
                                    tag: "button" as const,
                                    id: "second-show-error",
                                    componentId:
                                      view.render.selection.components[0]!
                                        .artifactId,
                                    text: "Show error again",
                                    targetState: "error" as const,
                                  },
                                ],
                              },
                        ),
                      },
                    },
              ),
              responsive: {
                ...view.render.responsive!,
                states: view.render.responsive!.states.map((entry) =>
                  entry.state !== "success"
                    ? entry
                    : {
                        ...entry,
                        operations: [
                          ...entry.operations,
                          {
                            kind: "replace" as const,
                            targetId: "return-success",
                            with: {
                              tag: "button" as const,
                              id: "return-mobile",
                              componentId:
                                view.render.selection.components[0]!.artifactId,
                              text: "Return to filtered queue",
                            },
                            focusMap: [
                              {
                                desktopId: "return-success",
                                mobileId: "return-mobile",
                              },
                            ],
                          },
                        ],
                      },
                ),
              },
            },
          },
    ),
    controls: [
      ...source.controls,
      {
        viewId: "review",
        nodeId: "return-mobile",
        action: { kind: "return" },
      },
    ],
  };
}

/** Exercise alternate filter feedback and a filtered entity row on the mobile surface. */
export function authoredReplacementSurfacePlan(
  original: PrototypeJourneyInput,
): PrototypeJourneyInput {
  const source = authoredReplacementReturnPlan(original);
  const queue = source.views.find((view) => view.id === "queue")!;
  const componentId = queue.render.selection.components[0]!.artifactId;
  const mobileRow: PrototypeNode = {
    tag: "article",
    id: "mobile-row-c204",
    children: [
      { tag: "h3", text: "C-204 · Riverside intake" },
      { tag: "p", text: "needs-review · uncommitted" },
      button("mobile-open-c204", "Open C-204", componentId),
    ],
  };
  return {
    ...source,
    outputPath: "journey-surface-replacement",
    filterEmpty: {
      ...source.filterEmpty,
      mobileNodeId: "mobile-no-results",
    },
    views: source.views.map((view) =>
      view.id !== "queue"
        ? view
        : {
            ...view,
            render: {
              ...view.render,
              responsive: {
                version: 1,
                states: [
                  {
                    state: "success",
                    rule: view.render.selection.responsiveRule,
                    rationale:
                      "Keep filter feedback and the selected case path on the mobile queue.",
                    continuity: {
                      entity: {
                        desktopId: "row-c204",
                        mobileId: "mobile-row-c204",
                      },
                      primaryAction: {
                        desktopId: "open-c204",
                        mobileId: "mobile-open-c204",
                      },
                      criticalInfo: [
                        { desktopId: "row-c205", mobileId: "row-c205" },
                      ],
                      returnPath: {
                        desktopId: "open-c204",
                        mobileId: "mobile-open-c204",
                      },
                    },
                    operations: [
                      {
                        kind: "replace" as const,
                        targetId: "row-c204",
                        with: mobileRow,
                        focusMap: [
                          {
                            desktopId: "open-c204",
                            mobileId: "mobile-open-c204",
                          },
                        ],
                      },
                      {
                        kind: "replace" as const,
                        targetId: "queue-no-results",
                        with: {
                          tag: "p" as const,
                          id: "mobile-no-results",
                          text: "No matching cases",
                        },
                        focusMap: [],
                      },
                    ],
                  },
                ],
              },
            },
          },
    ),
    controls: [
      ...source.controls.map((control) =>
        control.viewId === "queue" &&
        control.nodeId === "open-c204" &&
        control.action.kind === "select"
          ? {
              ...control,
              action: { ...control.action, returnFocusId: "open-c204" },
            }
          : control,
      ),
      {
        viewId: "queue",
        nodeId: "mobile-open-c204",
        action: {
          kind: "select",
          entityId: "C-204",
          viewId: "review",
          returnFocusId: "mobile-open-c204",
        },
      },
    ],
    rows: [
      ...source.rows,
      { viewId: "queue", nodeId: "mobile-row-c204", entityId: "C-204" },
    ],
  };
}
