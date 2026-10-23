# Release process

OpenAqua Harness is distributed from GitHub as source and as platform-specific
desktop artifacts. The npm workspaces remain private and are not an npm release
channel.

## Release gates

A release candidate is ready only when all of the following are true:

- the release commit is checked out in a clean root Git worktree;
- root, harness, changelog, citation, and tag versions agree;
- `npm run release:check` passes on the pinned Node.js release with Python 3.12 available for adapter tests;
- the Node 26 compatibility job passes;
- the built Web server reports a non-degraded global-search worker;
- a clean home passes onboarding and `openaqua doctor --probe`;
- a bounded real-backend recommendation or retrieval smoke completes and records its output;
- desktop artifacts have been built and launched on every advertised platform;
- macOS and Windows artifacts are signed, and macOS is notarized and stapled;
- release assets include SHA-256 checksums, `SBOM.spdx.json`, and the packaged license notices.

Do not build a release from a directory that contains only the vendored
`engine/.git`. Clone the OpenAqua Harness repository so tracked-file and
sensitive-data checks run against the correct root worktree.

## Prepare the candidate

Use a clean clone and the Node version declared in `package.json`:

```bash
git clone https://github.com/zhaorui-bi/OpenAqua-Harness.git
cd OpenAqua-Harness
npm ci
npm run setup
npm run release:check
```

Regenerate notices whenever a dependency changes:

```bash
npm run licenses
npm run check:licenses
```

Before tagging, update all of the following in one commit:

- `package.json` and `package-lock.json`;
- `engine/apps/openaqua-harness/package.json`;
- `CHANGELOG.md` and its comparison links;
- `CITATION.cff` and its release date.

The repository check rejects version drift. Root package, Harness package,
`CITATION.cff`, changelog section, and `v*` Git tag must all use the same SemVer
identifier, including any prerelease suffix. Never replace assets attached to
an older version with a build from a newer commit.

## Scientific acceptance smoke

Run this gate with a dedicated test provider account and non-sensitive example
water-quality inputs. Do not place credentials or unpublished data in CI artifacts.

1. Complete `openaqua onboard` in a fresh temporary home.
2. Require every required `openaqua doctor --probe` check to pass.
3. Invoke `openaqua_status` and `openaqua_catalog` through MCP.
4. Run one minimal, bounded structured recommendation or retrieval operation with explicit input and output.
5. Verify job status, timestamps, bounded logs, and artifact indexing.
6. Exercise graceful cancellation on a disposable job.
7. Confirm that a restarted server can recover the completed job.
8. Record Harness, OpenAqua commit, Hugging Face revision, index chunk count,
   provider/model, and operating-system versions.

This is an integration gate, not evidence that a treatment train is compliant,
optimal, safe, or field-ready.

## Build desktop artifacts

Build each target on its native operating system after `npm run setup`:

```bash
# macOS, once per architecture (or build a universal artifact)
npm run dist -- --mac --arm64
npm run dist -- --mac --x64

# Windows x64
npm run dist -- --win --x64

# Linux x64
npm run dist -- --linux --x64
```

Configured targets are DMG and ZIP on macOS, NSIS and ZIP on Windows, and
AppImage and tar.gz on Linux. Artifact names include product, version, operating
system, and architecture.

The unpacked application must contain at least:

```text
Resources/harness/dist/cli.mjs
Resources/harness/dist/mcp-server.mjs
Resources/harness/dist/job-runner.mjs
Resources/harness/dist/search-worker.mjs
Resources/harness/skills/
Resources/harness/backend/openaqua_cli.py
Resources/web-ui/
Resources/licenses/OPENAQUA_HARNESS_LICENSE
Resources/licenses/KIMI_CODE_LICENSE
Resources/licenses/OPENAQUA_UPSTREAM_LICENSE
Resources/licenses/THIRD_PARTY_NOTICES.md
Resources/licenses/SBOM.spdx.json
Resources/licenses/ELECTRON_LICENSE
Resources/licenses/ELECTRON_THIRD_PARTY_NOTICES.html
```

The `Desktop packages` workflow builds every native target and runs
`npm run smoke:desktop` against the unpacked packaged application. The smoke
requires the branded renderer, authenticated search worker, clean shutdown,
and all declared resources (including notices and SBOM) to be present.

For release acceptance, also launch the installed artifact rather than only
checking archive creation. Verify first-run onboarding, provider setup,
workspace selection, search, server shutdown, and restart.

## Signing and notarization

The tag-triggered `Release` workflow fails closed unless signing credentials are
available. Configure these GitHub Actions secrets for macOS:

```text
MACOS_CSC_LINK
MACOS_CSC_KEY_PASSWORD
APPLE_API_KEY_P8
APPLE_API_KEY_ID
APPLE_API_ISSUER
```

`APPLE_API_KEY_P8` contains the private-key text; the workflow writes it to a
private temporary file and exposes the resulting path as `APPLE_API_KEY` for
electron-builder. Locally, provide a Developer ID Application identity and one
supported notarization credential set. API-key environment variables are
preferred:

```text
APPLE_API_KEY=/private/path/AuthKey_ID.p8
APPLE_API_KEY_ID=...
APPLE_API_ISSUER=...
```

After building, require both checks to pass:

```bash
codesign --verify --deep --strict --verbose=2 "OpenAqua Harness.app"
spctl --assess --type execute --verbose=4 "OpenAqua Harness.app"
xcrun stapler validate OpenAqua-Harness-*.dmg
```

For Windows, configure `WINDOWS_CSC_LINK` and
`WINDOWS_CSC_KEY_PASSWORD`; the workflow maps them to electron-builder's
`CSC_LINK` and `CSC_KEY_PASSWORD` mechanism. It rejects every generated
executable whose Authenticode status is not `Valid`. Verify the installed
application and test SmartScreen behavior as a manual acceptance step. Never
publish a desktop artifact from a signing job that silently fell back to
unsigned output.

## Publish

Generate checksums after signing and notarization, because those steps change
the artifacts. The command hashes installers/archives plus any colocated
canonical SBOM and notice files, ignores update metadata and blockmaps, and
writes `dist/SHA256SUMS`:

```bash
npm run checksums
```

Create an annotated tag from the accepted commit and push it. The `Release`
workflow verifies that the tag, package, changelog, and citation versions agree;
builds signed native artifacts; verifies signatures/notarization; launches each
packaged app; generates combined checksums; and creates a GitHub prerelease or
release containing:

- platform and architecture-labelled installers/archives;
- `SHA256SUMS`, `SBOM.spdx.json`, and `THIRD_PARTY_NOTICES.md`;
- release notes derived from `CHANGELOG.md`;
- upgrade, backend-compatibility, and known-limitation notes.

Retain the exact commit and build logs. If a post-release defect affects data,
credentials, job control, or scientific interpretation, withdraw the affected
artifacts, document the issue, and publish a new version rather than replacing
files in place.
