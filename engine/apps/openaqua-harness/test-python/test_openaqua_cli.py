from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
ADAPTER = PACKAGE_ROOT / "backend" / "openaqua_cli.py"
PRODUCT_VERSION = json.loads(
    (PACKAGE_ROOT / "package.json").read_text(encoding="utf-8")
)["version"]


class OpenAquaAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="openaqua-adapter-test-")
        self.root = Path(self.temporary.name)
        self.repo = self.root / "OpenAqua"
        self.agent = self.repo / "water_treatment_agent"
        (self.agent / "app" / "agents").mkdir(parents=True)
        (self.agent / "app" / "core").mkdir(parents=True)
        for package in (self.agent / "app", self.agent / "app" / "agents", self.agent / "app" / "core"):
            (package / "__init__.py").write_text("", encoding="utf-8")
        (self.agent / "requirements.txt").write_text("# fake checkout\n", encoding="utf-8")
        self._write_fake_core()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_version_matches_harness_beta_release(self) -> None:
        result = self._run("--version")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(
            result.stdout.startswith(f"openaqua-harness-adapter {PRODUCT_VERSION} "),
            result.stdout,
        )

    def test_identity_reports_effective_non_secret_scientific_configuration(self) -> None:
        result = self._run("identity")

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["models"]["default_model"], "fixture/default")
        self.assertEqual(payload["models"]["planner_model"], "fixture/planner")
        self.assertEqual(payload["models"]["llm_temperature"], 0.2)
        self.assertEqual(payload["retrieval"]["top_k_retrieval"], 10)
        self.assertNotIn("api_key", json.dumps(payload).lower())

    def test_normalize_keeps_stdout_machine_readable(self) -> None:
        self._write(
            self.agent / "app" / "agents" / "parser_agent.py",
            """
            class _Normalized:
                def __init__(self, query_id):
                    self.query_id = query_id

                def model_dump(self, mode="json"):
                    return {"query_id": self.query_id, "contaminants": ["Arsenic"]}


            class TaskParserAgent:
                def run(self, query):
                    print("upstream diagnostic on stdout")
                    return _Normalized(query.values.get("query_id", "generated"))
            """,
        )
        query = self.root / "query.json"
        query.write_text(json.dumps({"query_id": "fixture-query"}), encoding="utf-8")

        result = self._run("normalize", "--query-file", str(query))

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["normalized_query"]["query_id"], "fixture-query")
        self.assertIn("upstream diagnostic on stdout", result.stderr)
        self.assertNotIn("upstream diagnostic", result.stdout)

    def test_assess_case_builds_readiness_state_and_prioritized_actions(self) -> None:
        self._write(
            self.agent / "app" / "agents" / "parser_agent.py",
            """
            class _Normalized:
                def model_dump(self, mode="json"):
                    return {
                        "query_id": "arsenic-case",
                        "source_water": "groundwater",
                        "water_quality": {"arsenic_ug_L": 150.0, "extra": {}},
                        "contaminants": ["arsenic"],
                        "treatment_targets": {
                            "arsenic_ug_L": 10.0,
                            "compliance_standard": "WHO",
                            "extra": {},
                        },
                        "constraints": {
                            "brine_disposal": False,
                            "use_for_drinking": True,
                            "extra": {},
                        },
                        "context": "rural drinking-water supply",
                        "missing_fields": [],
                        "assumptions": [],
                        "normalization_notes": ["fixture"],
                    }


            class TaskParserAgent:
                def run(self, query):
                    return _Normalized()
            """,
        )
        query = self.root / "query.json"
        query.write_text(
            json.dumps(
                {
                    "source_water": "groundwater",
                    "water_quality": {"arsenic_ug_L": 150},
                    "contaminants": ["arsenic"],
                }
            ),
            encoding="utf-8",
        )

        result = self._run("assess-case", "--query-file", str(query))

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["case_state"]["schema_version"], 1)
        self.assertEqual(payload["case_state"]["query_id"], "arsenic-case")
        self.assertEqual(payload["decision_readiness"]["status"], "needs_information")
        actions = payload["decision_readiness"]["information_actions"]
        self.assertEqual(actions[0]["field"], "water_quality.pH")
        self.assertEqual(actions[0]["priority"], "high")
        self.assertIn(
            "water_quality.iron_mg_L",
            {action["field"] for action in actions},
        )
        self.assertIn(
            "not a calibrated probability",
            payload["decision_readiness"]["interpretation"],
        )

    def test_ingest_accepts_public_and_upstream_kb_type_spellings(self) -> None:
        record = self.root / "record.json"
        record.write_text(json.dumps({"case_id": "fixture/case", "value": 1}), encoding="utf-8")

        for spelling in ("kb-case", "kb_case"):
            with self.subTest(spelling=spelling):
                output = self.root / f"{spelling}.report.json"
                result = self._run(
                    "ingest",
                    "--kb-type",
                    spelling,
                    "--data-file",
                    str(record),
                    "--no-rebuild",
                    "--output",
                    str(output),
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                payload = json.loads(result.stdout)
                self.assertEqual(payload["kb_type"], "kb_case")
                self.assertFalse(payload["index_rebuilt"])
                staged = Path(payload["staged_record"])
                self.assertTrue(staged.is_file())
                self.assertEqual(json.loads(staged.read_text(encoding="utf-8"))["value"], 1)
                self.assertEqual(json.loads(output.read_text(encoding="utf-8")), payload)

    def test_audit_report_builds_claim_ledger_and_flags_structural_failures(self) -> None:
        report = self.root / "report.json"
        report.write_text(
            json.dumps(
                {
                    "query_id": "case-1",
                    "pipeline_version": "0.1.0",
                    "recommendations": [
                        {
                            "chain_id": "chain-1",
                            "chain": ["Oxidation", "Adsorption", "Chlorine"],
                            "why_it_works": "Expected effluent is 10 ug/L.",
                            "evidence": [
                                {
                                    "claim": "Adsorption is applicable.",
                                    "support_type": "evidence_backed",
                                    "source_id": "source-1",
                                    "chunk_id": "chunk-1",
                                    "text_excerpt": "Arsenic adsorption was evaluated.",
                                }
                            ],
                            "assumptions": ["Arsenic speciation remains unresolved."],
                            "constraint_report": {"overall_status": "PASS"},
                            "uncertainty": "medium",
                        },
                        {
                            "chain_id": "chain-2",
                            "chain": ["Membrane Separation"],
                            "why_it_works": "Removal is 99%.",
                            "evidence": [
                                {
                                    "claim": "Unsupported claim",
                                    "support_type": "evidence_backed",
                                    "source_id": "",
                                    "chunk_id": "",
                                    "text_excerpt": "",
                                }
                            ],
                            "assumptions": [],
                            "constraint_report": {"overall_status": "FAIL"},
                            "uncertainty": "insufficient_evidence",
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )

        result = self._run("audit-report", "--report-file", str(report))

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["kind"], "openaqua.claim-evidence-audit")
        self.assertEqual(payload["status"], "fail")
        self.assertEqual(payload["summary"]["recommendations"], 2)
        self.assertEqual(payload["summary"]["support_types"]["evidence_backed"], 2)
        self.assertGreaterEqual(payload["summary"]["critical_issues"], 2)
        self.assertTrue(
            any(claim["support_type"] == "assumption" for claim in payload["claim_ledger"])
        )
        second_issues = payload["recommendations"][1]["issues"]
        self.assertTrue(any(issue["code"] == "AUDIT-006" for issue in second_issues))
        self.assertTrue(any(issue["code"] == "AUDIT-008" for issue in second_issues))

    def test_treatment_evaluator_modules_with_dataclasses_load_correctly(self) -> None:
        self._write(
            self.repo / "test_openaqua.py",
            """
            from dataclasses import asdict, dataclass


            @dataclass
            class Summary:
                n_cases: int


            def evaluate_predictions(benchmark_dir, prediction_path):
                return {"summary": asdict(Summary(n_cases=1))}
            """,
        )
        benchmark = self.root / "benchmark"
        benchmark.mkdir()
        predictions = self.root / "predictions.json"
        predictions.write_text("[]\n", encoding="utf-8")

        result = self._run(
            "evaluate-trains",
            "--benchmark-dir",
            str(benchmark),
            "--predictions",
            str(predictions),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["summary"]["n_cases"], 1)

    def test_retrieval_evaluator_adapts_current_wcontbench_evidence_layout(self) -> None:
        self._write(
            self.repo / "test_retrieval.py",
            """
            import json


            def normalize_text(value):
                return "" if value is None else str(value).strip()


            def unique_preserve_order(values):
                return list(dict.fromkeys(value for value in values if value))


            def extract_case_id(obj, fallback=None):
                return str(obj.get("case_id") or fallback)


            def load_benchmark_cases(benchmark_dir):
                cases = {}
                for path in sorted(benchmark_dir.glob("*.json")):
                    data = json.loads(path.read_text(encoding="utf-8"))
                    case_id = extract_case_id(data, path.stem)
                    cases[case_id] = {"case_id": case_id, "gold_evidence": []}
                return cases


            def load_predictions(predictions_path):
                return json.loads(predictions_path.read_text(encoding="utf-8"))


            def evaluate_all_cases(cases, predictions, k_values):
                return {
                    "gold": cases["case-1"]["gold_evidence"],
                    "prediction_count": len(predictions),
                    "k_values": k_values,
                }
            """,
        )
        benchmark = self.root / "benchmark"
        benchmark.mkdir()
        (benchmark / "case.json").write_text(
            json.dumps(
                {
                    "case_id": "case-1",
                    "reference_answer": {
                        "ranked_recommendations": [
                            {"evidence_list": ["evidence-a", "evidence-b"]},
                            {"evidence_list": ["evidence-b", "evidence-c"]},
                        ]
                    },
                }
            ),
            encoding="utf-8",
        )
        predictions = self.root / "retrieval.json"
        predictions.write_text(json.dumps([{"case_id": "case-1"}]), encoding="utf-8")

        result = self._run(
            "evaluate-retrieval",
            "--benchmark-dir",
            str(benchmark),
            "--predictions",
            str(predictions),
            "--k",
            "1,3,3",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["gold"], ["evidence-a", "evidence-b", "evidence-c"])
        self.assertEqual(payload["k_values"], [1, 3])
        self.assertEqual(
            payload["adapter_compatibility"]["ranked_recommendation_evidence_cases"],
            1,
        )

    def _write_fake_core(self) -> None:
        self._write(
            self.agent / "app" / "core" / "schemas.py",
            """
            class UserQuery:
                def __init__(self, **values):
                    self.values = values
            """,
        )
        self._write(
            self.agent / "app" / "core" / "config.py",
            """
            from pathlib import Path


            class _Settings:
                data_dir = Path(__file__).resolve().parents[2] / "data"
                openrouter_api_key = ""
                openrouter_base_url = "https://openrouter.ai/api/v1"
                default_model = "fixture/default"
                planner_model = "fixture/planner"
                explanation_model = "fixture/explanation"
                llm_temperature = 0.2
                llm_max_tokens = 2048
                top_k_retrieval = 10
                top_k_rerank = 5
                bm25_weight = 0.4
                embedding_weight = 0.6
                embedding_model = "fixture/embedding"
                top_k_recommendations = 3
                max_planning_candidates = 5
                max_critic_iterations = 2


            _SETTINGS = _Settings()


            def get_settings():
                return _SETTINGS
            """,
        )

    def _write(self, path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(content).lstrip(), encoding="utf-8")

    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(ADAPTER), "--repo", str(self.repo), *args],
            cwd=self.root,
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )


if __name__ == "__main__":
    unittest.main()
