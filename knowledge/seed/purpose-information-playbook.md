# User purpose and information hierarchy for Mimic

Verified: 2026-10-09. Compact S09/S11 evidence input. Source observations and
Mimic transfer ideas are separated in `purpose-information-source-review.md`.
Copy this file into a Run workspace and pass its workspace-relative path in
`evidenceFiles`; record the copied bytes' digest. This guide does not replace
the current Problem Profile or Product UI Contract.

## State the task before reducing information

Mimic's repository `README.md` describes its intended outcome as a versioned
Design Package that a person can inspect, critique, and build from. A person
works with a controlling AI through a local CLI, considers distinct design
directions and evidence, and makes durable choices. The repository's
`docs/development/workspace-monitor.md`
has a narrower, diagnostic purpose: show a Run's recorded state, stop reason,
artifacts, and selected prototype without suggesting unearned approval or
completion. It cannot approve, resume, or commit work.

For each target screen, write one task sentence: **who needs to decide or act,
on what object, using which evidence, with which next step?** The minimum
visible information is the smallest set that lets that task succeed. Fewer
pixels alone are not a successful reduction. Preserve a route to source and
diagnostic detail when needed.

## Conditional mechanisms

| Source and observed mechanism                                                                                                                                                                                    | Fit test                                                                                                                                                                            | Failure or counterexample                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SmartHR common table](https://smarthr.design/products/design-patterns/smarthr-table/): row identity, comparison fields, status, and actions are visible; the first-party guidance says not to show every field. | A person compares several persistent proposals using shared attributes. Ask them to explain a choice and next action from the overview.                                             | A hidden decisive difference or status forces repeated detail visits and undermines comparison; too many columns bury the action.                                                         |
| [teamLab object-oriented UI deck](https://speakerdeck.com/teamlab/object-oriented-ui-design): in the illustrated book collection, identity leads to an individual object and its contextual actions.             | A person repeatedly selects a persistent object before acting. Put collection-level identity and distinguishing facts first, then object-specific actions and details at selection. | A one-off procedure does not need an object collection; deferring a cross-object comparison fact until detail can make selection harder. The bookshelf is an example, not a Mimic screen. |
| [GOV.UK Details](https://design-system.service.gov.uk/components/details/): a short summary opens one optional help section.                                                                                     | One bounded explanation matters to a minority of users after the main action is clear. Test whether the summary makes that detail discoverable.                                     | The source explicitly says not to hide information most users need. If several important sections exist, one Details control is the wrong structure.                                      |
| [GOV.UK Complete multiple tasks](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/): task groups, completion labels, and links orient a returning user.                                     | A long transaction spans multiple tasks or sessions. Show completed, pending, blocked, and next actionable task with honest dependencies.                                           | If the task can be simplified or finished in one pass, a task list adds process noise. A small aggregate count cannot explain which task needs attention.                                 |
| [GitHub Actions Run navigation](https://github.blog/news-insights/product-news/improving-navigation-for-github-actions/): parent/child job status and an expandable hierarchy connect overview and diagnosis.    | Work is parallel or nested and a person must locate a failing child or return to the run overview.                                                                                  | Raw steps on the overview overwhelm; a single parent badge hides a child failure. Do not invent a linear percentage for uncertain work.                                                   |

## Use in divergence and convergence

1. For the current profile, list the visible decision facts: object identity,
   meaningful alternatives, discriminating attributes, current/blocked state,
   consequence, and next action. Mark each as `visible`, `on-demand`, or
   `not-needed`, with a reason. A fact needed to decide now stays visible.
2. Generate at least two proposals with different information or interaction
   mechanisms when the task supports them: object comparison, task-oriented
   progress, or a compact overview with bounded diagnostic disclosure.
   Variation in color or whitespace alone is not a new direction.
3. In S11, test every proposal against the same concrete task. Can the person
   locate the current object and state, distinguish alternatives, explain a
   choice from visible evidence, recover a blocker, and identify the next
   action? Log missing decisive information and noise separately. Do not use
   a fabricated score or hide uncertainty behind a neat presentation.
4. Keep internal IDs and lock digests inspectable for provenance, but only
   place them in the primary hierarchy when the user task actually requires
   copying or verifying them. Preserve the monitor's existing safety and
   operational boundaries. For the current Mimic design evaluation,
   accessibility is outside the convergence axes and gates; existing
   interaction support is not removed.

The source examples are mechanisms and limits, not ready-made Mimic screens.
Their fit, role, and effect remain hypotheses until evaluated on the actual
profile and UI Contract.
