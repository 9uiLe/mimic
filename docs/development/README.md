# Development

Use Node.js `24.21.0` and pnpm `12.9.1`. The Dev Container pins Node `24.21.0`, installs the exact pnpm release, and provisions Chromium with its Linux system dependencies through `playwright install --with-deps chromium`. Its setup command runs as the container image’s root user so the browser dependency packages can be installed. A local setup must use the pinned Node release from `.node-version`; check `node --version` before installing. Run `pnpm install --frozen-lockfile` at the repository root. The root lockfile is authoritative, and all direct dependencies use exact versions. The pnpm supply-chain defaults enforce a 1440-minute release age and block exotic subdependencies and undeclared build scripts. `esbuild` is the sole explicit build-script allowlist entry because Vite and Vitest require its binary installation check. Review that exception with lockfile changes.

| Command             | Purpose                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`          | Run the vanilla Vite demo lab for local preview only.                                                              |
| `pnpm build`        | Build the core package, CLI, then demo lab. Output is ignored.                                                     |
| `pnpm format`       | Apply Prettier to bootstrap owned sources.                                                                         |
| `pnpm format:check` | Check formatting without writes.                                                                                   |
| `pnpm lint`         | Run ESLint, Stylelint, html-validate, and markdownlint.                                                            |
| `pnpm typecheck`    | Check all TypeScript projects without emitting.                                                                    |
| `pnpm validate`     | Check JSON schemas/fixtures and native YAML fixtures.                                                              |
| `pnpm test`         | Run Vitest unit tests.                                                                                             |
| `pnpm test:browser` | Run Playwright and axe across configured Chromium, Firefox, and WebKit desktop/mobile emulations.                  |
| `pnpm check`        | Non-mutating local gate: formatting, lint, typecheck, validation, build, unit tests, and the preserved `check:ci`. |

The pull request workflows preserve the initial specification checks and run stable `quality`, `unit`, `browser`, and `dco` jobs. The PR browser job covers Chromium desktop and mobile emulation; the separate Firefox/WebKit matrix runs on PRs, after merge, or on schedule. Run `pnpm exec playwright install chromium firefox webkit` before the full local browser check. The [CI guide](../../ci/README.md) describes commands, the Dev Container verification job, and settings that need separate owner action. Automated axe findings do not prove WCAG compliance.

`packages/core` exposes a public ESM entry point; `apps/cli` consumes it using a workspace dependency. Run `node apps/cli/dist/main.js` after a build for an ESM smoke test. `apps/demo-lab` is a vanilla Vite preview, not a prototype export pipeline. Durable artifact behavior is not implemented by these bootstrap entry points.

`node_modules`, `dist`, Vite caches, coverage, Playwright reports/results, and TypeScript build metadata are ignored. Canonical schemas, fixtures, and source files remain tracked. The YAML check parses one mapping, rejects duplicate or non-string mapping keys and non-JSON values, and validates against the same artifact schema as JSON. Cross-document registry constraints and evidence quality remain future runtime work.
