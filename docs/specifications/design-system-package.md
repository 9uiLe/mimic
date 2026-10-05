# Design System package (v1)

Status: specification for [9UI-92](https://linear.app/9uile/issue/9UI-92/specify-ai-readable-design-system-package-patterns-and-iconography). This document applies the [Mimic v1 Architecture & Operating Reference](https://linear.app/9uile/document/mimic-v1-architecture-and-operating-reference-4b4a6ddcb408), [technical baseline](technical-baseline.md), and [artifact architecture](artifact-architecture.md). The canonical artifact contract is [`design-system-asset.schema.json`](../../schemas/artifacts/types/design-system-asset.schema.json), with an [existing valid fixture](../../fixtures/artifacts/valid/design-system-asset.json). The Design System is executable design knowledge: an agent can resolve design decisions, compose a prototype, and explain why each choice is allowed. It is more than a component catalog. This document specifies knowledge and review rules, not a runtime interface.

## Scope and asset contract

The inheritance path is **Organization → Product → Experience Domain → Local**. It uses the existing envelope `scope.level` values `organization`, `product`, `domain`, and `local`. `scope.ownerId` identifies the owner; every non-organization scope has `scope.parentId`. A design context resolves the applicable approved revisions along that ancestry. A narrower scope may add a permitted variation, but cannot silently edit or replace an approved parent revision. Domain rules address a distinct experience domain; local rules apply to one bounded design context. Product rules express product-wide decisions. Organization rules are shared defaults.

Each unit of knowledge is a `design-system-asset` artifact with `meta.schemaVersion: "1.0.0"`. Its `content` has exactly these required outer fields: `summary`, `assetKind`, `name`, `definition`, `usageRules`, and `antiUsageRules`; `providerLicense` is optional. Put category-specific structures, including failure modes and property governance, inside `definition`. The schema permits no other outer `content` fields. The existing [valid fixture](../../fixtures/artifacts/valid/design-system-asset.json) demonstrates the full envelope; its provisional pattern is illustrative, not an approved design decision.

| `assetKind`          | Knowledge represented in `definition`                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `foundation`         | Design principles, visual intent, motion and content principles, and the conditions under which they apply. |
| `dtcg-tokens`        | Source tokens in Design Tokens Community Group (DTCG) form, references, modes, and transformation intent.   |
| `semantic-icon`      | A purpose or state conveyed by an icon, contextual meaning, and representation policy.                      |
| `provider-binding`   | A concrete provider glyph or custom asset bound to a semantic icon.                                         |
| `component`          | A semantic UI building block, its states, inputs, behavior, and accessibility expectations.                 |
| `pattern`            | A task-level interaction strategy, context, decision criteria, slots, and failure modes.                    |
| `layout`             | Structural placement, reading order, regions, and layout constraints used by a pattern.                     |
| `responsive-rule`    | How structure and interaction adapt to viewport, input, and content constraints.                            |
| `accessibility-rule` | Testable interaction and content obligations against the WCAG 2.2 AA baseline.                              |
| `governance`         | Per-property inheritance policy, allowed variations, approval conditions, and promotion criteria.           |

Every asset must state when to use it and when not to use it in `usageRules` and `antiUsageRules`. Put observable failure modes and recovery guidance in `definition`, rather than implying that a reusable pattern always succeeds. This category vocabulary is fixed by the v1 `assetKind` enum. The detailed keys inside `definition` below are illustrative conventions; the current schema requires only a nonempty object there and does not validate each category's internal structure.

## Resolution and composition

Resolve **Task → Pattern → Layout → Components**. Start with the user task, its context and risks. Select a pattern whose intent and usage rules fit that task; inspect its anti-usage rules and failure modes. Select a layout that preserves the pattern's required information and interaction order. Fill the layout with components that satisfy the pattern's slots and states. Then apply foundations, tokens, responsive rules, accessibility rules, and relevant semantic icons across the composition. A component's existence is not a reason to select a pattern; a visual treatment must not quietly change the task structure.

For example, a task to compare two candidate plans can select a `pattern` called **Candidate comparison** with slots for shared criteria, differences, uncertainties, and a decision action. Its `layout` can use aligned sections on wide screens and a criterion-by-criterion sequence on narrow screens. `component` assets can supply headings, comparison rows, evidence links, and a decision control. A `responsive-rule` must preserve criterion labels and association with each candidate in both presentations. An `accessibility-rule` must preserve semantic headings, discernible controls, keyboard use, and meaningful order. The pattern fails if visual alignment makes different units appear comparable or hides uncertainty; its anti-usage rule should reject such use. This is a proposed design example, not empirical validation.

The following is a **content-only** example. It maps directly to the existing `design-system-asset` content shape; a real artifact also needs the common envelope, provenance, and any exact dependency locks.

```json
{
  "summary": "Compare candidate plans using shared criteria and visible uncertainty.",
  "assetKind": "pattern",
  "name": "Candidate comparison",
  "definition": {
    "task": "Choose between two or more candidate plans",
    "slots": [
      "shared criteria",
      "candidate evidence",
      "uncertainty",
      "decision action"
    ],
    "layoutIntent": "Keep each criterion associated with every candidate at all sizes",
    "failureModes": [
      "Different units appear equivalent",
      "A narrow layout omits uncertainty or candidate identity"
    ]
  },
  "usageRules": ["Use when candidates can be assessed against shared criteria"],
  "antiUsageRules": ["Do not use as a ranking when evidence is unverified"]
}
```

The pattern-to-layout and layout-to-component selections should be recorded as exact `dependencies` on their separate artifacts when a selection relies on those assets. The task context and choice rationale need truthful `provenance` in the consuming artifact. Dependencies identify locked artifact IDs, revisions, digests, and change impact; a displayed asset name or a path is not a lock.

## Property governance and constrained variation

Resolve each property against the closest applicable approved ancestor rule. A governance asset can declare a policy for a property path in `definition`; the property owner and scope are supplied by the artifact envelope. A more specific rule is allowed only within its parent's declared variation policy. Missing permission is not an override. Treat an ambiguous or contradictory rule as blocked for durable use and propose a revision for human review.

| Policy         | Child-scope behavior                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `locked`       | Preserve the approved parent value. A different value requires a proposed parent revision and human approval; a child cannot relabel the property to escape the lock.             |
| `configurable` | Select a value from the parent's explicit options or range and record the selection and rationale. A value outside that boundary requires a proposed revision and human approval. |
| `overridable`  | Declare the replacement at the child scope, cite the parent property and reason, and obtain the approval required for that durable decision. The parent snapshot stays intact.    |

For example, an approved product governance asset may lock `component.button.focusIndicator` to a visible treatment, allow `component.button.density` as `comfortable` or `compact`, and permit `pattern.comparison.columnOrder` to be overridden for a domain. A domain may select `compact` for a dense comparison and declare a different column order with a documented task rationale. It may not remove the focus indicator, add a third density value, or silently replace the product asset. The constrained selection must still meet accessibility rules. This is policy guidance, not a claim that the current schema checks property paths or allowed-value membership.

Review failure modes include a child asset shadowing an approved parent by name, a configurable value outside its approved set, an override without its parent reference or rationale, and an inherited rule whose locked dependency is stale or mismatched. Record those cases as blocked or proposed work; do not reinterpret the approved snapshot in place.

## Tokens and prototype output

The `dtcg-tokens` asset carries source token semantics, types, values, and references in DTCG form inside `definition`. A deterministic transformation resolves those references and emits CSS custom properties for the canonical semantic HTML, plain CSS, and ES JavaScript prototype. Generated CSS is derived output, not the source of authority. It must be reproducible from the exact source artifact revisions and transformation inputs; changes to generated CSS alone are not design-system revisions. Preserve modes and references rather than flattening them into unexplained colors or dimensions. A token conflict, missing reference, or unrepresentable value blocks a trusted output until resolved. This specification does not prescribe a compiler API or runtime package dependency.

## Semantic iconography and representation

A `semantic-icon` defines meaning independently of glyph shape or vendor. Its `definition` should describe the concept, context, state distinctions, ambiguity risks, and representation policy. The representation policy chooses among **icon-only**, **icon + label**, and **label-only** for each use context. Icon-only is acceptable only when the meaning is reliably understood in that context and the interactive control still has a discernible accessible name. Use icon + label when text disambiguates an action or state; use label-only when a glyph adds no reliable meaning or is unavailable. Do not use icon shape alone to distinguish critical states, and check meaning with representative users when making empirical claims.

A separate `provider-binding` maps a semantic icon to a concrete glyph or custom asset, with its own exact dependency on the semantic icon revision. Lucide is the default **replaceable** provider, not part of Mimic's identity. A different provider may implement the same meaning if the binding preserves the semantic contract and passes visual, accessibility, and license review. Record a third-party binding's license terms in `content.providerLicense` and preserve required notices and attribution when distributed. A license string is documentation, not proof that a use is permitted. Keep brand marks and trademarks separate from the general semantic-icon provider pool; a brand asset needs its own rights and human-governed brand decision. Custom icons should begin at local or product scope. Promoting one to shared organization scope requires a human decision and a new approved artifact revision or scope-specific artifact, never an automatic move.

These two **content-only** examples show the separation. The binding's full artifact must lock the semantic icon's exact ID, revision, and digest in `dependencies`, and record the provider asset's exact version and distribution terms. The example is provisional; reviewers must verify the actual glyph and applicable terms before approval. Lucide's [published license](https://lucide.dev/license) lists the `x` icon among Feather-derived glyphs, for which it includes a separate MIT notice alongside the ISC terms.

```json
{
  "summary": "Indicate that an item can be removed from a selection.",
  "assetKind": "semantic-icon",
  "name": "Remove item",
  "definition": {
    "meaning": "Remove this item from the current selection, without deleting the underlying item",
    "representation": {
      "toolbar": "icon+label",
      "denseSelectedItem": "icon-only",
      "ambiguousContext": "label-only"
    },
    "failureModes": ["A delete glyph implies permanent deletion"]
  },
  "usageRules": ["Use only for removal from a selection"],
  "antiUsageRules": ["Do not use for permanent deletion"]
}
```

```json
{
  "summary": "Candidate Lucide glyph for the Remove item meaning.",
  "assetKind": "provider-binding",
  "name": "Remove item / Lucide",
  "definition": {
    "semanticIconArtifactId": "art_remove_item",
    "provider": "Lucide",
    "glyph": "x",
    "review": "Check the glyph in context and verify the applicable license before approval"
  },
  "usageRules": ["Use only with the locked Remove item semantic-icon revision"],
  "antiUsageRules": ["Do not infer permanent deletion from this glyph"],
  "providerLicense": "Lucide ISC and Feather MIT notices for x; verify exact asset and retain both notices"
}
```

## Revision, evidence, and enforcement boundaries

`meta.id` is the stable logical ID; `meta.revision` identifies one immutable snapshot. Revision 2 and later carries `meta.supersedesRevision`. Approved assets are immutable in place, including before release. A change is a new proposed revision with pending approval, while the earlier approved revision remains available under its exact lock. A Design Package selects exact design-system asset revisions and lock digests; it does not upgrade them automatically. A dependency digest mismatch at the locked revision blocks use. Promotion across scopes is a human decision, especially promotion to organization scope. Human approval records a decision, actor, and time; schema validity alone cannot grant authority.

Record provenance at the narrowest useful `/content` pointer. A fact needs evidence; an assumption or hypothesis needs a rationale; a human decision needs its decision ID; a derivation needs input references. Do not present mock data, a glyph interpretation, or an automated test result as observed user evidence. Accessibility targets WCAG 2.2 AA. Automated checks can provide evidence for checked rules, but cannot establish full conformance; untested outcomes remain `UNVERIFIED`.

| Requirement                      | Current schema enforcement                                                                                                                        | Additional producer/reviewer responsibility                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Asset category and outer content | `assetKind` enum, required fields, nonempty `definition`, usage and anti-usage arrays, optional `providerLicense`; no extra outer content fields. | Check that definitions and rules are meaningful for the category.                                                                        |
| Scope and approval envelope      | Allowed levels, parent ID presence, lifecycle and approval shape, approved-snapshot digest format.                                                | Verify actual ancestry, human actor and decision, approval authority, and immutability across revisions.                                 |
| Exact dependencies               | ID, revision, lock-digest syntax, and `onChange` value.                                                                                           | Resolve the referenced snapshot and compare its actual digest; assess change impact. Illustrative digest strings are not verified locks. |
| Composition and governance       | Category-specific `definition` structures are not typed.                                                                                          | Check task fit, property permissions, parent references, override rationale, and accessibility constraints.                              |
| Icon license and meaning         | `providerLicense` is an optional string; provider binding is an allowed kind.                                                                     | Verify provider rights, retain notices, keep brand/trademark assets separate, and approve shared promotion.                              |

The existing schemas and fixture support these examples without a schema change. Category-specific validation, cross-artifact ancestry and locks, evidence quality, and human authority remain semantic checks to be implemented or reviewed outside the current schema. This document does not claim that those checks already run.
