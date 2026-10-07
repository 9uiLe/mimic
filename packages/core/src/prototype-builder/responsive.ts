import type { ExactArtifactRef } from "../runtime-engines/dependency.js";
import type {
  PrototypeBuilderInput,
  PrototypeNode,
  PrototypeState,
} from "./index.js";

export interface ResponsiveIdentity {
  readonly desktopId: string;
  readonly mobileId: string;
}
export interface ResponsiveContinuity {
  readonly entity: ResponsiveIdentity;
  readonly primaryAction: ResponsiveIdentity;
  readonly criticalInfo: readonly ResponsiveIdentity[];
  readonly returnPath: ResponsiveIdentity;
}
export type ResponsiveOperation =
  | {
      readonly kind: "reorder";
      readonly parentId: string;
      readonly childIds: readonly string[];
    }
  | {
      readonly kind: "collapse" | "progressive-disclose";
      readonly targetId: string;
      readonly summary: string;
    }
  | {
      readonly kind: "replace";
      readonly targetId: string;
      readonly with: PrototypeNode;
      readonly focusMap: readonly ResponsiveIdentity[];
    };
export interface ResponsiveStatePlan {
  readonly state: PrototypeState;
  readonly rule: ExactArtifactRef;
  readonly rationale: string;
  /** Author-reviewed claims; structural validation cannot prove semantic equivalence. */
  readonly continuity: ResponsiveContinuity;
  readonly operations: readonly ResponsiveOperation[];
}
export interface ResponsivePlan {
  readonly version: 1;
  readonly states: readonly ResponsiveStatePlan[];
}

type Info = { node: PrototypeNode; parent?: string };
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
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
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const safeText = (value: unknown): value is string =>
  typeof value === "string" &&
  !!value.trim() &&
  ![...value].some((char) => {
    const n = char.charCodeAt(0);
    return n < 32 && n !== 9 && n !== 10 && n !== 13;
  });
