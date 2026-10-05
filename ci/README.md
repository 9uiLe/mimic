# Pull request validation

Use Node.js `24.21.0` and pnpm `12.9.1`. From the repository root, run the same commands as the pull request workflow:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm exec playwright install chromium
pnpm run test:browser
node apps/cli/dist/main.js
```

The pull request workflow keeps the original documentation and artifact schema job, which runs `check:ci`. A bootstrap job runs `check` (format, lint, typecheck, validation, build, Vitest, and `check:ci`), installs Chromium with Linux system dependencies, runs the Playwright/axe smoke, and asserts the built CLI startup output. Both jobs use the pinned Node and pnpm versions, read-only repository permission, and no secrets.

Artifact schemas belong under `schemas/artifacts/**` and must end in `.schema.json` and declare JSON Schema 2020-12. The entrypoint is `schemas/artifacts/artifact.schema.json`; supporting schemas such as `common.schema.json` and `types/*.schema.json` are compiled too. The checker loads them by `$id` and checks all JSON files in `fixtures/artifacts/valid/` and `fixtures/artifacts/invalid/` against the entrypoint. Each folder needs at least one JSON fixture once schemas exist. Unpaired fixture JSON fails. YAML fixtures are outside this initial JSON check.

`check:ci` remains the initial JSON specification check. Native YAML fixture validation is included in `pnpm validate` through the bootstrap job. The full pre-release CI and security rollout remain in 9UI-120.
