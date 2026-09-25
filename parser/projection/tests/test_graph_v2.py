from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

from parser.projection.graph_v2 import project_graph
from parser.shared.ir import normalize, stable_json

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
from python_parser import analyze_repository  # noqa: E402


FIXTURES = Path(__file__).resolve().parents[2] / "conformance" / "fixtures"


class ProjectionTests(unittest.TestCase):
    def test_deterministic_path_independent_projection_and_ir_retention(self):
        raw = json.loads((FIXTURES / "typescript-javascript.json").read_text(encoding="utf-8"))
        first = project_graph(normalize(raw, adapter="typescript-javascript"))
        relocated = copy.deepcopy(raw)
        relocated["root"] = "/different/checkout"
        second = project_graph(normalize(relocated, adapter="typescript-javascript"))
        self.assertEqual(stable_json(first), stable_json(second))
        self.assertEqual(first["formatVersion"], 2)
        self.assertEqual(first["ir"]["contract"], "codewalk.parser.ir/1")
        graph_only = project_graph(normalize(raw, adapter="typescript-javascript"), include_ir=False)
        self.assertNotIn("ir", graph_only)
        self.assertEqual(
            {key: value for key, value in first.items() if key != "ir"},
            graph_only,
        )

    def test_only_categories_external_nodes_and_unresolved_dangling_endpoint_diagnostic(self):
        raw = json.loads((FIXTURES / "typescript-javascript.json").read_text(encoding="utf-8"))
        document = normalize(raw, adapter="typescript-javascript")
        graph = project_graph(document)
        self.assertEqual({edge["kind"] for edge in graph["edges"]}, {"requires"})
        self.assertTrue(any(node["external"] for node in graph["nodes"]))
        self.assertEqual(graph["stats"]["skippedUnresolved"], 1)
        self.assertEqual(graph["stats"]["danglingEndpoints"], 0)
        self.assertTrue(any(item["code"] == "UNRESOLVED_ENDPOINT" for item in graph["diagnostics"]))
        self.assertNotIn("reexports", {edge["kind"] for edge in graph["edges"]})

    def test_occurrence_count_and_evidence_are_projected(self):
        raw = json.loads((FIXTURES / "python.json").read_text(encoding="utf-8"))
        document = normalize(raw, adapter="python")
        graph = project_graph(document)
        node = next(node for node in graph["nodes"] if node["label"] == "make_service")
        self.assertEqual(node["occurrenceCount"], len(node["evidence"]))
        self.assertEqual(node["evidence"][0]["file"], "src/demo_pkg/service.py")

    def test_python_layout_grouping_and_semantic_declarations(self):
        raw = analyze_repository(Path(__file__).resolve().parents[2] / "python" / "fixtures", ["src"])
        document = normalize(raw, adapter="python")
        graph = project_graph(document)
        anchors = {
            node["namespace"]
            for node in graph["nodes"]
            if node["kind"] == "namespace" and node.get("namespace")
        }
        self.assertTrue({"demo_pkg", "demo_pkg.models", "demo_pkg.service", "demo_pkg.subpkg.worker"} <= anchors)
        project_nodes = [node for node in graph["nodes"] if node["kind"] == "var" and not node["external"]]
        self.assertTrue(project_nodes)
        self.assertTrue(all(node.get("namespace") in anchors for node in graph["nodes"] if node["kind"] != "namespace"))
        self.assertTrue(all(node.get("namespace") in anchors for node in project_nodes))
        self.assertTrue(all(node.get("fqn") and node.get("container") for node in project_nodes))
        self.assertTrue(all(node["container"].split(".")[0] in node["namespace"] for node in project_nodes))
        self.assertTrue(all(node["occurrenceCount"] == len(node["evidence"]) >= 1 for node in project_nodes))
        semantic_kinds = {node.get("semanticKind") for node in project_nodes}
        self.assertTrue({"class", "function", "async_function", "method", "async_method", "variable"} <= semantic_kinds)
        by_id = {node["id"]: node for node in graph["nodes"]}
        for edge in graph["edges"]:
            source = by_id[edge["source"]]
            target = by_id[edge["target"]]
            self.assertTrue(source.get("namespace"))
            self.assertTrue(target.get("namespace"))
            if edge["kind"] == "requires":
                self.assertEqual(source["kind"], "namespace")
                self.assertEqual(target["kind"], "namespace")
            else:
                self.assertIn(edge["kind"], {"calls", "mentions"})
        self.assertEqual(graph["stats"]["vars"], len([node for node in graph["nodes"] if node["kind"] == "var"]))
        self.assertEqual(graph["stats"]["namespaces"], len(anchors))

    def test_csharp_namespace_requires_keep_owners_external_targets_and_evidence(self):
        raw = copy.deepcopy(json.loads((FIXTURES / "csharp.json").read_text(encoding="utf-8")))
        raw["nodes"].extend([
            {
                "id": "namespace:app",
                "kind": "namespace",
                "name": "Sample.App",
                "fullyQualifiedName": "Sample.App",
                "namespace": "Sample.App",
                "projectId": "parser/csharp/App/App.csproj",
                "file": "parser/csharp/App/Program.cs",
            },
            {
                "id": "namespace:library",
                "kind": "namespace",
                "name": "Sample.Library",
                "fullyQualifiedName": "Sample.Library",
                "namespace": "Sample.Library",
                "projectId": "parser/csharp/Library/Library.csproj",
            },
            {
                "id": "namespace:system",
                "kind": "namespace",
                "name": "System",
                "fullyQualifiedName": "System",
                "namespace": "System",
                "projectId": "external:System",
                "isExternal": True,
            },
        ])
        raw["relationships"].extend([
            {
                "id": "r-requires",
                "kind": "requires",
                "source": "namespace:app",
                "target": "namespace:library",
                "resolution": {"status": "resolved", "confidence": 1},
                "occurrenceIds": ["o-requires"],
            },
            {
                "id": "r-external-requires",
                "kind": "requires",
                "source": "namespace:app",
                "target": "namespace:system",
                "resolution": {"status": "external", "confidence": 0.95},
                "occurrenceIds": ["o-external"],
            },
        ])
        raw["occurrences"] = [
            {
                "id": "o-requires",
                "relationshipId": "r-requires",
                "file": "parser/csharp/App/Program.cs",
                "span": {"file": "parser/csharp/App/Program.cs", "start": 0, "end": 0, "row": 1, "col": 0, "endRow": 1, "endCol": 1},
                "text": "using",
            },
            {
                "id": "o-external",
                "relationshipId": "r-external-requires",
                "file": "parser/csharp/App/Program.cs",
                "span": {"file": "parser/csharp/App/Program.cs", "start": 1, "end": 1, "row": 1, "col": 1, "endRow": 1, "endCol": 2},
                "text": "System",
            },
        ]
        first = project_graph(normalize(raw, adapter="csharp"))
        second = project_graph(normalize(raw, adapter="csharp"))
        self.assertEqual(stable_json(first), stable_json(second))
        by_id = {node["id"]: node for node in first["nodes"]}
        requires = [edge for edge in first["edges"] if edge["kind"] == "requires"]
        self.assertTrue(requires)
        self.assertTrue(all(by_id[edge["source"]]["namespace"] != "<global>" for edge in requires))
        self.assertTrue(any(by_id[edge["target"]]["external"] for edge in requires))
        self.assertTrue(all(edge["occurrenceCount"] == len(edge["evidence"]) for edge in requires))
        app = next(node for node in first["nodes"] if node["label"] == "Sample.App")
        self.assertEqual(app["projectName"], "App")
        self.assertTrue(app["projectPath"].endswith("App.csproj"))


if __name__ == "__main__":
    unittest.main()
