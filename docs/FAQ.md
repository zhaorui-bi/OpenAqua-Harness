# Frequently asked questions

English | [简体中文](./zh-CN/FAQ.md)

### What is OpenAqua Harness?

It is an independent local workbench around the open-source OpenAqua
water-treatment research framework. It adds an agent interface, MCP tools,
durable jobs, provenance, CLI/TUI/Web/desktop surfaces, setup, diagnostics, and
packaging.

### Does this repository include OpenAqua and its dataset?

No. The Harness includes an adapter, not the OpenAqua source, Python
dependencies, processed knowledge base, or WContBench. Clone OpenAqua separately
and download `zhaorui-bi/OpenAqua` from Hugging Face.

### Why are there two model configurations?

The Kimi Code-based Harness needs a conversational model to plan and call tools.
OpenAqua optionally uses OpenRouter for natural-language parsing, planning, and
explanation. They are separate credentials. OpenAqua can run fallback logic
without `OPENROUTER_API_KEY`, but natural-language quality is lower.

### Can I avoid sending water-quality data to a remote model?

Use structured fields and leave `OPENROUTER_API_KEY` unset to keep OpenAqua in
its rule/template fallback mode. The conversational agent provider may still
receive your prompt and tool output. For sensitive data, use an approved local
or private provider and follow your organization’s data policy.

### How is the backend located?

Use `openaqua onboard --openaqua-repo /path/to/OpenAqua`, set
`OPENAQUA_REPO`, or provide an adapter-compatible `OPENAQUA_COMMAND`. The
Harness recognizes virtual environments at the repository root and under
`water_treatment_agent/`; `OPENAQUA_PYTHON` overrides interpreter selection.

### Why does status say the backend is healthy but data are missing?

Backend discovery only proves that the adapter and Python interpreter can run.
OpenAqua keeps processed data on Hugging Face, not in its Git repository.
Download/unzip `data.zip`, then build indexes.

### Can the Harness download the dataset automatically?

Not currently. Dataset acquisition is explicit so users can choose the storage
location and preserve a known snapshot. Follow the commands in
[Quick start](./QUICKSTART.md).

### What does `openaqua_ingest_knowledge` do?

It mirrors OpenAqua v1’s `/ingest` behavior by writing a JSON record under
`water_treatment_agent/data/ingest`. The stock `IndexBuilder` reads canonical
TDB and case files and does not automatically merge staged records. Treat the
staged file as a curation input, not proof that retrieval now uses it.

### Are recommendations safe to implement directly?

No. They are early-stage decision support. Taxonomy and rule checks do not
establish removal performance, hydraulics, residuals management, chemical
compatibility, cost, reliability, regulatory compliance, or local
constructability. Use expert review and site-specific testing/design.

### What does WContBench measure?

The included evaluation scripts compare predicted treatment units or retrieved
evidence to benchmark references. They measure benchmark agreement, not actual
finished-water performance or regulatory compliance.

### Where are jobs and outputs stored?

Job records default to `<workdir>/openaqua-jobs/`. Result JSON files default to
`<workdir>/openaqua-output/` unless a tool receives an explicit `output` path.
Use `openaqua_job_list`, `openaqua_job_manifest`, and
`openaqua_job_artifacts` to recover them.

### Is OAuth required for the Harness agent?

No. Provider setup is API-key based. Environment-variable credentials are
recommended over `--api-key`, which writes plaintext to configuration and may
remain in shell history.

### Which interfaces have the same capabilities?

TUI, CLI/REPL, Web, and desktop use the same Harness and MCP tools. The choice
is mainly interaction style: terminal for scriptability, Web/desktop for longer
reading and session browsing.

### How is OpenAqua Harness related to Kimi Code?

It vendors the MIT-licensed Kimi Code engine but is an independent product. The
OpenAqua-specific layer lives under `engine/apps/openaqua-harness`; directly
running the upstream Kimi Code client keeps its native identity and behavior.

### How do I report an issue?

Open <https://github.com/zhaorui-bi/OpenAqua-Harness/issues> and include a
redacted `openaqua doctor --json` report, OS, Node/Python versions, OpenAqua
commit, and a minimal reproduction. Use the private channel in
[SECURITY.md](../SECURITY.md) for vulnerabilities.
