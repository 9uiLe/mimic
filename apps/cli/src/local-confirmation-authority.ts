// Local approval is a cooperative host assertion, not an OS authentication boundary.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  FileWorkspaceStorage,
  type CommitRequest,
  type DecisionRecord,
  type ExactArtifactRef,
  type Proposal,
  type DecisionPacket,
  type RegistryAuthority,
  type RegistryState,
} from "@mimic/core";
import { atomicCreateJson } from "./atomic-file.js";

export const LOCAL_MARKER = "mimic-local-confirmation:";
export const SIGNED_MARKER = "mimic-receipt:";
const RESERVED = [LOCAL_MARKER, SIGNED_MARKER];

export interface LocalConfirmation {
  readonly version: 1;
  readonly action: "decide" | "commit";
  readonly hostId: string;
  readonly humanActorId: string;
  readonly confirmedAt: string;
  readonly runId: string;
  readonly scopeOwnerId: string;
  readonly packetId: string;
  readonly packetDigest: string;
  readonly requestId: string;
  readonly requestDigest: string;
  /** Persisted by the adapter to reconstruct the caller's exact request. */
  readonly externalRefsPresent?: boolean;
  readonly conversationRef?: string;
  readonly proposalId?: string;
  readonly proposalDigest?: string;
  readonly outcome?: DecisionRecord["outcome"];
  readonly candidate?: ExactArtifactRef;
  readonly expectedCanonical?: ExactArtifactRef;
  readonly output?: ExactArtifactRef;
  readonly approvals?: CommitRequest["approvals"];
}

export class LocalConfirmationError extends Error {
  constructor(
    readonly code: "INVALID" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "LocalConfirmationError";
  }
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new LocalConfirmationError("INVALID", message);
}
function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
function same(a: unknown, b: unknown): boolean {
  return a === undefined || b === undefined
    ? a === b
    : canonicalJson(a) === canonicalJson(b);
}
function name(value: string): string {
  check(/^sha256:[0-9a-f]{64}$/.test(value), "Invalid confirmation digest");
  return `${value.slice(7)}.json`;
}
function idName(value: string): string {
  check(
    typeof value === "string" && value.trim().length > 0,
    "Invalid request ID",
  );
  return name(digest(value));
}
function proposalIntent(proposal: Proposal): object {
  return {
    id: proposal.id,
    ref: proposal.ref,
    ...(proposal.expectedCanonical
      ? { expectedCanonical: proposal.expectedCanonical }
      : {}),
    alternatives: proposal.alternatives,
    rationale: proposal.rationale,
    evidenceLimits: proposal.evidenceLimits,
    dependents: proposal.dependents,
    ...(proposal.priorRejectionId
      ? { priorRejectionId: proposal.priorRejectionId }
      : {}),
    ...(proposal.impactEvidence
      ? { impactEvidence: proposal.impactEvidence }
      : {}),
    packetId: proposal.packetId,
  };
}
export function localProposalDigest(proposal: Proposal): string {
  return digest(proposalIntent(proposal));
}
export function localPacketDigest(packet: DecisionPacket): string {
  return digest(packet);
}
export function assertNoReservedRefs(record: DecisionRecord): void {
  check(
    !record.externalRefs?.some((ref) =>
      RESERVED.some((prefix) => ref.startsWith(prefix)),
    ),
    "Caller supplied a reserved authority marker",
  );
}
function unmarked(
  record: DecisionRecord,
  externalRefsPresent: boolean,
): DecisionRecord {
  const refs = record.externalRefs?.filter(
    (ref) => !RESERVED.some((prefix) => ref.startsWith(prefix)),
  );
  if (externalRefsPresent) return { ...record, externalRefs: refs ?? [] };
  check(!refs?.length, "Unexpected unconfirmed external references");
  const copy = { ...record };
  delete (copy as { externalRefs?: readonly string[] }).externalRefs;
  return copy;
}
function validConfirmation(c: LocalConfirmation): boolean {
  const keys = Object.keys(c ?? {});
  const allowed = new Set([
    "version",
    "action",
    "hostId",
    "humanActorId",
    "confirmedAt",
    "runId",
    "scopeOwnerId",
    "packetId",
    "packetDigest",
    "requestId",
    "requestDigest",
    "externalRefsPresent",
    "conversationRef",
    "proposalId",
    "proposalDigest",
    "outcome",
    "candidate",
    "expectedCanonical",
    "output",
    "approvals",
  ]);
  return (
    !!c &&
    keys.every((key) => allowed.has(key)) &&
    c.version === 1 &&
    ["decide", "commit"].includes(c.action) &&
    [
      c.hostId,
      c.humanActorId,
      c.runId,
      c.scopeOwnerId,
      c.packetId,
      c.requestId,
    ].every((value) => typeof value === "string" && value.trim().length > 0) &&
    /^sha256:[0-9a-f]{64}$/.test(c.requestDigest) &&
    /^sha256:[0-9a-f]{64}$/.test(c.packetDigest) &&
    Number.isFinite(Date.parse(c.confirmedAt)) &&
    Date.parse(c.confirmedAt) <= Date.now() &&
    (c.action !== "decide" || typeof c.externalRefsPresent === "boolean") &&
    (c.action !== "commit" || c.externalRefsPresent === undefined) &&
    (c.conversationRef === undefined ||
      (typeof c.conversationRef === "string" &&
        c.conversationRef.trim().length > 0))
  );
}

