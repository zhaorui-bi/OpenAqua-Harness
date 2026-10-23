# OpenAqua Harness package

`openaqua-harness` is the product host for OpenAqua Harness. It starts the Kimi
Code agent engine through `@moonshot-ai/kimi-code-sdk` and
`@moonshot-ai/kap-server`, then exposes the external OpenAqua Python checkout as
an MCP stdio server.

The package provides onboarding, diagnostics, a bundled Python adapter, durable
jobs, request provenance, session-level tool registration, a branded Web UI,
and the executables used by the desktop application.

Release `0.1.0-beta.1` is validated against OpenAqua commit `0e39908` and
Hugging Face dataset revision `cc2d3c620e8ada7c62fa922cf3a827d8b42889e3`.

## Commands

| Command | Behavior |
| --- | --- |
| `openaqua run "<prompt>"` | Create a session, attach OpenAqua tools, stream one response, and exit. |
| `openaqua chat` | Lightweight persistent REPL. |
| `openaqua web [options]` | Start kap-server and the branded local Web UI. |
| `openaqua doctor [--json] [--probe]` | Check Node, storage, model configuration, backend health, MCP, Web assets, and skills. |
| `openaqua onboard [options]` | Configure the home directory, API model provider, OpenAqua repository/command, MCP, and skills. |
| `openaqua tools [--json]` | List all 16 tool schemas and annotations. |
| `openaqua info` / `--version` | Print version and resolved paths. |

## Development

From `engine/`:

```bash
pnpm install --frozen-lockfile
pnpm --filter openaqua-harness run typecheck
pnpm --filter openaqua-harness run test
pnpm --filter openaqua-harness run build
```

The build produces `dist/cli.mjs`, `dist/mcp-server.mjs`, and
`dist/job-runner.mjs`; the shared worker build adds `dist/search-worker.mjs`.

## Environment variables

- `OPENAQUA_HOME` — Harness configuration; defaults to `~/.openaqua`.
- `OPENAQUA_COMMAND` — adapter-compatible backend command.
- `OPENAQUA_REPO` — OpenAqua repository checkout.
- `OPENAQUA_PYTHON` — optional Python interpreter for that checkout.
- `OPENAQUA_WORKDIR` / `OPENAQUA_JOBS_DIR` — workspace and durable-job roots.
- `OPENAQUA_WEB_ASSETS_DIR` — branded Web UI override.
- `OPENROUTER_API_KEY` / `OPENAQUA_OPENROUTER_MODEL` — optional OpenAqua LLM configuration; use `OPENAQUA_DEFAULT_MODEL`, `OPENAQUA_PLANNER_MODEL`, and `OPENAQUA_EXPLANATION_MODEL` for per-stage overrides.

## Source map

```text
backend/openaqua_cli.py       stable adapter over the upstream Python project
src/cli.ts                    command dispatch
src/cli-args.ts               strict argument parsing
src/harness.ts                Kimi Harness assembly and MCP attachment
src/server.ts                 kap-server startup and host identity
src/mcp/server.ts             MCP stdio server
src/mcp/register.ts           safe mcp.json registration
src/openaqua/backend.ts       checkout discovery and bounded process execution
src/openaqua/provenance.ts    engineering input/payload fingerprints
src/openaqua/jobs.ts          durable jobs, logs, artifacts, manifests
src/openaqua/job-runner.ts    independent process runner
src/openaqua/tools.ts         OpenAqua tool catalog and Zod schemas
skills/                       focused operation and campaign guidance
theme/openaqua.css            branded Web visual system
scripts/sync-web-ui.mjs       deterministic Web UI branding
```

Recommendation, retrieval, index building, knowledge staging, and WContBench
evaluation are asynchronous. They return a `jobId`; lifecycle state, bounded
logs, output metadata, and `run-manifest.json` remain available after the
initiating session exits.

The manifest is request-level provenance. A matching `requestSha256` does not
prove identical knowledge snapshots, generated indexes, remote model responses,
or treatment recommendations. Preserve those identities separately.

## Generated assets

`dist/` and `web-ui/` are generated. Do not edit them directly. From the
repository root:

```bash
npm run sync:web
```

## License

MIT. See the repository root for OpenAqua and Kimi Code attribution.
