from __future__ import annotations

import ast
import copy
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from parser.shared.ir import normalize, stable_json, validate  # noqa: E402
from python_parser import _ModuleExtractor, _name_text, analyze_repository  # noqa: E402


FIXTURE = Path(__file__).parents[1] / "fixtures" / "unresolved_targets.py"


class UnresolvedSymbolTests(unittest.TestCase):
    def test_decorator_calls_preserve_callable_target_and_repeated_occurrences(self):
        graph = analyze_repository(FIXTURE.parent, ["."])
        target = next(
            node
            for node in graph["nodes"]
            if node.get("qualified_name") == "registry.route"
        )
        self.assertEqual(target["name"], "route")
        self.assertTrue(target["external"])
        relations = [
            relation
            for relation in graph["relationships"]
            if relation.get("target") == target["id"] and relation["kind"] == "mentions"
        ]
        self.assertEqual(len(relations), 1)
        self.assertEqual(len(relations[0]["occurrence_ids"]), 2)
        self.assertEqual(relations[0]["target_name"], "registry.route")

    def test_targetless_references_have_stable_non_empty_placeholders(self):
        first = analyze_repository(FIXTURE.parent, ["."])
        second = analyze_repository(FIXTURE.parent, ["."])
        self.assertEqual(first, second)
        placeholders = [
            node
            for node in first["nodes"]
            if node.get("external") and node.get("qualified_name", "").startswith("<unresolved-")
        ]
        self.assertTrue(placeholders)
        self.assertTrue(all(node["name"] and not node["id"].endswith(":") for node in placeholders))
        self.assertTrue(all(node["qualified_name"] for node in placeholders))

    def test_placeholder_ids_are_path_independent(self):
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as second_dir:
            first_root = Path(first_dir)
            second_root = Path(second_dir)
            shutil.copy2(FIXTURE, first_root / FIXTURE.name)
            shutil.copy2(FIXTURE, second_root / FIXTURE.name)
            first = analyze_repository(first_root, ["."])
            second = analyze_repository(second_root, ["."])
        self.assertEqual(first, second)

    def test_attribute_and_callable_name_components_are_not_empty(self):
        attribute = ast.Attribute(
            value=ast.Name(id="registry", ctx=ast.Load()),
            attr="",
            ctx=ast.Load(),
        )
        self.assertEqual(_name_text(attribute), "registry")

        extractor = _ModuleExtractor("fixture", "fixture.py", "")
        extractor.project_symbols = set()
        extractor.project_namespaces = set()
        extractor.local_names = set()
        targetless = ast.Call(func=ast.Constant(value=None), args=[], keywords=[])
        extractor._reference(targetless, "", "mentions")
        node = next(iter(extractor.nodes.values()))
        self.assertTrue(node["name"])
        self.assertFalse(node["id"].endswith(":"))

    def test_normalized_fixture_validates_and_preserves_existing_resolution_states(self):
        raw = analyze_repository(FIXTURE.parent, ["."])
        normalized = normalize(copy.deepcopy(raw), adapter="python")
        self.assertFalse(validate(normalized))
        self.assertEqual(stable_json(normalized), stable_json(normalize(raw, adapter="python")))

        existing = analyze_repository(Path(__file__).parents[1] / "fixtures", ["src"])
        states = {relation["state"] for relation in existing["relationships"]}
        self.assertTrue({"resolved", "external", "ambiguous", "unresolved"} <= states)


if __name__ == "__main__":
    unittest.main()
