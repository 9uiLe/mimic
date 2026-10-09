# CI validation and security configuration

Use Node.js `24.21.0` and pnpm `12.9.1`. Install with `pnpm install --frozen-lockfile`. The root `pnpm-workspace.yaml` keeps the 1440-minute release age, exotic subdependency block, strict dependency build policy, and the sole `esbuild` build allowance. Review lockfile and build-policy changes together.

## Pull request checks

`pre-release.yml` checks the exact pull request head SHA with read-only repository permission and checkout credentials disabled. Its stable job names are:

| Job       | Command and guarantee                                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality` | `pnpm check:quality`: non-mutating formatting, all configured linters and type checks, JSON Schema and YAML fixtures, build, the preserved `check:ci` regression suite, and DCO checker tests. The built CLI must print the expected startup JSON. |
| `unit`    | `pnpm test`: Vitest unit tests.                                                                                                                                                                                                                    |
| `browser` | Playwright Chromium desktop and Pixel 7 mobile emulation, in parallel jobs whose results must both pass. The demo flow asserts interaction and runs axe.                                                                                           |
| `dco`     | Every commit after the PR head/base merge base must contain a valid `Signed-off-by` trailer matching its author. Missing, malformed, or mismatched trailers fail.                                                                                  |

The stable jobs always report on every PR. `scripts/select-ci.mjs` compares the complete PR base and head trees without rename detection and records its scope in the Actions summary:

| Changed paths, all within one row                                   | `quality`   | `unit`                | `browser`                 |
| ------------------------------------------------------------------- | ----------- | --------------------- | ------------------------- |
| `README.md`, `ci/README.md`, or `docs/{dogfood,onboarding}/**/*.md` | docs/schema | CI/schema tests       | no browser impact         |
| `apps/demo-lab/{src,public,tests}/**`                               | full        | Demo Lab catalog test | Chrome desktop and mobile |
| `apps/cli/{src,tests}/**`                                           | full        | full                  | no Demo Lab impact        |
| `packages/core/src/**`                                              | full        | full                  | Chrome desktop and mobile |
| Mixed paths, config, lockfile, workflow, other                      | full        | full                  | Chrome desktop and mobile |

`docs/development/**` and `docs/specifications/**` select full checks because the CLI Skill reads them at runtime. An empty diff, unavailable base/head, or unknown path also selects full checks. The selector has example-based tests in `pnpm test:ci`. A browser check with no affected browser path records the reason; it does not hide a browser failure. A new PR head cancels only older runs for that PR in each workflow. DCO and CodeQL still run on the current PR head.

`spec-validation.yml` still runs `Documentation and artifact schemas` and `Bootstrap quality, unit, browser and CLI`. Its bootstrap quality/unit/CLI and Chrome browser suites run in parallel; their original aggregate check passes only if both pass. `devcontainer-verification.yml` likewise runs its full quality/unit/CLI and Chrome browser checks in parallel inside separate instances of the same Dev Container. Markdown-only changes do not build those runtimes. No workflow file alone makes a job required at merge.

Run equivalent local gates with:

```sh
pnpm install --frozen-lockfile
pnpm run check:quality
pnpm run test
pnpm run check
node scripts/chrome-for-testing.mjs
pnpm run test:browser --project=chromium-desktop --project=chromium-mobile
node apps/cli/dist/main.js
```

CI targets Chrome/Chromium only. Firefox and WebKit compatibility is not established by these checks. The mobile project is browser emulation on hosted Linux, not a physical device test. Automated axe checks do not establish full WCAG conformance.

`devcontainer-verification.yml` uses the [official Dev Container CI action](https://github.com/devcontainers/ci/blob/main/docs/github-action.md) to build and start the repository's `.devcontainer/devcontainer.json` on hosted Linux, execute its `postCreateCommand`, then run `ci/devcontainer-smoke.sh quality` and `browser` in separate containers. Together they check Node and pnpm versions, frozen install, the canonical quality/unit gate, both PR Chrome projects, and built CLI startup. No job pushes an image or logs into a registry. Results must come from an actual hosted run; workflow files alone do not prove the environment works.

Artifact schemas belong under `schemas/artifacts/**`, end in `.schema.json`, and declare JSON Schema 2020-12. The entrypoint is `schemas/artifacts/artifact.schema.json`; supporting schemas are compiled by `$id`. The checker loads every paired JSON fixture from `fixtures/artifacts/valid/` and `fixtures/artifacts/invalid/`. Native YAML fixture validation runs through `pnpm validate`, including rejection of duplicate or non-string mapping keys.

## Security rollout boundary

`.github/dependabot.yml` requests weekly npm workspace and GitHub Actions update PRs. This file does not enable Dependabot alerts or security updates, which are separate repository features.

`codeql.yml` analyzes JavaScript and TypeScript on PRs, pushes to `main`, and weekly. Its analysis job alone has the approved `security-events: write` upload permission. CodeQL default setup was `not-configured` when checked through the GitHub API before this workflow was added. Do not enable default and advanced setup together without rechecking the state.

Repository rulesets, branch protection, Dependabot alerts/security updates, and secret scanning with push protection are settings checks outside this file change. Unknown settings remain unknown until verified by an authorized owner. The four new job names are candidates for required checks once the existing required-check set is migrated without dropping coverage.
