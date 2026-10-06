# Static Skill package contract

This document describes the declarative package metadata in [`skill-package.schema.json`](../../schemas/skills/skill-package.schema.json). It implements the static portion of [9UI-136](https://linear.app/9uile/issue/9UI-136/define-static-skill-package-contracts) using the [reasoning Skill semantics](../specifications/reasoning-skill-contracts.md) and [artifact architecture](../specifications/artifact-architecture.md). The [Mimic v1 architecture and operating reference](https://linear.app/9uile/document/mimic-v1-architecture-and-operating-reference-4b4a6ddcb408) remains the product boundary.

## Package layout and versions

A package contains a `manifest.yaml` (JSON is accepted for fixtures), a referenced `SKILL.md`, and referenced example and test files. The manifest identifies a Skill with a stable `skillId` independent of its directory. `manifestVersion` is the shape version of this contract, currently `1.0.0`; it is not an artifact schema version. `packageVersion` versions the package's own contents. It is distinct from an artifact's `meta.revision`, artifact `meta.schemaVersion`, Run ID, and released Design Package version. This slice accepts plain three-part package versions and does not define package acquisition or upgrade behavior.

`supportedArtifactSchemas` lists the artifact type and schema version pairs the package declares. Each artifact input and output must match a declared pair and an existing canonical artifact schema. The current artifact schema version is `1.0.0`. The manifest does not extend the sixteen artifact types. A type name alone does not authorize reading a particular artifact: the Orchestrator must supply an exact applicable reference and verified lock.

## Input and output declarations

`inputs.required` lists inputs necessary for the stated task. `inputs.optional` lists inputs whose absence narrows conclusions and must be reported as a gap. `inputs.alternatives` lists named `oneOf` groups: one suitable member can meet the condition, without pretending that all members are required. Every declaration has a unique name and a `kind`:

| Kind            | Meaning                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `artifact`      | A canonical artifact type and schema version; invocation still requires an exact reference and verified lock.          |
| `human-brief`   | Human supplied intent or direction. It is not an artifact or verified empirical evidence.                              |
| `evidence-file` | A file or source offered for examination. Its presence does not establish authenticity, relevance, or a factual claim. |

The [S01 contract fixture](../../fixtures/skills/valid/s01/manifest.json) declares a human brief **or** an existing product definition for product intent, plus optional task and research inputs. The [S04 YAML contract fixture](../../fixtures/skills/valid/s04/manifest.yaml) declares alternative system sources. These fixtures are illustrative metadata, separate from the [S01–S18 static packages](../../skills/README.md). A package must retain the per-task qualifications, scope, and blockers in the 9UI-90 catalog; metadata does not flatten them into a universal artifact prerequisite list.

`outputs` names possible artifact types, including optional proposals. It is not a promise that every invocation produces them. A wholly blocked invocation may produce none. `forbiddenResponsibilities` records Skill-specific limits in addition to the common prohibition on direct Skill-to-Skill calls and canonical mutation. `humanGates` identifies durable decision categories that remain `PROPOSE_ONLY`, including product definition, brand, domain boundaries, selected direction, system change, organization promotion, and final release. A manifest cannot grant its own authority.

## Static conformance and limits

The [Vitest contract test](../../packages/core/src/skill-package-contract/skill-package.test.ts) compiles the Draft 2020-12 schema with strict Ajv settings. It safely parses JSON and YAML, rejects duplicate YAML mapping keys and non-JSON values, requires nonempty valid and invalid fixture coverage, checks that referenced files are regular files inside the package without symlink traversal, rejects noncanonical path spellings, checks type/version pairs against the canonical artifact schemas, and rejects duplicate or contradictory declarations. Each invalid fixture has one intended defect and a targeted error assertion; repairing that defect makes it valid. The test runs under the existing `packages/**/*.test.ts` Vitest inclusion. `check:schemas` and `check-yaml` currently cover artifacts only; they do not validate Skill packages.

Shape and file checks do not prove approval, digest or lock integrity, provenance or evidence quality, scope ancestry, runtime permission, or a right to change canonical state. The Orchestrator owns context construction and routing; the remaining 9UI-103 work owns the execution harness and boundary enforcement after 9UI-100. This contract defines no invocation/result transport, executable entrypoint, network or tool grant, or canonical-state write. Skills exchange artifacts only through the Orchestrator and cannot approve their outputs, silently replace approved revisions, select canonical directions, or release a package.
