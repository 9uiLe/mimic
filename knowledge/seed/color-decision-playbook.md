# Brand color to product UI roles

Verified: 2026-10-09. Compact evidence for brand and visual-system tasks. Copy
this file into the Run workspace and pass the workspace-relative path through
`evidenceFiles`; record its digest. Source observations and transfer hypotheses
are separated in `color-source-review.md`. The cited brands' actual color values
are not Mimic palette proposals.

## Start from intent, not a swatch

Inputs: the current Product Definition, approved Brand decision (if any),
Product UI Contract, principal user tasks and target screens, existing product
colors, and required states. If Mimic has no approved brand direction, propose
and compare candidate **color roles and rationales** provisionally; do not
present one exact hue as an approved brand asset.

Ask what the core color should signal, where it should be recognizable, and
where it should step back so work content and task state remain primary. Test
the answer in real screens, including a proposal comparison, a Run in progress,
a blocker, a selection, and a completed state. Brand emphasis and status
meaning need distinct roles so a decorative accent cannot masquerade as a
warning or selection.

## Four observed mechanisms and transfer boundaries

| Source                                                                                                         | Observed decision mechanism                                                                                                                                                   | Fit and limit for Mimic                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [kintone Style Book](https://speakerdeck.com/kintone/kintone-style-book), slides 24–28                         | Core yellow expresses the author's Warm Smart brand idea; support colors are subordinate, and the deck contrasts workable and weak color pairings.                            | A warm, visible core could fit an approachable tool if that is an approved character. A source's yellow and layout do not establish Mimic's identity; broad yellow surfaces may compete with task states. |
| [YouTube’s New Hue](https://design.google/library/youtube-new-red-color)                                       | The team kept a recognizable red but adjusted it after product research and screen/TV issues; a red–magenta gradient and red are reserved for brand and signature UI moments. | A mature brand can evolve recognition while limiting saturation in work surfaces. Mimic has no evidenced legacy red to preserve, and gradients can distract from dense comparison or status reading.      |
| [SmartHR color tokens](https://smarthr.design/products/design-tokens/color/)                                   | Semantic tokens separate main impression, text, link, border, surface/background, and danger/warning states.                                                                  | Assign roles before values so a color change can be evaluated across components. Copying SmartHR token values or assuming its HR task semantics would be unjustified.                                     |
| [IBM Carbon color guidelines](https://www.carbondesignsystem.com/building-blocks/foundations/color/guidelines) | Layered backgrounds pair with field and border tokens; contextual tokens adapt components to their layer.                                                                     | A restrained neutral work canvas with explicit depth suits nested panels and diagnostics. More layers add complexity and can be unnecessary for a flat, simple UI.                                        |

## Compare genuine color strategies

These are conditional strategies, not rankings or finished palettes:

1. **Warm core / quiet work area:** a single warm brand hue establishes identity
   in navigation and a few key moments; neutral surfaces carry comparison data.
   Check that warning, selection, and in-progress states remain distinguishable
   from the brand cue. Reconsider if the approved brand intent is technical,
   reserved, or incompatible with a warm signal.
2. **Signature moments / restrained canvas:** most working surfaces remain
   neutral; brand color concentrates on decisive actions and moments of
   recognition. Check whether the product still feels coherent across overview,
   detail, progress, and preview. Reconsider if users need a persistent visual
   anchor between distant contexts.
3. **Layered utility / minimal brand chroma:** background, surface, field,
   border, text, link, selected, and status roles organize nested work before
   expressive accents are chosen. Check whether the extra surface layers truly
   clarify containment. Reconsider if the interface is shallow enough that
   layering only adds decorative complexity.

For every candidate, map at least these semantic roles to proposed values:
`text.primary`, `text.secondary`, `background`, `surface`, `surface.raised`,
`border`, `link`, `action.primary`, `selection`, `status.in-progress`,
`status.blocked`, `status.complete`, and `brand.accent`. Explain any shared
value across roles and show the mapping in target screens and state changes.
Roles can be merged only when their meanings do not collide. The resulting
palette must trace to the approved brand and task context; no source case is
a palette to copy.

## Harness route and human decision

S09 may cite these color cases as visual-system references, with fit limits in
`reference-selection`. S10 compares structural directions first; it must not
settle a palette before structural fit. Once a direction and applicable
design-system foundations are resolved, S13 can propose provisional foundation
and DTCG token candidates using this role map and a bounded provisional brand
intent when no brand has been approved. S16 can critique the same-content
screen applications. Keep exact input and output artifact references in the
Run record and present every candidate as proposed until a human decides.

- **Machine-checkable:** `checkColorRoleProposal` verifies that every required
  role is mapped, the declared contexts use their required roles, cited cases
  are known, and shared values have an explicit reason. Inspect rendered
  screens or style sources separately for raw colors outside the proposal.
  These checks do not establish design quality.
- **Model comparison:** explain how each strategy changes brand emphasis,
  information hierarchy, nested surfaces, selection and status meaning;
  inspect screenshots for noisy saturation, weak text/background pairings,
  ambiguous status colors, or lost hierarchy. Keep observations separate from
  predicted effects; do not fabricate a numeric ranking.
- **Human decision:** select or revise the brand character, core hue, and
  endorsed product palette after seeing same-content alternatives. Until that
  choice, proposals remain provisional. For the current Mimic review,
  accessibility is outside design evaluation axes and convergence gates;
  existing interaction support remains intact.
