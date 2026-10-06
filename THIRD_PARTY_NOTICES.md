# Third-party material and notices

Mimic's [Apache-2.0 license](LICENSE) covers repository material under that license. It does not replace the terms for third-party source, icons, fonts, images, datasets, or other assets. Keep applicable upstream license, copyright, attribution, patent, and other required notices when material is included or redistributed. Check the exact asset and version, intended use, modification, and distribution rights before adding it. A name or license identifier alone is not proof that a proposed use is allowed.

## Record material brought into the repository or a distribution

For each material third-party item that is vendored, bundled, or otherwise included in a distribution, record:

| Field                  | What to capture                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Material               | Name and kind of file or asset; distinguish it from a brand or trademark asset.                        |
| Source                 | Upstream author/publisher and source URL or other verifiable origin.                                   |
| Exact identity         | Version, revision, commit, or other exact asset identifier.                                            |
| License and rights     | Applicable license(s), where their full texts can be found, and any use or redistribution constraints. |
| Copyright and notices  | Original copyright holder(s), attribution, and verbatim notices required by upstream.                  |
| Location and inclusion | Repository or distribution path; whether bytes are bundled or only referenced/acquired externally.     |
| Modifications          | Whether changed, what changed, and where the modified-file notice appears when required.               |

Preserve upstream notice text and license files where required. Add material-specific records below or in a linked distribution inventory with the full required notices. Do not put additional restrictions in [NOTICE](NOTICE) or treat it as a substitute for upstream terms.

This file is guidance and a record location, not a completed dependency or release audit. The current monorepo declares package-manager dependencies in `package.json`, workspace manifests, and `pnpm-lock.yaml`; their licenses and any bundled distribution obligations need review for the actual release contents. A package-manager dependency is not automatically a vendored asset. Likewise, an empty record here does not mean the project has no third-party dependencies. Record the actual included bytes and applicable notices when preparing each distribution, including generated bundles or future seed knowledge.

For user Design Packages, the [Design Package governance contract](docs/specifications/design-package-governance.md) distinguishes bundled bytes from exact external references. Check the license for each asset in the package's manifest and lock. Do not bundle an asset into a Portable Snapshot without redistribution rights; use a Reference Package with exact acquisition requirements when appropriate. Using Mimic does not make a user's private Design Package Apache-2.0.

Reference Cases may record original observations, transferable principles, and source citations. Do not copy third-party screenshots, CSS, icons, or proprietary assets into repository knowledge or package output without compatible rights. Keep brand marks and trademarks separate from ordinary icons; rights and human brand decisions govern their use.

## Material records

Add a verified record here when material is introduced or distributed. Include the fields above and retain the exact required upstream notice text or a path to it. No material-specific records are asserted by this template.
