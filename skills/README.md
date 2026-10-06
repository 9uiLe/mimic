# Skills

This directory contains the S01–S18 static reasoning Skill packages. Each package has a manifest, `SKILL.md`, illustrative examples, and scenario data. [The catalog contract](../docs/specifications/reasoning-skill-contracts.md) defines their semantic inputs, outputs, and forbidden responsibilities; [the development guides](../docs/development/README.md) describe the package format and test bridges.

Skills exchange artifacts through the Orchestrator; they do not import or invoke one another. The deterministic test executors check package and runtime boundaries with synthetic inputs. They do not establish live AI reasoning quality or empirical design outcomes.
