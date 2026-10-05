# Initial specification checks

Use Node.js `24.21.0` and pnpm `12.9.1`. From the repository root, run the same commands as the pull request workflow:

```sh
pnpm install --frozen-lockfile
pnpm run check:ci
```

`check:ci` runs focused validator tests, Prettier and Markdown lint for repository documentation and JSON, then the artifact schema and fixture check. The workflow runs for every pull request with read-only repository permission and no secrets.

Artifact schemas belong under `schemas/artifacts/**` and must end in `.schema.json` and declare JSON Schema 2020-12. The entrypoint is `schemas/artifacts/artifact.schema.json`; supporting schemas such as `common.schema.json` and `types/*.schema.json` are compiled too. The checker loads them by `$id` and checks all JSON files in `fixtures/artifacts/valid/` and `fixtures/artifacts/invalid/` against the entrypoint. Each folder needs at least one JSON fixture once schemas exist. Unpaired fixture JSON fails. YAML fixtures are outside this initial JSON check.

Until those artifact files land, the checker prints `NO_SCHEMA_INPUTS`. That result means artifact coverage is pending; the focused validator tests still exercise both passing and failing fixtures. The broader monorepo and full CI remain in 9UI-96 and 9UI-120.