export class LocalConfirmationAuthority implements RegistryAuthority {
  private preparedCommit?: {
    request: CommitRequest;
    confirmation: LocalConfirmation;
  };
  constructor(
    private readonly workspace: FileWorkspaceStorage,
    private readonly root: string,
  ) {}
  private folder(): string {
    return path.join(this.root, ".mimic", "confirmations");
  }
  private async readStored(file: string): Promise<unknown> {
    const root = await realpath(this.root);
    const resolved = await realpath(file);
    const metadata = await lstat(file);
    check(
      metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        resolved.startsWith(`${root}${path.sep}`),
      "Confirmation file escapes workspace",
    );
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  }
  private async store(c: LocalConfirmation): Promise<void> {
    const folder = this.folder();
    const ids = path.join(folder, "ids");
    await mkdir(ids, { recursive: true });
    const root = await realpath(this.root);
    for (const directory of [folder, ids])
      check(
        (await realpath(directory)).startsWith(`${root}${path.sep}`),
        "Confirmation store escapes workspace",
      );
    const confirmationDigest = digest(c);
    await atomicCreateJson(path.join(folder, name(confirmationDigest)), c);
    const binding = {
      action: c.action,
      requestDigest: c.requestDigest,
      confirmationDigest,
    };
    const file = path.join(ids, idName(`${c.action}:${c.requestId}`));
    if (
      !(await atomicCreateJson(file, binding)) &&
      !same(await this.readStored(file), binding)
    )
      throw new LocalConfirmationError(
        "CONFLICT",
        "Confirmation ID changed request",
      );
  }
  private async lookup(value: string): Promise<LocalConfirmation> {
    const c = (await this.readStored(
      path.join(this.folder(), name(value)),
    )) as LocalConfirmation;
    check(
      validConfirmation(c) && digest(c) === value,
      "Invalid stored confirmation",
    );
    const binding = await this.readStored(
      path.join(this.folder(), "ids", idName(`${c.action}:${c.requestId}`)),
    );
    check(
      same(binding, {
        action: c.action,
        requestDigest: c.requestDigest,
        confirmationDigest: value,
      }),
      "Confirmation ID binding mismatch",
    );
    return c;
  }
  private bindsDecision(
    c: LocalConfirmation,
    record: DecisionRecord,
    proposal: Proposal,
    state: RegistryState,
  ): boolean {
    const packet = state.packets[record.packetId];
    const run = packet && state.runs[packet.runId];
    return (
      validConfirmation(c) &&
      c.action === "decide" &&
      c.proposalId === record.proposalId &&
      c.outcome === record.outcome &&
      c.proposalDigest === localProposalDigest(proposal) &&
      c.humanActorId === record.actor.id &&
      record.actor.kind === "human" &&
      !!packet &&
      !!run &&
      packet.proposalIds.includes(record.proposalId) &&
      c.runId === run.id &&
      c.scopeOwnerId === run.scope &&
      c.packetId === record.packetId &&
      c.requestId === record.id &&
      c.packetDigest === localPacketDigest(packet) &&
      same(c.candidate, proposal.ref) &&
      same(c.expectedCanonical, proposal.expectedCanonical) &&
      same(c.output, record.output?.ref) &&
      c.approvals === undefined &&
      c.requestDigest === digest(unmarked(record, c.externalRefsPresent!)) &&
      Date.parse(c.confirmedAt) <= Date.parse(record.at)
    );
  }
  async prepareDecision(
    record: DecisionRecord,
    c: LocalConfirmation,
  ): Promise<DecisionRecord> {
    assertNoReservedRefs(record);
    check(
      c && c.externalRefsPresent === undefined,
      "Adapter metadata is reserved",
    );
    const stored = {
      ...c,
      externalRefsPresent: record.externalRefs !== undefined,
    };
    const state = await this.workspace.read();
    const packet = state.packets[record.packetId];
    const proposal =
      packet && state.runs[packet.runId]?.proposals[record.proposalId];
    check(proposal, "Unknown proposal for confirmation");
    const marked: DecisionRecord = {
      ...record,
      externalRefs: [
        ...(record.externalRefs ?? []),
        `${LOCAL_MARKER}${digest(stored)}`,
      ],
    };
    check(
      this.bindsDecision(stored, marked, proposal, state),
      "Confirmation does not bind exact decision and candidate",
    );
    await this.store(stored);
    return marked;
  }
  async verify(record: DecisionRecord, proposal: Proposal): Promise<boolean> {
    try {
      const marks =
        record.externalRefs?.filter((ref) =>
          RESERVED.some((prefix) => ref.startsWith(prefix)),
        ) ?? [];
      if (marks.length !== 1 || !marks[0]!.startsWith(LOCAL_MARKER))
        return false;
      const c = await this.lookup(marks[0]!.slice(LOCAL_MARKER.length));
      const state = await this.workspace.readVerificationState();
      if (
        state.decisions[record.id] &&
        !same(state.decisions[record.id], record)
      )
        return false;
      return this.bindsDecision(c, record, proposal, state);
    } catch {
      return false;
    }
  }
  async prepareCommit(
    request: CommitRequest,
    c: LocalConfirmation,
  ): Promise<void> {
    const state = await this.workspace.read();
    const packet = state.packets[request.packetId];
    const run = packet && state.runs[packet.runId];
    check(
      validConfirmation(c) &&
        c.action === "commit" &&
        !!packet &&
        !!run &&
        request.actor.kind === "human" &&
        c.humanActorId === request.actor.id &&
        c.runId === run.id &&
        c.scopeOwnerId === run.scope &&
        c.packetId === request.packetId &&
        c.packetDigest === localPacketDigest(packet) &&
        c.requestId === request.id &&
        c.requestDigest === digest(request) &&
        same(c.approvals, request.approvals) &&
        c.proposalId === undefined &&
        c.proposalDigest === undefined &&
        c.outcome === undefined &&
        c.candidate === undefined &&
        c.expectedCanonical === undefined &&
        c.output === undefined &&
        Date.parse(c.confirmedAt) <= Date.parse(request.at),
      "Confirmation does not bind exact named commit",
    );
    await this.store(c);
    this.preparedCommit = { request, confirmation: c };
  }
  clearCommit(): void {
    this.preparedCommit = undefined;
  }
  async allowCommit(
    record: DecisionRecord,
    proposal: Proposal,
    state: Readonly<RegistryState>,
  ): Promise<boolean> {
    const prepared = this.preparedCommit;
    if (!prepared) return false;
    const packet = state.packets[prepared.request.packetId];
    const run = packet && state.runs[packet.runId];
    return (
      !!run &&
      prepared.confirmation.scopeOwnerId === run.scope &&
      prepared.request.approvals.some(
        (item) =>
          item.decisionId === record.id && item.proposalId === proposal.id,
      ) &&
      (await this.verify(record, proposal))
    );
  }
}
