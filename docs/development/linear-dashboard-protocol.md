# Linear dashboard protocol

This protocol makes the [Mimic Linear project](https://linear.app/9uile/project/mimic-bedb90164abf) the durable dashboard for autonomous development. It applies to agents and maintainers working on repository issues. The [Mimic v1 architecture and operating reference](https://linear.app/9uile/document/mimic-v1-architecture-and-operating-reference-4b4a6ddcb408) defines the product boundary; this document defines how to plan, record, and hand off work.

## Plan work in Linear

- Use project milestones for dependency and release stages. A milestone describes what must be ready for the next stage; it is not a bucket of unrelated tasks. Keep an issue in the stage that owns its deliverable.
- Use parent issues for workstreams and children for units that can be assigned, implemented, validated, and reviewed independently. Give each child a clear output and acceptance criteria. Split work that requires separate write sets or reviews.
- Add a hard blocker relation only when the dependent issue genuinely cannot proceed without the prerequisite. Describe the missing output in the dependent issue. Stage order, preference, or shared subject matter alone is not a blocker.
- Put a focused finding or bug under the closest owning workstream. Link related issues where useful; do not expand an unrelated issue's scope to absorb it.
- Keep produced references on the relevant issue as they become concrete: primary PR, repository files, specifications, prototypes, validation results, and decisions. Update stale references when artifacts move.

## Execute one issue per coding task

The clean `main` checkout is for coordination. Each coding task uses one issue, branch, worktree, and primary PR. Start from fresh `origin/main`; do not use the same branch in multiple worktrees. Use no more than four coding worktrees at once, and create only those needed for useful parallel work.

Before starting parallel tasks, compare their write sets and outputs. Serialize work that edits a shared design contract or whose output is a prerequisite for another task. Prioritize the critical path while limiting conflicts, rework, and idle time. Run targeted checks for the changed area, then the repository's canonical checks; never disable tests to make a change pass.

Reference the Linear issue in the primary PR. Maintainers may squash only after CI is green for the PR's actual current head and repository policy permits the merge. Never auto-merge an external contributor's PR. Mark the coding issue Done only after its primary PR actually merges and the issue's acceptance criteria are satisfied; record the merge SHA and evidence on the issue. Then sync `main` and dependent branches, re-evaluate dependent issues before starting them from the latest `main`, resolve conflicts, rerun affected checks, and clean up the merged worktree and branch. A draft PR or green CI alone is not completion.

Retry recoverable worker failures safely. If a durable architectural choice needs the owner, use the decision process below and continue independent reversible work. Record any blocked dependent work explicitly.

## Log every autonomous session

Append a concise Activity comment to the issue for every autonomous work session, including sessions that end blocked or without a code change. Record intent, changes, validation with outcomes, blockers or `none`, and the next action. Link the exact PR, file, document, or prototype when one exists. Update the issue's artifact references as work progresses.

Record decisions, evidence, actions, and outcomes. Do not store private chain-of-thought, raw internal deliberation, or unsupported claims. A failed check is an outcome to report, not a reason to omit validation. If work stops, name the condition that would unblock it and who owns the next action.

### Session log template

```text
Session (YYYY-MM-DD)
Intent: [issue-sized goal]
Changes: [what changed, or none; link PR/files/docs/prototype]
Validation: [commands or review performed and result; or why not run]
Blockers: [none, or exact prerequisite and owning issue/decision]
Next: [specific action and owner]
```

## Queue durable owner decisions

When an agent cannot safely infer a durable choice that belongs to the owner, create a focused issue labeled **Human Decision**, assign it to the owner, and link it to the affected workstream. Explain the options, trade-offs, evidence, and a recommendation. These issues are the owner's batch-review queue. Do not treat a provisional approach as approved.

Block only an issue whose next required output depends on the decision. Continue unrelated reversible work, including provisional exploration that does not commit the choice. If the decision is not blocking, state the provisional assumption in the affected issue and revisit it after the owner decides. Record the decision and its outcome in both the decision issue and affected issue; update durable artifacts through their normal review path.

### Human Decision issue template

```text
Title: [choice to make]
Label: Human Decision
Assignee: [owner]
Context and affected work: [links; what cannot be inferred safely]
Options: A — [benefit/cost]; B — [benefit/cost]
Evidence and trade-offs: [facts, uncertainty, and downstream effects]
Recommendation: [option and reason]
Decision needed by: [dependency or stage, not an invented deadline]
After decision: [affected issues/artifacts to update]
```

## Use project updates for milestones

Project status updates summarize meaningful changes across workstreams: stage readiness, completed deliverables, new cross-workstream risks, owner decisions needed, and the next dependency. Keep individual commands, attempts, and routine progress in issue Activity. Link the source issues and artifacts so the update remains verifiable.
