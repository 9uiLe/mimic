# Artifact registry and store

`@mimic/core` exports `loadSchemaDirectory`, `SchemaRegistry`, `parseArtifactYaml`, `serializeArtifactYaml`, `artifactDigest`, `ArtifactStore`, and `FileSnapshotStorage`. The built ESM package does not guess where schemas live. A caller passes an explicit directory containing `artifact.schema.json`, `common.schema.json`, and all sixteen `types/*.schema.json` files, or supplies equivalent `SchemaSource` values to `SchemaRegistry`. This works when the built package is imported outside the source tree. The registry compiles the complete local JSON Schema 2020-12 graph by `$id` with Ajv formats. It rejects duplicate identities, missing references, unsupported dialects, and any artifact version except `1.0.0`. `validate` returns structured diagnostics and does not grant canonical admission. Ajv does not coerce, remove fields, insert defaults, fetch remote schemas, or migrate versions.

```ts
import {
  ArtifactStore,
  FileSnapshotStorage,
  loadSchemaDirectory,
} from "@mimic/core";

const schemas = await loadSchemaDirectory(
  "/explicit/location/schemas/artifacts",
);
const scopes = [
  { level: "organization", ownerId: "org_example" },
  { level: "product", ownerId: "product_example", parentId: "org_example" },
] as const;
const store = new ArtifactStore(
  new FileSnapshotStorage("/product/workspace/artifacts"),
  schemas,
  scopes,
  authorityVerifier,
);
const snapshot = await store.create(parsedArtifact);
const exact = await store.read(
  snapshot.artifact.meta.id,
  snapshot.artifact.meta.revision,
);
```

`authorityVerifier` is an injected `AuthorityVerifier` implementation supplied by the decision/approval owner. Its `verifyApproval` and `verifyDecision` methods must check authoritative records, actor identity, and the particular action. Without it, approved/rejected artifacts and human-decision provenance fail closed on admission and read. Approval-shaped JSON, even with a valid digest, is not authority. A provisional artifact can pass schema validation without entering this trusted store. Scope nodes are explicitly registered with complete Organization → Product → Domain → Local parentage; dependencies may refer only to their own or an ancestor scope. Dependencies resolve exact ID, revision, and locked digest, never a newer revision. Content JSON Pointers are checked for existence; this does not establish evidence quality.

## Canonicalization: `mimic-json-v1`

The digest is SHA-256 of UTF-8 bytes of a canonical JSON rendering of the **complete parsed artifact**, omitting only `meta.contentDigest`. It includes final lifecycle, approval, provenance, scope, dependencies, and content values. It is written as `sha256:` followed by 64 lowercase hexadecimal digits. A supplied digest must match. The rule version is stored in the filesystem record as `canonicalization`, not in the artifact schema. Display YAML and JSON indentation are not integrity bytes.

For this named rule, object keys sort in ascending UTF-16 code unit order at every depth; array order is preserved. Strings are not Unicode-normalized, and unpaired surrogates are rejected. Strings and escapes use ECMAScript `JSON.stringify`; serialization uses UTF-8 without a byte-order mark or trailing newline. Numbers are finite IEEE-754 values rendered by `JSON.stringify`; negative zero becomes `0`, and integers outside JavaScript's safe integer range are rejected. Null, booleans, strings, arrays, and plain string-keyed objects are accepted. Undefined, functions, symbols, BigInt, nonfinite numbers, sparse arrays, accessors, and non-JSON object values are rejected. This is a Mimic-specific rule, not a claim of compliance with a general JSON canonicalization standard.

YAML input must be exactly one mapping of JSON-compatible data using YAML 1.2 (implicit or explicit). A YAML 1.1 directive is rejected. Explicit tags are limited to the JSON-compatible core scalar tags (`str`, `int`, `float`, `bool`, `null`) and collection tags (`map`, `seq`); non-core tags such as `set`, `omap`, and `timestamp` are rejected even when a YAML version would otherwise resolve them. Duplicate, non-string, or complex keys, aliases, unsupported tags/values, and nonfinite numbers are rejected before schema validation. Aliases are rejected rather than expanded, so expansion cannot consume unbounded memory. `serializeArtifactYaml` emits deterministic display YAML by sorted object keys and can be parsed back to the same JSON value. It is not used to calculate digests.

## Snapshot history and publication

The filesystem backend stores one record for each logical ID and integer revision. The ID schema permits only `art_` plus ASCII letters, digits, underscore, and hyphen, so callers cannot supply a path. A revision must be the next integer and, from revision 2, name its immediate predecessor in `meta.supersedesRevision`. An identical retry returns the existing record; a different snapshot at that revision conflicts. Every published revision is append-only, including proposals. A content, approval, freshness, or dependency change requires a new revision. Approved and release-referenced revisions are therefore never changed in place. This store does not choose release references or set Run state.

Publication writes and syncs a same-directory temporary file, then creates the final revision with a hard link that fails if another writer published it first. A process interrupted before that link leaves an ignored `.pending` file and no visible snapshot; after the link it leaves a complete visible record. Reads verify record identity, schema, canonicalization version, digest, authority, scope, exact dependencies, and pointers. Missing snapshots return `UNAVAILABLE`; invalid stored records return `CORRUPT`; unavailable authority returns `UNVERIFIED`. History lists exact revisions and reports gaps. Moving the whole storage directory preserves logical IDs and history. `SnapshotStorage` can be replaced without changing callers.

The backing directory and verifier are trusted local infrastructure. This mechanism prevents accidental overwrite and detects ordinary corruption; it does not claim protection against an administrator who can replace both files and their digest, or provide forged authority responses. No deletion, retention expiry, external upload, or automatic Git commit is implemented. A product workspace may version the records with Git independently.

## Shared Run commit transaction

`FileWorkspaceStorage` is an alternative `SnapshotStorage` backend for a product workspace that needs Human Commit Points. Its `snapshots` adapter preserves the existing `ArtifactStore` read/create interface. Its registry transaction stages new approved or rejected artifact records and the Run/Decision/canonical state in one file and exposes them through one atomic rename. A transaction-local `ArtifactStore.withStorage` instance runs the ordinary admission guards before publication. `ArtifactStorePublication` binds the new full envelope to the human Decision Record; `RegistryAuthorityVerifier` checks that binding on later reads. Existing `FileSnapshotStorage` single-revision publication and clients are unchanged, but it cannot serve as the backend for a multi-revision atomic commit.

A caller must keep both store and registry on the same `FileWorkspaceStorage` instance. The Run registry refuses commit or rejection publication if the shared transactional backend and publisher are absent or mismatched. Commit IDs support exact-request retry after an uncertain response. A different request using the same ID conflicts. The workspace file is versioned and contains all artifact records and registry state; there is no automatic import of an existing snapshot directory. The local filesystem must provide atomic same-directory rename and reliable file and directory sync for the stated durability guarantee.
