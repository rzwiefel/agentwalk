from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from parser.orchestration.dispatcher import DispatcherError, analyze_repository, capabilities, detect_repository


FIXTURE_COMMAND = "{python} {dispatcher_root}/parser/orchestration/tests/fixtures/fake_adapter.py {repo_root}"


class DispatcherTests(unittest.TestCase):
    def _repo(self, *files: str) -> Path:
        root = Path(tempfile.mkdtemp())
        for name in files:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")
        return root

    def test_detection_selection_and_ambiguity(self):
        python_repo = self._repo("pyproject.toml", "src/main.py")
        self.assertEqual(detect_repository(python_repo)["selected"], "python")
        mixed_repo = self._repo("main.py", "main.cs")
        self.assertTrue(detect_repository(mixed_repo)["ambiguous"])
        self.assertIsNone(detect_repository(mixed_repo)["selected"])
        project_mixed = self._repo("pyproject.toml", "src/main.py", "app.csproj", "app.cs")
        self.assertTrue(detect_repository(project_mixed)["ambiguous"])
        self.assertIsNone(detect_repository(project_mixed)["selected"])

    def test_capabilities_reports_override(self):
        result = capabilities(self._repo("main.py"), command_overrides={"python": FIXTURE_COMMAND})
        python = next(item for item in result["adapters"] if item["name"] == "python")
        self.assertTrue(python["override"])
        self.assertEqual(result["repository"]["selected"], "python")

    def test_missing_command_and_malformed_output(self):
        root = self._repo("main.py")
        with self.assertRaisesRegex(DispatcherError, "missing"):
            try:
                analyze_repository(root, adapter="python", command_overrides={"python": "definitely-not-a-runtime {repo_root}"})
            except DispatcherError as exc:
                self.assertEqual(exc.code, "MISSING_COMMAND")
                raise
        malformed = self._write_config(root, {"adapters": {"python": {"environment": {"FAKE_MODE": "malformed"}}}})
        with self.assertRaisesRegex(DispatcherError, "malformed JSON"):
            try:
                analyze_repository(root, adapter="python", command_overrides={"python": FIXTURE_COMMAND}, config_path=malformed)
            except DispatcherError:
                raise
        nonzero_malformed = self._write_config(root, {"adapters": {"python": {"environment": {"FAKE_MODE": "nonzero-malformed"}}}})
        with self.assertRaisesRegex(DispatcherError, "exit code 7"):
            try:
                analyze_repository(root, adapter="python", command_overrides={"python": FIXTURE_COMMAND}, config_path=nonzero_malformed)
            except DispatcherError as exc:
                self.assertEqual(exc.code, "ADAPTER_NONZERO_EXIT")
                raise
        invalid_ir = self._write_config(root, {"adapters": {"python": {"environment": {"FAKE_MODE": "invalid-ir"}}}})
        with self.assertRaisesRegex(DispatcherError, "invalid codewalk.parser.ir"):
            try:
                analyze_repository(root, adapter="python", command_overrides={"python": FIXTURE_COMMAND}, config_path=invalid_ir)
            except DispatcherError as exc:
                self.assertEqual(exc.code, "INVALID_IR")
                raise

    def test_partial_nonzero_output_is_not_fatal(self):
        root = self._repo("main.py")
        graph = analyze_repository(
            root,
            adapter="python",
            command_overrides={"python": FIXTURE_COMMAND},
            config_path=self._write_config(root, {"adapters": {"python": {"environment": {"FAKE_MODE": "nonzero-partial"}}}}),
        )
        self.assertEqual(graph["analysis"]["result_status"], "partial")
        self.assertEqual(graph["analysis"]["adapter_status"], "recoverable-diagnostics")

    def test_ir_can_be_omitted_after_projection(self):
        root = self._repo("main.py")
        kwargs = {
            "adapter": "python",
            "command_overrides": {"python": FIXTURE_COMMAND},
        }
        complete = analyze_repository(root, **kwargs)
        graph_only = analyze_repository(root, include_ir=False, **kwargs)

        self.assertIn("ir", complete)
        self.assertNotIn("ir", graph_only)
        self.assertEqual({key: value for key, value in complete.items() if key != "ir"}, graph_only)

    def test_timeout_and_fatal_states(self):
        root = self._repo("main.py")
        config = self._write_config(root, {"adapters": {"python": {"environment": {"FAKE_MODE": "timeout"}},}, "timeout_seconds": 0.05})
        with self.assertRaisesRegex(DispatcherError, "timeout"):
            try:
                analyze_repository(root, adapter="python", command_overrides={"python": FIXTURE_COMMAND}, config_path=config)
            except DispatcherError as exc:
                self.assertEqual(exc.code, "ADAPTER_TIMEOUT")
                raise
        fatal_config = self._write_config(root, {"adapters": {"python": {"environment": {"FAKE_MODE": "fatal"}}}})
        graph = analyze_repository(root, adapter="python", command_overrides={"python": FIXTURE_COMMAND}, config_path=fatal_config)
        self.assertEqual(graph["analysis"]["result_status"], "fatal")
        self.assertEqual(graph["analysis"]["invocation_status"], "fatal")

    def _write_config(self, root: Path, value: dict) -> Path:
        path = root / "dispatcher.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return path


if __name__ == "__main__":
    unittest.main()
