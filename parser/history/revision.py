"""Deterministic, parser-independent Git history mapping helpers."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any


def normalize_metadata(metadata: Mapping[str, Any]) -> dict[str, Any]:
    """Return sorted, JSON-compatible revision path metadata."""
    renames = [
        {"from": str(item["from"]), "to": str(item["to"])}
        for item in metadata.get("renamedFiles", [])
        if isinstance(item, Mapping) and item.get("from") and item.get("to")
    ]
    return {
        "commit": str(metadata.get("commit") or metadata.get("hash") or ""),
        **({"parentCommit": str(metadata["parentCommit"])} if metadata.get("parentCommit") else {}),
        "changedFiles": sorted({str(item) for item in metadata.get("changedFiles", [])}),
        "addedFiles": sorted({str(item) for item in metadata.get("addedFiles", [])}),
        "deletedFiles": sorted({str(item) for item in metadata.get("deletedFiles", [])}),
        "renamedFiles": sorted(renames, key=lambda item: (item["from"], item["to"])),
    }


def _matches(node_file: Any, path: str) -> bool:
    return isinstance(node_file, str) and (
        node_file == path or node_file.startswith(f"{path}/")
    )


def _overlaps(item: Mapping[str, Any], ranges: Sequence[Sequence[int]]) -> bool:
    row = item.get("row")
    end = item.get("endRow", row)
    return isinstance(row, int) and isinstance(end, int) and any(
        start <= end and row <= finish for start, finish in ranges
    )


def changed_elements(
    metadata: Mapping[str, Any],
    nodes: Sequence[Mapping[str, Any]],
    edges: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Map path/range changes onto stable current node and edge IDs."""
    data = normalize_metadata(metadata)
    ranges = metadata.get("changed-ranges", {})
    changed_files = data["changedFiles"]
    added_files = data["addedFiles"]

    def changed(item: Mapping[str, Any]) -> bool:
        file = item.get("file")
        if not isinstance(file, str):
            return False
        for path, path_ranges in ranges.items():
            if _matches(file, path) and _overlaps(item, path_ranges):
                return True
        if not ranges:
            for path in changed_files:
                if _matches(file, path):
                    return True
        return False

    data["changedNodeIds"] = sorted(
        str(node["id"]) for node in nodes if changed(node) and node.get("id")
    )
    data["addedNodeIds"] = sorted(
        str(node["id"])
        for node in nodes
        if node.get("id")
        and any(_matches(node.get("file"), path) for path in added_files)
    )
    data["changedEdgeIds"] = sorted(
        str(edge["id"])
        for edge in edges
        if edge.get("id")
        and any(changed(evidence) for evidence in [edge, *edge.get("evidence", [])])
    )
    return data
