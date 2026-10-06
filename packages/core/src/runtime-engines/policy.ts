import {
  canonicalJson,
  jsonCopy,
  type JsonValue,
} from "../artifact-canonical.js";
import type { ArtifactSnapshot, AuthorityVerifier } from "../artifact-store.js";
import { RuntimeEngineError, type ExactArtifactRef } from "./dependency.js";

export type PropertyPolicy = "locked" | "configurable" | "overridable";
export interface PropertyRule {
  readonly parent: ExactArtifactRef;
  readonly path: string;
  readonly policy: PropertyPolicy;
  readonly value: JsonValue;
  readonly allowedValues?: readonly JsonValue[];
  readonly numericRange?: {
    readonly minimum: number;
    readonly maximum: number;
  };
}
export interface PropertySelection {
  readonly parent: ExactArtifactRef;
  readonly path: string;
  readonly value: JsonValue;
  readonly rationale?: string;
  readonly intent: "propose" | "commit";
  readonly approvalDecisionId?: string;
}
export interface PolicyDecision {
  readonly allowed: boolean;
  readonly effect: "inherit" | "configure" | "override" | "blocked";
  readonly reason: string;
}
export interface PolicyAuthority {
  verifyApproval(
    decisionId: string,
    selection: PropertySelection,
  ): Promise<boolean>;
}

function refSame(a: ExactArtifactRef, b: ExactArtifactRef): boolean {
  return (
    a.artifactId === b.artifactId &&
    a.revision === b.revision &&
    a.lockDigest === b.lockDigest
  );
}
function blocked(reason: string): PolicyDecision {
  return { allowed: false, effect: "blocked", reason };
}

/** Call with the exact verified, approved parent rule; proposal permission is not commit authority. */
export async function evaluatePropertyPolicy(
  rule: PropertyRule,
  selection: PropertySelection,
  authority?: PolicyAuthority,
): Promise<PolicyDecision> {
  if (
    !rule ||
    !selection ||
    !["locked", "configurable", "overridable"].includes(rule.policy) ||
    !["propose", "commit"].includes(selection.intent) ||
    typeof rule.path !== "string" ||
    !rule.path.startsWith("/content/") ||
    !refSame(rule.parent, selection.parent) ||
    rule.path !== selection.path
  )
    throw new RuntimeEngineError(
      "INVALID",
      "Invalid property rule or parent reference",
    );
  // Canonicalization rejects non-JSON values before a rule is evaluated.
  const parentValue = canonicalJson(rule.value);
  const selectedValue = canonicalJson(selection.value);
  if (parentValue === selectedValue)
    return {
      allowed: true,
      effect: "inherit",
      reason: "Approved parent value retained",
    };
  if (rule.policy === "locked")
    return blocked("Locked parent value cannot change at child scope");
  if (!selection.rationale?.trim())
    return blocked("Changed value requires a rationale");
  if (rule.policy === "configurable") {
    const options = rule.allowedValues;
    const range = rule.numericRange;
    if ((!options || options.length === 0) && !range)
      return blocked("Configurable rule has no explicit boundary");
    if (options && (!Array.isArray(options) || options.length === 0))
      throw new RuntimeEngineError("INVALID", "Invalid configurable options");
    options?.forEach((value) => {
      canonicalJson(value);
    });
    if (
      range &&
      (!Number.isFinite(range.minimum) ||
        !Number.isFinite(range.maximum) ||
        range.minimum > range.maximum)
    )
      throw new RuntimeEngineError("INVALID", "Invalid configurable range");
    const inOptions =
      options?.some((value) => canonicalJson(value) === selectedValue) ?? false;
    const inRange =
      range &&
      typeof selection.value === "number" &&
      selection.value >= range.minimum &&
      selection.value <= range.maximum;
    return inOptions || inRange
      ? {
          allowed: true,
          effect: "configure",
          reason: "Value is within approved boundary",
        }
      : blocked("Value is outside approved configurable boundary");
  }
  if (selection.intent === "propose")
    return {
      allowed: true,
      effect: "override",
      reason: "Override is proposal only",
    };
  if (!selection.approvalDecisionId?.trim() || !authority)
    return blocked("Durable override requires verified human approval");
  try {
    return (await authority.verifyApproval(
      selection.approvalDecisionId,
      jsonCopy(selection),
    ))
      ? { allowed: true, effect: "override", reason: "Human-approved override" }
      : blocked("Override approval could not be verified");
  } catch {
    return blocked("Override approval could not be verified");
  }
}

export interface RevisionGuardInput {
  readonly previous: ArtifactSnapshot;
  readonly next: ArtifactSnapshot;
  readonly action: "propose" | "approve";
  readonly authority?: AuthorityVerifier;
}

/** Additional guard before publication; ArtifactStore remains the final append-only authority. */
export async function guardArtifactRevision(
  input: RevisionGuardInput,
): Promise<PolicyDecision> {
  if (!input?.previous?.meta || !input.next?.meta)
    throw new RuntimeEngineError("INVALID", "Both snapshots are required");
  const { previous, next, action } = input;
  if (
    previous.meta.id !== next.meta.id ||
    previous.meta.type !== next.meta.type
  )
    return blocked("Artifact identity and type must remain stable");
  if (
    next.meta.revision !== previous.meta.revision + 1 ||
    next.meta.supersedesRevision !== previous.meta.revision
  )
    return blocked(
      "Approved and published snapshots require a new consecutive revision",
    );
  if (action === "propose") {
    if (
      next.lifecycle.status !== "proposed" ||
      next.approval.status !== "pending"
    )
      return blocked("A proposed revision must have pending approval");
    return {
      allowed: true,
      effect: "override",
      reason: "New proposal preserves prior snapshot",
    };
  }
  if (
    action === "approve" &&
    next.lifecycle.status === "approved" &&
    next.approval.status === "approved" &&
    next.approval.decisionId &&
    input.authority
  ) {
    try {
      if (
        await input.authority.verifyApproval(
          jsonCopy(next.approval),
          jsonCopy(next),
        )
      )
        return {
          allowed: true,
          effect: "override",
          reason: "Verified approval applies to new revision",
        };
    } catch {
      // Fail closed when authority is unavailable.
    }
  }
  return blocked("Approval requires verified authority for the new revision");
}
