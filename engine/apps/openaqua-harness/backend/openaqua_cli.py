#!/usr/bin/env python3
"""Stable CLI adapter between OpenAqua Harness and an OpenAqua source checkout.

The upstream OpenAqua v1 repository exposes Python modules, FastAPI routes, and
evaluation scripts rather than a single command-line entry point. This adapter
keeps the harness protocol small and versioned while importing the checkout in
place. It is shipped with the harness; the OpenAqua checkout and its Python
dependencies remain external.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.metadata
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

ADAPTER_VERSION = "0.1.0-beta.1"
CALLER_CWD = Path.cwd()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenAqua Harness backend adapter")
    parser.add_argument("--repo", required=True, help="Path to an OpenAqua source checkout")
    parser.add_argument("--version", action="store_true", help="Print adapter/backend identity")
    subparsers = parser.add_subparsers(dest="command")

    health = subparsers.add_parser("health", help="Inspect the OpenAqua runtime and data")
    health.add_argument("--json", action="store_true", help=argparse.SUPPRESS)

    subparsers.add_parser(
        "identity",
        help="Report non-secret scientific runtime and model configuration",
    )

    catalog = subparsers.add_parser("catalog", help="List contaminants and treatment units")
    catalog.add_argument("--kind", choices=("all", "contaminants", "units"), default="all")
    catalog.add_argument("--search", default="")
    catalog.add_argument("--limit", type=int, default=100)

    normalize = subparsers.add_parser("normalize", help="Normalize an OpenAqua query")
    add_query_arguments(normalize)
    normalize.add_argument("--output")

    assess = subparsers.add_parser(
        "assess-case",
        help="Build a structured case state and deterministic information-readiness audit",
    )
    add_query_arguments(assess)
    assess.add_argument("--output")

    recommend = subparsers.add_parser("recommend", help="Run the five-agent recommendation pipeline")
    add_query_arguments(recommend)
    recommend.add_argument("--top-k", type=int, default=3)
    recommend.add_argument("--output")

    retrieve = subparsers.add_parser("retrieve", help="Normalize a query and retrieve evidence")
    add_query_arguments(retrieve)
    retrieve.add_argument("--output")

    critic = subparsers.add_parser("check-constraints", help="Apply OpenAqua engineering rules")
    add_query_arguments(critic)
    critic_source = critic.add_mutually_exclusive_group(required=True)
    critic_source.add_argument("--candidates-json")
    critic_source.add_argument("--candidates-file")
    critic.add_argument("--output")

    indexes = subparsers.add_parser("build-indexes", help="Rebuild the local BM25/corpus indexes")
    indexes.add_argument("--output")

    ingest = subparsers.add_parser("ingest", help="Stage a KB record and optionally rebuild indexes")
    ingest.add_argument(
        "--kb-type",
        choices=("kb-unit", "kb-case", "kb_unit", "kb_case"),
        required=True,
    )
    ingest.add_argument("--data-file", required=True)
    ingest.add_argument("--rebuild", action=argparse.BooleanOptionalAction, default=True)
    ingest.add_argument("--output")

    train_eval = subparsers.add_parser("evaluate-trains", help="Evaluate treatment-train predictions")
    train_eval.add_argument("--benchmark-dir", required=True)
    train_eval.add_argument("--predictions", required=True)
    train_eval.add_argument("--output")

    retrieval_eval = subparsers.add_parser("evaluate-retrieval", help="Evaluate retrieval predictions")
    retrieval_eval.add_argument("--benchmark-dir", required=True)
    retrieval_eval.add_argument("--predictions", required=True)
    retrieval_eval.add_argument("--k", default="1,3,5")
    retrieval_eval.add_argument("--output")

    audit = subparsers.add_parser(
        "audit-report",
        help="Build a structural claim-evidence ledger from an OpenAqua report",
    )
    audit.add_argument("--report-file", required=True)
    audit.add_argument("--output")

    return parser


def add_query_arguments(parser: argparse.ArgumentParser) -> None:
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--query-json")
    source.add_argument("--query-file")


def resolve_repo(raw: str) -> Path:
    candidate = resolve_external_path(raw)
    if (candidate / "water_treatment_agent" / "requirements.txt").is_file():
        return candidate
    if candidate.name == "water_treatment_agent" and (candidate / "requirements.txt").is_file():
        return candidate.parent
    raise FileNotFoundError(
        f"Not an OpenAqua checkout: {candidate} (expected water_treatment_agent/requirements.txt)"
    )


def resolve_external_path(raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = CALLER_CWD / path
    return path.resolve()


def bootstrap(repo: Path) -> Path:
    model_overrides = {
        "OPENAQUA_DEFAULT_MODEL": "DEFAULT_MODEL",
        "OPENAQUA_PLANNER_MODEL": "PLANNER_MODEL",
        "OPENAQUA_EXPLANATION_MODEL": "EXPLANATION_MODEL",
    }
    common_model = os.environ.get("OPENAQUA_OPENROUTER_MODEL", "").strip()
    if common_model:
        for target in model_overrides.values():
            os.environ.setdefault(target, common_model)
    for source, target in model_overrides.items():
        value = os.environ.get(source, "").strip()
        if value:
            os.environ[target] = value

    agent_root = repo / "water_treatment_agent"
    sys.path.insert(0, str(agent_root))
    os.chdir(agent_root)
    return agent_root


def load_json_source(json_text: str | None, file_name: str | None, label: str) -> Any:
    if json_text is not None:
        return json.loads(json_text)
    if file_name is None:
        raise ValueError(f"{label} source is required")
    path = resolve_external_path(file_name)
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def model_json(model: Any) -> Any:
    if hasattr(model, "model_dump"):
        return model.model_dump(mode="json")
    return model


def write_json_file(payload: Any, output: str) -> None:
    rendered = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False)
    target = resolve_external_path(output)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(rendered)
            handle.write("\n")
        os.replace(temporary_name, target)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def emit(payload: Any, output: str | None = None) -> None:
    if output:
        write_json_file(payload, output)
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False))


def repository_revision(repo: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), "describe", "--tags", "--always", "--dirty"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
        value = result.stdout.strip()
        return value or "unknown"
    except Exception:
        return "unknown"


def dependency_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def command_health(repo: Path) -> dict[str, Any]:
    from app.core.config import get_settings

    settings = get_settings()
    index_dir = Path(settings.index_dir)
    corpus = index_dir / "corpus.jsonl"
    chunk_count = 0
    if corpus.is_file():
        with corpus.open("r", encoding="utf-8") as handle:
            chunk_count = sum(1 for _ in handle)

    taxonomy_path = Path(settings.taxonomy_path)
    unit_kb_dir = Path(settings.unit_kb_dir)
    case_kb_json = Path(settings.case_kb_json)
    dependencies = {
        name: dependency_version(name)
        for name in ("pydantic", "pydantic-settings", "openai", "rank-bm25")
    }
    indexes_available = corpus.is_file() and (index_dir / "bm25_index.pkl").is_file()
    data_ready = (
        taxonomy_path.is_file()
        and unit_kb_dir.is_dir()
        and indexes_available
        and chunk_count > 0
    )
    return {
        "ok": all(version is not None for version in dependencies.values()),
        "ready_for_recommendation": data_ready,
        "ready_for_evaluation": True,
        "adapter_version": ADAPTER_VERSION,
        "backend_revision": repository_revision(repo),
        "repo": str(repo),
        "python": sys.version.split()[0],
        "dependencies": dependencies,
        "llm": {
            "configured": bool(settings.openrouter_api_key),
            "default_model": settings.default_model,
            "planner_model": settings.planner_model,
            "explanation_model": settings.explanation_model,
        },
        "data": {
            "data_dir": str(settings.data_dir),
            "taxonomy_path": str(taxonomy_path),
            "taxonomy_available": taxonomy_path.is_file(),
            "unit_kb_dir": str(unit_kb_dir),
            "unit_kb_available": unit_kb_dir.is_dir(),
            "case_kb_json": str(case_kb_json),
            "case_kb_available": case_kb_json.is_file(),
            "index_dir": str(index_dir),
            "indexes_available": indexes_available,
            "chunk_count": chunk_count,
        },
    }


def command_identity(repo: Path) -> dict[str, Any]:
    from app.core.config import get_settings

    settings = get_settings()
    return {
        "adapter_version": ADAPTER_VERSION,
        "backend_revision": repository_revision(repo),
        "python": sys.version.split()[0],
        "models": {
            "openrouter_configured": bool(getattr(settings, "openrouter_api_key", "")),
            "default_model": getattr(settings, "default_model", None),
            "planner_model": getattr(settings, "planner_model", None),
            "explanation_model": getattr(settings, "explanation_model", None),
            "llm_temperature": getattr(settings, "llm_temperature", None),
            "llm_max_tokens": getattr(settings, "llm_max_tokens", None),
        },
        "retrieval": {
            "top_k_retrieval": getattr(settings, "top_k_retrieval", None),
            "top_k_rerank": getattr(settings, "top_k_rerank", None),
            "bm25_weight": getattr(settings, "bm25_weight", None),
            "embedding_weight": getattr(settings, "embedding_weight", None),
            "embedding_model": getattr(settings, "embedding_model", None),
        },
        "planning": {
            "top_k_recommendations": getattr(settings, "top_k_recommendations", None),
            "max_planning_candidates": getattr(settings, "max_planning_candidates", None),
            "max_critic_iterations": getattr(settings, "max_critic_iterations", None),
        },
    }


def load_user_query(args: argparse.Namespace) -> Any:
    from app.core.schemas import UserQuery

    value = load_json_source(args.query_json, args.query_file, "query")
    if not isinstance(value, dict):
        raise ValueError("query must be a JSON object")
    return UserQuery(**value)


def command_catalog(args: argparse.Namespace) -> dict[str, Any]:
    from app.core.taxonomy import get_taxonomy

    taxonomy = get_taxonomy()
    search = args.search.strip().lower()
    limit = max(1, min(args.limit, 1000))

    def filtered(values: list[str]) -> list[str]:
        matching = [value for value in values if search in value.lower()] if search else values
        return matching[:limit]

    payload: dict[str, Any] = {"search": args.search, "limit": limit}
    if args.kind in ("all", "contaminants"):
        contaminants = filtered(sorted(taxonomy.all_contaminant_ids(), key=str.lower))
        payload["contaminants"] = contaminants
        payload["contaminants_returned"] = len(contaminants)
    if args.kind in ("all", "units"):
        units = filtered(taxonomy.all_treatment_units())
        payload["treatment_units"] = units
        payload["treatment_units_returned"] = len(units)
    return payload


def command_normalize(args: argparse.Namespace) -> dict[str, Any]:
    from app.agents.parser_agent import TaskParserAgent

    normalized = TaskParserAgent().run(load_user_query(args))
    return {"normalized_query": model_json(normalized)}


_MEASUREMENT_UNITS = {
    "pH": None,
    "turbidity_NTU": "NTU",
    "arsenic_ug_L": "µg/L",
    "nitrate_mg_L": "mg/L",
    "fluoride_mg_L": "mg/L",
    "toc_mg_L": "mg/L",
    "iron_mg_L": "mg/L",
    "hardness_mg_L": "mg/L",
    "e_coli_CFU_100mL": "CFU/100 mL",
    "lead_ug_L": "µg/L",
}
_TARGET_FIELDS = {
    "arsenic": "arsenic_ug_L",
    "nitrate": "nitrate_mg_L",
    "fluoride": "fluoride_mg_L",
    "turbidity": "turbidity_NTU",
    "toc": "toc_mg_L",
    "e_coli": "e_coli",
}
_PRIORITY_ORDER = {"critical": 0, "high": 1, "medium": 2}


def _as_mapping(value: Any) -> dict[str, Any]:
    value = model_json(value)
    return value if isinstance(value, dict) else {}


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    return True


def _measurement_records(values: dict[str, Any]) -> list[dict[str, Any]]:
    records = []
    for field, value in values.items():
        if field == "extra" or not _has_value(value):
            continue
        records.append(
            {
                "field": field,
                "value": value,
                "unit": _MEASUREMENT_UNITS.get(field),
            }
        )
    extra = values.get("extra")
    if isinstance(extra, dict):
        records.extend(
            {"field": f"extra.{field}", "value": value, "unit": None}
            for field, value in sorted(extra.items())
            if _has_value(value)
        )
    return records


def _add_information_action(
    actions: list[dict[str, Any]],
    seen: set[str],
    *,
    code: str,
    field: str,
    priority: str,
    action_type: str,
    rationale: str,
    decision_impact: str,
) -> None:
    if field in seen:
        return
    seen.add(field)
    actions.append(
        {
            "code": code,
            "field": field,
            "priority": priority,
            "action_type": action_type,
            "rationale": rationale,
            "decision_impact": decision_impact,
            "basis": "deterministic_screening_rule",
        }
    )


def build_case_assessment(normalized: Any) -> dict[str, Any]:
    data = _as_mapping(normalized)
    water_quality = _as_mapping(data.get("water_quality"))
    targets = _as_mapping(data.get("treatment_targets"))
    constraints = _as_mapping(data.get("constraints"))
    contaminants = [
        str(value).strip()
        for value in data.get("contaminants", [])
        if isinstance(value, str) and value.strip()
    ]
    contaminant_set = {value.lower() for value in contaminants}
    source_water = str(data.get("source_water") or "unknown").strip() or "unknown"
    actions: list[dict[str, Any]] = []
    seen: set[str] = set()

    if source_water.lower() == "unknown":
        _add_information_action(
            actions,
            seen,
            code="CASE-001",
            field="source_water",
            priority="critical",
            action_type="clarify_context",
            rationale="The source-water type is not established.",
            decision_impact="Source-water context changes pretreatment needs and evidence transferability.",
        )
    if not contaminants:
        _add_information_action(
            actions,
            seen,
            code="CASE-002",
            field="contaminants",
            priority="critical",
            action_type="identify_contaminants",
            rationale="No contaminant was mapped to the controlled taxonomy.",
            decision_impact="A treatment train cannot be screened without a defined treatment objective.",
        )
    if not _measurement_records(water_quality):
        _add_information_action(
            actions,
            seen,
            code="CASE-003",
            field="water_quality",
            priority="critical",
            action_type="provide_measurements",
            rationale="No measured source-water values were supplied.",
            decision_impact="Concentrations and matrix conditions are needed to assess whether a technology is applicable.",
        )

    concentration_fields = {
        "arsenic": "arsenic_ug_L",
        "nitrate": "nitrate_mg_L",
        "fluoride": "fluoride_mg_L",
        "turbidity": "turbidity_NTU",
        "toc": "toc_mg_L",
        "e_coli": "e_coli_CFU_100mL",
        "lead": "lead_ug_L",
    }
    for contaminant in contaminants:
        key = contaminant.lower()
        concentration_field = concentration_fields.get(key)
        if concentration_field is not None and not _has_value(water_quality.get(concentration_field)):
            _add_information_action(
                actions,
                seen,
                code="CASE-004",
                field=f"water_quality.{concentration_field}",
                priority="high",
                action_type="measure_influent",
                rationale=f"{contaminant} is listed, but its influent value is missing.",
                decision_impact="Influent loading affects treatment intensity and whether the stated target is technically meaningful.",
            )
        target_field = _TARGET_FIELDS.get(key)
        if target_field is not None and not _has_value(targets.get(target_field)):
            _add_information_action(
                actions,
                seen,
                code="CASE-005",
                field=f"treatment_targets.{target_field}",
                priority="high",
                action_type="clarify_target",
                rationale=f"No explicit effluent target was supplied for {contaminant}.",
                decision_impact="Candidate trains cannot be compared against a declared treatment endpoint.",
            )

    target_values = [value for field, value in targets.items() if field != "extra"]
    target_extra = targets.get("extra")
    if not any(_has_value(value) for value in target_values) and not _has_value(target_extra):
        _add_information_action(
            actions,
            seen,
            code="CASE-006",
            field="treatment_targets",
            priority="high",
            action_type="clarify_target",
            rationale="The case has no measurable treatment target or named compliance standard.",
            decision_impact="A ranked recommendation without an endpoint is only a technology shortlist.",
        )

    if constraints.get("use_for_drinking") is None:
        _add_information_action(
            actions,
            seen,
            code="CASE-007",
            field="constraints.use_for_drinking",
            priority="high",
            action_type="declare_constraint",
            rationale="The intended use of the treated water is unknown.",
            decision_impact="Drinking-water use changes disinfection and review requirements.",
        )
    for field, code, impact in (
        (
            "brine_disposal",
            "CASE-008",
            "Brine-disposal availability can exclude concentration-based membrane trains.",
        ),
        (
            "energy",
            "CASE-009",
            "Energy availability changes the acceptability of energy-intensive unit operations.",
        ),
        (
            "operator_skill",
            "CASE-010",
            "Operator capacity affects whether complex treatment trains are practically supportable.",
        ),
        (
            "chemical_dosing_allowed",
            "CASE-011",
            "Chemical-use restrictions can exclude otherwise plausible oxidation, coagulation, or disinfection steps.",
        ),
    ):
        if constraints.get(field) is None:
            _add_information_action(
                actions,
                seen,
                code=code,
                field=f"constraints.{field}",
                priority="medium",
                action_type="declare_constraint",
                rationale=f"The {field.replace('_', ' ')} constraint is not declared.",
                decision_impact=impact,
            )

    if "arsenic" in contaminant_set:
        if not _has_value(water_quality.get("pH")):
            _add_information_action(
                actions,
                seen,
                code="CASE-AS-001",
                field="water_quality.pH",
                priority="high",
                action_type="measure_matrix",
                rationale="pH is missing for an arsenic-treatment case.",
                decision_impact="pH affects arsenic speciation and the applicability of adsorption and coagulation evidence.",
            )
        if not _has_value(water_quality.get("iron_mg_L")):
            _add_information_action(
                actions,
                seen,
                code="CASE-AS-002",
                field="water_quality.iron_mg_L",
                priority="medium",
                action_type="measure_matrix",
                rationale="Iron concentration is missing for an arsenic-treatment case.",
                decision_impact="Background iron can affect oxidation, co-precipitation, and adsorptive removal behavior.",
            )
    if source_water.lower() in {"surface water", "surface_water"}:
        for field, code, impact in (
            (
                "turbidity_NTU",
                "CASE-SW-001",
                "Turbidity affects pretreatment and particle-removal requirements.",
            ),
            (
                "toc_mg_L",
                "CASE-SW-002",
                "Organic carbon affects oxidant demand, adsorption competition, and by-product risk.",
            ),
        ):
            if not _has_value(water_quality.get(field)):
                _add_information_action(
                    actions,
                    seen,
                    code=code,
                    field=f"water_quality.{field}",
                    priority="medium",
                    action_type="measure_matrix",
                    rationale=f"{field} is missing for a surface-water case.",
                    decision_impact=impact,
                )

    actions.sort(key=lambda item: (_PRIORITY_ORDER[item["priority"]], item["field"]))
    critical_count = sum(action["priority"] == "critical" for action in actions)
    high_count = sum(action["priority"] == "high" for action in actions)
    status = (
        "blocked"
        if critical_count
        else "needs_information"
        if high_count
        else "ready_for_screening"
    )
    missing_fields = [
        str(value) for value in data.get("missing_fields", []) if isinstance(value, str)
    ]
    return {
        "case_state": {
            "schema_version": 1,
            "query_id": str(data.get("query_id") or "unknown"),
            "source_water": source_water,
            "contaminants": contaminants,
            "measurements": _measurement_records(water_quality),
            "treatment_targets": _measurement_records(targets),
            "constraints": {
                key: value
                for key, value in constraints.items()
                if key != "extra" and value is not None
            },
            "context": data.get("context"),
            "missing_fields": missing_fields,
            "assumptions": [
                str(value) for value in data.get("assumptions", []) if isinstance(value, str)
            ],
            "normalization_notes": [
                str(value)
                for value in data.get("normalization_notes", [])
                if isinstance(value, str)
            ],
        },
        "decision_readiness": {
            "status": status,
            "critical_blockers": [
                action for action in actions if action["priority"] == "critical"
            ],
            "information_actions": actions,
            "summary": {
                "critical": critical_count,
                "high": high_count,
                "medium": sum(action["priority"] == "medium" for action in actions),
            },
            "interpretation": (
                "This is a deterministic screening audit, not a calibrated probability of "
                "treatment success, compliance, safety, or field performance."
            ),
        },
    }


def command_assess_case(args: argparse.Namespace) -> dict[str, Any]:
    from app.agents.parser_agent import TaskParserAgent

    normalized = TaskParserAgent().run(load_user_query(args))
    return {
        "normalized_query": model_json(normalized),
        **build_case_assessment(normalized),
    }


def command_recommend(args: argparse.Namespace) -> dict[str, Any]:
    from app.workflows.pipeline import WaterTreatmentPipeline

    if not 1 <= args.top_k <= 10:
        raise ValueError("top-k must be between 1 and 10")
    report = WaterTreatmentPipeline().run(load_user_query(args), top_k=args.top_k)
    return model_json(report)


def command_retrieve(args: argparse.Namespace) -> dict[str, Any]:
    from app.agents.parser_agent import TaskParserAgent
    from app.agents.retrieval_agent import RetrievalAgent

    normalized = TaskParserAgent().run(load_user_query(args))
    retrieval = RetrievalAgent().run(normalized)
    return {
        "normalized_query": model_json(normalized),
        "retrieval": model_json(retrieval),
    }


def candidate_bundle(args: argparse.Namespace, normalized: Any) -> Any:
    from app.core.schemas import CandidateChain, CandidatesBundle

    raw = load_json_source(args.candidates_json, args.candidates_file, "candidates")
    if isinstance(raw, dict) and isinstance(raw.get("candidates"), list):
        raw = raw["candidates"]
    if not isinstance(raw, list) or not raw:
        raise ValueError("candidates must be a non-empty JSON array")

    candidates = []
    for index, item in enumerate(raw, start=1):
        if isinstance(item, list):
            item = {"chain": item}
        if not isinstance(item, dict):
            raise ValueError(f"candidate {index} must be an object or a list of unit names")
        chain = item.get("chain") or item.get("process_chain")
        if not isinstance(chain, list) or not chain or not all(isinstance(unit, str) for unit in chain):
            raise ValueError(f"candidate {index} requires a non-empty string array named chain")
        normalized_units = [unit.strip() for unit in chain if unit.strip()]
        lower_units = {unit.replace("_", " ").lower() for unit in normalized_units}
        candidates.append(
            CandidateChain(
                chain_id=str(item.get("chain_id") or f"candidate_{index}"),
                chain=normalized_units,
                key_units=item.get("key_units") or normalized_units[:3],
                rationale=str(item.get("rationale") or "User-supplied chain for rule checking"),
                energy_intensity=item.get("energy_intensity"),
                generates_brine=bool(
                    item.get("generates_brine", "membrane separation" in lower_units)
                ),
                requires_disinfection=bool(
                    item.get(
                        "requires_disinfection",
                        any(
                            token in lower_units
                            for token in (
                                "chlorine",
                                "chloramine",
                                "chlorine dioxide",
                                "ozone",
                                "ultraviolet irradiation",
                            )
                        ),
                    )
                ),
            )
        )
    return CandidatesBundle(query_id=normalized.query_id, candidates=candidates)


def command_check_constraints(args: argparse.Namespace) -> dict[str, Any]:
    from app.agents.critic_agent import ConstraintCriticAgent
    from app.agents.parser_agent import TaskParserAgent

    normalized = TaskParserAgent().run(load_user_query(args))
    candidates = candidate_bundle(args, normalized)
    report = ConstraintCriticAgent().run(candidates, normalized)
    return {
        "normalized_query": model_json(normalized),
        "candidates_after_revision": model_json(candidates),
        "constraint_report": model_json(report),
    }


def command_build_indexes() -> dict[str, Any]:
    from app.core.config import get_settings
    from app.rag.index_builder import IndexBuilder

    count = IndexBuilder().build_all()
    settings = get_settings()
    return {
        "status": "success",
        "chunks_indexed": count,
        "index_dir": str(settings.index_dir),
        "corpus": str(Path(settings.index_dir) / "corpus.jsonl"),
        "bm25_index": str(Path(settings.index_dir) / "bm25_index.pkl"),
    }


def safe_entry_id(data: dict[str, Any]) -> str:
    raw = str(data.get("id") or data.get("case_id") or "new_entry")
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("._")
    return slug[:120] or "new_entry"


def command_ingest(args: argparse.Namespace) -> dict[str, Any]:
    from app.core.config import get_settings

    data_path = resolve_external_path(args.data_file)
    with data_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("ingest data must be a JSON object")

    settings = get_settings()
    kb_type = args.kb_type.replace("-", "_")
    ingest_dir = Path(settings.data_dir) / "ingest"
    ingest_dir.mkdir(parents=True, exist_ok=True)
    target = ingest_dir / f"{kb_type}_{safe_entry_id(data)}.json"
    write_json_file(data, str(target))

    index_report = command_build_indexes() if args.rebuild else None
    return {
        "status": "success",
        "kb_type": kb_type,
        "staged_record": str(target),
        "index_rebuilt": bool(args.rebuild),
        "index_report": index_report,
        "warning": (
            "OpenAqua v1 stages ad-hoc records under data/ingest, while its stock IndexBuilder "
            "reads the canonical unit-level tree and case-level/kb_cases.json. The staged record "
            "is preserved for curation but is not automatically merged into those canonical sources."
        ),
    }


def load_script_module(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load Python module from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


def command_evaluate_trains(repo: Path, args: argparse.Namespace) -> dict[str, Any]:
    module = load_script_module(repo / "test_openaqua.py", "_openaqua_train_evaluation")
    return module.evaluate_predictions(
        resolve_external_path(args.benchmark_dir), resolve_external_path(args.predictions)
    )


def parse_k_values(raw: str) -> list[int]:
    values: list[int] = []
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        value = int(token)
        if value <= 0 or value > 1000:
            raise ValueError("k values must be between 1 and 1000")
        if value not in values:
            values.append(value)
    if not values:
        raise ValueError("at least one k value is required")
    return values


def command_evaluate_retrieval(repo: Path, args: argparse.Namespace) -> dict[str, Any]:
    module = load_script_module(repo / "test_retrieval.py", "_openaqua_retrieval_evaluation")
    benchmark_dir = resolve_external_path(args.benchmark_dir)
    cases = module.load_benchmark_cases(benchmark_dir)

    # OpenAqua's current WContBench files store evidence under
    # reference_answer.ranked_recommendations, while the bundled evaluator still
    # looks for the older candidate_solutions field. Fill only empty gold sets so
    # the adapter remains compatible with both layouts.
    adapted_cases = 0
    for path in sorted(benchmark_dir.glob("*.json")):
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            continue
        case_id = module.extract_case_id(data, fallback=path.stem)
        case = cases.get(case_id)
        if case is None or case.get("gold_evidence"):
            continue
        ranked = data.get("reference_answer", {}).get("ranked_recommendations", [])
        evidence: list[str] = []
        if isinstance(ranked, list):
            for recommendation in ranked:
                if not isinstance(recommendation, dict):
                    continue
                values = recommendation.get("evidence_list", [])
                if isinstance(values, list):
                    evidence.extend(module.normalize_text(value) for value in values)
        case["gold_evidence"] = module.unique_preserve_order(
            value for value in evidence if value
        )
        if case["gold_evidence"]:
            adapted_cases += 1

    predictions = module.load_predictions(resolve_external_path(args.predictions))
    report = module.evaluate_all_cases(cases, predictions, parse_k_values(args.k))
    report["adapter_compatibility"] = {
        "ranked_recommendation_evidence_cases": adapted_cases,
        "note": (
            "Filled empty evaluator gold sets from "
            "reference_answer.ranked_recommendations[].evidence_list."
        ),
    }
    return report


_QUANTITATIVE_CLAIM = re.compile(
    r"\b\d+(?:\.\d+)?\s*(?:%|mg/L|µg/L|ug/L|ng/L|NTU|kWh|USD|CNY)(?=$|\s|[.,;:)\]])",
    re.IGNORECASE,
)
_ALLOWED_SUPPORT_TYPES = {"evidence_backed", "system_inference", "assumption"}


def _audit_issue(
    issues: list[dict[str, Any]],
    code: str,
    severity: str,
    message: str,
    location: str,
) -> None:
    issues.append(
        {
            "code": code,
            "severity": severity,
            "message": message,
            "location": location,
        }
    )


def command_audit_report(args: argparse.Namespace) -> dict[str, Any]:
    report_path = resolve_external_path(args.report_file)
    with report_path.open("r", encoding="utf-8") as handle:
        report = json.load(handle)
    if not isinstance(report, dict):
        raise ValueError("OpenAqua report must be a JSON object")
    recommendations = report.get("recommendations")
    if not isinstance(recommendations, list):
        raise ValueError("OpenAqua report requires a recommendations array")

    claim_ledger: list[dict[str, Any]] = []
    recommendation_audits: list[dict[str, Any]] = []
    all_issues: list[dict[str, Any]] = []
    support_counts = {support_type: 0 for support_type in sorted(_ALLOWED_SUPPORT_TYPES)}
    malformed_claims = 0

    for index, recommendation in enumerate(recommendations, start=1):
        location = f"recommendations[{index - 1}]"
        issues: list[dict[str, Any]] = []
        if not isinstance(recommendation, dict):
            _audit_issue(
                issues,
                "AUDIT-001",
                "critical",
                "Recommendation is not a JSON object.",
                location,
            )
            all_issues.extend(issues)
            recommendation_audits.append(
                {"index": index, "status": "fail", "issues": issues}
            )
            continue

        chain_id = str(recommendation.get("chain_id") or f"recommendation_{index}")
        chain = recommendation.get("chain")
        if not isinstance(chain, list) or not chain or not all(
            isinstance(unit, str) and unit.strip() for unit in chain
        ):
            _audit_issue(
                issues,
                "AUDIT-002",
                "critical",
                "Recommendation has no valid ordered treatment chain.",
                f"{location}.chain",
            )

        evidence = recommendation.get("evidence")
        if not isinstance(evidence, list):
            evidence = []
            _audit_issue(
                issues,
                "AUDIT-003",
                "critical",
                "Recommendation evidence is missing or is not an array.",
                f"{location}.evidence",
            )
        evidence_backed = 0
        for evidence_index, citation in enumerate(evidence, start=1):
            citation_location = f"{location}.evidence[{evidence_index - 1}]"
            if not isinstance(citation, dict):
                malformed_claims += 1
                _audit_issue(
                    issues,
                    "AUDIT-004",
                    "critical",
                    "Evidence citation is not a JSON object.",
                    citation_location,
                )
                continue
            support_type = str(citation.get("support_type") or "").strip()
            claim = str(citation.get("claim") or "").strip()
            source_id = str(citation.get("source_id") or "").strip()
            chunk_id = str(citation.get("chunk_id") or "").strip()
            excerpt = str(citation.get("text_excerpt") or "").strip()
            valid_support = support_type in _ALLOWED_SUPPORT_TYPES
            structurally_complete = bool(claim) and valid_support
            if support_type == "evidence_backed":
                structurally_complete = structurally_complete and bool(
                    source_id and chunk_id and excerpt
                )
                if structurally_complete:
                    evidence_backed += 1
            if not structurally_complete:
                malformed_claims += 1
                _audit_issue(
                    issues,
                    "AUDIT-005",
                    "critical" if support_type == "evidence_backed" else "warning",
                    "Claim-evidence entry is structurally incomplete or has an unsupported support type.",
                    citation_location,
                )
            if valid_support:
                support_counts[support_type] += 1
            claim_ledger.append(
                {
                    "claim_id": f"{chain_id}:evidence:{evidence_index}",
                    "chain_id": chain_id,
                    "recommendation_index": index,
                    "claim": claim,
                    "support_type": support_type or "missing",
                    "source_id": source_id or None,
                    "chunk_id": chunk_id or None,
                    "text_excerpt": excerpt or None,
                    "structurally_complete": structurally_complete,
                }
            )

        assumptions = recommendation.get("assumptions")
        if isinstance(assumptions, list):
            for assumption_index, assumption in enumerate(assumptions, start=1):
                if not isinstance(assumption, str) or not assumption.strip():
                    continue
                support_counts["assumption"] += 1
                claim_ledger.append(
                    {
                        "claim_id": f"{chain_id}:assumption:{assumption_index}",
                        "chain_id": chain_id,
                        "recommendation_index": index,
                        "claim": assumption.strip(),
                        "support_type": "assumption",
                        "source_id": None,
                        "chunk_id": None,
                        "text_excerpt": None,
                        "structurally_complete": True,
                    }
                )

        why_it_works = str(recommendation.get("why_it_works") or "")
        if _QUANTITATIVE_CLAIM.search(why_it_works) and evidence_backed == 0:
            _audit_issue(
                issues,
                "AUDIT-006",
                "warning",
                "The explanatory text contains a quantitative statement but no structurally complete evidence-backed citation.",
                f"{location}.why_it_works",
            )
        if evidence_backed == 0:
            _audit_issue(
                issues,
                "AUDIT-007",
                "warning",
                "Recommendation has no structurally complete evidence-backed claim.",
                f"{location}.evidence",
            )

        constraint_report = recommendation.get("constraint_report")
        constraint_status = None
        if isinstance(constraint_report, dict):
            constraint_status = constraint_report.get("overall_status")
            if constraint_status == "FAIL":
                _audit_issue(
                    issues,
                    "AUDIT-008",
                    "critical",
                    "Recommendation retains a failed constraint report.",
                    f"{location}.constraint_report.overall_status",
                )
        else:
            _audit_issue(
                issues,
                "AUDIT-009",
                "critical",
                "Recommendation has no machine-readable constraint report.",
                f"{location}.constraint_report",
            )

        uncertainty = recommendation.get("uncertainty")
        if uncertainty in (None, ""):
            _audit_issue(
                issues,
                "AUDIT-010",
                "warning",
                "Recommendation does not declare uncertainty.",
                f"{location}.uncertainty",
            )
        elif uncertainty == "insufficient_evidence":
            _audit_issue(
                issues,
                "AUDIT-011",
                "warning",
                "Recommendation explicitly reports insufficient evidence.",
                f"{location}.uncertainty",
            )

        status = (
            "fail"
            if any(issue["severity"] == "critical" for issue in issues)
            else "warn"
            if issues
            else "pass"
        )
        recommendation_audits.append(
            {
                "index": index,
                "chain_id": chain_id,
                "status": status,
                "constraint_status": constraint_status,
                "evidence_backed_claims": evidence_backed,
                "issues": issues,
            }
        )
        all_issues.extend(issues)

    critical_count = sum(issue["severity"] == "critical" for issue in all_issues)
    warning_count = sum(issue["severity"] == "warning" for issue in all_issues)
    audit_status = "fail" if critical_count else "warn" if warning_count else "pass"
    return {
        "schema_version": 1,
        "kind": "openaqua.claim-evidence-audit",
        "report": {
            "path": str(report_path),
            "query_id": report.get("query_id"),
            "pipeline_version": report.get("pipeline_version"),
        },
        "status": audit_status,
        "summary": {
            "recommendations": len(recommendations),
            "claims": len(claim_ledger),
            "support_types": support_counts,
            "malformed_claims": malformed_claims,
            "critical_issues": critical_count,
            "warnings": warning_count,
        },
        "recommendations": recommendation_audits,
        "claim_ledger": claim_ledger,
        "limitations": [
            "This audit checks structure, declared support type, constraint status, and selected quantitative-claim signals.",
            "It does not establish semantic entailment, source quality, transferability, treatment performance, safety, or regulatory compliance.",
        ],
    }


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    repo = resolve_repo(args.repo)

    if args.version:
        print(
            f"openaqua-harness-adapter {ADAPTER_VERSION} "
            f"(OpenAqua {repository_revision(repo)}; Python {sys.version.split()[0]})"
        )
        return 0
    if args.command is None:
        parser.error("a command is required (or use --version)")

    bootstrap(repo)
    handlers: dict[str, Callable[[], dict[str, Any]]] = {
        "health": lambda: command_health(repo),
        "identity": lambda: command_identity(repo),
        "catalog": lambda: command_catalog(args),
        "normalize": lambda: command_normalize(args),
        "assess-case": lambda: command_assess_case(args),
        "recommend": lambda: command_recommend(args),
        "retrieve": lambda: command_retrieve(args),
        "check-constraints": lambda: command_check_constraints(args),
        "build-indexes": command_build_indexes,
        "ingest": lambda: command_ingest(args),
        "evaluate-trains": lambda: command_evaluate_trains(repo, args),
        "evaluate-retrieval": lambda: command_evaluate_retrieval(repo, args),
        "audit-report": lambda: command_audit_report(args),
    }
    # Upstream loggers attach to stdout. Keep stdout reserved for the adapter's
    # single JSON document so callers can parse it reliably; diagnostics remain
    # visible on stderr and in durable job logs.
    with contextlib.redirect_stdout(sys.stderr):
        payload = handlers[args.command]()
    emit(payload, getattr(args, "output", None))
    if args.command == "health" and payload.get("ok") is not True:
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(json.dumps({"ok": False, "error": "cancelled"}), file=sys.stderr)
        raise SystemExit(130)
    except Exception as error:  # The adapter must always leave a concise machine-readable failure.
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": type(error).__name__,
                    "detail": str(error),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1)
