# Runtime engines

`@mimic/core` exports deterministic dependency, freshness, provenance, property-policy, revision-guard, and audit APIs from `runtime-engines`. These modules consume verified exact snapshots from `ArtifactStore`; they do not choose canonical releases or implement Run state transitions.

## Dependency graph and freshness

`DependencyGraph.load(store, roots)` takes exact `{ artifactId, revision, lockDigest }` roots, reads every locked dependency, and returns a dependency-first `order`. Traversal is stable by artifact ID and revision. Missing snapshots, conflicting locks, cycles, and digest or identity mismatches fail before assessment. An `ArtifactStore` read also verifies schema, scope, provenance pointers, authority, and stored digest. A digest mismatch is an integrity error, never ordinary staleness.

`await graph.assessChanges(changes)` verifies an explicit newer candidate revision and digest for each changed logical artifact. It does not adopt the candidate, mutate a snapshot, or change an existing dependency lock. It walks only reachable dependents through edges whose `onChange` is not `none`. `graph.directImpacts(ref)` also exposes direct `none` classifications for audit. The result retains every affected path and the strongest required response: `validate` or `revise` gives `stale`; `invalidate` gives `blocked`. This is a computed assessment, not a mutation of `lifecycle.freshness`. The caller records a state event or publishes a new revision before changing the durable freshness assessment.

```ts
const graph = await DependencyGraph.load(store, [lockedRoot]);
const findings = await graph.assessChanges([
  {
    artifactId: "art_tokens",
    fromRevision: 1,
    candidateRevision: 2,
    candidateDigest: verifiedCandidateDigest,
  },
]);
```

## Provenance and policy

`assessProvenance(artifact, verifier)` checks content pointers and the six schema kinds. Fact and derived references remain `UNVERIFIED` until a caller verifies every evidence or input reference for that claim. A human decision remains `UNVERIFIED` until decision authority is checked. Assumptions and hypotheses are `DECLARED`; unknown claims remain `UNKNOWN`. These statuses do not establish empirical evidence quality by themselves.

`evaluatePropertyPolicy(rule, selection, authority)` is a low-level evaluator for an explicit caller-supplied rule; its result does not establish verified governance. Design-system `definition` is intentionally untyped by the current artifact schema. The caller and eventual Orchestrator must verify that the rule came from an applicable approved ancestor, resolve scope priority and inheritance constraints, check freshness and exact locks, and enforce the decision again at publication. A `locked` value cannot change at a child scope. `configurable` permits only enumerated JSON values or an explicit numeric range, with rationale. A rule supplying both forms is ambiguous and blocks. `overridable` permits a reasoned proposal; a durable override needs a decision ID and verified human approval. A proposal result is not commit authority. Contradictory or absent boundaries block.

`guardArtifactRevision` checks consecutive revisions and proposal/approval state before publication. For approval, it calls an injected `AuthorityVerifier`; a caller-provided approval-shaped object is insufficient. `ArtifactStore.create` remains the final append-only publication guard, including exact revision conflicts and authority checks. The old approved snapshot stays available under its old revision and digest.

## Audit

`ExecutionAuditLog.record` accepts explicit Run ID, actor, timestamp, action, outcome, reason, and exact input/output references. It assigns an ordered sequence and returns defensive copies. Pass an `AuditSink` to persist each event; without one the log is process-local. The caller records engine outcomes and guard refusals at the point of effect. Audit records do not grant authority or replace the artifact store. Run orchestration and commit-point event storage belong to the downstream Orchestrator.
