# Skill self-documentation

`mimic skill` is a read-only bootstrap interface for a controlling AI. It works before `mimic init`. The bare `mimic` command still emits its original readiness JSON.

| Command                                                      | Compact result                                        | Explicit detail                                      |
| ------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------- |
| `mimic skill`, `skill list`                                  | Installed Skill IDs and source paths                  | `skill show <id>`                                    |
| `skill show <id>`                                            | Validated manifest inputs, outputs, gates, paths      | `--section <heading>` or `--full` reads `SKILL.md`   |
| `skill flow [--mode system-first\|experience-first\|hybrid]` | Entry mode and flow source paths                      | `--full` prints the checked-in flow section          |
| `skill topic <topic>`                                        | Matching documentation file or heading                | `--section <heading>` or `--full`                    |
| `skill artifact <type>`                                      | Schema path and installed producer/consumer Skill IDs | Follow the paths                                     |
| `skill schema <type>`                                        | Canonical schema path and URI                         | `--print` prints the schema                          |
| `skill locate <id>`                                          | Installed Skill, artifact, or topic path              | Follow the path                                      |
| `skill current --run <id>`                                   | Existing Run state, references, proposals, blockers   | Inspect the returned state path through normal tools |
| `skill recommend <intent>`                                   | Up to five deterministic installed-Skill suggestions  | Inspect a suggested Skill                            |

All commands accept `--root <workspace-directory>` and `--json`. The source catalog is discovered from directories under `skills/` containing a manifest, using Core's static package loader and the canonical schemas. A directory without a manifest is not an installed Skill. Malformed packages fail closed. Skill IDs are resolved exactly or by an unambiguous prefix. Unknown, planned, and ambiguous IDs return exit 3. Recommendations compare intent words with installed package names, headings, and output types; they do not invoke a Skill or authorize a decision.

The artifact type list comes from `schemas/artifacts/types/`. Topics resolve existing Markdown files or headings in `docs/specifications/` and `docs/development/`. The full design sequence is in `docs/specifications/design-space-exploration.md`; entry-mode semantics are in `docs/specifications/orchestrator-runs.md`. The CLI keeps only a small mapping from the three modes to their starting context. These sources are linked in compact output, and full bodies require an explicit flag. Explicit bodies are limited to 256,000 source bytes.

`current` reads the existing `.mimic/workspace.json` through `FileWorkspaceStorage.read()` and derives the Run state through Core. It does not initialize a workspace, run a task, write a report, or generate `.mimic/outputs/`. A missing Run returns exit 3. The same CLI exit convention applies: 2 for usage, 3 for invalid or unavailable input, and 6 for I/O or internal failure.
