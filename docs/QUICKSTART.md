# Quick start

English | [简体中文](./zh-CN/QUICKSTART.md)

This guide installs the Harness, connects an OpenAqua checkout, downloads the
processed knowledge base, and runs a first query.

## 1. Requirements

- Node.js 24.15.0+
- npm 12
- Python 3.10+
- macOS, Linux, or Windows

```bash
node --version
npm --version
python3 --version
```

## 2. Install the Harness

```bash
git clone https://github.com/zhaorui-bi/OpenAqua-Harness.git
cd OpenAqua-Harness
npm ci
npm run setup
```

## 3. Install OpenAqua and its data

```bash
git clone https://github.com/zhaorui-bi/OpenAqua.git
cd OpenAqua
git checkout 0e3990817946f1786828fabbfa9ba4bc06af96e8
cd water_treatment_agent
python3 -m venv .venv
source .venv/bin/activate                 # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
python -m pip install -U huggingface_hub

hf download zhaorui-bi/OpenAqua data.zip WContBench/ \
  --repo-type dataset \
  --revision cc2d3c620e8ada7c62fa922cf3a827d8b42889e3 \
  --local-dir ../hf_openaqua
unzip ../hf_openaqua/data.zip -d .
```

Because the archive already contains `data/`, extract it into
`water_treatment_agent`; extracting into `data/` would create an invalid
`data/data/` tree. The pinned Git and dataset revisions are this Harness
release’s validation baseline. If you update either, record the new revision
and rerun validation. The benchmark remains under `../hf_openaqua/WContBench/`.

## 4. Configure the Harness and backend

The conversational Harness needs a provider. OpenAqua’s internal LLM stages can
optionally use OpenRouter.

```bash
export DEEPSEEK_API_KEY="YOUR_KEY"
export OPENROUTER_API_KEY="YOUR_OPTIONAL_OPENROUTER_KEY"

cd /path/to/OpenAqua-Harness
./bin/openaqua onboard \
  --provider deepseek \
  --api-key-env DEEPSEEK_API_KEY \
  --openaqua-repo /path/to/OpenAqua
```

Run `./bin/openaqua onboard` without flags for the interactive wizard.

## 5. Verify and build indexes

```bash
./bin/openaqua doctor --probe
./bin/openaqua run "Inspect OpenAqua status and build indexes if the downloaded knowledge base is ready but indexes are missing."
```

A healthy backend report should show installed Python dependencies, available
`taxonomy.json`/TDB/case data, and non-empty generated indexes.

## 6. Run a first query

```bash
./bin/openaqua run '
Use OpenAqua for groundwater containing arsenic at 150 µg/L.
Target ≤10 µg/L, low budget, low operator skill, no brine disposal,
and drinking-water use. Normalize the query, retrieve evidence, recommend
three trains, and explain constraints, risks, assumptions, and uncertainty.'
```

Or start an interactive interface:

```bash
./bin/openaqua       # full TUI
./bin/openaqua chat  # lightweight REPL
./bin/openaqua web   # browser
npm start            # Electron desktop
```

On Windows, replace `./bin/openaqua` with `npm run cli --`.

## Next steps

- [README](../README.md) — tools, architecture, backend resolution, and limits.
- [FAQ](./FAQ.md) — common setup and model questions.
- [Troubleshooting](./TROUBLESHOOTING.md) — backend/data/index failures.
- [Engineering workflow discipline](./SCIENTIFIC_WORKFLOWS.md) — reproducible studies and WContBench evaluation.
