import type {
  PrototypeBuilderInput,
  PrototypeNode,
} from "../../packages/core/src/prototype-builder/index.js";
import type { PrototypeModePlan } from "../../packages/core/src/prototype-modes/index.js";

/** Bind each entire finite mobile operation to the same Current capability in both modes. */
export function withResponsiveMode(
  source: PrototypeModePlan,
): PrototypeModePlan {
  const adapt = (render: PrototypeBuilderInput): PrototypeBuilderInput => {
    const success = render.states.find((state) => state.name === "success")!;
    const [actions, context, ...rest] = success.root.children!;
    let actionIndex = 0;
    const newActions: PrototypeNode = {
      ...actions,
      id: "mode-actions",
      children: actions.children?.map((node) =>
        node.tag === "button"
          ? {
              ...node,
              id:
                actionIndex++ === 0
                  ? "mode-primary"
                  : actionIndex === 2
                    ? "mode-return"
                    : `mode-action-${actionIndex}`,
            }
          : node,
      ),
    };
    const newContext: PrototypeNode = {
      ...context,
      id: "mode-context",
      children: context.children?.map((node) =>
        node.tag === "p" ? { ...node, id: "mode-identity" } : node,
      ),
    };
    const same = (id: string) => ({ desktopId: id, mobileId: id });
    return {
      ...render,
      states: render.states.map((state) =>
        state.name === "success"
          ? {
              ...success,
              root: {
                ...success.root,
                id: "mode-success-root",
                children: [newActions, newContext, ...rest],
              },
            }
          : state,
      ),
      fixtures: {
        ...render.fixtures,
        success: {
          ...render.fixtures.success,
          mobileLabel: "Choose mobile candidate",
        },
      },
      responsive: {
        version: 1,
        states: [
          {
            state: "success",
            rule: render.selection.responsiveRule,
            rationale:
              "Named identity disclosure keeps the candidate and decision reachable on mobile.",
            continuity: {
              entity: same("mode-identity"),
              primaryAction: {
                desktopId: "mode-primary",
                mobileId: "mode-mobile-primary",
              },
              criticalInfo: [same("mode-identity")],
              returnPath: same("mode-return"),
            },
            operations: [
              {
                kind: "collapse",
                targetId: "mode-context",
                summary: "Candidate identity",
              },
              {
                kind: "replace",
                targetId: "mode-primary",
                with: {
                  tag: "button",
                  id: "mode-mobile-primary",
                  componentId: render.selection.components[0]!.artifactId,
                  fixtureKey: "mobileLabel",
                  targetState: "disabled",
                },
                focusMap: [
                  {
                    desktopId: "mode-primary",
                    mobileId: "mode-mobile-primary",
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  };
  const binding = (index: number) => ({
    state: "success" as const,
    nodePath: [],
    field: "responsiveOperation" as const,
    responsiveOperation: index,
    choiceId: "candidateList",
  });
  return {
    ...source,
    current: adapt(source.current),
    proposed: adapt(source.proposed),
    bindings: {
      current: [...source.bindings.current, binding(0), binding(1)],
      proposed: [...source.bindings.proposed, binding(0), binding(1)],
    },
  };
}
