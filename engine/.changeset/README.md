# OpenAqua Harness change records

OpenAqua Harness is distributed through versioned GitHub desktop releases;
its product packages are private and are not an npm release channel. Follow the root
[release process](../../docs/RELEASE.md) and maintain the product
[changelog](../../CHANGELOG.md).

This directory retains OpenAqua-specific user-facing change records and the
vendored Changesets tooling configuration. These files do not trigger npm
publication or an automatic upstream release PR in this repository.

Do not carry unrelated pending upstream changes into a product release. Keep
upstream attribution and licenses in place when updating the vendored engine.
