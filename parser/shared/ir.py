"""Stdlib runtime for the executable ``codewalk.parser.ir/1`` contract.

The adapters intentionally keep their native output shapes.  ``normalize`` is
the boundary that makes those outputs portable and deterministic without
discarding semantic relationship kinds or native coordinate declarations.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import sys
from typing import Any, Iterable, Mapping

CONTRACT_ID = "codewalk.parser.ir/1"
CONTRACT_VERSION = 1
RELATIONSHIP_CATEGORIES = frozenset({"requires", "calls", "mentions"})
RESOLUTION_STATES = frozenset({"resolved", "external", "ambiguous", "unresolved"})
ANALYSIS_MODES = frozenset({"full", "incremental"})
INVOCATION_STATUSES = frozenset({"success", "fatal"})
RESULT_STATUSES = frozenset({"complete", "partial", "fatal"})
NATIVE_RELATIONSHIP_KINDS = frozenset(
    {
        "requires",
        "calls",
        "mentions",
        "inherits",
        "implements",
        "exports",
        "reexports",
        "overrides",
        "contains",
        "project-references",
        "type-reference",
        "jsx",
    }
)
_DRIVE_PATH = re.compile(r"^[A-Za-z]:[\\/]")
_WINDOWS_UNC = re.compile(r"^(?:\\\\|//)")
_IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]*$")
_TRANSLATION_LEDGER = {
    "python": {
        "native_kinds": ["requires", "calls", "mentions", "inherits", "implements", "overrides", "contains", "exports"],
        "category_kinds": ["requires", "calls", "mentions"],
        "translation_gaps": ["inherits", "implements", "overrides", "contains", "exports"],
    },
    "csharp": {
        "native_kinds": ["requires", "calls", "mentions", "inherits", "implements", "overrides", "contains", "project-references"],
        "category_kinds": ["requires", "calls", "mentions"],
        "translation_gaps": ["inherits", "implements", "overrides", "contains", "project-references"],
    },
    "typescript-javascript": {
        "native_kinds": ["requires", "calls", "mentions", "extends", "implements", "exports", "reexports", "overrides", "contains", "type-reference", "jsx"],
        "category_kinds": ["requires", "calls", "mentions"],
        "translation_gaps": ["extends", "implements", "exports", "reexports", "overrides", "contains", "type-reference", "jsx"],
    },
}


class ContractError(ValueError):
    """Raised when input cannot be represented as a valid contract document."""

    def __init__(self, message: str, diagnostics: Iterable[Mapping[str, Any]] = ()) -> None:
        super().__init__(message)
        self.diagnostics = tuple(dict(item) for item in diagnostics)


def _stable_id(prefix: str, *parts: Any) -> str:
    payload = json.dumps([prefix, *parts], ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return f"{prefix}:{hashlib.sha256(payload.encode('utf-8')).hexdigest()[:24]}"


def stable_json(value: Any) -> str:
    """Serialize a contract using stable key and compact-array ordering."""

    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n"


def _as_mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractError(f"{field} must be an object")
    return value


def _as_list(value: Any, field: str) -> list[Any]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ContractError(f"{field} must be an array")
    return value


def _ordered_unique(values: Iterable[str]) -> list[str]:
    return sorted(set(values))


def normalize_path(value: Any, field: str = "path") -> str:
    """Validate and normalize a repository-relative POSIX path.

    Absolute paths and traversal are errors rather than values to coerce.  A
    leading ``./`` and redundant separators are harmlessly canonicalized.
    """

    if not isinstance(value, str) or not value:
        raise ContractError(f"{field} must be a non-empty POSIX path")
    if "\\" in value:
        raise ContractError(f"{field} must use POSIX '/' separators: {value!r}")
    if value.startswith("/") or _DRIVE_PATH.match(value) or _WINDOWS_UNC.match(value):
        raise ContractError(f"{field} must be repository-relative, not absolute: {value!r}")
    normalized = posixpath.normpath(value)
    if normalized == ".." or normalized.startswith("../"):
        raise ContractError(f"{field} escapes the repository root: {value!r}")
    if normalized == ".":
        return "."
    return normalized.removeprefix("./")


def _path_or_none(value: Any, field: str) -> str | None:
    return None if value is None else normalize_path(value, field)


def _language(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise ContractError("language must be a non-empty string")
    return value.lower().replace("#", "sharp")


def _coordinate_policy(adapter: str | None, raw: Mapping[str, Any] | None = None) -> dict[str, Any]:
    raw_policy = raw if isinstance(raw, Mapping) else {}
    offset_unit = raw_policy.get("offset_unit") or raw_policy.get("offsetUnit")
    line_base = raw_policy.get("line_base", raw_policy.get("lineBase"))
    column_base = raw_policy.get("column_base", raw_policy.get("columnBase"))
    column_unit = raw_policy.get("column_unit") or raw_policy.get("columnUnit")
    if adapter in {"python", "python-stdlib-ast"}:
        offset_unit = offset_unit or "utf-8-bytes"
        line_base = 1 if line_base is None else line_base
        column_base = 0 if column_base is None else column_base
        column_unit = column_unit or "utf-8-bytes"
        source = "python-ast"
    elif adapter in {"csharp", "roslyn"}:
        offset_unit = offset_unit or "utf-16-code-units"
        line_base = 0 if line_base is None else line_base
        column_base = 0 if column_base is None else column_base
        column_unit = column_unit or "utf-16-code-units"
        source = "roslyn"
    elif adapter in {"typescript", "javascript", "typescript-javascript"}:
        offset_unit = offset_unit or "utf-16-code-units"
        line_base = 1 if line_base is None else line_base
        column_base = 1 if column_base is None else column_base
        column_unit = column_unit or "utf-16-code-units"
        source = "typescript-compiler-api"
    else:
        offset_unit = offset_unit or "declared"
        line_base = 1 if line_base is None else line_base
        column_base = 0 if column_base is None else column_base
        column_unit = column_unit or "declared"
        source = "adapter-declared"
    if offset_unit not in {"utf-8-bytes", "unicode-scalars", "utf-16-code-units", "declared"}:
        raise ContractError(f"unsupported offset unit: {offset_unit!r}")
    if not isinstance(line_base, int) or line_base not in {0, 1}:
        raise ContractError("line_base must be 0 or 1")
    if not isinstance(column_base, int) or column_base not in {0, 1}:
        raise ContractError("column_base must be 0 or 1")
    return {
        "offset_unit": offset_unit,
        "column_unit": column_unit,
        "line_base": line_base,
        "column_base": column_base,
        "source": source,
    }


def _canonical_span(
    raw: Any,
    *,
    adapter: str | None,
    default_file: str | None = None,
) -> dict[str, Any] | None:
    if raw is None:
        return None
    data = _as_mapping(raw, "span")
    file = _path_or_none(data.get("file", default_file), "span.file")
    if file is None:
        raise ContractError("span.file is required")
    policy = _coordinate_policy(adapter, data.get("coordinates") if isinstance(data.get("coordinates"), Mapping) else None)
    start = data.get("start")
    end = data.get("end")
    if isinstance(start, Mapping) and isinstance(end, Mapping):
        start_line = start.get("line", start.get("row"))
        end_line = end.get("line", end.get("row"))
        start_column = start.get("column", start.get("col"))
        end_column = end.get("column", end.get("col"))
        if not all(isinstance(item, int) for item in (start_line, end_line, start_column, end_column)):
            raise ContractError("span positions require integer line and column values")
        canonical_start_line = start_line - policy["line_base"] + 1
        canonical_end_line = end_line - policy["line_base"] + 1
        canonical_start_column = start_column - policy["column_base"]
        canonical_end_column = end_column - policy["column_base"]
    else:
        start_line = data.get("row")
        end_line = data.get("endRow", start_line)
        start_column = data.get("col")
        end_column = data.get("endCol", start_column)
        if not all(isinstance(item, int) for item in (start_line, end_line, start_column, end_column)):
            raise ContractError("span requires start/end positions")
        canonical_start_line = start_line - policy["line_base"] + 1
        canonical_end_line = end_line - policy["line_base"] + 1
        canonical_start_column = start_column - policy["column_base"]
        canonical_end_column = end_column - policy["column_base"]
    if min(canonical_start_line, canonical_end_line, canonical_start_column, canonical_end_column) < 0:
        raise ContractError("span coordinates cannot be negative after normalization")
    offset = data.get("offset", data.get("start"))
    if isinstance(offset, Mapping):
        offset = None
    length = data.get("length")
    if length is None and isinstance(data.get("start"), int) and isinstance(data.get("end"), int):
        offset = data["start"]
        length = data["end"] - data["start"]
    if offset is not None and not isinstance(offset, int):
        raise ContractError("span.offset must be an integer or null")
    if length is not None and (not isinstance(length, int) or length < 0):
        raise ContractError("span.length must be a non-negative integer or null")
    text = data.get("text")
    if text is not None and not isinstance(text, str):
        raise ContractError("span.text must be a string")
    result: dict[str, Any] = {
        "file": file,
        "start": {"line": canonical_start_line, "column": canonical_start_column},
        "end": {"line": canonical_end_line, "column": canonical_end_column},
        "offset": offset,
        "length": length,
        "coordinates": policy,
    }
    if text is not None:
        result["text"] = text
    return result


def _validate_canonical_span(raw: Any) -> None:
    data = _as_mapping(raw, "span")
    normalize_path(data.get("file"), "span.file")
    for position_name in ("start", "end"):
        position = _as_mapping(data.get(position_name), f"span.{position_name}")
        if not all(isinstance(position.get(key), int) for key in ("line", "column")):
            raise ContractError(f"span.{position_name} requires integer line and column values")
        if position["line"] < 1 or position["column"] < 0:
            raise ContractError("canonical span coordinates cannot be negative")
    if data.get("offset") is not None and not isinstance(data["offset"], int):
        raise ContractError("span.offset must be an integer or null")
    if data.get("length") is not None and (not isinstance(data["length"], int) or data["length"] < 0):
        raise ContractError("span.length must be a non-negative integer or null")
    policy = _as_mapping(data.get("coordinates"), "span.coordinates")
    if policy.get("offset_unit") not in {"utf-8-bytes", "unicode-scalars", "utf-16-code-units", "declared"}:
        raise ContractError("span.coordinates.offset_unit is invalid")


def _semantic_kind(node: Mapping[str, Any]) -> str:
    value = node.get("semantic_kind") or node.get("semanticKind") or node.get("varKind")
    value = value or node.get("symbol_kind") or node.get("symbolKind") or node.get("declarationKind")
    if value is None:
        value = "namespace" if node.get("kind") == "namespace" else "symbol"
    return str(value).lower()


def _engine(raw: Mapping[str, Any]) -> dict[str, Any]:
    value = raw.get("engine") or {}
    if isinstance(value, str):
        return {"name": value, "version": "unknown"}
    value = _as_mapping(value, "engine")
    name = value.get("name") or value.get("Name") or "unknown"
    version = value.get("version") or value.get("Version") or "unknown"
    if not isinstance(name, str) or not isinstance(version, str):
        raise ContractError("engine.name and engine.version must be strings")
    return {
        "name": name,
        "version": version,
        **(
            {"runtime": value["runtime"]}
            if isinstance(value.get("runtime"), str)
            else {}
        ),
    }


def _raw_id(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ContractError(f"{field} must be a non-empty string")
    return value


def _node_id(kind: str, semantic_key: str) -> str:
    return _stable_id(f"node-{kind}", semantic_key)


def _canonical_node(
    raw: Any,
    *,
    adapter: str | None,
    file_hint: str | None,
    root_engine: Mapping[str, Any],
) -> tuple[dict[str, Any], str]:
    if isinstance(raw, str):
        raw = {"id": raw, "kind": "namespace" if raw.startswith("namespace:") else "var", "name": raw}
    node = _as_mapping(raw, "node")
    original_id = _raw_id(node.get("id"), "node.id")
    kind = "namespace" if node.get("kind") == "namespace" or original_id.startswith("namespace:") else "symbol"
    semantic_kind = _semantic_kind(node)
    name = node.get("name") or node.get("label") or node.get("qualified_name") or node.get("fullyQualifiedName")
    if not isinstance(name, str) or not name:
        raise ContractError(f"node {original_id!r} has no name")
    fqn = node.get("fqn") or node.get("qualified_name") or node.get("fullyQualifiedName")
    if fqn is not None and not isinstance(fqn, str):
        raise ContractError(f"node {original_id!r}.fqn must be a string")
    file = _path_or_none(node.get("file", file_hint), f"node {original_id}.file")
    canonical_key = "|".join(
        [
            kind,
            str(node.get("namespace") or ""),
            str(fqn or name),
            str(node.get("project_id") or node.get("projectId") or ""),
            str(file or ""),
        ]
    )
    canonical_id = _node_id(kind, canonical_key)
    output: dict[str, Any] = {
        "id": canonical_id,
        "kind": kind,
        "semantic_kind": semantic_kind,
        "name": name,
        "fqn": fqn,
        "external": bool(node.get("external", node.get("isExternal", False))),
        "occurrence_ids": [],
    }
    if file is not None:
        output["file"] = file
    namespace = node.get("namespace")
    if namespace is not None:
        output["namespace"] = str(namespace)
    project_id = node.get("project_id") or node.get("projectId")
    if project_id is not None:
        output["project_id"] = str(project_id)
    package_id = node.get("package_id") or node.get("packageId") or node.get("packageName")
    if package_id is not None:
        output["package_id"] = str(package_id)
    span = _canonical_span(node.get("span"), adapter=adapter, default_file=file)
    if span is not None:
        output["span"] = span
    for source_key, target_key in (
        ("signature", "signature"),
        ("visibility", "visibility"),
        ("isExported", "exported"),
        ("exported", "exported"),
        ("isPartial", "partial"),
        ("isOverride", "override"),
        ("isAbstract", "abstract"),
        ("isStatic", "static"),
    ):
        if source_key in node and target_key not in output:
            output[target_key] = node[source_key]
    output["engine"] = dict(root_engine)
    return output, original_id


def _resolution(raw: Any, *, engine: Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(raw, str):
        status = raw
        value: Mapping[str, Any] = {}
    elif raw is None:
        status = "unresolved"
        value = {}
    else:
        value = _as_mapping(raw, "relationship.resolution")
        status = value.get("status") or value.get("state") or "unresolved"
    if status not in RESOLUTION_STATES:
        raise ContractError(f"invalid resolution status: {status!r}")
    confidence = value.get("confidence", 1.0 if status == "resolved" else 0.5)
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= confidence <= 1:
        raise ContractError("resolution.confidence must be between 0 and 1")
    provenance = value.get("provenance")
    if isinstance(provenance, Mapping):
        provenance_out = {
            "engine": str(provenance.get("engine") or engine["name"]),
            "version": str(provenance.get("version") or engine["version"]),
            **(
                {"source": str(provenance["source"])}
                if provenance.get("source") is not None
                else {}
            ),
        }
    else:
        provenance_out = {
            "engine": str(value.get("engine") or engine["name"]),
            "version": str(value.get("engineVersion") or engine["version"]),
            **(
                {"source": str(provenance)}
                if isinstance(provenance, str)
                else {}
            ),
        }
    candidates = value.get("candidates") or value.get("candidateIds") or []
    if not isinstance(candidates, list) or not all(isinstance(item, str) for item in candidates):
        raise ContractError("resolution.candidates must be an array of strings")
    return {
        "status": status,
        "confidence": float(confidence),
        "provenance": provenance_out,
        "_candidate_raw_ids": candidates,
    }


def _raw_relationships(raw: Mapping[str, Any]) -> list[Any]:
    return _as_list(raw.get("relationships", raw.get("edges", [])), "relationships")


def _raw_occurrences(raw: Mapping[str, Any]) -> list[Any]:
    return _as_list(raw.get("occurrences", []), "occurrences")


def _target_info(
    target_raw: Any,
    *,
    status: str,
    candidates: list[str],
) -> dict[str, Any] | None:
    if status == "resolved" and not isinstance(target_raw, Mapping):
        return None
    if isinstance(target_raw, Mapping):
        name = target_raw.get("name") or target_raw.get("label") or target_raw.get("id")
        target_kind = target_raw.get("kind") or target_raw.get("semantic_kind")
        package = target_raw.get("package") or target_raw.get("packageName")
    else:
        name = target_raw
        target_kind = None
        package = None
    if not isinstance(name, str) or not name:
        raise ContractError("relationship target reference requires a name")
    result: dict[str, Any] = {"status": status, "name": name}
    if target_kind is not None:
        result["kind"] = str(target_kind)
    if package is not None:
        result["package"] = str(package)
    if candidates:
        result["candidates"] = candidates
    return result


def _raw_change_values(analysis: Mapping[str, Any], key: str) -> list[Any]:
    aliases = {
        "changed_files": ("changed_files", "changedFiles"),
        "deleted_files": ("deleted_files", "deletedFiles"),
        "invalidated_files": ("invalidated", "invalidated_files", "invalidatedFiles"),
    }
    for name in aliases[key]:
        if name in analysis:
            return _as_list(analysis[name], f"analysis.{name}")
    return []


def _normalize_status(raw: Mapping[str, Any], diagnostics: list[dict[str, Any]]) -> tuple[str, str, bool]:
    analysis = raw.get("analysis")
    analysis_map = analysis if isinstance(analysis, Mapping) else {}
    invocation = analysis_map.get("invocation_status") or analysis_map.get("invocationStatus")
    if invocation is None and analysis_map.get("fatal") is True:
        invocation = "fatal"
    invocation = invocation or raw.get("invocation_status") or "success"
    if invocation not in INVOCATION_STATUSES:
        raise ContractError("analysis.invocation_status must be 'success' or 'fatal'")
    if invocation == "fatal":
        return invocation, "fatal", True
    recoverable = any(item["severity"] == "error" and item["recoverable"] for item in diagnostics)
    return invocation, "partial" if recoverable or diagnostics else "complete", False


def normalize(raw: Mapping[str, Any], *, adapter: str | None = None) -> dict[str, Any]:
    """Normalize a Python, C#, or TypeScript/JavaScript adapter result.

    The function is intentionally conservative: invalid paths, malformed
    spans, unknown resolution states, and category mismatches fail the
    invocation instead of producing a plausible-but-invalid document.
    """

    source = _as_mapping(raw, "input")
    adapter_name = adapter or str(source.get("adapter") or source.get("format") or source.get("schema") or "unknown")
    engine = _engine(source)
    input_info = source.get("input") if isinstance(source.get("input"), Mapping) else {}
    analysis_info = source.get("analysis") if isinstance(source.get("analysis"), Mapping) else {}
    raw_policy = source.get("coordinates") if isinstance(source.get("coordinates"), Mapping) else {}
    default_policy = _coordinate_policy(adapter_name, raw_policy)

    raw_nodes = _as_list(source.get("nodes", []), "nodes")
    raw_files_value = source.get("files", source.get("documents"))
    if raw_files_value is None:
        raw_files_value = analysis_info.get("files", [])
    raw_files = _as_list(raw_files_value, "files")
    raw_occurrences = _raw_occurrences(source)
    for item in raw_nodes:
        if isinstance(item, Mapping):
            for occurrence in _as_list(item.get("occurrences", []), "node.occurrences"):
                occurrence_copy = dict(_as_mapping(occurrence, "node.occurrence"))
                occurrence_copy.setdefault("node_id", item.get("id"))
                raw_occurrences.append(occurrence_copy)
    raw_relationships = _raw_relationships(source)

    node_map: dict[str, str] = {}
    nodes: dict[str, dict[str, Any]] = {}
    for item in raw_nodes:
        node, original_id = _canonical_node(
            item,
            adapter=adapter_name,
            file_hint=None,
            root_engine=engine,
        )
        node_map[original_id] = node["id"]
        existing = nodes.get(node["id"])
        if existing is None:
            nodes[node["id"]] = node
        else:
            existing["occurrence_ids"] = _ordered_unique(existing["occurrence_ids"] + node["occurrence_ids"])

    def resolve_node(raw_id: Any, *, status: str, target_raw: Any = None) -> str:
        identifier = _raw_id(raw_id, "relationship endpoint")
        if identifier in node_map:
            return node_map[identifier]
        if status == "resolved":
            raise ContractError(f"relationship endpoint references unknown node: {identifier!r}")
        info = _target_info(target_raw if target_raw is not None else identifier, status=status, candidates=[])
        assert info is not None
        semantic = f"{status}|{info.get('kind', 'symbol')}|{info['name']}|{info.get('package', '')}"
        placeholder_id = _node_id(status, semantic)
        nodes.setdefault(
            placeholder_id,
            {
                "id": placeholder_id,
                "kind": "symbol" if info.get("kind", "symbol") != "namespace" else "namespace",
                "semantic_kind": info.get("kind", "unresolved"),
                "name": info["name"],
                "fqn": info["name"],
                "external": status == "external",
                "target": info,
                "occurrence_ids": [],
                "engine": dict(engine),
            },
        )
        return placeholder_id

    relationship_map: dict[str, str] = {}
    relationships: dict[str, dict[str, Any]] = {}
    pending_occurrences: list[tuple[Mapping[str, Any], str | None, str | None]] = []
    for relation_item in raw_relationships:
        if isinstance(relation_item, list):
            if len(relation_item) < 4:
                raise ContractError("array relationships require kind, source, target, and resolution")
            relation: Mapping[str, Any] = {
                "kind": relation_item[0],
                "source": relation_item[1],
                "target": relation_item[2],
                "state": relation_item[3],
            }
        else:
            relation = _as_mapping(relation_item, "relationship")
        kind = relation.get("kind") or relation.get("type")
        if not isinstance(kind, str) or not kind or not _IDENTIFIER.match(kind):
            raise ContractError(f"invalid relationship kind: {kind!r}")
        resolution = _resolution(relation.get("resolution", relation.get("state")), engine=engine)
        status = resolution["status"]
        raw_provenance = relation.get("provenance")
        if raw_provenance is not None:
            if isinstance(raw_provenance, Mapping):
                resolution["provenance"] = {
                    "engine": str(raw_provenance.get("engine") or resolution["provenance"]["engine"]),
                    "version": str(raw_provenance.get("version") or resolution["provenance"]["version"]),
                    **(
                        {"source": str(raw_provenance["source"])}
                        if raw_provenance.get("source") is not None
                        else {}
                    ),
                }
            else:
                resolution["provenance"]["source"] = str(raw_provenance)
        source_id = resolve_node(relation.get("source"), status="resolved")
        target_raw = relation.get("target")
        if isinstance(target_raw, Mapping):
            target_identifier = target_raw.get("id") or target_raw.get("name")
        else:
            target_identifier = target_raw
        target_id = resolve_node(target_identifier, status=status, target_raw=target_raw)
        candidate_ids = [
            node_map.get(candidate, candidate)
            for candidate in resolution.pop("_candidate_raw_ids")
        ]
        if any(not isinstance(candidate, str) or not candidate for candidate in candidate_ids):
            raise ContractError("resolution candidate IDs must be non-empty strings")
        resolution["candidates"] = _ordered_unique(candidate_ids)
        relation_id = _stable_id("relationship", kind, source_id, target_id)
        original_relation_id = relation.get("id")
        if original_relation_id is not None:
            relationship_map[_raw_id(original_relation_id, "relationship.id")] = relation_id
        category = relation.get("category") or relation.get("codegraph_category") or relation.get("codegraphCategory")
        if category is not None:
            if category not in RELATIONSHIP_CATEGORIES:
                raise ContractError(f"invalid CodeGraph-v2 category: {category!r}")
            if kind not in RELATIONSHIP_CATEGORIES or category != kind:
                raise ContractError(f"relationship {kind!r} cannot project to category {category!r}")
        elif kind in RELATIONSHIP_CATEGORIES:
            category = kind
        edge: dict[str, Any] = {
            "id": relation_id,
            "kind": kind,
            "source": source_id,
            "target": target_id,
            "resolution": resolution,
            "occurrence_ids": [],
            "occurrence_count": 0,
            "category": category,
            "provenance": resolution["provenance"],
        }
        span = _canonical_span(relation.get("span"), adapter=adapter_name)
        if span is not None:
            edge["span"] = span
        target_info = _target_info(target_raw, status=status, candidates=resolution["candidates"])
        if target_info is not None:
            edge["target_ref"] = target_info
        detail = relation.get("detail")
        if detail is not None:
            if not isinstance(detail, Mapping):
                raise ContractError("relationship.detail must be an object")
            edge["detail"] = {str(key): str(value) for key, value in sorted(detail.items())}
        relationships[relation_id] = edge
        for occurrence_id in relation.get("occurrence_ids", relation.get("occurrenceIds", [])) or []:
            pending_occurrences.append(({"id": occurrence_id}, relation_id, None))

    occurrence_outputs: dict[str, dict[str, Any]] = {}
    for occurrence_item in raw_occurrences:
        occurrence = _as_mapping(occurrence_item, "occurrence")
        relation_raw = occurrence.get("relationship_id") or occurrence.get("relationship") or occurrence.get("relationshipId")
        node_raw = occurrence.get("node_id") or occurrence.get("nodeId")
        relation_id = relationship_map.get(relation_raw) if isinstance(relation_raw, str) else None
        node_id = node_map.get(node_raw) if isinstance(node_raw, str) else None
        if relation_raw is not None and relation_id is None:
            raise ContractError(f"occurrence references unknown relationship: {relation_raw!r}")
        if node_raw is not None and node_id is None:
            raise ContractError(f"occurrence references unknown node: {node_raw!r}")
        span_raw = occurrence.get("span")
        if span_raw is None:
            span_raw = occurrence
        span = _canonical_span(span_raw, adapter=adapter_name, default_file=occurrence.get("file"))
        if span is None:
            raise ContractError("occurrence.span is required")
        role = occurrence.get("role") or ("relationship" if relation_id else "reference")
        text = occurrence.get("text", span.get("text", ""))
        if not isinstance(role, str) or not isinstance(text, str):
            raise ContractError("occurrence.role and occurrence.text must be strings")
        occurrence_id = _stable_id(
            "occurrence",
            relation_id or node_id or "",
            role,
            span["file"],
            span["offset"],
            span["length"],
            text,
        )
        output = {
            "id": occurrence_id,
            "role": role,
            "file": span["file"],
            "span": span,
            "text": text,
        }
        if relation_id is not None:
            output["relationship_id"] = relation_id
        if node_id is not None:
            output["node_id"] = node_id
        detail = occurrence.get("detail")
        if detail is not None:
            if isinstance(detail, Mapping):
                output["detail"] = {str(key): str(value) for key, value in sorted(detail.items())}
            elif isinstance(detail, (str, int, float, bool)):
                output["detail"] = {"value": str(detail)}
            else:
                raise ContractError("occurrence.detail must be an object or scalar")
        occurrence_outputs[occurrence_id] = output
        if relation_id is not None:
            relationships[relation_id]["occurrence_ids"].append(occurrence_id)
        if node_id is not None:
            nodes[node_id]["occurrence_ids"].append(occurrence_id)

    for pending, relation_id, node_id in pending_occurrences:
        if not isinstance(pending.get("id"), str):
            continue
        if relation_id is None:
            continue
        edge = relationships[relation_id]
        if edge.get("span") is None:
            continue
        span = edge["span"]
        occurrence_id = _stable_id("occurrence", relation_id, "relationship", span["file"], span["offset"], span["length"], span.get("text", ""))
        occurrence_outputs.setdefault(
            occurrence_id,
            {
                "id": occurrence_id,
                "role": "relationship",
                "file": span["file"],
                "span": span,
                "text": span.get("text", ""),
                "relationship_id": relation_id,
            },
        )
        edge["occurrence_ids"].append(occurrence_id)

    for edge in relationships.values():
        edge["occurrence_ids"] = _ordered_unique(edge["occurrence_ids"])
        edge["occurrence_count"] = len(edge["occurrence_ids"])
        edge["resolution"]["candidates"] = _ordered_unique(edge["resolution"]["candidates"])
    for node in nodes.values():
        node["occurrence_ids"] = _ordered_unique(node["occurrence_ids"])
        node["occurrence_count"] = len(node["occurrence_ids"])

    files: dict[str, dict[str, Any]] = {}
    for file_item in raw_files:
        item = {"path": file_item} if isinstance(file_item, str) else _as_mapping(file_item, "file")
        path = normalize_path(item.get("path"), "file.path")
        entry: dict[str, Any] = {
            "path": path,
            "status": str(item.get("status") or "present"),
            "language": _language(item.get("language")),
        }
        for source_key, target_key in (
            ("project_id", "project_id"),
            ("projectId", "project_id"),
            ("package_id", "package_id"),
            ("packageId", "package_id"),
            ("hash", "content_hash"),
            ("content_hash", "content_hash"),
        ):
            if source_key in item and target_key not in entry and item[source_key] is not None:
                entry[target_key] = str(item[source_key])
        policy = item.get("coordinates") or item.get("coordinate_policy")
        entry["coordinates"] = _coordinate_policy(adapter_name, policy if isinstance(policy, Mapping) else None)
        files[path] = entry

    for node in nodes.values():
        if node.get("file") and node["file"] not in files:
            files[node["file"]] = {
                "path": node["file"],
                "status": "present",
                "language": None,
                "coordinates": default_policy,
            }
    for occurrence in occurrence_outputs.values():
        if occurrence["file"] not in files:
            files[occurrence["file"]] = {
                "path": occurrence["file"],
                "status": "present",
                "language": None,
                "coordinates": occurrence["span"]["coordinates"],
            }

    diagnostics: list[dict[str, Any]] = []
    for diagnostic_item in _as_list(source.get("diagnostics", []), "diagnostics"):
        diagnostic = _as_mapping(diagnostic_item, "diagnostic")
        severity = str(diagnostic.get("severity") or diagnostic.get("category") or "warning").lower()
        severity = {"hidden": "message", "information": "info"}.get(severity, severity)
        if severity not in {"error", "warning", "suggestion", "message", "info"}:
            raise ContractError(f"invalid diagnostic severity: {severity!r}")
        recoverable = bool(diagnostic.get("recoverable", severity != "error" or not diagnostic.get("fatal", False)))
        file = _path_or_none(diagnostic.get("file"), "diagnostic.file")
        span = _canonical_span(diagnostic.get("span"), adapter=adapter_name, default_file=file)
        diagnostics.append(
            {
                "id": str(diagnostic.get("id") or diagnostic.get("code") or _stable_id("diagnostic", severity, diagnostic.get("message", ""))),
                "severity": severity,
                "message": str(diagnostic.get("message") or ""),
                "code": str(diagnostic.get("code") or diagnostic.get("id") or "DIAGNOSTIC"),
                "recoverable": recoverable,
                "fatal": bool(diagnostic.get("fatal", False)),
                "file": file,
                "span": span,
            }
        )
    invocation_status, result_status, fatal = _normalize_status(source, diagnostics)
    if any(item["fatal"] for item in diagnostics):
        invocation_status, result_status, fatal = "fatal", "fatal", True

    def normalize_file_list(key: str) -> list[str]:
        return _ordered_unique(normalize_path(item, f"analysis.{key}") for item in _raw_change_values(analysis_info, key))

    changed_files = normalize_file_list("changed_files")
    deleted_files = normalize_file_list("deleted_files")
    invalidated_files = normalize_file_list("invalidated_files")
    if not changed_files:
        changed_files = _ordered_unique(
            normalize_path(item, "input.changed_files")
            for item in _as_list(input_info.get("changedFiles", input_info.get("changed_files", [])), "input.changed_files")
        )
    raw_invalidation = source.get("ownership")
    if isinstance(raw_invalidation, Mapping):
        raw_invalidation = raw_invalidation.get("invalidation")
    if isinstance(raw_invalidation, Mapping) and not invalidated_files:
        invalidated_files = _ordered_unique(
            normalize_path(item, "ownership.invalidation.impactedFiles")
            for item in _as_list(
                raw_invalidation.get("impactedFiles", raw_invalidation.get("invalidatedFiles", [])),
                "ownership.invalidation.impactedFiles",
            )
        )
    for path in deleted_files:
        files.setdefault(
            path,
            {"path": path, "status": "deleted", "language": None, "coordinates": default_policy},
        )["status"] = "deleted"
    for path in changed_files:
        files.setdefault(
            path,
            {"path": path, "status": "present", "language": None, "coordinates": default_policy},
        )
    ownership: dict[str, dict[str, Any]] = {}
    raw_ownership = analysis_info.get("ownership") or source.get("ownership")
    if isinstance(raw_ownership, Mapping):
        raw_ownership = raw_ownership.get("files", raw_ownership)
        raw_ownership = [
            {
                "file": key,
                **(value if isinstance(value, Mapping) else {"project_id": value}),
            }
            for key, value in raw_ownership.items()
        ]
    for item in _as_list(raw_ownership, "ownership"):
        owner = _as_mapping(item, "ownership item")
        path = normalize_path(owner.get("file"), "ownership.file")
        ownership[path] = {
            "file": path,
            "node_ids": _ordered_unique(node_map.get(value, value) for value in _as_list(owner.get("node_ids", owner.get("nodeIds", [])), "ownership.node_ids")),
            "relationship_ids": _ordered_unique(relationship_map.get(value, value) for value in _as_list(owner.get("edge_ids", owner.get("edgeIds", owner.get("relationship_ids", []))), "ownership.relationship_ids")),
        }
        project_id = owner.get("project_id") or owner.get("projectId")
        if project_id is not None:
            ownership[path]["project_id"] = str(project_id)
    for node in nodes.values():
        if node.get("file"):
            ownership.setdefault(node["file"], {"file": node["file"], "node_ids": [], "relationship_ids": []})["node_ids"].append(node["id"])
    for edge in relationships.values():
        span = edge.get("span")
        if span:
            ownership.setdefault(span["file"], {"file": span["file"], "node_ids": [], "relationship_ids": []})["relationship_ids"].append(edge["id"])
    for owner in ownership.values():
        owner["node_ids"] = _ordered_unique(owner["node_ids"])
        owner["relationship_ids"] = _ordered_unique(owner["relationship_ids"])

    def package_items() -> list[dict[str, Any]]:
        output = []
        for item in _as_list(source.get("packages", []), "packages"):
            package = _as_mapping(item, "package")
            root = normalize_path(package.get("root", package.get("path", ".")), "package.root")
            output.append(
                {
                    "id": str(package.get("id") or _stable_id("package", package.get("name", root), root)),
                    "name": str(package.get("name") or root),
                    "root": root,
                    **({"manifest": normalize_path(package["manifest"], "package.manifest")} if package.get("manifest") else {}),
                }
            )
        return output

    def project_items() -> list[dict[str, Any]]:
        output = []
        for item in _as_list(source.get("projects", []), "projects"):
            project = _as_mapping(item, "project")
            path = project.get("path")
            output.append(
                {
                    "id": str(project.get("id") or _stable_id("project", project.get("name", "project"), path or "")),
                    "name": str(project.get("name") or project.get("id") or "project"),
                    "root": normalize_path(path, "project.root") if path else ".",
                    "language": _language(project.get("language")),
                    "source_roots": _ordered_unique(normalize_path(value, "project.source_roots") for value in _as_list(project.get("source_roots", project.get("sourceRoots", [])), "project.source_roots")),
                    "references": _ordered_unique(str(value) for value in _as_list(project.get("projectReferences", project.get("references", [])), "project.references")),
                }
            )
        return output

    document: dict[str, Any] = {
        "contract": CONTRACT_ID,
        "schema_version": CONTRACT_VERSION,
        "engine": dict(engine),
        "repository": {
            "root": ".",
            "id": str(source.get("repository_id") or source.get("repositoryId") or "repository"),
            "source_roots": _ordered_unique(
                normalize_path(value, "repository.source_roots")
                for value in _as_list(source.get("source_roots", source.get("sourceRoots", [])), "repository.source_roots")
            ),
            "package_roots": _ordered_unique(item["root"] for item in package_items()),
            "project_roots": _ordered_unique(item["root"] for item in project_items()),
        },
        "coordinates": {
            "line_base": 1,
            "column_base": 0,
            "column_unit": "native-per-file",
            "offset_unit": "native-per-file",
            "policy": "Lines are 1-based and columns are 0-based in the canonical view; offsets and native columns retain each adapter's declared unit.",
        },
        "translation": {
            "adapter": (
                "python"
                if adapter_name in {"python", "python-stdlib-ast"}
                else "csharp"
                if adapter_name in {"csharp", "roslyn"}
                else "typescript-javascript"
                if adapter_name in {"typescript", "javascript", "typescript-javascript"}
                else adapter_name
            ),
            "preserved_native_kinds": sorted({item["kind"] for item in relationships.values()}),
            "category_kinds": sorted(RELATIONSHIP_CATEGORIES & {item["kind"] for item in relationships.values()}),
            "translation_gaps": sorted(
                {item["kind"] for item in relationships.values()} - RELATIONSHIP_CATEGORIES
            ),
        },
        "packages": sorted(package_items(), key=lambda item: item["id"]),
        "projects": sorted(project_items(), key=lambda item: item["id"]),
        "files": sorted(files.values(), key=lambda item: item["path"]),
        "nodes": sorted(nodes.values(), key=lambda item: item["id"]),
        "relationships": sorted(relationships.values(), key=lambda item: item["id"]),
        "occurrences": sorted(occurrence_outputs.values(), key=lambda item: item["id"]),
        "diagnostics": sorted(diagnostics, key=lambda item: (item["file"] or "", item["span"]["offset"] if item["span"] and item["span"]["offset"] is not None else -1, item["id"])),
        "analysis": {
            "mode": str(
                analysis_info.get("mode")
                or input_info.get("analysisMode")
                or ("incremental" if changed_files or deleted_files else "full")
            ).lower(),
            "invocation_status": invocation_status,
            "result_status": result_status,
            "fatal": fatal,
            "changed_files": changed_files,
            "deleted_files": deleted_files,
            "invalidated_files": invalidated_files,
            "ownership": sorted(ownership.values(), key=lambda item: item["file"]),
            "strategy": str(analysis_info.get("strategy") or "adapter-declared"),
        },
        "stats": {
            "files": len(files),
            "nodes": len(nodes),
            "relationships": len(relationships),
            "occurrences": len(occurrence_outputs),
            "diagnostics": len(diagnostics),
        },
    }
    errors = validate(document)
    if errors:
        raise ContractError("normalized document failed contract validation", errors)
    return document


def validate(document: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return deterministic structural and semantic contract diagnostics."""

    errors: list[dict[str, Any]] = []

    def error(code: str, message: str, path: str) -> None:
        errors.append({"code": code, "message": message, "path": path})

    if not isinstance(document, Mapping):
        return [{"code": "ROOT_TYPE", "message": "document must be an object", "path": "$"}]
    if document.get("contract") != CONTRACT_ID:
        error("CONTRACT_ID", f"expected {CONTRACT_ID}", "contract")
    if document.get("schema_version") != CONTRACT_VERSION:
        error("SCHEMA_VERSION", "schema_version must be 1", "schema_version")
    for key in ("repository", "coordinates", "translation", "files", "nodes", "relationships", "occurrences", "diagnostics", "analysis"):
        if key not in document:
            error("REQUIRED", f"missing required field {key}", key)
    try:
        repository = _as_mapping(document.get("repository"), "repository")
        if repository.get("root") != ".":
            error("ROOT_PATH", "repository.root must be '.'", "repository.root")
        for key in ("source_roots", "package_roots", "project_roots"):
            for index, path in enumerate(_as_list(repository.get(key, []), f"repository.{key}")):
                try:
                    normalize_path(path, f"repository.{key}[{index}]")
                except ContractError as exc:
                    error("PATH", str(exc), f"repository.{key}[{index}]")
    except ContractError as exc:
        error("TYPE", str(exc), "repository")
    ids: set[str] = set()
    node_ids: set[str] = set()
    for index, node in enumerate(document.get("nodes", [])):
        if not isinstance(node, Mapping):
            error("TYPE", "node must be an object", f"nodes[{index}]")
            continue
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id:
            error("NODE_ID", "node.id must be a non-empty string", f"nodes[{index}].id")
        elif node_id in ids:
            error("DUPLICATE_ID", f"duplicate ID {node_id}", f"nodes[{index}].id")
        else:
            ids.add(node_id)
            node_ids.add(node_id)
        if node.get("kind") not in {"namespace", "symbol"}:
            error("NODE_KIND", "node.kind must be namespace or symbol", f"nodes[{index}].kind")
        if node.get("file") is not None:
            try:
                normalize_path(node["file"], f"nodes[{index}].file")
            except ContractError as exc:
                error("PATH", str(exc), f"nodes[{index}].file")
    relationship_ids: set[str] = set()
    for index, relation in enumerate(document.get("relationships", [])):
        if not isinstance(relation, Mapping):
            error("TYPE", "relationship must be an object", f"relationships[{index}]")
            continue
        relation_id = relation.get("id")
        if not isinstance(relation_id, str) or not relation_id:
            error("RELATIONSHIP_ID", "relationship.id must be a non-empty string", f"relationships[{index}].id")
        elif relation_id in ids:
            error("DUPLICATE_ID", f"duplicate ID {relation_id}", f"relationships[{index}].id")
        else:
            ids.add(relation_id)
            relationship_ids.add(relation_id)
        if relation.get("source") not in node_ids or relation.get("target") not in node_ids:
            error("ENDPOINT", "relationship endpoints must reference nodes", f"relationships[{index}]")
        kind = relation.get("kind")
        if not isinstance(kind, str) or not kind:
            error("RELATIONSHIP_KIND", "relationship.kind must be a non-empty string", f"relationships[{index}].kind")
        category = relation.get("category")
        if category is not None and (category not in RELATIONSHIP_CATEGORIES or kind != category):
            error("CATEGORY", "category is allowed only when it exactly matches requires/calls/mentions", f"relationships[{index}].category")
        resolution = relation.get("resolution")
        if not isinstance(resolution, Mapping) or resolution.get("status") not in RESOLUTION_STATES:
            error("RESOLUTION", "relationship resolution status is invalid", f"relationships[{index}].resolution")
        elif not isinstance(resolution.get("confidence"), (int, float)) or not 0 <= resolution["confidence"] <= 1:
            error("CONFIDENCE", "resolution confidence must be between 0 and 1", f"relationships[{index}].resolution.confidence")
    occurrence_ids: set[str] = set()
    for index, occurrence in enumerate(document.get("occurrences", [])):
        if not isinstance(occurrence, Mapping):
            error("TYPE", "occurrence must be an object", f"occurrences[{index}]")
            continue
        occurrence_id = occurrence.get("id")
        if not isinstance(occurrence_id, str) or not occurrence_id:
            error("OCCURRENCE_ID", "occurrence.id must be a non-empty string", f"occurrences[{index}].id")
        elif occurrence_id in ids:
            error("DUPLICATE_ID", f"duplicate ID {occurrence_id}", f"occurrences[{index}].id")
        else:
            ids.add(occurrence_id)
            occurrence_ids.add(occurrence_id)
        if occurrence.get("relationship_id") not in relationship_ids and occurrence.get("node_id") not in node_ids:
            error("OCCURRENCE_OWNER", "occurrence must reference a relationship or node", f"occurrences[{index}]")
        try:
            _validate_canonical_span(occurrence.get("span"))
        except ContractError as exc:
            error("SPAN", str(exc), f"occurrences[{index}].span")
    for index, file in enumerate(document.get("files", [])):
        if not isinstance(file, Mapping):
            error("TYPE", "file must be an object", f"files[{index}]")
            continue
        try:
            normalize_path(file.get("path"), f"files[{index}].path")
        except ContractError as exc:
            error("PATH", str(exc), f"files[{index}].path")
        if file.get("status") not in {"present", "deleted", "invalid"}:
            error("FILE_STATUS", "file.status is invalid", f"files[{index}].status")
    for index, relation in enumerate(document.get("relationships", [])):
        if isinstance(relation, Mapping):
            for occurrence_id in relation.get("occurrence_ids", []):
                if occurrence_id not in occurrence_ids:
                    error("OCCURRENCE_REF", "relationship references unknown occurrence", f"relationships[{index}].occurrence_ids")
    analysis = document.get("analysis")
    if isinstance(analysis, Mapping):
        if analysis.get("mode") not in ANALYSIS_MODES:
            error("ANALYSIS_MODE", "analysis.mode must be full or incremental", "analysis.mode")
        if analysis.get("invocation_status") not in INVOCATION_STATUSES:
            error("INVOCATION_STATUS", "analysis.invocation_status is invalid", "analysis.invocation_status")
        if analysis.get("result_status") not in RESULT_STATUSES:
            error("RESULT_STATUS", "analysis.result_status is invalid", "analysis.result_status")
        for key in ("changed_files", "deleted_files", "invalidated_files"):
            for index, path in enumerate(analysis.get(key, [])):
                try:
                    normalize_path(path, f"analysis.{key}[{index}]")
                except ContractError as exc:
                    error("PATH", str(exc), f"analysis.{key}[{index}]")
    else:
        error("TYPE", "analysis must be an object", "analysis")
    return sorted(errors, key=lambda item: (item["path"], item["code"], item["message"]))


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Normalize and validate Codewalk parser IR JSON.")
    parser.add_argument("input", help="adapter JSON file, or '-' for stdin")
    parser.add_argument("--adapter", default=None, help="python, csharp, or typescript-javascript")
    parser.add_argument("--out", default=None, help="normalized JSON output file")
    args = parser.parse_args(argv)
    text = sys.stdin.read() if args.input == "-" else open(args.input, encoding="utf-8").read()
    try:
        result = normalize(json.loads(text), adapter=args.adapter)
    except (ContractError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    output = stable_json(result)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(output)
    else:
        sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
