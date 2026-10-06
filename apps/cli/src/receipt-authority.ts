import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  FileWorkspaceStorage,
  type CommitRequest,
  type DecisionRecord,
  type ExactArtifactRef,
  type Proposal,
  type RegistryAuthority,
  type RegistryState,
} from "@mimic/core";
import { atomicCreateJson } from "./atomic-file.js";
import {
  LOCAL_MARKER,
  assertNoReservedRefs,
} from "./local-confirmation-authority.js";

export interface OperatorTrust {
  readonly version: 1;
  readonly keys: readonly {
    readonly id: string;
    readonly publicKeyPem: string;
    /** An absent purpose list authorizes decisions only for legacy host keys. */
    readonly purposes?: readonly ("authorize" | "attest")[];
  }[];
}
export interface ReceiptPayload {
  readonly version: 1;
  readonly keyId: string;
  readonly action: "decide" | "commit";
  readonly actorId: string;
  readonly runId: string;
  readonly scopeOwnerId: string;
  readonly packetId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly proposalId?: string;
  readonly outcome?: DecisionRecord["outcome"];
  readonly candidate?: ExactArtifactRef;
  readonly output?: ExactArtifactRef;
  readonly approvals?: CommitRequest["approvals"];
}
export interface SignedReceipt {
  readonly payload: ReceiptPayload;
  readonly signature: string;
}
export interface AcceptancePayload {
  readonly version: 1;
  readonly keyId: string;
  readonly action: "attest-acceptance";
  readonly actorId: string;
  readonly runId: string;
  readonly scopeOwnerId: string;
  readonly decisionId: string;
  readonly decisionDigest: string;
  readonly authorizationDigest: string;
  /** The trusted signer attests it observed Core acceptance at this time. */
  readonly certifiedAt: string;
  readonly decisionEvent: {
    readonly sequence: number;
    readonly digest: string;
  };
  readonly commit?: {
    readonly id: string;
    readonly digest: string;
    readonly authorizationDigest: string;
    readonly event: { readonly sequence: number; readonly digest: string };
  };
}
export interface SignedAcceptance {
  readonly payload: AcceptancePayload;
  readonly signature: string;
}
const marker = "mimic-receipt:";
function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
function same(a: unknown, b: unknown): boolean {
  return a === undefined || b === undefined
    ? a === b
    : canonicalJson(a) === canonicalJson(b);
}
export class ReceiptError extends Error {
  constructor(
    readonly code: "INVALID" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "ReceiptError";
  }
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ReceiptError("INVALID", message);
}
function expiry(
  payload: ReceiptPayload,
  now: string,
  certifiedReadback = false,
): boolean {
  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);
  const at = Date.parse(now);
  const current = Date.now();
  return (
    Number.isFinite(issued) &&
    Number.isFinite(expires) &&
    issued <= at &&
    at <= expires &&
    issued < expires &&
    (certifiedReadback || (issued <= current && current <= expires))
  );
}
function unsignedDecision(record: DecisionRecord): DecisionRecord {
  const copy = { ...record };
  const externalRefs = record.externalRefs?.filter(
    (ref) => !ref.startsWith(marker) && !ref.startsWith(LOCAL_MARKER),
  );
  if (externalRefs?.length) return { ...copy, externalRefs };
  delete (copy as { externalRefs?: readonly string[] }).externalRefs;
  return copy;
}
function receiptMarker(receipt: SignedReceipt): string {
  return `${marker}${digest(receipt)}`;
}
function receiptName(value: string): string {
  check(/^sha256:[0-9a-f]{64}$/.test(value), "Invalid receipt digest");
  return `${value.slice(7)}.json`;
}
function nonceName(value: string): string {
  check(/^[A-Za-z0-9_-]{8,128}$/.test(value), "Invalid receipt nonce");
  return `${digest(value).slice(7)}.json`;
}
function acceptanceName(decisionId: string): string {
  return `${digest(decisionId).slice(7)}.json`;
}
function validTrust(value: unknown): value is OperatorTrust {
  const root = value as OperatorTrust;
  return (
    !!root &&
    root.version === 1 &&
    Array.isArray(root.keys) &&
    root.keys.length > 0 &&
    root.keys.every(
      (key) =>
        key &&
        typeof key.id === "string" &&
        key.id.length > 0 &&
        typeof key.publicKeyPem === "string" &&
        (key.purposes === undefined ||
          (Array.isArray(key.purposes) &&
            key.purposes.length > 0 &&
            key.purposes.every((purpose: string) =>
              ["authorize", "attest"].includes(purpose),
            ))),
    ) &&
    new Set(root.keys.map((key) => key.id)).size === root.keys.length
  );
}
export interface TrustFileAccess {
  readonly stat: (file: string) => Promise<{
    readonly uid: number;
    readonly mode: number;
    isSymbolicLink(): boolean;
    isFile(): boolean;
    isDirectory(): boolean;
  }>;
  readonly text: (file: string) => Promise<string>;
}
const operatingSystemFiles: TrustFileAccess = {
  stat: lstat,
  text: (file) => readFile(file, "utf8"),
};
/** The binary calls this without an adapter: only the fixed, OS-protected path is read. */
export async function loadOperatorTrustRoot(
  access: TrustFileAccess = operatingSystemFiles,
): Promise<OperatorTrust | undefined> {
  if (!process.getuid) return undefined;
  const file =
    process.platform === "darwin"
      ? "/Library/Application Support/Mimic/trust.json"
      : "/etc/mimic/trust.json";
  let current = path.parse(file).root;
  for (const part of ["", ...path.relative(current, file).split(path.sep)]) {
    if (part) current = path.join(current, part);
    let metadata;
    try {
      metadata = await access.stat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    check(
      !metadata.isSymbolicLink() &&
        metadata.uid === 0 &&
        (metadata.mode & 0o022) === 0,
      "Operator trust path is not protected",
    );
    check(
      current === file ? metadata.isFile() : metadata.isDirectory(),
      "Invalid operator trust path",
    );
  }
  const value = JSON.parse(await access.text(file)) as unknown;
  check(validTrust(value), "Invalid operator trust root");
  for (const key of value.keys)
    check(
      createPublicKey(key.publicKeyPem).asymmetricKeyType === "ed25519",
      "Only Ed25519 public keys are supported",
    );
  return value;
}

export class ReceiptAuthority implements RegistryAuthority {
  private preparedCommit?: { request: CommitRequest; receipt: SignedReceipt };
  constructor(
    private readonly workspace: FileWorkspaceStorage,
    private readonly root: string,
    private readonly trust: OperatorTrust,
  ) {
    check(validTrust(trust), "Invalid operator trust root");
  }
  private folder(): string {
    return path.join(this.root, ".mimic", "receipts");
  }
  private async stored(receipt: SignedReceipt): Promise<void> {
    const folder = this.folder();
    await mkdir(path.join(folder, "nonces"), { recursive: true });
    const root = await realpath(this.root);
    const resolved = await realpath(folder);
    check(
      resolved.startsWith(`${root}${path.sep}`) &&
        (await realpath(path.join(folder, "nonces"))).startsWith(
          `${root}${path.sep}`,
        ),
      "Receipt store escapes workspace",
    );
    await atomicCreateJson(
      path.join(folder, receiptName(digest(receipt))),
      receipt,
    );
    const nonceFile = path.join(
      folder,
      "nonces",
      nonceName(receipt.payload.nonce),
    );
    const binding = {
      action: receipt.payload.action,
      requestDigest: receipt.payload.requestDigest,
      receiptDigest: digest(receipt),
    };
    if (!(await atomicCreateJson(nonceFile, binding))) {
      const previous = await this.readStored(nonceFile);
      if (!same(previous, binding))
        throw new ReceiptError(
          "CONFLICT",
          "Receipt nonce replayed for another request",
        );
    }
  }
  private async readStored(file: string): Promise<unknown> {
    const root = await realpath(this.root);
    const resolved = await realpath(file);
    const metadata = await lstat(file);
    check(
      metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        resolved.startsWith(`${root}${path.sep}`),
      "Receipt file escapes workspace",
    );
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  }
  private signed(receipt: SignedReceipt | SignedAcceptance): boolean {
    if (
      !receipt ||
      !receipt.payload ||
      typeof receipt.signature !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(receipt.signature)
    )
      return false;
    const key = this.trust.keys.find(
      (item) => item.id === receipt.payload.keyId,
    );
    const needed =
      receipt.payload.action === "attest-acceptance" ? "attest" : "authorize";
    if (!key || !(key.purposes ?? ["authorize"]).includes(needed)) return false;
    try {
      return verifySignature(
        null,
        Buffer.from(canonicalJson(receipt.payload)),
        createPublicKey(key.publicKeyPem),
        Buffer.from(receipt.signature, "base64url"),
      );
    } catch {
      return false;
    }
  }
  private async lookup(receiptDigest: string): Promise<SignedReceipt> {
    const receipt = (await this.readStored(
      path.join(this.folder(), receiptName(receiptDigest)),
    )) as SignedReceipt;
    check(
      digest(receipt) === receiptDigest && this.signed(receipt),
      "Invalid stored receipt",
    );
    const nonceFile = path.join(
      this.folder(),
      "nonces",
      nonceName(receipt.payload.nonce),
    );
    const binding = await this.readStored(nonceFile);
    check(
      same(binding, {
        action: receipt.payload.action,
        requestDigest: receipt.payload.requestDigest,
        receiptDigest,
      }),
      "Receipt nonce binding mismatch",
    );
    return receipt;
  }
  private async acceptance(
    record: DecisionRecord,
  ): Promise<SignedAcceptance | undefined> {
    const file = path.join(
      this.root,
      ".mimic",
      "acceptances",
      acceptanceName(record.id),
    );
    try {
      return (await this.readStored(file)) as SignedAcceptance;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async bindsAcceptance(
    acceptance: SignedAcceptance,
    record: DecisionRecord,
    receipt: SignedReceipt,
    state: RegistryState,
  ): Promise<boolean> {
    const proof = acceptance.payload;
    const packet = state.packets[record.packetId];
    const run = packet && state.runs[packet.runId];
    const event = state.events.find(
      (item) => item.sequence === proof.decisionEvent.sequence,
    );
    const certified = Date.parse(proof.certifiedAt);
    if (
      !this.signed(acceptance) ||
      proof.version !== 1 ||
      proof.action !== "attest-acceptance" ||
      !run ||
      !same(state.decisions[record.id], record) ||
      proof.actorId !== record.actor.id ||
      proof.runId !== run.id ||
      proof.scopeOwnerId !== run.scope ||
      proof.decisionId !== record.id ||
      proof.decisionDigest !== digest(record) ||
      proof.authorizationDigest !== digest(receipt) ||
      !Number.isFinite(certified) ||
      certified < Date.parse(receipt.payload.issuedAt) ||
      certified > Date.parse(receipt.payload.expiresAt) ||
      certified > Date.now() ||
      !event ||
      event.runId !== run.id ||
      event.action !== `decision-${record.outcome}` ||
      event.at !== record.at ||
      !same(event.details, { decision: record }) ||
      proof.decisionEvent.digest !== digest(event)
    )
      return false;
    if (record.outcome !== "approved") return !proof.commit;
    const commitProof = proof.commit;
    const committed = commitProof && state.commits[commitProof.id];
    const commitEvent =
      commitProof &&
      state.events.find((item) => item.sequence === commitProof.event.sequence);
    if (
      !record.output ||
      !commitProof ||
      !committed ||
      !commitEvent ||
      commitEvent.runId !== run.id ||
      commitEvent.action !== "commit-point-approve" ||
      commitEvent.sequence <= event.sequence ||
      commitEvent.at !== committed.request.at ||
      !same(commitEvent.details, { commit: committed.request }) ||
      commitProof.digest !== digest(committed.request) ||
      commitProof.event.digest !== digest(commitEvent) ||
      !committed.request.approvals.some(
        (item) =>
          item.decisionId === record.id &&
          item.proposalId === record.proposalId,
      ) ||
      !committed.outputs.some((ref) => same(ref, record.output?.ref)) ||
      !commitEvent.outputs.some((ref) => same(ref, record.output?.ref)) ||
      !same(
        commitEvent.canonicalAfter[record.output.ref.artifactId]?.ref,
        record.output.ref,
      )
    )
      return false;
    const commitReceipt = await this.lookup(commitProof.authorizationDigest);
    return (
      commitReceipt.payload.action === "commit" &&
      commitReceipt.payload.requestDigest === digest(committed.request) &&
      commitReceipt.payload.requestId === committed.request.id &&
      commitReceipt.payload.packetId === committed.request.packetId &&
      commitReceipt.payload.runId === run.id &&
      commitReceipt.payload.scopeOwnerId === run.scope &&
      commitReceipt.payload.actorId === committed.request.actor.id &&
      same(commitReceipt.payload.approvals, committed.request.approvals) &&
      expiry(commitReceipt.payload, committed.request.at, true) &&
      certified <= Date.parse(commitReceipt.payload.expiresAt) &&
      certified >= Date.parse(commitReceipt.payload.issuedAt)
    );
  }
  /** Import only host-signed evidence issued after the exact Core effects exist. */
  async certify(acceptance: SignedAcceptance): Promise<void> {
    const id = acceptance?.payload?.decisionId;
    check(
      typeof id === "string" && id.length > 0,
      "Acceptance needs a decision ID",
    );
    check(
      Number.isSafeInteger(acceptance.payload.decisionEvent?.sequence) &&
        typeof acceptance.payload.decisionEvent?.digest === "string" &&
        (!acceptance.payload.commit ||
          (Number.isSafeInteger(acceptance.payload.commit.event?.sequence) &&
            typeof acceptance.payload.commit.event?.digest === "string")),
      "Malformed acceptance event binding",
    );
    const state = await this.workspace.read();
    const record = state.decisions[id];
    check(record, "Acceptance has no recorded decision");
    const marks =
      record.externalRefs?.filter(
        (ref) => ref.startsWith(marker) || ref.startsWith(LOCAL_MARKER),
      ) ?? [];
    check(marks.length === 1, "Decision has no exact authorization receipt");
    const receipt = await this.lookup(marks[0]!.slice(marker.length));
    check(
      await this.bindsAcceptance(acceptance, record, receipt, state),
      "Acceptance does not attest exact Core effects",
    );
    const folder = path.join(this.root, ".mimic", "acceptances");
    await mkdir(folder, { recursive: true });
    const root = await realpath(this.root);
    check(
      (await realpath(folder)).startsWith(`${root}${path.sep}`),
      "Acceptance store escapes workspace",
    );
    const file = path.join(folder, acceptanceName(id));
    if (!(await atomicCreateJson(file, acceptance)))
      check(
        same(await this.readStored(file), acceptance),
        "Acceptance ID already has another certificate",
      );
  }
  private bindsDecision(
    receipt: SignedReceipt,
    record: DecisionRecord,
    proposal: Proposal,
    state: RegistryState,
    certifiedReadback = false,
  ): boolean {
    const payload = receipt.payload;
    const packet = state.packets[record.packetId];
    const run = packet && state.runs[packet.runId];
    return (
      this.signed(receipt) &&
      payload.version === 1 &&
      payload.action === "decide" &&
      !!packet &&
      !!run &&
      packet.proposalIds.includes(record.proposalId) &&
      payload.actorId === record.actor.id &&
      record.actor.kind === "human" &&
      payload.runId === run.id &&
      payload.scopeOwnerId === run.scope &&
      payload.packetId === record.packetId &&
      payload.proposalId === record.proposalId &&
      payload.requestId === record.id &&
      payload.outcome === record.outcome &&
      same(payload.candidate, proposal.ref) &&
      same(payload.output, record.output?.ref) &&
      payload.requestDigest === digest(unsignedDecision(record)) &&
      expiry(payload, record.at, certifiedReadback)
    );
  }
  async prepareDecision(
    record: DecisionRecord,
    receipt: SignedReceipt,
  ): Promise<DecisionRecord> {
    assertNoReservedRefs(record);
    const state = await this.workspace.read();
    const packet = state.packets[record.packetId];
    const proposal =
      packet && state.runs[packet.runId]?.proposals[record.proposalId];
    check(proposal, "Unknown proposal for receipt");
    const marked: DecisionRecord = {
      ...unsignedDecision(record),
      externalRefs: [
        ...(unsignedDecision(record).externalRefs ?? []),
        receiptMarker(receipt),
      ],
    };
    check(
      this.bindsDecision(receipt, marked, proposal, state),
      "Decision receipt does not authorize exact request",
    );
    await this.stored(receipt);
    return marked;
  }
  async verify(record: DecisionRecord, proposal: Proposal): Promise<boolean> {
    try {
      const marks =
        record.externalRefs?.filter(
          (ref) => ref.startsWith(marker) || ref.startsWith(LOCAL_MARKER),
        ) ?? [];
      if (marks.length !== 1) return false;
      const receipt = await this.lookup(marks[0]!.slice(marker.length));
      const state = await this.workspace.read();
      if (this.bindsDecision(receipt, record, proposal, state)) return true;
      const validAtDecision = expiry(receipt.payload, record.at);
      if (validAtDecision) return false;
      const proof = await this.acceptance(record);
      return (
        !!proof &&
        this.bindsDecision(receipt, record, proposal, state, true) &&
        (await this.bindsAcceptance(proof, record, receipt, state))
      );
    } catch {
      return false;
    }
  }
  async prepareCommit(
    request: CommitRequest,
    receipt: SignedReceipt,
  ): Promise<void> {
    const state = await this.workspace.read();
    const packet = state.packets[request.packetId];
    const run = packet && state.runs[packet.runId];
    const payload = receipt.payload;
    check(
      this.signed(receipt) &&
        payload.version === 1 &&
        payload.action === "commit" &&
        !!packet &&
        !!run &&
        request.actor.kind === "human" &&
        payload.actorId === request.actor.id &&
        payload.runId === run.id &&
        payload.scopeOwnerId === run.scope &&
        payload.packetId === request.packetId &&
        payload.requestId === request.id &&
        same(payload.approvals, request.approvals) &&
        payload.requestDigest === digest(request) &&
        expiry(payload, request.at),
      "Commit receipt does not authorize exact request",
    );
    await this.stored(receipt);
    this.preparedCommit = { request, receipt };
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
    if (!prepared || !this.signed(prepared.receipt)) return false;
    const packet = state.packets[prepared.request.packetId];
    const run = packet && state.runs[packet.runId];
    return (
      !!run &&
      prepared.receipt.payload.scopeOwnerId === run.scope &&
      prepared.request.approvals.some(
        (item) =>
          item.decisionId === record.id && item.proposalId === proposal.id,
      ) &&
      (await this.verify(record, proposal))
    );
  }
}
