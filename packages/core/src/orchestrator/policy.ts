import { AsyncLocalStorage } from "node:async_hooks";
import {
  canonicalJson,
  jsonCopy,
  type JsonValue,
} from "../artifact-canonical.js";
import type {
  ArtifactSnapshot,
  ArtifactStore,
  ScopeNode,
} from "../artifact-store.js";
import {
  evaluatePropertyPolicy,
  type PolicyAuthority,
  type PropertyRule,
} from "../runtime-engines/policy.js";
import {
  DependencyGraph,
  type ExactArtifactRef,
} from "../runtime-engines/dependency.js";
import type {
  CommitRequest,
  DecisionRecord,
  Proposal,
  RegistryAuthority,
  RegistryState,
} from "../run-registry/registry.js";

export interface GovernanceRule extends Omit<PropertyRule, "parent"> {
  readonly targetAssetKind: string;
  readonly targetName?: string;
}
export interface PolicyCheck {
  readonly scopeOwnerId: string;
  readonly targetAssetKind: string;
  readonly targetName: string;
  readonly path: string;
  readonly value: JsonValue;
  readonly intent: "propose" | "commit";
  readonly rationale?: string;
  readonly approvalDecisionId?: string;
}
export interface ResolvedPolicy {
  readonly allowed: boolean;
  readonly reason: string;
  readonly sources: readonly ExactArtifactRef[];
}
const levels = ["organization", "product", "domain", "local"] as const;
const deny = (
  reason: string,
  sources: readonly ExactArtifactRef[] = [],
): ResolvedPolicy => ({ allowed: false, reason, sources });
const object = (x: unknown): Record<string, unknown> | undefined =>
  x && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : undefined;
const same = (a: unknown, b: unknown): boolean =>
  canonicalJson(a) === canonicalJson(b);

