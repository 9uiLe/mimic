# Product UI reference guide for Mimic

Verified: 2026-10-09. This file is a compact S09 evidence input. The typed paths
and full claim ledger are in `graph.json`, `spaces.json`, and `sources.json`.
All transfers below are hypotheses; no external screen or slide is bundled.

## User purpose and selection question

Provisional Mimic user purpose: **compare different design directions for a
product, understand the reason for a choice, and make the chosen direction
operable**. For each visible element, ask which user decision or next action it
supports. Keep source data and engineering diagnostics reachable when needed,
but do not make internal artifact IDs, lock digests, or generation steps the
primary product information. Do not remove a status, constraint, or difference
that a user needs to compare or act.

## Four distinct reference spaces

| Path IDs            | Observed mechanism                                                                                                                                                                                                                                                     | Good fit and transfer test                                                                                                                                                            | Limit and counterexample                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `teamlab-object`    | In the author's bookshelf comparison, a collection of books leads to a selected book and its actions. [Speaker Deck slides 8–18, 28–31, 48, 60–61](https://speakerdeck.com/teamlab/object-oriented-ui-design).                                                         | Try an object-first proposal collection when people revisit, compare, and act on persistent proposals. Check that a person can find a proposal, understand it, and return to the set. | A single implicit target or fixed one-off procedure may work better as a task flow. Do not copy the bookshelf layout.                                                    |
| `smarthr-table`     | SmartHR's [common table](https://smarthr.design/products/design-patterns/smarthr-table/) shows object name, identifying/comparison fields, status, and actions. Its illustrated table and guidance distinguish essential columns from all available fields.            | Try a compact proposal comparison table when attributes are comparable. Ask users to explain differences and choose a next action without opening every detail.                       | Removing decisive columns or status makes a calm table misleading. Too many columns bury the action. Use detail views for secondary data, not for missing decision data. |
| `google-expressive` | Google's [email screen pair](https://design.google/library/expressive-material-design-google-research) makes Send larger and places it near the keyboard; the same article's playlist pair and label-removal finding show the cost of breaking recognizable structure. | Try emphasis where one next action is truly primary. Check if it is found quickly **and** surrounding choices remain legible.                                                         | Strong shape/color may be noise in a calm, multi-action setting. The source's study result is not a predicted Mimic effect. Do not remove labels merely to simplify.     |
| `github-run`        | GitHub's [Actions run image and explanation](https://github.blog/news-insights/product-news/improving-navigation-for-github-actions/) show status on parent/child jobs, expandable hierarchy, and a route back to the workflow list.                                   | Try a run overview showing current stage, completed/blocked work, next action, and optional diagnostic detail. Check where a person finds a stalled task and returns to the overview. | Raw steps flood the overview; a single aggregate badge hides a failing child. Do not imply precise or linear progress when work is parallel or uncertain.                |

## S09 → S10 → S11 handoff

1. Pass this file as an S09 `evidenceFiles` entry when the current task concerns
   proposal comparison or Run progress. The session prompt includes exact
   evidence file contents; merely storing the corpus does not inject it.
2. Read the current Problem Profile and UI Contract first. Map their **actual**
   traits to graph trait IDs. Assess each case's structural fit and context
   distance separately; a case has no permanent Near/Far/Anti role. Use
   `retrieveDesignReferences` and retain selected and excluded case reasons.
3. Carry the resulting `reference-selection` as an exact S10 input. Generate
   directions that change navigation, information architecture, interaction,
   spatial arrangement, density, or temporal behavior. Compare every pair on
   these axes. The four sources support different mechanisms; they are not four
   ready-made screens.
4. In S11 compare each direction against the same user task: Can the person
   identify where they are, distinguish meaningful alternatives, explain a
   choice, and take the next action? Note hidden state, missing evidence, and
   visual noise. Do not rank by a fabricated quality score. For the current
   Mimic review, accessibility is outside the evaluation axes and convergence
   gates; existing interaction support remains intact.

The work should retain the source's observation separately from each proposed
Mimic application. Verify the actual contract and capabilities before treating
any of these mechanisms as suitable for a product direction.
