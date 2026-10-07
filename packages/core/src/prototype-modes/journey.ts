import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  jsonCopy,
  type JsonValue,
} from "../artifact-canonical.js";
import type { ArtifactSnapshot, ArtifactStore } from "../artifact-store.js";
import type { ExactArtifactRef } from "../runtime-engines/dependency.js";
import {
  buildPrototypeJourney,
  checkPrototypeJourneyPlan,
  type PrototypeJourneyInput,
  type PrototypeJourneyResult,
} from "../prototype-journey/index.js";
import type { PrototypeNode } from "../prototype-builder/index.js";
import type { ModeChoice } from "./index.js";

export interface JourneyModeBinding {
  readonly contribution: string;
  readonly choiceId: string;
}
export interface PrototypeJourneyModePlan {
  readonly contract: ExactArtifactRef;
  readonly choices: readonly ModeChoice[];
  readonly currentUses: readonly string[];
  readonly proposedUses: readonly string[];
  readonly bindings: {
    readonly current: readonly JourneyModeBinding[];
    readonly proposed: readonly JourneyModeBinding[];
  };
  readonly decisionContext: {
    readonly kind: "live" | "historical";
    readonly requests: readonly ExactArtifactRef[];
  };
  readonly current: PrototypeJourneyInput;
  readonly proposed: PrototypeJourneyInput;
  readonly comparisonPath: string;
}
export interface PrototypeJourneyModeResult {
  readonly comparisonDirectory: string;
  readonly modePlanDigest: string;
  readonly current: PrototypeJourneyResult;
  readonly proposed?: PrototypeJourneyResult;
  readonly fallback?:
    "rejected-system-request" | "rejected-capability" | "unresolved-choice";
}
export class PrototypeJourneyModeError extends Error {
  constructor(
    readonly code: "INVALID" | "INTEGRITY" | "UNAPPROVED" | "PATH",
    message: string,
  ) {
    super(message);
    this.name = "PrototypeJourneyModeError";
  }
}
function fail(code: PrototypeJourneyModeError["code"], message: string): never {
  throw new PrototypeJourneyModeError(code, message);
}
function object<T>(value: T): value is T & Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: object, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail("INVALID", at + ": unsupported " + key);
}
function same(a: ExactArtifactRef, b: ExactArtifactRef): boolean {
  return (
    a.artifactId === b.artifactId &&
    a.revision === b.revision &&
    a.lockDigest === b.lockDigest
  );
}
function ref(value: unknown): ExactArtifactRef {
  if (
    !object(value) ||
    !/^art_[A-Za-z0-9_-]+$/.test(String(value.artifactId)) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.lockDigest))
  )
    fail("INVALID", "Invalid exact mode source");
  keys(value, ["artifactId", "revision", "lockDigest"], "source");
  return value as unknown as ExactArtifactRef;
}
async function read(
  store: ArtifactStore,
  exact: ExactArtifactRef,
  type: string,
): Promise<ArtifactSnapshot> {
  const value = await store.read(exact.artifactId, exact.revision);
  if (value.digest !== exact.lockDigest)
    fail("INTEGRITY", "Exact mode lock mismatch");
  if (
    value.artifact.meta.type !== type ||
    value.artifact.meta.schemaVersion !== "1.0.0"
  )
    fail("INVALID", "Wrong mode source type");
  if (value.artifact.lifecycle.freshness !== "valid")
    fail("UNAPPROVED", "Stale mode source");
  return value.artifact;
}
function locked(source: ArtifactSnapshot, exact: ExactArtifactRef): boolean {
  return source.dependencies.some((item) => same(item, exact));
}
function approved(source: ArtifactSnapshot): boolean {
  return (
    source.lifecycle.status === "approved" &&
    source.approval.status === "approved"
  );
}
function inputProvenance(
  source: ArtifactSnapshot,
  exact: ExactArtifactRef,
  path?: string,
): boolean {
  const id = exact.artifactId + "@" + exact.revision + "#" + exact.lockDigest;
  return source.provenance.some(
    (entry) =>
      (!path || entry.path === path) &&
      entry.kind === "derived" &&
      Array.isArray(entry.inputRefs) &&
      entry.inputRefs.includes(id),
  );
}
function evidence(source: ArtifactSnapshot): boolean {
  const refs = (source.content as { supportingEvidence?: unknown })
    .supportingEvidence;
  return (
    Array.isArray(refs) &&
    refs.length > 0 &&
    source.provenance.some(
      (entry) =>
        entry.path === "/content/description" &&
        entry.kind === "fact" &&
        Array.isArray(entry.evidenceRefs) &&
        refs.every((item) => (entry.evidenceRefs as string[]).includes(item)),
    )
  );
}
function digest(value: unknown): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update(canonicalJson(value as JsonValue))
      .digest("hex")
  );
}
/** Every visible value and executable effect is enumerated under a stable authored key. */
export function enumerateJourneyContributions(
  plan: PrototypeJourneyInput,
): ReadonlyMap<string, string> {
  const valid = checkPrototypeJourneyPlan(plan);
  if (!valid.plan) fail("INVALID", valid.errors.join("; "));
  const entries = new Map<string, string>();
  const put = (key: string, value: unknown): void => {
    if (entries.has(key)) fail("INVALID", "Duplicate contribution key: " + key);
    entries.set(key, canonicalJson(value as JsonValue));
  };
  put(
    "views/order",
    plan.views.map((view) => view.id),
  );
  put("document/title", plan.views[0]!.render.title + " journey");
  put("initial/view", plan.initialViewId);
  put("initial/entity", plan.initialEntityId);
  put("initial/filter", plan.initialFilter);
  put("filter/field", plan.filterField);
  put("filter/empty", plan.filterEmpty);
  put("draft/fields", plan.draftFields);
  put("retention", plan.retention);
  const controls = new Map(
    plan.controls.map((item) => [item.viewId + "/" + item.nodeId, item.action]),
  );
  for (const view of plan.views) {
    put("view/" + view.id + "/route", view.route);
    put("view/" + view.id + "/title", view.render.title);
    put("view/" + view.id + "/layout", view.render.layout);
    put("view/" + view.id + "/style", view.render.styleTokens);
    put("view/" + view.id + "/initial-status", view.render.initialState);
    for (const state of view.render.states) {
      const visit = (node: PrototypeNode, path: string): void => {
        const action = node.id && controls.get(view.id + "/" + node.id);
        const interactive =
          node.tag === "button" || node.tag === "a" || node.tag === "input";
        put(
          "view/" + view.id + "/" + state.name + "/node/" + path,
          interactive
            ? {
                tag: node.tag,
                id: node.id ?? null,
                text: node.text ?? null,
                fixtureKey: node.fixtureKey ?? null,
                ariaLabel: node.ariaLabel ?? null,
                inputKind: node.inputKind ?? null,
                componentId: node.componentId ?? null,
                href: node.href ?? null,
                targetState: node.targetState ?? null,
                action: action ?? null,
              }
            : {
                tag: node.tag,
                id: node.id ?? null,
                text: node.text ?? null,
                fixtureKey: node.fixtureKey ?? null,
                componentId: node.componentId ?? null,
              },
        );
        node.children?.forEach((child, index) =>
          visit(child, path + "/" + index),
        );
      };
      visit(state.root, "root");
      for (const [key, value] of Object.entries(
        view.render.fixtures[state.name] ?? {},
      ))
        put("view/" + view.id + "/" + state.name + "/fixture/" + key, value);
    }
    for (const responsive of view.render.responsive?.states ?? [])
      for (const [index, operation] of responsive.operations.entries())
        put(
          "view/" + view.id + "/" + responsive.state + "/responsive/" + index,
          operation,
        );
  }
  for (const control of plan.controls) {
    const view = plan.views.find((item) => item.id === control.viewId)!;
    let node: PrototypeNode | undefined;
    const visit = (candidate: PrototypeNode): void => {
      if (candidate.id === control.nodeId) node = candidate;
      candidate.children?.forEach(visit);
    };
    view.render.states.forEach((state) => visit(state.root));
    view.render.responsive?.states.forEach((entry) =>
      entry.operations.forEach((operation) => {
        if (operation.kind === "replace") visit(operation.with);
      }),
    );
    if (!node) fail("INVALID", "Control has no visible node");
    put("control/" + control.viewId + "/" + control.nodeId, {
      tag: node.tag,
      id: node.id ?? null,
      text: node.text ?? null,
      fixtureKey: node.fixtureKey ?? null,
      ariaLabel: node.ariaLabel ?? null,
      inputKind: node.inputKind ?? null,
      componentId: node.componentId ?? null,
      action: control.action,
    });
  }
  for (const entity of plan.entities) {
    for (const [field, value] of Object.entries(entity.fields))
      put("entity/" + entity.id + "/field/" + field, value);
    for (const [field, value] of Object.entries(entity.drafts))
      put("entity/" + entity.id + "/draft/" + field, value);
  }
  for (const row of plan.rows)
    put("row/" + row.viewId + "/" + row.nodeId, row.entityId);
  for (const text of plan.texts)
    put("text/" + text.viewId + "/" + text.nodeId, text);
  return entries;
}
function bound(
  plan: PrototypeJourneyInput,
  bindings: readonly JourneyModeBinding[],
  uses: readonly string[],
  choices: readonly ModeChoice[],
  mode: "current" | "proposed",
): Map<string, string> {
  const values = enumerateJourneyContributions(plan);
  if (!Array.isArray(bindings) || bindings.length !== values.size)
    fail(
      "INVALID",
      mode + " does not enumerate every visible/executable contribution",
    );
  const labels = new Map<string, string>();
  for (const binding of bindings) {
    if (!object(binding)) fail("INVALID", "Invalid journey mode binding");
    keys(binding, ["contribution", "choiceId"], "binding");
    if (
      typeof binding.contribution !== "string" ||
      !values.has(binding.contribution) ||
      typeof binding.choiceId !== "string" ||
      !uses.includes(binding.choiceId) ||
      labels.has(binding.contribution)
    )
      fail("INVALID", "Unbound or duplicate journey contribution");
    const choice = choices.find((item) => item.id === binding.choiceId);
    if (!choice || (mode === "current" && choice.status !== "current"))
      fail("INVALID", "Current cannot claim noncurrent capability");
    labels.set(binding.contribution, binding.choiceId);
  }
  for (const key of values.keys())
    if (!labels.has(key))
      fail("INVALID", "Missing journey contribution " + key);
  for (const control of plan.controls) {
    const group = "control/" + control.viewId + "/" + control.nodeId;
    const view = plan.views.find((item) => item.id === control.viewId)!;
    let owner: string | undefined;
    const visit = (node: PrototypeNode, key: string): void => {
      if (node.id === control.nodeId) owner = key;
      node.children?.forEach((child, index) => visit(child, key + "/" + index));
    };
    for (const state of view.render.states)
      visit(state.root, "view/" + view.id + "/" + state.name + "/node/root");
    for (const entry of view.render.responsive?.states ?? [])
      for (const [index, operation] of entry.operations.entries())
        if (operation.kind === "replace") {
          const found = (node: PrototypeNode): boolean =>
            node.id === control.nodeId || (node.children?.some(found) ?? false);
          if (found(operation.with))
            owner =
              "view/" + view.id + "/" + entry.state + "/responsive/" + index;
        }
    if (!owner || labels.get(owner) !== labels.get(group))
      fail(
        "INVALID",
        "Action label, component, behavior and data effect must share one choice: " +
          group,
      );
  }
  for (const id of uses)
    if (![...labels.values()].includes(id))
      fail("INVALID", "Unused mode choice " + id);
  return new Map(
    [...values].map(([key, value]) => [
      key,
      canonicalJson([labels.get(key), value]),
    ]),
  );
}
export function markedJourneyModePlan(
  plan: PrototypeJourneyInput,
  choices: readonly ModeChoice[],
  historical: boolean,
): PrototypeJourneyInput {
  const notices = choices
    .filter((choice) => choice.status !== "current")
    .map(
      (choice) =>
        (choice.status === "required"
          ? "Approved requirement, not implemented: "
          : "Proposed, not implemented: ") +
        choice.id +
        "; System Request " +
        choice.systemRequest!.artifactId +
        "@" +
        choice.systemRequest!.revision +
        "; digest " +
        choice.systemRequest!.lockDigest.slice(0, 19) +
        "…",
    );
  return {
    ...plan,
    views: plan.views.map((view) => ({
      ...view,
      render: {
        ...view.render,
        ...(view.render.responsive
          ? {
              responsive: {
                ...view.render.responsive,
                states: view.render.responsive.states.map((entry) => ({
                  ...entry,
                  operations: entry.operations.map((operation) =>
                    operation.kind === "reorder" &&
                    operation.parentId ===
                      view.render.states.find(
                        (state) => state.name === entry.state,
                      )?.root.id
                      ? {
                          ...operation,
                          childIds: [
                            ...operation.childIds,
                            "mode-notice-" + entry.state,
                          ],
                        }
                      : operation,
                  ),
                })),
              },
            }
          : {}),
        states: view.render.states.map((state) => ({
          ...state,
          root: {
            ...state.root,
            children: [
              ...(state.root.children ?? []),
              {
                tag: "header",
                id: "mode-notice-" + state.name,
                children: [
                  {
                    tag: "h2",
                    text: historical
                      ? "System mode: Proposed historical replay"
                      : "System mode: Proposed",
                  },
                  ...notices.map((text) => ({ tag: "p" as const, text })),
                ],
              },
            ],
          },
        })),
      },
    })),
  };
}
export async function buildPrototypeJourneyModes(
  store: ArtifactStore,
  supplied: PrototypeJourneyModePlan,
  outputRoot: string,
): Promise<PrototypeJourneyModeResult> {
  let plan: PrototypeJourneyModePlan;
  try {
    plan = jsonCopy(
      supplied as unknown as JsonValue,
    ) as unknown as PrototypeJourneyModePlan;
  } catch {
    fail("INVALID", "Mode plan must be finite JSON");
  }
  if (!object(plan)) fail("INVALID", "Mode plan must be an object");
  keys(
    plan,
    [
      "contract",
      "choices",
      "currentUses",
      "proposedUses",
      "bindings",
      "decisionContext",
      "current",
      "proposed",
      "comparisonPath",
    ],
    "mode plan",
  );
  ref(plan.contract);
  if (
    !Array.isArray(plan.choices) ||
    !plan.choices.length ||
    !Array.isArray(plan.currentUses) ||
    !Array.isArray(plan.proposedUses) ||
    !object(plan.bindings) ||
    !Array.isArray(plan.bindings.current) ||
    !Array.isArray(plan.bindings.proposed) ||
    !object(plan.decisionContext) ||
    !Array.isArray(plan.decisionContext.requests) ||
    !["live", "historical"].includes(plan.decisionContext.kind) ||
    !/^[A-Za-z][A-Za-z0-9_-]*$/.test(plan.comparisonPath)
  )
    fail("INVALID", "Incomplete journey mode plan");
  keys(plan.bindings, ["current", "proposed"], "bindings");
  keys(plan.decisionContext, ["kind", "requests"], "decision context");
  if (
    plan.decisionContext.kind === "historical" &&
    plan.decisionContext.requests.length
  )
    fail("INVALID", "Historical mode cannot claim live decisions");
  const currentPlan = checkPrototypeJourneyPlan(plan.current);
  const proposedPlan = checkPrototypeJourneyPlan(plan.proposed);
  if (!currentPlan.plan || !proposedPlan.plan)
    fail("INVALID", "Invalid journey plan");
  if (
    !same(plan.contract, plan.current.contract) ||
    !same(plan.contract, plan.proposed.contract) ||
    !same(plan.current.journey, plan.proposed.journey)
  )
    fail(
      "INVALID",
      "Both modes must share the exact common UI Contract and journey",
    );
  if (
    new Set([
      plan.comparisonPath,
      plan.current.outputPath,
      plan.proposed.outputPath,
    ]).size !== 3 ||
    [plan.current.outputPath, plan.proposed.outputPath].some(
      (part) => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(part),
    )
  )
    fail("PATH", "Mode output paths must be distinct safe directory names");
  const ids = new Set<string>();
  for (const choice of plan.choices) {
    if (!object(choice)) fail("INVALID", "Invalid mode choice");
    keys(choice, ["id", "status", "capability", "systemRequest"], "choice");
    if (
      !/^[A-Za-z][A-Za-z0-9_-]*$/.test(choice.id) ||
      ids.has(choice.id) ||
      !["current", "required", "proposed", "unresolved"].includes(choice.status)
    )
      fail("INVALID", "Invalid or duplicate mode choice");
    ids.add(choice.id);
    ref(choice.capability);
    if (choice.status === "current" && choice.systemRequest !== undefined)
      fail("INVALID", "Current choice cannot claim a System Request");
    if (choice.status !== "current") ref(choice.systemRequest);
  }
  for (const uses of [plan.currentUses, plan.proposedUses])
    if (
      !uses.length ||
      new Set(uses).size !== uses.length ||
      uses.some((id) => !ids.has(id))
    )
      fail("INVALID", "Unknown, empty or duplicate mode choices");
  if (
    plan.currentUses.some((id) => !plan.proposedUses.includes(id)) ||
    !plan.proposedUses.some((id) => !plan.currentUses.includes(id))
  )
    fail("INVALID", "Proposed must retain Current and add a noncurrent choice");
  const current = bound(
    plan.current,
    plan.bindings.current,
    plan.currentUses,
    plan.choices,
    "current",
  );
  const proposed = bound(
    plan.proposed,
    plan.bindings.proposed,
    plan.proposedUses,
    plan.choices,
    "proposed",
  );
  for (const [key, value] of current)
    if (proposed.get(key) !== value)
      fail(
        "INVALID",
        "Proposed removes or alters Current contribution: " + key,
      );
  const contract = await read(store, plan.contract, "product-ui-contract");
  if (!approved(contract)) fail("UNAPPROVED", "UI Contract must be approved");
  const chosen = plan.choices.filter(
    (choice) =>
      plan.currentUses.includes(choice.id) ||
      plan.proposedUses.includes(choice.id),
  );
  let fallback: PrototypeJourneyModeResult["fallback"];
  for (const choice of chosen) {
    const capability = await read(
      store,
      choice.capability,
      "system-capability",
    );
    const availability = (capability.content as { availability?: string })
      .availability;
    if (choice.status === "current") {
      if (
        !locked(contract, choice.capability) ||
        availability !== "current" ||
        !approved(capability) ||
        !inputProvenance(contract, choice.capability) ||
        !evidence(capability)
      )
        fail("UNAPPROVED", "Unsupported Current capability: " + choice.id);
      continue;
    }
    const request = await read(store, choice.systemRequest!, "system-request");
    if (
      !locked(request, plan.contract) ||
      !locked(capability, choice.systemRequest!) ||
      !inputProvenance(request, plan.contract, "/content/request") ||
      !inputProvenance(
        capability,
        choice.systemRequest!,
        "/content/description",
      ) ||
      (request.content as { changeType?: string }).changeType !==
        "capability" ||
      availability !== "proposed"
    )
      fail("INVALID", "Noncurrent capability/request chain is not exact");
    if (plan.decisionContext.kind === "live") {
      const contexts = plan.decisionContext.requests.filter(
        (item) => item.artifactId === choice.systemRequest!.artifactId,
      );
      if (
        contexts.length !== 1 ||
        contexts[0]!.revision < choice.systemRequest!.revision
      )
        fail("INVALID", "Missing current decision context");
      const context = await read(store, contexts[0]!, "system-request");
      if (!locked(context, plan.contract))
        fail("INVALID", "Decision context is not contract-locked");
      if (
        context.lifecycle.status === "rejected" ||
        context.approval.status === "rejected"
      )
        fallback = "rejected-system-request";
      else if (!same(contexts[0]!, choice.systemRequest!))
        fail("UNAPPROVED", "Stale System Request context");
    }
    if (choice.status === "unresolved") fallback = "unresolved-choice";
    if (
      request.lifecycle.status === "rejected" ||
      request.approval.status === "rejected"
    )
      fallback = "rejected-system-request";
    else if (
      capability.lifecycle.status === "rejected" ||
      capability.approval.status === "rejected"
    )
      fallback = "rejected-capability";
    else if (
      choice.status === "required" &&
      (!approved(request) || !approved(capability))
    )
      fail("UNAPPROVED", "Required capability is not approved");
    else if (
      choice.status === "proposed" &&
      (!["proposed", "approved"].includes(request.lifecycle.status) ||
        !["proposed", "approved"].includes(capability.lifecycle.status))
    )
      fail("UNAPPROVED", "Proposed choice has unsupported status");
  }
  const base = await realpath(outputRoot);
  const destination = path.join(base, plan.comparisonPath);
  try {
    await lstat(destination);
    fail("PATH", "Comparison destination is occupied");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(path.join(base, ".mimic-journey-modes-"));
  let published = false;
  try {
    const currentResult = await buildPrototypeJourney(
      store,
      plan.current,
      staging,
    );
    const markedProposed = fallback
      ? undefined
      : markedJourneyModePlan(
          plan.proposed,
          chosen,
          plan.decisionContext.kind === "historical",
        );
    const proposedResult = markedProposed
      ? await buildPrototypeJourney(store, markedProposed, staging)
      : undefined;
    const modePlanDigest = digest(plan);
    const comparison = {
      kind: "mimic-prototype-journey-mode-comparison",
      productionReady: false,
      modePlanDigest,
      contract: plan.contract,
      journey: plan.current.journey,
      choices: chosen,
      decisionContext: plan.decisionContext,
      current: {
        path: plan.current.outputPath,
        planDigest: currentResult.planDigest,
      },
      proposed: proposedResult
        ? {
            path: plan.proposed.outputPath,
            planDigest: proposedResult.planDigest,
          }
        : null,
      fallback: fallback ?? null,
      review:
        "Authored mode and journey plans are not approved by referenced artifact approvals",
    };
    await writeFile(
      path.join(staging, "mode-plan.json"),
      canonicalJson(plan as unknown as JsonValue) + "\n",
      { flag: "wx" },
    );
    await writeFile(
      path.join(staging, "comparison.json"),
      canonicalJson(comparison as unknown as JsonValue) + "\n",
      { flag: "wx" },
    );
    await rename(staging, destination);
    published = true;
    return {
      comparisonDirectory: destination,
      modePlanDigest,
      fallback,
      current: {
        ...currentResult,
        directory: path.join(destination, plan.current.outputPath),
      },
      proposed: proposedResult
        ? {
            ...proposedResult,
            directory: path.join(destination, plan.proposed.outputPath),
          }
        : undefined,
    };
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}
