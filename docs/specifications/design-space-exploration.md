# Design Space Knowledge Graph and Exploration

This specification defines how Mimic v1 explores design possibilities without treating reference cases as UI templates. It is a semantic contract for problem profiling, the knowledge graph, retrieval, divergence, and direction decisions. It does not define an artifact format, storage model, seed inventory, Skill interface, or runtime algorithm.

The [Mimic v1 architecture and operating reference](https://linear.app/9uile/document/mimic-v1-architecture-and-operating-reference-4b4a6ddcb408) governs the larger design flow and human decision boundaries. [9UI-91](https://linear.app/9uile/issue/9UI-91/specify-design-space-knowledge-graph-and-exploration-rules) governs the design-space rules below.

## Place in the design flow

The full flow is:

> Product Definition → User/Task Model → Brand → Design Principles → Product UI Contract → Experience Domains / Cross-domain Journeys → Design Problem Profile → Design Space Retrieval → Divergence → Human Design Decision → Design System Resolution → Visual System → UI Composition → Responsive Architecture → Prototype → System Feedback → Critique/Validation → Final Human Approval → Design Package.

System-first and Experience-first are entry modes. Both converge through a Product UI Contract before domain profiling and exploration. The contract states product-wide interaction commitments and constraints that directions must respect. A System-first entry may begin with existing system commitments; an Experience-first entry may begin with tasks and journeys. Neither entry mode grants a retrieved case authority over the contract.

Exploration may propose directions, prototypes, and critiques autonomously. Selection of a durable direction is a Human Design Decision. Work may continue provisionally across that commit point, but provisional work remains identifiable and may be discarded or revised after the human decision. The final Design Package requires Final Human Approval.

## Problem profile and scope

A Design Problem Profile describes a problem in terms that support comparison across contexts. It identifies primary user goals and tasks, consequential decisions, information and entity relationships, interaction and collaboration model, temporal behavior, constraints, risks, and relevant Product UI Contract commitments. A **Problem Trait** is one explicit, transferable property of that profile, such as “several roles coordinate time-sensitive handoffs while retaining a shared incident state.” A trait is narrower than the whole product brief and must trace to a task, constraint, or stated design intent. Unknowns remain unknown; exploration must not invent user research or measured behavior.

A product may have multiple **Experience Domains** when primary goal, interaction model, information structure, temporal behavior, risk, or session model differs materially. The difference must affect how a user works, rather than merely page naming or visual treatment. Profile domain-specific problems at the appropriate scope; do not assume one retrieved mechanism should shape every domain.

**Cross-domain Journeys** connect those domains. A direction spanning domains must preserve entity context, terminology, navigation, return path, and state across transitions. For example, moving from live incident response to a later review should retain the incident identity, understood status terms, relevant decisions, and a route back to the operational context. A locally attractive pattern that breaks that continuity is a poor fit for the journey.

## Knowledge graph semantics

The graph expresses conceptual relationships, not a required physical graph database or fixed class hierarchy.

```text
Problem Trait → Design Principle → Reference Space → Reference Case
                         ├────────→ UI Pattern
                         └────────→ Failure Mode
```

| Concept          | Meaning and boundary                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Problem Trait    | A specific property of the current design problem that calls for a design response.                                                                                         |
| Design Principle | A reusable design intent or decision rule that responds to a trait, such as “make ownership and the next handoff visible.” It does not prescribe a screen layout.           |
| Reference Space  | A class of contexts in which relevant principles or coordination mechanisms appear. It is a search and comparison domain, not a visual style collection.                    |
| Reference Case   | A particular example within a reference space. It can illuminate a mechanism and its limits; it is never a ready-made UI direction.                                         |
| UI Pattern       | A reusable interaction or information arrangement that can realize a principle under stated conditions. Its suitability is conditional on the current problem and contract. |
| Failure Mode     | A way the principle or candidate pattern can fail, including a context transfer error, misuse, omission, or conventional design trap.                                       |

The arrows mean “provides a reason to examine” or “can inform,” not “automatically entails.” A trait may support several principles; a principle may lead to several spaces, patterns, or failure modes. A case may illuminate several principles. The graph must allow new traits, principles, spaces, cases, patterns, and failure modes without assuming the initial taxonomy is exhaustive or that each node has exactly one parent.

Every proposed connection needs a stated rationale. When a case is used, distinguish documented case properties from inference about transfer to the current problem. Missing evidence is not filled by confidence language.

## Two design spaces

**Structural Design Space** concerns task flow, roles, handoffs, information architecture, entity relationships, interaction mechanisms, state, feedback, risk controls, and temporal behavior. Retrieval and divergence start here. Structural fitness is judged against the problem profile and Product UI Contract.

**Visual Design Space** concerns visual language, hierarchy, typography, color, imagery, motion, and expression of brand. It is explored after structural directions and their mechanisms are explicit. A visually compelling case cannot justify an unsuitable workflow, and visual similarity alone cannot establish structural relevance. Visual references may inform later expression, subject to brand, accessibility, and resolved system constraints; they do not erase structural rationale.

This order does not require one frozen layout before any visual thinking. It requires that visual treatment not silently determine a structural decision. If visual exploration reveals a structural issue, revisit the structural direction explicitly.

## Retrieval and candidate roles

Evaluate each candidate on two separate questions:

1. **Structural similarity or relevance:** Does it address a comparable arrangement of tasks, decisions, relationships, states, constraints, or mechanisms? Which parts transfer, and which do not?
2. **Context distance:** How different are its users, goals, domain, stakes, operating environment, scale, and constraints from the current problem?

These are qualitative judgments with reasons, not a synthetic overall score. Context distance is not a quality judgment; a distant case can reveal a strong transferable mechanism.

| Role           | Structural fit and context distance                                                                            | Exploration purpose                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Near           | High structural similarity and low context distance.                                                           | Establish credible baseline mechanisms and local conventions.                                            |
| Adjacent       | Useful structural similarity and medium context distance.                                                      | Reveal alternative mechanisms without losing task relevance.                                             |
| Far            | High structural relevance and high context distance; the similarity must be useful to the current problem.     | Expose transferable mechanisms obscured by familiar domain conventions. Far is never random inspiration. |
| Wildcard       | An unconventional candidate with at least a minimum defensible structural fit.                                 | Challenge an assumption while retaining a stated trait or mechanism link. Novelty alone is insufficient. |
| Anti-reference | A conventional trap or structurally poor fit, including an attractive example whose mechanism would fail here. | Make rejection boundaries and likely failure modes explicit.                                             |

These roles are lenses, not permanent labels for cases. The same case may be adjacent for one problem and far for another. An anti-reference is documented for what to avoid, not promoted as a direction. A candidate with no plausible trait → principle → mechanism connection is out of scope even if its appearance is striking.

Retrieval first identifies relevant principles and searches reference spaces that might illuminate them, then examines particular cases. Divergence compares distinct mechanisms and tradeoffs. The explorer must not simply return the most similar _K_ cases or fill a fixed quota for each role. It assembles an explainable portfolio covering important principles and distinct mechanisms, including counterexamples when they clarify risk. Repeated cases teaching the same mechanism add little. A missing role is preferable to an irrelevant case; a critical uncovered principle should be called out rather than concealed by quantity.

## Transfer before direction

The canonical reasoning path is:

> Problem Traits → Design Principles → Reference Spaces → Transferable Mechanisms → Design Directions.

Reference Cases provide evidence and counterexamples within Reference Spaces. They do **not** flow directly into UI. Before any case influences a direction, articulate:

- The problem trait and principle it addresses.
- The case's mechanism: what action, information, feedback, or constraint makes it work.
- Why that mechanism could transfer to this product and domain, and which assumptions remain unverified.
- What must **not** be borrowed, including domain-specific terminology, visual conventions, process steps, or controls that do not fit.
- Associated failure modes and the conditions under which the mechanism would become harmful or ineffective.

A **Design Direction** combines selected principles and mechanisms into a coherent approach for the current product, with explicit tradeoffs and open questions. It is not a pasted screen, renamed reference case, or style mood board. Distinct directions should differ in meaningful workflow, information, or interaction mechanisms. Each direction is explainable through the profile and contract; visual expression is resolved later.

Do-not-borrow notes and failure modes belong in the exploration account even for rejected cases. They prevent a later composition step from importing surface details while losing the transfer rationale. If a mechanism's fit depends on an untested claim about users or operations, mark it unverified and design validation accordingly. Do not fabricate empirical support or convert qualitative reasoning into a 0–100 design score. Use the governing quality vocabulary (PASS / CONCERN / FAIL / UNVERIFIED / N/A, with BLOCKER / MAJOR / MINOR / NOTE severity when relevant) for specific criteria rather than an aggregate ranking.

## Worked conceptual example

Suppose a product supports a team coordinating an ongoing service incident. The operational domain needs rapid shared-state updates and accountable handoffs; a later review domain needs slower reconstruction and explanation. The profile contains the trait “several roles coordinate time-sensitive work on one incident while ownership changes.” A corresponding principle is “show current ownership, next handoff, and the reason for each state change.”

| Candidate role | Conceptual case                                           | Transferable mechanism                                                               | Do not borrow / failure to examine                                                                   |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Near           | A service incident console.                               | Shared timeline with explicit owner and status transitions.                          | Do not inherit its exact severity labels or assume its escalation chain matches this team.           |
| Adjacent       | An editorial production queue.                            | Visible assignment, review gate, and return-to-author path.                          | A scheduled publication cadence may delay urgent incident action.                                    |
| Far            | Theater stage management during a live performance.       | A common cue sequence and explicit acknowledgment before a responsibility handoff.   | Do not import performance terminology or a rigid cue order into unpredictable incident work.         |
| Wildcard       | A restaurant kitchen pass coordinating concurrent orders. | One shared view of readiness and blockers across roles.                              | Minimum fit is concurrent work plus handoffs; per-order timing and physical layout may not transfer. |
| Anti-reference | A generic KPI dashboard used as the main work surface.    | It may summarize outcomes but does not itself coordinate ownership and next actions. | A decorative status grid can hide the handoff and leave users guessing who acts next.                |

These are conceptual comparisons, not claims that a named product has been studied or validated. One possible direction emphasizes an incident timeline with explicit acknowledgments; another emphasizes a queue of handoffs with contextual return paths. Both need critique against risk, domain boundaries, and cross-domain continuity. The human chooses the durable direction; subsequent system resolution and prototyping test the selected approach. Neither the stage-management case nor the kitchen case supplies a UI to copy.

## Decision and continuation

Exploration leaves a reviewable account of the profile, principles, spaces and cases considered, extracted mechanisms, rejected transfers, do-not-borrow notes, failure modes, directions, tradeoffs, and unresolved evidence. The human selects or revises the durable direction. Until then, exploration and prototypes may continue provisionally under the existing Product UI Contract. If a later test changes understanding of a trait or mechanism, revisit the rationale and relevant decision rather than quietly changing an approved direction.

The knowledge taxonomy is a seed for exploration, not a closed ontology. New domains and mechanisms may be proposed with their rationale and provenance. Promotion into shared knowledge is a durable human decision under Mimic's operating model.
