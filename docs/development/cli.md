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
