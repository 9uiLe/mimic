# Mimic

**Design like a designer.** [日本語](README.ja.md)

Mimic is an early-stage, model-independent, AI-operated product design engine. A human works with a controlling AI agent, which uses Mimic's local CLI, Skills, and file-backed artifacts to explore a product design. The intended deliverable is a versioned **Design Package** that people and tools can inspect, critique, and build from. Mimic is not a production application generator or a production-framework conversion service.

## Why Mimic

Generic AI prompts can converge on familiar layouts and visual conventions even when products have different users, tasks, and constraints. Mimic starts with the problem and evidence: it examines task traits, design principles, and transferable mechanisms before choosing an interaction direction or visual treatment. References are material to analyze, not interfaces to copy. This is the project's design goal, not a claim that current Skills have demonstrated better live design quality.

## How the design flow works

The intended path moves from product definition and user tasks through brand, system capabilities, a shared Product UI Contract, and experience domains. It then profiles design problems, explores references and distinct directions, resolves design-system choices, composes a prototype, and critiques and validates the result. See the [design flow](docs/specifications/design-space-exploration.md) and [Run contract](docs/specifications/orchestrator-runs.md) for the full sequence.

**System-first** begins with evidenced capabilities of an existing system; **Experience-first** begins with the desired user experience. They are entry modes into the same flow. Both meet at the Product UI Contract and keep the same approval rules; neither makes a proposed system capability real.

Mimic's intended operating loop is canonical state → reversible Run → provisional artifacts and evidence → **Human Commit Point** → accept or discard the named revisions. AI can explore alternatives, draft, prototype, and run checks autonomously. A human makes durable choices such as product definition, brand, experience-domain boundaries, selected direction, shared-asset promotion, and final release. The controlling host must present the exact proposal and obtain explicit human confirmation before recording a decision or commit. A pending choice need not stop unrelated reversible work.

## What a Design Package contains

The target Design Package brings together machine-readable design decisions, design-system usage, an executable semantic HTML/CSS/JavaScript prototype, scenarios, system requirements, validation evidence, and decision history. Approved artifacts and released packages are intended to be versioned and immutable in place. The [package governance contract](docs/specifications/design-package-governance.md) describes the target format and lifecycle; the release backend is not yet implemented.

## Start exploring

Use Node.js **24.21.0** and pnpm **12.9.1**. After `pnpm install --frozen-lockfile` and `pnpm build`, run the local CLI from the repository root:

```sh
node apps/cli/dist/main.js skill
node apps/cli/dist/main.js skill flow --mode experience-first
node apps/cli/dist/main.js skill show s01 --full
```

`mimic skill` is the read-only discovery interface for a controlling AI and works before workspace initialization. It lists installed Skill packages, flow and schema sources, and related documentation. It does not execute a Skill or make a design decision. See the [onboarding guide](docs/onboarding/README.md) for a first-workspace path and the [CLI reference](docs/development/cli.md) for exact commands and confirmation inputs.

## Current status and architecture

Mimic is **pre-alpha**. The repository has a local CLI, Core orchestration and artifact storage, schema contracts, static Skill packages, and a demo lab. `init`, `status`, `run`, `next`, `submit`, `decisions`, `decide`, `validate`, and `skill` are implemented with the documented constraints. `preview` and `release` have no implemented backend. The demo lab is a local preview surface, not a Design Package deployment path. Static Skill definitions and synthetic tests establish contracts; they do not establish live AI reasoning or empirical design quality.

The interaction boundary is **human → controlling AI agent → local CLI and filesystem → model-independent Core**. An Orchestrator routes file-backed artifacts between Skills; Skills do not call one another. Schema validation, registry checks, and human authority are separate from AI reasoning. Core does not require MCP or a hosted backend. The [onboarding guide](docs/onboarding/README.md) separates today's capabilities from the intended design flow; [technical architecture](docs/specifications/technical-baseline.md) gives the deeper boundaries.

## Contributing and license

External bug reports, feature ideas, and knowledge proposals are welcome through focused issues. External pull requests are not accepted until dogfooding is complete; the maintainer will reassess PR intake afterward. Start with the [contribution guide](CONTRIBUTING.md), [development setup](docs/development/README.md), [code of conduct](CODE_OF_CONDUCT.md), and [security reporting policy](SECURITY.md). Pull request commits need a DCO sign-off. Mimic's repository content is licensed under [Apache License 2.0](LICENSE), subject to the noted terms for third-party material; a separately owned Design Package does not automatically inherit this repository's license.
