# Engineering workflow discipline

OpenAqua Harness is an execution and interaction layer around OpenAqua. It
helps make early-stage water-treatment studies traceable; it does not turn
retrieval, rules, or model output into a field-ready design.

## Operating model

Advance long-running work through explicit gates:

```text
readiness → query smoke → end-to-end smoke → bounded pilot → approved study → review/handoff
```

| Stage | Purpose | Minimum evidence before advancing |
| --- | --- | --- |
| Readiness | Verify code, Python dependencies, processed knowledge, indexes, paths, and model configuration. | `openaqua_status` is interpretable; required data exist; indexes are non-empty. |
| Query smoke | Verify units, taxonomy normalization, targets, constraints, and case-state readiness. | A representative query normalizes as intended without silent unit changes; `openaqua_assess_case` exposes unresolved critical or high-priority information needs. |
| End-to-end smoke | Exercise retrieval, planning, critique, explanation, and output persistence. | One case produces a readable result with evidence, assumptions, uncertainty, and a durable manifest. |
| Pilot | Estimate completion rate, latency, schema failures, evidence coverage, and model variability. | Recurring failures are diagnosed and the proposed study budget is justified. |
| Approved study | Run the frozen comparison or WContBench subset in bounded batches. | Each branch has stable identity, complete denominators, and recoverable outputs. |
| Review/handoff | Make the engineering decision auditable. | Manifest, predictions, metrics, failures, evidence context, deviations, and limitations are present. |

A successful adapter probe is not data readiness. A successful index command
that produces zero chunks is not a successful retrieval setup.

## Query integrity

Record source-water context, measurements, units, contaminants, treatment
targets, intended use, and operational constraints. Prefer structured values
for measured data. If values are converted, preserve the original value,
original unit, conversion equation, and converted value.

Do not silently infer:

- concentration units;
- whether a target is an influent or effluent value;
- whether water is intended for drinking;
- availability of brine disposal, chemicals, energy, or skilled operators;
- applicable regulatory standards.

Natural-language parsing can fill gaps when OpenRouter is configured, but those
fields remain model-extracted assumptions until reviewed. `openaqua_assess_case`
provides a deterministic screening checklist for missing information; its
readiness status is not a calibrated probability of success, safety, or
compliance.

## Evidence and recommendation contract

Keep three evidence classes separate:

1. **Retrieved evidence** — unit-level or case-level chunks returned by the
   OpenAqua retriever.
2. **Rule results** — taxonomy, disinfection, brine, energy, and other checks
   implemented in OpenAqua.
3. **Model synthesis** — proposed chains, rationale, and explanatory text.

A cited case can support plausibility but does not prove transferability to a
new source water. A rule pass means only that the implemented rule did not
reject the chain. A high rank score is not a probability of success.

Reports should preserve ordered unit operations, decomposed scores, citations,
constraint revisions, dropped alternatives, assumptions, risks, and
uncertainty. Unsupported quantitative performance claims must be omitted.
`openaqua_audit_report` can enforce this contract structurally and produce a
claim–evidence ledger, but its checks do not establish semantic entailment or
source quality.

## Machine-readable run provenance

Durable operations write a private, schema-versioned `run-manifest.json`. It
preserves:

- validated tool and operation;
- requested parameters (excluding wait controls);
- backend source, command, and adapter-reported version/revision when available;
- Harness/Node/platform identity;
- adapter-reported model, retrieval, and planning settings plus explicit non-secret environment overrides;
- regular-file input paths, sizes, timestamps, and SHA-256 hashes;
- inline query/candidate JSON byte counts and SHA-256 hashes;
- configured output path;
- stable request fingerprint;
- completion-time output content fingerprint and completeness state.

Inspect it with `openaqua_job_manifest`.

The request and result identities are separate. Schema version 2 recursively
fingerprints benchmark inputs and configured outputs within explicit entry and
byte limits, reports whether each tree hash is complete, and never follows
symbolic links. It still cannot freeze remote model behavior or replace an
immutable dataset release. A reproducible study must also preserve:

- OpenAqua Git commit/release;
- Hugging Face dataset revision or an external checksum inventory;
- processed knowledge files and generated indexes;
- OpenRouter provider-side model revision or behavior changes that cannot be frozen by a local identifier;
- prediction/result JSON;
- evaluator code revision;
- any manual curation applied to staged knowledge.

## Fair WContBench evaluation

For comparable branches:

- use the same benchmark files and split;
- use the same `top_k`, normalization policy, and evaluator revision;
- freeze the knowledge/index snapshot;
- freeze or explicitly vary model settings;
- include missing predictions and failed cases in denominators;
- report per-split and aggregate metrics;
- preserve case-level details, not only averages;
- avoid tuning on the same test split presented as final evaluation;
- use repeated runs when remote-model variability is part of the question.

Treatment-train metrics (precision, recall, F1, coverage, hit rate, and CLA) and
retrieval metrics (Precision@k, Recall@k, Hit@k) measure benchmark agreement.
They do not establish process performance or compliance.

## Knowledge curation boundary

`openaqua_ingest_knowledge` stages a regular JSON object under `data/ingest` and
can invoke index rebuilding. OpenAqua v1’s stock `IndexBuilder` reads the
canonical unit-level TDB tree and case-level `kb_cases.json`; it does not merge
staged records automatically.

A curation workflow should therefore:

1. validate source provenance and licensing;
2. validate schema and controlled vocabulary;
3. review technical claims and units;
4. merge into the appropriate canonical source through a reviewed change;
5. rebuild indexes;
6. record the new knowledge snapshot and rerun regression cases.

Do not report a staged record as active retrieval knowledge without verifying
that it appears in the generated corpus.

## Bounded observability

Jobs remain discoverable after the initiating interface closes:

- `openaqua_job_list` — recover IDs;
- `openaqua_job_status` — lifecycle and timing;
- `openaqua_job_manifest` — request provenance and output inventory;
- `openaqua_job_log` — bounded tail, error/event filtering, or cursor traversal;
- `openaqua_job_artifacts` — metadata below the explicit output path;
- `openaqua_job_cancel` — bounded graceful-to-forceful cancellation.

Keep raw logs on disk and quote only enough evidence to diagnose a failure.
Avoid busy-polling remote model or evaluation jobs.

## Handoff checklist

A complete handoff includes:

- objective, scope, and decision owner;
- source-water inputs and unit policy;
- OpenAqua, data, index, model, and evaluator identities;
- job IDs and request fingerprints;
- attempted/completed/failed/evaluable counts;
- full prediction/result files and metric tables;
- evidence and constraint summaries;
- missing data, assumptions, uncertainty, and deviations;
- limits on external validity;
- required expert, regulatory, laboratory, pilot, and site-design follow-up.

Use terms such as “computational recommendation,” “benchmark result,” or
“early-stage shortlist.” Do not call a train safe, compliant, optimal, or
field-ready without independent evidence supporting that claim.
