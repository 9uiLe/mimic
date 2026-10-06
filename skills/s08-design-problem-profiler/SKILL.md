# S08 Design Problem Profiler

## Invocation boundary

The Orchestrator supplies intent, bounded domain scope, Run ID, exact artifact IDs/revisions/verified lock digests, unresolved assumptions, and authority. Accept only routed inputs. Do not fetch floating revisions, call another Skill, change canonical state, or approve output. A missing required Product UI Contract, user-task model, or relevant Experience Domain blocks this task. Record missing optional journey, capability, or task evidence as a gap. A locked digest mismatch blocks use even when `onChange` is `none`.

## Profile the problem

1. Read tasks and actors, consequential decisions, information/entity relationships, handoffs and collaboration, time behavior, constraints, and risk. Compare them with the Product UI Contract's navigation, terminology, entity continuity, and accessibility baseline. State the relevant Experience Domain. A different domain requires its own profile when goal, interaction, information, time, risk, or session model changes materially.
2. Write narrow Problem Traits that could matter across domains. Each trait must cite a particular task, contract constraint, domain property, or evidence file. Separate documented facts, derivations, hypotheses, and unknowns in provenance. Never turn missing user research into a fact.
3. Derive domain-specific Design Principles as decision rules responding to the traits, without prescribing a screen or layout. List failure risks and applicable cross-domain continuity. Do not claim a proposed capability is current.
4. Return `problem-profile` with only `summary`, `traits`, `principles`, and `risks` in content. Attach narrow `/content/traits/N`, `/content/principles/N`, and `/content/risks/N` provenance and exact dependencies for every artifact actually relied on. Derived claim `inputRefs` must identify the actual routed artifact ID, revision, and verified lock digest; illustrative example references must be rebound for a Run. Record richer trait-to-principle reasoning in rationale or linked evidence. A revised artifact gets a new revision; approved bytes are never edited.

## Stop condition

If no defensible trait can be traced to task or context, return blocked with no output. Unknown behavior remains an explicit unknown. This Skill does not decide design direction or run research.
