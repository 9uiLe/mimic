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
  buildPrototype,
  type PrototypeBuilderInput,
  type PrototypeBuildResult,
  type PrototypeNode,
  type PrototypeState,
  type PrototypeStatePlan,
} from "../prototype-builder/index.js";
import { responsiveErrors } from "../prototype-builder/responsive.js";

export type ModeChoiceStatus =
  "current" | "required" | "proposed" | "unresolved";
export interface ModeChoice {
  readonly id: string;
  readonly status: ModeChoiceStatus;
  readonly capability: ExactArtifactRef;
  readonly systemRequest?: ExactArtifactRef;
}
export type ModeBindingField =
  "text" | "fixtureKey" | "targetState" | "href" | "responsiveOperation";
/** One authored claim tying an actual render-plan value or action to a capability. */
export interface ModeBinding {
  readonly state: PrototypeState;
  readonly nodePath: readonly number[];
  readonly field: ModeBindingField;
  readonly choiceId: string;
  /** Atomic classification of one finite responsive operation and its complete subtree. */
  readonly responsiveOperation?: number;
}
/** Authored comparison input. Its digest records intent, not human approval. */
export interface PrototypeModePlan {
  readonly contract: ExactArtifactRef;
  readonly choices: readonly ModeChoice[];
  readonly currentUses: readonly string[];
  readonly proposedUses: readonly string[];
  readonly bindings: {
    readonly current: readonly ModeBinding[];
    readonly proposed: readonly ModeBinding[];
  };
  readonly decisionContext: {
    /** Live callers supply exact authoritative System Request revisions; historical replay is labeled. */
    readonly kind: "live" | "historical";
    readonly requests: readonly ExactArtifactRef[];
  };
  readonly current: PrototypeBuilderInput;
  readonly proposed: PrototypeBuilderInput;
  readonly comparisonPath: string;
}
export interface PrototypeModeResult {
  readonly modePlanDigest: string;
  readonly current: PrototypeBuildResult;
  readonly proposed?: PrototypeBuildResult;
  readonly fallback?:
    "rejected-system-request" | "rejected-capability" | "unresolved-choice";
  readonly comparisonDirectory: string;
}
export class PrototypeModeError extends Error {
  constructor(
    readonly code: "INVALID" | "INTEGRITY" | "UNAPPROVED" | "PATH",
    message: string,
  ) {
    super(message);
    this.name = "PrototypeModeError";
  }
}
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const REF_ID = /^art_[A-Za-z0-9_-]+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const STATUSES: readonly ModeChoiceStatus[] = [
  "current",
  "required",
  "proposed",
  "unresolved",
];
const BINDING_FIELDS = [
  "text",
  "fixtureKey",
  "targetState",
  "href",
] as const satisfies readonly ModeBindingField[];
function fail(code: PrototypeModeError["code"], message: string): never {
  throw new PrototypeModeError(code, message);
}
function keys(value: object, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      fail("INVALID", `${at}: unsupported field ${key}`);
}
function ref(value: ExactArtifactRef | undefined): ExactArtifactRef {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !REF_ID.test(value.artifactId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !DIGEST.test(value.lockDigest)
  )
    fail("INVALID", "Invalid exact artifact reference");
  keys(value, ["artifactId", "revision", "lockDigest"], "reference");
  return value;
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
  kind: string,
): Promise<ArtifactSnapshot> {
  const record = await store.read(exact.artifactId, exact.revision);
  if (record.digest !== exact.lockDigest)
    fail(
      "INTEGRITY",
      `Exact lock mismatch: ${exact.artifactId}@${exact.revision}`,
    );
  if (
    record.artifact.meta.type !== kind ||
    record.artifact.meta.schemaVersion !== "1.0.0"
  )
    fail("INVALID", `Expected v1 ${kind}: ${exact.artifactId}`);
  if (record.artifact.lifecycle.freshness !== "valid")
    fail("UNAPPROVED", `Stale input: ${exact.artifactId}`);
  return record.artifact;
}
function approved(value: ArtifactSnapshot): boolean {
  return (
    value.lifecycle.status === "approved" &&
    value.approval.status === "approved"
  );
}
function locks(artifact: ArtifactSnapshot, exact: ExactArtifactRef): boolean {
  return artifact.dependencies.some((dependency) => same(dependency, exact));
}
function inputProvenance(
  artifact: ArtifactSnapshot,
  claimPath: string | undefined,
  exact: ExactArtifactRef,
): boolean {
  const identity = `${exact.artifactId}@${exact.revision}#${exact.lockDigest}`;
  return artifact.provenance.some(
    (entry) =>
      (claimPath
        ? entry.path === claimPath
        : entry.path.startsWith("/content/")) &&
      entry.kind === "derived" &&
      Array.isArray(entry.inputRefs) &&
      entry.inputRefs.includes(identity),
  );
}
function currentEvidence(capability: ArtifactSnapshot): boolean {
  const supporting = (capability.content as { supportingEvidence?: unknown })
    .supportingEvidence;
  return (
    Array.isArray(supporting) &&
    supporting.length > 0 &&
    capability.provenance.some((entry) => {
      const refs = entry.evidenceRefs;
      return (
        entry.path === "/content/description" &&
        entry.kind === "fact" &&
        Array.isArray(refs) &&
        supporting.every((evidence) => refs.includes(evidence))
      );
    })
  );
}
function bindingKey(
  state: string,
  nodePath: readonly number[],
  field: ModeBindingField,
  operation?: number,
): string {
  return `${state}/${operation === undefined ? nodePath.join("/") : `responsive/${operation}`}/${field}`;
}
function boundValues(
  render: PrototypeBuilderInput,
  bindings: readonly ModeBinding[],
  uses: readonly string[],
  mode: "current" | "proposed",
  choices: readonly ModeChoice[],
): Map<string, number> {
  if (!Array.isArray(bindings))
    fail("INVALID", `${mode} bindings must be an array`);
  if (
    !Array.isArray(render.states) ||
    !render.fixtures ||
    typeof render.fixtures !== "object" ||
    Array.isArray(render.fixtures)
  )
    fail("INVALID", `${mode} needs authored states and fixtures`);
  const responsiveProblems = responsiveErrors(render);
  if (responsiveProblems.length)
    fail(
      "INVALID",
      `${mode} responsive plan: ${responsiveProblems.join("; ")}`,
    );
  const actual = new Map<
    string,
    {
      value: string;
      field: ModeBindingField;
      state: PrototypeState;
      tag: PrototypeNode["tag"];
      componentId?: string;
    }
  >();
  const fixtureUses = new Set<string>();
  for (const state of render.states as readonly PrototypeStatePlan[]) {
    const visit = (node: PrototypeNode, nodePath: number[]) => {
      for (const field of BINDING_FIELDS) {
        const value = node[field];
        if (value === undefined) continue;
        const key = bindingKey(state.name, nodePath, field);
        let signature = canonicalJson(value);
        if (field === "fixtureKey") {
          const fixture = render.fixtures[state.name]?.[value as string];
          if (fixture === undefined)
            fail("INVALID", `Missing fixture for ${key}`);
          signature = canonicalJson([value, fixture]);
          fixtureUses.add(`${state.name}/${value}`);
        }
        actual.set(key, {
          value: signature,
          field,
          state: state.name,
          tag: node.tag,
          componentId: node.componentId,
        });
      }
      node.children?.forEach((child, index) =>
        visit(child, [...nodePath, index]),
      );
    };
    visit(state.root, []);
  }
  for (const responsive of render.responsive?.states ?? []) {
    responsive.operations.forEach((operation, index) => {
      const key = bindingKey(
        responsive.state,
        [],
        "responsiveOperation",
        index,
      );
      actual.set(key, {
        value: canonicalJson(operation),
        field: "responsiveOperation",
        state: responsive.state,
        tag: "section",
      });
      if (operation.kind === "replace") {
        const visit = (node: PrototypeNode): void => {
          if (node.fixtureKey)
            fixtureUses.add(`${responsive.state}/${node.fixtureKey}`);
          node.children?.forEach(visit);
        };
        visit(operation.with);
      }
    });
  }
  for (const [state, fixtures] of Object.entries(render.fixtures)) {
    for (const key of Object.keys(fixtures ?? {}))
      if (!fixtureUses.has(`${state}/${key}`))
        fail(
          "INVALID",
          `${mode} contains unbound synthetic fixture ${state}.${key}`,
        );
  }
  const seen = new Set<string>();
  const signatures = new Map<string, number>();
  const usedChoices = new Set<string>();
  type NodeGroup = {
    choiceId: string;
    state: PrototypeState;
    tag: PrototypeNode["tag"];
    componentId?: string;
    fields: Partial<Record<ModeBindingField, string>>;
  };
  const nodes = new Map<string, NodeGroup>();
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding))
      fail("INVALID", `Invalid ${mode} binding`);
    keys(
      binding,
      ["state", "nodePath", "field", "choiceId", "responsiveOperation"],
      "binding",
    );
    if (
      !Array.isArray(binding.nodePath) ||
      binding.nodePath.some(
        (index: number) => !Number.isSafeInteger(index) || index < 0,
      ) ||
      !(
        BINDING_FIELDS.includes(binding.field) ||
        binding.field === "responsiveOperation"
      ) ||
      (binding.field === "responsiveOperation" &&
        (!Number.isSafeInteger(binding.responsiveOperation) ||
          (binding.responsiveOperation ?? -1) < 0 ||
          binding.nodePath.length !== 0)) ||
      (binding.field !== "responsiveOperation" &&
        binding.responsiveOperation !== undefined) ||
      typeof binding.choiceId !== "string" ||
      !uses.includes(binding.choiceId)
    )
      fail("INVALID", `Invalid ${mode} binding target or choice`);
    const choice = choices.find(
      (candidate) => candidate.id === binding.choiceId,
    );
    if (!choice || (mode === "current" && choice.status !== "current"))
      fail("INVALID", `${mode} binding claims unsupported capability`);
    const key = bindingKey(
      binding.state,
      binding.nodePath,
      binding.field,
      binding.responsiveOperation,
    );
    const entry = actual.get(key);
    if (!entry || seen.has(key))
      fail(
        "INVALID",
        `${mode} binding does not uniquely name an authored value: ${key}`,
      );
    seen.add(key);
    usedChoices.add(binding.choiceId);
    const nodeKey = `${binding.state}/${binding.responsiveOperation === undefined ? binding.nodePath.join("/") : `responsive/${binding.responsiveOperation}`}`;
    const existing = nodes.get(nodeKey);
    if (existing && existing.choiceId !== binding.choiceId)
      fail("INVALID", `${mode} assigns one control to different capabilities`);
    const group: NodeGroup = existing ?? {
      choiceId: binding.choiceId,
      state: entry.state,
      tag: entry.tag,
      componentId: entry.componentId,
      fields: {},
    };
    group.fields[entry.field] = entry.value;
    nodes.set(nodeKey, group);
  }
  for (const group of nodes.values()) {
    const signature = canonicalJson([
      group.choiceId,
      group.state,
      group.tag,
      group.componentId ?? null,
      group.fields,
    ]);
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
  for (const state of render.states) {
    const visit = (node: PrototypeNode, nodePath: number[]) => {
      if (node.tag === "button" || node.tag === "a") {
        const action = nodes.get(`${state.name}/${nodePath.join("/")}`);
        if (!action)
          fail("INVALID", `${mode} action has no capability binding`);
        const parts: unknown[] = [];
        const collect = (child: PrototypeNode, relativePath: number[]) => {
          const bound = nodes.get(
            `${state.name}/${[...nodePath, ...relativePath].join("/")}`,
          );
          if (bound) {
            if (bound.choiceId !== action.choiceId)
              fail(
                "INVALID",
                `${mode} action label and behavior claim different capabilities`,
              );
            parts.push([
              relativePath,
              bound.tag,
              bound.componentId ?? null,
              bound.fields,
            ]);
          }
          child.children?.forEach((descendant, index) =>
            collect(descendant, [...relativePath, index]),
          );
        };
        collect(node, []);
        const signature = canonicalJson([
          "action",
          state.name,
          action.choiceId,
          parts,
        ]);
        signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
      }
      node.children?.forEach((child, index) =>
        visit(child, [...nodePath, index]),
      );
    };
    visit(state.root, []);
  }
  if (seen.size !== actual.size)
    fail("INVALID", `${mode} has unbound text, fixture data, or actions`);
  if (uses.some((id) => !usedChoices.has(id)))
    fail("INVALID", `${mode} declares a choice without a bound rendered value`);
  return signatures;
}
/** Add status chrome to every proposed state; the manifest retains full exact locks. */
function markedPlan(
  plan: PrototypeBuilderInput,
  choices: readonly ModeChoice[],
  historical: boolean,
): PrototypeBuilderInput {
  const notices = choices
    .filter((choice) => choice.status !== "current")
    .map((choice) => {
      const request = choice.systemRequest!;
      const status =
        choice.status === "required"
          ? "Approved requirement, not implemented"
          : "Proposed, not implemented";
      return `${status}: ${choice.id}; System Request ${request.artifactId}@${request.revision}; digest ${request.lockDigest.slice(0, 19)}…`;
    });
  return {
    ...plan,
    ...(plan.responsive
      ? {
          responsive: {
            ...plan.responsive,
            states: plan.responsive.states.map((entry) => ({
              ...entry,
              operations: entry.operations.map((operation) => {
                const rootId = plan.states.find(
                  (state) => state.name === entry.state,
                )?.root.id;
                return operation.kind === "reorder" &&
                  operation.parentId === rootId
                  ? {
                      ...operation,
                      childIds: [
                        ...operation.childIds,
                        `mode-notice-${entry.state}`,
                      ],
                    }
                  : operation;
              }),
            })),
          },
        }
      : {}),
    states: plan.states.map((state) => ({
      ...state,
      root: {
        ...state.root,
        children: [
          ...(state.root.children ?? []),
          {
            tag: "header",
            id: `mode-notice-${state.name}`,
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
  };
}
/** Build both modes from explicit plans without changing canonical artifact schemas. */
export async function buildPrototypeModes(
  store: ArtifactStore,
  supplied: PrototypeModePlan,
  outputRoot: string,
): Promise<PrototypeModeResult> {
  // Snapshot mutable caller intent before the first asynchronous store operation.
  const plan = jsonCopy(
    supplied as unknown as JsonValue,
  ) as unknown as PrototypeModePlan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan))
    fail("INVALID", "Mode plan must be a mapping");
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
    !Array.isArray(plan.currentUses) ||
    !Array.isArray(plan.proposedUses) ||
    !plan.bindings ||
    typeof plan.bindings !== "object" ||
    Array.isArray(plan.bindings) ||
    !plan.decisionContext ||
    typeof plan.decisionContext !== "object" ||
    Array.isArray(plan.decisionContext) ||
    !plan.current ||
    !plan.proposed ||
    typeof plan.comparisonPath !== "string"
  )
    fail("INVALID", "Incomplete mode plan");
  keys(plan.bindings, ["current", "proposed"], "bindings");
  keys(plan.decisionContext, ["kind", "requests"], "decision context");
  if (
    !["live", "historical"].includes(plan.decisionContext.kind) ||
    !Array.isArray(plan.decisionContext.requests) ||
    (plan.decisionContext.kind === "historical" &&
      plan.decisionContext.requests.length)
  )
    fail("INVALID", "Invalid exact decision context");
  plan.decisionContext.requests.forEach(ref);
  if (!same(ref(plan.current.scenario), ref(plan.proposed.scenario)))
    fail("INVALID", "Both modes must use the same exact scenario");
  for (const [name, relative] of [
    ["current", plan.current.outputPath],
    ["proposed", plan.proposed.outputPath],
    ["comparison", plan.comparisonPath],
  ] as const)
    if (typeof relative !== "string" || !ID.test(relative))
      fail("PATH", `${name} path must be one safe directory name`);
  if (
    new Set([
      plan.current.outputPath,
      plan.proposed.outputPath,
      plan.comparisonPath,
    ]).size !== 3
  )
    fail("PATH", "Mode output paths must differ");
  const ids = new Set<string>();
  for (const choice of plan.choices) {
    if (!choice || typeof choice !== "object" || Array.isArray(choice))
      fail("INVALID", "Invalid mode choice");
    keys(choice, ["id", "status", "capability", "systemRequest"], "choice");
    if (
      typeof choice.id !== "string" ||
      !ID.test(choice.id) ||
      ids.has(choice.id) ||
      !STATUSES.includes(choice.status)
    )
      fail("INVALID", "Invalid or duplicate mode choice");
    ids.add(choice.id);
    ref(choice.capability);
    if (choice.status === "current" && choice.systemRequest !== undefined)
      fail("INVALID", "Current choice cannot claim a System Request");
    if (choice.status !== "current") ref(choice.systemRequest);
  }
  for (const [mode, uses] of [
    ["current", plan.currentUses],
    ["proposed", plan.proposedUses],
  ] as const) {
    if (new Set(uses).size !== uses.length || uses.some((id) => !ids.has(id)))
      fail("INVALID", `${mode} uses unknown or duplicate choices`);
  }
  if (
    !plan.currentUses.length ||
    !plan.proposedUses.length ||
    plan.currentUses.some(
      (id) =>
        plan.choices.find((choice) => choice.id === id)?.status !== "current",
    )
  )
    fail("INVALID", "Current mode must use only declared current choices");
  if (plan.currentUses.some((id) => !plan.proposedUses.includes(id)))
    fail("INVALID", "Proposed mode must retain current choices");
  if (!plan.proposedUses.some((id) => !plan.currentUses.includes(id)))
    fail("INVALID", "Proposed mode must declare a noncurrent choice");
  const currentSignatures = boundValues(
    plan.current,
    plan.bindings.current,
    plan.currentUses,
    "current",
    plan.choices,
  );
  const proposedSignatures = boundValues(
    plan.proposed,
    plan.bindings.proposed,
    plan.proposedUses,
    "proposed",
    plan.choices,
  );
  for (const [signature, count] of currentSignatures)
    if ((proposedSignatures.get(signature) ?? 0) < count)
      fail("INVALID", "Proposed mode removes bound Current content or actions");
  const contract = await read(store, plan.contract, "product-ui-contract");
  if (!approved(contract)) fail("UNAPPROVED", "UI contract must be approved");
  const scenario = await read(store, plan.current.scenario, "scenario");
  if (!approved(scenario) || !locks(scenario, plan.contract))
    fail(
      "UNAPPROVED",
      "Scenario must approve and lock the exact Product UI Contract",
    );
  const chosen = plan.choices.filter(
    (choice) =>
      plan.currentUses.includes(choice.id) ||
      plan.proposedUses.includes(choice.id),
  );
  const requestIds = new Set(
    chosen
      .filter((choice) => choice.status !== "current")
      .map((choice) => choice.systemRequest!.artifactId),
  );
  if (
    plan.decisionContext.kind === "live" &&
    plan.decisionContext.requests.some(
      (exact) => !requestIds.has(exact.artifactId),
    )
  )
    fail("INVALID", "Decision context includes an unrelated System Request");
  let fallback: PrototypeModeResult["fallback"];
  for (const choice of chosen) {
    const capability = await read(
      store,
      choice.capability,
      "system-capability",
    );
    const availability = (capability.content as { availability?: string })
      .availability;
    if (choice.status === "current") {
      if (!locks(contract, choice.capability))
        fail(
          "INVALID",
          `Current capability is not locked by the UI Contract: ${choice.id}`,
        );
      if (
        availability !== "current" ||
        !approved(capability) ||
        !inputProvenance(contract, undefined, choice.capability) ||
        !currentEvidence(capability)
      )
        fail(
          "UNAPPROVED",
          `Current capability is not supported and approved: ${choice.id}`,
        );
    } else {
      const request = await read(
        store,
        choice.systemRequest!,
        "system-request",
      );
      if (
        !locks(request, plan.contract) ||
        !locks(capability, choice.systemRequest!) ||
        !inputProvenance(request, "/content/request", plan.contract) ||
        !inputProvenance(
          capability,
          "/content/description",
          choice.systemRequest!,
        ) ||
        (request.content as { changeType?: string }).changeType !== "capability"
      )
        fail(
          "INVALID",
          `System Request is not exactly linked to this product and capability: ${choice.id}`,
        );
      if (availability !== "proposed")
        fail(
          "INVALID",
          `Noncurrent choice must reference proposed capability: ${choice.id}`,
        );
      if (plan.proposedUses.includes(choice.id)) {
        if (plan.decisionContext.kind === "live") {
          const contexts = plan.decisionContext.requests.filter(
            (candidate) =>
              candidate.artifactId === choice.systemRequest!.artifactId,
          );
          if (
            contexts.length !== 1 ||
            contexts[0]!.revision < choice.systemRequest!.revision
          )
            fail(
              "INVALID",
              `Missing current exact decision context for ${choice.id}`,
            );
          const context = await read(store, contexts[0]!, "system-request");
          if (!locks(context, plan.contract))
            fail(
              "INVALID",
              `Decision context is not locked to the UI Contract: ${choice.id}`,
            );
          if (
            context.lifecycle.status === "rejected" ||
            context.approval.status === "rejected"
          )
            fallback = "rejected-system-request";
          else if (!same(contexts[0]!, choice.systemRequest!))
            fail(
              "UNAPPROVED",
              `Proposed choice must adopt the current exact request revision: ${choice.id}`,
            );
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
          fail(
            "UNAPPROVED",
            `Required choice lacks approved request and capability: ${choice.id}`,
          );
        else if (
          choice.status === "proposed" &&
          (!["proposed", "approved"].includes(request.lifecycle.status) ||
            !["proposed", "approved"].includes(capability.lifecycle.status))
        )
          fail(
            "UNAPPROVED",
            `Proposed choice has unsupported request status: ${choice.id}`,
          );
      }
    }
  }
  const digest = `sha256:${createHash("sha256").update(canonicalJson(plan)).digest("hex")}`;
  const base = await realpath(outputRoot);
  const comparisonDirectory = path.join(base, plan.comparisonPath);
  const assertVacant = async () => {
    try {
      await lstat(comparisonDirectory);
      fail("PATH", "Comparison destination already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  await assertVacant();
  const staging = await mkdtemp(path.join(base, ".mimic-modes-"));
  let published = false;
  let current: PrototypeBuildResult;
  let proposed: PrototypeBuildResult | undefined;
  try {
    current = await buildPrototype(store, plan.current, staging);
    if (!fallback) {
      const used = chosen.filter((choice) =>
        plan.proposedUses.includes(choice.id),
      );
      proposed = await buildPrototype(
        store,
        markedPlan(
          plan.proposed,
          used,
          plan.decisionContext.kind === "historical",
        ),
        staging,
      );
    }
    const comparison = {
      kind: "mimic-prototype-mode-comparison",
      productionReady: false,
      modePlanDigest: digest,
      contract: plan.contract,
      scenario: plan.current.scenario,
      choices: chosen,
      decisionContext: plan.decisionContext,
      current: {
        path: plan.current.outputPath,
        planDigest: current.planDigest,
      },
      proposed: proposed
        ? { path: plan.proposed.outputPath, planDigest: proposed.planDigest }
        : null,
      fallback: fallback ?? null,
      review:
        "Authored mode and render plans are not approved by referenced artifact approvals",
    };
    await writeFile(
      path.join(staging, "mode-plan.json"),
      `${canonicalJson(plan)}\n`,
      { flag: "wx" },
    );
    await writeFile(
      path.join(staging, "comparison.json"),
      `${canonicalJson(comparison)}\n`,
      { flag: "wx" },
    );
    await assertVacant();
    await rename(staging, comparisonDirectory);
    published = true;
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
  return {
    modePlanDigest: digest,
    current: {
      ...current,
      directory: path.join(comparisonDirectory, plan.current.outputPath),
    },
    proposed: proposed
      ? {
          ...proposed,
          directory: path.join(comparisonDirectory, plan.proposed.outputPath),
        }
      : undefined,
    fallback,
    comparisonDirectory,
  };
}
