import type { PrototypeBuilderInput } from "../prototype-builder/index.js";
import path from "node:path";

const STATES = new Set([
  "loading",
  "empty",
  "partial",
  "success",
  "error",
  "permission",
  "disabled",
]);
const TAGS = new Set([
  "main",
  "section",
  "article",
  "header",
  "nav",
  "h1",
  "h2",
  "h3",
  "p",
  "ul",
  "li",
  "span",
  "strong",
  "button",
  "a",
]);
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const safeText = (value: unknown): value is string =>
  typeof value === "string" &&
  !!value.trim() &&
  ![...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  });
const containedOutputPath = (value: unknown): value is string =>
  typeof value === "string" &&
  !!value &&
  !path.isAbsolute(value) &&
  !value.includes("\\") &&
  value
    .split("/")
    .every((segment) => !!segment && segment !== "." && segment !== "..");
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
  const onlyKeys = (
    source: Record<string, unknown>,
    allowed: readonly string[],
    at: string,
  ): void => {
    for (const key of Object.keys(source))
      if (!allowed.includes(key))
        errors.push(`${at}: unsupported field ${key}`);
  };
  onlyKeys(
    value,
    [
      "scenario",
      "selection",
      "tokenSources",
      "title",
      "initialState",
      "requiredStates",
      "states",
      "fixtures",
      "layout",
      "styleTokens",
      "outputPath",
    ],
    "plan",
  );
  if (!ref(value.scenario))
    errors.push("scenario must be an exact artifact reference");
  const selection = value.selection;
  if (record(selection))
    onlyKeys(
      selection,
      [
        "pattern",
        "layout",
        "components",
        "responsiveRule",
        "accessibilityRule",
      ],
      "selection",
    );
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
  if (!safeText(value.title)) errors.push("title must be nonempty safe text");
  if (!containedOutputPath(value.outputPath))
    errors.push("outputPath must be a contained relative directory");
  if (record(value.styleTokens))
    onlyKeys(value.styleTokens, ["foreground", "background"], "styleTokens");
  if (
    !record(value.styleTokens) ||
    !safeText(value.styleTokens.foreground) ||
    (value.styleTokens.background !== undefined &&
      !safeText(value.styleTokens.background))
  )
    errors.push("styleTokens must contain safe color token paths");
  if (record(value.layout))
    onlyKeys(
      value.layout,
      ["breakpointPx", "desktopColumns", "mobileColumns"],
      "layout",
    );
  if (
    !record(value.layout) ||
    !Number.isSafeInteger(value.layout.breakpointPx) ||
    Number(value.layout.breakpointPx) < 320 ||
    Number(value.layout.breakpointPx) > 1600 ||
    !Number.isSafeInteger(value.layout.desktopColumns) ||
    Number(value.layout.desktopColumns) < 1 ||
    Number(value.layout.desktopColumns) > 6 ||
    !Number.isSafeInteger(value.layout.mobileColumns) ||
    Number(value.layout.mobileColumns) < 1 ||
    Number(value.layout.mobileColumns) > 3
  )
    errors.push("layout must contain bounded breakpoint and column counts");
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
  if (record(value.fixtures) && Array.isArray(required))
    for (const state of required) {
      if (typeof state !== "string") continue;
      const fixture = value.fixtures[state];
      if (!record(fixture)) {
        errors.push(`fixtures.${state} must be a field-to-text map`);
        continue;
      }
      for (const [key, text] of Object.entries(fixture))
        if (!ID.test(key) || !safeText(text))
          errors.push(`fixtures.${state}.${key} must be safe text`);
    }
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
    const ids = new Set(["prototype-status"]);
    const fragments: string[] = [];
    const componentIds = new Set(
      record(selection) && Array.isArray(selection.components)
        ? selection.components
            .filter(ref)
            .map((item: Record<string, unknown>) => item.artifactId)
        : [],
    );
    const visit = (
      node: unknown,
      at: string,
      stateName: string,
      depth: number,
      interactiveAncestor: boolean,
    ): boolean => {
      if (
        !record(node) ||
        depth > 16 ||
        ++count > 1000 ||
        typeof node.tag !== "string"
      ) {
        errors.push(`${at} must be a bounded semantic node`);
        return false;
      }
      onlyKeys(
        node,
        [
          "tag",
          "id",
          "componentId",
          "text",
          "fixtureKey",
          "href",
          "targetState",
          "children",
        ],
        at,
      );
      if (!TAGS.has(node.tag))
        errors.push(`${at} has unsupported semantic tag ${node.tag}`);
      const interactive = node.tag === "button" || node.tag === "a";
      if (interactiveAncestor && interactive)
        errors.push(`${at} nests interactive controls`);
      if (node.id !== undefined) {
        if (
          typeof node.id !== "string" ||
          !ID.test(node.id) ||
          ids.has(node.id)
        )
          errors.push(`${at}.id must be safe and unique`);
        else ids.add(node.id);
      }
      if (node.componentId !== undefined && !componentIds.has(node.componentId))
        errors.push(`${at}.componentId must be a selected component`);
      if (node.tag === "button" && !node.componentId)
        errors.push(`${at} button needs a selected component`);
      if (node.text !== undefined && node.fixtureKey !== undefined)
        errors.push(`${at} cannot combine text and fixtureKey`);
      if (node.text !== undefined && !safeText(node.text))
        errors.push(`${at}.text must be safe text`);
      let label = safeText(node.text);
      if (node.fixtureKey !== undefined) {
        if (typeof node.fixtureKey !== "string" || !ID.test(node.fixtureKey))
          errors.push(`${at}.fixtureKey must be a safe field name`);
        const fixture = record(value.fixtures)
          ? value.fixtures[stateName]
          : undefined;
        const fixtureText =
          record(fixture) && typeof node.fixtureKey === "string"
            ? fixture[node.fixtureKey]
            : undefined;
        if (!safeText(fixtureText))
          errors.push(`${at}.fixtureKey must resolve to safe text`);
        else label = true;
      }
      if (
        node.tag === "button" &&
        (typeof node.targetState !== "string" ||
          !required.includes(node.targetState))
      )
        errors.push(`${at} button must target a required state`);
      if (node.targetState !== undefined && node.tag !== "button")
        errors.push(`${at} only a button may target a state`);
      if (
        node.href !== undefined &&
        (node.tag !== "a" ||
          typeof node.href !== "string" ||
          !/^#[A-Za-z][A-Za-z0-9_-]*$/.test(node.href))
      )
        errors.push(`${at}.href must be a local fragment on a link`);
      if (node.tag === "a" && !node.href)
        errors.push(`${at} link needs a local fragment`);
      if (node.tag === "a" && typeof node.href === "string")
        fragments.push(node.href.slice(1));
      if (node.children !== undefined && !Array.isArray(node.children)) {
        errors.push(`${at}.children must be an array`);
        return label;
      }
      for (const [index, child] of (node.children ?? []).entries())
        label =
          visit(
            child,
            `${at}.children[${index}]`,
            stateName,
            depth + 1,
            interactiveAncestor || interactive,
          ) || label;
      if ((interactive || /^h[123]$/.test(node.tag)) && !label)
        errors.push(`${at} needs a discernible text label`);
      return label;
    };
    for (const state of states) {
      onlyKeys(state, ["name", "root"], `state ${state.name}`);
      if (!record(state.root) || state.root.tag !== "main")
        errors.push(`state ${state.name} must have a main root`);
      visit(state.root, `state ${state.name}.root`, state.name, 0, false);
    }
    for (const fragment of fragments)
      if (!ids.has(fragment))
        errors.push(`fragment target ${fragment} is absent`);
  }
  return errors.length
    ? { errors }
    : { plan: value as unknown as PrototypeBuilderInput, errors };
}
