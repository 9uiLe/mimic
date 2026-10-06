import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  artifactDigest,
  canonicalJson,
  jsonCopy,
  type JsonValue,
} from "../artifact-canonical.js";
import type { ArtifactSnapshot } from "../artifact-store.js";
import type { AtomicRegistryStorage } from "../workspace-transaction.js";
import type { TransactionalArtifactPublisher } from "./publication.js";
import {
  DependencyGraph,
  type ExactArtifactRef,
  type SnapshotReader,
} from "../runtime-engines/dependency.js";

export type { ExactArtifactRef } from "../runtime-engines/dependency.js";
export type RunState = "active" | "review-ready" | "blocked" | "closed";
export type DecisionOutcome =
  "approved" | "rejected" | "deferred" | "superseded";
export type Actor = {
  readonly kind: "human" | "agent" | "skill" | "import";
  readonly id: string;
};
export interface DecisionRecord {
  readonly id: string;
  readonly packetId: string;
  readonly proposalId: string;
  readonly outcome: DecisionOutcome;
  readonly actor: Actor;
  readonly at: string;
  readonly rationale: string;
  readonly supersedesDecisionId?: string;
  readonly externalRefs?: readonly string[];
  readonly output?: {
    readonly ref: ExactArtifactRef;
    readonly artifact: ArtifactSnapshot;
  };
}
export interface Proposal {
  readonly id: string;
  readonly ref: ExactArtifactRef;
  readonly expectedCanonical?: ExactArtifactRef;
  readonly alternatives: readonly string[];
  readonly rationale: string;
  readonly evidenceLimits: readonly string[];
  readonly dependents: readonly ExactArtifactRef[];
  readonly priorRejectionId?: string;
  readonly impactEvidence?: readonly {
    readonly dependency: ExactArtifactRef;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly packetId: string;
  status: "pending" | "merged" | "rejected" | "discarded" | "superseded";
  readiness: "ready" | "stale" | "blocked";
  readinessReason?: string;
  deferred?: boolean;
}
export interface DecisionPacket {
  readonly id: string;
  readonly runId: string;
  readonly proposalIds: readonly string[];
  readonly createdAt: string;
  readonly reason: string;
  readonly externalRefs?: readonly string[];
}
export interface RunEvent {
  readonly sequence: number;
  readonly runId: string;
  readonly action: string;
  readonly actor: Actor;
  readonly at: string;
  readonly reason: string;
  readonly inputs: readonly ExactArtifactRef[];
  readonly outputs: readonly ExactArtifactRef[];
  readonly runAfter: Run;
  readonly canonicalAfter: RegistryState["canonical"];
  readonly freshnessAfter: RegistryState["freshness"];
  readonly details?: JsonValue;
}
export interface Run {
  readonly id: string;
  readonly scope: string;
  readonly entryMode: "system-first" | "experience-first" | "hybrid";
  readonly base: readonly ExactArtifactRef[];
  readonly reused: readonly { ref: ExactArtifactRef; reason: string }[];
  readonly artifacts: readonly ExactArtifactRef[];
  readonly proposals: Record<string, Proposal>;
  readonly blockers: Record<string, string>;
  readonly safeActions: readonly string[];
  readonly closed?: {
    at: string;
    reason: string;
    fates: Record<string, Proposal["status"]>;
  };
}
export interface CommitRequest {
  readonly id: string;
  readonly packetId: string;
  readonly approvals: readonly { proposalId: string; decisionId: string }[];
  readonly actor: Actor;
  readonly at: string;
  readonly reason: string;
}
export interface RegistryState {
  canonical: Record<string, { ref: ExactArtifactRef; decisionId?: string }>;
  freshness: Record<
    string,
    { ref: ExactArtifactRef; status: "stale" | "blocked"; reason: string }
  >;
  runs: Record<string, Run>;
  packets: Record<string, DecisionPacket>;
  decisions: Record<string, DecisionRecord>;
  commits: Record<
    string,
    { request: CommitRequest; outputs: readonly ExactArtifactRef[] }
  >;
  events: RunEvent[];
}
export interface TransactionalRegistryStorage {
  /** Callback must see the current state under exclusive ownership; commit all changes or none. */
  transact<T>(change: (state: RegistryState) => Promise<T>): Promise<T>;
  read(): Promise<RegistryState>;
}
const empty = (): RegistryState => ({
  canonical: {},
  freshness: {},
  runs: {},
  packets: {},
  decisions: {},
  commits: {},
  events: [],
});
export class RegistryError extends Error {
  constructor(
    readonly code: "INVALID" | "CONFLICT" | "UNVERIFIED" | "UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}
function requireThat(
  ok: unknown,
  message: string,
  code: RegistryError["code"] = "INVALID",
): asserts ok {
  if (!ok) throw new RegistryError(code, message);
}
function validRef(ref: ExactArtifactRef): boolean {
  return (
    !!ref &&
    /^art_[A-Za-z0-9_-]+$/.test(ref.artifactId) &&
    Number.isSafeInteger(ref.revision) &&
    ref.revision > 0 &&
    /^sha256:[0-9a-f]{64}$/.test(ref.lockDigest)
  );
}
function same(a: unknown, b: unknown): boolean {
  return a === undefined || b === undefined
    ? a === b
    : canonicalJson(a) === canonicalJson(b);
}
function event(
  state: RegistryState,
  runId: string,
  action: string,
  actor: Actor,
  at: string,
  reason: string,
  inputs: readonly ExactArtifactRef[] = [],
  outputs: readonly ExactArtifactRef[] = [],
  details?: unknown,
): void {
  requireThat(
    actor?.id?.trim() &&
      ["human", "agent", "skill", "import"].includes(actor.kind) &&
      Number.isFinite(Date.parse(at)) &&
      reason?.trim(),
    "Invalid event metadata",
  );
  state.events.push({
    sequence: state.events.length + 1,
    runId,
    action,
    actor,
    at,
    reason,
    inputs,
    outputs,
    runAfter: jsonCopy(state.runs[runId]),
    canonicalAfter: jsonCopy(state.canonical),
    freshnessAfter: jsonCopy(state.freshness),
    ...(details === undefined
      ? {}
      : { details: jsonCopy(details) as JsonValue }),
  });
}
export function deriveRunState(run: Run): RunState {
  if (run.closed) return "closed";
  if (
    Object.values(run.proposals).some(
      (p) => p.status === "pending" && p.readiness === "ready" && !p.deferred,
    )
  )
    return "review-ready";
  if (run.safeActions.length) return "active";
  if (Object.keys(run.blockers).length) return "blocked";
  return "closed";
}
function closeCompleted(
  state: RegistryState,
  runId: string,
  actor: Actor,
  at: string,
): void {
  const run = state.runs[runId];
  if (run.closed || deriveRunState(run) !== "closed") return;
  const fates: Record<string, Proposal["status"]> = {};
  for (const proposal of Object.values(run.proposals))
    fates[proposal.id] = proposal.status;
  state.runs[runId] = {
    ...run,
    closed: { at, reason: "All recorded work is complete", fates },
  };
  event(state, runId, "close-run", actor, at, "All recorded work is complete");
}
export interface RegistryAuthority {
  verify(record: DecisionRecord, proposal: Proposal): Promise<boolean>;
  verifyEvidence?(
    proposal: Proposal,
    dependency: ExactArtifactRef,
    refs: readonly string[],
  ): Promise<boolean>;
  verifyResolution?(
    blockerId: string,
    evidenceRefs: readonly string[],
  ): Promise<boolean>;
  allowCommit(
    record: DecisionRecord,
    proposal: Proposal,
    current: Readonly<RegistryState>,
  ): Promise<boolean>;
}
export class RunRegistry {
  constructor(
    private readonly storage: TransactionalRegistryStorage,
    private readonly artifacts: SnapshotReader,
    private readonly authority: RegistryAuthority,
    private readonly publisher?: TransactionalArtifactPublisher,
  ) {}
  async snapshot(): Promise<RegistryState> {
    return this.storage.read();
  }
  async run(id: string): Promise<{ run: Run; state: RunState }> {
    const state = await this.storage.read();
    const run = state.runs[id];
    requireThat(run, `Unknown Run ${id}`, "UNAVAILABLE");
    return { run: jsonCopy(run), state: deriveRunState(run) };
  }
  private async checked(ref: ExactArtifactRef): Promise<ArtifactSnapshot> {
    requireThat(validRef(ref), "Invalid exact artifact reference");
    const result = await this.artifacts.read(ref.artifactId, ref.revision);
    requireThat(
      result.digest === ref.lockDigest,
      "Artifact lock mismatch",
      "UNVERIFIED",
    );
    return result.artifact;
  }
  async seedCanonical(refsInput: readonly ExactArtifactRef[]): Promise<void> {
    const refs = jsonCopy(refsInput);
    requireThat(
      new Set(refs.map((r) => r.artifactId)).size === refs.length,
      "Duplicate canonical artifact",
    );
    for (const ref of refs)
      requireThat(
        (await this.checked(ref)).lifecycle.status === "approved",
        "Canonical seed requires approved artifact",
        "UNVERIFIED",
      );
    await this.storage.transact(async (state) => {
      requireThat(
        !Object.keys(state.canonical).length && !Object.keys(state.runs).length,
        "Registry already initialized",
        "CONFLICT",
      );
      for (const ref of refs) state.canonical[ref.artifactId] = { ref };
    });
  }
  async start(input: {
    id: string;
    scope: string;
    entryMode: Run["entryMode"];
    base: readonly ExactArtifactRef[];
    reused: Run["reused"];
    safeActions: readonly string[];
    actor: Actor;
    at: string;
    reason: string;
  }): Promise<Run> {
    const x = jsonCopy(input);
    requireThat(
      x.id?.trim() &&
        x.scope?.trim() &&
        ["system-first", "experience-first", "hybrid"].includes(x.entryMode),
      "Invalid Run identity",
    );
    requireThat(
      new Set(x.base.map((r) => r.artifactId)).size === x.base.length,
      "Duplicate base reference",
    );
    for (const ref of x.base) await this.checked(ref);
    for (const reuse of x.reused) {
      requireThat(
        x.base.some((r) => same(r, reuse.ref)) && reuse.reason.trim(),
        "Reuse must cite exact base and reason",
      );
    }
    return this.storage.transact(async (state) => {
      requireThat(!state.runs[x.id], "Run ID already exists", "CONFLICT");
      for (const ref of x.base) {
        const selection = state.canonical[ref.artifactId];
        requireThat(
          same(selection?.ref, ref),
          "Canonical base moved",
          "CONFLICT",
        );
        const approved = await this.checked(ref);
        requireThat(
          approved.lifecycle.status === "approved" &&
            approved.approval.status === "approved",
          "Canonical base must read back as an approved envelope",
          "UNVERIFIED",
        );
        if (selection.decisionId)
          requireThat(
            state.decisions[selection.decisionId]?.outcome === "approved" &&
              approved.approval.decisionId === selection.decisionId,
            "Canonical authority missing or mismatched",
            "UNVERIFIED",
          );
      }
      const run: Run = {
        id: x.id,
        scope: x.scope,
        entryMode: x.entryMode,
        base: x.base,
        reused: x.reused,
        artifacts: [],
        proposals: {},
        blockers: {},
        safeActions: x.safeActions,
      };
      state.runs[x.id] = run;
      event(state, x.id, "start", x.actor, x.at, x.reason, x.base);
      closeCompleted(state, x.id, x.actor, x.at);
      return jsonCopy(state.runs[x.id]);
    });
  }
  async produce(input: {
    runId: string;
    ref: ExactArtifactRef;
    inputs: readonly ExactArtifactRef[];
    actor: Actor;
    at: string;
    reason: string;
  }): Promise<void> {
    const x = jsonCopy(input);
    const artifact = await this.checked(x.ref);
    requireThat(
      artifact.lifecycle.status === "provisional" ||
        artifact.lifecycle.status === "proposed",
      "Produced revision must be provisional or proposed",
    );
    for (const ref of x.inputs) await this.checked(ref);
    await this.storage.transact(async (state) => {
      const run = state.runs[x.runId];
      requireThat(
        run &&
          !run.closed &&
          ["active", "review-ready"].includes(deriveRunState(run)),
        "Run cannot produce provisional work",
        "CONFLICT",
      );
      requireThat(
        !run.artifacts.some((r) => same(r, x.ref)) &&
          !Object.values(state.runs).some(
            (other) =>
              other.id !== x.runId &&
              other.artifacts.some((r) => same(r, x.ref)),
          ),
        "Revision already owned",
        "CONFLICT",
      );
      for (const input of x.inputs)
        requireThat(
          [...run.base, ...run.artifacts].some((r) => same(r, input)),
          "Input is outside the Run base and branch",
          "CONFLICT",
        );
      for (const dependency of artifact.dependencies)
        requireThat(
          x.inputs.some((r) =>
            same(r, {
              artifactId: dependency.artifactId,
              revision: dependency.revision,
              lockDigest: dependency.lockDigest,
            }),
          ),
          "Dependency is absent from exact inputs",
          "CONFLICT",
        );
      state.runs[x.runId] = { ...run, artifacts: [...run.artifacts, x.ref] };
      event(
        state,
        x.runId,
        "produce-provisional",
        x.actor,
        x.at,
        x.reason,
        x.inputs,
        [x.ref],
      );
    });
  }
  async submit(input: {
    runId: string;
    packetId: string;
    proposals: readonly Omit<
      Proposal,
      "packetId" | "status" | "readiness" | "readinessReason"
    >[];
    actor: Actor;
    at: string;
    reason: string;
    externalRefs?: readonly string[];
  }): Promise<void> {
    const x = jsonCopy(input);
    requireThat(
      x.proposals.length > 0 &&
        new Set(x.proposals.map((p) => p.id)).size === x.proposals.length,
      "Packet needs distinct proposals",
    );
    for (const p of x.proposals) {
      const artifact = await this.checked(p.ref);
      requireThat(
        artifact.lifecycle.status === "proposed" &&
          artifact.approval.status === "pending" &&
          artifact.lifecycle.freshness === "valid",
        "Proposal must be fresh and pending",
      );
      requireThat(
        p.alternatives.length > 0 && p.rationale.trim(),
        "Proposal needs alternatives and rationale",
      );
    }
    await this.storage.transact(async (state) => {
      const run = state.runs[x.runId];
      requireThat(
        run &&
          !run.closed &&
          ["active", "review-ready"].includes(deriveRunState(run)),
        "Run cannot submit proposals",
        "CONFLICT",
      );
      requireThat(
        !state.packets[x.packetId],
        "Packet already exists",
        "CONFLICT",
      );
      for (const p of x.proposals) {
        requireThat(
          !run.proposals[p.id] &&
            run.artifacts.some((r) => same(r, p.ref)) &&
            !Object.values(run.proposals).some((old) => same(old.ref, p.ref)),
          "Proposal must own a unique produced revision",
        );
        const rejected = Object.values(run.proposals).filter(
          (old) =>
            old.ref.artifactId === p.ref.artifactId &&
            (old.status === "rejected" || old.status === "superseded"),
        );
        requireThat(
          rejected.every((old) => !same(old.ref, p.ref)),
          "Rejected revision cannot be replayed",
          "CONFLICT",
        );
        if (rejected.length)
          requireThat(
            p.priorRejectionId &&
              rejected.some((old) =>
                Object.values(state.decisions).some(
                  (d) => d.id === p.priorRejectionId && d.proposalId === old.id,
                ),
              ),
            "Renewed proposal must cite rejection",
            "CONFLICT",
          );
        requireThat(
          same(state.canonical[p.ref.artifactId]?.ref, p.expectedCanonical) ||
            (!state.canonical[p.ref.artifactId] && !p.expectedCanonical),
          "Expected canonical selection moved",
          "CONFLICT",
        );
        run.proposals[p.id] = {
          ...p,
          packetId: x.packetId,
          status: "pending",
          readiness: "ready",
        };
      }
      state.packets[x.packetId] = {
        id: x.packetId,
        runId: x.runId,
        proposalIds: x.proposals.map((p) => p.id),
        createdAt: x.at,
        reason: x.reason,
        ...(x.externalRefs ? { externalRefs: x.externalRefs } : {}),
      };
      event(
        state,
        x.runId,
        "submit-proposal",
        x.actor,
        x.at,
        x.reason,
        x.proposals
          .map((p) => p.expectedCanonical)
          .filter((r): r is ExactArtifactRef => !!r),
        x.proposals.map((p) => p.ref),
      );
    });
  }
  private atomicStorage(): AtomicRegistryStorage {
    const storage = this.storage as Partial<AtomicRegistryStorage>;
    requireThat(
      typeof storage.transactWorkspace === "function" &&
        !!storage.snapshots &&
        !!this.publisher &&
        this.publisher.sourceStorage === storage.snapshots,
      "Shared artifact/registry transaction unavailable",
      "UNAVAILABLE",
    );
    return storage as AtomicRegistryStorage;
  }
  private validateOutput(record: DecisionRecord, proposal: Proposal): void {
    if (record.outcome !== "approved" && record.outcome !== "rejected") return;
    const output = record.output;
    requireThat(
      output && validRef(output.ref),
      "Decision must bind an exact output",
      "INVALID",
    );
    const artifact = output.artifact;
    requireThat(
      artifact.meta.id === proposal.ref.artifactId &&
        output.ref.artifactId === proposal.ref.artifactId &&
        artifact.meta.revision === proposal.ref.revision + 1 &&
        output.ref.revision === artifact.meta.revision &&
        artifact.meta.supersedesRevision === proposal.ref.revision &&
        artifact.lifecycle.status === record.outcome &&
        artifact.approval.status === record.outcome &&
        artifact.approval.decisionId === record.id &&
        artifact.approval.actorId === record.actor.id &&
        artifact.approval.at === record.at &&
        artifact.meta.contentDigest === output.ref.lockDigest &&
        artifactDigest(artifact) === output.ref.lockDigest,
      "Decision output does not match the exact approved/rejected envelope",
      "INVALID",
    );
  }
  async decide(input: DecisionRecord): Promise<void> {
    const x = jsonCopy(input);
    requireThat(
      x.actor.kind === "human" &&
        x.actor.id.trim() &&
        x.rationale.trim() &&
        Number.isFinite(Date.parse(x.at)),
      "Decision needs human identity, time, rationale",
    );
    const change = async (
      state: RegistryState,
      snapshots?: import("../artifact-store.js").SnapshotStorage,
    ): Promise<void> => {
      const previous = state.decisions[x.id];
      if (previous) {
        requireThat(same(previous, x), "Decision ID conflict", "CONFLICT");
        return;
      }
      const packet = state.packets[x.packetId];
      const run = packet && state.runs[packet.runId];
      const proposal = run?.proposals[x.proposalId];
      requireThat(
        packet &&
          run &&
          !run.closed &&
          packet.proposalIds.includes(x.proposalId) &&
          proposal?.status === "pending" &&
          (proposal.readiness === "ready" || proposal.deferred),
        "Decision does not name a ready pending proposal",
        "CONFLICT",
      );
      requireThat(
        !Object.values(state.decisions).some(
          (d) =>
            d.packetId === x.packetId &&
            d.proposalId === x.proposalId &&
            d.outcome !== "deferred",
        ),
        "Proposal already decided",
        "CONFLICT",
      );
      if (x.outcome !== "deferred") {
        requireThat(
          same(
            state.canonical[proposal.ref.artifactId]?.ref,
            proposal.expectedCanonical,
          ),
          "Decision candidate has a stale canonical base",
          "CONFLICT",
        );
        const candidate = await this.checked(proposal.ref);
        requireThat(
          candidate.lifecycle.status === "proposed" &&
            candidate.lifecycle.freshness === "valid",
          "Decision candidate is no longer fresh",
          "CONFLICT",
        );
      }
      this.validateOutput(x, proposal);
      if (x.supersedesDecisionId) {
        const prior = state.decisions[x.supersedesDecisionId];
        const priorPacket = prior && state.packets[prior.packetId];
        const priorProposal =
          priorPacket &&
          state.runs[priorPacket.runId]?.proposals[prior.proposalId];
        requireThat(
          prior &&
            priorPacket?.runId === run.id &&
            priorProposal?.ref.artifactId === proposal.ref.artifactId &&
            !same(priorProposal.ref, proposal.ref),
          "Supersession must cite a prior decision on another revision of the same Run artifact",
          "CONFLICT",
        );
        if (priorProposal.status === "pending")
          priorProposal.status = "superseded";
      }
      requireThat(
        await this.authority.verify(x, proposal),
        "Decision authority unverified",
        "UNVERIFIED",
      );
      state.decisions[x.id] = x;
      if (x.outcome === "deferred") {
        proposal.deferred = true;
        proposal.readiness = "blocked";
        proposal.readinessReason = "Human decision deferred";
        run.blockers[`decision:${proposal.id}`] = "Human decision deferred";
      } else {
        proposal.deferred = false;
        delete run.blockers[`decision:${proposal.id}`];
        if (proposal.status === "pending") {
          proposal.readiness = "ready";
          delete proposal.readinessReason;
        }
      }
      if (x.outcome === "rejected") {
        requireThat(
          snapshots && this.publisher && x.output,
          "Atomic rejection publication unavailable",
          "UNAVAILABLE",
        );
        const published = await this.publisher.publish(
          snapshots,
          state,
          x.output.artifact,
        );
        requireThat(
          published.digest === x.output.ref.lockDigest,
          "Rejected output digest mismatch",
          "CONFLICT",
        );
        proposal.status = "rejected";
      } else if (x.outcome === "superseded") proposal.status = "superseded";
      event(
        state,
        run.id,
        `decision-${x.outcome}`,
        x.actor,
        x.at,
        x.rationale,
        [proposal.ref],
        x.output ? [x.output.ref] : [],
        { decision: x },
      );
      closeCompleted(state, run.id, x.actor, x.at);
    };
    if (x.outcome === "rejected")
      await this.atomicStorage().transactWorkspace(change);
    else await this.storage.transact((state) => change(state));
  }
  async commit(input: CommitRequest): Promise<void> {
    const x = jsonCopy(input);
    requireThat(
      x.id?.trim() &&
        x.actor.kind === "human" &&
        x.approvals.length > 0 &&
        new Set(x.approvals.map((a) => a.proposalId)).size ===
          x.approvals.length,
      "Commit needs ID and distinct named approvals",
    );
    const storage = this.atomicStorage();
    await storage.transactWorkspace(async (state, snapshots) => {
      const previous = state.commits[x.id];
      if (previous) {
        requireThat(
          same(previous.request, x),
          "Commit ID conflict",
          "CONFLICT",
        );
        return;
      }
      const packet = state.packets[x.packetId];
      const run = packet && state.runs[packet.runId];
      requireThat(
        packet && run && !run.closed,
        "Run or packet unavailable",
        "CONFLICT",
      );
      const approved: { proposal: Proposal; record: DecisionRecord }[] = [];
      const selectedArtifactIds = new Set<string>();
      for (const item of x.approvals) {
        requireThat(
          packet.proposalIds.includes(item.proposalId),
          "Approval outside packet",
        );
        const proposal = run.proposals[item.proposalId];
        const record = state.decisions[item.decisionId];
        requireThat(
          proposal?.status === "pending" &&
            record?.proposalId === item.proposalId &&
            record.packetId === x.packetId &&
            record.outcome === "approved" &&
            record.actor.id === x.actor.id &&
            record.output,
          "No exact named approval",
          "CONFLICT",
        );
        requireThat(
          !selectedArtifactIds.has(proposal.ref.artifactId),
          "Commit has overlapping canonical effects",
          "CONFLICT",
        );
        selectedArtifactIds.add(proposal.ref.artifactId);
        requireThat(
          !Object.values(state.runs).some((other) =>
            Object.values(other.proposals).some(
              (p) =>
                same(p.ref, proposal.ref) &&
                (p.status === "rejected" || p.status === "superseded"),
            ),
          ),
          "Rejected exact candidate cannot be committed",
          "CONFLICT",
        );
        this.validateOutput(record, proposal);
        requireThat(
          (await this.authority.verify(record, proposal)) &&
            (await this.authority.allowCommit(
              record,
              proposal,
              jsonCopy(state),
            )),
          "Commit authority or policy unverified",
          "UNVERIFIED",
        );
        requireThat(
          same(
            state.canonical[proposal.ref.artifactId]?.ref,
            proposal.expectedCanonical,
          ) ||
            (!state.canonical[proposal.ref.artifactId] &&
              !proposal.expectedCanonical),
          "Latest canonical selection changed",
          "CONFLICT",
        );
        const candidate = await this.publisher!.reader(snapshots, state).read(
          proposal.ref.artifactId,
          proposal.ref.revision,
        );
        requireThat(
          candidate.digest === proposal.ref.lockDigest &&
            candidate.artifact.lifecycle.status === "proposed" &&
            candidate.artifact.approval.status === "pending" &&
            candidate.artifact.lifecycle.freshness === "valid",
          "Proposal is no longer fresh, exact, and pending",
          "CONFLICT",
        );
        approved.push({ proposal, record });
      }
      // Publish dependency-first inside an isolated state. None become visible until the workspace rename.
      const remaining = [...approved];
      const outputs = approved.map((a) => a.record.output!.ref);
      while (remaining.length) {
        const index = remaining.findIndex(
          (a) =>
            !a.record.output!.artifact.dependencies.some((dep) =>
              remaining.some((other) =>
                same(other.record.output!.ref, {
                  artifactId: dep.artifactId,
                  revision: dep.revision,
                  lockDigest: dep.lockDigest,
                }),
              ),
            ),
        );
        requireThat(
          index >= 0,
          "Cyclic approved output dependencies",
          "CONFLICT",
        );
        const [{ record, proposal }] = remaining.splice(index, 1);
        const artifact = record.output!.artifact;
        for (const dep of artifact.dependencies) {
          const ref = {
            artifactId: dep.artifactId,
            revision: dep.revision,
            lockDigest: dep.lockDigest,
          };
          const exact = await this.publisher!.reader(snapshots, state).read(
            ref.artifactId,
            ref.revision,
          );
          requireThat(
            exact.digest === ref.lockDigest &&
              exact.artifact.lifecycle.status === "approved" &&
              exact.artifact.lifecycle.freshness === "valid",
            "Dependency must be a fresh approved exact revision",
            "CONFLICT",
          );
          const assessed = state.freshness[ref.artifactId];
          if (assessed && same(assessed.ref, ref)) {
            requireThat(
              assessed.status !== "blocked",
              "Dependency has a blocked registry freshness assessment",
              "CONFLICT",
            );
            const evidence =
              proposal.impactEvidence?.find((item) =>
                same(item.dependency, ref),
              )?.evidenceRefs ?? [];
            requireThat(
              evidence.length > 0 &&
                (await this.authority.verifyEvidence?.(
                  proposal,
                  ref,
                  evidence,
                )),
              "Stale dependency requires verified validation evidence",
              "UNVERIFIED",
            );
          }
          const current = state.canonical[ref.artifactId]?.ref;
          const adoptedInSet = outputs.some((output) => same(output, ref));
          if (current && !same(current, ref) && !adoptedInSet) {
            if (dep.onChange === "validate") {
              const evidence =
                proposal.impactEvidence?.find((item) =>
                  same(item.dependency, ref),
                )?.evidenceRefs ?? [];
              requireThat(
                evidence.length > 0 &&
                  (await this.authority.verifyEvidence?.(
                    proposal,
                    ref,
                    evidence,
                  )),
                "Changed dependency requires verified validation evidence",
                "UNVERIFIED",
              );
            } else
              requireThat(
                dep.onChange === "none" || dep.onChange === "revise",
                "Changed canonical dependency requires a new revision or resolution",
                "CONFLICT",
              );
          }
        }
        const published = await this.publisher!.publish(
          snapshots,
          state,
          artifact,
        );
        requireThat(
          published.digest === record.output!.ref.lockDigest,
          "Approved output digest mismatch",
          "CONFLICT",
        );
      }
      const txReader = this.publisher!.reader(snapshots, state);
      await DependencyGraph.load(txReader, outputs);
      const previousRoots = Object.values(state.canonical).map(
        (selection) => selection.ref,
      );
      const graph = previousRoots.length
        ? await DependencyGraph.load(txReader, previousRoots)
        : undefined;
      const changes = approved
        .filter((item) => !!state.canonical[item.proposal.ref.artifactId])
        .map((item) => ({
          artifactId: item.proposal.ref.artifactId,
          fromRevision:
            state.canonical[item.proposal.ref.artifactId].ref.revision,
          candidateRevision: item.record.output!.ref.revision,
          candidateDigest: item.record.output!.ref.lockDigest,
        }));
      const findings =
        graph && changes.length ? await graph.assessChanges(changes) : [];
      for (const finding of findings) {
        if (selectedArtifactIds.has(finding.artifact.artifactId)) continue;
        state.freshness[finding.artifact.artifactId] = {
          ref: finding.artifact,
          status: finding.freshness,
          reason: finding.reason,
        };
      }
      for (const { proposal, record } of approved) {
        delete state.freshness[proposal.ref.artifactId];
        state.canonical[proposal.ref.artifactId] = {
          ref: record.output!.ref,
          decisionId: record.id,
        };
        proposal.status = "merged";
      }
      state.commits[x.id] = { request: x, outputs };
      await this.refreshPending(
        state,
        this.publisher!.reader(snapshots, state),
        x.actor,
        x.at,
      );
      event(
        state,
        run.id,
        "commit-point-approve",
        x.actor,
        x.at,
        x.reason,
        approved.map((a) => a.proposal.ref),
        outputs,
        { commit: x },
      );
      closeCompleted(state, run.id, x.actor, x.at);
    });
  }
  private async refreshPending(
    state: RegistryState,
    reader: SnapshotReader,
    actor: Actor,
    at: string,
  ): Promise<void> {
    for (const run of Object.values(state.runs)) {
      if (run.closed) continue;
      let changed = false;
      for (const proposal of Object.values(run.proposals)) {
        if (proposal.status !== "pending" || proposal.deferred) continue;
        let readiness: Proposal["readiness"] = "ready";
        let reason: string | undefined;
        if (
          !same(
            state.canonical[proposal.ref.artifactId]?.ref,
            proposal.expectedCanonical,
          )
        ) {
          readiness = "stale";
          reason = "Canonical selection moved since proposal submission";
        } else {
          try {
            const exact = await reader.read(
              proposal.ref.artifactId,
              proposal.ref.revision,
            );
            const blockedDependency = exact.artifact.dependencies.some(
              (dep) => {
                const assessment = state.freshness[dep.artifactId];
                return (
                  assessment &&
                  same(assessment.ref, {
                    artifactId: dep.artifactId,
                    revision: dep.revision,
                    lockDigest: dep.lockDigest,
                  })
                );
              },
            );
            if (
              exact.digest !== proposal.ref.lockDigest ||
              exact.artifact.lifecycle.freshness !== "valid" ||
              blockedDependency
            ) {
              readiness = "blocked";
              reason = "Exact proposal lock or freshness is invalid";
            }
          } catch {
            readiness = "blocked";
            reason = "Exact proposal cannot be verified";
          }
        }
        if (
          proposal.readiness !== readiness ||
          proposal.readinessReason !== reason
        )
          changed = true;
        proposal.readiness = readiness;
        if (reason) {
          proposal.readinessReason = reason;
          run.blockers[`proposal:${proposal.id}`] = reason;
        } else {
          delete proposal.readinessReason;
          delete run.blockers[`proposal:${proposal.id}`];
        }
      }
      if (changed)
        event(
          state,
          run.id,
          "proposal-readiness",
          actor,
          at,
          "Revalidated pending proposals against current canonical state",
        );
    }
  }
  async refreshReadiness(input: { actor: Actor; at: string }): Promise<void> {
    const x = jsonCopy(input);
    await this.storage.transact(async (state) =>
      this.refreshPending(state, this.artifacts, x.actor, x.at),
    );
  }
  async setWork(input: {
    runId: string;
    safeActions: readonly string[];
    blockers: Record<string, string>;
    actor: Actor;
    at: string;
    reason: string;
    resolutions?: Record<
      string,
      { evidenceRefs?: readonly string[]; decisionId?: string }
    >;
  }): Promise<void> {
    const x = jsonCopy(input);
    requireThat(
      Object.values(x.blockers).every((v) => v.trim()) &&
        x.safeActions.every((v) => v.trim()),
      "Work and blocker reasons required",
    );
    await this.storage.transact(async (state) => {
      const run = state.runs[x.runId];
      requireThat(
        run && !run.closed && deriveRunState(run) !== "closed",
        "Run is closed",
        "CONFLICT",
      );
      for (const blockerId of Object.keys(run.blockers)) {
        if (Object.hasOwn(x.blockers, blockerId)) continue;
        requireThat(
          !blockerId.startsWith("proposal:") &&
            !blockerId.startsWith("decision:"),
          "Review hold requires an explicit new decision or revision",
          "CONFLICT",
        );
        const resolution = x.resolutions?.[blockerId];
        requireThat(
          resolution,
          `Missing resolution for ${blockerId}`,
          "UNVERIFIED",
        );
        const decision =
          resolution.decisionId && state.decisions[resolution.decisionId];
        const evidence = resolution.evidenceRefs ?? [];
        requireThat(
          (decision && decision.actor.kind === "human") ||
            (evidence.length > 0 &&
              (await this.authority.verifyResolution?.(blockerId, evidence))),
          `Unverified resolution for ${blockerId}`,
          "UNVERIFIED",
        );
      }
      state.runs[x.runId] = {
        ...run,
        safeActions: x.safeActions,
        blockers: x.blockers,
      };
      event(state, x.runId, "set-work", x.actor, x.at, x.reason, [], [], {
        resolutions: x.resolutions ?? {},
      });
      closeCompleted(state, x.runId, x.actor, x.at);
    });
  }
  async discard(input: {
    runId: string;
    actor: Actor;
    at: string;
    reason: string;
  }): Promise<void> {
    const x = jsonCopy(input);
    await this.storage.transact(async (state) => {
      const run = state.runs[x.runId];
      requireThat(
        run && !run.closed && deriveRunState(run) !== "closed",
        "Run is closed",
        "CONFLICT",
      );
      const fates: Record<string, Proposal["status"]> = {};
      for (const p of Object.values(run.proposals)) {
        if (p.status === "pending") p.status = "discarded";
        fates[p.id] = p.status;
      }
      state.runs[x.runId] = {
        ...run,
        closed: { at: x.at, reason: x.reason, fates },
      };
      event(state, x.runId, "discard-run", x.actor, x.at, x.reason);
    });
  }
}

/** One-file transaction: an exclusive lock protects read/validate/write; rename is the sole visibility point. */
export class FileRegistryStorage implements TransactionalRegistryStorage {
  constructor(readonly file: string) {}
  async read(): Promise<RegistryState> {
    try {
      return jsonCopy(
        JSON.parse(await readFile(this.file, "utf8")) as RegistryState,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw error;
    }
  }
  async transact<T>(change: (state: RegistryState) => Promise<T>): Promise<T> {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true });
    const lock = `${this.file}.lock`;
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new RegistryError("CONFLICT", "Registry writer lock held");
      throw error;
    }
    let temp: string | undefined;
    try {
      const state = await this.read();
      const before = canonicalJson(state);
      const result = await change(state);
      if (canonicalJson(state) !== before) {
        temp = path.join(directory, `.${randomUUID()}.pending`);
        const handle = await open(temp, "wx", 0o600);
        try {
          await handle.writeFile(canonicalJson(state), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, this.file);
        temp = undefined;
        const dir = await open(directory, "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
      return result === undefined ? result : jsonCopy(result);
    } finally {
      if (temp) await rm(temp, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
