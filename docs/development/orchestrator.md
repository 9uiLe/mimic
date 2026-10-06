# Orchestrator and Skill routing

`@mimic/core` exports `createOrchestratorRuntime`, `Orchestrator`, and `resolveApprovedPolicy`. The runtime factory connects one `FileWorkspaceStorage` to `ArtifactStore`, `RunRegistry`, `ArtifactStorePublication`, and `RegistryAuthorityVerifier`. It wraps the registry authority with `GovernedRegistryAuthority` and passes that same wrapper to the registry and publisher. The human authority supplied by the host remains responsible for verifying actual decision identity, evidence, and commit permission.

The Orchestrator calls the registry's existing state transitions. It never writes canonical selection itself. A controlling agent supplies tasks, and `next` returns compact actions and exact references for later CLI presentation. `invoke` is the mediated Skill transport boundary: it selects a routable invocation, passes only its task intent, scope, exact inputs, human brief, evidence file references, labeled assumptions, and authority, then validates the returned references. Runtime input groups preserve the static 9UI-136 required, optional, and `oneOf` alternative semantics for artifacts, human briefs, and evidence files. The static manifest describes capabilities but does not grant invocation or approval authority. No executable Skill harness or CLI command is defined here.

## Routing

`start` reads every applicable approved canonical revision through `ArtifactStore`, verifies its digest, freshness, and scope, and records exact reuse on the Run. It records task-specific blockers while preserving independent safe actions. Entry modes change investigation order; they do not bypass the common Product UI Contract or human review. A task with an existing approved exact target returns `USE`; an explicit revision returns `UPDATE`; a gap returns `GENERATE`; a ready named proposal returns `REQUEST_DECISION`; a missing required input, blocking unknown, or failed upstream prerequisite returns `BLOCK`; an unavailable task returns `IGNORE`. Optional missing inputs stay absent. Hypotheses and assumptions remain labeled in the minimal invocation context. `next` also reports pending packet IDs, blocker reasons, and unresolved provenance references.

Skill outputs must already be immutable snapshots in the shared store. `accept` re-reads each exact lock, checks Skill/Run origin, pending provisional or proposed lifecycle, input dependencies, and provenance shape. It records produced references and submits only explicitly named proposals. A repeated result can continue after a partial produce/submit failure without recording a duplicate produced revision. Rejection and renewed proposals remain governed by `RunRegistry`; a rejected candidate cannot be silently replayed. `requestUpstream` records a provisional `system-request` locked to the approved source and names affected locks and evidence. It does not mutate the source.

## Property governance

The v1 `design-system-asset.definition` is intentionally untyped. This runtime uses an explicit, narrow convention:

```json
{
  "rules": [
    {
      "targetAssetKind": "component",
      "targetName": "Button",
      "path": "/content/definition/density",
      "policy": "configurable",
      "value": "comfortable",
      "allowedValues": ["comfortable", "compact"]
    }
  ]
}
```

Only approved canonical `governance` assets in the target's registered ancestry supply rules. Rule references are exact and read through `ArtifactStore`; stale, blocked, tampered, ambiguous, or changed required locks fail closed. Each scope may have one applicable rule for a property. More specific rules must narrow inherited restrictions. The low-level `evaluatePropertyPolicy` is called only after this resolution and is not itself proof of authority. A property selection can carry a rationale and an exact decision ID in its target asset's `definition.propertySelections`. The target's actual value is read at each governed JSON Pointer; a label cannot substitute for the value. An override decision ID must equal the decision being committed and pass human authority verification.

The governed authority re-runs these checks in `allowCommit` inside the registry's shared workspace transaction, including checks for newly proposed child governance rules. The output must declare exact dependencies on every applicable governance source. A component cannot commit in the same packet as a newly approved governance output; review the governance revision first, then create a component revision against its exact approved lock. The registry then performs its own exact candidate, current canonical, freshness, transitive dependency, decision, and atomic publication guards. A denied policy leaves both canonical selection and output snapshot unpublished. `resolveApprovedPolicy` is also available for proposal planning, but its result is never publication authority.

## Integration boundary

Use the factory for orchestrated publication. Creating a separate `RunRegistry` with a different authority or storage backend does not enforce these orchestrator rules. The runtime does not perform live Linear actions, release a package, or claim empirical evidence is verified. Human Commit Point packets are IDs and explicit proposal sets; the registry handles partial approvals, rejection history, and exact retry IDs.
