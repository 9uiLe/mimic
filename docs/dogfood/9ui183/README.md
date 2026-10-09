# 9UI-183: matched reference-timing comparison

This is a comparison harness, not a selected Mimic operating policy. It
prepares one immutable S01–S11 plan and reads its results. The script does not
invoke a model, accept an artifact, approve a direction, or change a prior Run.
Use the normal `mimic run` and authorized session dispatcher for execution.

## Why one Run contains all three arms

The 9UI-182 design proposed a separate Run for each arm. Router input refs
must belong to a Run's base or its own branch. Provisional S01–S08 artifacts
from a different Run cannot become a new Run's base through `refs` alone:
the attempted S05 route was blocked with `Missing required system-capability`.
The comparison therefore puts one common S01–S08 sequence and three separate
S09–S11 task branches in **one new Run**. Each branch has distinct task IDs,
session IDs, artifact IDs, and evidence paths. All branches consume the same
exact upstream refs from that Run. No provisional artifact is promoted to
canonical solely for an experiment.

The branches execute sequentially through the official dispatcher, so order
and model state may influence them. One cohort can demonstrate feasibility and
specific differences; it cannot establish a causal winner. The historical
9UI-178 Run remains a functional example, not a matched control.

## Arms and frozen inputs

| Arm | S09 evidence                                                                                         | S11 emphasis                                                                   |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| B0  | Compact flat catalogue of the same sourced cases, without graph roles or paths                       | Same task and exact directions                                                 |
| C1  | Host `retrieveDesignReferences` projection with source IDs, mechanisms, risks, and missing-role gaps | Same task and exact directions                                                 |
| C2  | Compact catalogue with positive mechanisms foregrounded                                              | Purpose, hidden decisive facts, excess noise, and counterexamples foregrounded |

The graph projection is based on declared traits in the **fixed task brief**
before S08. It does not claim to have read a later model-generated S08 profile.
Compare those traits against S08 before interpreting C1. C1 can omit an
unexpected distant mechanism. The full corpus inventory, hash, and source
ledger remain saved even where S09 sees a compact projection. The page and
observation files enter all arms through the common S04/S08 upstream; they are
not repeated in each S09/S11 prompt.

`scripts/approach-comparison.mjs prepare <config.json>` requires a new
`mimic init` workspace and creates all evidence, the combined plan, and a
manifest with `wx` writes. It rejects a workspace with an existing Run or
canonical artifact so optional inputs cannot inherit prior work. Copy the
repository's `skills/` and `schemas/` directories into that workspace, and
place the fixed page/observation files under `inputs/` before preparation.
It freezes the repository commit, source file hashes, Skill package files,
page evidence, model name/effort, retrieval input, artifact and submission
schema files, and generated plan/evidence hashes. The repository contains the nine-stage
[plan template](plan-template.json). Keep each model attempt's session config
and authorized decision receipt separate; use a new session ID for every new
invocation. The trusted host calls `runAuthorizedSessionOnce`, checks the
workspace/model/request scope once, and records prompt _digests_, never prompt
or credentials, in non-sensitive attempt logs.

Then run `mimic run --id <manifest.runId> --tasks <manifest.planPath>` in that
workspace. Dispatch common stages once, followed by the three S09–S11
branches. The manifest's task IDs and frozen plan specify exact bindings.
`scripts/approach-comparison.mjs report <config.json>` checks the frozen
files again and reads the official session checkpoints and completed `set-work`
events for exact refs, attempts, stops, and the first S11 completion time.
Elapsed time is reported only when a non-sensitive `attempts.jsonl` exists;
otherwise it remains unknown and reasoning effort is marked unverified for
sessions without a matching attempt row. The report also shows whether the
current checkout still matches the repository inputs frozen at preparation.
A static rejection or unknown outcome stays
with its original work and submission marker; the normal session recovery
protocol determines whether the same work may be retried. Never rewrite a
model output or marker to create a pass.

S11 is a proposal for human review. No adoption is recorded by this harness.
The current Run lacks the approved foundations required for a real S13 visual
system; S13/S16 results must not be inferred from S11. Accessibility is not a
design evaluation or convergence criterion for this comparison, while existing
interactions remain intact.
