import { createHash } from "node:crypto";
import {
  canonicalJson,
  jsonCopy,
  type JsonValue,
} from "../artifact-canonical.js";
import type { ArtifactSnapshot, ArtifactStore } from "../artifact-store.js";
import type { ExactArtifactRef } from "../runtime-engines/dependency.js";
import {
  compilePrototypeBundle,
  type PrototypeBuilderInput,
  type PrototypeNode,
  type PrototypeState,
} from "../prototype-builder/index.js";
import {
  publishPrototypeBundle,
  PrototypeOutputError,
} from "../prototype-builder/output.js";
import { responsiveRuntime } from "../prototype-builder/runtime.js";

export type JourneyAction =
  | {
      readonly kind: "select";
      readonly entityId: string;
      readonly viewId: string;
      readonly returnFocusId: string;
    }
  | { readonly kind: "navigate"; readonly viewId: string }
  | { readonly kind: "return" }
  | { readonly kind: "set-filter"; readonly field: string }
  | { readonly kind: "edit-draft"; readonly field: string }
  | { readonly kind: "discard-draft" }
  | { readonly kind: "reset-draft" }
  | { readonly kind: "set-status"; readonly status: PrototypeState };
export interface JourneyView {
  readonly id: string;
  readonly route: string;
  readonly domainId: string;
  readonly domain: ExactArtifactRef;
  readonly render: PrototypeBuilderInput;
}
export interface JourneyEntity {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly drafts: Readonly<Record<string, string>>;
}
export interface JourneyControl {
  readonly viewId: string;
  readonly nodeId: string;
  readonly action: JourneyAction;
}
export interface JourneyRow {
  readonly viewId: string;
  readonly nodeId: string;
  readonly entityId: string;
}
export interface JourneyText {
  readonly viewId: string;
  readonly nodeId: string;
  readonly source: "selected-field" | "entity-field" | "selected-draft";
  readonly field: string;
  readonly entityId?: string;
}
/** Authored execution input. Its exact digest records intent; artifact approvals do not approve it. */
export interface PrototypeJourneyInput {
  readonly version: 1;
  readonly contract: ExactArtifactRef;
  readonly journey: ExactArtifactRef;
  readonly views: readonly JourneyView[];
  readonly initialViewId: string;
  readonly initialEntityId: string | null;
  readonly filterField: string;
  readonly initialFilter: string;
  readonly filterEmpty: { readonly viewId: string; readonly nodeId: string };
  readonly draftFields: readonly string[];
  readonly entities: readonly JourneyEntity[];
  readonly controls: readonly JourneyControl[];
  readonly rows: readonly JourneyRow[];
  readonly texts: readonly JourneyText[];
  readonly retention: {
    readonly filter: "session";
    readonly drafts: "per-entity-until-discard";
    readonly returnContext: "source-view-and-focus";
    readonly status: "per-view";
  };
  readonly outputPath: string;
}
export interface PrototypeJourneyResult {
  readonly directory: string;
  readonly planDigest: string;
  readonly files: readonly string[];
}
export class PrototypeJourneyError extends Error {
  constructor(
    readonly code: "INVALID" | "INTEGRITY" | "UNAPPROVED" | "PATH",
    message: string,
  ) {
    super(message);
    this.name = "PrototypeJourneyError";
  }
}
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ROUTE = /^#[A-Za-z][A-Za-z0-9_-]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REF_ID = /^art_[A-Za-z0-9_-]+$/;
const STATES = new Set<PrototypeState>([
  "loading",
  "empty",
  "partial",
  "success",
  "error",
  "permission",
  "disabled",
]);
const object = <T>(value: T): value is T & Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function fail(code: PrototypeJourneyError["code"], message: string): never {
  throw new PrototypeJourneyError(code, message);
}
function keys(value: object, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      fail("INVALID", at + ": unsupported field " + key);
}
function safeText(value: unknown, empty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4000 &&
    (empty || !!value.trim()) &&
    ![...value].some((char) => {
      const n = char.charCodeAt(0);
      return n < 32 && n !== 9 && n !== 10 && n !== 13;
    })
  );
}
function ref(value: unknown): ExactArtifactRef {
  if (
    !object(value) ||
    !REF_ID.test(String(value.artifactId)) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !DIGEST.test(String(value.lockDigest))
  )
    fail("INVALID", "Invalid exact artifact reference");
  keys(value, ["artifactId", "revision", "lockDigest"], "reference");
  return value as unknown as ExactArtifactRef;
}
function same(a: ExactArtifactRef, b: ExactArtifactRef): boolean {
  return (
    a.artifactId === b.artifactId &&
    a.revision === b.revision &&
    a.lockDigest === b.lockDigest
  );
}
async function read(
  store: ArtifactStore,
  exact: ExactArtifactRef,
  type: string,
): Promise<ArtifactSnapshot> {
  const snapshot = await store.read(exact.artifactId, exact.revision);
  if (snapshot.digest !== exact.lockDigest)
    fail("INTEGRITY", "Exact lock mismatch: " + exact.artifactId);
  if (
    snapshot.artifact.meta.type !== type ||
    snapshot.artifact.meta.schemaVersion !== "1.0.0"
  )
    fail("INVALID", "Wrong source type: " + exact.artifactId);
  if (
    snapshot.artifact.lifecycle.status !== "approved" ||
    snapshot.artifact.lifecycle.freshness !== "valid" ||
    snapshot.artifact.approval.status !== "approved"
  )
    fail("UNAPPROVED", "Source is not fresh and approved: " + exact.artifactId);
  return snapshot.artifact;
}
function locked(artifact: ArtifactSnapshot, exact: ExactArtifactRef): boolean {
  return artifact.dependencies.some((dependency) => same(dependency, exact));
}
function nodes(render: PrototypeBuilderInput): Map<string, PrototypeNode> {
  const result = new Map<string, PrototypeNode>();
  const visit = (node: PrototypeNode): void => {
    if (node.id) {
      if (result.has(node.id))
        fail("INVALID", "Duplicate logical node ID: " + node.id);
      result.set(node.id, node);
    }
    node.children?.forEach(visit);
  };
  render.states.forEach((state) => visit(state.root));
  render.responsive?.states.forEach((entry) =>
    entry.operations.forEach((operation) => {
      if (operation.kind === "replace") visit(operation.with);
    }),
  );
  return result;
}
function domId(viewId: string, nodeId: string): string {
  return viewId + "__" + nodeId;
}
function namespaceNode(node: PrototypeNode, viewId: string): PrototypeNode {
  return {
    ...node,
    ...(node.id ? { id: domId(viewId, node.id) } : {}),
    ...(node.href ? { href: "#" + domId(viewId, node.href.slice(1)) } : {}),
    ...(node.children
      ? { children: node.children.map((child) => namespaceNode(child, viewId)) }
      : {}),
  };
}
function namespaced(
  render: PrototypeBuilderInput,
  viewId: string,
): PrototypeBuilderInput {
  const id = (logical: string) => domId(viewId, logical);
  return {
    ...render,
    states: render.states.map((state) => ({
      ...state,
      root: namespaceNode(state.root, viewId),
    })),
    ...(render.responsive
      ? {
          responsive: {
            ...render.responsive,
            states: render.responsive.states.map((entry) => ({
              ...entry,
              continuity: {
                entity: {
                  desktopId: id(entry.continuity.entity.desktopId),
                  mobileId: id(entry.continuity.entity.mobileId),
                },
                primaryAction: {
                  desktopId: id(entry.continuity.primaryAction.desktopId),
                  mobileId: id(entry.continuity.primaryAction.mobileId),
                },
                criticalInfo: entry.continuity.criticalInfo.map((pair) => ({
                  desktopId: id(pair.desktopId),
                  mobileId: id(pair.mobileId),
                })),
                returnPath: {
                  desktopId: id(entry.continuity.returnPath.desktopId),
                  mobileId: id(entry.continuity.returnPath.mobileId),
                },
              },
              operations: entry.operations.map((operation) => {
                if (operation.kind === "reorder")
                  return {
                    ...operation,
                    parentId: id(operation.parentId),
                    childIds: operation.childIds.map(id),
                  };
                if (operation.kind === "replace")
                  return {
                    ...operation,
                    targetId: id(operation.targetId),
                    with: namespaceNode(operation.with, viewId),
                    focusMap: operation.focusMap.map((pair) => ({
                      desktopId: id(pair.desktopId),
                      mobileId: id(pair.mobileId),
                    })),
                  };
                return { ...operation, targetId: id(operation.targetId) };
              }),
            })),
          },
        }
      : {}),
  };
}
function validate(
  plan: PrototypeJourneyInput,
): Map<string, Map<string, PrototypeNode>> {
  if (!object(plan)) fail("INVALID", "Journey plan must be an object");
  keys(
    plan,
    [
      "version",
      "contract",
      "journey",
      "views",
      "initialViewId",
      "initialEntityId",
      "filterField",
      "initialFilter",
      "filterEmpty",
      "draftFields",
      "entities",
      "controls",
      "rows",
      "texts",
      "retention",
      "outputPath",
    ],
    "journey plan",
  );
  if (plan.version !== 1) fail("INVALID", "Unsupported journey plan version");
  ref(plan.contract);
  ref(plan.journey);
  if (
    !Array.isArray(plan.views) ||
    plan.views.length < 2 ||
    plan.views.length > 8
  )
    fail("INVALID", "Journey requires two to eight authored views");
  const viewIds = new Set<string>();
  const routes = new Set<string>();
  const viewNodes = new Map<string, Map<string, PrototypeNode>>();
  for (const view of plan.views) {
    if (!object(view)) fail("INVALID", "Invalid view");
    keys(view, ["id", "route", "domainId", "domain", "render"], "view");
    if (
      !ID.test(view.id) ||
      !ROUTE.test(view.route) ||
      !ID.test(view.domainId) ||
      viewIds.has(view.id) ||
      routes.has(view.route) ||
      !object(view.render)
    )
      fail("INVALID", "Invalid or duplicate view identity or route");
    viewIds.add(view.id);
    routes.add(view.route);
    ref(view.domain);
    viewNodes.set(view.id, nodes(view.render));
  }
  if (
    !viewIds.has(plan.initialViewId) ||
    !FIELD.test(plan.filterField) ||
    !safeText(plan.initialFilter, true) ||
    plan.initialFilter.length > 100 ||
    !Array.isArray(plan.draftFields) ||
    !plan.draftFields.length ||
    plan.draftFields.length > 16 ||
    new Set(plan.draftFields).size !== plan.draftFields.length ||
    plan.draftFields.some((field) => !FIELD.test(field))
  )
    fail("INVALID", "Invalid initial view, filter, or draft field list");
  if (!object(plan.filterEmpty))
    fail("INVALID", "Filter empty feedback must be authored");
  keys(plan.filterEmpty, ["viewId", "nodeId"], "filter empty feedback");
  const filterEmptyNode = viewNodes
    .get(plan.filterEmpty.viewId)
    ?.get(plan.filterEmpty.nodeId);
  if (!filterEmptyNode || filterEmptyNode.tag !== "p")
    fail("INVALID", "Filter empty feedback needs a known paragraph");
  if (
    !Array.isArray(plan.entities) ||
    !plan.entities.length ||
    plan.entities.length > 100
  )
    fail("INVALID", "Journey needs one to 100 synthetic entities");
  const entityIds = new Set<string>();
  for (const entity of plan.entities) {
    if (!object(entity)) fail("INVALID", "Invalid entity");
    keys(entity, ["id", "fields", "drafts"], "entity");
    if (
      !ID.test(entity.id) ||
      entityIds.has(entity.id) ||
      !object(entity.fields) ||
      !object(entity.drafts)
    )
      fail("INVALID", "Invalid or duplicate entity");
    entityIds.add(entity.id);
    if (
      !Object.hasOwn(entity.fields, plan.filterField) ||
      Object.keys(entity.fields).length > 32 ||
      Object.entries(entity.fields).some(
        ([field, value]) => !FIELD.test(field) || !safeText(value, true),
      ) ||
      Object.keys(entity.drafts).length !== plan.draftFields.length ||
      plan.draftFields.some(
        (field) =>
          !Object.hasOwn(entity.drafts, field) ||
          !safeText(entity.drafts[field], true),
      )
    )
      fail("INVALID", "Invalid bounded entity fields or drafts");
  }
  if (plan.initialEntityId !== null && !entityIds.has(plan.initialEntityId))
    fail("INVALID", "Initial entity is unknown");
  if (!object(plan.retention)) fail("INVALID", "Retention rules are required");
  keys(
    plan.retention,
    ["filter", "drafts", "returnContext", "status"],
    "retention",
  );
  if (
    plan.retention.filter !== "session" ||
    plan.retention.drafts !== "per-entity-until-discard" ||
    plan.retention.returnContext !== "source-view-and-focus" ||
    plan.retention.status !== "per-view"
  )
    fail("INVALID", "Unsupported retention rule");
  if (typeof plan.outputPath !== "string" || !plan.outputPath)
    fail("INVALID", "Output path required");
  if (
    !Array.isArray(plan.controls) ||
    !plan.controls.length ||
    !Array.isArray(plan.rows) ||
    !plan.rows.length ||
    !Array.isArray(plan.texts)
  )
    fail("INVALID", "Controls, rows, and texts must be authored lists");
  const controlIds = new Set<string>();
  const inputIds = new Set<string>();
  let filterControlCount = 0;
  for (const control of plan.controls) {
    if (!object(control)) fail("INVALID", "Invalid control");
    keys(control, ["viewId", "nodeId", "action"], "control");
    const node = viewNodes.get(control.viewId)?.get(control.nodeId);
    const key = control.viewId + "/" + control.nodeId;
    if (!node || controlIds.has(key) || !object(control.action))
      fail("INVALID", "Dangling or duplicate control: " + key);
    controlIds.add(key);
    const action = control.action;
    switch (action.kind) {
      case "select":
        keys(
          action,
          ["kind", "entityId", "viewId", "returnFocusId"],
          "select action",
        );
        if (
          !entityIds.has(action.entityId) ||
          !viewIds.has(action.viewId) ||
          !viewNodes.get(control.viewId)?.has(action.returnFocusId) ||
          action.viewId === control.viewId
        )
          fail("INVALID", "Invalid selection target or return focus");
        break;
      case "navigate":
        keys(action, ["kind", "viewId"], "navigate action");
        if (!viewIds.has(action.viewId))
          fail("INVALID", "Unknown navigation view");
        break;
      case "return":
      case "discard-draft":
      case "reset-draft":
        keys(action, ["kind"], "journey action");
        break;
      case "set-filter":
        keys(action, ["kind", "field"], "filter action");
        if (
          action.field !== plan.filterField ||
          control.viewId !== plan.filterEmpty.viewId
        )
          fail("INVALID", "Filter field is not declared");
        filterControlCount += 1;
        break;
      case "edit-draft":
        keys(action, ["kind", "field"], "draft action");
        if (!plan.draftFields.includes(action.field))
          fail("INVALID", "Draft field is not declared");
        break;
      case "set-status":
        keys(action, ["kind", "status"], "status action");
        if (
          !STATES.has(action.status) ||
          !plan.views
            .find((view) => view.id === control.viewId)
            ?.render.requiredStates.includes(action.status)
        )
          fail("INVALID", "Unsupported semantic status");
        break;
      default:
        fail("INVALID", "Unsupported journey action");
    }
    const input = action.kind === "set-filter" || action.kind === "edit-draft";
    if (input && (node.tag !== "input" || node.targetState !== undefined))
      fail("INVALID", "Input action needs an input node");
    if (!input && (node.tag !== "button" || node.targetState !== undefined))
      fail("INVALID", "Journey button action needs an unambiguous button");
    if (input) inputIds.add(key);
  }
  if (filterControlCount !== 1)
    fail("INVALID", "Journey needs one authored filter control");
  for (const view of plan.views) {
    for (const [nodeId, node] of viewNodes.get(view.id)!) {
      if (node.tag === "input" && !inputIds.has(view.id + "/" + nodeId))
        fail("INVALID", "Unbound journey input: " + nodeId);
    }
  }
  const rowIds = new Set<string>();
  for (const row of plan.rows) {
    if (!object(row)) fail("INVALID", "Invalid row");
    keys(row, ["viewId", "nodeId", "entityId"], "row");
    const node = viewNodes.get(row.viewId)?.get(row.nodeId);
    const key = row.viewId + "/" + row.nodeId;
    if (
      !node ||
      !["section", "article", "li"].includes(node.tag) ||
      !entityIds.has(row.entityId) ||
      row.viewId !== plan.filterEmpty.viewId ||
      rowIds.has(key)
    )
      fail("INVALID", "Dangling or duplicate entity row");
    rowIds.add(key);
  }
  const textIds = new Set<string>();
  for (const binding of plan.texts) {
    if (!object(binding)) fail("INVALID", "Invalid text binding");
    keys(
      binding,
      ["viewId", "nodeId", "source", "field", "entityId"],
      "text binding",
    );
    const node = viewNodes.get(binding.viewId)?.get(binding.nodeId);
    const key = binding.viewId + "/" + binding.nodeId;
    if (
      !node ||
      !["p", "span", "strong", "h1", "h2", "h3"].includes(node.tag) ||
      textIds.has(key) ||
      !FIELD.test(binding.field)
    )
      fail("INVALID", "Dangling or duplicate text binding");
    textIds.add(key);
    if (
      binding.source === "entity-field" &&
      !entityIds.has(binding.entityId ?? "")
    )
      fail("INVALID", "Text binding needs a known entity");
    if (binding.source !== "entity-field" && binding.entityId !== undefined)
      fail("INVALID", "Unexpected entity on selected text binding");
    if (
      binding.source === "selected-draft" &&
      !plan.draftFields.includes(binding.field)
    )
      fail("INVALID", "Unknown draft text field");
    if (
      !["selected-field", "entity-field", "selected-draft"].includes(
        binding.source,
      ) ||
      (binding.source !== "selected-draft" &&
        binding.field !== "id" &&
        plan.entities.some(
          (entity) => !Object.hasOwn(entity.fields, binding.field),
        ))
    )
      fail("INVALID", "Unknown entity text field");
  }
  return viewNodes;
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
function runtime(
  plan: PrototypeJourneyInput,
  responsive: readonly { state: string; operations: readonly unknown[] }[],
  breakpoint: number,
): string {
  const program = {
    views: plan.views.map((view) => ({
      id: view.id,
      route: view.route,
      initialState: view.render.initialState,
      states: view.render.requiredStates,
    })),
    initialViewId: plan.initialViewId,
    initialEntityId: plan.initialEntityId,
    initialFilter: plan.initialFilter,
    filterField: plan.filterField,
    filterEmpty: domId(plan.filterEmpty.viewId, plan.filterEmpty.nodeId),
    entities: plan.entities,
    controls: plan.controls.map((control) => ({
      ...control,
      domId: domId(control.viewId, control.nodeId),
    })),
    rows: plan.rows.map((row) => ({
      ...row,
      domId: domId(row.viewId, row.nodeId),
    })),
    texts: plan.texts.map((binding) => ({
      ...binding,
      domId: domId(binding.viewId, binding.nodeId),
    })),
  };
  return `const journey = ${JSON.stringify(program)};
const entities = new Map(journey.entities.map((item) => [item.id, item]));
const initialDrafts = new Map(journey.entities.map((item) => [item.id, { ...item.drafts }]));
const drafts = new Map(journey.entities.map((item) => [item.id, { ...item.drafts }]));
const statuses = new Map(journey.views.map((view) => [view.id, view.initialState]));
let viewId = journey.initialViewId;
let entityId = journey.initialEntityId;
let filterValue = journey.initialFilter;
let returnContext = null;
let focusAnchor = null;
const byId = (id) => document.getElementById(id);
const visible = (element) => element && element.getClientRects().length && !element.closest('[hidden],details:not([open])');
function focusAfterStateChange() {
  const active = document.activeElement;
  if (active && active !== document.body && visible(active)) return;
  const view = document.querySelector('[data-view]:not([hidden]) [data-state]:not([hidden])');
  const heading = [...view.querySelectorAll('h1,h2,h3')].find(visible);
  const target = heading || view;
  target.tabIndex = -1;
  target.focus();
  focusAnchor = heading || null;
}
function focusTarget(id) {
  const target = id && byId(id);
  if (visible(target)) {
    target.focus();
    focusAnchor = null;
  } else focusAfterStateChange();
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
      !focusAnchor || document.activeElement !== focusAnchor || !visible(focusAnchor)) return;
  const state = focusAnchor.closest('[data-state]');
  const next = [...state.querySelectorAll('a[href],button:not([disabled]),input,summary')]
    .find((item) => visible(item) || (item.tagName === 'SUMMARY' &&
      item.getClientRects().length && !item.closest('[hidden]')));
  if (!next) return;
  event.preventDefault();
  focusAnchor = null;
  next.focus();
});
function current() { return entityId ? entities.get(entityId) : null; }
function refresh() {
  for (const view of journey.views) {
    const wrapper = document.querySelector('[data-view="' + view.id + '"]');
    wrapper.hidden = view.id !== viewId;
    for (const state of wrapper.querySelectorAll('[data-state]'))
      state.hidden = state.getAttribute('data-state') !== statuses.get(view.id);
  }
  let matching = 0;
  for (const row of journey.rows) {
    const item = entities.get(row.entityId);
    const match = String(item.fields[journey.filterField]).toLocaleLowerCase().includes(filterValue.toLocaleLowerCase());
    byId(row.domId).hidden = !match;
    if (match) matching += 1;
  }
  byId(journey.filterEmpty).hidden = matching !== 0;
  for (const binding of journey.texts) {
    const item = binding.source === 'entity-field' ? entities.get(binding.entityId) : current();
    const value = !item ? '' : binding.source === 'selected-draft'
      ? drafts.get(item.id)[binding.field]
      : binding.field === 'id' ? item.id : item.fields[binding.field];
    const target = byId(binding.domId);
    if (target) target.textContent = value;
  }
  for (const control of journey.controls) {
    const input = byId(control.domId);
    if (input.tagName !== 'INPUT' || input === document.activeElement) continue;
    if (control.action.kind === 'set-filter') input.value = filterValue;
    else if (control.action.kind === 'edit-draft') input.value = current() ? drafts.get(entityId)[control.action.field] : '';
  }
  const activeView = journey.views.find((view) => view.id === viewId);
  byId('prototype-status').textContent = activeView.id + ' · ' + statuses.get(viewId) +
    (entityId ? ' · ' + entityId : '') + ' · synthetic, uncommitted';
  if (location.hash !== activeView.route) history.replaceState(null, '', activeView.route);
}
function run(action, input) {
  if (action.kind === 'select') {
    returnContext = { viewId, focusId: action.viewId === viewId ? null : action.returnFocusId };
    entityId = action.entityId;
    viewId = action.viewId;
    refresh();
    focusAfterStateChange();
  } else if (action.kind === 'navigate') {
    if (action.viewId !== viewId) returnContext = { viewId, focusId: null };
    viewId = action.viewId;
    refresh();
    focusAfterStateChange();
  } else if (action.kind === 'return') {
    if (!returnContext) return;
    viewId = returnContext.viewId;
    const focusId = returnContext.focusId ? viewId + '__' + returnContext.focusId : null;
    returnContext = null;
    refresh();
    focusTarget(focusId);
  } else if (action.kind === 'set-filter') {
    filterValue = input.value;
    refresh();
  } else if (action.kind === 'edit-draft') {
    if (!entityId) return;
    drafts.get(entityId)[action.field] = input.value;
    refresh();
  } else if (action.kind === 'discard-draft' || action.kind === 'reset-draft') {
    if (!entityId) return;
    drafts.set(entityId, { ...initialDrafts.get(entityId) });
    refresh();
  } else if (action.kind === 'set-status') {
    statuses.set(viewId, action.status);
    refresh();
    focusAfterStateChange();
  }
}
for (const control of journey.controls) {
  const element = byId(control.domId);
  const eventName = element.tagName === 'INPUT' ? 'input' : 'click';
  element.addEventListener(eventName, () => run(control.action, element));
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-target-state]');
  if (!button) return;
  const wrapper = button.closest('[data-view]');
  if (!wrapper || wrapper.hidden) return;
  const view = journey.views.find((item) => item.id === wrapper.dataset.view);
  const status = button.getAttribute('data-target-state');
  if (!view.states.includes(status)) return;
  statuses.set(view.id, status);
  refresh();
  focusAfterStateChange();
});
window.addEventListener('hashchange', () => {
  const target = journey.views.find((view) => view.route === location.hash);
  if (!target || (target.id !== journey.initialViewId && !entityId)) {
    refresh();
    return;
  }
  viewId = target.id;
  refresh();
  focusAfterStateChange();
});
refresh();
${responsive.length ? responsiveRuntime(responsive, breakpoint) + "\nresponsiveQuery.addEventListener('change', () => queueMicrotask(refresh));\nqueueMicrotask(refresh);\n" : ""}`;
}
export function checkPrototypeJourneyPlan(value: unknown): {
  plan?: PrototypeJourneyInput;
  errors: string[];
} {
  try {
    const plan = jsonCopy(
      value as JsonValue,
    ) as unknown as PrototypeJourneyInput;
    validate(plan);
    return { plan, errors: [] };
  } catch (error) {
    return { errors: [String(error)] };
  }
}
export interface CompiledJourneyBundle {
  readonly plan: PrototypeJourneyInput;
  readonly planDigest: string;
  readonly files: Readonly<Record<string, string>>;
}
/** Revalidate exact source locks and render all views without publishing. */
export async function compilePrototypeJourney(
  store: ArtifactStore,
  supplied: PrototypeJourneyInput,
): Promise<CompiledJourneyBundle> {
  // Capture all authored values before any asynchronous source read.
  let plan: PrototypeJourneyInput;
  try {
    plan = jsonCopy(
      supplied as unknown as JsonValue,
    ) as unknown as PrototypeJourneyInput;
  } catch {
    fail("INVALID", "Journey plan must be finite JSON data");
  }
  validate(plan);
  const contract = await read(store, ref(plan.contract), "product-ui-contract");
  const journey = await read(store, ref(plan.journey), "journey");
  if (
    !locked(journey, plan.contract) ||
    journey.scope.level !== "product" ||
    journey.scope.ownerId !== contract.scope.ownerId
  )
    fail(
      "INVALID",
      "Journey must lock the exact Product UI Contract in the same product",
    );
  const semanticDomains = (journey.content as { domains?: unknown }).domains;
  if (
    !Array.isArray(semanticDomains) ||
    plan.views.some((view) => !semanticDomains.includes(view.domainId))
  )
    fail("INVALID", "A view is absent from the approved journey domains");
  const compiled = [];
  for (const view of plan.views) {
    const domain = await read(store, ref(view.domain), "experience-domain");
    const scenario = await read(store, ref(view.render.scenario), "scenario");
    if (
      domain.scope.level !== "domain" ||
      scenario.scope.level !== "domain" ||
      domain.scope.ownerId !== scenario.scope.ownerId ||
      domain.scope.parentId !== contract.scope.ownerId ||
      !locked(domain, plan.contract) ||
      !locked(scenario, plan.contract) ||
      !locked(scenario, plan.journey) ||
      !locked(scenario, view.domain)
    )
      fail(
        "INVALID",
        "View scenario must lock its own domain, journey and contract",
      );
    const transformed = namespaced(view.render, view.id);
    const controls = new Set(
      plan.controls
        .filter(
          (control) =>
            control.viewId === view.id &&
            control.action.kind !== "set-filter" &&
            control.action.kind !== "edit-draft",
        )
        .map((control) => domId(view.id, control.nodeId)),
    );
    const inputs = new Set(
      plan.controls
        .filter(
          (control) =>
            control.viewId === view.id &&
            (control.action.kind === "set-filter" ||
              control.action.kind === "edit-draft"),
        )
        .map((control) => domId(view.id, control.nodeId)),
    );
    const built = await compilePrototypeBundle(store, transformed, {
      journeyControls: controls,
      journeyInputs: inputs,
    });
    compiled.push({ view, built });
  }
  const tokenCss = compiled[0]!.built.tokenCss;
  if (compiled.some(({ built }) => built.tokenCss !== tokenCss))
    fail(
      "INVALID",
      "Conflicting global token definitions across journey views",
    );
  const sections = compiled.map(
    ({ view, built }) =>
      '<div data-view="' +
      view.id +
      '"' +
      (view.id === plan.initialViewId ? "" : " hidden") +
      ">" +
      built.sections.join("") +
      "</div>",
  );
  const css =
    tokenCss +
    "\n" +
    compiled
      .map(({ view, built }) =>
        built.css
          .slice(built.tokenCss.length)
          .replaceAll("body {", '[data-view="' + view.id + '"] {')
          .replaceAll(
            "[data-state]",
            '[data-view="' + view.id + '"] [data-state]',
          ),
      )
      .join("\n") +
    "\n[data-view][hidden], [data-state][hidden], [hidden] { display: none !important; }\n";
  const responsive = compiled.flatMap(({ view, built }) =>
    (built.responsiveProgram ?? []).map((entry) => ({
      ...entry,
      state: view.id + "/" + entry.state,
    })),
  );
  const breakpoints = new Set(
    plan.views.map((view) => view.render.layout.breakpointPx),
  );
  if (responsive.length && breakpoints.size !== 1)
    fail("INVALID", "Responsive journey views need a common breakpoint");
  const digest =
    "sha256:" +
    createHash("sha256")
      .update(canonicalJson(plan as unknown as JsonValue))
      .digest("hex");
  const manifest = {
    kind: "mimic-prototype-journey",
    productionReady: false,
    fixtures: "synthetic",
    planDigest: digest,
    contract: plan.contract,
    journey: plan.journey,
    views: compiled.map(({ view, built }) => ({
      id: view.id,
      route: view.route,
      domain: view.domain,
      scenario: view.render.scenario,
      planDigest: built.planDigest,
      selectedAssets: JSON.parse(built.files["manifest.json"]!)[
        "selectedAssets"
      ],
      tokenSources: JSON.parse(built.files["manifest.json"]!)["tokenSources"],
    })),
    domIdRule: "viewId__logicalNodeId",
    review:
      "Authored journey execution plan is not approved by artifact approvals",
  };
  const html =
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>' +
    escapeHtml(plan.views[0]!.render.title) +
    ' journey</title><link rel="stylesheet" href="prototype.css"/><script type="module" src="prototype.js"></script></head><body><header><p>Specification prototype · synthetic fixture data · not a production app</p><h1>' +
    escapeHtml(plan.views[0]!.render.title) +
    " journey</h1></header><main>" +
    sections.join("") +
    '</main><p role="status" aria-live="polite" id="prototype-status">Synthetic journey</p></body></html>\n';
  const files = {
    "index.html": html,
    "prototype.css": css,
    "prototype.js": runtime(
      plan,
      responsive,
      plan.views[0]!.render.layout.breakpointPx,
    ),
    "manifest.json": canonicalJson(manifest as unknown as JsonValue) + "\n",
    "plan.json": canonicalJson(plan as unknown as JsonValue) + "\n",
  };
  return { plan, planDigest: digest, files };
}
export async function buildPrototypeJourney(
  store: ArtifactStore,
  supplied: PrototypeJourneyInput,
  outputRoot: string,
): Promise<PrototypeJourneyResult> {
  const built = await compilePrototypeJourney(store, supplied);
  let directory: string;
  try {
    directory = await publishPrototypeBundle(
      outputRoot,
      built.plan.outputPath,
      built.files,
    );
  } catch (error) {
    if (error instanceof PrototypeOutputError) fail("PATH", error.message);
    throw error;
  }
  return {
    directory,
    planDigest: built.planDigest,
    files: Object.keys(built.files),
  };
}
