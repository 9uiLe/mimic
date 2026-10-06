import type { PrototypeBuilderInput } from "../prototype-builder/index.js";

const STATES = new Set([
  "loading",
  "empty",
  "partial",
  "success",
  "error",
  "permission",
  "disabled",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const ref = (value: unknown): boolean =>
  record(value) &&
  /^art_[A-Za-z0-9_-]+$/.test(String(value.artifactId)) &&
  Number.isSafeInteger(value.revision) &&
  Number(value.revision) > 0 &&
  /^sha256:[0-9a-f]{64}$/.test(String(value.lockDigest));

/** Validate the runtime shape before any gate dereferences or iterates a saved plan. */
export function qualityPlan(value: unknown): {
  plan?: PrototypeBuilderInput;
  errors: string[];
} {
  const errors: string[] = [];
  if (!record(value)) return { errors: ["plan.json must contain an object"] };
  if (!ref(value.scenario))
    errors.push("scenario must be an exact artifact reference");
  const selection = value.selection;
  if (
    !record(selection) ||
    !Array.isArray(selection.components) ||
    !selection.components.length ||
    ![
      selection.pattern,
      selection.layout,
      selection.responsiveRule,
      selection.accessibilityRule,
      ...selection.components,
    ].every(ref)
  )
    errors.push(
      "selection must contain exact pattern, layout, component and rule references",
    );
  if (
    !Array.isArray(value.tokenSources) ||
    !value.tokenSources.length ||
    !value.tokenSources.every(ref)
  )
    errors.push("tokenSources must be a nonempty exact-reference list");
  if (
    !record(value.styleTokens) ||
    typeof value.styleTokens.foreground !== "string" ||
    !value.styleTokens.foreground
  )
    errors.push("styleTokens.foreground must be a nonempty token path");
  if (
    !record(value.layout) ||
    !Number.isSafeInteger(value.layout.breakpointPx) ||
    !Number.isSafeInteger(value.layout.desktopColumns) ||
    !Number.isSafeInteger(value.layout.mobileColumns)
  )
    errors.push("layout must contain numeric breakpoint and column counts");
  if (!record(value.fixtures))
    errors.push("fixtures must be a state-to-field map");
  const required = value.requiredStates;
  if (
    !Array.isArray(required) ||
    !required.length ||
    !required.includes("success") ||
    required.some((state) => typeof state !== "string" || !STATES.has(state)) ||
    new Set(required).size !== required.length
  ) {
    errors.push(
      "requiredStates must be nonempty, unique, supported, and include success",
    );
  }
  if (
    typeof value.initialState !== "string" ||
    !Array.isArray(required) ||
    !required.includes(value.initialState)
  )
    errors.push("initialState must be a required state");
  const states = value.states;
  if (
    !Array.isArray(states) ||
    !Array.isArray(required) ||
    states.length !== required.length ||
    states.some(
      (state) =>
        !record(state) ||
        typeof state.name !== "string" ||
        !required.includes(state.name),
    ) ||
    new Set(states.map((state) => (record(state) ? state.name : undefined)))
      .size !== states.length
  ) {
    errors.push("states must contain exactly one tree for each required state");
  } else {
    let count = 0;
    const visit = (node: unknown, at: string, depth: number): void => {
      if (
        !record(node) ||
        depth > 16 ||
        ++count > 1000 ||
        typeof node.tag !== "string"
      ) {
        errors.push(`${at} must be a bounded semantic node`);
        return;
      }
      if (
        node.tag === "button" &&
        (typeof node.targetState !== "string" ||
          !required.includes(node.targetState))
      )
        errors.push(`${at} button must target a required state`);
      if (node.children !== undefined && !Array.isArray(node.children)) {
        errors.push(`${at}.children must be an array`);
        return;
      }
      for (const [index, child] of (node.children ?? []).entries())
        visit(child, `${at}.children[${index}]`, depth + 1);
    };
    for (const state of states) {
      if (!record(state.root) || state.root.tag !== "main")
        errors.push(`state ${state.name} must have a main root`);
      visit(state.root, `state ${state.name}.root`, 0);
    }
  }
  return errors.length
    ? { errors }
    : { plan: value as unknown as PrototypeBuilderInput, errors };
}
