# Skill package runtime

`@mimic/core` exports `loadSkillPackage` and `runSkillPackage` for the 9UI-103 execution boundary. The [static manifest contract](skill-package.md) and [reasoning Skill contract](../specifications/reasoning-skill-contracts.md) define the metadata and domain duties. This runtime consumes the merged 9UI-136 schema; it does not implement the eighteen catalog Skills.

## Load a package

`loadSkillPackage(directory, schemasRoot)` reads one `manifest.yaml` or `manifest.json`, the referenced `SKILL.md`, examples, and tests. `schemasRoot` is the directory containing `skills/skill-package.schema.json` and `artifacts/`. The loader validates the manifest with strict Draft 2020-12 Ajv, checks declared artifact type/version pairs against the canonical type schemas, rejects duplicate or contradictory input declarations, and reads only regular files beneath the package directory. Noncanonical paths and symlink traversal are rejected. The returned package contains text for the referenced files; examples and tests are package data, not executable entrypoints. `manifestVersion` and `packageVersion` have separate meanings from artifact schema versions and Run IDs.

The schema and static file contract are the authority for package shape. A package can declare human gates and forbidden duties, but cannot grant permissions or add artifact types. A manifest's output list identifies possible types; a blocked invocation may return no output.

## Run through the Orchestrator

`runSkillPackage({ orchestrator, package, runId, tasks, taskId, at, executor })` checks the routed task against its manifest, then uses `Orchestrator.invoke`. The Orchestrator builds exact input bindings, determines the task's allowed authority, and verifies output references through `accept`. The runtime resolves named artifact inputs from `ArtifactStore` and passes copies of the invocation, snapshots, package text, and missing optional input names to the injected executor. A named binding may contain multiple exact references. Human briefs and evidence file names remain distinct from artifact snapshots; a supplied evidence file is not proof of a factual claim.

The executor returns a `SkillWork` object with an Orchestrator `SkillResult` plus optional findings, unknowns, and upstream revision requests. The result may contain exact provisional or proposed output references, an unchanged approved reference supplied in the Run base and invocation, a human review proposal, or a blocker with zero outputs. The Orchestrator verifies the Run/Skill origin, scope, exact locks, allowed output types, dependencies, pending approval, and proposal authority before recording produced work. It does not turn proposals into canonical selections. Findings with `PASS`, `CONCERN`, or `FAIL` require at least one evidence reference; this runtime does not verify the referenced evidence or its relevance. `UNVERIFIED` and `N/A` may have none. Revision requests are returned for explicit Orchestrator routing; callers use `requestUpstream` after review of the affected locks and evidence. An already accepted request is verified against its Run production and artifact provenance without producing it again, including when that completed task closed the Run. A new request still passes the registry's active-Run production guard. A rejected proposal remains governed by the Run registry and cannot be silently replayed.

The injected executor is trusted code running in the caller's process. Copying the context prevents its edits to supplied objects from mutating store state. This interface does **not** restrict filesystem, network, imported modules, or other privileges available to that code and is not a sandbox. Deployments that execute untrusted packages need an isolation mechanism outside this runtime. No package manifest declares an executable entrypoint or tool grant.

## Example integration

```ts
const skill = await loadSkillPackage(packageDirectory, schemasRoot);
const work = await runSkillPackage({
  orchestrator,
  package: skill,
  runId,
  tasks,
  taskId,
  at,
  executor: async ({ invocation, inputs, gaps, package: loaded }) => {
    // Trusted implementation uses exact named inputs and returns file-backed refs.
    return { result: await produceCandidate(invocation, inputs, gaps, loaded) };
  },
});
```

A caller must create candidate snapshots in the shared ArtifactStore before returning their exact references. The Orchestrator and Run registry handle acceptance, decision packets, human commit points, rejection history, and canonical publication. The runtime does not create snapshots, invoke another Skill, approve an output, or release a Design Package.
