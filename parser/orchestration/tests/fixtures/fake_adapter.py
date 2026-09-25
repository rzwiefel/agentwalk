#!/usr/bin/env python3
"""Small subprocess fixture used by dispatcher tests."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parents[3]
mode = os.environ.get("FAKE_MODE", "normal")
if mode == "timeout":
    time.sleep(5)
if mode == "malformed":
    print("{not-json")
    raise SystemExit(0)

fixture = json.loads((root / "conformance" / "fixtures" / "python.json").read_text(encoding="utf-8"))
if mode in {"partial", "nonzero-partial"}:
    fixture["diagnostics"] = [{"code": "FAKE", "severity": "error", "recoverable": True, "message": "compiler recovered"}]
if mode == "fatal":
    fixture["analysis"]["invocation_status"] = "fatal"
    fixture["diagnostics"] = [{"code": "FAKE", "severity": "error", "fatal": True, "recoverable": False, "message": "fatal"}]
if mode == "invalid-ir":
    fixture["nodes"][0]["file"] = "../outside.py"
if mode == "nonzero-malformed":
    print("{not-json")
    raise SystemExit(7)
print(json.dumps(fixture))
raise SystemExit(3 if mode == "nonzero-partial" else 1 if mode == "fatal" else 0)
