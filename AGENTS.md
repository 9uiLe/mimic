# Agent operating protocol

Follow [the Linear dashboard protocol](docs/development/linear-dashboard-protocol.md) for planning, execution, session logs, owner decisions, and project updates.

Use one issue, branch, worktree, and primary PR per coding task. Keep `main` clean for coordination, start from fresh `origin/main`, compare write sets before parallel work, and reserve hard blockers for real prerequisites. Run targeted checks and then canonical checks without disabling tests. Mark a coding issue Done only after its PR merges, and record the merge SHA and evidence. Log every autonomous session on its issue with intent, changes, validation, blockers, next action, and produced artifact links. Put durable owner choices in owner-assigned **Human Decision** issues and continue unrelated reversible work. Do not record private reasoning.
