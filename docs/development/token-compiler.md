# Token compiler

The compiler uses the [DTCG 2025.10 Format Module](https://www.designtokens.org/TR/2025.10/format/) and [Color Module](https://www.designtokens.org/TR/2025.10/color/) as its format baseline. It intentionally implements a CSS-ready subset. This is not a claim of full DTCG conformance.

`compileApprovedTokenAssets(store, sources, previous?)` takes exact artifact references (`artifactId`, `revision`, `lockDigest`) and reads them through `ArtifactStore`. The store validates the v1 artifact schema, snapshot digest, dependency locks and human approval using its configured authority verifier. The compiler also requires approved, fresh `design-system-asset` snapshots of kind `dtcg-tokens`. A caller cannot authorize a proposal by setting an approval label. No CSS is emitted on failure. The returned `sources` list and each token's `source` retain the exact input locks; generated CSS is derived output.

Exact references are validated and copied before the first asynchronous read. Returned source metadata is immutable, so caller changes during compilation or after return cannot relabel the verified CSS.

## Accepted source subset

- `content.definition.tokens` is a DTCG group tree under top-level `primitive`, `semantic`, and `component` groups. Group `$type` inheritance, token `$type`, `$value`, `$description`, and `$deprecated` are accepted. Types are never guessed from values.
- Supported concrete types are `color` (sRGB object with three numeric 0–1 components and optional numeric 0–1 alpha), `dimension` (`{ "value": number, "unit": "px" | "rem" }`), `duration` (same shape, `ms` or `s`), and `number` (JSON number). Other DTCG types, color spaces, color fallback `hex`, extensions, group extension, composite values, and property-level references are rejected.
- A complete curly-brace token alias such as `{primitive.color.navy}` is supported. Chained aliases preserve CSS `var()` links. A reference must resolve to a token of the same declared or inherited type and may target its own or an earlier layer. JSON Pointer `$ref`, interpolation, and partial aliases are rejected. This is narrower than DTCG 2025.10 reference support.
- `definition.modes` may be absent or exactly `["light"]`. Other modes need a future explicit output contract. An optional `definition.references` list must name tokens present in that asset.
- Name segments are lowercase ASCII letters and digits with interior hyphens, or a numeric scale segment. The runtime maps `primitive.color.navy` to `--mimic-primitive-color-navy`. Different paths that map to the same custom property are rejected. This narrow naming policy avoids ambiguous escaping and CSS injection.

The [S13 example](../../skills/s13-visual-system-builder/examples/output.json) is a **pending** proposal with typed `primitive`, `semantic`, and `component` tokens in this supported subset. Its conforming shape does not grant approval: only an exact revision published through a verified human decision and commit can become compiler input. The [S13 token integration bridge](s13-token-integration.md) exercises that handoff with a synthetic approval authority; it does not establish actual human review or design quality. The compiler does not choose a Design Direction or infer design intent from token values.

## Compatibility and reproducibility

Passing an exact approved `previous` token asset retains its paths that the new approved sources do not mention. A new approved source may replace a prior path; the name remains path-derived. Duplicate paths among new sources, output name collisions, unresolved/cyclic aliases, type mismatches, unsupported values, stale or unapproved artifacts, and lock mismatches stop compilation. Source objects are not mutated. Ordering is lexicographic by token path, independent of JSON property order; output ends with one newline.
