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

    def test_case_assessment_restores_declared_context_dropped_by_upstream(self) -> None:
        self._write_passthrough_parser()
        case = self._complete_case()
        case["water_quality"]["extra"] = {
            "arsenic_speciation": "As(V) measured",
            "hardness_basis": "as CaCO3",
        }
        case["constraints"]["extra"] = {"design_flow_m3_day": 100}

        for command in ("normalize", "assess-case"):
            with self.subTest(command=command):
                result = self._run(command, "--query-json", json.dumps(case))
                self.assertEqual(result.returncode, 0, result.stderr)
                payload = json.loads(result.stdout)
                self.assertEqual(payload["normalized_query"]["water_quality"]["extra"], case["water_quality"]["extra"])
                self.assertEqual(payload["normalized_query"]["constraints"]["extra"], case["constraints"]["extra"])
                self.assertIn("water_quality.extra.arsenic_speciation", payload["context_preservation"]["retained_fields"])
                self.assertIn("does not establish", payload["context_preservation"]["scope"])
                if command == "assess-case":
                    actions = {action["field"] for action in payload["decision_readiness"]["information_actions"]}
                    self.assertNotIn("water_quality.extra.arsenic_speciation", actions)
                    self.assertNotIn("constraints.extra.design_flow_m3_day", actions)
                    self.assertEqual(payload["case_state"]["constraints"]["extra"], case["constraints"]["extra"])
                    self.assertFalse(payload["case_state"]["design_basis"]["sizing_ready"])

    def test_case_assessment_blocks_invalid_values_and_emits_strict_json(self) -> None:
        self._write_passthrough_parser()
        for section, field, value in (
            ("water_quality", "arsenic_ug_L", -1),
            ("treatment_targets", "arsenic_ug_L", -1),
            ("water_quality", "arsenic_ug_L", "not measured"),
            ("water_quality", "arsenic_ug_L", float("nan")),
            ("water_quality", "arsenic_ug_L", float("inf")),
            ("water_quality", "arsenic_ug_L", float("-inf")),
        ):
            with self.subTest(section=section, field=field, value=value):
                case = self._complete_case()
                case[section][field] = value
                payload = self._assess(case)
                self.assertEqual(payload["decision_readiness"]["status"], "blocked")
                self.assertTrue(any(action["field"] == f"{section}.{field}" for action in payload["decision_readiness"]["critical_blockers"]))

        case = self._complete_case()
        case["water_quality"]["pH"] = 15
        payload = self._assess(case)
        self.assertEqual(payload["decision_readiness"]["status"], "needs_information")
        self.assertTrue(any(action["code"] == "CASE-PH-001" and action["priority"] == "high" for action in payload["decision_readiness"]["information_actions"]))
        self.assertEqual(payload["normalized_query"]["water_quality"]["pH"], 15)

    def test_query_input_rejects_boolean_measurements_before_upstream_numeric_coercion(self) -> None:
        self._write_passthrough_parser()
        for section, nested, field in (
            ("water_quality", False, "arsenic_ug_L"),
            ("water_quality", False, "pH"),
            ("water_quality", True, "nitrate_mg_L"),
            ("treatment_targets", False, "arsenic_ug_L"),
            ("treatment_targets", True, "lead_ug_L"),
            ("constraints", True, "design_flow_m3_day"),
        ):
            for input_kind in ("query-json", "query-file"):
                with self.subTest(section=section, nested=nested, field=field, input_kind=input_kind):
                    case = self._complete_case()
                    values = case[section].setdefault("extra", {}) if nested else case[section]
                    values[field] = True
                    if input_kind == "query-file":
                        query = self.root / "query.json"
                        query.write_text(json.dumps(case), encoding="utf-8")
                        source = str(query)
                    else:
                        source = json.dumps(case)
                    result = self._run("assess-case", f"--{input_kind}", source)
                    self.assertEqual(result.returncode, 1, result.stdout)
                    self.assertEqual(result.stdout, "")
                    error = json.loads(result.stderr)
                    expected_field = f"{section}.{'extra.' if nested else ''}{field}"
                    self.assertEqual(error["error"], "ValueError")
                    self.assertIn(expected_field, error["detail"])
                    self.assertIn("not a boolean", error["detail"])

    def test_case_assessment_still_blocks_boolean_measurements_generated_by_normalization(self) -> None:
        self._write(
            self.agent / "app" / "agents" / "parser_agent.py",
            """
            class TaskParserAgent:
                def run(self, query):
                    values = query.model_dump()
                    values["water_quality"]["arsenic_ug_L"] = True
                    return values
            """,
        )
        payload = self._assess(self._complete_case())
        self.assertEqual(payload["decision_readiness"]["status"], "blocked")
        self.assertTrue(any(action["field"] == "water_quality.arsenic_ug_L" for action in payload["decision_readiness"]["critical_blockers"]))

    def test_case_assessment_requires_matching_nitrate_bases_without_converting_values(self) -> None:
        self._write_passthrough_parser()
        case = self._complete_case()
        case["contaminants"] = ["nitrate"]
        case["water_quality"] = {"nitrate_mg_L": 60, "hardness_mg_L": 120, "extra": {}}
        case["treatment_targets"] = {"nitrate_mg_L": 30, "extra": {}}
        for influent_basis, target_basis, expected_status in (
            (None, None, "needs_information"),
            ("unknown", "as NO3", "needs_information"),
            ("as N", "as NO3", "needs_information"),
            ("as NO3", "as_NO3", "ready_for_screening"),
            ("as N", "nitrate-N", "ready_for_screening"),
        ):
            with self.subTest(influent_basis=influent_basis, target_basis=target_basis):
                case["water_quality"]["extra"]["nitrate_basis"] = influent_basis
                case["treatment_targets"]["extra"]["nitrate_basis"] = target_basis
                payload = self._assess(case)
                self.assertEqual(payload["decision_readiness"]["status"], expected_status)
                self.assertEqual(payload["normalized_query"]["water_quality"]["nitrate_mg_L"], 60)
                self.assertEqual(payload["normalized_query"]["treatment_targets"]["nitrate_mg_L"], 30)
                measurement = next(item for item in payload["case_state"]["measurements"] if item["field"] == "nitrate_mg_L")
                self.assertEqual(measurement["basis"], influent_basis)
                self.assertTrue(any(action["code"] == "CASE-HARDNESS-001" for action in payload["decision_readiness"]["information_actions"]))

    def test_case_assessment_requires_a_lead_target_and_preserves_its_unit(self) -> None:
        self._write_passthrough_parser()
        case = self._complete_case()
        case["contaminants"] = ["lead"]
        case["water_quality"] = {"lead_ug_L": 100}
        case["treatment_targets"] = {"compliance_standard": "declared study standard", "extra": {}}
        payload = self._assess(case)
        self.assertEqual(payload["decision_readiness"]["status"], "needs_information")
        self.assertTrue(any(action["field"] == "treatment_targets.extra.lead_ug_L" for action in payload["decision_readiness"]["information_actions"]))

        case["treatment_targets"]["extra"]["lead_ug_L"] = 5
        payload = self._assess(case)
        self.assertEqual(payload["decision_readiness"]["status"], "ready_for_screening")
        target = next(item for item in payload["case_state"]["treatment_targets"] if item["field"] == "extra.lead_ug_L")
        self.assertEqual((target["value"], target["unit"]), (5, "µg/L"))
        case["treatment_targets"]["extra"]["lead_ug_L"] = -1
        self.assertEqual(self._assess(case)["decision_readiness"]["status"], "blocked")

    def test_case_assessment_does_not_treat_metadata_as_measured_water_quality(self) -> None:
        self._write_passthrough_parser()
        case = self._complete_case()
        case["water_quality"] = {"extra": {"arsenic_speciation": "unknown"}}
        payload = self._assess(case)
        self.assertEqual(payload["decision_readiness"]["status"], "blocked")
        self.assertTrue(any(action["code"] == "CASE-003" for action in payload["decision_readiness"]["critical_blockers"]))

    def test_case_assessment_keeps_design_flow_separate_from_sizing_readiness(self) -> None:
        self._write_passthrough_parser()
        for flow, status, action_code in (
            (None, "ready_for_screening", "CASE-FLOW-001"),
            (0, "blocked", "CASE-FLOW-002"),
            (-5, "blocked", "CASE-FLOW-002"),
            ("20 m3/day", "blocked", "CASE-FLOW-002"),
            (20, "ready_for_screening", None),
        ):
            with self.subTest(flow=flow):
                case = self._complete_case()
                case["constraints"]["extra"]["design_flow_m3_day"] = flow
                payload = self._assess(case)
                self.assertEqual(payload["decision_readiness"]["status"], status)
                self.assertFalse(payload["case_state"]["design_basis"]["sizing_ready"])
                if action_code is not None:
                    self.assertTrue(any(action["code"] == action_code for action in payload["decision_readiness"]["information_actions"]))

    def test_documented_domain_cases_exercise_distinct_decision_gates(self) -> None:
        self._write_passthrough_parser()
        examples = PACKAGE_ROOT.parents[2] / "examples" / "cases"
        for name, status, field in (
            ("arsenic-groundwater", "ready_for_screening", "water_quality.extra.arsenic_speciation"),
            ("nitrate-basis-unknown", "needs_information", "water_quality.extra.nitrate_basis"),
            ("lead-source-unknown", "blocked", "source_water"),
        ):
            with self.subTest(name=name):
                case = json.loads((examples / f"{name}.json").read_text(encoding="utf-8"))
                payload = self._assess(case)
                self.assertEqual(payload["decision_readiness"]["status"], status)
                self.assertTrue(any(action["field"] == field for action in payload["decision_readiness"]["information_actions"]))
                self.assertEqual(payload["case_state"]["query_id"], case["query_id"])
                self.assertFalse(payload["case_state"]["design_basis"]["sizing_ready"])

    def test_recommendation_and_evidence_outputs_keep_context_without_claiming_rule_enforcement(self) -> None:
        self._write_passthrough_parser()
        self._write(
            self.agent / "app" / "agents" / "retrieval_agent.py",
            """
            class RetrievalAgent:
                def run(self, normalized):
                    assert not normalized.model_dump()["water_quality"].get("extra")
                    return {"total_retrieved": 0}
            """,
        )
        self._write(
            self.agent / "app" / "agents" / "critic_agent.py",
            """
            class ConstraintCriticAgent:
                def run(self, candidates, normalized):
                    assert not normalized.model_dump()["constraints"].get("extra")
                    return {"chain_reports": []}
            """,
        )
        self._write(self.agent / "app" / "workflows" / "__init__.py", "")
        self._write(
            self.agent / "app" / "workflows" / "pipeline.py",
            """
            from app.agents.parser_agent import TaskParserAgent


            class WaterTreatmentPipeline:
                def run(self, query, top_k):
                    return {
                        "normalized_query": TaskParserAgent().run(query).model_dump(),
                        "recommendations": [],
                    }
            """,
        )
        case = self._complete_case()
        case["water_quality"]["extra"] = {"arsenic_speciation": "unknown"}
        for command, extra_args in (
            ("recommend", ()),
            ("retrieve", ()),
            ("check-constraints", ("--candidates-json", '[["Adsorption"]]')),
        ):
            with self.subTest(command=command):
                result = self._run(command, "--query-json", json.dumps(case), *extra_args)
                self.assertEqual(result.returncode, 0, result.stderr)
                payload = json.loads(result.stdout)
                self.assertEqual(payload["normalized_query"]["water_quality"]["extra"], case["water_quality"]["extra"])
                self.assertIn("constraints.extra.design_flow_m3_day", payload["context_preservation"]["retained_fields"])
                self.assertIn("does not establish", payload["context_preservation"]["scope"])
                if command == "recommend":
                    self.assertIn("case_state", payload["case_assessment"])
                    self.assertEqual(payload["case_assessment"]["case_state"]["design_basis"]["design_flow_m3_day"], 100)

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

    def test_report_audit_rejects_empty_recommendations_and_incomplete_constraint_checks(self) -> None:
        empty = self._audit({"recommendations": []})
        self.assertEqual(empty["status"], "fail")
        self.assertEqual(empty["summary"]["recommendations"], 0)
        self.assertTrue(any(issue["code"] == "AUDIT-012" for issue in empty["issues"]))

        for status, expected in (
            ("PASS", "pass"),
            ("WARNING", "warn"),
            ("N/A", "warn"),
            ("FAIL", "fail"),
            ("WARN", "fail"),
            ("unknown", "fail"),
            (None, "fail"),
            ({"status": "PASS"}, "fail"),
        ):
            with self.subTest(status=status):
                recommendation = self._complete_recommendation()
                recommendation["constraint_report"] = {"overall_status": status}
                payload = self._audit({"recommendations": [recommendation]})
                self.assertEqual(payload["status"], expected)
                self.assertEqual(payload["recommendations"][0]["status"], expected)
        for report in ({}, None, "PASS"):
            with self.subTest(report=report):
                recommendation = self._complete_recommendation()
                recommendation["constraint_report"] = report
                self.assertEqual(self._audit({"recommendations": [recommendation]})["status"], "fail")

    def test_report_audit_never_coerces_non_text_citation_fields_into_evidence(self) -> None:
        for field, value in (
            ("claim", {"text": "a claim"}),
            ("source_id", 123),
            ("chunk_id", ["chunk-1"]),
            ("text_excerpt", True),
            ("support_type", {"type": "evidence_backed"}),
        ):
            with self.subTest(field=field):
                recommendation = self._complete_recommendation()
                recommendation["evidence"][0][field] = value
                payload = self._audit({"recommendations": [recommendation]})
                self.assertEqual(payload["status"], "fail")
                self.assertEqual(payload["summary"]["malformed_claims"], 1)
                self.assertEqual(payload["recommendations"][0]["evidence_backed_claims"], 0)
                self.assertFalse(payload["claim_ledger"][0]["structurally_complete"])

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

                def model_dump(self, mode="json"):
                    return self.values


            class CandidateChain:
                def __init__(self, **values):
                    self.values = values

                def model_dump(self, mode="json"):
                    return self.values


            class CandidatesBundle:
                def __init__(self, **values):
                    self.values = values

                def model_dump(self, mode="json"):
                    return {
                        "query_id": self.values["query_id"],
                        "candidates": [candidate.model_dump() for candidate in self.values["candidates"]],
                    }
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

    def _write_passthrough_parser(self) -> None:
        self._write(
            self.agent / "app" / "agents" / "parser_agent.py",
            """
            import copy


            class _Normalized:
                def __init__(self, values):
                    self.values = values
                    self.query_id = values["query_id"]

                def model_dump(self, mode="json"):
                    return copy.deepcopy(self.values)


            class TaskParserAgent:
                def run(self, query):
                    values = copy.deepcopy(query.values)
                    values.setdefault("query_id", "case-fixture")
                    for section in ("water_quality", "constraints"):
                        values.setdefault(section, {}).pop("extra", None)
                    return _Normalized(values)
            """,
        )

    def _complete_case(self) -> dict:
        return {
            "source_water": "groundwater",
            "contaminants": ["arsenic"],
            "water_quality": {"arsenic_ug_L": 150, "pH": 7, "iron_mg_L": 0.1},
            "treatment_targets": {"arsenic_ug_L": 10},
            "constraints": {
                "use_for_drinking": True,
                "brine_disposal": False,
                "energy": "limited",
                "operator_skill": "low",
                "chemical_dosing_allowed": True,
                "extra": {"design_flow_m3_day": 100},
            },
        }

    def _assess(self, case: dict) -> dict:
        output = self.root / "assessment.json"
        result = self._run("assess-case", "--query-json", json.dumps(case), "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)

        def reject_non_json_constant(value: str) -> None:
            self.fail(f"Non-standard numeric constant in JSON output: {value}")

        payload = json.loads(result.stdout, parse_constant=reject_non_json_constant)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"), parse_constant=reject_non_json_constant), payload)
        return payload

    def _complete_recommendation(self) -> dict:
        return {
            "chain_id": "chain-fixture",
            "chain": ["Adsorption"],
            "evidence": [{
                "claim": "A retrieved source considers adsorption.",
                "support_type": "evidence_backed",
                "source_id": "source-fixture",
                "chunk_id": "chunk-fixture",
                "text_excerpt": "Adsorption was studied under the stated conditions.",
            }],
            "constraint_report": {"overall_status": "PASS"},
            "uncertainty": "medium",
        }

    def _audit(self, report: dict) -> dict:
        path = self.root / "report.json"
        path.write_text(json.dumps(report), encoding="utf-8")
        result = self._run("audit-report", "--report-file", str(path))
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

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
