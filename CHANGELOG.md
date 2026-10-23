# Changelog

All notable user-facing changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic
versioning.

## [Unreleased]

### Planned

- Additional dataset acquisition and curation helpers.
- Broader real-backend integration fixtures and benchmark reporting.

## [0.1.0-beta.1] - 2026-10-23

### Added

- Complete OpenAqua Harness product shell with CLI, TUI, Web, and Electron
  desktop interfaces based on the open-source Kimi Code engine.
- Bundled `openaqua_cli.py` adapter over the OpenAqua Parser → Retriever →
  Planner → Critic → Explanation workflow, with clean JSON stdout, current
  WContBench evidence-layout compatibility, and evaluator-module isolation.
- MCP tools for status, taxonomy browsing, query normalization, recommendation,
  evidence retrieval, candidate constraint checking, index building, knowledge
  staging, and WContBench train/retrieval evaluation.
- Durable background jobs with recovery, status, cancellation, bounded
  raw/error/event logs, cursor pagination, and symlink-safe artifact metadata.
- Schema-versioned engineering run manifests with validated parameters,
  backend command plus adapter-reported version/revision, runtime identity,
  regular-file and inline-payload SHA-256 identities, explicit requested-only
  semantics, and request fingerprints.
- API-key provider onboarding, explicit OpenAqua repository/Python discovery,
  health diagnostics, MCP registration, and focused operation/campaign skills.
- OpenAqua branding, generated desktop icons, English and Simplified Chinese
  documentation, CI, native desktop packaging, license notices, and SPDX SBOM.
- Standard-library Python adapter regression tests covering JSON stream hygiene,
  ingestion aliases, dataclass-based evaluators, and current WContBench evidence.
- A documented validation baseline at OpenAqua commit `0e39908` and Hugging Face
  dataset revision `cc2d3c620e8ada7c62fa922cf3a827d8b42889e3`.

### Security

- Atomic private configuration writes and strict malformed-config handling.
- No-shell backend execution, bounded output capture, timeout/process-tree
  cleanup, strict user-path handling, and preflight rejection of unsafe inputs.
- Sandboxed Electron renderer, loopback/token validation, permission/webview
  denial, navigation guards, secret redaction, and bounded shutdown.
- HTTPS required for non-loopback custom model-provider endpoints.

### Known limitations

- OpenAqua source, Python dependencies, and Hugging Face knowledge/benchmark
  assets are external and must be installed separately.
- Knowledge ingestion follows OpenAqua v1 staging semantics; staged records are
  not automatically merged into canonical index sources.
- Recommendations remain early-stage engineering decision support and require
  expert, regulatory, laboratory, pilot, and site-specific review.

[Unreleased]: https://github.com/zhaorui-bi/OpenAqua-Harness/compare/v0.1.0-beta.1...main
[0.1.0-beta.1]: https://github.com/zhaorui-bi/OpenAqua-Harness/tree/v0.1.0-beta.1
