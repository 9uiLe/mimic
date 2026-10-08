# Demo Lab scenario review

The Demo Lab is a Vite vanilla development surface for inspecting generated specification prototypes. It is not Mimic's final product UI and does not approve a design, change a selected architecture, or write canonical artifacts. The catalog is explicitly synthetic; its project, domain, direction, and scenario labels illustrate the selection workflow rather than record a human design decision. Each entry points to one exact generated scenario and comparison. The direction selector is illustrative metadata, not a model-inferred selection.

## Review flow

Choose a project, Experience Domain, direction / architecture, and scenario. The selectors only offer combinations present in the catalog. Changing an upstream choice selects the first valid dependent choice and removes the prior prototype frame immediately, so a failed or pending load cannot leave stale controls active. The URL records the exact selection, viewport, and requested mode; browser back and forward restore valid combinations. Unknown or stale URL values are replaced with a valid catalog selection. There is no floating “latest” lookup.

Desktop and mobile set a fixed 880 px or 390 px prototype canvas inside a scrollable review surface. When no viewport is specified, a narrow browser starts on the mobile canvas. Current and Proposed read the _same scenario_ from the selected comparison. If the exact decision context rejects a System Request or another mode rule prevents Proposed output, the lab keeps Proposed as the requested mode and visibly displays the generated Current fallback. It never represents Proposed as implemented. The source trail reads exact scenario, contract, request, mode-plan, and render-plan references from the generated comparison and bundle manifests. The generated prototype itself supplies its state labels, System Request notices, and interactions.

The review frame has an opaque sandbox origin with scripts enabled and no parent access. The lab fetches only the committed local catalog paths and inlines the generated CSS and JS into the frame document so state transitions run there. The saved `index.html`, `prototype.css`, and `prototype.js` remain unchanged and can be served together without Vite. “Open standalone prototype” opens that original bundle in a new tab without an opener. Do not put untrusted third-party bundles into this local catalog or serve the lab from a shared origin with sensitive applications.

## Synthetic catalog and regeneration

`apps/demo-lab/public/catalog` contains real output from `buildPrototypeModes`, including `comparison.json`, `mode-plan.json`, both render plans and manifests, and each available standalone bundle. `candidate-review` is a product-scope fixture, `domain-review` uses an exact domain-scope scenario, and `rejected-change` supplies a later rejected System Request revision. Its comparison has `proposed: null` and `fallback: "rejected-system-request"`. Fixture approvals use a fixture authority verifier and are not production approval records. Authored render and mode plans still require review, as their generated manifest states.

Use Node `24.21.0` and pnpm `12.9.1` after `pnpm install --frozen-lockfile`. The catalog comparator regenerates these outputs into a trusted local temporary root and checks every committed byte. The canonical Vitest suite and the Demo Lab browser spec both invoke it, so unit and browser CI detect stale or hand-edited generated files. To refresh the committed fixture assets after an intentional builder or fixture change:

```sh
WRITE_CATALOG=1 pnpm test apps/demo-lab/src/catalog.test.ts
pnpm test apps/demo-lab/src/catalog.test.ts
```

The output root is local and trusted; the builder's path checks do not protect against hostile concurrent directory renames. Do not use a shared or attacker-controlled output root. To review the lab, run `pnpm dev`; `pnpm build` copies the static catalog into the Vite output. Run `pnpm test:browser apps/demo-lab/tests/demo-lab.spec.ts` for shell, generated-content, navigation, fallback, sandbox, viewport, and accessibility checks. Automated accessibility results are evidence for those rendered states, not a full WCAG conformance claim.
