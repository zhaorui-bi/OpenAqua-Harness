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

    catalog = subparsers.add_parser("catalog", help="List contaminants and treatment units")
    catalog.add_argument("--kind", choices=("all", "contaminants", "units"), default="all")
    catalog.add_argument("--search", default="")
    catalog.add_argument("--limit", type=int, default=100)

    normalize = subparsers.add_parser("normalize", help="Normalize an OpenAqua query")
    add_query_arguments(normalize)
    normalize.add_argument("--output")

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
        "catalog": lambda: command_catalog(args),
        "normalize": lambda: command_normalize(args),
        "recommend": lambda: command_recommend(args),
        "retrieve": lambda: command_retrieve(args),
        "check-constraints": lambda: command_check_constraints(args),
        "build-indexes": command_build_indexes,
        "ingest": lambda: command_ingest(args),
        "evaluate-trains": lambda: command_evaluate_trains(repo, args),
        "evaluate-retrieval": lambda: command_evaluate_retrieval(repo, args),
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
