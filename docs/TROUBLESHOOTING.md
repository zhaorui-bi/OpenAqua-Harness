# Troubleshooting

English | [简体中文](./zh-CN/TROUBLESHOOTING.md)

Start with:

```bash
./bin/openaqua doctor --probe
./bin/openaqua tools --json
```

On Windows, use `npm run cli --` in place of `./bin/openaqua`.

## Harness installation

### Node is older than 24.15

Upgrade Node, reopen the shell, then run:

```bash
node --version
npm --version
npm ci
npm run setup
```

### `npm run setup` fails

Retry once after checking network access, free space, and write permission. If a
previous run was interrupted, remove generated dependencies/build output only
as directed by the first error, then rerun `npm ci && npm run setup`.

### CLI says the engine is not built

Run `npm run setup` from the repository root. The POSIX launcher requires
`engine/apps/openaqua-harness/dist/cli.mjs`.

## Backend discovery

### `openaqua_backend` is not found

Use one of:

```bash
./bin/openaqua onboard --openaqua-repo /absolute/path/to/OpenAqua
export OPENAQUA_REPO=/absolute/path/to/OpenAqua
export OPENAQUA_COMMAND='["python","/path/to/adapter-compatible-cli.py"]'
```

A valid checkout contains `water_treatment_agent/requirements.txt`,
`water_treatment_agent/app/workflows/pipeline.py`, `test_openaqua.py`, and
`test_retrieval.py`.

### The wrong Python interpreter is selected

Set it explicitly:

```bash
export OPENAQUA_PYTHON=/path/to/OpenAqua/water_treatment_agent/.venv/bin/python
./bin/openaqua doctor --probe
```

On Windows, point to `.venv\Scripts\python.exe`.

### Probe reports missing `openai`, `rank_bm25`, or another package

Activate the OpenAqua environment and install its requirements:

```bash
cd /path/to/OpenAqua/water_treatment_agent
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Then make sure the Harness resolves that interpreter with `OPENAQUA_PYTHON` or
the recognized virtual-environment location.

## Data and indexes

### Health reports `taxonomy_available: false` or missing knowledge directories

OpenAqua’s data are hosted on Hugging Face, not GitHub. Download and extract:

```bash
cd /path/to/OpenAqua/water_treatment_agent
python -m pip install -U huggingface_hub
hf download zhaorui-bi/OpenAqua data.zip WContBench/ \
  --repo-type dataset \
  --revision cc2d3c620e8ada7c62fa922cf3a827d8b42889e3 \
  --local-dir ../hf_openaqua
unzip ../hf_openaqua/data.zip -d .
```

The ZIP already contains `data/`; extracting it with `-d data` creates the
incorrect path `data/data/`. Verify that `data/unit-level/taxonomy.json`
exists.

### Indexes are missing or have zero chunks

First confirm that the unit-level TDB and optional case KB exist. Then ask the
agent to call `openaqua_build_indexes`. A zero-chunk build usually means data
were extracted to the wrong directory.

Expected generated files:

```text
water_treatment_agent/data/processed/indexes/corpus.jsonl
water_treatment_agent/data/processed/indexes/bm25_index.pkl
```

### Retrieval returns no evidence

Check, in order:

1. query normalization produced canonical contaminants;
2. taxonomy/data paths are available;
3. indexes exist and `chunk_count` is non-zero;
4. contaminant names match the downloaded taxonomy;
5. the result/log contains no index-unpickle or schema error.

## Models

### Harness says no model is configured

Run `./bin/openaqua onboard` or use `/provider` in the TUI. Provider credentials
for the Harness are separate from `OPENROUTER_API_KEY`.

### OpenAqua does not parse a natural-language query

If `OPENROUTER_API_KEY` is absent, OpenAqua intentionally uses fallback logic
and does not extract all fields from free text. Supply structured fields or set
the key in the environment that launches the Harness/Web/desktop process.

### Desktop does not see an environment variable

GUI apps launched from Finder/Start Menu often inherit a different environment.
Use a persistent OS-level variable, launch from a shell that exports it, or
store only the approved credential through your organization’s preferred
mechanism. Restart the desktop app after changing variables.

### Custom Harness provider fails HTTPS validation

Non-loopback endpoints must use HTTPS. Loopback HTTP remains allowed for local
servers such as `http://127.0.0.1:8000/v1`.

## Queries and constraints

### Contaminants disappear during normalization

They were not found in the controlled taxonomy. Run `openaqua_catalog` with a
search term and use the canonical or recognized synonym. Do not bypass taxonomy
validation by inventing an ID.

### Constraint checking rejects every candidate

Read the rule-level checks. Common causes include unknown unit names, drinking
water without disinfection, membrane separation when brine disposal is
unavailable, or an energy conflict. Auto-revision is limited and must be
reviewed; it is not a complete process redesign.

### The agent reports unsupported quantitative removal or compliance claims

Treat that as an interpretation error. Ask it to distinguish retrieved evidence
from inference, cite the exact chunk, and remove claims that the source does not
support.

## Jobs

### A long operation appears lost

```text
openaqua_job_list → openaqua_job_status → openaqua_job_manifest
```

Then read a bounded log tail or `view: "errors"`. Jobs are stored under
`OPENAQUA_JOBS_DIR` or `<workdir>/openaqua-jobs`.

### A job succeeded but no artifact is listed

`openaqua_job_artifacts` only indexes the explicit `--output` location. Check
`configuredOutput` in job status/manifest and inspect the bounded log for a
backend-reported path.

### Cancellation refuses a stale job record

This is a safety feature: the Harness verifies that the recorded process still
matches the expected runner before signalling it. Inspect the job state and
remove stale metadata only after confirming no related process remains.

## Web and desktop

### Web UI does not open

Copy the complete `Local:` URL printed by `openaqua web`; it includes an
authentication token in the fragment. Try another port with `--port 8765` and
check loopback firewall/proxy rules.

### Desktop reports startup timeout or engine exit

Run `npm start` from a terminal to retain logs, select **文件 → 重启引擎**, and
rebuild with `npm run setup` if files are stale. Use `OPENAQUA_DEBUG=1 npm start`
for developer tools.

## Logs and privacy

Harness configuration lives under `~/.openaqua`. Development desktop state
lives under `openaqua-data/`; jobs live under the configured workspace. These
locations can contain prompts, source-water data, paths, model output, and
credentials. Redact them before sharing.

## Still stuck

Open an issue at <https://github.com/zhaorui-bi/OpenAqua-Harness/issues> with:

- redacted `openaqua doctor --json`;
- OS, Node, npm, Python, and OpenAqua commit;
- `openaqua_status` output;
- the smallest query/input that reproduces the issue;
- bounded error-log excerpts.
