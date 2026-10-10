import type { RoutedTask, ScopeNode } from "@mimic/core";

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new PlanError(message);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty);
}
function only(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function ref(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    only(value, ["artifactId", "revision", "lockDigest"]) &&
    typeof value.artifactId === "string" &&
    /^art_[A-Za-z0-9_-]+$/.test(value.artifactId) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) > 0 &&
    typeof value.lockDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value.lockDigest)
  );
}
function need(value: unknown): boolean {
  if (!record(value) || !nonempty(value.name)) return false;
  if (value.kind === "artifact")
    return (
      only(value, [
        "kind",
        "name",
        "artifactType",
        "schemaVersion",
        "refs",
        "refsFromTask",
      ]) &&
      nonempty(value.artifactType) &&
      (value.schemaVersion === undefined || nonempty(value.schemaVersion)) &&
      (value.refsFromTask === undefined || nonempty(value.refsFromTask)) &&
      !(value.refs !== undefined && value.refsFromTask !== undefined) &&
      (value.refs === undefined ||
        (Array.isArray(value.refs) &&
          value.refs.length > 0 &&
          value.refs.every(ref) &&
          new Set(
            value.refs.map((item: { artifactId: string }) => item.artifactId),
          ).size === value.refs.length))
    );
  return (
    (value.kind === "human-brief" || value.kind === "evidence-file") &&
    only(value, ["kind", "name"])
  );
}
function inputs(value: unknown): boolean {
  if (!record(value) || !only(value, ["required", "optional", "alternatives"]))
    return false;
  return (
    Array.isArray(value.required) &&
    value.required.every(need) &&
    Array.isArray(value.optional) &&
    value.optional.every(need) &&
    Array.isArray(value.alternatives) &&
    value.alternatives.every(
      (group: unknown) =>
        record(group) &&
        only(group, ["oneOf"]) &&
        Array.isArray(group.oneOf) &&
        group.oneOf.length > 0 &&
        group.oneOf.every(need),
    )
  );
}

export function scopeChain(
  scopes: readonly ScopeNode[],
  ownerId: string,
): readonly string[] {
  const byId = new Map(scopes.map((scope) => [scope.ownerId, scope]));
  check(byId.size === scopes.length, "Duplicate scope owner ID");
  const chain: ScopeNode[] = [];
  const seen = new Set<string>();
  let node = byId.get(ownerId);
  check(node, `Unknown scope ${ownerId}`);
  while (node) {
    check(!seen.has(node.ownerId), "Scope ancestry cycle");
    seen.add(node.ownerId);
    chain.unshift(node);
    if (!node.parentId) break;
    node = byId.get(node.parentId);
    check(node, "Missing scope parent");
  }
  check(
    chain[0]?.level === "organization" && !chain[0].parentId,
    "Scope must descend from an organization",
  );
  const ranks: Record<ScopeNode["level"], number> = {
    organization: 0,
    product: 1,
    domain: 2,
    local: 3,
  };
  for (let i = 1; i < chain.length; i++)
    check(
      ranks[chain[i - 1]!.level] < ranks[chain[i]!.level],
      "Invalid scope hierarchy",
    );
  return chain.map((scope) => scope.ownerId);
}

