#!/usr/bin/env python3
"""Deterministic Python parser adapter.

The adapter intentionally has no third-party runtime dependency.  It uses
``ast`` for syntax and conservative name resolution, while exposing an IR
envelope that can later carry Jedi/Pyright facts without changing the shared
Codewalk graph schema.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable

ENGINE = {
    "name": "python-stdlib-ast",
    "version": "1.0",
}
SKIP_DIRS = {
    ".git",
    ".hg",
    ".mypy_cache",
    ".pytest_cache",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
    "vendor",
}
BUILTIN_NAMES = {
    "bool", "bytes", "dict", "float", "getattr", "int", "len", "list", "object",
    "print", "set", "str", "super", "tuple", "type",
}


def _stable_id(*parts: object) -> str:
    payload = "\0".join(str(part) for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _node_id(kind: str, name: str) -> str:
    return f"{kind}:{name}"


def _source_span(node: ast.AST, text: str) -> dict[str, Any]:
    start_line = getattr(node, "lineno", 1)
    start_col = getattr(node, "col_offset", 0)
    end_line = getattr(node, "end_lineno", start_line)
    end_col = getattr(node, "end_col_offset", start_col)
    lines = text.splitlines(keepends=True)
    if 1 <= start_line <= len(lines) and 1 <= end_line <= len(lines):
        if start_line == end_line:
            snippet = lines[start_line - 1][start_col:end_col]
        else:
            snippet = lines[start_line - 1][start_col:]
            snippet += "".join(lines[start_line:end_line - 1])
            snippet += lines[end_line - 1][:end_col]
    else:
        snippet = ""
    return {
        "start": {"line": start_line, "column": start_col},
        "end": {"line": end_line, "column": end_col},
        "text": snippet,
    }


def _relative(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _is_python(path: Path) -> bool:
    return path.is_file() and path.suffix == ".py"


def _walk_files(root: Path) -> Iterable[Path]:
    if root.is_file():
        if _is_python(root):
            yield root
        return
    for child in sorted(root.iterdir(), key=lambda item: item.name):
        if child.is_dir() and child.name in SKIP_DIRS:
            continue
        if child.is_dir():
            yield from _walk_files(child)
        elif _is_python(child):
            yield child


def discover_source_roots(repo_root: str | Path, source_roots: Iterable[str | Path] | None = None) -> list[Path]:
    """Return normalized source roots, preferring explicit package boundaries.

    Explicit roots are resolved relative to ``repo_root``.  Without them,
    ``src``, ``lib``, and ``python`` are selected when present, otherwise the
    repository root is used.  The result is sorted and de-duplicated.
    """

    root = Path(repo_root).resolve()
    if source_roots:
        candidates = [
            (root / Path(item)).resolve() if not Path(item).is_absolute() else Path(item).resolve()
            for item in source_roots
        ]
    else:
        configured = [root / name for name in ("src", "lib", "python") if (root / name).is_dir()]
        candidates = configured or [root]
    unique = {path for path in candidates if path.exists()}
    return sorted(unique, key=lambda item: item.as_posix())


def _module_name(path: Path, source_root: Path) -> str:
    relative = path.resolve().relative_to(source_root.resolve())
    parts = list(relative.parts)
    if parts[-1] == "__init__.py":
        parts.pop()
        if not parts:
            parts = [source_root.name]
    else:
        parts[-1] = Path(parts[-1]).stem
    return ".".join(parts)


def _relative_module(module: str, current: str, level: int, current_is_package: bool = False) -> str:
    if level == 0:
        return module
    package = current.split(".") if current_is_package else current.split(".")[:-1]
    if level > len(package) + 1:
        return ""
    prefix = package[: len(package) - level + 1]
    return ".".join(prefix + ([module] if module else []))


def _name_text(node: ast.AST | None) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _name_text(node.value)
        return ".".join(part for part in (parent, node.attr) if part)
    return ""


def _target_names(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, (ast.Tuple, ast.List)):
        result: list[str] = []
        for element in node.elts:
            result.extend(_target_names(element))
        return result
    return []


def _fingerprint(node: ast.AST) -> str:
    """Fingerprint declaration content while excluding relocation-sensitive coordinates."""

    return hashlib.sha256(ast.dump(node, include_attributes=False).encode("utf-8")).hexdigest()[:16]


class _ModuleExtractor(ast.NodeVisitor):
    def __init__(self, module: str, filename: str, text: str, is_package: bool = False) -> None:
        self.module = module
        self.filename = filename
        self.text = text
        self.is_package = is_package
        self.scope: list[str] = []
        self.nodes: dict[str, dict[str, Any]] = {}
        self.relations: dict[tuple[str, str, str], dict[str, Any]] = {}
        self.occurrences: list[dict[str, Any]] = []
        self.aliases: dict[str, str] = {}
        self.wildcard_import = False
        self.explicit_exports: set[str] = set()
        self.diagnostics: list[dict[str, Any]] = []
        self._type_context = 0
        self.scope_ids: list[str] = []
        self.scope_bindings: list[set[str]] = []
        self.declaration_counts: dict[str, int] = {}

    @property
    def source_id(self) -> str:
        return _node_id("namespace", self.module)

    @property
    def current_id(self) -> str:
        return self.scope_ids[-1] if self.scope_ids else self.source_id

    @property
    def current_name(self) -> str:
        return ".".join(self.scope)

    def _symbol_name(self, name: str) -> str:
        parent = self.nodes[self.scope_ids[-1]]["qualified_name"] if self.scope_ids else self.module
        return f"{parent}.{name}"

    def _add_node(
        self,
        name: str,
        symbol_kind: str,
        node: ast.AST,
        *,
        exported: bool = False,
        async_fn: bool = False,
    ) -> str:
        qualified = self._symbol_name(name)
        ordinal = self.declaration_counts.get(qualified, 0) + 1
        self.declaration_counts[qualified] = ordinal
        if ordinal > 1:
            qualified = f"{qualified}#{ordinal}"
        node_id = _node_id("var", qualified)
        container = self.nodes[self.scope_ids[-1]]["qualified_name"] if self.scope_ids else self.module
        container_chain = container.split(".") if container else []
        data = {
            "id": node_id,
            "kind": "var",
            "name": name,
            "qualified_name": qualified,
            "namespace": self.module,
            "symbol_kind": symbol_kind,
            "semantic_kind": symbol_kind,
            "container": container,
            "container_chain": container_chain,
            "fingerprint": _fingerprint(node),
            "signature": {
                "fingerprint": _fingerprint(node),
                "container": container,
                "container_chain": container_chain,
            },
            "file": self.filename,
            "span": _source_span(node, self.text),
            "external": False,
            "engine": ENGINE,
        }
        if exported:
            data["exported"] = True
        if async_fn:
            data["async"] = True
            data["semantic_kind"] = "async_method" if symbol_kind == "method" else "async_function"
            data["signature"]["async"] = True
        self.nodes[node_id] = data
        self._add_relation("contains", self.current_id, node_id, node)
        span = data["span"]
        occurrence_id = f"occurrence:{_stable_id('declaration', node_id, self.filename, span['start'], span['end'])}"
        self.occurrences.append(
            {
                "id": occurrence_id,
                "node_id": node_id,
                "file": self.filename,
                "span": span,
                "role": "declaration",
                "text": span["text"],
            }
        )
        return node_id

    def _add_occurrence(self, relation_id: str, node: ast.AST) -> str:
        occurrence_id = f"occurrence:{_stable_id(relation_id, self.filename, ast.dump(node, include_attributes=True))}"
        self.occurrences.append(
            {
                "id": occurrence_id,
                "relationship": relation_id,
                "file": self.filename,
                "span": _source_span(node, self.text),
            }
        )
        return occurrence_id

    def _add_relation(
        self,
        kind: str,
        source: str,
        target: str,
        node: ast.AST,
        *,
        state: str = "resolved",
        confidence: float = 1.0,
        target_name: str | None = None,
    ) -> None:
        relation_key = (kind, source, target)
        relation = self.relations.get(relation_key)
        if relation is None:
            relation_id = f"{kind}:{_stable_id(source, target)}"
            relation = {
                "id": relation_id,
                "kind": kind,
                "source": source,
                "target": target,
                "state": state,
                "confidence": confidence,
                "engine": ENGINE,
                "occurrence_ids": [],
            }
            if target_name:
                relation["target_name"] = target_name
            self.relations[relation_key] = relation
        occurrence_id = self._add_occurrence(relation["id"], node)
        if occurrence_id not in relation["occurrence_ids"]:
            relation["occurrence_ids"].append(occurrence_id)

    def _placeholder_name(self, role: str, evidence: str) -> str:
        return f"<unresolved-{role}-{_stable_id(self.module, role, evidence)}>"

    def _unresolved_target(
        self,
        name: str,
        kind: str = "var",
        *,
        role: str = "reference",
        evidence: str = "",
    ) -> str:
        identity = name.strip() or self._placeholder_name(role, evidence)
        return _node_id(kind, f"unresolved:{self.module}:{identity}")

    def _resolve(
        self,
        name: str,
        project_symbols: set[str],
        *,
        role: str = "reference",
        evidence: str = "",
    ) -> tuple[str, str, float]:
        name = name.strip()
        if not name:
            return self._unresolved_target("", role=role, evidence=evidence), "unresolved", 0.0
        if name in BUILTIN_NAMES:
            return _node_id("var", f"builtins.{name}"), "external", 0.8
        first, _, rest = name.partition(".")
        imported = self.aliases.get(first)
        if imported:
            candidate = f"{imported}.{rest}" if rest else imported
            if candidate in project_symbols:
                return _node_id("var", candidate), "resolved", 0.95
            if candidate in self.project_namespaces:
                return _node_id("namespace", candidate), "external", 0.75
            return _node_id("var", candidate), "external", 0.65
        for scope_id in reversed(self.scope_ids):
            container = self.nodes.get(scope_id, {}).get("qualified_name")
            candidate = f"{container}.{name}" if container else ""
            if candidate in project_symbols:
                return _node_id("var", candidate), "resolved", 0.85
        for scope_id in reversed(self.scope_ids):
            if self.nodes.get(scope_id, {}).get("symbol_kind") == "class" and name.startswith("self."):
                class_name = self.nodes[scope_id]["qualified_name"]
                member_name = name.split(".", 1)[1]
                candidates = [f"{class_name}.{member_name}"]
                candidates.extend(
                    f"{relation['target'].split(':', 1)[-1]}.{member_name}"
                    for relation in self.relations.values()
                    if relation["kind"] == "inherits"
                    and relation["source"] == scope_id
                    and relation["state"] == "resolved"
                )
                for candidate in candidates:
                    if candidate in project_symbols:
                        return _node_id("var", candidate), "resolved", 0.85
        candidate = f"{self.module}.{name}"
        if candidate in project_symbols:
            return _node_id("var", candidate), "resolved", 0.9
        if self.wildcard_import:
            return self._unresolved_target(name), "ambiguous", 0.35
        return self._unresolved_target(name), "unresolved", 0.0

    def set_resolution_context(self, project_symbols: set[str], project_namespaces: set[str]) -> None:
        self.project_symbols = project_symbols
        self.project_namespaces = project_namespaces
        self.local_names = {
            node["name"]
            for node in self.nodes.values()
            if node.get("namespace") == self.module
            and "." not in node["qualified_name"][len(self.module) + 1 :]
        }

    def _reference(self, node: ast.AST, name: str, kind: str = "mentions") -> None:
        reference_name = name.strip()
        if not reference_name and isinstance(node, ast.Call):
            reference_name = _name_text(node.func)
        evidence = ast.dump(node, include_attributes=False)
        target, state, confidence = self._resolve(
            reference_name,
            self.project_symbols,
            role=kind,
            evidence=evidence,
        )
        display_name = (
            reference_name.rsplit(".", 1)[-1]
            if reference_name
            else self._placeholder_name(kind, evidence)
        )
        qualified_name = reference_name or display_name
        if target.startswith("var:unresolved:") or target.startswith("namespace:") or state == "external":
            if state != "resolved":
                identity = target.split(":", 1)[-1]
                namespace = self.module if target.startswith("var:unresolved:") else identity.rsplit(".", 1)[0] if "." in identity else identity
                if not target.startswith("var:unresolved:"):
                    qualified_name = identity
                    display_name = identity.rsplit(".", 1)[-1]
                self.nodes.setdefault(
                    target,
                    {
                        "id": target,
                        "kind": "namespace" if target.startswith("namespace:") else "var",
                        "name": display_name,
                        "qualified_name": qualified_name,
                        "namespace": namespace,
                        "semantic_kind": "external_reference",
                        "container": namespace,
                        "external": True,
                        "engine": ENGINE,
                    },
                )
                if namespace != self.module and not target.startswith("namespace:"):
                    namespace_id = _node_id("namespace", namespace)
                    self.nodes.setdefault(
                        namespace_id,
                        {
                            "id": namespace_id,
                            "kind": "namespace",
                            "name": namespace,
                            "qualified_name": namespace,
                            "namespace": namespace,
                            "external": True,
                            "engine": ENGINE,
                        },
                    )
        self._add_relation(
            kind,
            self.current_id,
            target,
            node,
            state=state,
            confidence=confidence,
            target_name=qualified_name,
        )

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            imported = alias.name
            local = alias.asname or imported.split(".")[0]
            self.aliases[local] = imported if alias.asname else local
            target = _node_id("namespace", imported)
            state = "resolved" if imported in self.project_namespaces else "external"
            self._add_relation("requires", self.source_id, target, node, state=state, confidence=1.0, target_name=imported)
            if state == "external":
                self.nodes.setdefault(
                    target,
                    {
                        "id": target,
                        "kind": "namespace",
                        "name": imported,
                        "qualified_name": imported,
                        "namespace": imported,
                        "external": True,
                        "engine": ENGINE,
                    },
                )

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        imported_module = _relative_module(node.module or "", self.module, node.level, self.is_package)
        target_name = imported_module or node.module or self._placeholder_name(
            "requires",
            ast.dump(node, include_attributes=False),
        )
        target_namespace = _node_id("namespace", target_name)
        state = "resolved" if imported_module in self.project_namespaces else "external"
        self._add_relation(
            "requires",
            self.source_id,
            target_namespace,
            node,
            state=state,
            confidence=1.0,
            target_name=target_name,
        )
        if state == "external":
            self.nodes.setdefault(
                target_namespace,
                {
                    "id": target_namespace,
                    "kind": "namespace",
                    "name": target_name,
                    "qualified_name": target_name,
                    "namespace": target_name,
                    "external": True,
                    "engine": ENGINE,
                },
            )
        for alias in node.names:
            if alias.name == "*":
                self.wildcard_import = True
                continue
            local = alias.asname or alias.name
            self.aliases[local] = f"{imported_module}.{alias.name}" if imported_module else alias.name

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_function(node, False)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_function(node, True)

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef, async_fn: bool) -> None:
        symbol_kind = "method" if self.scope and self.nodes.get(self.current_id, {}).get("symbol_kind") == "class" else "function"
        symbol_id = self._add_node(node.name, symbol_kind, node, async_fn=async_fn)
        self.scope.append(node.name)
        self.scope_ids.append(symbol_id)
        bindings = {
            argument.arg
            for argument in (
                *node.args.posonlyargs,
                *node.args.args,
                *node.args.kwonlyargs,
            )
        }
        if node.args.vararg:
            bindings.add(node.args.vararg.arg)
        if node.args.kwarg:
            bindings.add(node.args.kwarg.arg)
        self.scope_bindings.append(bindings)
        for decorator in node.decorator_list:
            self._reference(decorator, _name_text(decorator))
        self._type_context += 1
        for argument in (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs):
            if argument.annotation:
                self.visit(argument.annotation)
        if node.args.vararg and node.args.vararg.annotation:
            self.visit(node.args.vararg.annotation)
        if node.args.kwarg and node.args.kwarg.annotation:
            self.visit(node.args.kwarg.annotation)
        if node.returns:
            self.visit(node.returns)
        self._type_context -= 1
        for statement in node.body:
            self.visit(statement)
        self.scope_bindings.pop()
        self.scope_ids.pop()
        self.scope.pop()

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        class_id = self._add_node(node.name, "class", node)
        for base in node.bases:
            base_name = _name_text(base)
            target, state, confidence = self._resolve(base_name, self.project_symbols)
            if state != "resolved":
                identity = target.split(":", 1)[-1]
                namespace = (
                    self.module
                    if target.startswith("var:unresolved:")
                    else identity.rsplit(".", 1)[0]
                    if "." in identity
                    else self.module
                )
                display_name = base_name or identity.rsplit(".", 1)[-1]
                self.nodes.setdefault(
                    target,
                    {
                        "id": target,
                        "kind": "var",
                        "name": display_name,
                        "qualified_name": base_name or identity,
                        "namespace": namespace,
                        "semantic_kind": "external_reference",
                        "container": namespace,
                        "external": True,
                        "engine": ENGINE,
                    },
                )
                namespace_id = _node_id("namespace", namespace)
                self.nodes.setdefault(
                    namespace_id,
                    {
                        "id": namespace_id,
                        "kind": "namespace",
                        "name": namespace,
                        "qualified_name": namespace,
                        "namespace": namespace,
                        "external": True,
                        "engine": ENGINE,
                    },
                )
            self._add_relation("inherits", class_id, target, base, state=state, confidence=confidence, target_name=base_name)
            self._add_relation("implements", class_id, target, base, state=state, confidence=confidence, target_name=base_name)
        self.scope.append(node.name)
        self.scope_ids.append(class_id)
        self.scope_bindings.append(set())
        for decorator in node.decorator_list:
            self._reference(decorator, _name_text(decorator))
        for statement in node.body:
            self.visit(statement)
        self.scope_bindings.pop()
        self.scope_ids.pop()
        self.scope.pop()

    def visit_Assign(self, node: ast.Assign) -> None:
        if any(name == "__all__" for target in node.targets for name in _target_names(target)):
            if isinstance(node.value, (ast.List, ast.Tuple, ast.Set)):
                self.explicit_exports.update(
                    element.value for element in node.value.elts
                    if isinstance(element, ast.Constant) and isinstance(element.value, str)
                )
        for target in node.targets:
            for name in _target_names(target):
                if not self.scope or self.nodes.get(self.current_id, {}).get("symbol_kind") == "class":
                    self._add_node(name, "variable", target, exported=not name.startswith("_") and not self.scope)
                    if self.scope_bindings:
                        self.scope_bindings[-1].add(name)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        for name in _target_names(node.target):
            self._add_node(name, "variable", node.target, exported=not name.startswith("_") and not self.scope)
            if self.scope_bindings:
                self.scope_bindings[-1].add(name)
        self.visit(node.annotation)
        if node.value:
            self.visit(node.value)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load) and not any(node.id in bindings for bindings in self.scope_bindings):
            self._reference(node, node.id)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if isinstance(node.ctx, ast.Load):
            self._reference(node, _name_text(node))
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        name = _name_text(node.func)
        if name:
            self._reference(node.func, name, "calls")
        else:
            target = self._unresolved_target("<dynamic-call>")
            self.nodes.setdefault(
                target,
                {
                    "id": target,
                    "kind": "var",
                    "name": "<dynamic-call>",
                    "qualified_name": "<dynamic-call>",
                    "namespace": self.module,
                    "semantic_kind": "external_reference",
                    "container": self.module,
                    "external": True,
                    "engine": ENGINE,
                },
            )
            self._add_relation("calls", self.current_id, target, node.func, state="ambiguous", confidence=0.2, target_name="<dynamic-call>")
        self.generic_visit(node)

    def visit_AnnAssign_type(self, node: ast.AST) -> None:
        self.visit(node)

    def visit_If(self, node: ast.If) -> None:
        self.generic_visit(node)

    def visit(self, node: ast.AST) -> Any:
        if isinstance(node, (ast.arg, ast.Name)) and self._type_context:
            if isinstance(node, ast.Name):
                self._reference(node, node.id, "mentions")
        return super().visit(node)


def _parse_file(path: Path, root: Path, module: str) -> tuple[_ModuleExtractor | None, dict[str, Any] | None]:
    filename = _relative(path, root)
    try:
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text, filename=filename, type_comments=True)
    except (OSError, SyntaxError, UnicodeDecodeError) as exc:
        return None, {
            "file": filename,
            "severity": "error",
            "code": type(exc).__name__,
            "message": str(exc),
            "engine": ENGINE,
        }
    extractor = _ModuleExtractor(module, filename, text, path.name == "__init__.py")
    extractor.project_symbols = set()
    extractor.project_namespaces = set()
    extractor.local_names = set()
    extractor.visit(tree)
    return extractor, None


def _package_nodes(modules: dict[str, tuple[Path, _ModuleExtractor]], root: Path) -> dict[str, dict[str, Any]]:
    namespaces: dict[str, dict[str, Any]] = {}
    for module, (path, _) in modules.items():
        parts = module.split(".")
        for index in range(1, len(parts) + 1):
            name = ".".join(parts[:index])
            package_path = modules.get(name, (None, None))[0] if name in modules else None
            namespace_node = namespaces.setdefault(
                _node_id("namespace", name),
                {
                    "id": _node_id("namespace", name),
                    "kind": "namespace",
                    "name": name,
                    "qualified_name": name,
                    "namespace": name,
                    "namespace_kind": "package" if index < len(parts) or path.name == "__init__.py" else "module",
                    "external": False,
                    "engine": ENGINE,
                },
            )
            if package_path:
                namespace_node["file"] = _relative(package_path, root)
                namespace_node["span"] = {
                    "start": {"line": 1, "column": 0},
                    "end": {"line": 1, "column": 0},
                }
    return namespaces


def _changes_metadata(
    graph: dict[str, Any],
    changes: Iterable[dict[str, Any]] | None,
) -> dict[str, Any]:
    if not changes:
        return {"mode": "full", "changed_files": [], "ownership": {}, "invalidated": []}
    changed_files: set[str] = set()
    deleted_files: set[str] = set()
    renamed: list[dict[str, str]] = []
    for change in changes:
        kind = change.get("kind", "changed")
        path = str(change.get("path", ""))
        if path:
            changed_files.add(path)
        if kind == "deleted" and path:
            deleted_files.add(path)
        if kind == "renamed" and change.get("old_path"):
            renamed.append({"old_path": str(change["old_path"]), "new_path": path})
            changed_files.add(str(change["old_path"]))
    ownership: dict[str, list[str]] = {}
    for node in graph["nodes"]:
        filename = node.get("file")
        if filename and filename in changed_files:
            ownership.setdefault(filename, []).append(node["id"])
    ownership = {key: sorted(value) for key, value in sorted(ownership.items())}
    modules = {
        node["name"]
        for node in graph["nodes"]
        if node["kind"] == "namespace" and node.get("file") in changed_files
    }
    invalidated = set(deleted_files)
    for relation in graph["relationships"]:
        if relation["kind"] == "requires" and relation["target"].split(":", 1)[-1] in modules:
            source = next((node for node in graph["nodes"] if node["id"] == relation["source"]), None)
            if source and source.get("file"):
                invalidated.add(source["file"])
    return {
        "mode": "incremental",
        "changed_files": sorted(changed_files),
        "deleted_files": sorted(deleted_files),
        "renamed": renamed,
        "ownership": ownership,
        "invalidated": sorted(invalidated),
        "strategy": "conservative-full-reparse",
    }


def analyze_repository(
    repo_root: str | Path,
    source_roots: Iterable[str | Path] | None = None,
    *,
    changes: Iterable[dict[str, Any]] | None = None,
    previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Analyze Python files into a deterministic parser IR envelope."""

    del previous  # Reserved for a future cache; conservative reparsing is exact.
    root = Path(repo_root).resolve()
    roots = discover_source_roots(root, source_roots)
    modules: dict[str, tuple[Path, _ModuleExtractor]] = {}
    diagnostics: list[dict[str, Any]] = []
    for source_root in roots:
        for path in _walk_files(source_root):
            module = _module_name(path, source_root)
            extractor, diagnostic = _parse_file(path, root, module)
            if diagnostic:
                diagnostics.append(diagnostic)
            elif extractor:
                modules[module] = (path, extractor)

    project_namespaces = set(modules)
    project_symbols = {
        node["qualified_name"]
        for _, extractor in modules.values()
        for node in extractor.nodes.values()
        if not node.get("external")
    }
    for _, extractor in modules.values():
        extractor.set_resolution_context(project_symbols, project_namespaces)
        # Re-run import/reference resolution after all project symbols exist.
        extractor.nodes = {}
        extractor.relations = {}
        extractor.occurrences = []
        extractor.aliases = {}
        extractor.wildcard_import = False
        extractor.explicit_exports = set()
        extractor.scope = []
        extractor.scope_ids = []
        extractor.scope_bindings = []
        extractor.declaration_counts = {}
        extractor._type_context = 0
        extractor.visit(ast.parse(extractor.text, filename=extractor.filename, type_comments=True))

    namespaces = _package_nodes(modules, root)
    nodes: dict[str, dict[str, Any]] = dict(namespaces)
    relationships: dict[str, dict[str, Any]] = {}
    occurrences: list[dict[str, Any]] = []
    for _, extractor in sorted(modules.values(), key=lambda item: item[1].module):
        for node_id, node in extractor.nodes.items():
            existing = nodes.get(node_id)
            if existing is None or (existing.get("external") and not node.get("external")):
                nodes[node_id] = node
        for relation in extractor.relations.values():
            relationships[relation["id"]] = relation
        occurrences.extend(extractor.occurrences)
    for relation in relationships.values():
        relation["occurrence_ids"] = sorted(relation["occurrence_ids"])
    for node in nodes.values():
        node.setdefault("external", False)
    for relation in relationships.values():
        if relation["target"] not in nodes and relation["state"] in {"resolved", "external"}:
            target_name = relation.get("target_name", relation["target"].split(":", 1)[-1])
            target_kind = "namespace" if relation["target"].startswith("namespace:") else "var"
            target_identity = target_name
            target_namespace = (
                target_identity
                if target_kind == "namespace"
                else target_identity.rsplit(".", 1)[0]
                if "." in target_identity
                else None
            )
            nodes[relation["target"]] = {
                "id": relation["target"],
                "kind": target_kind,
                "name": target_name.rsplit(".", 1)[-1],
                "qualified_name": target_name,
                **({"namespace": target_namespace} if target_namespace else {}),
                "semantic_kind": "external_reference",
                "external": True,
                "engine": ENGINE,
            }
    # Preserve method overrides separately from inheritance.  This is limited
    # to statically resolved direct bases; dynamic MRO remains ambiguous.
    for inheritance in list(relationships.values()):
        if inheritance["kind"] != "inherits" or inheritance["state"] != "resolved":
            continue
        child = nodes.get(inheritance["source"])
        parent = nodes.get(inheritance["target"])
        if not child or not parent or child.get("symbol_kind") != "class" or parent.get("symbol_kind") != "class":
            continue
        child_prefix = child["qualified_name"] + "."
        parent_prefix = parent["qualified_name"] + "."
        child_methods = [
            node for node in nodes.values()
            if node.get("symbol_kind") == "method"
            and node.get("qualified_name", "").startswith(child_prefix)
            and "." not in node["qualified_name"][len(child_prefix):]
        ]
        for method in child_methods:
            method_name = method["name"]
            parent_method_id = _node_id("var", parent_prefix + method_name)
            if parent_method_id not in nodes:
                continue
            relation_id = f"overrides:{_stable_id(method['id'], parent_method_id)}"
            occurrence_id = f"occurrence:{_stable_id(relation_id, method['id'])}"
            relationships[relation_id] = {
                "id": relation_id,
                "kind": "overrides",
                "source": method["id"],
                "target": parent_method_id,
                "state": "resolved",
                "confidence": 0.9,
                "engine": ENGINE,
                "occurrence_ids": [occurrence_id],
            }
            occurrences.append(
                {
                    "id": occurrence_id,
                    "relationship": relation_id,
                    "file": method["file"],
                    "span": method["span"],
                }
            )
    # Export declarations are explicit relationships, including __all__.
    for module, (_, extractor) in modules.items():
        if extractor.explicit_exports:
            export_names = sorted(extractor.explicit_exports)
        else:
            export_names = sorted(
                node["qualified_name"].rsplit(".", 1)[-1]
                for node in extractor.nodes.values()
                if node.get("exported")
            )
        exported: list[dict[str, Any]] = []
        for export_name in export_names:
            target_id = _node_id("var", f"{module}.{export_name}")
            target = nodes.get(target_id)
            if target is None and export_name in extractor.aliases:
                resolved, state, confidence = extractor._resolve(export_name, project_symbols)
                target_id = resolved
                target = nodes.get(target_id)
                if target is None:
                    target = {
                        "id": target_id,
                        "kind": "var",
                        "name": export_name,
                        "qualified_name": extractor.aliases[export_name],
                        "external": state != "resolved",
                        "engine": ENGINE,
                    }
                    nodes[target_id] = target
            if target is not None:
                exported.append(target)
        for target in sorted(exported, key=lambda item: item["id"]):
            key = ("exports", _node_id("namespace", module), target["id"])
            relation_id = f"exports:{_stable_id(*key)}"
            relationships[relation_id] = {
                "id": relation_id,
                "kind": "exports",
                "source": _node_id("namespace", module),
                "target": target["id"],
                "state": "resolved",
                "confidence": 0.9,
                "engine": ENGINE,
                "occurrence_ids": [],
            }
    occurrences.sort(key=lambda item: item["id"])
    node_list = sorted(nodes.values(), key=lambda item: item["id"])
    relation_list = sorted(relationships.values(), key=lambda item: item["id"])
    graph = {
        "format": "codewalk.python.ir",
        "format_version": 2,
        "engine": ENGINE,
        "runtime": f"python-{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "repository_root": ".",
        "source_roots": [_relative(path, root) if path != root else "." for path in roots],
        "supported_extensions": [".py"],
        "nodes": node_list,
        "relationships": relation_list,
        "occurrences": occurrences,
        "diagnostics": sorted(diagnostics, key=lambda item: (item["file"], item["code"])),
    }
    graph["analysis"] = _changes_metadata(graph, changes)
    graph["stats"] = {
        "nodes": len(node_list),
        "relationships": len(relation_list),
        "occurrences": len(occurrences),
        "diagnostics": len(diagnostics),
    }
    return graph


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--source-root", action="append", default=None)
    parser.add_argument("--changes-json", help="JSON array of changed/add/delete/rename records")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    changes = json.loads(args.changes_json) if args.changes_json else None
    graph = analyze_repository(args.repo_root, args.source_root, changes=changes)
    rendered = json.dumps(graph, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
