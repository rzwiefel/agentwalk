#!/usr/bin/env python3
"""Run the shared parser IR conformance suite without a test framework."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from parser.shared.ir import normalize, stable_json, validate  # noqa: E402


def main() -> int:
    fixture_dir = Path(__file__).with_name("fixtures")
    outputs = []
    for name in ("python", "csharp", "typescript-javascript"):
        raw = json.loads((fixture_dir / f"{name}.json").read_text(encoding="utf-8"))
        first = normalize(raw, adapter=name)
        second = normalize(raw, adapter=name)
        assert stable_json(first) == stable_json(second), f"{name} is not deterministic"
        assert not validate(first), f"{name} did not validate"
        outputs.append((name, first["stats"]))
    print("conformance passed:", ", ".join(f"{name}={stats['nodes']} nodes/{stats['relationships']} relationships" for name, stats in outputs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
