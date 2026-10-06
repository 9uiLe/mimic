# Prototype Builder

`@mimic/core` exports `buildPrototype(store, input, outputRoot)`. It emits a specification prototype as semantic HTML, plain CSS, and ES JavaScript. The output is framework-neutral and does not use the Demo Lab or Vite. It is **not a production app**. Fixture data is synthetic; browser observations validate the generated prototype, not a real user's outcome or full WCAG conformance.

## Input boundary

The canonical v1 `scenario` has actor, context, prose steps, and expected outcome. It has no raw DOM plan, controls, state content, or interaction mapping; S14 explicitly does not define a composition-plan artifact. The builder therefore takes an authored, non-artifact `PrototypeBuilderInput` separately. It does not infer UI intent from prose, create a new artifact type, or change approved content. The caller retains this input for review and reproduction; the output copies it to `plan.json` and records its canonical SHA-256 digest in `manifest.json`.

The input declares:

- Exact scenario, pattern, layout, component, responsive-rule, accessibility-rule, and DTCG token source references (`artifactId`, `revision`, `lockDigest`). Selected assets and token sources must occur in the scenario's exact dependencies. Scenario provenance must link every selected asset and explain Task → Pattern → Layout → Components.
- One authored semantic node tree per required state. State names are limited to loading, empty, partial, success, error, permission, and disabled. Success is required; the caller declares other applicable states and an initial state. A button may only transition to a declared state. Links may only target a local fragment. Raw HTML, scripts, arbitrary event handlers, external URLs, and unknown elements are rejected.
- Synthetic fixture values keyed by state and field. They are inserted as escaped text, never as HTML. The plan declares desktop and mobile columns, a breakpoint, and approved compiled color token paths. Unsupported structure returns `UPSTREAM_REVISION_REQUIRED` with a specific revision request.
- A relative output directory inside an explicit root. Parent traversal, absolute paths, symlink directories, and existing output files are rejected.

`ArtifactStore.read` verifies the schema, digest, dependencies, and configured human authority. The builder additionally requires every referenced snapshot to be approved and fresh, checks exact locks and kinds, and calls `compileApprovedTokenAssets` for CSS variables and exact token provenance. An approved scenario does **not** cryptographically approve a later supplied render plan. `plan.json` and its digest make that separate input reviewable; `manifest.json` must not be interpreted as human approval of the rendered structure.

## Output and checks

The builder writes `index.html`, `prototype.css`, `prototype.js`, `plan.json`, and `manifest.json`. The manifest records exact source locks, token path provenance, required states, a synthetic fixture marker, and `productionReady: false`. The emitted JS only switches declared states; it does not evaluate caller code or call external services. Identical input and locked artifacts produce identical bytes in a fresh output directory.

The test fixture at `fixtures/prototypes/approved.ts` creates explicitly conforming approved snapshots with a fixture authority verifier. It is not an S13 output or a production approval record. `packages/core/src/prototype-builder/prototype-builder.test.ts` covers compilation, provenance, determinism, input isolation, lock and structure failures, escaping, URL rejection, and path containment. `apps/demo-lab/tests/prototype-builder.spec.ts` serves the _generated_ output over a local HTTP server and checks desktop and mobile layout, state transitions including repeated interactions, and automated axe results. It does not substitute Demo Lab smoke coverage for generated prototype verification.
