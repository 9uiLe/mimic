# Artifact architecture (v1)

This specification defines the file contract for Mimic artifacts. It implements the [Mimic v1 Architecture & Operating Reference](https://linear.app/9uile/document/mimic-v1-architecture-and-operating-reference-4b4a6ddcb408) and [9UI-88](https://linear.app/9uile/issue/9UI-88/define-artifact-architecture-schemas-provenance-and-revision-semantics). The schema source is [`schemas/artifacts/artifact.schema.json`](../../schemas/artifacts/artifact.schema.json). Every document is one YAML mapping; JSON is accepted as the YAML-compatible fixture format. Parse YAML into JSON-compatible values, then validate with JSON Schema 2020-12 and Ajv 2020. Load the entry schema, the common schema, and every `types/*.schema.json` into the validator by their `$id`; no network schema fetch is needed. Enable Ajv's `date-time` format support. Reject duplicate YAML mapping keys and non-JSON values before schema validation.

## Artifact identity and envelope

`meta.id` is a stable logical artifact ID, independent of file path. `meta.revision` identifies one immutable snapshot of that artifact. `meta.type` selects one of the sixteen v1 content contracts. `meta.schemaVersion` is the contract version, currently `1.0.0`. A path, filename, Git commit, Run ID, and release package version are distinct identifiers. Moving a file does not change its ID; editing a snapshot requires a new revision. `meta.supersedesRevision` is required from revision 2 onward and points to the previous revision. The registry must enforce uniqueness of `(meta.id, meta.revision)`, monotonic revisions, matching `supersedesRevision`, and immutable approved snapshots; JSON Schema cannot compare documents or Git history. `meta.contentDigest` is a SHA-256 digest of the canonical serialized artifact snapshot, excluding the digest field itself. The exact byte canonicalization is a storage-layer decision; until that is specified, a writer must not claim a verified digest. The examples use illustrative digest values, not verified hashes.

The common envelope requires:

| Field          | Contract                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta`         | Stable ID, type, schema version, revision, title, creation time, and approved-snapshot digest.                                                                            |
| `scope`        | `organization`, `product`, `domain`, or `local`, with owner ID and parent ID except at organization level. Parentage must follow Organization → Product → Domain → Local. |
| `lifecycle`    | `provisional`, `proposed`, `approved`, or `rejected`; freshness `valid`, `stale`, or `blocked`. Stale and blocked need a reason.                                          |
| `origin`       | Actor kind/ID, Run ID, creation time, and optional source artifact IDs. A skill writes an artifact; it does not invoke another skill.                                     |
| `dependencies` | Exact artifact ID and revision, locked digest, and change impact: `none`, `validate`, `revise`, or `invalidate`.                                                          |
| `approval`     | Pending, approved, or rejected. A decision ID, human actor ID, and time are required for approved/rejected outcomes.                                                      |
| `provenance`   | Content JSON Pointer, epistemic kind, and supporting references or rationale.                                                                                             |
| `content`      | Type-specific machine-readable payload.                                                                                                                                   |

The schemas constrain shape. A producer/registry must additionally verify that the approval actor is human, the decision exists, each dependency lock digest matches the referenced exact revision, scope ancestry exists, IDs resolve, and provenance pointers resolve to content. A dependency's `onChange` is the declared minimum response when a newer upstream revision is considered: `none` means no content impact; `validate` requires rechecking; `revise` requires a proposed new revision; `invalidate` blocks use until replacement or human resolution. The existing revision lock remains unchanged unless a new artifact revision explicitly adopts another exact dependency revision. A digest mismatch at the locked revision is an integrity failure and blocks use regardless of `onChange`. No design-system dependency upgrades automatically. A freshness value is the current assessment for a revision; changing it requires a new recorded state event or revision, not mutation of approved bytes.

## Provenance and truthfulness

Each substantive claim should have a `provenance` entry at the narrowest useful `/content` JSON Pointer. Use `fact` only with an evidence reference, `human-decision` with a decision ID, `assumption` or `hypothesis` with a rationale, `derived` with input references, and `unknown` with a reason. A reference string identifies a resolvable artifact, evidence file, or external source; it does not itself prove a claim. Reviewers must check evidence relevance and trace derivations. Mock data and untested assertions remain assumptions or hypotheses. Empirical outcomes stay `UNVERIFIED` until supported by evidence. Automated accessibility checks are limited evidence, not proof of WCAG 2.2 AA compliance. Never represent proposed system capability as current.

## Revisions, state, and human authority

The durable loop is canonical state → Run → provisional artifacts → evidence/prototype → Human Commit Point → merge or discard. The Orchestrator routes work through artifact inputs and outputs; skills neither communicate directly nor invoke one another. A Run may create or revise provisional artifacts and continue exploration while a decision is pending. Analysis, alternatives, prototype/mock data, critique, and checks are autonomous. Product definition, brand, experience-domain boundaries, a selected direction, system changes, promotion to shared organization scope, and final release are **PROPOSE_ONLY** until a human decision is recorded. Approved artifacts are immutable in place. A proposed change starts a new revision with pending approval; the prior approved revision remains usable under its exact lock until explicitly replaced. Rejection records a decision and leaves the approved revision intact. No schema validation alone grants approval.

The registry may use Git for initial history, but consumers must depend on logical IDs and revision locks, not path layout or Git SHA as the sole contract. Released Design Packages are separately immutable and versioned. A package version selects exact artifact revisions and cannot be inferred from `meta.revision`; release requires human approval. Promotion of an asset from local/product/domain to organization scope also requires human approval. No automatic design-system upgrades are allowed.

## Type contracts

The sixteen `types/*.schema.json` files constrain `content` and `meta.type`. They intentionally cover the first machine-readable structure, not all future design fields.

| Type                  | Required content beyond `summary`                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product-definition`  | vision, goals, nonGoals                                                                                                                                  |
| `user-task-model`     | users, tasks                                                                                                                                             |
| `brand`               | attributes, voice, visualIntent                                                                                                                          |
| `system-capability`   | capabilityId, availability, description; current requires supportingEvidence                                                                             |
| `product-ui-contract` | navigation, terminology, entityContext, WCAG 2.2 AA baseline                                                                                             |
| `experience-domain`   | primaryGoal, interactionModel, informationStructure, temporalBehavior, riskModel, sessionModel                                                           |
| `problem-profile`     | traits, principles, risks                                                                                                                                |
| `reference-selection` | references with classification, relevance, context distance, transferable mechanisms; `far` requires high structural relevance and high context distance |
| `design-direction`    | principles, mechanisms, selectionStatus; `selected` requires an approved envelope                                                                        |
| `evaluation`          | target and findings with PASS/CONCERN/FAIL/UNVERIFIED/N/A and severity                                                                                   |
| `system-request`      | changeType, request, rationale                                                                                                                           |
| `design-system-asset` | assetKind, name, definition, usageRules, antiUsageRules                                                                                                  |
| `scenario`            | actor, context, steps, expectedOutcome                                                                                                                   |
| `journey`             | domains, steps, preservedContext                                                                                                                         |
| `decision`            | question, alternatives, outcome; `committed` requires chosenAlternative, rationale, and an approved envelope                                             |
| `validation`          | target, method, state, evidenceRefs; PASS/CONCERN/FAIL require evidence                                                                                  |

`design-system-asset` covers foundations, DTCG tokens, semantic icons and provider bindings, components, patterns, layouts, responsive/accessibility rules, and governance. Composition is Task → Pattern → Layout → Components; icon semantics are separate from provider bindings. A provider binding must preserve third-party license terms. Cross-domain journeys should preserve entity context, terminology, navigation, return path, and state where applicable. Schema validates the declared list, while a review checks actual continuity.

## Validation and examples

[`fixtures/artifacts/valid`](../../fixtures/artifacts/valid) contains schema-valid examples, one per type plus a stale locked dependency; [`fixtures/artifacts/invalid`](../../fixtures/artifacts/invalid) contains deliberate contract violations. The invalid filenames state their failure: approval mismatch, a random `far` reference, an unsupported fact, selected direction without approved lifecycle, a dependency without a lock digest, and stale freshness without a reason. The JSON files can be parsed as YAML. [`proposed-product-ui-contract.yaml`](../../fixtures/artifacts/valid/proposed-product-ui-contract.yaml) demonstrates native YAML authoring. A validator should reject each invalid fixture against the entry schema and accept each valid fixture. Cross-document constraints and evidence quality need separate checks when runtime/registry support is added.

This specification does not define the 9UI-89 runtime state machine or 9UI-90 skill I/O protocol. Those efforts consume these artifact contracts.