export function preflightPlan(
  value: unknown,
  scopes: readonly ScopeNode[],
  runScope: string,
): RoutedTask[] {
  check(Array.isArray(value), "Tasks must be a JSON array");
  const chain = scopeChain(scopes, runScope);
  const ids = new Set<string>();
  for (const entry of value) {
    check(record(entry), "Each task must be an object");
    check(
      only(entry, [
        "id",
        "skillId",
        "outputType",
        "additionalOutputTypes",
        "scopeOwnerId",
        "targetArtifactId",
        "revisionBase",
        "proposalIds",
        "dependsOn",
        "inputs",
        "intent",
        "authority",
        "humanBrief",
        "evidenceFiles",
        "assumptions",
        "uncertainties",
      ]),
      "Unknown task field",
    );
    check(nonempty(entry.id), "Task ID is required");
    check(!ids.has(entry.id), "Duplicate task ID");
    ids.add(entry.id);
    check(
      typeof entry.skillId === "string" &&
        /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(entry.skillId),
      "Invalid static Skill ID",
    );
    check(nonempty(entry.outputType), "Output type is required");
    check(
      entry.additionalOutputTypes === undefined ||
        strings(entry.additionalOutputTypes),
      "Invalid additional output types",
    );
    check(
      nonempty(entry.scopeOwnerId) && chain.includes(entry.scopeOwnerId),
      "Task scope outside Run ancestry",
    );
    check(
      entry.targetArtifactId === undefined ||
        (typeof entry.targetArtifactId === "string" &&
          /^art_[A-Za-z0-9_-]+$/.test(entry.targetArtifactId)),
      "Invalid target artifact ID",
    );
    check(
      entry.revisionBase === undefined ||
        (record(entry.revisionBase) &&
          only(entry.revisionBase, [
            "ref",
            "sourceRunId",
            "decisionId",
            "selectionId",
          ]) &&
          ref(entry.revisionBase.ref) &&
          nonempty(entry.revisionBase.sourceRunId) &&
          ((nonempty(entry.revisionBase.decisionId) &&
            entry.revisionBase.selectionId === undefined) ||
            (nonempty(entry.revisionBase.selectionId) &&
              entry.revisionBase.decisionId === undefined)) &&
          entry.intent === "revise" &&
          entry.skillId === "mimic.s10.design-direction-generator" &&
          entry.targetArtifactId ===
            (entry.revisionBase.ref as { artifactId: string }).artifactId),
      "Invalid selected revision base",
    );
    check(
      entry.proposalIds === undefined || strings(entry.proposalIds),
      "Invalid proposal IDs",
    );
    check(
      entry.dependsOn === undefined || strings(entry.dependsOn),
      "Invalid task dependencies",
    );
    check(inputs(entry.inputs), "Invalid task input groups");
    check(
      ["use", "revise", "create"].includes(entry.intent as string),
      "Invalid task intent",
    );
    check(
      ["AUTONOMOUS", "PROPOSE_ONLY"].includes(entry.authority as string),
      "Invalid task authority",
    );
    check(
      entry.humanBrief === undefined || typeof entry.humanBrief === "string",
      "Invalid human brief",
    );
    check(
      entry.evidenceFiles === undefined || strings(entry.evidenceFiles),
      "Invalid evidence files",
    );
    check(
      entry.assumptions === undefined || strings(entry.assumptions),
      "Invalid assumptions",
    );
    check(
      entry.uncertainties === undefined ||
        (Array.isArray(entry.uncertainties) &&
          entry.uncertainties.every(
            (item: unknown) =>
              record(item) &&
              only(item, ["kind", "reason", "affectedTaskIds"]) &&
              ["assumption", "hypothesis", "blocking-unknown"].includes(
                item.kind as string,
              ) &&
              nonempty(item.reason) &&
              strings(item.affectedTaskIds),
          )),
      "Invalid uncertainties",
    );
  }
  const byId = new Map(value.map((entry: { id: string }) => [entry.id, entry]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    check(!visiting.has(id), "Task dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    const entry = byId.get(id) as { dependsOn?: string[] };
    for (const dependency of entry.dependsOn ?? []) {
      check(byId.has(dependency), `Missing task ${dependency}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  for (const entry of value) {
    for (const need of [
      ...entry.inputs.required,
      ...entry.inputs.optional,
      ...entry.inputs.alternatives.flatMap(
        (group: { oneOf: Record<string, unknown>[] }) => group.oneOf,
      ),
    ]) {
      if (need.kind !== "artifact" || !need.refsFromTask) continue;
      const producer = byId.get(need.refsFromTask) as
        { outputType: string; additionalOutputTypes?: string[] } | undefined;
      check(
        producer &&
          producer !== entry &&
          entry.dependsOn?.includes(need.refsFromTask) &&
          [
            producer.outputType,
            ...(producer.additionalOutputTypes ?? []),
          ].includes(need.artifactType),
        "Invalid producer output binding",
      );
    }
    for (const item of entry.uncertainties ?? [])
      for (const affected of item.affectedTaskIds)
        check(ids.has(affected), `Unknown affected task ${affected}`);
  }
  return value as RoutedTask[];
}
