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
