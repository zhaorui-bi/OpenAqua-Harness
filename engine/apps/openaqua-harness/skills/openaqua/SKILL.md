---
name: openaqua
description: Run a focused OpenAqua water-treatment operation: inspect readiness, browse the taxonomy, normalize a source-water query, retrieve evidence, recommend treatment trains, check constraints, build indexes, stage knowledge, evaluate predictions, or inspect durable jobs. Use for one query or one bounded operation. For benchmark suites or repeated comparisons, use openaqua-campaign.
---

# OpenAqua water-treatment operations

OpenAqua is a five-agent research framework for **early-stage water-treatment
train design**:

```text
Parser → Retriever → Planner → Critic → Explanation
```

The harness exposes this workflow through `openaqua_*` MCP tools and durable
background jobs. Recommendations are engineering decision support, not final
process design, regulatory certification, or evidence that a train will achieve
a target at a specific site.

## Operating contract

1. Run `openaqua_status` when readiness is unknown. Do not launch design work
   when the taxonomy, knowledge base, or indexes are missing.
2. Preserve units exactly. Ask for clarification when concentration units,
   source-water context, or targets are ambiguous; never silently convert or
   invent measurements.
3. Prefer structured fields for measured data and constraints. Natural-language
   parsing can supplement them, but explicit structured values take precedence.
4. Distinguish retrieved evidence, OpenAqua rule checks, and model-generated
   synthesis in every report.
5. State missing fields, assumptions, uncertainty, and evidence gaps. Do not
   present an absent citation or weak retrieval match as support.
6. Ask for confirmation before rebuilding indexes, staging knowledge, replacing
   an explicit output path, or launching a large evaluation/model workload.
7. Recommend expert review, applicable regulatory review, treatability testing,
   pilot testing, and site-specific design before implementation.

## Query checklist

Before recommendation, establish as much of the following as practical:

- source water: groundwater, surface water, wastewater, seawater, or another
  explicit context;
- measured water quality with units;
- contaminants and known synonyms;
- effluent targets and compliance standard, if any;
- drinking-water use;
- budget, energy, operator skill, footprint, chemical-dosing, and brine-disposal
  constraints;
- relevant site context and known pretreatment/post-treatment requirements.

Use `openaqua_catalog` to check canonical contaminant and treatment-unit names.
Use `openaqua_normalize_query` before a full run when the input is ambiguous or
contains many synonyms. If only `rawQuery` is supplied and OpenRouter is not
configured, OpenAqua falls back to structured/rule behavior and may leave the
contaminant list empty; report that limitation rather than guessing.

## Choosing the right tool

- `openaqua_status` — inspect the checkout, Python runtime, dependencies,
  knowledge assets, indexes, and optional OpenRouter setup.
- `openaqua_catalog` — browse/search canonical contaminants and treatment units.
- `openaqua_normalize_query` — run the parser and taxonomy normalization only.
- `openaqua_retrieve_evidence` — retrieve unit-level and case-level evidence
  without asking the planner to produce final recommendations.
- `openaqua_recommend` — run the complete five-agent pipeline and write a result
  JSON file.
- `openaqua_check_constraints` — apply taxonomy, drinking-water disinfection,
  brine-disposal, and energy rules to supplied candidate trains.
- `openaqua_build_indexes` — replace generated BM25/corpus indexes from the
  canonical downloaded knowledge assets.
- `openaqua_ingest_knowledge` — stage a `kb_unit` or `kb_case` record. OpenAqua
  v1 preserves staged records under `data/ingest`; its stock index builder does
  not automatically merge them into canonical data sources.
- `openaqua_evaluate_trains` — score treatment-train predictions with WContBench
  precision, recall, F1, coverage, hit rate, and case-level acceptability.
- `openaqua_evaluate_retrieval` — score retrieval predictions at requested k.

## Run at the right scale

Use four explicit gates:

1. **Readiness** — status is healthy; dependencies, processed data, and indexes
   are available.
2. **Normalization** — one representative query maps to the expected source,
   contaminant taxonomy, targets, and constraints.
3. **Smoke case** — one complete recommendation or retrieval run produces a
   readable result and traceable evidence.
4. **Evaluation/campaign** — only after the smoke case, run a declared benchmark
   subset or repeated comparison. Load `openaqua-campaign` for this stage.

A healthy adapter alone does not imply that the knowledge assets are present.
An index with zero chunks is not a successful knowledge build.

## Monitoring durable jobs

Recommendation, retrieval, indexing, ingestion, and evaluations run as durable
jobs.

- Use `wait: true` only for bounded work likely to finish inside
  `waitTimeoutMs`; otherwise return the `jobId`.
- Recover detached work with `openaqua_job_list`.
- Use `openaqua_job_status` for lifecycle state and timing.
- Use `openaqua_job_manifest` before comparing or handing off a run. It records
  validated parameters, the backend command and adapter-reported revision,
  runtime identity, input hashes, inline-payload hashes, and `requestSha256`.
- A matching request fingerprint does **not** prove identical Hugging Face data,
  generated indexes, OpenRouter responses, or engineering outcomes. Preserve
  those versions and result files separately.
- Use bounded `openaqua_job_log` tails or `errors`/`events` views; do not
  busy-poll or paste full logs into the conversation.
- Use `openaqua_job_artifacts` for bounded output metadata. Symbolic links are
  reported but never followed.
- On failure, report the job ID, failed stage, concise evidence, and one bounded
  recovery step. Do not create an automatic retry loop.

## Interpreting results

For each recommended train, report:

- ordered unit operations and canonical names;
- decomposed rank score (coverage, constraint, evidence, risk penalty);
- retrieved evidence and whether each claim is evidence-backed, inference, or
  assumption;
- constraint status, auto-revisions, and dropped alternatives;
- missing query fields, assumptions, risks, and uncertainty;
- job ID, output path, backend revision, and dataset/index context when known.

Do not state removal efficiency, finished-water compliance, cost, footprint,
energy demand, residuals handling, or operability unless the supplied evidence
supports the specific claim. A taxonomy-valid train can still be technically,
economically, or regulatorily unsuitable.
