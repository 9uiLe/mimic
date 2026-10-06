# M2 reasoning and knowledge refactoring checkpoint

This is the 9UI-133 investigation and bounded correction at baseline `d1ac82660d1b1b405e8e6d82d2922ca029c329c7`, which matched `origin/main` when work began. The assigned branch is `ai/9UI-133-m2-refactor-checkpoint`. Linear confirmed 9UI-104, 9UI-107, 9UI-108, and 9UI-109 Done before this review. The pre-edit inventory, decisions, and check outcomes were also recorded on [9UI-133](https://linear.app/9uile/issue/9UI-133/audit-and-refactor-the-m2-reasoningknowledge-baseline-without-behavior).

The initial exclusive tracked write set was this report. After comparing the six areas below, the coordinator assigned four further exact paths for factual text corrections: `skills/README.md`, `docs/development/skill-package.md`, `docs/development/skill-runtime.md`, and only the top descriptive comment in `packages/core/src/design-knowledge/index.ts`. Concurrent 9UI-110 owns `packages/core/src/token-compiler/**`, the Core index export, and its compiler fixtures and guide. Those paths, runtime logic, schemas, CI, configuration, lockfiles, S13 contracts, and root onboarding are read only for this task. No other worktree or `main` file is edited.

## Sources and ownership

The [reasoning Skill contract](../specifications/reasoning-skill-contracts.md) owns S01–S18 semantics and exact artifact I/O. The [design-space specification](../specifications/design-space-exploration.md) owns graph traversal, roles, and transfer limits. The [artifact architecture](../specifications/artifact-architecture.md) owns v1 file shape, provenance, revisions, and approval envelopes; the [Run contract](../specifications/orchestrator-runs.md) owns routing and Human Commit Points. The [technical baseline](../specifications/technical-baseline.md) defines repository and security boundaries. The [static package](skill-package.md), [runtime](skill-runtime.md), [seed knowledge](seed-knowledge.md), and [skill-family guides](README.md) explain the present implementation. [AGENTS.md](../../AGENTS.md) and the [Linear dashboard protocol](linear-dashboard-protocol.md) govern contributors, not runtime reasoning Skills. There is no repository `.agents/skills` directory at this baseline.

The inventory spans the workspace rather than only the changed files:

| Surface                  | Baseline evidence                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static Skills            | `skills/s01-*` through `skills/s18-*` contain 18 manifests, 18 `SKILL.md` files, examples, and scenario data. Contract fixtures under `fixtures/skills` are separate illustrative packages.                                                                                                                                                                                                        |
| Runtime and consumers    | `packages/core/src/skill-runtime/index.ts` loads package data and runs a trusted injected executor through the Orchestrator. `packages/core/src/orchestrator` and artifact/Run registries enforce exact locks and authority. `apps/cli/src/skill/index.ts` discovers manifests for read-only self-documentation.                                                                                   |
| Knowledge and provenance | `packages/core/src/design-knowledge/index.ts` supplies pure graph types, validation, and retrieval. `knowledge/seed/graph.json` has 56 nodes and 56 edges; `spaces.json` has eight reference spaces; `sources.json` has 16 observation or transfer-hypothesis ledger entries. `research-review.md` records the source review. All nodes are provisional; citation does not prove transfer fitness. |
| Schemas and fixtures     | `schemas` contains 19 JSON schemas: 16 artifact type schemas, the artifact wrapper and common schemas, and the static Skill package schema. Artifact validation covers the 18 artifact schemas with 17 valid and six invalid JSON fixtures, plus native YAML coverage. Package manifests reference their own examples and tests.                                                                   |
| Tests and workflows      | `vitest.config.mjs` discovers 21 files and 200 tests through `packages/**/*.test.ts`, CLI tests, and the YAML test. The six `skill-catalog-tests` files cover S01–S18 and seed knowledge with deterministic fixtures. `playwright.config.mjs` defines Chromium desktop/mobile, Firefox desktop, and WebKit desktop/mobile. CI has separate quality, unit, browser, matrix, and DCO checks.         |
| Guidance and settings    | `docs/specifications` is the semantic reference; `docs/development` gives operational detail. `skills/README.md` still describes the bootstrap before static packages existed. `pnpm-workspace.yaml`, pinned Node/pnpm, lockfile policy, GitHub workflows, and `AGENTS.md` have separate build, security, and contributor roles.                                                                   |

## Six-area comparison before implementation

### 1. Directory structure

**Current evidence.** The 18 static packages, schema registry, Core runtime, CLI, fixtures, seed corpus, and focused guides live in distinct roots consistent with the technical baseline. The `skillId` is stable independently of its package directory, but manifests and CLI discovery refer to package paths. Tests and docs also refer to exact paths.

**Alternatives and trade-offs.** Keeping the layout preserves path references. Consolidating Skill families or moving the knowledge corpus might shorten navigation, but would require manifest references, loader paths, imports/exports, TypeScript/workspace configuration, fixtures, test discovery, scripts, CI globs, and links to move in lockstep. No demonstrated misplaced responsibility offsets that risk. **Decision: no path move.** Moved-path mapping is empty.

### 2. Documentation

**Current evidence.** `skills/README.md` says no Skill implementation exists, though all 18 static packages and their scenario bridges are present. The static package guide's S01/S04 fixture sentence is accurate about those fixtures but can be mistaken for the current catalog. The runtime guide correctly says the runtime does not implement reasoning, yet omits the available static packages. The top comment of `design-knowledge/index.ts` correctly separates code from the seed library but can state where the corpus now lives. The family guides and seed guide already supply detailed context.

**Alternatives and trade-offs.** Leave the confusing bootstrap wording, copy all family details into an overview, or correct only the affected navigation and responsibility statements. Copying contracts creates divergent sources. **Decision: small factual text change** in the four assigned paths, linking the catalog and guides while retaining the distinction between static packages, injected executor, graph helper, and separate seed data. No specification or root onboarding rewrite.

### 3. Implementation

**Current evidence.** The package loader validates manifest shape and file containment; the Orchestrator routes exact references and authority; the artifact store verifies snapshots and digests; the graph helper validates and deterministically orders candidates. Public Core exports and the built CLI are already separate. The test bridge's deterministic executor exercises contracts with synthetic inputs and does not constitute a live reasoning provider.

**Alternatives and trade-offs.** An extraction or shared facade could reduce some repeated test setup, but would blur authority and require new characterization of state, ordering, and errors. The observed problem is descriptive, not a demonstrated runtime defect. **Decision: no logic, exports, or dependency change.** The one source edit is a top comment.

### 4. Tests

**Current evidence.** Family suites consume package scenario and negative files, compare exact locks and provisional outputs, and check blockers, approval boundaries, and specific S01–S18 duties. Seed tests cover graph links, ledger linkage, eight spaces, and representative retrieval. Package tests check schema and safe paths; CLI tests exercise discovery. Unit, schema/CI, DCO, and browser checks have different discovery paths. These are contract and fixture checks, not empirical AI quality or full accessibility evidence.

**Alternatives and trade-offs.** Keep all cases or consolidate suites/fixtures. Consolidation would add moved references and risk narrowing discovery or losing assertions without improving the reviewed text. **Decision: no test or fixture change.** Every original file, scenario, assertion, threshold, and CI check remains; the before/after discovery count must stay 21 files and 200 tests.

### 5. Architecture

**Current evidence.** Skills receive exact Orchestrator-mediated context and return artifact references; storage computes canonical digests; the Orchestrator and Run registry guard proposals and human decisions. Design knowledge retrieval is a pure local helper, while the seed corpus and evidence ledger remain data. S13's visual-system and token contracts are separate from 9UI-110's deterministic compiler. Schema shape alone cannot establish evidence truth or approval.

**Alternatives and trade-offs.** Combining retrieval, Skill execution, and canonical state could simplify call sites but would introduce new authority and state semantics. A new schema or knowledge promotion policy requires its own review. **Decision: no architecture change.** Preserve exact revision locks, scope, provenance, approved-snapshot immutability, and Human Commit Points.

### 6. AI skills and settings

**Current evidence.** The S01–S18 `SKILL.md` instructions and manifests declare task reasoning, inputs, outputs, forbidden duties, and human gates. `AGENTS.md` is a contributor workflow instruction, and toolchain/CI files are build and security settings. Runtime code does not sandbox a trusted injected executor. Static package presence and synthetic tests do not prove live model quality, source truth, or a new permission boundary.

**Alternatives and trade-offs.** Reword prompts or adjust manifests/settings to reduce apparent duplication, or leave them. Such edits can change reasoning, required inputs, permission expectations, or security checks; they need separate explicit evaluation. **Decision: no prompt, manifest, policy, tool permission, dependency, or setting change.** The catalog overview correction grants no new authority.

Taken together, only the descriptive navigation has a demonstrated safe correction. No cross-area finding justifies a broad refactor.

## Preserved observable invariants

The bounded change does not touch executable statements, schema data, package manifests, examples, tests, fixtures, CI, or lockfiles. Preserve:

- Public `@mimic/core` exports, CLI ESM/bin entry points, flags, stdout JSON, stderr/error text and exit codes, and read-only Skill discovery.
- Required and optional Skill inputs, alternative bindings, possible outputs, forbidden responsibilities, human-gate metadata, exact locks, and blocked zero-output behavior.
- v1 artifact and manifest shapes, on-disk snapshots, canonical byte/digest computation, dependency ordering, exact version selection, immutable approved revisions, and provenance qualification.
- Run state precedence, transitions, retry/idempotency behavior, proposal/rejection history, Human Commit Point publication, scope ancestry, and security/approval boundaries.
- Test and browser discovery, all scenarios, assertions, fixtures, thresholds, and CI enforcement. Unsupported or untested empirical and accessibility claims remain `UNVERIFIED`.

## Validation record

All local commands use Node `24.21.0` and pnpm `12.9.1`; the shell default was Node `25.2.1`. `pnpm install --frozen-lockfile` passed using 318 cached packages without changing the lockfile. The baseline browser setup command was `pnpm exec playwright install chromium firefox webkit`.

| Check                         | Before text edit at `d1ac826`                                                                                                                               | After text edit                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Targeted docs/Skill checks    | Baseline `check:docs` passed 61 Markdown files; unchanged S16–S18 rerun passed 8/8 after timeout.                                                           | `check:docs` passed 62 Markdown files; package and catalog suites passed 7 files/68 tests.    |
| `pnpm exec vitest list`       | 21 files, 200 tests.                                                                                                                                        | Same 21 files, 200 tests.                                                                     |
| `pnpm check`                  | Quality, build, schema/CI, and DCO stages passed; Vitest 20 files/199 tests passed, one unchanged S16 scenario timed out at five seconds; command exited 1. | Passed: quality/build/schema/CI/DCO and 21 Vitest files/200 tests.                            |
| Built CLI startup             | `node apps/cli/dist/main.js` returned `{"name":"mimic","state":"ready"}` with exit 0.                                                                       | Same JSON and exit 0.                                                                         |
| `pnpm test:browser`           | Chromium desktop/mobile and WebKit desktop/mobile passed. Firefox desktop stalled; run interrupted with exit 130 after four passed and one unfinished.      | Same four projects passed; Firefox desktop stalled and the run was interrupted with exit 130. |
| Tracked paths and moved files | Clean assigned branch; five approved paths only, no path move.                                                                                              | Only the five approved paths changed; no test or source path moved.                           |
| Hosted exact-head checks      | No PR yet.                                                                                                                                                  | Tracked on the primary draft PR and 9UI-133 after push.                                       |

The baseline Vitest timeout is a failed full check, even though the unchanged targeted rerun passed. The local Firefox result is interrupted, not passed. Hosted checks on the actual final PR head are required before readiness; the parent owns independent review, merge, and final Linear coordination.
