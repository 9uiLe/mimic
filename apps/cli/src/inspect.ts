import {
  canonicalJson,
  deriveRunState,
  type ArtifactSnapshot,
  type ExactArtifactRef,
  type RegistryState,
  type UpstreamRevisionRequest,
} from "@mimic/core";

/** Read ports only: callers must use the authority-verifying runtime artifact store. */
export interface InspectRuntime {
  registry: { snapshot(): Promise<RegistryState> };
  artifacts: {
    read(
      id: string,
      revision: number,
    ): Promise<{ artifact: ArtifactSnapshot; digest: string }>;
  };
}
export interface BackendStop {
  readonly reason: "quota" | "auth" | "cancelled" | "unsupported" | "unknown";
  readonly message: string;
  readonly backend?: string;
}
export interface RevisionInspectionRecord {
  readonly taskId: string;
  readonly path: string;
  readonly inputRefs: readonly ExactArtifactRef[];
  readonly requests: readonly {
    request: UpstreamRevisionRequest;
    state: string;
  }[];
}
export interface InspectOptions {
  readonly revisionRecords?: readonly RevisionInspectionRecord[];
  /** Resolve workspace-contained evidence only; presence is never semantic verification. */
  readonly resolveEvidence?: (reference: string) => Promise<boolean>;
  readonly backendStops?: readonly BackendStop[];
}

export function pointerExists(value: unknown, pointer: string): boolean {
  if (pointer === "") return true;
  if (!pointer.startsWith("/")) return false;
  for (const encoded of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(encoded)) return false;
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
        return false;
      value = value[Number(key)];
    } else if (
      value &&
      typeof value === "object" &&
      Object.hasOwn(value, key)
    ) {
      value = (value as Record<string, unknown>)[key];
    } else return false;
  }
  return true;
}
const sameRef = (
  a: ExactArtifactRef | undefined,
  b: ExactArtifactRef | undefined,
) =>
  a === undefined || b === undefined
    ? a === b
    : a.artifactId === b.artifactId &&
      a.revision === b.revision &&
      a.lockDigest === b.lockDigest;

