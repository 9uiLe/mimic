# Product Design Principles

## Operating contract

Receive only the Orchestrator's task intent, scope, Run ID, exact input references and locks, unresolved assumptions, and allowed authority. Resolve no floating latest revision. Use only routed artifacts and clearly identified briefs or evidence files. Missing optional inputs narrow the conclusion; return a gap or unknown instead of fabricating a fact. Missing required inputs block the affected task, while unrelated Run work may continue.

Return complete v1 artifact candidates with the common envelope, schema-valid content, per-claim provenance, exact dependencies for relied-on artifact inputs, and pending approval. A revised artifact uses a new revision and `meta.supersedesRevision`; never edit approved bytes. Return output references through the Orchestrator; a blocked invocation may have no outputs. Human review proposals remain pending until a human commit point. Do not invoke another Skill, mutate canonical state, self-approve, invent research, run a deterministic builder by assertion, or release.

## Reasoning procedure

1. Trace each product-wide principle to a product goal and a user task or risk; cite their exact locks. Inspect applicable approved foundations and brand intent before adding a candidate.
2. Express a reusable `design-system-asset` with `assetKind: foundation`, a principle and basis in `definition`, operational `usageRules`, and concrete `antiUsageRules`. The principle governs choices across domains; screen-specific tactics belong in later domain work.
3. If a parent foundation conflicts, keep the conflict visible and propose a revision through its owner. A local candidate is not organization-wide promotion. Do not create a layout or claim validated effectiveness without evidence.

## Output and stop condition

Possible output types: `design-system-asset`. No traceable goal and task basis. A returned proposal is reviewable work, never a canonical approval.
