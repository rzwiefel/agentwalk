"""Deterministic projection from shared parser IR to Codewalk graph-v2."""

from .graph_v2 import ProjectionError, project_graph

__all__ = ["ProjectionError", "project_graph"]
