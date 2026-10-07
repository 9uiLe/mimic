# Development

Use Node.js `24.21.0` and pnpm `12.9.1`. The Dev Container pins Node `24.21.0`, installs the exact pnpm release, and provisions Chromium with its Linux system dependencies through `playwright install --with-deps chromium`. Its setup command runs as the container image’s root user so the browser dependency packages can be installed. A local setup must use the pinned Node release from `.node-version`; check `node --version` before installing. Run `pnpm install --frozen-lockfile` at the repository root. The root lockfile is authoritative, and all direct dependencies use exact versions. The pnpm supply-chain defaults enforce a 1440-minute release age and block exotic subdependencies and undeclared build scripts. `esbuild` is the sole explicit build-script allowlist entry because Vite and Vitest require its binary installation check. Review that exception with lockfile changes.

| Command             | Purpose                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm dev`          | Run the vanilla Vite demo lab for local preview only.                                             |
| `pnpm build`        | Build the core package, CLI, then demo lab. Output is ignored.                                    |
| `pnpm format`       | Apply Prettier to bootstrap owned sources.                                                        |
| `pnpm format:check` | Check formatting without writes.                                                                  |
| `pnpm lint`         | Run ESLint, Stylelint, html-validate, and markdownlint.                                           |
| `pnpm typecheck`    | Check all TypeScript projects without emitting.                                                   |
| `pnpm validate`     | Check JSON schemas/fixtures and native YAML fixtures.                                             |
| `pnpm test`         | Run Vitest unit tests.                                                                            |
| `pnpm test:browser` | Run Playwright and axe across configured Chromium, Firefox, and WebKit desktop/mobile emulations. |
| `pnpm check`        | Non-mutating local gate: quality checks, DCO checker tests, and Vitest unit tests.                |

The pull request workflows preserve the initial specification checks and run stable `quality`, `unit`, `browser`, and `dco` jobs. The PR browser job covers Chromium desktop and mobile emulation; the separate Firefox/WebKit matrix runs on PRs, after merge, or on schedule. Run `pnpm exec playwright install chromium firefox webkit` before the full local browser check. The [CI guide](../../ci/README.md) describes commands, the Dev Container verification job, and settings that need separate owner action. Automated axe findings do not prove WCAG compliance.

## Runtime and CLI guide

`packages/core` exposes the public `@mimic/core` ESM entry point; `apps/cli` consumes it through a workspace dependency and exposes the `mimic` binary. Run `node apps/cli/dist/main.js` after a build for an ESM startup smoke test. `apps/demo-lab` is a vanilla Vite preview, not a Design Package export pipeline.

| Concern                      | Current boundary and detailed guide                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact and schema registry | [Artifact store](artifact-store.md): explicit schema loading, canonicalization and digests, append-only snapshots, exact dependencies, and verified readback.                                                                                     |
| Deterministic engines        | [Runtime engines](runtime-engines.md): dependency and freshness assessment, provenance, policy evaluation, revision guards, and audit; these do not publish canonical selections.                                                                 |
| Package lookup and locks     | [Package registry](package-registry.md): exact version resolution, design locks, and promotion checks; it does not release packages.                                                                                                              |
| Package compilation          | [Package compiler](package-compiler.md): exact inventory, quality evidence, Reference/Portable closure, and immutable publication to a trusted local root.                                                                                        |
| Prototype generation         | [Token compiler](token-compiler.md), [Prototype Builder](prototype-builder.md), and [Current/Proposed modes](prototype-modes.md): approved token inputs, framework-neutral output, and exact mode comparisons.                                    |
| Prototype review             | [Demo Lab](demo-lab.md) and [quality gates](quality-gates.md): local Vite preview and separate static/browser inspection of generated output.                                                                                                     |
| Runs and decisions           | [Run registry](run-registry.md): provisional work, Decision Packets and Records, Human Commit Points, and atomic publication through shared workspace storage.                                                                                    |
| Orchestrator                 | [Orchestrator](orchestrator.md): Skill routing and governed authority around the store and Run registry.                                                                                                                                          |
| AI-facing CLI                | [CLI and filesystem protocol](cli.md): compact commands, workspace files, exit behavior, local confirmation, and optional signed receipts. [Skill self-documentation](skill-bootstrap.md) is read-only and works before workspace initialization. |
| Static Skills                | [Skill package contract](skill-package.md) and [Skill runtime](skill-runtime.md): declarative manifests and a trusted injected executor; reasoning prose never grants runtime permissions.                                                        |

The [M1 refactoring checkpoint](m1-refactoring-review.md) records the repository-wide boundary review and validation. The [technical baseline](../specifications/technical-baseline.md) remains the architectural reference. [AGENTS.md](../../AGENTS.md) and the [Linear dashboard protocol](linear-dashboard-protocol.md) govern contributor work, not runtime Skill authority.

`node_modules`, `dist`, Vite caches, coverage, Playwright reports/results, and TypeScript build metadata are ignored. Canonical schemas, fixtures, and source files remain tracked. The YAML check parses one mapping, rejects duplicate or non-string mapping keys and non-JSON values, and validates against the same artifact schema as JSON. Runtime admission and publication enforce exact references and authority; schema validation alone does not establish evidence quality.
