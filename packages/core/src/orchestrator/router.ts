import { canonicalJson, jsonCopy } from "../artifact-canonical.js";
import {
  ArtifactStore,
  type ArtifactSnapshot,
  type AuthorityVerifier,
  type ScopeNode,
} from "../artifact-store.js";
import type { SchemaRegistry } from "../schema-registry.js";
import {
  ArtifactStorePublication,
  RegistryAuthorityVerifier,
} from "../run-registry/publication.js";
import {
  RunRegistry,
  type Actor,
  type CommitRequest,
  type Proposal,
  type RegistryAuthority,
  type Run,
  type RunState,
} from "../run-registry/registry.js";
import type { ExactArtifactRef } from "../runtime-engines/dependency.js";
import { assessProvenance } from "../runtime-engines/provenance.js";
import type { PolicyAuthority } from "../runtime-engines/policy.js";
import { FileWorkspaceStorage } from "../workspace-transaction.js";
import {
  GovernedRegistryAuthority,
  resolveApprovedPolicy,
  type PolicyCheck,
  type ResolvedPolicy,
} from "./policy.js";

export type RouteAction =
  "USE" | "UPDATE" | "GENERATE" | "REQUEST_DECISION" | "BLOCK" | "IGNORE";
export type InputNeed =
  | {
      readonly kind: "artifact";
      readonly name: string;
      readonly artifactType: string;
      readonly schemaVersion?: string;
      /** Explicit exact bindings when a task needs named or multiple assets. */
      readonly refs?: readonly ExactArtifactRef[];
      /** Bind every matching exact output from a completed task in this Run. */
      readonly refsFromTask?: string;
    }
  | { readonly kind: "human-brief"; readonly name: string }
  | { readonly kind: "evidence-file"; readonly name: string };
export interface InputGroups {
  readonly required: readonly InputNeed[];
  readonly optional: readonly InputNeed[];
  readonly alternatives: readonly { readonly oneOf: readonly InputNeed[] }[];
}
/** Runtime transport only; the static Skill manifest does not declare execution authority. */
export interface RoutedTask {
  readonly id: string;
  readonly skillId: string;
  readonly outputType: string;
  readonly additionalOutputTypes?: readonly string[];
  readonly scopeOwnerId: string;
  readonly targetArtifactId?: string;
  readonly proposalIds?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly inputs: InputGroups;
  readonly intent: "use" | "revise" | "create";
  readonly authority: "AUTONOMOUS" | "PROPOSE_ONLY";
  readonly humanBrief?: string;
  readonly evidenceFiles?: readonly string[];
  readonly assumptions?: readonly string[];
  readonly uncertainties?: readonly {
    readonly kind: "assumption" | "hypothesis" | "blocking-unknown";
    readonly reason: string;
    readonly affectedTaskIds: readonly string[];
  }[];
}
export interface SkillInvocation {
  readonly runId: string;
  readonly taskId: string;
  readonly skillId: string;
  readonly allowedOutputTypes: readonly string[];
  readonly targetArtifactId?: string;
  readonly intent: RoutedTask["intent"];
  readonly scopeOwnerId: string;
  readonly inputRefs: readonly ExactArtifactRef[];
  readonly inputBindings: readonly {
    readonly name: string;
    readonly refs: readonly ExactArtifactRef[];
  }[];
  readonly humanBrief?: string;
  readonly evidenceFiles: readonly string[];
  readonly assumptions: readonly string[];
  readonly authority: RoutedTask["authority"];
}
export interface RoutedAction {
  readonly taskId: string;
  readonly action: RouteAction;
  readonly reason: string;
  readonly ref?: ExactArtifactRef;
  readonly invocation?: SkillInvocation;
  readonly gaps?: readonly string[];
  readonly blockKind?: "transient" | "durable";
}
export interface NextActions {
  readonly runId: string;
  readonly state: RunState;
  readonly actions: readonly RoutedAction[];
  readonly commitPoints: readonly {
    packetId: string;
    proposalIds: readonly string[];
  }[];
  readonly blockers: Readonly<Record<string, string>>;
  readonly evidenceGaps: readonly {
    artifactId: string;
    path: string;
    reason: string;
  }[];
}
export interface SkillResult {
  readonly runId: string;
  readonly taskId: string;
  readonly skillId: string;
  readonly inputRefs: readonly ExactArtifactRef[];
  readonly outputRefs: readonly ExactArtifactRef[];
  readonly blocked?: {
    readonly reason: string;
    readonly affectedTaskIds: readonly string[];
  };
  readonly proposal?: {
    readonly packetId: string;
    readonly items: readonly Omit<
      Proposal,
      "packetId" | "status" | "readiness" | "readinessReason"
    >[];
    readonly reason: string;
  };
  readonly directSkillCalls?: never;
}
export interface UpstreamRevisionRequest {
  readonly runId: string;
  readonly source: ExactArtifactRef;
  readonly request: ExactArtifactRef;
  readonly affectedLocks: readonly ExactArtifactRef[];
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
}

