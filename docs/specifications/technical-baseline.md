# Mimic v1 technical baseline

Status: architecture specification for [9UI-94](https://linear.app/9uile/issue/9UI-94/specify-technical-stack-repository-layout-and-development-environment). Implementation belongs to the [monorepo bootstrap](https://linear.app/9uile/issue/9UI-96/bootstrap-the-pnpmtypescript-monorepo-and-development-toolchain), [initial-specification CI](https://linear.app/9uile/issue/9UI-131/bootstrap-minimal-ci-for-initial-specification-prs), and [full CI and supply-chain setup](https://linear.app/9uile/issue/9UI-120/set-up-pre-release-ci-security-scanning-and-supply-chain-safeguards). The [v1 architecture and operating reference](https://linear.app/9uile/document/mimic-v1-architecture-and-operating-reference-4b4a6ddcb408) governs product and operating boundaries.

## Purpose and boundaries

Mimic is a model-independent, AI-operated product design engine. It produces versioned Design Packages, not production applications or framework conversions. A package contains machine-readable design decisions, design-system usage, an executable prototype, scenarios, system requirements, validation evidence, and decision history. The canonical prototype is semantic HTML, plain CSS, and ES JavaScript. It must be inspectable and runnable without requiring a production UI framework.

The interaction path is human → controlling AI agent → Mimic CLI and filesystem protocol. MCP may be an adapter, but is not required by Core. Large artifacts remain in files; command stdout returns compact IDs, paths, status, and next actions. Skills exchange artifacts through the orchestrator rather than calling one another. Reasoning and proposals stay separate from deterministic runtime, schema validation, token transformation, and prototype builders.

Workspaces are mutable, but approved or locked artifacts are immutable in place even before release. Revisions are proposed, reviewed, and versioned. A release snapshots an approved Design Package as an immutable, versioned artifact; later changes produce a new version rather than editing released bytes. Git is the initial history store. Registry and storage access stay behind abstract interfaces so the initial filesystem/Git implementation does not become the package contract. Human approval gates durable decisions and release; provisional exploration can continue independently.

## Stack

| Concern | v1 baseline | Boundary |
| --- | --- | --- |
| Runtime | Node.js 24 LTS | CLI, builders, validators, and development tools |
| Language and modules | TypeScript 6, ESM, `NodeNext` module and resolution settings | Internal runtime and package code; emit and imports must work under Node ESM |
| Repository | pnpm workspace monorepo | One root lockfile; no Nx or Turborepo initially |
| Prototype | Semantic HTML, plain CSS, ES JavaScript | Canonical deliverable, independent of Vite and any app framework |
| Demo lab | Vite vanilla | Local preview and demonstrations only; its bundling is not a Design Package requirement |
| Artifact contracts | JSON Schema 2020-12 with Ajv | Schemas validate canonical machine-readable artifacts, primarily YAML data parsed as data |
| Design tokens | DTCG tokens compiled to CSS custom properties | Preserve source token semantics and references; generated CSS is a derived output |
| Formatting | Prettier | Repository formatting contract |
| Static checks | ESLint with typescript-eslint, Stylelint, html-validate, markdownlint-cli2 | Check the relevant source and prototype file types |
| Tests | Vitest, Playwright, axe-core | Unit and browser checks, including automated accessibility checks |
| Development environment | Dev Container | Canonical reproducible development environment; local installs use the same pinned tools |

React, Tailwind, Sass, Nx, and Turborepo are not canonical dependencies. The demo lab must not impose Vite conventions on emitted prototypes. Accessibility targets WCAG 2.2 AA; axe results are evidence for automated rules, not a claim of full conformance.

## Repository and package boundaries

The workspace layout to bootstrap is:

```text
apps/                 CLI entry point and vanilla Vite demo lab
packages/             Reusable Core, artifact, validation, token, and prototype code
skills/               Skill definitions and contracts; artifact exchange only
schemas/              Versioned canonical artifact JSON Schemas
  artifacts/
knowledge/            Curated design knowledge and reference material
docs/
  specifications/     Architectural and artifact specifications
  development/        Contributor and environment instructions
fixtures/
  artifacts/          Contract examples and test fixtures
```

These are responsibility boundaries, not prescribed package names or an instruction to create empty packages. `apps` compose packages and expose commands or preview surfaces; reusable domain behavior belongs in `packages`. `schemas/artifacts` is the source of truth for artifact structure and versioning. `fixtures/artifacts` exercises those contracts and records representative inputs/outputs. `skills` describe AI-facing tasks and artifact contracts; they do not import or invoke one another. `knowledge` is curated input, not generated run output. `docs/specifications` holds stable contracts; `docs/development` explains how contributors run them.

Use explicit workspace dependencies and public package entry points. Avoid cross-package source imports and hidden dependence on the demo lab. Keep domain types aligned with versioned artifact schemas; validation at file and package boundaries is mandatory even if TypeScript types compile. A Design Package's files, schema versions, dependency versions, and lock data must be sufficient to reproduce its interpretation. Generated previews and temporary runs belong in ignored output locations, not in canonical source directories.

## Standard commands

The bootstrap must expose these root commands through `pnpm <command>` with the same meaning in the Dev Container, local development, and CI:

| Command | Contract |
| --- | --- |
| `dev` | Start the local CLI/demo development workflow without modifying released artifacts. |
| `build` | Build workspace packages and the demo lab in dependency order. |
| `format` | Apply Prettier formatting to owned source files; provide a non-mutating format check for CI. |
| `lint` | Run ESLint, Stylelint, html-validate, and markdownlint-cli2 on applicable files. |
| `typecheck` | Check all TypeScript workspace projects without emitting build artifacts. |
| `validate` | Validate schemas and representative canonical artifact fixtures with Ajv. |
| `test` | Run the applicable Vitest unit suite; browser tests have a distinct CI invocation. |
| `check` | Run the local quality gate: format check, lint, typecheck, validate, build, and unit tests without changing tracked/source files; ignored build and cache output is allowed. |

Scripts must return nonzero on failure and must not silently skip a relevant package. Browser setup and browser checks may use additional named scripts; `test` must not misleadingly claim browser coverage. The exact script wiring and package names are bootstrap work, not established repository behavior today.

## Versions, reproducibility, and generated files

Pin the Node 24 toolchain and pnpm version in repository metadata and the Dev Container. Use an exact `packageManager` version, an engine declaration, and one committed `pnpm-lock.yaml`. Pin direct dependency versions exactly; dependency changes must update the lockfile in the same PR. CI installs with `pnpm install --frozen-lockfile`, then uses the pinned toolchain. Design-system dependencies likewise record exact versions plus lock data, with no automatic upgrades to approved artifacts or released packages.

Prefer vetted releases over newly published dependency versions by configuring pnpm's release-age safeguard when the selected pnpm version supports it. Block dependency lifecycle builds by default and allowlist only reviewed packages that need them. Review lockfile changes and any build allowlist changes together. Keep install scripts, registries, and dependency overrides explicit in versioned configuration. Do not put secrets in repository files or generated output.

Generated code and assets carry a reproducible generator command and source reference. Source schemas, DTCG tokens, and canonical artifact data are edited; generated types, CSS, bundles, previews, caches, and `dist` outputs are regenerated. Ignore disposable generated/cache/build output. If a generated file must be committed for distribution or external tooling, mark it as generated, include its generator version/input, and verify that regeneration leaves the working tree unchanged. Never hand-edit generated output or treat it as the authority over its source.

## CI contract

The [9UI-131 initial-specification CI slice](https://linear.app/9uile/issue/9UI-131/bootstrap-minimal-ci-for-initial-specification-prs) provides scoped documentation, schema, and fixture validation for the first specification PRs. Its checks must actually pass on each current PR head before merge. The later [9UI-120 full pre-release CI baseline](https://linear.app/9uile/issue/9UI-120/set-up-pre-release-ci-security-scanning-and-supply-chain-safeguards) requires four PR checks:

1. **quality:** non-mutating format check, lint, typecheck, schema/fixture validation, and build.
2. **unit:** Vitest.
3. **browser:** Playwright on Chromium desktop and mobile viewports, with axe-core checks on representative prototype flows.
4. **dco:** verify DCO sign-off on commits.

The broader Firefox, WebKit, and mobile browser matrix can run post-merge or on a schedule. Keep tests enabled, and report an absent suite or unimplemented check as not run rather than passed. Use least-privilege GitHub Actions tokens, frozen lockfile installation, and pinned tool versions. The security baseline includes Dependabot alerts and updates, secret scanning with push protection, and CodeQL. External contributors do not gain release or merge authority through CI configuration. The full CI workflow and supply-chain safeguards are implementation work for 9UI-120; 9UI-131 is the initial merge-enabling slice, not a waiver of required checks or completion of the full CI contract. This document defines the target contract, not current enforcement.
