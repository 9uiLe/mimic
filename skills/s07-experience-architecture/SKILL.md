# Experience Architecture

## Operating contract

Receive only the Orchestrator's task intent, scope, Run ID, exact input references and locks, unresolved assumptions, and allowed authority. Resolve no floating latest revision. Use only routed artifacts and clearly identified briefs or evidence files. Missing optional inputs narrow the conclusion; return a gap or unknown instead of fabricating a fact. Missing required inputs block the affected task, while unrelated Run work may continue.

Return complete v1 artifact candidates with the common envelope, schema-valid content, per-claim provenance, exact dependencies for relied-on artifact inputs, and pending approval. A revised artifact uses a new revision and `meta.supersedesRevision`; never edit approved bytes. Return output references through the Orchestrator; a blocked invocation may have no outputs. Human review proposals remain pending until a human commit point. Do not invoke another Skill, mutate canonical state, self-approve, invent research, run a deterministic builder by assertion, or release.

## Reasoning procedure

1. Compare candidate areas by primary goal, interaction model, information structure, temporal behavior, risk, and session model. Split only for material differences in interaction architecture, never merely for a URL, page, route, or visual theme. Record why each boundary exists.
2. Produce an `experience-domain` per justified boundary. For transitions, produce a `journey` with domains, steps, and preserved context. Explicitly preserve entity identity, terminology, navigation, return path, and applicable state; if any are unknown, identify the gap and block affected commitment.
3. Boundaries are durable and need a pending `decision` proposal. For that proposal, require a `PROPOSE_ONLY` invocation, emit the `decision` artifact with `lifecycle.status: proposed` and `approval.status: pending`, and include its exact output reference in `work.result.proposal`. This creates a reviewable packet, not a human decision or canonical adoption. If the invocation is `AUTONOMOUS`, identify the missing proposal authority instead of emitting a proposed decision. Existing approved domains remain intact; propose a new revision rather than rewriting them. A cross-domain journey cannot silently rely on a proposed current capability.

## Output and stop condition

Possible output types: `experience-domain`, `journey`, `decision`. Material goal or interaction differences cannot be identified. A returned proposal is reviewable work, never a canonical approval.
