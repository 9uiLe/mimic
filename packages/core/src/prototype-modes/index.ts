import { createHash } from "node:crypto";
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
} from "../prototype-builder/index.js";
import {
  publishPrototypeBundle,
  PrototypeOutputError,
} from "../prototype-builder/output.js";

export type ModeChoiceStatus =
  "current" | "required" | "proposed" | "unresolved";
export interface ModeChoice {
  readonly id: string;
  readonly status: ModeChoiceStatus;
  readonly capability: ExactArtifactRef;
  readonly systemRequest?: ExactArtifactRef;
}
/** Authored comparison input. Its digest records intent, not human approval. */
export interface PrototypeModePlan {
  readonly contract: ExactArtifactRef;
  readonly choices: readonly ModeChoice[];
  readonly currentUses: readonly string[];
  readonly proposedUses: readonly string[];
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
/** Add exact request provenance and status as escaped text to every proposed state. */
function markedPlan(
  plan: PrototypeBuilderInput,
  choices: readonly ModeChoice[],
): PrototypeBuilderInput {
  const notices = choices
    .filter((choice) => choice.status !== "current")
    .map((choice) => {
      const request = choice.systemRequest!;
      const status =
        choice.status === "required"
          ? "Approved requirement, not implemented"
          : "Proposed, not implemented";
      return `${status}: ${choice.id}; System Request ${request.artifactId}@${request.revision}#${request.lockDigest}`;
    });
  return {
    ...plan,
    states: plan.states.map((state) => ({
      ...state,
      root: {
        ...state.root,
        children: [
          {
            tag: "section",
            children: [
              { tag: "h2", text: "System mode: Proposed" },
              ...notices.map((text) => ({ tag: "p" as const, text })),
            ],
          },
          ...(state.root.children ?? []),
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
    !plan.current ||
    !plan.proposed ||
    typeof plan.comparisonPath !== "string"
  )
    fail("INVALID", "Incomplete mode plan");
  if (!same(ref(plan.current.scenario), ref(plan.proposed.scenario)))
    fail("INVALID", "Both modes must use the same exact scenario");
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
  const contract = await read(store, plan.contract, "product-ui-contract");
  if (!approved(contract)) fail("UNAPPROVED", "UI contract must be approved");
  const chosen = plan.choices.filter(
    (choice) =>
      plan.currentUses.includes(choice.id) ||
      plan.proposedUses.includes(choice.id),
  );
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
      if (
        availability !== "current" ||
        !approved(capability) ||
        !Array.isArray(
          (capability.content as { supportingEvidence?: unknown })
            .supportingEvidence,
        )
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
      if (availability !== "proposed")
        fail(
          "INVALID",
          `Noncurrent choice must reference proposed capability: ${choice.id}`,
        );
      if (plan.proposedUses.includes(choice.id)) {
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
  const current = await buildPrototype(store, plan.current, outputRoot);
  let proposed: PrototypeBuildResult | undefined;
  if (!fallback) {
    const used = chosen.filter((choice) =>
      plan.proposedUses.includes(choice.id),
    );
    proposed = await buildPrototype(
      store,
      markedPlan(plan.proposed, used),
      outputRoot,
    );
  }
  const comparison = {
    kind: "mimic-prototype-mode-comparison",
    productionReady: false,
    modePlanDigest: digest,
    contract: plan.contract,
    scenario: plan.current.scenario,
    choices: chosen,
    current: { path: plan.current.outputPath, planDigest: current.planDigest },
    proposed: proposed
      ? { path: plan.proposed.outputPath, planDigest: proposed.planDigest }
      : null,
    fallback: fallback ?? null,
    review:
      "Authored mode and render plans are not approved by referenced artifact approvals",
  };
  let comparisonDirectory: string;
  try {
    comparisonDirectory = await publishPrototypeBundle(
      outputRoot,
      plan.comparisonPath,
      {
        "mode-plan.json": `${canonicalJson(plan)}\n`,
        "comparison.json": `${canonicalJson(comparison)}\n`,
      },
    );
  } catch (error) {
    if (error instanceof PrototypeOutputError) fail("PATH", error.message);
    throw error;
  }
  return {
    modePlanDigest: digest,
    current,
    proposed,
    fallback,
    comparisonDirectory,
  };
}