function ancestors(scopes: readonly ScopeNode[], ownerId: string): ScopeNode[] {
  const byId = new Map(scopes.map((scope) => [scope.ownerId, scope]));
  const chain: ScopeNode[] = [];
  let node = byId.get(ownerId);
  while (node) {
    if (chain.some((prior) => prior.ownerId === node!.ownerId))
      throw new Error("Cyclic scope ancestry");
    chain.unshift(node);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  if (
    !chain.length ||
    chain.some(
      (item, index) =>
        item.level !== levels[index] ||
        (index > 0 && item.parentId !== chain[index - 1].ownerId),
    )
  )
    throw new Error("Invalid scope ancestry");
  return chain;
}

function rules(
  artifact: ArtifactSnapshot,
): readonly GovernanceRule[] | undefined {
  const content = object(artifact.content);
  if (
    artifact.meta.type !== "design-system-asset" ||
    content?.assetKind !== "governance"
  )
    return undefined;
  const values = object(content.definition)?.rules;
  if (!Array.isArray(values) || !values.length)
    throw new Error("Governance definition needs rules");
  for (const item of values) {
    const rule = object(item);
    if (
      !rule ||
      typeof rule.targetAssetKind !== "string" ||
      (rule.targetName !== undefined && typeof rule.targetName !== "string") ||
      typeof rule.path !== "string" ||
      !rule.path.startsWith("/content/definition/") ||
      !["locked", "configurable", "overridable"].includes(
        String(rule.policy),
      ) ||
      !Object.hasOwn(rule, "value")
    )
      throw new Error("Invalid governance rule");
    canonicalJson(rule.value);
  }
  const keys = values.map(
    (item) => `${item.targetAssetKind}:${item.targetName ?? "*"}:${item.path}`,
  );
  if (new Set(keys).size !== keys.length)
    throw new Error("Duplicate governance rule");
  return values as GovernanceRule[];
}
function matches(
  rule: GovernanceRule,
  check: Pick<PolicyCheck, "targetAssetKind" | "targetName" | "path">,
): boolean {
  return (
    rule.path === check.path &&
    rule.targetAssetKind === check.targetAssetKind &&
    (rule.targetName === undefined || rule.targetName === check.targetName)
  );
}
function inBoundary(rule: GovernanceRule, value: JsonValue): boolean {
  if (rule.allowedValues && rule.numericRange) return false;
  if (rule.allowedValues)
    return rule.allowedValues.some((option) => same(option, value));
  return (
    !!rule.numericRange &&
    typeof value === "number" &&
    value >= rule.numericRange.minimum &&
    value <= rule.numericRange.maximum
  );
}
function narrows(parent: GovernanceRule, child: GovernanceRule): boolean {
  if (parent.policy === "locked")
    return child.policy === "locked" && same(parent.value, child.value);
  if (parent.policy === "overridable") return true;
  if (child.policy === "overridable" || !inBoundary(parent, child.value))
    return false;
  if (child.policy === "locked") return true;
  if (child.allowedValues)
    return child.allowedValues.every((value) => inBoundary(parent, value));
  return (
    !!child.numericRange &&
    !!parent.numericRange &&
    child.numericRange.minimum >= parent.numericRange.minimum &&
    child.numericRange.maximum <= parent.numericRange.maximum
  );
}
function pointer(root: unknown, path: string): unknown {
  let value: unknown = root;
  for (const encoded of path.slice(1).split("/")) {
    if (/~(?![01])/.test(encoded)) return undefined;
    value = object(value)?.[encoded.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return value;
}

/** Never accepts a caller's rule as authority: exact approved canonical ancestry is the source. */
async function resolvePolicy(
  store: ArtifactStore,
  state: Readonly<RegistryState>,
  scopes: readonly ScopeNode[],
  check: PolicyCheck,
  authority?: PolicyAuthority,
  excludeArtifactId?: string,
): Promise<ResolvedPolicy> {
  let chain: ScopeNode[];
  try {
    state = jsonCopy(state);
    scopes = jsonCopy(scopes);
    check = structuredClone(check);
    if (
      !check ||
      typeof check.targetAssetKind !== "string" ||
      !check.targetAssetKind.trim() ||
      typeof check.targetName !== "string" ||
      typeof check.path !== "string" ||
      !check.path.startsWith("/content/definition/") ||
      !["propose", "commit"].includes(check.intent)
    )
      return deny("Invalid property context");
    canonicalJson(check.value);
    chain = ancestors(scopes, check.scopeOwnerId);
  } catch {
    return deny("Invalid target scope ancestry");
  }
  const found: {
    ref: ExactArtifactRef;
    rule: GovernanceRule;
    depth: number;
  }[] = [];
  try {
    for (const selected of Object.values(state.canonical)) {
      const ref = selected.ref;
      if (ref.artifactId === excludeArtifactId) continue;
      const snapshot = await store.read(ref.artifactId, ref.revision);
      if (snapshot.digest !== ref.lockDigest)
        return deny("Canonical lock mismatch");
      const governance = rules(snapshot.artifact);
      if (!governance) continue;
      const depth = chain.findIndex(
        (scope) => scope.ownerId === snapshot.artifact.scope.ownerId,
      );
      if (depth < 0) continue;
      for (const rule of governance)
        if (matches(rule, check)) {
          if (
            snapshot.artifact.lifecycle.status !== "approved" ||
            snapshot.artifact.approval.status !== "approved" ||
            snapshot.artifact.lifecycle.freshness !== "valid" ||
            state.freshness[ref.artifactId]
          )
            return deny("Governance source is not fresh and approved", [ref]);
          const graph = await DependencyGraph.load(store, [ref]);
          for (const lockedRef of graph.order) {
            const node = graph.get(lockedRef);
            if (
              !node ||
              node.artifact.lifecycle.status !== "approved" ||
              node.artifact.lifecycle.freshness !== "valid" ||
              state.freshness[lockedRef.artifactId]
            )
              return deny(
                "Governance transitive lock is not fresh and approved",
                [ref],
              );
            for (const dependency of node.artifact.dependencies) {
              const current = state.canonical[dependency.artifactId]?.ref;
              if (
                current &&
                !same(current, {
                  artifactId: dependency.artifactId,
                  revision: dependency.revision,
                  lockDigest: dependency.lockDigest,
                }) &&
                dependency.onChange !== "none"
              )
                return deny("Governance transitive dependency changed", [ref]);
            }
          }
          found.push({ ref, rule, depth });
        }
    }
  } catch {
    return deny("Governance source or exact lock cannot be verified");
  }
  if (!found.length) return deny("No applicable approved governance rule");
  found.sort(
    (a, b) =>
      a.depth - b.depth || a.ref.artifactId.localeCompare(b.ref.artifactId),
  );
  const sources = found.map(({ ref }) => ref);
  if (new Set(found.map(({ depth }) => depth)).size !== found.length)
    return deny("Ambiguous rules at one scope", sources);
  for (let i = 1; i < found.length; i++)
    if (!narrows(found[i - 1].rule, found[i].rule))
      return deny("Child rule weakens inherited restriction", sources);
  for (const { ref, rule } of found) {
    let decision;
    try {
      decision = await evaluatePropertyPolicy(
        { ...rule, parent: ref },
        {
          parent: ref,
          path: check.path,
          value: check.value,
          intent: check.intent,
          rationale: check.rationale,
          approvalDecisionId: check.approvalDecisionId,
        },
        authority,
      );
    } catch {
      return deny("Invalid approved governance boundary", sources);
    }
    if (!decision.allowed) return deny(decision.reason, sources);
  }
  return {
    allowed: true,
    reason: "Approved ancestor policy permits selection",
    sources,
  };
}

export function resolveApprovedPolicy(
  store: ArtifactStore,
  state: Readonly<RegistryState>,
  scopes: readonly ScopeNode[],
  check: PolicyCheck,
  authority?: PolicyAuthority,
): Promise<ResolvedPolicy> {
  return resolvePolicy(store, state, scopes, check, authority);
}

/** Wrap the authority passed to BOTH RunRegistry and ArtifactStorePublication. */
export class GovernedRegistryAuthority implements RegistryAuthority {
  private store?: ArtifactStore;
  private readonly scopeNodes: readonly ScopeNode[];
  private readonly commitContext = new AsyncLocalStorage<CommitRequest>();
  constructor(
    private readonly delegate: RegistryAuthority,
    scopes: readonly ScopeNode[],
    private readonly policyAuthority?: PolicyAuthority,
  ) {
    this.scopeNodes = Object.freeze(
      jsonCopy(scopes).map((scope) => Object.freeze(scope)),
    );
  }
  withCommit<T>(request: CommitRequest, effect: () => Promise<T>): Promise<T> {
    return this.commitContext.run(jsonCopy(request), effect);
  }
  bind(store: ArtifactStore): void {
    if (this.store) throw new Error("Already bound");
    this.store = store;
  }
  verify(record: DecisionRecord, proposal: Proposal): Promise<boolean> {
    return this.delegate.verify(record, proposal);
  }
  verifyResolutionDecision(
    ...args: Parameters<
      NonNullable<RegistryAuthority["verifyResolutionDecision"]>
    >
  ): Promise<boolean> {
    return (
      this.delegate.verifyResolutionDecision?.(...args) ??
      Promise.resolve(false)
    );
  }
  verifyEvidence(
    ...args: Parameters<NonNullable<RegistryAuthority["verifyEvidence"]>>
  ): Promise<boolean> {
    return this.delegate.verifyEvidence?.(...args) ?? Promise.resolve(false);
  }
  verifyResolution(
    ...args: Parameters<NonNullable<RegistryAuthority["verifyResolution"]>>
  ): Promise<boolean> {
    return this.delegate.verifyResolution?.(...args) ?? Promise.resolve(false);
  }
  async allowCommit(
    record: DecisionRecord,
    proposal: Proposal,
    state: Readonly<RegistryState>,
  ): Promise<boolean> {
    const request = this.commitContext.getStore();
    if (
      !this.store ||
      !request ||
      request.packetId !== record.packetId ||
      !request.approvals.some(
        (item) =>
          item.decisionId === record.id && item.proposalId === proposal.id,
      ) ||
      !record.output ||
      !(await this.delegate.allowCommit(record, proposal, state))
    )
      return false;
    const artifact = record.output.artifact;
    const named = request.approvals.map(
      (item) => state.decisions[item.decisionId],
    );
    if (
      named.some(
        (decision) =>
          !decision?.output ||
          decision.packetId !== request.packetId ||
          decision.outcome !== "approved",
      )
    )
      return false;
    const namedGovernance = named.filter(
      (decision) =>
        object(decision.output!.artifact.content)?.assetKind === "governance",
    );
    try {
      for (let i = 0; i < namedGovernance.length; i++)
        for (let j = i + 1; j < namedGovernance.length; j++) {
          const a = namedGovernance[i].output!.artifact;
          const b = namedGovernance[j].output!.artifact;
          const aRules = rules(a) ?? [];
          const bRules = rules(b) ?? [];
          const aChain = ancestors(this.scopeNodes, a.scope.ownerId).map(
            (scope) => scope.ownerId,
          );
          const bChain = ancestors(this.scopeNodes, b.scope.ownerId).map(
            (scope) => scope.ownerId,
          );
          for (const left of aRules)
            for (const right of bRules) {
              if (
                left.targetAssetKind !== right.targetAssetKind ||
                left.path !== right.path ||
                (left.targetName !== undefined &&
                  right.targetName !== undefined &&
                  left.targetName !== right.targetName)
              )
                continue;
              if (a.scope.ownerId === b.scope.ownerId) return false;
              if (bChain.includes(a.scope.ownerId) && !narrows(left, right))
                return false;
              if (aChain.includes(b.scope.ownerId) && !narrows(right, left))
                return false;
            }
        }
    } catch {
      return false;
    }
    if (artifact.meta.type !== "design-system-asset") return true;
    const content = object(artifact.content);
    if (
      !content ||
      typeof content.assetKind !== "string" ||
      typeof content.name !== "string"
    )
      return false;
    try {
      if (
        content.assetKind !== "governance" &&
        namedGovernance.some((decision) =>
          (rules(decision.output!.artifact) ?? []).some(
            (rule) =>
              rule.targetAssetKind === content.assetKind &&
              (rule.targetName === undefined ||
                rule.targetName === content.name) &&
              pointer(artifact, rule.path) !== undefined &&
              ancestors(this.scopeNodes, artifact.scope.ownerId).some(
                (scope) =>
                  scope.ownerId === decision.output!.artifact.scope.ownerId,
              ),
          ),
        )
      )
        return false;
      const locksSource = (source: ExactArtifactRef): boolean =>
        artifact.dependencies.some(
          (dependency) =>
            dependency.artifactId === source.artifactId &&
            dependency.revision === source.revision &&
            dependency.lockDigest === source.lockDigest,
        );
      const newRules =
        content.assetKind === "governance" ? (rules(artifact) ?? []) : [];
      const definition = object(content.definition);
      if (!definition) return false;
      const selected = definition.propertySelections;
      if (selected !== undefined && !Array.isArray(selected)) return false;
      const annotations = new Map<string, Record<string, unknown>>();
      for (const item of (selected ?? []) as unknown[]) {
        const value = object(item);
        if (
          !value ||
          typeof value.path !== "string" ||
          annotations.has(value.path)
        )
          return false;
        annotations.set(value.path, value);
      }
      const target = {
        scopeOwnerId: artifact.scope.ownerId,
        targetAssetKind: content.assetKind,
        targetName: content.name,
      };
      const paths = new Set(annotations.keys());
      const ancestorsForTarget = ancestors(
        this.scopeNodes,
        target.scopeOwnerId,
      ).map((scope) => scope.ownerId);
      const inherited: { rule: GovernanceRule; depth: number }[] = [];
      for (const selectedSource of Object.values(state.canonical)) {
        const source = await this.store.read(
          selectedSource.ref.artifactId,
          selectedSource.ref.revision,
        );
        if (source.digest !== selectedSource.ref.lockDigest) return false;
        const depth = ancestorsForTarget.indexOf(source.artifact.scope.ownerId);
        for (const rule of rules(source.artifact) ?? []) {
          if (selectedSource.ref.artifactId === artifact.meta.id) continue;
          if (depth >= 0) inherited.push({ rule, depth });
          if (depth >= 0 && matches(rule, { ...target, path: rule.path }))
            paths.add(rule.path);
        }
      }
      for (const rule of newRules) {
        const overlapping = inherited.filter(
          (item) =>
            item.rule.targetAssetKind === rule.targetAssetKind &&
            item.rule.path === rule.path &&
            (item.rule.targetName === undefined ||
              rule.targetName === undefined ||
              item.rule.targetName === rule.targetName),
        );
        if (
          overlapping.some(
            (item) => item.depth === ancestorsForTarget.length - 1,
          )
        )
          return false;
        const parents = overlapping.filter(
          (item) => item.depth < ancestorsForTarget.length - 1,
        );
        if (parents.some((item) => !narrows(item.rule, rule))) return false;
        if (parents.length) {
          const checked = await resolvePolicy(
            this.store,
            state,
            this.scopeNodes,
            {
              scopeOwnerId: artifact.scope.ownerId,
              targetAssetKind: rule.targetAssetKind,
              targetName: rule.targetName ?? "",
              path: rule.path,
              value: rule.value,
              intent: "commit",
              rationale: "Proposed child governance rule",
              approvalDecisionId: record.id,
            },
            {
              verifyApproval: async (id, selection) =>
                id === record.id &&
                selection.approvalDecisionId === record.id &&
                (await this.delegate.verify(record, proposal)) &&
                ((await this.policyAuthority?.verifyApproval(id, selection)) ??
                  true),
            },
            artifact.meta.id,
          );
          if (!checked.allowed || !checked.sources.every(locksSource))
            return false;
        }
      }
      for (const path of paths) {
        const value = pointer(artifact, path);
        if (value === undefined) return false;
        const note = annotations.get(path);
        if (
          note?.approvalDecisionId !== undefined &&
          note.approvalDecisionId !== record.id
        )
          return false;
        const result = await resolvePolicy(
          this.store,
          state,
          this.scopeNodes,
          {
            ...target,
            path,
            value: value as JsonValue,
            intent: "commit",
            rationale: note?.rationale as string | undefined,
            approvalDecisionId: note?.approvalDecisionId as string | undefined,
          },
          {
            verifyApproval: async (id, selection) =>
              id === record.id &&
              selection.approvalDecisionId === record.id &&
              (await this.delegate.verify(record, proposal)) &&
              ((await this.policyAuthority?.verifyApproval(id, selection)) ??
                true),
          },
        );
        if (!result.allowed || !result.sources.every(locksSource)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}
