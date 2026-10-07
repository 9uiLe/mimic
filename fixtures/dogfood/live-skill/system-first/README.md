# Riverbend live Skill run evidence

Read the [dogfood report](../../../../docs/development/live-skill-dogfood.md) for scope, results, corrections, and limits. `input-packet.json` is the sole sanitized case source. `tasks.json` is the corrected route. `work/*.json` contains the controlling AI's submitted answers and exact output references. `attempts/initial` preserves the abandoned route and failed validation attempt; `attempts/corrected` contains complete CLI logs, output files preserved byte-for-byte as `.json.raw`, and readback. `packages.json`, `results.json`, and `revision-request-repro.json` index the exact evidence.

Replay of these files tests only deterministic CLI behavior. It cannot reproduce or prove the controlling AI's semantic judgment.
