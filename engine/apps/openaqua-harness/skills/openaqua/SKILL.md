---
name: openaqua
description: Run a focused OpenAqua water-treatment operation: inspect runtime readiness, browse the taxonomy, normalize or assess a source-water case, retrieve evidence, recommend treatment trains, check constraints, build indexes, stage knowledge, evaluate predictions, or inspect durable jobs. Use for one query or one bounded operation. For benchmark suites or repeated comparisons, use openaqua-campaign.
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

Declare reporting bases as well as units. For nitrate, preserve
`waterQuality.extra.nitrate_basis` and `treatmentTargets.extra.nitrate_basis`
independently (`"as NO3"` or `"as N"`). Equal mg/L values on different bases
are not interchangeable. The case audit asks for a documented common basis;
it does not convert values. For hardness, retain
`waterQuality.extra.hardness_basis`, for example `"as CaCO3"`.
Use `treatmentTargets.extra.lead_ug_L` for an explicit lead endpoint, and
`waterQuality.extra.arsenic_speciation` for measured As(III)/As(V) information.
An unmeasured speciation remains unknown. Record design flow, when known, in
`constraints.extra.design_flow_m3_day`. Flow alone does not establish sizing
readiness. A named standard alone does not supply a numeric endpoint or
establish its jurisdiction, edition, applicability, or sampling requirements.

Query-file fields use upstream snake_case (`water_quality`,
`treatment_targets`, `source_water`), while inline MCP inputs use camelCase.
Preserved extension fields are case context: check `context_preservation`
before interpreting them as constraints the upstream planner or critic used.

## Case-to-report workflow

For a treatment-design request:

1. Establish runtime/data readiness and controlled contaminant names.
2. Call `openaqua_assess_case`. Report critical blockers and bundle the most
   decision-sensitive information needs into a concise clarification.
   While critical blockers remain, limit work to clarification or exploratory
   retrieval. With unresolved high-priority gaps, a requested shortlist must
   state its conditional scope and cannot demonstrate target attainment.
3. Call `openaqua_retrieve_evidence` for the defined case. Check whether the
   source-water matrix, speciation, scale, operating conditions, and residuals
   handling match the intended application; a relevance score is not this check.
4. Run `openaqua_recommend`, preserving the result path and run manifest.
5. Call `openaqua_audit_report` on that saved result. Read the JSON `status`
   and issue list: successful execution of the audit job does not mean that
   the scientific audit passed. An empty recommendation set, an unknown
   constraint state, or malformed citations cannot substantiate a recommendation.
6. Hand off the case, evidence, candidate trains, constraint revisions,
   unresolved issues, uncertainty, job/output identifiers, and manifest hashes.

Keep the output at technology-screening level unless an independently
validated design basis supports additional calculations. Missing flow,
contact-time, dose, loading, residuals, or operating data cannot be replaced
with an invented engineering value. Treat an upstream rule pass as the result
of the implemented checks only.

## Choosing the right tool

- `openaqua_status` — inspect the checkout, Python runtime, dependencies,
  knowledge assets, indexes, and optional OpenRouter setup.
- `openaqua_catalog` — browse/search canonical contaminants and treatment units.
- `openaqua_normalize_query` — run the parser and taxonomy normalization only.
- `openaqua_assess_case` — build a machine-readable case state and a deterministic
  readiness audit with critical blockers and prioritized next-information actions.
  It is a screening checklist, not a calibrated risk or success probability.
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
- `openaqua_audit_report` — create a versioned claim–evidence ledger and check
  citation structure, declared support types, failed constraints, uncertainty,
  and selected quantitative-claim signals. It does not test semantic entailment
  or establish source quality, performance, safety, or compliance.

## Run at the right scale

Use four explicit gates:

1. **Readiness** — status is healthy; dependencies, processed data, and indexes
   are available.
2. **Normalization and case assessment** — one representative query maps to the
   expected source, contaminant taxonomy, targets, and constraints; critical
   information gaps are resolved or explicitly accepted before recommendation.
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
  runtime identity, non-secret effective scientific settings, input hashes,
  inline-payload hashes, and `requestSha256`.
  After completion it also records `result.resultSha256` for the configured
  output when that path can be captured.
- A matching request fingerprint does **not** prove identical OpenRouter
  responses or engineering outcomes. Compare the result fingerprint, preserve
  the actual result files, and retain dataset/index/model identities separately.
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
