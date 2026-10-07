# Explore Mimic locally

This guide is for contributors and controlling AI hosts investigating the current pre-alpha implementation. Start with the [English README](../../README.md) or [Japanese README](../../README.ja.md) for the product boundary. The [CLI reference](../development/cli.md) is authoritative for command inputs and errors; this page gives a short route through them.

## 1. Prepare the checkout

Use Node.js `24.21.0` (see `.node-version`) and pnpm `12.9.1` (see `package.json`). From the repository root:

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
```

The executable in this source checkout is `node apps/cli/dist/main.js`. The documented `mimic` spelling names that CLI, not a separately installed global command. See [development setup](../development/README.md) for the complete local toolchain and checks.

## 2. Discover before creating a workspace

The read-only Skill interface works without `init`:

```sh
node apps/cli/dist/main.js skill
node apps/cli/dist/main.js skill flow --mode system-first
node apps/cli/dist/main.js skill flow --mode experience-first
node apps/cli/dist/main.js skill show s01 --full
```

`skill` discovers installed packages from `skills/*/manifest.yaml`. `skill show` reads a package's manifest and instructions; `skill flow` points to the checked-in flow sources. `skill schema <type>`, `skill artifact <type>`, and `skill topic <topic>` locate contracts and documentation. `skill recommend <intent>` makes deterministic text-based suggestions; it does not run a Skill, rank design quality, or obtain human approval. See [Skill discovery](../development/skill-bootstrap.md) for the complete query interface. Treat source files under `skills/` as task contracts, not evidence of a connected reasoning model.

## 3. Understand the intended design work

**System-first** begins by examining real existing capabilities and recording evidence; **Experience-first** begins with user goals and the desired journey. Both lead through the shared Product UI Contract before domain-specific design. A capability that is merely proposed must remain labeled proposed, even in a convincing mockup. The modes change starting context, not approval authority. The [Run contract](../specifications/orchestrator-runs.md) explains this boundary.

The design sequence moves from product and task definition through system and experience modeling, design-problem profiling, reference exploration, distinct directions, design-system resolution, prototype, and validation. The [design-space specification](../specifications/design-space-exploration.md) explains why structural relevance matters more than copying a reference screen. A Run can produce provisional artifacts and evidence while a decision waits. At a **Human Commit Point**, a human decides which exact proposal and revision may become canonical. A schema pass or a polished prototype cannot approve itself.

The target [Design Package](../specifications/design-package-governance.md) records the resulting decisions, design-system dependencies, executable prototype, scenarios, system requirements, evidence, and history as a versioned deliverable. This is a target contract; the current CLI cannot publish it.

## 4. Try the implemented workspace protocol

Initialize a separate workspace directory with `mimic init --root <directory>`, then use `mimic status --root <directory>` to inspect it. Pass the same `--root <directory>` on every later command, or run from that directory. `mimic run --tasks <file> [--mode system-first|experience-first|hybrid]` requires a workspace-local JSON array of routed tasks. `mimic next <run-id>` points to file-backed actions. `mimic submit <run-id> --task <task-id> --package <directory> --work <file>` accepts a matching static Skill package and structured work file; it does not execute package text or produce live AI reasoning. Read the [CLI reference](../development/cli.md) and [Skill runtime guide](../development/skill-runtime.md) before constructing these inputs. All command paths must respect the workspace rules in the CLI reference.

`mimic decisions [run-id]` lists pending decision packets. For `mimic decide --file <decision.json> --confirmation <confirmation.json>`, the controlling host must present the actual proposal, candidate and expected revisions, scope, outcome, and any commit effects to a human and obtain an explicit answer. Decision confirmation and commit confirmation are separate. The standard local assertion trusts that host to ask and report faithfully; it does **not** isolate the interaction from a malicious process with the same OS rights. Local use needs no signing key, protected trust root, or server. Signed receipts are an optional advanced mode with their own protected trust setup; failed signed verification never falls back to local confirmation. The [CLI authority details](../development/cli.md#authority-and-current-limits) define the exact fields and limits. Do not synthesize a confirmation from a Skill output or an actor label.

## 5. Read results with the right limits

`mimic validate --file <artifact.json>` checks JSON Schema shape. It does not prove provenance, empirical findings, accessibility, or release readiness. Static Skill packages and synthetic tests establish executable contracts, not live design quality. `mimic preview --file <authored-plan.json>` builds a local specification prototype from exact approved workspace artifacts and writes inspect-only quality reports. `mimic release inspect` exposes individual findings for policy review, `mimic release prepare` freezes a local package candidate, and `mimic release publish` requires separate exact human confirmation. A cooperative local policy assertion permits dependency-free packages; packages with external dependencies need a trusted host policy and authority. See [the CLI protocol](../development/cli.md) for the file shapes and recovery rules. `pnpm dev` starts only the local demo lab. These local commands do not provide a hosted service or production deployment pipeline.

For implementation and contribution work, follow the [development guide](../development/README.md), [contribution guide](../../CONTRIBUTING.md), and the more detailed [architecture specifications](../specifications/technical-baseline.md).
