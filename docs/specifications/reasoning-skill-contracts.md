# Reasoning Skill boundaries and artifact I/O (v1)

This specification defines the eighteen reasoning Skills for [9UI-90](https://linear.app/9uile/issue/9UI-90/specify-reasoning-skill-boundaries-and-io-contracts). It consumes the merged [Run and human commit contract](orchestrator-runs.md), [artifact architecture](artifact-architecture.md), [design-space rules](design-space-exploration.md), [Design System package](design-system-package.md), [Design Package governance](design-package-governance.md), and [technical baseline](technical-baseline.md). The [Mimic v1 architecture and operating reference](https://linear.app/9uile/document/mimic-v1-architecture-and-operating-reference-4b4a6ddcb408) governs the overall flow. This is a semantic I/O contract for [9UI-102](https://linear.app/9uile/issue/9UI-102/) and [9UI-103](https://linear.app/9uile/issue/9UI-103/), not a command payload, schema extension, runtime implementation, builder, or quality policy. The existing artifact schemas are the authority for file shape.

## Common invocation and result

The controlling agent invokes the Orchestrator; only the Orchestrator invokes a Skill. The Orchestrator supplies **task intent, scope, Run ID, applicable exact input artifact references and locks, unresolved assumptions, and allowed authority (`AUTONOMOUS` or `PROPOSE_ONLY`)**. Intent identifies the bounded task and desired output, including whether it is a new artifact or proposed revision. Scope includes the applicable organization → product → domain → local ancestry. An input reference means a logical `meta.id`, `meta.revision`, and a **verified** `lockDigest`, not a filename, an unverified illustrative hash, a floating latest version, or a Git commit. The Orchestrator resolves applicable approved reusable revisions before generation, records reuse and gaps, and supplies the specific references this invocation may use. A Skill must not resolve a different revision silently. Missing optional inputs are recorded as gaps, not fabricated; missing required inputs block only the dependent task. Entry mode (System-first, Experience-first, or Hybrid) changes the starting investigation, never this contract or authority.

A Skill result supplies **artifact references, evidence/provenance, dependency declarations, proposed decisions, and blocked reasons** as applicable. Each produced artifact is a complete file-backed v1 document: `meta`, `scope`, `lifecycle`, `origin`, `dependencies`, `approval`, `provenance`, and schema-specific `content`. It uses `meta.schemaVersion: "1.0.0"`, `origin.actorKind: skill`, the invoking Run ID, and exact dependency locks for inputs whose content it relies on. A result may also name existing unchanged artifact references and external evidence files; neither is a new artifact type. A proposed decision is a request for Orchestrator routing, normally represented by a `decision` artifact with `content.outcome: proposed`, pending approval, alternatives, and a named affected revision set. The Skill cannot create a committed decision by labeling it so. A blocked reason identifies the missing fact, invalid lock, forbidden authority, or affected work and its safe remaining work. No output artifact is required for a wholly blocked invocation; the Orchestrator records the blocker in Run events/status.

The Orchestrator checks schema shape, then separately checks registry identity/revision invariants, scope ancestry, resolved exact locks and digest integrity, provenance pointers and evidence relevance, and Run policy/authority. Shape validation cannot establish truth, approved state, or permission. Digest byte canonicalization and computation belong to storage; a Skill neither computes a canonical lock nor claims a verified `meta.contentDigest` without storage verification. Approved snapshots and released selections remain immutable. Revision 2+ uses `meta.supersedesRevision`; adoption of a newer upstream revision is an explicit new downstream revision with impact handling under `dependencies[].onChange`. Rejected candidates retain their rejected envelope and decision history; renewed work cites that rejection in a new proposal. A stale or blocked input needs a reason and cannot be treated as an approved usable substitute. The Orchestrator, not a Skill, maintains the graph, routes revision requests, guards commit points, and derives Run state.

`AUTONOMOUS` permits reversible analysis, provisional artifacts, labeled mock data, prototype planning, critique, and evidence collection within the Run. `PROPOSE_ONLY` permits drafting a candidate and asking for human review; it never grants a Skill approval, canonical selection, shared-scope promotion, system change, or release. Product definition, brand, Experience Domain boundaries, selected design direction, system changes, organization-scope promotion, and final release require the applicable human decision. A blocked work item does not make the Run `blocked` while unrelated authorized work remains; a review-ready proposal does not stop safe provisional work. `lifecycle.status`, `lifecycle.freshness`, `approval.status`, `decision.content.outcome`, and Run state remain separate dimensions. A `design-direction` candidate or `proposed-selection` is not `selected`; `selected` requires an approved envelope. Rejection is represented by the rejected envelope/history, not an invented decision outcome.

Skills communicate only through artifacts routed by the Orchestrator. They cannot invoke one another, mutate approved bytes, approve their own outputs, select canonical revisions, or release. They reason over design inputs; deterministic schema validation, registry/storage checks, token compilation, prototype building, and package release are runtime responsibilities. A Skill may request these checks and consume their evidence, but cannot report an unrun check as passed. Empirical findings without relevant evidence stay `UNVERIFIED`; mock behavior and proposed system capabilities remain labeled. Automated accessibility findings cover checked rules only and cannot establish full WCAG 2.2 AA conformance.

## Skill catalog

Every artifact type named below has schema version `1.0.0`; no other type or outer `content` field is implied. “Required” means required for that Skill's stated task, not for starting every Run. An absent optional input narrows the conclusion and is recorded as an assumption or gap. For each output, the common envelope, provenance, dependencies, and authority rules above still apply. The listed forbidden responsibility is additional to the common prohibitions.

### S01 Product Definition

- **Purpose:** Frame the product vision, goals, and non-goals so later work has a bounded intent.
- **Required inputs:** Human brief or an exact existing `product-definition` revision to revise; product scope and known constraints. **Optional:** `user-task-model`, `system-capability`, and evidence references.
- **Output:** A `product-definition` candidate or proposed revision (`summary`, `vision`, `goals`, `nonGoals`); a `decision` proposal for unresolved durable choices when needed.
- **Forbidden:** Treat inferred market demand or product scope as human-approved fact; approve product definition.
- **Blocks:** No usable human intent or an unresolved contradictory product boundary that prevents an honest candidate. A missing research result alone permits a labeled assumption.

### S02 User & Task Modeling

- **Purpose:** Identify users and tasks, distinguishing observed needs from hypotheses.
- **Required inputs:** Exact `product-definition` revision or a bounded provisional product brief; task/user evidence or explicit assumptions. **Optional:** `system-capability`, existing `user-task-model`, and research files.
- **Output:** `user-task-model` (`summary`, `users`, `tasks`); unresolved behavioral claims remain assumptions and can seed `validation` work later.
- **Forbidden:** Invent interviews, measurements, or validated personas.
- **Blocks:** No identifiable user or task from the available brief; evidence that is required for a claimed fact cannot be resolved.

### S03 Brand Builder

- **Purpose:** Express brand attributes, voice, and visual intent for product design.
- **Required inputs:** Human brand direction or exact existing `brand` revision to revise, plus product scope. **Optional:** `product-definition`, approved organization assets, and brand evidence.
- **Output:** `brand` (`summary`, `attributes`, `voice`, `visualIntent`) as a candidate/proposal; `decision` proposal for a durable brand choice.
- **Forbidden:** Declare generated brand direction canonical, override approved parent brand rules, or claim trademark rights.
- **Blocks:** Brand authority or essential identity is unknown and no honest provisional direction can be drafted; conflicting locked brand inputs prevent safe use.

### S04 System Capability Extractor

- **Purpose:** Describe what the actual system supports and distinguish possible changes.
- **Required inputs:** System documentation, executable evidence, or an exact `system-capability` revision being examined; product/system scope. **Optional:** `product-definition`, `user-task-model`, and implementation evidence.
- **Output:** `system-capability` with `availability: current` only when `supportingEvidence` supports it, otherwise `availability: proposed`; `system-request` for an upstream change when needed.
- **Forbidden:** Relabel a proposed capability as current or implement the system change.
- **Blocks:** A current-capability claim lacks resolvable evidence; conflicting system sources cannot be reconciled for the affected task. Other capabilities may still be documented.

### S05 UI Contract Manager

- **Purpose:** Form the shared Product UI Contract before domain-specific directions diverge.
- **Required inputs:** `product-definition`, `user-task-model`, and applicable `system-capability` exact revisions or explicitly bounded provisional equivalents. **Optional:** `brand`, existing `product-ui-contract`, `journey`, and approved design-system rules.
- **Output:** `product-ui-contract` (`summary`, `navigation`, `terminology`, `entityContext`, `accessibilityBaseline`) candidate/proposal; `system-request` if the contract exposes a system gap.
- **Forbidden:** Grant a proposed capability current status, waive the WCAG 2.2 AA baseline, or silently change an approved product contract.
- **Blocks:** Essential navigation/entity commitments cannot be stated without a missing product or system decision; a required input lock fails integrity.

### S06 Product Design Principles

- **Purpose:** Derive product-wide design principles from goals, task risks, and brand intent.
- **Required inputs:** Exact `product-definition` and `user-task-model` revisions or bounded provisional counterparts. **Optional:** `brand`, `product-ui-contract`, `problem-profile`, and approved `design-system-asset` foundations.
- **Output:** `design-system-asset` of `assetKind: foundation` for reusable principles, with `definition`, `usageRules`, and `antiUsageRules`; domain-specific problem principles can instead be recorded in `problem-profile.principles` by S08.
- **Forbidden:** Treat a principle as a screen layout or promote it to organization scope without human approval.
- **Blocks:** No traceable goal/task basis for a principle; conflicting approved foundation rules prevent a usable recommendation.

### S07 Experience Architecture

- **Purpose:** Partition materially different Experience Domains and describe cross-domain continuity.
- **Required inputs:** `product-ui-contract`, `user-task-model`, and product context as exact revisions or explicitly provisional equivalents. **Optional:** `system-capability`, existing `experience-domain` and `journey` revisions.
- **Output:** `experience-domain` for each proposed boundary and `journey` for transitions (`domains`, `steps`, `preservedContext`); `decision` proposal for durable boundaries.
- **Forbidden:** Declare a proposed domain boundary approved or lose entity identity, terminology, navigation, return path, and applicable state across a journey.
- **Blocks:** Primary goal/interaction/risk differences cannot be identified; a required cross-domain state or system capability is unknown and cannot honestly be modeled.

### S08 Design Problem Profiler

- **Purpose:** Describe transferable problem traits, related principles, and risks for a bounded domain.
- **Required inputs:** `user-task-model`, `product-ui-contract`, and relevant `experience-domain` exact revisions or bounded provisional equivalents. **Optional:** `journey`, `system-capability`, and task evidence.
- **Output:** `problem-profile` (`summary`, `traits`, `principles`, `risks`), with each substantive trait traced through provenance to the task or constraint.
- **Forbidden:** Convert unknown user behavior into a fact or collapse materially different domains into one profile without rationale.
- **Blocks:** No defensible trait can be identified from task/context; an essential contract lock is invalid.

### S09 Design Space Explorer

- **Purpose:** Retrieve near, adjacent, far, wildcard, and anti-reference candidates by structural mechanism and context distance.
- **Required inputs:** Exact `problem-profile` and `product-ui-contract` revisions or bounded provisional equivalents; accessible reference sources. **Optional:** `experience-domain`, `journey`, curated knowledge, and evidence files.
- **Output:** `reference-selection` with schema-supported `references` and transferable mechanisms; rationale, do-not-borrow limits, failure modes, and rejected cases belong in provenance or linked evidence files where the schema has no dedicated fields.
- **Forbidden:** Use visual similarity or novelty alone as structural fit; label a random distant example `far`; copy a reference UI as the direction.
- **Blocks:** No candidate has a defensible trait → principle → mechanism link, or a required reference cannot be examined. An absent candidate role is a disclosed coverage gap, not a quota failure.

### S10 Design Direction Generator

- **Purpose:** Diverge into meaningfully different workflow, information, or interaction mechanisms.
- **Required inputs:** `problem-profile`, `product-ui-contract`, and relevant `reference-selection` exact revisions or bounded provisional equivalents. **Optional:** `brand`, `journey`, `system-capability`, and prior `design-direction` revisions.
- **Output:** One `design-direction` per candidate with `selectionStatus: candidate`; a proposed durable choice may use `proposed-selection` plus a `decision` proposal. Transfer rationale and limits remain in provenance/evidence references.
- **Forbidden:** Set `selectionStatus: selected`, equate a retrieved case with a direction, or resolve visual treatment before structural fit.
- **Blocks:** No direction satisfies the Product UI Contract or key task/risk constraints; current system support is essential, lacks evidence, and no safe explicitly provisional alternative satisfies the task. A direction depending on proposed capability may still be explored with that dependency labeled and mock behavior identified; it cannot present the capability as current.

### S11 Direction Evaluator

- **Purpose:** Compare direction candidates against explicit task, contract, risk, and evidence criteria.
- **Required inputs:** Exact `design-direction`, `problem-profile`, and `product-ui-contract` revisions for every candidate under comparison. **Optional:** `journey`, `system-capability`, `reference-selection`, and evaluation evidence.
- **Output:** `evaluation` per target, with criterion-level `PASS`, `CONCERN`, `FAIL`, `UNVERIFIED`, or `N/A` and `BLOCKER`, `MAJOR`, `MINOR`, or `NOTE`; a `decision` proposal can present alternatives and rationale.
- **Forbidden:** Produce an aggregate 0–100 ranking, mark unevidenced empirical criteria PASS, or select the canonical direction.
- **Blocks:** Target or criteria cannot be resolved; an exact candidate lock fails. Unknown empirical performance yields `UNVERIFIED`, not an invocation failure.

### S12 Design System Resolver

- **Purpose:** Resolve applicable approved assets across scope ancestry and propose only necessary additions or revisions.
- **Required inputs:** Exact `design-direction`, `product-ui-contract`, task context, and applicable approved `design-system-asset` references/locks, including governance rules. **Optional:** `brand`, `problem-profile`, `journey`, and domain assets.
- **Output:** References to unchanged resolved `design-system-asset` revisions; proposed `design-system-asset` revisions or `system-request` for genuine gaps, with exact dependency declarations and usage rationale.
- **Forbidden:** Shadow a parent by name, bypass `locked`/`configurable`/`overridable` rules, silently upgrade a lock, or approve shared promotion.
- **Blocks:** Conflicting or ambiguous governance, missing mandatory asset or license review, unresolvable exact lock, or a property value outside allowed variation for the affected selection.

### S13 Visual System Builder

- **Purpose:** Propose visual foundations and token semantics consistent with brand and structural direction.
- **Required inputs:** Exact `brand`, `design-direction`, `product-ui-contract`, and resolved design-system foundation/governance references or bounded provisional equivalents. **Optional:** `reference-selection` for visual inspiration and existing token/semantic-icon assets.
- **Output:** `design-system-asset` candidates with `assetKind: foundation`, `dtcg-tokens`, `semantic-icon`, or `provider-binding`, as applicable; provider bindings need license terms and exact semantic-icon dependency.
- **Forbidden:** Compile tokens to CSS, treat a glyph as its semantic meaning, infer trademark rights, or override structural decisions with surface styling.
- **Blocks:** A token/reference cannot be represented, a locked property conflicts, or a required glyph license/meaning cannot be established for trusted reuse. Independent visual options may remain provisional.

### S14 UI Composition Planner

- **Purpose:** Plan Task → Pattern → Layout → Components for a scenario without building executable code.
- **Required inputs:** Exact `user-task-model`/task context, `product-ui-contract`, relevant `design-direction`, and resolved `design-system-asset` pattern/layout/component/rule revisions. **Optional:** `journey`, `scenario`, `system-capability`, and responsive assets.
- **Output:** `scenario` for the actor, context, steps, and expected outcome; references and exact locks to selected assets, with composition rationale in provenance or linked file-backed evidence. A needed reusable pattern/layout/component change is a proposed `design-system-asset` or `system-request`.
- **Forbidden:** Build the prototype, substitute an available component for task fit, or claim a proposed capability is executable.
- **Blocks:** No allowed pattern/layout/component combination preserves required task, state, and accessibility constraints; an essential asset lock is invalid.

### S15 Responsive Architect

- **Purpose:** Specify how interaction and reading order adapt to viewport, input, and content constraints.
- **Required inputs:** Exact `scenario`, selected pattern/layout/component `design-system-asset` locks, and `product-ui-contract`. **Optional:** `journey`, `design-direction`, existing responsive/accessibility rules, and observed viewport evidence.
- **Output:** Proposed `design-system-asset` with `assetKind: responsive-rule` or `accessibility-rule` when reusable; scenario revisions for changed steps, with exact selected-asset dependencies and provenance.
- **Forbidden:** Implement CSS, treat breakpoint values as sufficient accessibility proof, or silently omit information on narrow layouts.
- **Blocks:** Adaptation cannot preserve meaning, association, keyboard path, or essential content; an approved locked rule conflicts.

### S16 Design Critic

- **Purpose:** Critique a direction, scenario, prototype evidence, or design-system choice against stated criteria and failure modes.
- **Required inputs:** Exact target artifact reference and applicable `product-ui-contract` and task/risk context. **Optional:** `journey`, `design-direction`, `design-system-asset`, prototype files, and test evidence.
- **Output:** `evaluation` with criterion-level findings and severity; `system-request` or upstream revision request routed through the Orchestrator when a locked source needs change.
- **Forbidden:** Edit an approved upstream asset, turn critique into an approval, or assert full WCAG 2.2 AA conformance from automated checks.
- **Blocks:** Target cannot be resolved or exact lock integrity fails. Missing test evidence makes the affected empirical finding `UNVERIFIED` while other critique proceeds.

### S17 Knowledge Curator

- **Purpose:** Preserve reusable principles, mechanisms, failure modes, and evidence limits for later exploration.
- **Required inputs:** Exact source `reference-selection`, `problem-profile`, `evaluation`, or validation artifacts and their evidence for the knowledge proposed. **Optional:** existing curated `design-system-asset` revisions and design-space taxonomy.
- **Output:** Case-specific `reference-selection` revision or proposed reusable `design-system-asset` (`foundation` or `pattern`) where its schema semantics fit; `decision` proposal for organization-scope promotion. Conceptual graph edges and case notes may remain linked evidence pending a dedicated representation.
- **Forbidden:** Treat a conceptual graph as a validated physical registry, promote knowledge automatically, or erase rejected-case limits.
- **Blocks:** No traceable source/rationale for a claimed reusable mechanism; contradictory source evidence prevents honest reuse.

### S18 Experience Validation Planner & Analyst

- **Purpose:** Plan an experience check and interpret actual evidence against a target and method.
- **Required inputs:** Exact target `scenario`, `journey`, `design-direction`, or other artifact reference and the task/contract criteria being checked. **Optional:** prototype/evaluation files, participant observations, automated check output, and prior `validation` revisions.
- **Output:** `validation` with `target`, `method`, `state`, `evidenceRefs`, and optional `limitations`. A plan or unevidenced outcome uses `state: UNVERIFIED` and may have empty `evidenceRefs`; `PASS`, `CONCERN`, or `FAIL` requires evidence refs. `evaluation` may record separate criterion findings.
- **Forbidden:** Fabricate observations, run deterministic validators by assertion, or claim automated accessibility coverage proves full WCAG 2.2 AA conformance.
- **Blocks:** No identifiable target or method; corrupted or mismatched exact target lock. Lack of evidence blocks a verified outcome, not a plan or an `UNVERIFIED` report.

## Boundary and representation gaps

The sixteen current artifact types cover the machine-readable outcomes above, but do not provide a dedicated composition-plan, prototype, knowledge-graph, quality-policy, or validation-plan type. S14 uses a `scenario` only for its actual actor/context/steps/outcome; its selected-asset rationale may be file-backed evidence and exact dependencies, not invented `scenario.content` fields. S17 can propose a `design-system-asset` only when the knowledge genuinely fits an allowed `assetKind`; the full graph edges and do-not-borrow notes have no typed v1 fields. S18 can represent an unexecuted plan as `validation` with `state: UNVERIFIED`, a stated method, and empty `evidenceRefs`; it cannot claim measured results. Prototype files, code, and release manifests are package outputs outside the sixteen artifact types and are produced or assembled by their owning runtime work, not by retyping them as artifacts here. These are representational limits for follow-on contracts, not permission to add unsupported schema fields in a Skill result.

Category-specific `design-system-asset.definition` structure and permission checks, reference transfer limits, scope ancestry, evidence quality, artifact lock verification, digest canonicalization, and exact package acquisition exceed the v1 JSON Schema shape checks. The relevant producer, registry, reviewer, storage, and Orchestrator work must enforce them before trusted use. This specification leaves detailed quality criteria to the quality-policy work; it does not depend on an unmerged quality-policy document.

## Conformance examples

| Situation                                                            | Required Skill result and Orchestrator behavior                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S10 succeeds with verified profile, contract, and references         | Return `design-direction` candidates with exact input dependencies, narrow provenance, `selectionStatus: candidate`, and unresolved assumptions. The Orchestrator checks shape, locks, evidence, and authority before routing evaluation.                 |
| S08 lacks its required Product UI Contract                           | Return a blocked reason for profiling; record the missing contract and affected task. The Orchestrator can route independent S04 capability extraction; the Run stays `active` if that work is safe.                                                      |
| S09 has no optional brand or no credible far case                    | Return a `reference-selection` from defensible candidates, note absent coverage, and do not invent a far reference.                                                                                                                                       |
| S12 receives a stale input or digest mismatch                        | A stale revision needs its recorded reason and impact handling; a mismatch at the exact locked revision blocks its use regardless of `onChange`. Neither causes silent retargeting to a newer revision.                                                   |
| S13 returns a malformed `design-system-asset`                        | Schema shape rejection prevents routing that output. A shape-valid output still needs separate registry, provenance/evidence, governance, and Run-policy checks.                                                                                          |
| S10 proposes a durable direction choice                              | Return a `proposed-selection` candidate and `decision` with `outcome: proposed` and pending approval. The Orchestrator forms a named Human Commit Point set; the Skill does not write `selected`.                                                         |
| A human rejects that choice while S16 can critique another candidate | Retain the rejected envelope and history; any renewed choice is a new proposal citing the rejection. Continue S16 provisionally; the Run is `active` or `review-ready` according to remaining work, not `blocked` solely because one choice was rejected. |
| S18 has only an automated accessibility result                       | Record the exact result file and limits for checked rules; leave untested WCAG criteria `UNVERIFIED` and do not claim full conformance.                                                                                                                   |
