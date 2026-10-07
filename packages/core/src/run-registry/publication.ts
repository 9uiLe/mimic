import { canonicalJson, jsonCopy } from "../artifact-canonical.js";
import {
  FileWorkspaceStorage,
  isWorkspaceTransactionView,
} from "../workspace-transaction.js";
import {
  ArtifactStore,
  type ArtifactSnapshot,
  type AuthorityVerifier,
  type SnapshotStorage,
} from "../artifact-store.js";
import type {
  SnapshotReader,
  VerifiedSnapshot,
} from "../runtime-engines/dependency.js";
import type {
  DecisionRecord,
  Proposal,
  RegistryAuthority,
  RegistryState,
  TransactionalRegistryStorage,
} from "./registry.js";

export interface TransactionalArtifactPublisher {
  readonly sourceStorage: SnapshotStorage;
  reader(storage: SnapshotStorage, registry: RegistryState): SnapshotReader;
  publish(
    storage: SnapshotStorage,
    registry: RegistryState,
    artifact: ArtifactSnapshot,
  ): Promise<VerifiedSnapshot>;
}
/** The normal ArtifactStore validators run against snapshots staged in the shared transaction. */
export class ArtifactStorePublication implements TransactionalArtifactPublisher {
  readonly sourceStorage: SnapshotStorage;
  constructor(
    private readonly store: ArtifactStore,
    private readonly authority: RegistryAuthority,
  ) {
    this.sourceStorage = store.storage;
  }
  private verifier(registry: RegistryState): AuthorityVerifier {
    return registryVerifier(registry, this.authority, this.store.authority);
  }
  reader(storage: SnapshotStorage, registry: RegistryState): SnapshotReader {
    return this.store.withStorage(storage, this.verifier(registry));
  }
  publish(
    storage: SnapshotStorage,
    registry: RegistryState,
    artifact: ArtifactSnapshot,
  ): Promise<VerifiedSnapshot> {
    if (!isWorkspaceTransactionView(storage, this.sourceStorage))
      throw new Error(
        "Approved or rejected publication requires an active shared workspace transaction",
      );
    return this.store
      .withStorage(storage, this.verifier(registry))
      .create(artifact);
  }
}

function registryVerifier(
  registry: RegistryState,
  authority: RegistryAuthority,
  fallback?: AuthorityVerifier,
  requireCommitted = false,
): AuthorityVerifier {
  const find = (
    id: string,
  ): { decision: DecisionRecord; proposal: Proposal } | undefined => {
    const decision = registry.decisions[id];
    if (!decision) return undefined;
    const packet = registry.packets[decision.packetId];
    const proposal =
      packet && registry.runs[packet.runId]?.proposals[decision.proposalId];
    return proposal ? { decision, proposal } : undefined;
  };
  const admitted = (decision: DecisionRecord): boolean =>
    !requireCommitted ||
    decision.outcome === "rejected" ||
    Object.values(registry.commits).some(
      (commit) =>
        commit.request.approvals.some(
          (item) =>
            item.decisionId === decision.id &&
            item.proposalId === decision.proposalId,
        ) &&
        !!decision.output &&
        commit.outputs.some(
          (ref) => canonicalJson(ref) === canonicalJson(decision.output!.ref),
        ),
    );
  return {
    verifyApproval: async (approval, artifact) => {
      const match = approval.decisionId ? find(approval.decisionId) : undefined;
      if (
        match?.decision.output &&
        canonicalJson(match.decision.output.artifact) ===
          canonicalJson(artifact) &&
        match.decision.outcome === approval.status &&
        match.decision.actor.id === approval.actorId &&
        match.decision.at === approval.at &&
        admitted(match.decision)
      )
        return authority.verify(
          jsonCopy(match.decision),
          jsonCopy(match.proposal),
        );
      return fallback?.verifyApproval(approval, artifact) ?? false;
    },
    verifyDecision: async (id, artifact) => {
      const match = find(id);
      if (
        match?.decision.output &&
        canonicalJson(match.decision.output.artifact) ===
          canonicalJson(artifact) &&
        admitted(match.decision) &&
        (await authority.verify(
          jsonCopy(match.decision),
          jsonCopy(match.proposal),
        ))
      )
        return true;
      return fallback?.verifyDecision(id, artifact) ?? false;
    },
  };
}
/** Readback verifier: a Run decision is authority only for its bound immutable output. */
export class RegistryAuthorityVerifier implements AuthorityVerifier {
  constructor(
    private readonly storage: TransactionalRegistryStorage,
    private readonly authority: RegistryAuthority,
    private readonly fallback?: AuthorityVerifier,
  ) {}
  private async state(): Promise<RegistryState> {
    return this.storage instanceof FileWorkspaceStorage
      ? this.storage.readVerificationState()
      : this.storage.read();
  }
  async verifyApproval(
    approval: ArtifactSnapshot["approval"],
    artifact: ArtifactSnapshot,
  ): Promise<boolean> {
    return registryVerifier(
      await this.state(),
      this.authority,
      this.fallback,
      true,
    ).verifyApproval(approval, artifact);
  }
  async verifyDecision(
    id: string,
    artifact: ArtifactSnapshot,
  ): Promise<boolean> {
    return registryVerifier(
      await this.state(),
      this.authority,
      this.fallback,
      true,
    ).verifyDecision(id, artifact);
  }
}
