import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from python_parser import analyze_repository, discover_source_roots


FIXTURES = Path(__file__).parents[1] / "fixtures"


def stable_projection(graph):
    return {
        "format": graph["format"],
        "format_version": graph["format_version"],
        "engine": graph["engine"],
        "source_roots": graph["source_roots"],
        "supported_extensions": graph["supported_extensions"],
        "nodes": [node["id"] for node in graph["nodes"]],
        "relationships": [
            [relation[key] for key in ("kind", "source", "target", "state")]
            for relation in graph["relationships"]
        ],
    }


class ParserTests(unittest.TestCase):
    def test_repeated_runs_are_deterministic(self):
        first = analyze_repository(FIXTURES, ["src"])
        second = analyze_repository(FIXTURES, ["src"])
        self.assertEqual(first, second)

    def test_package_boundaries_and_source_spans(self):
        graph = analyze_repository(FIXTURES, ["src"])
        namespaces = {node["name"]: node for node in graph["nodes"] if node["kind"] == "namespace"}
        self.assertEqual(namespaces["demo_pkg"]["namespace_kind"], "package")
        self.assertEqual(namespaces["demo_pkg.subpkg"]["namespace_kind"], "package")
        self.assertEqual(namespaces["demo_pkg.service"]["namespace_kind"], "module")
        occurrence = next(item for item in graph["occurrences"] if item["file"] == "src/demo_pkg/service.py")
        span = occurrence["span"]
        lines = (FIXTURES / occurrence["file"]).read_text().splitlines(keepends=True)
        if span["start"]["line"] == span["end"]["line"]:
            sliced = lines[span["start"]["line"] - 1][span["start"]["column"]:span["end"]["column"]]
        else:
            sliced = lines[span["start"]["line"] - 1][span["start"]["column"]:]
            sliced += "".join(lines[span["start"]["line"]:span["end"]["line"] - 1])
            sliced += lines[span["end"]["line"] - 1][:span["end"]["column"]]
        self.assertEqual(sliced, span["text"])

    def test_resolution_states_and_semantic_detail(self):
        graph = analyze_repository(FIXTURES, ["src"])
        states = {relation["state"] for relation in graph["relationships"]}
        self.assertTrue({"resolved", "external", "ambiguous", "unresolved"} <= states)
        kinds = {relation["kind"] for relation in graph["relationships"]}
        self.assertTrue(
            {"requires", "calls", "mentions", "inherits", "implements", "overrides", "contains", "exports"} <= kinds
        )
        self.assertTrue(any(node.get("async") for node in graph["nodes"]))
        self.assertTrue(any(node.get("exported") for node in graph["nodes"]))
        self.assertTrue(all("engine" in relation for relation in graph["relationships"]))

    def test_incremental_metadata_and_full_convergence(self):
        full = analyze_repository(FIXTURES, ["src"])
        incremental = analyze_repository(
            FIXTURES,
            ["src"],
            previous=full,
            changes=[
                {"kind": "changed", "path": "src/demo_pkg/models.py"},
                {"kind": "renamed", "old_path": "src/demo_pkg/old.py", "path": "src/demo_pkg/new.py"},
                {"kind": "deleted", "path": "src/demo_pkg/deleted.py"},
            ],
        )
        self.assertEqual(stable_projection(full), stable_projection(incremental))
        self.assertEqual(incremental["analysis"]["mode"], "incremental")
        self.assertIn("src/demo_pkg/models.py", incremental["analysis"]["changed_files"])
        self.assertIn("src/demo_pkg/service.py", incremental["analysis"]["invalidated"])
        self.assertEqual(incremental["analysis"]["renamed"][0]["old_path"], "src/demo_pkg/old.py")

    def test_golden_projection(self):
        graph = analyze_repository(FIXTURES, ["src"])
        golden = json.loads((Path(__file__).parents[1] / "fixtures" / "golden.json").read_text())
        self.assertEqual(stable_projection(graph), golden)

    def test_default_root_discovery(self):
        self.assertEqual([path.name for path in discover_source_roots(FIXTURES)], ["src"])

    def test_python_declarations_are_owned_and_relevant_variables_are_bounded(self):
        graph = analyze_repository(FIXTURES, ["src"])
        namespaces = {
            node["name"]
            for node in graph["nodes"]
            if node["kind"] == "namespace" and not node.get("external")
        }
        project_vars = [node for node in graph["nodes"] if node["kind"] == "var" and not node.get("external")]
        self.assertTrue(project_vars)
        self.assertTrue(all(node.get("namespace") in namespaces for node in project_vars))
        self.assertTrue(any(node.get("semantic_kind") == "async_function" for node in project_vars))
        self.assertTrue(any(node.get("semantic_kind") == "async_method" for node in project_vars))
        self.assertTrue(any(node["qualified_name"].endswith(".annotated_local") for node in project_vars))
        self.assertTrue(any(node["qualified_name"].endswith(".class_value") for node in project_vars))
        self.assertFalse(any(node["qualified_name"].endswith(".make_service.result") for node in project_vars))
        self.assertTrue(any("#2" in node["qualified_name"] for node in project_vars))

        for relation in graph["relationships"]:
            if relation["kind"] == "contains":
                source = next(node for node in graph["nodes"] if node["id"] == relation["source"])
                target = next(node for node in graph["nodes"] if node["id"] == relation["target"])
                self.assertEqual(source.get("namespace", source.get("name")), target.get("namespace"))
            if relation["kind"] == "requires":
                source = next(node for node in graph["nodes"] if node["id"] == relation["source"])
                target = next(node for node in graph["nodes"] if node["id"] == relation["target"])
                self.assertEqual(source["kind"], "namespace")
                self.assertEqual(target["kind"], "namespace")
            if relation["kind"] in {"calls", "mentions"}:
                self.assertTrue(relation["source"])
                self.assertTrue(relation["target"])

    def test_declaration_ids_survive_relocation_and_body_fingerprint_changes(self):
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as second_dir:
            first_root = Path(first_dir) / "fixture"
            second_root = Path(second_dir) / "fixture"
            shutil.copytree(FIXTURES, first_root)
            shutil.copytree(FIXTURES, second_root)
            first = analyze_repository(first_root, ["src"])
            second = analyze_repository(second_root, ["src"])
            first_declarations = {
                node["qualified_name"]: node["id"]
                for node in first["nodes"]
                if node["kind"] == "var" and not node.get("external")
            }
            second_declarations = {
                node["qualified_name"]: node["id"]
                for node in second["nodes"]
                if node["kind"] == "var" and not node.get("external")
            }
            self.assertEqual(first_declarations, second_declarations)

            source = first_root / "src/demo_pkg/semantics.py"
            source.write_text(source.read_text().replace("return nested()\n\n\nasync", "return nested() + 1\n\n\nasync"))
            changed = analyze_repository(first_root, ["src"])
            before = next(node for node in first["nodes"] if node["qualified_name"] == "demo_pkg.semantics.outer")
            after = next(node for node in changed["nodes"] if node["qualified_name"] == "demo_pkg.semantics.outer")
            self.assertEqual(before["id"], after["id"])
            self.assertNotEqual(before["fingerprint"], after["fingerprint"])
            incremental = analyze_repository(
                first_root,
                ["src"],
                previous=first,
                changes=[{"kind": "changed", "path": "src/demo_pkg/semantics.py"}],
            )
            owned = incremental["analysis"]["ownership"]["src/demo_pkg/semantics.py"]
            self.assertIn(before["id"], owned)


if __name__ == "__main__":
    unittest.main()
