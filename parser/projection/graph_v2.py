"""Project ``codewalk.parser.ir/1`` into the narrow Codewalk graph-v2 format."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Mapping

from parser.shared.ir import stable_json, validate

PROJECTED_RELATIONSHIPS = frozenset({"requires", "calls", "mentions"})
NODE_KINDS = frozenset({"namespace", "var", "keyword"})


class ProjectionError(ValueError):
    """The input is not a valid shared IR document."""


def _span_position(span: Mapping[str, Any] | None, position: str) -> tuple[int | None, int | None]:
    if not isinstance(span, Mapping) or not isinstance(span.get(position), Mapping):
        return None, None
    point = span[position]
    return point.get("line"), point.get("column")


def _evidence(occurrences: Mapping[str, Mapping[str, Any]], ids: list[str]) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for occurrence_id in ids:
        occurrence = occurrences.get(occurrence_id)
        if not occurrence:
            continue
        span = occurrence.get("span") if isinstance(occurrence.get("span"), Mapping) else {}
        row, col = _span_position(span, "start")
        end_row, end_col = _span_position(span, "end")
        item: dict[str, Any] = {
            "file": occurrence.get("file", span.get("file")),
            "row": row,
            "col": col,
            "endRow": end_row,
            "endCol": end_col,
            "text": occurrence.get("text", span.get("text", "")),
        }
        values.append(item)
    return sorted(values, key=lambda item: (item["file"] or "", item["row"] or 0, item["col"] or 0, item["endRow"] or 0, item["endCol"] or 0, item["text"] or ""))


def _node_kind(node: Mapping[str, Any]) -> str:
    semantic = str(node.get("semantic_kind") or "").lower()
    if semantic in {"keyword", "clojure-keyword"}:
        return "keyword"
    return "namespace" if node.get("kind") == "namespace" else "var"


def _project_node(
    node: Mapping[str, Any],
    occurrences: Mapping[str, Mapping[str, Any]],
    projects: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    kind = _node_kind(node)
    fqn = node.get("fqn")
    label = str(node.get("name") or fqn or node["id"])
    output: dict[str, Any] = {
        "id": node["id"],
        "kind": kind,
        "label": label,
        "external": bool(node.get("external", False)),
        "occurrenceCount": int(node.get("occurrence_count", len(node.get("occurrence_ids", [])))),
        "evidence": _evidence(occurrences, list(node.get("occurrence_ids", []))),
    }
    if fqn:
        output["fqn"] = fqn
    if node.get("file"):
        output["file"] = node["file"]
    project_id = node.get("project_id")
    if project_id:
        output["projectId"] = str(project_id)
        project = projects.get(str(project_id))
        if project:
            output["projectName"] = str(project.get("name") or "")
            project_root = str(project.get("root") or "")
            output["assemblyName"] = str(project.get("assembly_name") or project_root.rsplit("/", 1)[-1].removesuffix(".csproj"))
            output["projectPath"] = project_root
    namespace = node.get("namespace")
    if namespace is None and kind == "var" and isinstance(fqn, str) and "." in fqn:
        namespace = fqn.rsplit(".", 1)[0]
    if namespace is None and kind == "namespace":
        namespace = str(fqn or label)
    if namespace:
        output["namespace"] = namespace
    semantic_kind = node.get("semantic_kind")
    if semantic_kind:
        output["semanticKind"] = str(semantic_kind)
        if str(semantic_kind).lower() in {"unresolved", "ambiguous"}:
            output["synthetic"] = True
            output["resolutionStatus"] = str(semantic_kind).lower()
    signature = node.get("signature")
    if isinstance(signature, Mapping):
        output["signature"] = deepcopy(dict(signature))
        if signature.get("fingerprint"):
            output["fingerprint"] = str(signature["fingerprint"])
        if signature.get("container"):
            output["container"] = str(signature["container"])
        if isinstance(signature.get("container_chain"), list):
            output["containerChain"] = [
                str(item) for item in signature["container_chain"] if str(item)
            ]
    span = node.get("span")
    row, col = _span_position(span, "start")
    end_row, end_col = _span_position(span, "end")
    if row is not None:
        output["row"], output["col"] = row, col
        output["endRow"], output["endCol"] = end_row, end_col
    if node.get("visibility") is not None:
        output["private"] = str(node["visibility"]).lower() in {"private", "internal"}
    if kind == "var" and node.get("occurrence_count") is not None:
        output["usageCount"] = int(node["occurrence_count"])
    return output


def project_graph(
    document: Mapping[str, Any],
    *,
    invocation: Mapping[str, Any] | None = None,
    include_ir: bool = True,
) -> dict[str, Any]:
    """Return a deterministic graph-v2 document, optionally retaining shared IR."""
    errors = validate(document)
    if errors:
        raise ProjectionError(f"shared IR validation failed: {errors}")
    # Graph-only consumers do not need a second deep copy of the complete IR.
    # The projection below only reads from the input document; diagnostics and
    # analysis are copied separately because projection may append/update them.
    ir = deepcopy(dict(document)) if include_ir else document
    occurrences = {
        item["id"]: item
        for item in ir["occurrences"]
        if isinstance(item, Mapping) and isinstance(item.get("id"), str)
    }
    projects = {
        str(item.get("id")): item
        for item in ir.get("projects", [])
        if isinstance(item, Mapping) and item.get("id")
    }
    projected_nodes: dict[str, dict[str, Any]] = {}
    for node in ir["nodes"]:
        if not isinstance(node, Mapping) or node.get("kind") not in {"namespace", "symbol"}:
            continue
        target_status = node.get("target", {}).get("status") if isinstance(node.get("target"), Mapping) else None
        if target_status in {"unresolved", "ambiguous"}:
            continue
        projected_nodes[node["id"]] = _project_node(node, occurrences, projects)

    diagnostics = deepcopy(ir["diagnostics"])
    projected_edges: dict[str, dict[str, Any]] = {}
    skipped_unresolved = 0
    dangling = 0
    for edge in ir["relationships"]:
        if not isinstance(edge, Mapping):
            continue
        category = edge.get("category")
        if edge.get("kind") not in PROJECTED_RELATIONSHIPS or category != edge.get("kind"):
            continue
        source = edge.get("source")
        target = edge.get("target")
        if source not in projected_nodes or target not in projected_nodes:
            status = (edge.get("resolution") or {}).get("status")
            if status in {"unresolved", "ambiguous"}:
                skipped_unresolved += 1
                diagnostics.append(
                    {
                        "id": f"projection-unresolved-{edge.get('id', '')}",
                        "severity": "warning",
                        "message": "Unresolved target has no graph endpoint and was omitted from graph-v2.",
                        "code": "UNRESOLVED_ENDPOINT",
                        "recoverable": True,
                        "fatal": False,
                        "relationship_id": edge.get("id"),
                    }
                )
            else:
                dangling += 1
                diagnostics.append(
                    {
                        "id": f"projection-dangling-{edge.get('id', '')}",
                        "severity": "error",
                        "message": "Projected relationship endpoint is missing and the edge was omitted.",
                        "code": "DANGLING_ENDPOINT",
                        "recoverable": True,
                        "fatal": False,
                        "relationship_id": edge.get("id"),
                    }
                )
            continue
        evidence = _evidence(occurrences, list(edge.get("occurrence_ids", [])))
        output: dict[str, Any] = {
            "id": edge["id"],
            "kind": edge["kind"],
            "source": source,
            "target": target,
            "occurrenceCount": int(edge.get("occurrence_count", len(edge.get("occurrence_ids", [])))),
            "evidence": evidence,
        }
        span = edge.get("span")
        row, col = _span_position(span, "start")
        if row is not None:
            output["file"] = span["file"]
            output["row"], output["col"] = row, col
        projected_edges[output["id"]] = output
    diagnostics.sort(key=lambda item: (str(item.get("file") or ""), str(item.get("code") or ""), str(item.get("id") or ""), str(item.get("message") or "")))
    nodes = sorted(projected_nodes.values(), key=lambda item: item["id"])
    edges = sorted(projected_edges.values(), key=lambda item: item["id"])
    stats = {
        "nodes": len(nodes),
        "edges": len(edges),
        "namespaces": sum(item["kind"] == "namespace" for item in nodes),
        "vars": sum(item["kind"] == "var" for item in nodes),
        "keywords": sum(item["kind"] == "keyword" for item in nodes),
        "requires": sum(item["kind"] == "requires" for item in edges),
        "calls": sum(item["kind"] == "calls" for item in edges),
        "mentions": sum(item["kind"] == "mentions" for item in edges),
        "externalNodes": sum(bool(item["external"]) for item in nodes),
        "files": len(ir["files"]),
        "occurrences": len(ir["occurrences"]),
        "diagnostics": len(diagnostics),
        "skippedUnresolved": skipped_unresolved,
        "danglingEndpoints": dangling,
    }
    analysis = deepcopy(ir["analysis"])
    if (skipped_unresolved or dangling) and analysis.get("result_status") == "complete":
        analysis["result_status"] = "partial"
    analysis.update(
        {
            "files": len(ir["files"]),
            "ir_contract": ir["contract"],
            "projection": "codewalk.graph-v2",
        }
    )
    if invocation:
        analysis.update(dict(invocation))
    repository = ir["repository"]
    result = {
        "formatVersion": 2,
        "repo": {"name": repository["id"], "root": "."},
        "analysis": analysis,
        "nodes": nodes,
        "edges": edges,
        "stats": stats,
        "diagnostics": diagnostics,
    }
    if include_ir:
        result["ir"] = ir
    return result
