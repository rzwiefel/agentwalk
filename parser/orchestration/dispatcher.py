#!/usr/bin/env python3
"""Dispatch Codewalk language adapters and project their shared IR to graph-v2.

The dispatcher deliberately uses argv-based subprocesses (never a shell). Adapter
commands are registry defaults and can be replaced in a JSON config file or with
repeated ``--command adapter=...`` overrides.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from parser.projection.graph_v2 import project_graph
from parser.shared.ir import ContractError, normalize, stable_json, validate

ROOT = Path(__file__).resolve().parents[2]
CONFIG_NAME = ".codewalk-parser.json"
ADAPTER_NAMES = ("python", "csharp", "typescript-javascript")


class DispatcherError(RuntimeError):
    """An actionable adapter orchestration failure."""

    def __init__(self, code: str, message: str, *, details: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})

    def as_dict(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": str(self), "details": self.details}}


@dataclass(frozen=True)
class AdapterSpec:
    name: str
    display_name: str
    description: str
    command: tuple[str, ...]
    runtime: str
    signals: tuple[str, ...]


DEFAULT_SPECS: dict[str, AdapterSpec] = {
    "python": AdapterSpec(
        "python",
        "Python",
        "stdlib AST parser with repository-relative semantic IR",
        (
            "{python}",
            "{dispatcher_root}/parser/python/python_parser.py",
            "--repo-root",
            "{repo_root}",
        ),
        "Python 3.10+",
        ("*.py", "pyproject.toml", "setup.py", "requirements*.txt"),
    ),
    "csharp": AdapterSpec(
        "csharp",
        "C#",
        "Roslyn/MSBuild semantic parser",
        (
            "dotnet",
            "run",
            "--project",
            "{dispatcher_root}/parser/csharp/Codewalk.CSharp.csproj",
            "--",
            "{repo_root}",
            "--repo-root",
            "{repo_root}",
        ),
        ".NET SDK 9+ and MSBuild",
        ("*.cs", "*.csproj", "*.sln", "*.slnx"),
    ),
    "typescript-javascript": AdapterSpec(
        "typescript-javascript",
        "TypeScript/JavaScript",
        "TypeScript compiler API adapter via the checked-in bridge",
        (
            "node",
            "{dispatcher_root}/parser/orchestration/typescript_adapter_bridge.mjs",
            "{repo_root}",
            "{project_file}",
        ),
        "Node.js 18+; adapter dist must be built",
        (
            "*.ts",
            "*.tsx",
            "*.mts",
            "*.cts",
            "*.js",
            "*.jsx",
            "*.mjs",
            "*.cjs",
            "tsconfig.json",
            "jsconfig.json",
            "package.json",
        ),
    ),
}


def _walk_files(root: Path) -> Iterable[Path]:
    skipped = {".git", "node_modules", ".venv", "venv", "bin", "obj", "dist", "build"}
    for directory, dirs, files in os.walk(root):
        dirs[:] = sorted(name for name in dirs if name not in skipped)
        for name in sorted(files):
            yield Path(directory) / name


def _signal_score(root: Path, adapter: str) -> tuple[int, list[str]]:
    names = [path.name for path in _walk_files(root)]
    signals: list[str] = []
    score = 0
    if adapter == "python":
        py = sum(name.endswith(".py") for name in names)
        if py:
            score += min(py, 10) * 2
            signals.append(f"{py} Python source file(s)")
        for name, weight in (("pyproject.toml", 6), ("setup.py", 5)):
            if name in names:
                score += weight
                signals.append(name)
        requirement_files = sorted(name for name in names if name.startswith("requirements") and name.endswith(".txt"))
        if requirement_files:
            score += 3
            signals.extend(requirement_files)
    elif adapter == "csharp":
        cs = sum(name.endswith(".cs") for name in names)
        if cs:
            score += min(cs, 10) * 2
            signals.append(f"{cs} C# source file(s)")
        for suffix, weight in ((".sln", 10), (".slnx", 10), (".csproj", 8)):
            matches = sorted(name for name in names if name.endswith(suffix))
            if matches:
                score += weight * min(len(matches), 3)
                signals.extend(matches)
    else:
        source_suffixes = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
        source_count = sum(name.endswith(source_suffixes) for name in names)
        if source_count:
            score += min(source_count, 10) * 2
            signals.append(f"{source_count} TypeScript/JavaScript source file(s)")
        for name, weight in (("tsconfig.json", 8), ("jsconfig.json", 8), ("package.json", 5)):
            if name in names:
                score += weight
                signals.append(name)
    return score, signals


def detect_repository(repo_root: str | Path) -> dict[str, Any]:
    """Detect supported languages without reading or mutating the target."""
    root = Path(repo_root).expanduser().resolve()
    if not root.is_dir():
        raise DispatcherError("INVALID_REPOSITORY", f"Repository root is not a directory: {root}")
    scores: dict[str, int] = {}
    signals: dict[str, list[str]] = {}
    for name in ADAPTER_NAMES:
        scores[name], signals[name] = _signal_score(root, name)
    active = sorted((name for name, score in scores.items() if score), key=lambda name: (-scores[name], name))
    strong = [
        name
        for name in active
        if (
            any(
                marker in signals[name]
                for marker in (
                    "pyproject.toml",
                    "setup.py",
                    "package.json",
                    "tsconfig.json",
                    "jsconfig.json",
                )
            )
            or any(item.startswith("requirements") and item.endswith(".txt") for item in signals[name])
        )
        or any(item.endswith((".sln", ".slnx", ".csproj")) for item in signals[name])
    ]
    selected: str | None = None
    reason = "no supported language signals"
    if active:
        highest = scores[active[0]]
        tied = [name for name in active if scores[name] == highest]
        if len(strong) > 1:
            reason = "ambiguous: multiple project boundaries detected"
        elif len(tied) == 1:
            selected = tied[0]
            reason = "highest-scoring repository signals"
        else:
            reason = "ambiguous: equally strong repository signals"
    return {
        "root": ".",
        "scores": {name: scores[name] for name in ADAPTER_NAMES},
        "signals": {name: signals[name] for name in ADAPTER_NAMES},
        "candidates": active,
        "selected": selected,
        "ambiguous": bool(active and selected is None),
        "reason": reason,
    }


def _parse_command(value: Any, field: str) -> tuple[str, ...]:
    if isinstance(value, str):
        result = tuple(shlex.split(value))
    elif isinstance(value, list) and all(isinstance(item, str) for item in value):
        result = tuple(value)
    else:
        raise DispatcherError("INVALID_CONFIG", f"{field} must be a command string or argv array")
    if not result:
        raise DispatcherError("INVALID_CONFIG", f"{field} cannot be empty")
    return result


def load_config(repo_root: Path, config_path: str | Path | None = None) -> dict[str, Any]:
    path = Path(config_path).expanduser() if config_path else repo_root / CONFIG_NAME
    if not path.is_absolute():
        path = repo_root / path
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise DispatcherError("CONFIG_READ", f"Cannot read parser config {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise DispatcherError("INVALID_CONFIG", f"Parser config is not valid JSON: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise DispatcherError("INVALID_CONFIG", "Parser config root must be an object")
    return value


def _configured_spec(name: str, config: Mapping[str, Any], overrides: Mapping[str, str] | None = None) -> AdapterSpec:
    base = DEFAULT_SPECS[name]
    adapters = config.get("adapters", {})
    adapter_config = adapters.get(name, {}) if isinstance(adapters, Mapping) else {}
    if adapter_config is None:
        adapter_config = {}
    if not isinstance(adapter_config, Mapping):
        raise DispatcherError("INVALID_CONFIG", f"adapters.{name} must be an object")
    command = overrides.get(name) if overrides else None
    configured_command = command or adapter_config.get("command")
    return AdapterSpec(
        base.name,
        base.display_name,
        base.description,
        _parse_command(configured_command, f"adapters.{name}.command") if configured_command is not None else base.command,
        str(adapter_config.get("runtime") or base.runtime),
        base.signals,
    )


def capabilities(
    repo_root: str | Path | None = None,
    *,
    config_path: str | Path | None = None,
    command_overrides: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    root = Path(repo_root or ".").expanduser().resolve()
    config = load_config(root, config_path)
    detection = detect_repository(root) if root.is_dir() else {
        "root": ".",
        "scores": {name: 0 for name in ADAPTER_NAMES},
        "signals": {name: [] for name in ADAPTER_NAMES},
        "candidates": [],
        "selected": None,
        "ambiguous": False,
        "reason": "repository root is unavailable",
    }
    adapters = []
    for name in ADAPTER_NAMES:
        spec = _configured_spec(name, config, command_overrides)
        adapters.append(
            {
                "name": spec.name,
                "displayName": spec.display_name,
                "description": spec.description,
                "runtime": spec.runtime,
                "command": list(spec.command),
                "signals": list(spec.signals),
                "score": detection["scores"][name],
                "detected": bool(detection["scores"][name]),
                "override": name in (command_overrides or {}) or bool(
                    isinstance(config.get("adapters"), Mapping)
                    and isinstance(config["adapters"].get(name), Mapping)
                    and config["adapters"][name].get("command") is not None
                ),
            }
        )
    return {"command": "capabilities", "repository": detection, "adapters": adapters}


def _substitute(command: Iterable[str], *, root: Path, project_file: str | None) -> list[str]:
    values = {
        "repo_root": str(root),
        "dispatcher_root": str(ROOT),
        "project_file": str(root / project_file) if project_file else "",
        "python": sys.executable,
        "adapter": "",
    }
    return [item.format_map(values) for item in command]


def _project_file(root: Path, adapter: str) -> str | None:
    if adapter == "typescript-javascript":
        for name in ("tsconfig.json", "jsconfig.json"):
            if (root / name).is_file():
                return name
    if adapter == "csharp":
        for suffix in (".sln", ".slnx", ".csproj"):
            matches = sorted(path.relative_to(root).as_posix() for path in _walk_files(root) if path.name.endswith(suffix))
            if matches:
                return matches[0]
    return None


def _config_value(config: Mapping[str, Any], adapter: str, key: str, default: Any) -> Any:
    adapter_config = config.get("adapters", {})
    if isinstance(adapter_config, Mapping) and isinstance(adapter_config.get(adapter), Mapping):
        if key in adapter_config[adapter]:
            return adapter_config[adapter][key]
    return config.get(key, default)


def _run_adapter(
    root: Path,
    adapter: str,
    *,
    config: Mapping[str, Any],
    command_overrides: Mapping[str, str] | None,
    project_file: str | None,
    timeout: float | None,
) -> tuple[dict[str, Any], int, str]:
    if adapter not in DEFAULT_SPECS:
        raise DispatcherError("UNKNOWN_ADAPTER", f"Unsupported adapter: {adapter}")
    spec = _configured_spec(adapter, config, command_overrides)
    command = _substitute(spec.command, root=root, project_file=project_file or _project_file(root, adapter))
    working_directory = str(_config_value(config, adapter, "working_directory", str(root)))
    working_directory = working_directory.format_map(
        {"repo_root": str(root), "dispatcher_root": str(ROOT), "project_file": str(root / project_file) if project_file else "", "python": sys.executable, "adapter": adapter}
    )
    if not Path(working_directory).is_absolute():
        working_directory = str(root / working_directory)
    environment = os.environ.copy()
    configured_env = _config_value(config, adapter, "environment", _config_value(config, adapter, "env", {}))
    if configured_env is not None:
        if not isinstance(configured_env, Mapping) or not all(isinstance(k, str) and isinstance(v, str) for k, v in configured_env.items()):
            raise DispatcherError("INVALID_CONFIG", f"adapters.{adapter}.environment must map strings to strings")
        environment.update(configured_env)
    limit = timeout if timeout is not None else float(_config_value(config, adapter, "timeout_seconds", config.get("timeout_seconds", 300)))
    try:
        completed = subprocess.run(
            command,
            cwd=working_directory,
            env=environment,
            capture_output=True,
            text=True,
            timeout=limit,
            check=False,
        )
    except FileNotFoundError as exc:
        raise DispatcherError(
            "MISSING_COMMAND",
            f"Cannot start {adapter} adapter; runtime/command is missing: {command[0]}",
            details={"adapter": adapter, "command": command, "hint": f"Install the {spec.runtime} or override adapters.{adapter}.command."},
        ) from exc
    except PermissionError as exc:
        raise DispatcherError("COMMAND_PERMISSION", f"Adapter command is not executable: {command[0]}", details={"command": command}) from exc
    except subprocess.TimeoutExpired as exc:
        raise DispatcherError(
            "ADAPTER_TIMEOUT",
            f"{adapter} adapter exceeded timeout of {limit:g} seconds",
            details={"adapter": adapter, "command": command, "stdout": (exc.stdout or "")[-2000:], "stderr": (exc.stderr or "")[-2000:]},
        ) from exc
    stdout = completed.stdout.strip()
    stderr = completed.stderr.strip()
    try:
        raw = json.loads(stdout)
    except json.JSONDecodeError as exc:
        code = "ADAPTER_NONZERO_EXIT" if completed.returncode else "MALFORMED_JSON"
        if completed.returncode and ("ERR_MODULE_NOT_FOUND" in stderr or "Cannot find module" in stderr):
            code = "MISSING_ADAPTER_DEPENDENCY"
        raise DispatcherError(
            code,
            f"{adapter} adapter returned {'exit code ' + str(completed.returncode) + ' and ' if completed.returncode else ''}malformed JSON",
            details={"adapter": adapter, "command": command, "exit_code": completed.returncode, "stdout": stdout[-2000:], "stderr": stderr[-2000:]},
        ) from exc
    if not isinstance(raw, Mapping):
        raise DispatcherError("MALFORMED_OUTPUT", f"{adapter} adapter output must be a JSON object", details={"exit_code": completed.returncode})
    return dict(raw), completed.returncode, stderr


def analyze_repository(
    repo_root: str | Path,
    *,
    adapter: str | None = None,
    config_path: str | Path | None = None,
    command_overrides: Mapping[str, str] | None = None,
    project_file: str | None = None,
    timeout: float | None = None,
    include_ir: bool = True,
) -> dict[str, Any]:
    root = Path(repo_root).expanduser().resolve()
    if not root.is_dir():
        raise DispatcherError("INVALID_REPOSITORY", f"Repository root is not a directory: {root}")
    config = load_config(root, config_path)
    detection = detect_repository(root)
    selected = adapter or detection["selected"]
    if not selected:
        code = "AMBIGUOUS_REPOSITORY" if detection["ambiguous"] else "NO_ADAPTER"
        raise DispatcherError(code, f"Cannot select a parser adapter: {detection['reason']}", details=detection)
    raw, exit_code, stderr = _run_adapter(
        root,
        selected,
        config=config,
        command_overrides=command_overrides,
        project_file=project_file,
        timeout=timeout,
    )
    try:
        normalized = normalize(raw, adapter=selected)
        errors = validate(normalized)
    except (ContractError, TypeError, ValueError) as exc:
        raise DispatcherError("INVALID_IR", f"{selected} adapter emitted invalid codewalk.parser.ir/1: {exc}", details={"adapter": selected, "exit_code": exit_code}) from exc
    if errors:
        raise DispatcherError("INVALID_IR", f"{selected} adapter emitted IR that failed validation", details={"errors": errors})
    graph = project_graph(
        normalized,
        invocation={
            "adapter": selected,
            "exit_code": exit_code,
            "stderr_present": bool(stderr),
        },
        include_ir=include_ir,
    )
    graph["analysis"]["adapter_status"] = (
        "success" if exit_code == 0 else "recoverable-diagnostics" if graph["analysis"]["result_status"] == "partial" else "fatal-exit"
    )
    if exit_code and graph["analysis"]["result_status"] != "partial":
        graph["analysis"]["invocation_status"] = "fatal"
        graph["analysis"]["result_status"] = "fatal"
        graph["analysis"]["fatal"] = True
    return graph


def _write_json(path: str | Path, value: Any) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(stable_json(value), encoding="utf-8")


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    caps = subparsers.add_parser("capabilities")
    caps.add_argument("repo_root", nargs="?", default=".")
    caps.add_argument("--config")
    caps.add_argument("--command", dest="command_override", action="append", default=[], metavar="ADAPTER=COMMAND")
    analyze = subparsers.add_parser("analyze")
    analyze.add_argument("repo_root")
    analyze.add_argument("--adapter", choices=ADAPTER_NAMES)
    analyze.add_argument("--config")
    analyze.add_argument("--command", dest="command_override", action="append", default=[], metavar="ADAPTER=COMMAND")
    analyze.add_argument("--project-file")
    analyze.add_argument("--timeout", type=float)
    analyze.add_argument("--omit-ir", action="store_true")
    analyze.add_argument("--out")
    analyze.add_argument("--ir-out")
    args = parser.parse_args(argv)
    overrides: dict[str, str] = {}
    for value in args.command_override:
        name, separator, command = value.partition("=")
        if not separator or name not in ADAPTER_NAMES or not command.strip():
            parser.error(f"--command must be ADAPTER=COMMAND for one of {', '.join(ADAPTER_NAMES)}")
        overrides[name] = command
    try:
        if args.command == "capabilities":
            result = capabilities(args.repo_root, config_path=args.config, command_overrides=overrides)
        else:
            result = analyze_repository(
                args.repo_root,
                adapter=args.adapter,
                config_path=args.config,
                command_overrides=overrides,
                project_file=args.project_file,
                timeout=args.timeout,
                include_ir=not args.omit_ir or bool(args.ir_out),
            )
            if args.ir_out:
                _write_json(args.ir_out, result["ir"])
            if args.omit_ir:
                result = dict(result)
                result.pop("ir", None)
        if getattr(args, "out", None):
            _write_json(args.out, result)
        else:
            sys.stdout.write(stable_json(result))
            sys.stdout.write("\n")
        if args.command == "analyze" and result.get("analysis", {}).get("result_status") == "fatal":
            return 1
        return 0
    except DispatcherError as exc:
        sys.stderr.write(stable_json(exc.as_dict()) + "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(_main())
