# Multi-domain Product Design Package inventory

[9UI-144](https://linear.app/9uile/issue/9UI-144/) clarifies the existing [Design Package governance](../specifications/design-package-governance.md) contract. A Product deliverable can inventory work from multiple Experience Domains and a cross-domain journey without changing artifact consumption or asset distribution authority.

## Containment rule

For an explicitly selected artifact in a package manifest, the registry first permits the package's own or registered ancestor scope as before. Only when the package scope is a registered Product and `kind` is `design` does it additionally permit an artifact whose registered Domain or Local scope has that Product as an ancestor. The trusted scope tree must match the artifact's original embedded scope exactly. Unregistered scopes, forged parentage, unrelated Products, and foreign Domains fail. Other package kinds and scopes retain the original ancestor-only rule.

The manifest and root lock already list each artifact's exact ID, integer revision, schema version, raw byte digest, and parsed snapshot digest. Its embedded snapshot retains source scope, lifecycle, approval, and provenance. The package's release approval remains separate and bound to exact candidate bytes. Compilation of a new release checks selected and consumed artifact closure through the trusted `ArtifactStore` for current approval and freshness. Historical registry reads verify released bytes and release authority without retroactively imposing current freshness on contextual historical snapshots.

A Product journey's `content.domains` names are semantic references. They are not artifact dependency edges or invented locks. Real `artifact.dependencies` still require exact ID, revision, digest, and ancestor-scope consumption. Package dependencies likewise remain ancestor-only; a Product package cannot depend on a Domain package. Inventory is delivery containment, not promotion or permission for sibling consumption.

## Reproduction and compatibility

Before this correction, a canonical Product `design` candidate with two Domain-scoped experience artifacts and a Product-scoped journey could be returned by `compilePackage`, but `candidate.verifyResolution()` failed with `Artifact is out of package scope`. The publisher invokes reconstruction before staging and before commit, so that candidate was not a published release. A single Domain package could pass, but did not satisfy the Product multi-domain deliverable.

The corrected reader reconstructs the same explicit inventory in both Reference and Portable modes. Portable still requires exact bundled transitive package bytes and a redistribution grant; Reference still acquires exact external dependencies. Neither mode changes source artifact scope, approval, provenance, freshness, or dependency direction. The `format: 1` manifest and lock schema and existing valid release bytes are unchanged. Older readers reject newly valid descendant inventories, so distribution of such releases requires an updated reader; existing historical releases remain readable by the corrected reader.

Separate Domain packages aggregated as Product package dependencies would violate the existing package dependency direction and require a different membership contract. This change does not introduce that model.
