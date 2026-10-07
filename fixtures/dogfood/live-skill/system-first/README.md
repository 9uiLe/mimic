# Riverbend live Skill run evidence

Read the [dogfood report](../../../../docs/development/live-skill-dogfood.md) for scope, results, corrections, and limits. `input-packet.json` is the sole sanitized case source. `tasks.json` is the corrected route. `work/*.json` contains the controlling AI's submitted answers and exact output references. `attempts/initial` preserves the first route and failed validation attempt; `attempts/corrected` preserves the second route that reused the same authored S04/S01/S02 content; `attempts/provenance-corrected` preserves the third route; `attempts/final` contains the reviewed S05 wording and complete CLI logs, raw output files, and readback. `packages.json`, `results.json`, and `revision-request-repro.json` index the exact evidence.

Replay of these files tests only deterministic CLI behavior. It cannot reproduce or prove the controlling AI's semantic judgment.