/** Diagnostic only; never constructs approvals, mutates locks, or promises commit success. */
export async function inspectRun(
  runtime: InspectRuntime,
  runId: string,
  options: InspectOptions = {},
) {
  const state = await runtime.registry.snapshot();
  const run = state.runs[runId];
  if (!run) throw new Error(`Unknown Run ${runId}`);
  const readExact = async (ref: ExactArtifactRef) => {
    const read = await runtime.artifacts.read(ref.artifactId, ref.revision);
    if (read.digest !== ref.lockDigest)
      throw new Error("Exact artifact lock mismatch");
    return read.artifact;
  };
  const sourceProposals = (ref: ExactArtifactRef) =>
    Object.values(state.runs).flatMap((owner) =>
      Object.values(owner.proposals)
        .filter((p) => sameRef(p.ref, ref))
        .map((p) => ({
          runId: owner.id,
          proposalId: p.id,
          packetId: p.packetId,
          status: p.status,
          readiness: p.readiness,
        })),
    );
  const dependency = async (
    input: ExactArtifactRef & { readonly onChange?: string },
  ) => {
    const ref = {
      artifactId: input.artifactId,
      revision: input.revision,
      lockDigest: input.lockDigest,
    };

    try {
      const artifact = await readExact(ref);
      const assessed = state.freshness[ref.artifactId];
      const canonical = state.canonical[ref.artifactId]?.ref;
      const canonicalChanged = !!canonical && !sameRef(canonical, ref);
      const blockers: string[] = [];
      if (
        artifact.lifecycle.status !== "approved" ||
        artifact.lifecycle.freshness !== "valid" ||
        (assessed && sameRef(assessed.ref, ref))
      )
        blockers.push(
          "Dependency requires a fresh approved exact revision; stale assessments require verified impact evidence.",
        );
      if (canonicalChanged && input.onChange && input.onChange !== "none")
        blockers.push(
          input.onChange === "validate"
            ? "Canonical dependency changed; verified impact evidence is required for onChange validate."
            : "Canonical dependency changed; explicitly rebind and revise or invalidate the dependent output before commit.",
        );
      return {
        ref,
        status: artifact.lifecycle.status,
        freshness: artifact.lifecycle.freshness,
        registryFreshness:
          assessed && sameRef(assessed.ref, ref) ? assessed.status : undefined,
        canonical,
        canonicalChanged,
        onChange: input.onChange,
        sourceProposals: sourceProposals(ref),
        commitBlocker: blockers.length ? blockers.join(" ") : undefined,
      };
    } catch (error) {
      return {
        ref,
        status: "unavailable-or-unverified",
        commitBlocker: String(error),
        sourceProposals: sourceProposals(ref),
      };
    }
  };
  const candidates = await Promise.all(
    Object.values(run.proposals).map(async (proposal) => {
      let artifact: ArtifactSnapshot | undefined;
      const reasons: string[] = [];
      try {
        artifact = await readExact(proposal.ref);
      } catch (error) {
        reasons.push(String(error));
      }
      const dependencies = await Promise.all(
        (artifact?.dependencies ?? []).map(dependency),
      );
      if (
        proposal.status !== "pending" ||
        proposal.readiness !== "ready" ||
        proposal.deferred ||
        run.closed
      )
        reasons.push("Proposal is not currently available for adoption.");
      if (
        !artifact ||
        artifact.lifecycle.status !== "proposed" ||
        artifact.approval.status !== "pending" ||
        artifact.lifecycle.freshness !== "valid"
      )
        reasons.push(
          "Candidate must be fresh, proposed, pending, and authority-readable.",
        );
      if (
        !sameRef(
          state.canonical[proposal.ref.artifactId]?.ref,
          proposal.expectedCanonical,
        )
      )
        reasons.push("Expected canonical selection has changed.");
      for (const dep of dependencies)
        if (dep.commitBlocker) reasons.push(dep.commitBlocker);
      return {
        proposalId: proposal.id,
        packetId: proposal.packetId,
        candidate: proposal.ref,
        expectedCanonical: proposal.expectedCanonical,
        status: proposal.status,
        readiness: proposal.readiness,
        rationale: proposal.rationale,
        evidenceLimits: proposal.evidenceLimits,
        content: artifact?.content,
        inputRefs: artifact?.dependencies ?? [],
        dependencies,
        reviewReady:
          !run.closed &&
          proposal.status === "pending" &&
          proposal.readiness === "ready" &&
          !proposal.deferred &&
          !!artifact,
        commitReadiness: reasons.length
          ? "blocked"
          : "requires-human-authorization-and-core-validation",
        commitBlockers: reasons,
      };
    }),
  );
  const references = new Map<string, ExactArtifactRef>();
  for (const ref of [
    ...run.base,
    ...run.reused.map((r) => r.ref),
    ...run.artifacts,
    ...Object.values(run.proposals).map((p) => p.ref),
  ])
    references.set(`${ref.artifactId}@${ref.revision}`, ref);
  const provenance = [];
  for (const ref of references.values()) {
    let artifact: ArtifactSnapshot;
    try {
      artifact = await readExact(ref);
    } catch (error) {
      provenance.push({
        ref,
        status: "artifact-unavailable-or-unverified",
        reason: String(error),
        findings: [],
      });
      continue;
    }
    const findings = [];
    for (const entry of artifact.provenance) {
      if (entry.kind !== "fact" && entry.kind !== "derived") continue;
      const refs = (
        entry.kind === "fact" ? entry.evidenceRefs : entry.inputRefs
      ) as string[];
      const resolutions = [];
      for (const reference of refs ?? []) {
        let resolved = false;
        let reason =
          "Reference could not be resolved by the configured resolver.";
        const match = /^(art_[A-Za-z0-9_-]+)@([1-9][0-9]*)(?:#(.*))?$/.exec(
          reference,
        );
        try {
          if (match) {
            const exact = artifact.dependencies.find(
              (dep) =>
                dep.artifactId === match[1] &&
                dep.revision === Number(match[2]),
            );
            if (exact) {
              const input = await readExact(exact);
              resolved =
                match[3] === undefined || pointerExists(input, match[3]);
            } else
              reason =
                "Artifact reference is not bound to an exact input dependency.";
          } else if (options.resolveEvidence)
            resolved = await options.resolveEvidence(reference);
        } catch (error) {
          reason = String(error);
        }
        resolutions.push({
          reference,
          resolved,
          ...(resolved ? {} : { reason }),
        });
      }
      findings.push({
        path: entry.path,
        kind: entry.kind,
        status: "UNVERIFIED",
        verification: "verifier-not-connected",
        referenceResolution:
          resolutions.length && resolutions.every((r) => r.resolved)
            ? "resolved"
            : "unresolved",
        meaning: "not-checked",
        references: resolutions,
      });
    }
    provenance.push({ ref, findings });
  }
  const revisionRequests = await Promise.all(
    (options.revisionRecords ?? []).flatMap((record) =>
      record.requests.map(async ({ request, state: requestState }) => ({
        taskId: record.taskId,
        path: record.path,
        request,
        state: requestState,
        source: await dependency(request.source),
        requestContent: await readExact(request.request)
          .then((a) => a.content)
          .catch(() => undefined),
        nextSteps:
          requestState === "pending-source-approval"
            ? [
                "Read the request and collect missing information or evidence before approval; unknown or unavailable is an acceptable answer.",
                "Prepare a source review if adoption is needed; a missing source proposal/packet requires separate review preparation.",
                "Approval publishes a new exact revision and does not mutate this source lock. Explicitly rebind a new task/Run/request and reevaluate downstream inputs; unchanged submit retry cannot advance this provisional lock.",
              ]
            : requestState === "pending-routing"
              ? [
                  "Inspect the accepted submission and routing error. An identical submit retry can recover routing only when this exact source is approved and unchanged.",
                ]
              : [
                  "Inspect the exact request and source state before preparing the appropriate upstream answer.",
                ],
      })),
    ),
  );
  if (canonicalJson(state) !== canonicalJson(await runtime.registry.snapshot()))
    throw new Error(
      "Workspace changed during inspection; retry read-only inspect.",
    );
  return {
    runId,
    state: deriveRunState(run),
    readOnly: true,
    candidates,
    provenance,
    revisionRequests,
    backendStops: options.backendStops ?? [],
    nextSteps: [
      "Collect requested information and check whether each reference supports its claim; resolved references are not VERIFIED evidence.",
      ...(run.safeActions.length
        ? [
            "Safe generation work remains available; review-ready does not require stopping all work.",
          ]
        : []),
      ...(candidates.length
        ? [
            "Present exact candidates, input locks, evidence limits and commit blockers to the human. Review readiness is not commit readiness; inspect never grants authority.",
          ]
        : []),
      ...((options.backendStops?.length ?? 0)
        ? [
            "Resolve the reported backend stop or explicitly select a supported backend; do not fall back to another billing mode.",
          ]
        : []),
    ],
  };
}
