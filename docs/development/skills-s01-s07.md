# Foundation reasoning Skills S01–S07

Each directory under `skills/s01-product-definition` through `skills/s07-experience-architecture` is a separate static package. `manifest.yaml` declares schema-compatible input alternatives, optional context, outputs, forbidden duties, and human gates. `SKILL.md` supplies domain reasoning. Examples are provisional schema-shaped artifacts; test JSON is scenario and negative data consumed by `packages/core/src/skill-catalog-tests/s01-s07.test.ts`. The test bridge loads packages and uses an injected deterministic executor; it verifies routing, envelope shape, exact locks, and forbidden effects, not model reasoning quality or empirical truth.

| Skill                           | Principal output                 | Distinct boundary                                                                     |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| S01 Product Definition          | `product-definition`             | Human intent and explicit non-goals; product choice is proposed                       |
| S02 User & Task Modeling        | `user-task-model`                | Behavior and tasks, with observed claims separated from hypotheses                    |
| S03 Brand Builder               | `brand`                          | Reuse exact inherited approved brand where applicable                                 |
| S04 System Capability Extractor | `system-capability`              | Current claims require evidence; semantic gaps remain unknown                         |
| S05 UI Contract Manager         | `product-ui-contract`            | Shared System-first and Experience-first convergence; GUI gaps create system requests |
| S06 Product Design Principles   | `design-system-asset` foundation | Product goal and task basis, not screen layout                                        |
| S07 Experience Architecture     | `experience-domain`, `journey`   | Material interaction differences and cross-domain context                             |

The v1 UI Contract schema has no typed current/required/proposed/unresolved buckets. S05 uses the allowed summary and provenance or linked evidence rather than adding unsupported fields. Runtime policy and human commit points govern approval. The example artifacts are illustrative candidates and claim no research.
