# CI validation and security configuration

Use Node.js `24.21.0` and pnpm `12.9.1`. Install with `pnpm install --frozen-lockfile`. The root `pnpm-workspace.yaml` keeps the 1440-minute release age, exotic subdependency block, strict dependency build policy, and the sole `esbuild` build allowance. Review lockfile and build-policy changes together.

## Pull request checks

`pre-release.yml` checks the exact pull request head SHA with read-only repository permission and checkout credentials disabled. Its stable job names are:

| Job       | Command and guarantee                                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality` | `pnpm check:quality`: non-mutating formatting, all configured linters and type checks, JSON Schema and YAML fixtures, build, the preserved `check:ci` regression suite, and DCO checker tests. The built CLI must print the expected startup JSON. |
| `unit`    | `pnpm test`: Vitest unit tests.                                                                                                                                                                                                                    |
| `browser` | Playwright Chromium desktop and Pixel 7 mobile emulation. The available demo flow asserts interaction and runs axe after it.                                                                                                                       |
| `dco`     | Every commit after the PR head/base merge base must contain a valid `Signed-off-by` trailer matching its author. Missing, malformed, or mismatched trailers fail.                                                                                  |

`spec-validation.yml` still runs `Documentation and artifact schemas` and `Bootstrap quality, unit, browser and CLI`. Keep both during the transition to the four stable checks; required-check migration is a repository setting owned separately. No workflow file alone makes a job required at merge.

Run equivalent local gates with:

```sh
pnpm install --frozen-lockfile
pnpm run check:quality
pnpm run test
pnpm run check
pnpm exec playwright install firefox webkit
node scripts/chrome-for-testing.mjs
pnpm run test:browser
node apps/cli/dist/main.js
```

`browser-matrix.yml` runs Firefox desktop, WebKit desktop, and iPhone 15 WebKit emulation on PRs, after pushes to `main`, weekly, or when manually dispatched. It is a separate, slower workflow from the four stable checks. These are browser/device emulations on hosted Linux, not physical device tests. The PR Chromium mobile project is also emulation. Automated axe checks do not establish full WCAG conformance.

`devcontainer-verification.yml` uses the [official Dev Container CI action](https://github.com/devcontainers/ci/blob/main/docs/github-action.md) to build and start the repository's `.devcontainer/devcontainer.json` on hosted Linux, execute its `postCreateCommand`, then run `ci/devcontainer-smoke.sh` inside the container. The script checks Node and pnpm versions, frozen install, the canonical quality/unit gate, both PR browser projects, and built CLI startup. The job never pushes an image and does not log into a registry. Its result must come from an actual hosted run; the workflow file alone does not prove the environment works.

Artifact schemas belong under `schemas/artifacts/**`, end in `.schema.json`, and declare JSON Schema 2020-12. The entrypoint is `schemas/artifacts/artifact.schema.json`; supporting schemas are compiled by `$id`. The checker loads every paired JSON fixture from `fixtures/artifacts/valid/` and `fixtures/artifacts/invalid/`. Native YAML fixture validation runs through `pnpm validate`, including rejection of duplicate or non-string mapping keys.

## Security rollout boundary

`.github/dependabot.yml` requests weekly npm workspace and GitHub Actions update PRs. This file does not enable Dependabot alerts or security updates, which are separate repository features.

`codeql.yml` analyzes JavaScript and TypeScript on PRs, pushes to `main`, and weekly. Its analysis job alone has the approved `security-events: write` upload permission. CodeQL default setup was `not-configured` when checked through the GitHub API before this workflow was added. Do not enable default and advanced setup together without rechecking the state.

Repository rulesets, branch protection, Dependabot alerts/security updates, and secret scanning with push protection are settings checks outside this file change. Unknown settings remain unknown until verified by an authorized owner. The four new job names are candidates for required checks once the existing required-check set is migrated without dropping coverage.