const equal = (a: unknown, b: unknown): boolean =>
  canonicalJson(a) === canonicalJson(b);
const completionReason = (taskId: string): string =>
  `Skill task ${JSON.stringify(taskId)} completed with verified exact outputs`;
const productionReason = (taskId: string, skillId: string): string =>
  `Skill task ${JSON.stringify(taskId)} by ${JSON.stringify(skillId)} returned exact provisional output`;
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const modeOrder: Record<Run["entryMode"], readonly string[]> = {
  "system-first": [
    "system-capability",
    "product-definition",
    "user-task-model",
    "product-ui-contract",
  ],
  "experience-first": [
    "product-definition",
    "user-task-model",
    "system-capability",
    "product-ui-contract",
  ],
  hybrid: [
    "product-definition",
    "system-capability",
    "user-task-model",
    "product-ui-contract",
  ],
};

export class Orchestrator {
  private readonly scopeNodes: readonly ScopeNode[];
  constructor(
    readonly registry: RunRegistry,
    readonly artifacts: ArtifactStore,
    scopes: readonly ScopeNode[],
  ) {
    this.scopeNodes = Object.freeze(
      jsonCopy(scopes).map((scope) => Object.freeze(scope)),
    );
  }

  private scopeChain(ownerId: string): readonly string[] {
    const byId = new Map(
      this.scopeNodes.map((scope) => [scope.ownerId, scope]),
    );
    const chain: string[] = [];
    let node = byId.get(ownerId);
    while (node) {
      assert(!chain.includes(node.ownerId), "Cyclic scope");
      chain.unshift(node.ownerId);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
    assert(
      chain.length > 0 &&
        this.scopeNodes.find((scope) => scope.ownerId === chain[0])?.level ===
          "organization",
      "Invalid scope",
    );
    return chain;
  }
  private async verified(input: ExactArtifactRef): Promise<ArtifactSnapshot> {
    const snapshot = await this.artifacts.read(
      input.artifactId,
      input.revision,
    );
    assert(
      snapshot.digest === input.lockDigest,
      "Exact artifact lock mismatch",
    );
    return snapshot.artifact;
  }
  /** A Run always starts from the verified current selection of its applicable ancestry. */
  async start(input: {
    id: string;
    scopeOwnerId: string;
    entryMode: Run["entryMode"];
    actor: Actor;
    at: string;
    tasks: readonly RoutedTask[];
  }): Promise<Run> {
    input = jsonCopy(input);
    const chain = this.scopeChain(input.scopeOwnerId);
    const state = await this.registry.snapshot();
    const base: ExactArtifactRef[] = [];
    const reused: Run["reused"][number][] = [];
    for (const selection of Object.values(state.canonical)) {
      const artifact = await this.verified(selection.ref);
      if (!chain.includes(artifact.scope.ownerId)) continue;
      assert(
        artifact.lifecycle.status === "approved" &&
          artifact.approval.status === "approved" &&
          artifact.lifecycle.freshness === "valid" &&
          !state.freshness[selection.ref.artifactId],
        "Unusable canonical selection",
      );
      base.push(selection.ref);
      reused.push({
        ref: selection.ref,
        reason: `Applicable approved ${artifact.scope.level} selection`,
      });
    }
    base.sort((a, b) => a.artifactId.localeCompare(b.artifactId));
    reused.sort((a, b) => a.ref.artifactId.localeCompare(b.ref.artifactId));
    const started = await this.registry.start({
      id: input.id,
      scope: input.scopeOwnerId,
      entryMode: input.entryMode,
      base,
      reused,
      safeActions: input.tasks.map((task) => task.id),
      actor: input.actor,
      at: input.at,
      reason: "Start from verified applicable canonical selection",
    });
    const plan = await this.next(input.id, input.tasks);
    const blocked = Object.fromEntries(
      plan.actions
        .filter(
          (action) =>
            action.action === "BLOCK" && action.blockKind === "durable",
        )
        .map((action) => [action.taskId, action.reason]),
    );
    if (Object.keys(blocked).length) {
      await this.registry.setWork({
        runId: input.id,
        safeActions: input.tasks
          .map((task) => task.id)
          .filter((id) => !Object.hasOwn(blocked, id)),
        blockers: blocked,
        actor: input.actor,
        at: input.at,
        reason:
          "Record task-specific prerequisites and retain independent work",
      });
      return (await this.registry.run(input.id)).run;
    }
    return started;
  }

  async policy(
    runId: string,
    check: PolicyCheck,
    authority?: PolicyAuthority,
  ): Promise<ResolvedPolicy> {
    check = jsonCopy(check);
    const { run } = await this.registry.run(runId);
    assert(
      this.scopeChain(run.scope).includes(check.scopeOwnerId),
      "Policy target is outside Run ancestry",
    );
    return resolveApprovedPolicy(
      this.artifacts,
      await this.registry.snapshot(),
      this.scopeNodes,
      check,
      authority,
    );
  }

  async next(
    runId: string,
    tasks: readonly RoutedTask[],
  ): Promise<NextActions> {
    tasks = jsonCopy(tasks);
    const state = await this.registry.snapshot();
    const run = state.runs[runId];
    assert(run, "Unknown Run");
    const chain = this.scopeChain(run.scope);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    assert(byId.size === tasks.length, "Duplicate task ID");
    for (const task of tasks)
      assert(
        /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(task.skillId),
        "Invalid static Skill ID",
      );
    const visiting = new Set<string>();
    const ordered: RoutedTask[] = [];
    const visit = (task: RoutedTask): void => {
      assert(!visiting.has(task.id), "Task dependency cycle");
      if (ordered.includes(task)) return;
      visiting.add(task.id);
      for (const id of task.dependsOn ?? []) {
        const dependency = byId.get(id);
        assert(dependency, `Missing task ${id}`);
        visit(dependency);
      }
      visiting.delete(task.id);
      ordered.push(task);
    };
    const rank = modeOrder[run.entryMode];
    const priorities = [...tasks].sort((a, b) => {
      const ai = rank.indexOf(a.outputType),
        bi = rank.indexOf(b.outputType);
      return (ai < 0 ? rank.length : ai) - (bi < 0 ? rank.length : bi);
    });
    priorities.forEach(visit);
    for (const task of tasks)
      for (const need of [
        ...task.inputs.required,
        ...task.inputs.optional,
        ...task.inputs.alternatives.flatMap((group) => group.oneOf),
      ]) {
        if (need.kind !== "artifact" || !need.refsFromTask) continue;
        const source = byId.get(need.refsFromTask);
        assert(
          source &&
            source.id !== task.id &&
            task.dependsOn?.includes(source.id) &&
            [
              source.outputType,
              ...(source.additionalOutputTypes ?? []),
            ].includes(need.artifactType),
          "Invalid producer output binding",
        );
      }
    const available = [...run.base, ...run.artifacts];
    const artifacts = new Map<string, ArtifactSnapshot>();
    for (const item of available)
      artifacts.set(
        `${item.artifactId}@${item.revision}`,
        await this.verified(item),
      );
    const actions: RoutedAction[] = [];
    const completed = new Set(
      state.events
        .filter(
          (event) =>
            event.runId === runId &&
            event.action === "set-work" &&
            event.actor.kind === "agent" &&
            event.actor.id === "orchestrator",
        )
        .flatMap((event) =>
          tasks
            .filter((task) => event.reason === completionReason(task.id))
            .map((task) => task.id),
        ),
    );
    for (const task of ordered) {
      assert(
        chain.includes(task.scopeOwnerId),
        "Task scope outside Run ancestry",
      );
      if (run.closed) {
        actions.push({
          taskId: task.id,
          action: "IGNORE",
          reason: "Run is closed",
        });
        continue;
      }
      const pending = Object.values(run.proposals).filter(
        (proposal) =>
          proposal.status === "pending" &&
          (task.proposalIds?.includes(proposal.id) ||
            (task.targetArtifactId !== undefined &&
              proposal.ref.artifactId === task.targetArtifactId)),
      );
      if (
        pending.some(
          (proposal) => proposal.readiness === "ready" && !proposal.deferred,
        )
      ) {
        actions.push({
          taskId: task.id,
          action: "REQUEST_DECISION",
          reason: "Named proposal awaits Human Commit Point",
        });
        continue;
      }
      const blocker = run.blockers[task.id];
      if (blocker) {
        actions.push({
          taskId: task.id,
          action: "BLOCK",
          reason: blocker,
          blockKind: "durable",
        });
        continue;
      }
      if (!run.safeActions.includes(task.id)) {
        actions.push({
          taskId: task.id,
          action: "IGNORE",
          reason: "Task is not available on this Run",
        });
        continue;
      }
      const unknown = task.uncertainties?.find(
        (item) =>
          item.kind === "blocking-unknown" &&
          item.affectedTaskIds.includes(task.id),
      );
      if (unknown) {
        actions.push({
          taskId: task.id,
          action: "BLOCK",
          reason: unknown.reason,
          blockKind: "durable",
        });
        continue;
      }
      if (
        (task.dependsOn ?? []).some((id) => {
          if (actions.find((action) => action.taskId === id)?.action === "USE")
            return false;
          return (
            !!run.blockers[id] ||
            run.safeActions.includes(id) ||
            !completed.has(id)
          );
        })
      ) {
        actions.push({
          taskId: task.id,
          action: "BLOCK",
          reason: "Required upstream task is not available yet",
          blockKind: "transient",
        });
        continue;
      }
      const current = task.targetArtifactId
        ? state.canonical[task.targetArtifactId]?.ref
        : undefined;
      if (current && !run.base.some((item) => equal(item, current))) {
        actions.push({
          taskId: task.id,
          action: "BLOCK",
          reason:
            "Current target moved since the Run base; explicit revision or new Run required",
        });
        continue;
      }
      if (current) {
        const selected = artifacts.get(
          `${current.artifactId}@${current.revision}`,
        );
        if (
          !selected ||
          selected.lifecycle.status !== "approved" ||
          selected.lifecycle.freshness !== "valid" ||
          state.freshness[current.artifactId]
        ) {
          actions.push({
            taskId: task.id,
            action: "BLOCK",
            reason: "Current exact target is not fresh and approved",
          });
          continue;
        }
      }
      if (current && task.intent === "use") {
        actions.push({
          taskId: task.id,
          action: "USE",
          ref: current,
          reason: "Applicable approved exact revision",
        });
        continue;
      }
      const inputs: ExactArtifactRef[] = [];
      const inputBindings: { name: string; refs: ExactArtifactRef[] }[] = [];
      let includeBrief = false;
      let includeEvidence = false;
      const gaps: string[] = [];
      let hardMissing = false;
      const isEligible = (
        item: ExactArtifactRef,
        need: Extract<InputNeed, { kind: "artifact" }>,
      ): boolean => {
        const artifact = artifacts.get(`${item.artifactId}@${item.revision}`);
        const proposal = Object.values(run.proposals).find((candidate) =>
          equal(candidate.ref, item),
        );
        return (
          !!artifact &&
          artifact.meta.type === need.artifactType &&
          (!need.schemaVersion ||
            artifact.meta.schemaVersion === need.schemaVersion) &&
          chain.includes(artifact.scope.ownerId) &&
          artifact.lifecycle.freshness === "valid" &&
          !state.freshness[item.artifactId] &&
          ["approved", "provisional", "proposed"].includes(
            artifact.lifecycle.status,
          ) &&
          !["rejected", "superseded", "discarded", "merged"].includes(
            proposal?.status ?? "",
          )
        );
      };
      const resolveNeed = (
        need: InputNeed,
      ): readonly ExactArtifactRef[] | boolean => {
        if (need.kind === "human-brief") return !!task.humanBrief?.trim();
        if (need.kind === "evidence-file") return !!task.evidenceFiles?.length;
        if (need.refsFromTask) {
          const source = byId.get(need.refsFromTask)!;
          const completions = state.events.filter(
            (event) =>
              event.runId === runId &&
              event.action === "set-work" &&
              event.actor.kind === "agent" &&
              event.actor.id === "orchestrator" &&
              event.reason === completionReason(source.id) &&
              !event.runAfter.safeActions.includes(source.id),
          );
          const completion = completions.at(-1);
          if (!completion) return false;
          // Legacy file-backed completions omitted outputs. Their producer
          // events carry the same invocation timestamp as set-work. Exclude
          // partial outputs from earlier attempts as well as earlier tasks.
          const previousSequence = completions.at(-2)?.sequence ?? 0;
          const produced = completion.outputs.length
            ? completion.outputs
            : state.events
                .filter(
                  (event) =>
                    event.sequence > previousSequence &&
                    event.sequence < completion.sequence &&
                    event.at === completion.at &&
                    event.runId === runId &&
                    event.action === "produce-provisional" &&
                    event.actor.kind === "skill" &&
                    event.actor.id === source.skillId &&
                    event.reason ===
                      productionReason(source.id, source.skillId),
                )
                .flatMap((event) => event.outputs)
                .filter((ref) =>
                  completion.runAfter.artifacts.some((item) =>
                    equal(item, ref),
                  ),
                );
          const selected = produced.filter(
            (ref) =>
              artifacts.get(`${ref.artifactId}@${ref.revision}`)?.meta.type ===
              need.artifactType,
          );
          return selected.length > 0 &&
            new Set(selected.map((ref) => canonicalJson(ref))).size ===
              selected.length &&
            selected.every(
              (ref) =>
                available.some((item) => equal(item, ref)) &&
                isEligible(ref, need) &&
                state.events.some(
                  (event) =>
                    event.sequence < completion.sequence &&
                    event.runId === runId &&
                    event.action === "produce-provisional" &&
                    event.actor.kind === "skill" &&
                    event.actor.id === source.skillId &&
                    event.reason ===
                      productionReason(source.id, source.skillId) &&
                    event.outputs.some((item) => equal(item, ref)),
                ),
            )
            ? selected
            : false;
        }
        if (need.refs) {
          if (
            !need.refs.length ||
            new Set(need.refs.map((item) => item.artifactId)).size !==
              need.refs.length
          )
            return false;
          return need.refs.every(
            (item) =>
              available.some((candidate) => equal(candidate, item)) &&
              isEligible(item, need),
          )
            ? need.refs
            : false;
        }
        const candidates = available.filter((item) => isEligible(item, need));
        if (!candidates.length) return false;
        const depth = Math.max(
          ...candidates.map((item) =>
            chain.indexOf(
              artifacts.get(`${item.artifactId}@${item.revision}`)!.scope
                .ownerId,
            ),
          ),
        );
        const closest = candidates.filter(
          (item) =>
            chain.indexOf(
              artifacts.get(`${item.artifactId}@${item.revision}`)!.scope
                .ownerId,
            ) === depth,
        );
        return closest.length === 1 ? closest : false;
      };
      const consume = (
        need: InputNeed,
        chosen: readonly ExactArtifactRef[] | boolean,
      ): void => {
        if (need.kind === "artifact" && Array.isArray(chosen)) {
          inputBindings.push({ name: need.name, refs: [...chosen] });
          for (const item of chosen)
            if (!inputs.some((current) => equal(current, item)))
              inputs.push(item);
        }
        if (need.kind === "human-brief") includeBrief = true;
        if (need.kind === "evidence-file") includeEvidence = true;
      };
      const label = (need: InputNeed): string =>
        need.kind === "artifact"
          ? `${need.name} (${need.artifactType})`
          : need.name;
      const producerExists = (need: InputNeed): boolean =>
        need.kind === "artifact" &&
        !need.refsFromTask &&
        tasks.some(
          (candidate) =>
            candidate.id !== task.id &&
            run.safeActions.includes(candidate.id) &&
            candidate.outputType === need.artifactType,
        );
      for (const need of task.inputs.required) {
        const chosen = resolveNeed(need);
        if (chosen) consume(need, chosen);
        else {
          gaps.push(`Missing required ${label(need)}`);
          if (
            !producerExists(need) &&
            !(
              need.kind === "artifact" &&
              need.refsFromTask &&
              !completed.has(need.refsFromTask)
            )
          )
            hardMissing = true;
        }
      }
      for (const group of task.inputs.alternatives) {
        const choice = group.oneOf
          .map((need) => ({ need, chosen: resolveNeed(need) }))
          .find(({ chosen }) => !!chosen);
        if (choice) consume(choice.need, choice.chosen);
        else {
          gaps.push(`Missing one of ${group.oneOf.map(label).join(", ")}`);
          if (!group.oneOf.some(producerExists)) hardMissing = true;
        }
      }
      if (gaps.length) {
        actions.push({
          taskId: task.id,
          action: "BLOCK",
          reason: gaps.join("; "),
          blockKind: hardMissing ? "durable" : "transient",
        });
        continue;
      }
      for (const need of task.inputs.optional) {
        const chosen = resolveNeed(need);
        if (chosen) consume(need, chosen);
        else gaps.push(`Optional ${label(need)} unavailable`);
      }
      const invocation: SkillInvocation = {
        runId,
        taskId: task.id,
        skillId: task.skillId,
        allowedOutputTypes: [
          task.outputType,
          ...(task.additionalOutputTypes ?? []),
        ],
        ...(task.targetArtifactId
          ? { targetArtifactId: task.targetArtifactId }
          : {}),
        intent: task.intent,
        scopeOwnerId: task.scopeOwnerId,
        inputRefs: inputs,
        inputBindings,
        evidenceFiles: includeEvidence ? (task.evidenceFiles ?? []) : [],
        assumptions: [
          ...(task.assumptions ?? []),
          ...(task.uncertainties ?? [])
            .filter((item) => item.kind !== "blocking-unknown")
            .map((item) => `${item.kind}: ${item.reason}`),
          ...inputs
            .filter(
              (item) =>
                artifacts.get(`${item.artifactId}@${item.revision}`)?.lifecycle
                  .status !== "approved",
            )
            .map(
              (item) =>
                `Provisional input ${item.artifactId}@${item.revision} is not approved canonical state`,
            ),
        ],
        authority: task.authority,
        ...(includeBrief ? { humanBrief: task.humanBrief } : {}),
      };
      actions.push({
        taskId: task.id,
        action: current ? "UPDATE" : "GENERATE",
        reason: current
          ? "Explicit new revision required"
          : "No applicable approved target",
        ...(current ? { ref: current } : {}),
        invocation,
        ...(gaps.length ? { gaps } : {}),
      });
    }
    const commitPoints = Object.values(state.packets)
      .filter((packet) => packet.runId === runId)
      .map((packet) => ({
        packetId: packet.id,
        proposalIds: packet.proposalIds.filter((id) => {
          const proposal = run.proposals[id];
          return (
            proposal?.status === "pending" &&
            proposal.readiness === "ready" &&
            !proposal.deferred
          );
        }),
      }))
      .filter((packet) => packet.proposalIds.length);
    const evidenceGaps: NextActions["evidenceGaps"][number][] = [];
    for (const item of run.artifacts) {
      const artifact = artifacts.get(`${item.artifactId}@${item.revision}`)!;
      for (const finding of await assessProvenance(artifact))
        if (finding.status === "UNVERIFIED" || finding.status === "UNKNOWN")
          evidenceGaps.push({
            artifactId: item.artifactId,
            path: finding.path,
            reason: finding.reason,
          });
    }
    const blockers = {
      ...run.blockers,
      ...Object.fromEntries(
        actions
          .filter((action) => action.action === "BLOCK")
          .map((action) => [action.taskId, action.reason]),
      ),
    };
    const hasRunnableWork = actions.some((action) =>
      ["USE", "UPDATE", "GENERATE"].includes(action.action),
    );
    const allSafeActionsRepresented = run.safeActions.every((id) =>
      byId.has(id),
    );
    const registryState = (await this.registry.run(runId)).state;
    return {
      runId,
      state:
        registryState === "active" &&
        allSafeActionsRepresented &&
        !hasRunnableWork &&
        Object.keys(blockers).length
          ? "blocked"
          : registryState,
      actions,
      commitPoints,
      blockers,
      evidenceGaps,
    };
  }

  async invoke(
    runId: string,
    tasks: readonly RoutedTask[],
    taskId: string,
    executor: (invocation: SkillInvocation) => Promise<SkillResult>,
    at: string,
  ): Promise<void> {
    const action = (await this.next(runId, tasks)).actions.find(
      (item) => item.taskId === taskId,
    );
    assert(
      action?.invocation && ["GENERATE", "UPDATE"].includes(action.action),
      "Task is not routable",
    );
    const invocation = action.invocation;
    const result = await executor(jsonCopy(invocation));
    await this.accept(
      invocation,
      result,
      { kind: "skill", id: invocation.skillId },
      at,
    );
  }

  /** Accepts references only; Skills never invoke another Skill or select canonical state. */
  async accept(
    invocation: SkillInvocation,
    result: SkillResult,
    actor: Actor,
    at: string,
  ): Promise<void> {
    invocation = jsonCopy(invocation);
    result = jsonCopy(result);
    actor = jsonCopy(actor);
    assert(
      actor.kind === "skill" && actor.id === invocation.skillId,
      "Skill identity mismatch",
    );
    assert(
      result.runId === invocation.runId &&
        result.taskId === invocation.taskId &&
        result.skillId === invocation.skillId &&
        equal(result.inputRefs, invocation.inputRefs),
      "Result does not match invocation",
    );
    assert(
      !Object.hasOwn(result, "directSkillCalls"),
      "Direct Skill invocation is forbidden",
    );
    assert(
      Object.keys(result).every((key) =>
        [
          "runId",
          "taskId",
          "skillId",
          "inputRefs",
          "outputRefs",
          "blocked",
          "proposal",
        ].includes(key),
      ),
      "Unexpected Skill result effect",
    );
    assert(
      new Set(result.outputRefs.map((output) => canonicalJson(output))).size ===
        result.outputRefs.length,
      "Duplicate Skill output reference",
    );
    const { run } = await this.registry.run(invocation.runId);
    assert(
      !run.closed && run.safeActions.includes(invocation.taskId),
      "Task is not active",
    );
    assert(
      result.outputRefs.length > 0 || result.blocked,
      "Skill result has no output or blocker",
    );
    if (result.blocked)
      assert(
        result.blocked.reason.trim() &&
          result.blocked.affectedTaskIds.length === 1 &&
          result.blocked.affectedTaskIds[0] === invocation.taskId,
        "Invalid blocked reason",
      );
    for (const input of result.inputRefs) {
      await this.verified(input);
      const fate = Object.values(run.proposals).find((proposal) =>
        equal(proposal.ref, input),
      )?.status;
      assert(
        !["rejected", "superseded", "discarded", "merged"].includes(fate ?? ""),
        "Rejected or resolved proposal cannot be an input",
      );
    }
    const state = await this.registry.snapshot();
    const recordedRun = state.runs[invocation.runId] ?? run;
    const newOutputs: ExactArtifactRef[] = [];
    for (const output of result.outputRefs) {
      assert(
        !Object.values(recordedRun.proposals).some(
          (proposal) =>
            equal(proposal.ref, output) && proposal.status !== "pending",
        ),
        "Rejected or resolved output cannot be reused",
      );
      const artifact = await this.verified(output);
      if (artifact.lifecycle.status === "approved") {
        assert(
          artifact.approval.status === "approved" &&
            this.scopeChain(run.scope).includes(artifact.scope.ownerId) &&
            invocation.allowedOutputTypes.includes(artifact.meta.type) &&
            run.base.some((item) => equal(item, output)) &&
            !!state.canonical[output.artifactId] &&
            equal(state.canonical[output.artifactId]?.ref, output) &&
            !state.freshness[output.artifactId] &&
            result.inputRefs.some((item) => equal(item, output)),
          "Unchanged output is not verified approved Run context",
        );
        continue;
      }
      const origin = artifact.origin as Record<string, unknown> | undefined;
      assert(
        origin?.actorKind === "skill" &&
          origin.actorId === invocation.skillId &&
          origin.runId === invocation.runId,
        "Output origin mismatch",
      );
      assert(
        artifact.scope.ownerId === invocation.scopeOwnerId &&
          invocation.allowedOutputTypes.includes(artifact.meta.type) &&
          (artifact.meta.type !== invocation.allowedOutputTypes[0] ||
            !invocation.targetArtifactId ||
            artifact.meta.id === invocation.targetArtifactId) &&
          ["provisional", "proposed"].includes(artifact.lifecycle.status) &&
          (artifact.lifecycle.status !== "proposed" ||
            invocation.authority === "PROPOSE_ONLY") &&
          artifact.approval.status === "pending",
        "Skill output cannot be durable",
      );
      assert(
        artifact.dependencies.every((dependency) =>
          result.inputRefs.some(
            (input) =>
              input.artifactId === dependency.artifactId &&
              input.revision === dependency.revision &&
              input.lockDigest === dependency.lockDigest,
          ),
        ),
        "Output dependency outside minimal context",
      );
      await assessProvenance(artifact);
      newOutputs.push(output);
    }
    if (result.proposal) {
      assert(
        invocation.authority === "PROPOSE_ONLY",
        "Proposal requires PROPOSE_ONLY route",
      );
      assert(
        result.proposal.items.every((item) =>
          newOutputs.some((output) => equal(output, item.ref)),
        ),
        "Proposal output not returned",
      );
    }
    const known = recordedRun.artifacts;
    for (const output of newOutputs) {
      if (known.some((item) => equal(item, output))) {
        assert(
          state.events.some(
            (event) =>
              event.runId === invocation.runId &&
              event.action === "produce-provisional" &&
              event.reason ===
                productionReason(invocation.taskId, invocation.skillId) &&
              event.actor.kind === "skill" &&
              event.actor.id === invocation.skillId &&
              event.outputs.some((item) => equal(item, output)),
          ),
          "Existing output belongs to another task",
        );
      } else {
        await this.registry.produce({
          runId: invocation.runId,
          ref: output,
          inputs: result.inputRefs,
          actor,
          at,
          reason: productionReason(invocation.taskId, invocation.skillId),
        });
      }
    }
    if (result.proposal) {
      const snapshot = await this.registry.snapshot();
      const packet = snapshot.packets[result.proposal.packetId];
      if (packet) {
        const currentRun = snapshot.runs[invocation.runId];
        assert(
          packet.runId === invocation.runId &&
            packet.reason === result.proposal.reason &&
            equal(
              packet.proposalIds,
              result.proposal.items.map((item) => item.id),
            ) &&
            result.proposal.items.every((item) => {
              const stored = currentRun?.proposals[item.id];
              if (
                !stored ||
                stored.packetId !== packet.id ||
                stored.status !== "pending" ||
                stored.readiness !== "ready" ||
                stored.deferred
              )
                return false;
              const declared = Object.fromEntries(
                Object.entries(stored).filter(
                  ([key]) =>
                    ![
                      "packetId",
                      "status",
                      "readiness",
                      "readinessReason",
                      "deferred",
                    ].includes(key),
                ),
              );
              return equal(declared, item);
            }),
          "Result packet belongs to another task or is no longer live",
        );
      } else {
        await this.registry.submit({
          runId: invocation.runId,
          packetId: result.proposal.packetId,
          proposals: result.proposal.items,
          actor: { kind: "agent", id: "orchestrator" },
          at,
          reason: result.proposal.reason,
        });
      }
    }
    const current = (await this.registry.run(invocation.runId)).run;
    if (result.proposal)
      assert(
        result.proposal.items.every((item) => {
          const proposal = current.proposals[item.id];
          return (
            proposal?.status === "pending" &&
            proposal.readiness === "ready" &&
            !proposal.deferred
          );
        }),
        "Result packet is no longer live",
      );
    assert(
      result.outputRefs.every(
        (output) =>
          !Object.values(current.proposals).some(
            (proposal) =>
              equal(proposal.ref, output) && proposal.status !== "pending",
          ),
      ),
      "Rejected or resolved output cannot be reused",
    );
    await this.registry.setWork({
      runId: invocation.runId,
      safeActions: current.safeActions.filter((id) => id !== invocation.taskId),
      blockers: result.blocked
        ? { ...current.blockers, [invocation.taskId]: result.blocked.reason }
        : current.blockers,
      actor: { kind: "agent", id: "orchestrator" },
      at,
      reason: result.blocked
        ? "Skill reported a genuine affected-work blocker"
        : completionReason(invocation.taskId),
      outputs: result.blocked ? [] : result.outputRefs,
    });
  }

  async requestUpstream(
    input: UpstreamRevisionRequest,
    actor: Actor,
    at: string,
  ): Promise<void> {
    input = jsonCopy(input);
    assert(
      input.reason.trim() &&
        input.evidenceRefs.length > 0 &&
        input.affectedLocks.length > 0,
      "Revision request needs evidence and affected locks",
    );
    const source = await this.verified(input.source);
    const request = await this.verified(input.request);
    assert(
      actor.kind === "skill" &&
        source.lifecycle.status === "approved" &&
        request.meta.type === "system-request" &&
        request.lifecycle.status === "provisional" &&
        request.approval.status === "pending" &&
        (request.origin as Record<string, unknown> | undefined)?.actorKind ===
          "skill" &&
        (request.origin as Record<string, unknown> | undefined)?.runId ===
          input.runId &&
        (request.origin as Record<string, unknown> | undefined)?.actorId ===
          actor.id,
      "Revision request cannot mutate approved source",
    );
    assert(
      input.affectedLocks.some((item) => equal(item, input.source)),
      "Request must name upstream exact lock",
    );
    assert(
      request.dependencies.some(
        (dependency) =>
          dependency.artifactId === input.source.artifactId &&
          dependency.revision === input.source.revision &&
          dependency.lockDigest === input.source.lockDigest,
      ),
      "Request must lock upstream source",
    );
    assert(
      input.evidenceRefs.every((reference) =>
        request.provenance.some(
          (entry) =>
            Array.isArray(entry.evidenceRefs) &&
            entry.evidenceRefs.includes(reference),
        ),
      ),
      "Revision request evidence is absent from artifact provenance",
    );
    const state = await this.registry.snapshot();
    const run = state.runs[input.runId];
    assert(
      run &&
        input.affectedLocks.every((ref) =>
          [...run.base, ...run.artifacts].some((item) => equal(item, ref)),
        ),
      "Revision request affected locks are outside the Run",
    );
    if (run.artifacts.some((ref) => equal(ref, input.request))) {
      assert(
        state.events.some(
          (event) =>
            event.runId === input.runId &&
            event.action === "produce-provisional" &&
            event.actor.kind === actor.kind &&
            event.actor.id === actor.id &&
            event.outputs.some((ref) => equal(ref, input.request)) &&
            input.affectedLocks.every((ref) =>
              event.inputs.some((item) => equal(item, ref)),
            ),
        ),
        "Revision request has no matching Run production",
      );
      return;
    }
    await this.registry.produce({
      runId: input.runId,
      ref: input.request,
      inputs: input.affectedLocks,
      actor,
      at,
      reason: input.reason,
    });
  }
}

/** Builds every runtime participant on ONE canonical FileWorkspaceStorage instance. */
export function createOrchestratorRuntime(
  workspace: FileWorkspaceStorage,
  schemas: SchemaRegistry,
  scopes: readonly ScopeNode[],
  authority: RegistryAuthority,
  seedAuthority?: AuthorityVerifier,
  policyAuthority?: PolicyAuthority,
): {
  orchestrator: Orchestrator;
  registry: RunRegistry;
  artifacts: ArtifactStore;
  governedAuthority: GovernedRegistryAuthority;
} {
  const scopeNodes = jsonCopy(scopes);
  const governedAuthority = new GovernedRegistryAuthority(
    authority,
    scopeNodes,
    policyAuthority,
  );
  const artifacts = new ArtifactStore(
    workspace.snapshots,
    schemas,
    scopeNodes,
    new RegistryAuthorityVerifier(workspace, governedAuthority, seedAuthority),
  );
  governedAuthority.bind(artifacts);
  class RuntimeRegistry extends RunRegistry {
    override commit(input: CommitRequest): Promise<void> {
      return governedAuthority.withCommit(input, () => super.commit(input));
    }
  }
  const registry = new RuntimeRegistry(
    workspace,
    artifacts,
    governedAuthority,
    new ArtifactStorePublication(artifacts, governedAuthority),
  );
  return {
    orchestrator: new Orchestrator(registry, artifacts, scopeNodes),
    registry,
    artifacts,
    governedAuthority,
  };
}
