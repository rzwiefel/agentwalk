from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from parser.shared.ir import (  # noqa: E402
    CONTRACT_ID,
    ContractError,
    normalize,
    normalize_path,
    stable_json,
    validate,
)


FIXTURES = Path(__file__).parents[1] / "fixtures"


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


class ContractTests(unittest.TestCase):
    def test_all_adapter_samples_normalize_and_preserve_native_relationships(self):
        expected = {
            "python": {"contains", "calls", "inherits"},
            "csharp": {"calls", "project-references"},
            "typescript-javascript": {"requires", "mentions", "reexports"},
        }
        for adapter, kinds in expected.items():
            with self.subTest(adapter=adapter):
                document = normalize(fixture(adapter), adapter=adapter)
                self.assertEqual(document["contract"], CONTRACT_ID)
                self.assertTrue(kinds <= {item["kind"] for item in document["relationships"]})
                categories = {item["category"] for item in document["relationships"] if item.get("category")}
                self.assertTrue(categories <= {"requires", "calls", "mentions"})
                self.assertTrue(kinds <= set(document["translation"]["preserved_native_kinds"]))
                self.assertFalse(validate(document))

    def test_deterministic_output_and_path_independence(self):
        raw = fixture("typescript-javascript")
        first = normalize(raw, adapter="typescript-javascript")
        second = normalize(copy.deepcopy(raw), adapter="typescript-javascript")
        self.assertEqual(stable_json(first), stable_json(second))
        relocated = copy.deepcopy(raw)
        relocated["root"] = "/another/checkout"
        self.assertEqual(
            stable_json(first),
            stable_json(normalize(relocated, adapter="typescript-javascript")),
        )

    def test_paths_reject_absolute_and_escaping_values(self):
        for value in ("/tmp/file.py", "../outside.py", "C:/outside.py", r"src\file.py"):
            with self.subTest(value=value):
                with self.assertRaises(ContractError):
                    normalize_path(value)
        raw = fixture("python")
        raw["nodes"][0]["file"] = "../outside.py"
        with self.assertRaises(ContractError):
            normalize(raw, adapter="python")

    def test_category_validation_does_not_coerce_extensions(self):
        raw = fixture("python")
        raw["relationships"][0] = {
            "kind": "inherits",
            "source": "var:demo_pkg.models.Service",
            "target": "var:external_lib.missing",
            "resolution": "resolved",
            "category": "calls",
        }
        with self.assertRaises(ContractError):
            normalize(raw, adapter="python")
        document = normalize(fixture("python"), adapter="python")
        native = next(item for item in document["relationships"] if item["kind"] == "inherits")
        self.assertIsNone(native.get("category"))

    def test_external_and_structured_unresolved_targets(self):
        raw = fixture("python")
        raw["relationships"].append(
            {
                "kind": "calls",
                "source": "var:demo_pkg.service.make_service",
                "target": {"name": "Factory.create", "kind": "method", "package": "vendor"},
                "resolution": {"status": "ambiguous", "confidence": 0.2, "candidates": ["missing-a", "missing-b"]},
            }
        )
        document = normalize(raw, adapter="python")
        edge = next(item for item in document["relationships"] if item["resolution"]["status"] == "ambiguous")
        self.assertEqual(edge["target_ref"]["name"], "Factory.create")
        self.assertEqual(edge["target_ref"]["package"], "vendor")
        self.assertEqual(len(edge["resolution"]["candidates"]), 2)
        self.assertTrue(any(node["external"] is False for node in document["nodes"]))

    def test_coordinate_declarations_for_python_csharp_and_typescript(self):
        cases = [
            ("python", "src/demo_pkg/service.py", "utf-8-bytes", 1, 0, 1),
            ("csharp", "parser/csharp/App/Program.cs", "utf-16-code-units", 1, 0, 0),
            ("typescript-javascript", "packages/app/src/main.tsx", "utf-16-code-units", 1, 0, 1),
        ]
        for adapter, path, unit, line, column, native_line_base in cases:
            with self.subTest(adapter=adapter):
                document = normalize(fixture(adapter), adapter=adapter)
                file = next(item for item in document["files"] if item["path"] == path)
                self.assertEqual(file["coordinates"]["offset_unit"], unit)
                self.assertEqual(file["coordinates"]["line_base"], native_line_base)
                spans = [
                    item["span"]
                    for item in document["occurrences"]
                    if item["file"] == path
                ]
                if spans:
                    self.assertEqual(spans[0]["start"]["line"], line)
                    self.assertEqual(spans[0]["start"]["column"], column)

    def test_occurrence_counts_and_ownership_are_consistent(self):
        raw = fixture("typescript-javascript")
        raw["occurrences"] = [
            {
                "relationship": "e-import",
                "role": "reference",
                "file": "packages/app/src/main.tsx",
                "span": {"file": "packages/app/src/main.tsx", "start": 0, "end": 7, "row": 1, "col": 1, "endRow": 1, "endCol": 8},
                "text": "import",
            }
        ]
        document = normalize(raw, adapter="typescript-javascript")
        edge = next(item for item in document["relationships"] if item["kind"] == "requires")
        self.assertEqual(edge["occurrence_count"], 1)
        self.assertEqual(edge["occurrence_count"], len(edge["occurrence_ids"]))
        owner = next(item for item in document["analysis"]["ownership"] if item["file"] == "packages/app/src/main.tsx")
        self.assertIn(edge["id"], owner["relationship_ids"])

    def test_recoverable_diagnostics_and_fatal_invocation_status(self):
        partial = normalize(fixture("typescript-javascript"), adapter="typescript-javascript")
        self.assertEqual(partial["analysis"]["invocation_status"], "success")
        self.assertEqual(partial["analysis"]["result_status"], "partial")
        self.assertFalse(partial["analysis"]["fatal"])
        fatal = fixture("python")
        fatal["analysis"]["invocation_status"] = "fatal"
        fatal["diagnostics"] = [{"severity": "error", "fatal": True, "message": "cannot parse"}]
        document = normalize(fatal, adapter="python")
        self.assertEqual(document["analysis"]["invocation_status"], "fatal")
        self.assertEqual(document["analysis"]["result_status"], "fatal")
        self.assertTrue(document["analysis"]["fatal"])

    def test_malformed_input_is_rejected(self):
        raw = fixture("python")
        raw["relationships"] = [{"kind": "calls", "source": "missing", "target": "missing", "resolution": "resolved"}]
        with self.assertRaises(ContractError):
            normalize(raw, adapter="python")
        document = normalize(fixture("python"), adapter="python")
        broken = copy.deepcopy(document)
        broken["relationships"][0]["category"] = "inherits"
        self.assertTrue(any(item["code"] == "CATEGORY" for item in validate(broken)))


if __name__ == "__main__":
    unittest.main()
