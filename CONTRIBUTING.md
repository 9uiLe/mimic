# Contributing to Mimic

Mimic is a public, maintainer-led project. External bug reports, feature ideas, and knowledge proposals are welcome through issues. External pull requests are not accepted until dogfooding is complete; the maintainer will reassess PR intake afterward. During pre-release, the maintainer reviews contributions and is the only person who merges pull requests or publishes releases. Passing checks does not itself approve a contribution. See the [code of conduct](CODE_OF_CONDUCT.md) when participating and the [security policy](SECURITY.md) for sensitive reports.

## Propose a change

1. Search existing issues and pull requests for related work. Use the [bug, feature, or knowledge issue template](.github/ISSUE_TEMPLATE) to describe a proposal. For a security vulnerability, follow [SECURITY.md](SECURITY.md) instead of posting exploit details in an issue.
2. Maintainers preparing code or documentation changes should create a focused branch from current `main`. Follow the [development guide](docs/development/README.md) for the pinned toolchain and local checks. Include applicable tests or validation evidence, and report checks that could not run.
3. Maintainers should open a pull request against `main` using the [PR template](.github/PULL_REQUEST_TEMPLATE.md). Link the issue or explain the change, its evidence, and any compatibility or licensing effects. The maintainer may ask for revisions before merging.

Knowledge contributions should state the problem traits and the transferable principle or mechanism, including poor-fit conditions and failure modes. Cite sources and distinguish observations from unverified claims. Reference cases are evidence to examine, not UI to copy; see the [design-space rules](docs/specifications/design-space-exploration.md). Promotion into shared knowledge needs a human decision.

## License and contribution terms

Mimic code, Skills, schemas, knowledge, documentation, and examples are under [Apache License 2.0](LICENSE) unless a file or material explicitly says otherwise. By submitting a contribution for inclusion, you make it available under its indicated license. We initially use the [Developer Certificate of Origin 1.1](DCO), not a Contributor License Agreement (CLA).

Only submit material you have the right to contribute under the applicable license. Third-party material retains its own terms and required notices; follow [third-party notice guidance](THIRD_PARTY_NOTICES.md) before proposing it for inclusion. Apache-2.0 for this repository does not set the license for a user's separately owned Design Package or require a private Design Package made with Mimic to be Apache-2.0. Its bundled or referenced third-party assets still carry their applicable terms; see the [Design Package governance contract](docs/specifications/design-package-governance.md).

## DCO sign-off

Each commit in a pull request needs a `Signed-off-by` trailer certifying the DCO statement. Read [the complete DCO 1.1 text](DCO) before signing. Use your actual authorized contributor name and email, matching the Git commit author. Do not use the `9uiLe` copyright attribution as a substitute for your identity or sign for someone else's contribution.

After checking that you can make the certification, create the commit with `git commit -s`, or add a matching `Signed-off-by: Your Name <you@example.com>` trailer to the commit message. If you work on another person's contribution, make sure the DCO's applicable clause covers it; never certify work you are not authorized to submit. The sign-off is part of the public commit record. The DCO states that the contribution and personal information submitted with it, including the sign-off, may be maintained indefinitely and redistributed under the relevant project or open source license.

The current pull request CI checks that every commit after the pull request base has a valid sign-off matching its commit author. It does not decide whether the signer actually has the rights claimed. See the [CI guide](ci/README.md) for the check and the rest of the current validation.