function keys(
  value: Record<string, unknown>,
  allowed: string[],
  at: string,
  errors: string[],
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) errors.push(`${at}: unsupported ${key}`);
}
function collect(
  node: PrototypeNode,
  ids: Map<string, Info>,
  errors: string[],
  at: string,
  plan: PrototypeBuilderInput,
  state: PrototypeState,
  parent?: string,
  depth = 0,
  budget = { count: 0 },
  interactive = false,
): void {
  if (!record(node) || depth > 16 || ++budget.count > 1000) {
    errors.push(`${at}: invalid or unbounded node`);
    return;
  }
  keys(
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
    errors,
  );
  if (!TAGS.has(node.tag)) errors.push(`${at}: unsupported tag`);
  const action = node.tag === "a" || node.tag === "button";
  if (action && interactive) errors.push(`${at}: nested action`);
  if (node.id !== undefined) {
    if (typeof node.id !== "string" || !ID.test(node.id) || ids.has(node.id))
      errors.push(`${at}: unsafe or duplicate ID`);
    else ids.set(node.id, { node, parent });
  }
  if (
    node.componentId !== undefined &&
    !plan.selection.components.some(
      (ref) => ref.artifactId === node.componentId,
    )
  )
    errors.push(`${at}: unselected component`);
  if (node.tag === "button" && !node.componentId)
    errors.push(`${at}: button needs selected component`);
  if (node.text !== undefined && !safeText(node.text))
    errors.push(`${at}: unsafe text`);
  if (node.text !== undefined && node.fixtureKey !== undefined)
    errors.push(`${at}: text and fixture conflict`);
  if (
    node.fixtureKey !== undefined &&
    (typeof node.fixtureKey !== "string" ||
      !ID.test(node.fixtureKey) ||
      !safeText(plan.fixtures[state]?.[node.fixtureKey]))
  )
    errors.push(`${at}: unresolved fixture`);
  if (node.tag === "button" && !plan.requiredStates.includes(node.targetState!))
    errors.push(`${at}: invalid transition`);
  if (node.targetState !== undefined && node.tag !== "button")
    errors.push(`${at}: transition on non-button`);
  if (
    node.tag === "a" &&
    (typeof node.href !== "string" ||
      !/^#[A-Za-z][A-Za-z0-9_-]*$/.test(node.href))
  )
    errors.push(`${at}: invalid fragment`);
  if (node.href !== undefined && node.tag !== "a")
    errors.push(`${at}: fragment on non-link`);
  if (
    action &&
    !safeText(node.text) &&
    !(node.fixtureKey && safeText(plan.fixtures[state]?.[node.fixtureKey]))
  )
    errors.push(`${at}: action needs label`);
  if (node.children !== undefined && !Array.isArray(node.children)) {
    errors.push(`${at}: invalid children`);
    return;
  }
  node.children?.forEach((child, i) =>
    collect(
      child,
      ids,
      errors,
      `${at}/${i}`,
      plan,
      state,
      node.id ?? parent,
      depth + 1,
      budget,
      interactive || action,
    ),
  );
}
function inside(id: string, ancestor: string, ids: Map<string, Info>): boolean {
  for (
    let parent = ids.get(id)?.parent;
    parent;
    parent = ids.get(parent)?.parent
  )
    if (parent === ancestor) return true;
  return false;
}
function actionIds(
  node: PrototypeNode,
  at: string,
  errors: string[],
): string[] {
  const found: string[] = [];
  const visit = (current: PrototypeNode): void => {
    if (current.tag === "button" || current.tag === "a") {
      if (!current.id)
        errors.push(`${at}: every replaced action needs a stable ID`);
      else found.push(current.id);
    }
    current.children?.forEach(visit);
  };
  visit(node);
  return found;
}
function mapIdentity(
  value: unknown,
  at: string,
  errors: string[],
  desktop: Map<string, Info>,
  mobile: Map<string, Info>,
  action = false,
): void {
  if (!record(value)) {
    errors.push(`${at}: mapping required`);
    return;
  }
  keys(value, ["desktopId", "mobileId"], at, errors);
  if (
    typeof value.desktopId !== "string" ||
    typeof value.mobileId !== "string" ||
    !desktop.has(value.desktopId) ||
    !mobile.has(value.mobileId)
  ) {
    errors.push(`${at}: missing mapped node`);
    return;
  }
  if (
    action &&
    (!["button", "a"].includes(desktop.get(value.desktopId)!.node.tag) ||
      !["button", "a"].includes(mobile.get(value.mobileId)!.node.tag))
  )
    errors.push(`${at}: action mapping required`);
}
/** The same finite structural check is used by the builder and saved-plan gate. */
export function responsiveErrors(plan: PrototypeBuilderInput): string[] {
  const errors: string[] = [];
  const value = plan.responsive;
  if (value === undefined) return errors;
  if (!record(value)) return ["responsive must be an object"];
  keys(value, ["version", "states"], "responsive", errors);
  if (
    value.version !== 1 ||
    !Array.isArray(value.states) ||
    !value.states.length
  )
    return [...errors, "responsive needs version 1 and nonempty states"];
  const seen = new Set<string>();
  const allBaseIds = new Set<string>();
  const allReplacementIds = new Set<string>();
  const addBaseIds = (node: PrototypeNode): void => {
    if (node.id) allBaseIds.add(node.id);
    node.children?.forEach(addBaseIds);
  };
  plan.states.forEach((state) => addBaseIds(state.root));
  for (const entry of value.states) {
    if (!record(entry)) {
      errors.push("invalid responsive state");
      continue;
    }
    keys(
      entry,
      ["state", "rule", "rationale", "continuity", "operations"],
      "responsive state",
      errors,
    );
    if (
      typeof entry.state !== "string" ||
      !plan.requiredStates.includes(entry.state as PrototypeState) ||
      seen.has(entry.state)
    ) {
      errors.push("responsive state must uniquely name a required state");
      continue;
    }
    seen.add(entry.state);
    const state = entry.state as PrototypeState;
    const rule = entry.rule;
    const selected = plan.selection.responsiveRule;
    if (
      !record(rule) ||
      Object.keys(rule).length !== 3 ||
      rule.artifactId !== selected.artifactId ||
      rule.revision !== selected.revision ||
      rule.lockDigest !== selected.lockDigest
    )
      errors.push(`${state}: exact responsive rule mismatch`);
    if (!safeText(entry.rationale)) errors.push(`${state}: rationale required`);
    const root = plan.states.find((item) => item.name === state)?.root;
    if (!root) {
      errors.push(`${state}: missing base state`);
      continue;
    }
    const desktop = new Map<string, Info>();
    collect(root, desktop, errors, `${state}.root`, plan, state);
    const mobile = new Map(desktop);
    if (!Array.isArray(entry.operations) || !entry.operations.length) {
      errors.push(`${state}: operations required`);
      continue;
    }
    let phase = 0;
    const touched = new Set<string>();
    for (const [index, op] of entry.operations.entries()) {
      const at = `${state}.operations[${index}]`;
      if (!record(op)) {
        errors.push(`${at}: invalid operation`);
        continue;
      }
      const next =
        op.kind === "reorder"
          ? 0
          : op.kind === "collapse" || op.kind === "progressive-disclose"
            ? 1
            : op.kind === "replace"
              ? 2
              : -1;
      if (next < 0) {
        errors.push(`${at}: unsupported operation`);
        continue;
      }
      if (next < phase) errors.push(`${at}: operation phase out of order`);
      phase = next;
      const target = op.kind === "reorder" ? op.parentId : op.targetId;
      if (
        typeof target !== "string" ||
        !desktop.has(target) ||
        touched.has(target)
      )
        errors.push(`${at}: missing or duplicate target`);
      if (typeof target === "string") touched.add(target);
      if (op.kind === "reorder") {
        keys(op, ["kind", "parentId", "childIds"], at, errors);
        const children = desktop.get(String(op.parentId))?.node.children ?? [];
        if (
          !Array.isArray(op.childIds) ||
          children.some((child) => !child.id) ||
          children.length !== op.childIds.length ||
          new Set(op.childIds).size !== children.length ||
          children.some(
            (child) => !(op.childIds as string[]).includes(child.id!),
          )
        )
          errors.push(`${at}: order must include every direct child ID once`);
      } else if (op.kind === "collapse" || op.kind === "progressive-disclose") {
        keys(op, ["kind", "targetId", "summary"], at, errors);
        if (
          !safeText(op.summary) ||
          !["section", "article", "nav", "ul"].includes(
            desktop.get(String(op.targetId))?.node.tag ?? "",
          )
        )
          errors.push(`${at}: disclosure needs safe summary and group target`);
      } else {
        keys(op, ["kind", "targetId", "with", "focusMap"], at, errors);
        if (
          !record(op.with) ||
          typeof op.targetId !== "string" ||
          !desktop.has(op.targetId) ||
          op.targetId === root.id
        ) {
          errors.push(`${at}: replacement needs non-root subtree`);
          continue;
        }
        if (!mobile.has(op.targetId)) {
          errors.push(`${at}: replacement removes another operation target`);
          continue;
        }
        const replacement = new Map<string, Info>();
        collect(
          op.with as unknown as PrototypeNode,
          replacement,
          errors,
          `${at}.with`,
          plan,
          state,
        );
        if (op.with.tag === "main")
          errors.push(`${at}: replacement cannot introduce a main landmark`);
        if (!op.with.id || replacement.size === 0)
          errors.push(`${at}: replacement root needs ID`);
        for (const id of replacement.keys()) {
          if (allBaseIds.has(id) || allReplacementIds.has(id))
            errors.push(`${at}: replacement ID collides with another surface`);
          allReplacementIds.add(id);
        }
        if (
          [...touched].some(
            (id) =>
              id !== op.targetId && inside(id, op.targetId as string, desktop),
          )
        )
          errors.push(`${at}: replacement removes another operation target`);
        const removed = [...mobile.keys()].filter(
          (id) =>
            id === op.targetId || inside(id, op.targetId as string, mobile),
        );
        for (const id of removed) mobile.delete(id);
        for (const [id, info] of replacement) mobile.set(id, info);
        if (!Array.isArray(op.focusMap))
          errors.push(`${at}: focus map required`);
        else {
          const mappings = op.focusMap.filter(
            record,
          ) as unknown as ResponsiveIdentity[];
          if (mappings.length !== op.focusMap.length)
            errors.push(`${at}: invalid focus mapping`);
          if (
            new Set(mappings.map((m) => m.desktopId)).size !==
              mappings.length ||
            new Set(mappings.map((m) => m.mobileId)).size !== mappings.length
          )
            errors.push(`${at}: focus mappings must be one-to-one`);
          for (const mapping of op.focusMap)
            mapIdentity(
              mapping,
              `${at}.focusMap`,
              errors,
              desktop,
              replacement,
              true,
            );
          const oldActions = actionIds(
            desktop.get(op.targetId as string)!.node,
            at,
            errors,
          );
          const newActions = actionIds(
            op.with as unknown as PrototypeNode,
            at,
            errors,
          );
          for (const mapping of mappings)
            if (
              !oldActions.includes(mapping.desktopId) ||
              !newActions.includes(mapping.mobileId)
            )
              errors.push(`${at}: focus map reaches outside replacement`);
          if (
            oldActions.some(
              (id) => !mappings.some((m) => m.desktopId === id),
            ) ||
            newActions.some((id) => !mappings.some((m) => m.mobileId === id))
          )
            errors.push(`${at}: all action focus paths must be mapped`);
        }
      }
    }
    for (const info of mobile.values())
      if (
        info.node.tag === "a" &&
        info.node.href &&
        !mobile.has(info.node.href.slice(1))
      )
        errors.push(`${state}: mobile fragment target is absent`);
    const c = entry.continuity;
    if (!record(c)) {
      errors.push(`${state}: continuity required`);
      continue;
    }
    keys(
      c,
      ["entity", "primaryAction", "criticalInfo", "returnPath"],
      `${state}.continuity`,
      errors,
    );
    mapIdentity(c.entity, `${state}.entity`, errors, desktop, mobile);
    mapIdentity(
      c.primaryAction,
      `${state}.primaryAction`,
      errors,
      desktop,
      mobile,
      true,
    );
    mapIdentity(
      c.returnPath,
      `${state}.returnPath`,
      errors,
      desktop,
      mobile,
      true,
    );
    if (!Array.isArray(c.criticalInfo) || !c.criticalInfo.length)
      errors.push(`${state}: critical info mapping required`);
    else
      c.criticalInfo.forEach((mapping: unknown, i: number) =>
        mapIdentity(
          mapping,
          `${state}.criticalInfo[${i}]`,
          errors,
          desktop,
          mobile,
        ),
      );
  }
  return errors;
}
