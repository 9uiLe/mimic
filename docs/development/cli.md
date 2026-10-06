# Mimic CLI and filesystem protocol

`mimic` is the local entry point for a controlling AI agent. It uses the Core Orchestrator and one `FileWorkspaceStorage` at `.mimic/workspace.json`. No MCP service or shell execution is involved. With no arguments, it retains the original readiness JSON for existing startup checks.

Use Node 24.21.0. All commands accept `--root <workspace-directory>` (default: current directory) and `--json`. JSON and text stdout contain compact state, IDs, and relative paths. Errors and diagnostics go to stderr with stable exit codes: `0` success, `2` usage, `3` invalid input or unverifiable decision, `4` unsupported capability or missing host authority, `5` conflict, `6` I/O or internal failure. Full `next` plans and validation diagnostics are written under `.mimic/outputs/` with private file permissions; `--json` does not inline them.

## Workspace and work

1. `mimic init --root <directory> [--scope <organization-id>]` creates `.mimic/config.json`. Repeating it with the same configuration is safe. A custom scope graph can be supplied with `--scopes <file>` as a JSON object with `version: 1`, `defaultScope`, and `scopes` using Core `ScopeNode` entries. The input file must reside inside the workspace.
2. `mimic status` lists Run IDs and states, canonical artifact references, and the shared state path. Corrupt state fails; it is never reset automatically.
3. `mimic run --tasks <file> [--id <run-id>] [--scope <owner-id>] [--mode system-first|experience-first|hybrid]` starts an Orchestrator Run. The tasks file is a JSON array of Core `RoutedTask` objects inside the workspace. A supplied Run ID supports retry with the same plan. The plan is saved in `.mimic/runs/<run-id>.json` so later commands reopen the same routing context.
4. `mimic next <run-id>` returns compact actions and a path to the full `NextActions`, including exact references, invocation context, blockers, and evidence gaps.
5. `mimic decisions [run-id]` lists Decision Packet IDs, proposal IDs, status, and readiness.
6. `mimic validate --file <artifact.json>` runs JSON Schema validation only. It does not assert provenance, empirical evidence, accessibility, or release readiness. The input must reside inside the workspace.

## Authority and current limits

The standalone executable has no human authority verifier. `mimic decide --file <decision.json> [--commit <commit.json>]` requires a trusted embedding host to inject Core `RegistryAuthority`; it passes the exact Decision Record and optional Commit Request to the shared Run Registry. A JSON `actor.kind: "human"` field is data, not authentication. Reopening and routing from approved canonical artifacts also requires a host verifier that can revalidate those approvals; standalone use is limited to workspaces without approved canonical state. Core rechecks the proposal, exact snapshot, authority, and atomic commit conditions. Host consumers may call the exported `runCli` with `CliHost.authority` and a trusted Skill executor.

`mimic submit <run-id> --task <task-id>` invokes the Core Orchestrator only when the host supplies a trusted `executeSkill` function. Standalone Skill execution awaits the Skill harness; the CLI never executes caller-controlled shell text. `mimic preview` and `mimic release` return unsupported until their backends exist. None of these commands claim success for an absent capability.

## Preflight and recovery

`run` validates every task field, input group and exact reference, Skill ID, scope ancestry, dependency reference and cycle, and local evidence path before saving a plan or starting a Run. Invalid plans return exit 3 without creating either. Config and plan files are written to a synced temporary file and linked into their final name only after the complete JSON is durable. An interruption before publication leaves no final file, so the same `init` or `run --id` can be retried. A lost response after publication can be retried with the same input. The CLI does not reset corrupt workspace state or steal a writer lock. For a legacy truncated config or orphan plan, an operator must first verify no writer remains and inspect whether the corresponding Run exists before restoring or removing that file.

## Proposed terminal authority and Skill adapter

The following is a completion design, **not an implemented authority mode**. A standalone terminal `decide` can accept a human-issued signed receipt file alongside the Decision Record. A trusted verifier installed outside the agent-writable workspace would verify the receipt before constructing `RegistryAuthority`; neither `--root`, a workspace JSON field, an environment override controlled by the agent, nor an arbitrary imported plugin may choose signing keys. Installing that trust root and issuing real credentials are separate operator actions.

Use a canonical signed receipt with a key ID, action (`decide` or `commit`), human identity, decision/packet/proposal/Run IDs, scope owner ID, outcome, the candidate's exact artifact ID/revision/SHA-256 lock digest, and the approved or rejected output's exact ID/revision/digest when applicable. A commit receipt additionally binds the complete Commit Request ID and exact approval pairs. Bind the digest of the full submitted request, issued and expiry times, and a unique nonce. At acceptance, verify the signature against the protected trust root, match every bound field to the Core proposal and request, require the current time within the receipt window, and reject a nonce reused for a different action or request. Persist the verified receipt by digest for later Core readback; historical verification checks that the original acceptance time was inside the window, so expiry does not invalidate already committed approved artifacts. Core remains responsible for exact candidate freshness, authority, policy, and atomic publication. A receipt cannot assert empirical evidence without separate verified evidence binding.

After 9UI-103 provides its Skill harness, a fixed local adapter should route `submit` through that harness and pass its verified `SkillResult` to `Orchestrator.invoke`. The adapter should use file references within the workspace and never execute task text as a shell command. Until both adapters are implemented and tested, standalone `submit` and `decide` continue to return unsupported.
