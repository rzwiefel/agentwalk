import type { CodeEdge, CodeGraph, CodeNode, EdgeKind } from '../types';

export interface EvidenceLocation {
  source: string;
  file?: string;
  start?: {
    line: number;
    column: number;
  };
  end?: {
    line: number;
    column: number;
  };
  occurrenceIndex: number;
}

export interface EvidenceBackedEdge extends CodeEdge {
  occurrenceCount: number;
  evidence: EvidenceLocation[];
}

export interface NamespaceFactOptions {
  structuralEdgeKinds?: EdgeKind[];
}

export interface NamespaceFacts {
  knownNamespaces: Set<string>;
  namespaceByNode: Map<string, string>;
  externalNamespaces: Set<string>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function location(value: unknown): { line: number; column: number } | undefined {
  const input = record(value);
  const line = input.line ?? input.row;
  const column = input.column ?? input.col;
  return finiteNumber(line) && finiteNumber(column)
    ? { line, column }
    : undefined;
}

function evidenceLocation(value: unknown, fallback: CodeEdge, occurrenceIndex: number): EvidenceLocation {
  const input = record(value);
  const source = typeof input.source === 'string'
    ? input.source
    : typeof input.sourceNode === 'string'
      ? input.sourceNode
      : fallback.source;
  const file = typeof input.file === 'string' ? input.file : fallback.file;
  const start = location(input.start) ?? location({
    line: input.startLine ?? input.row ?? fallback.row,
    column: input.startColumn ?? input.col ?? fallback.col,
  });
  const end = location(input.end) ?? location({
    line: input.endLine ?? input.endRow,
    column: input.endColumn ?? input.endCol,
  });
  return {
    source,
    ...(file === undefined ? {} : { file }),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    occurrenceIndex,
  };
}

export function edgeOccurrenceCount(edge: CodeEdge): number {
  const input = edge as CodeEdge & { occurrenceCount?: unknown; evidence?: unknown };
  if (finiteNumber(input.occurrenceCount) && input.occurrenceCount >= 1) {
    return Math.max(1, Math.floor(input.occurrenceCount));
  }
  return Array.isArray(input.evidence) && input.evidence.length > 0 ? input.evidence.length : 1;
}

export function edgeEvidence(edge: CodeEdge): EvidenceLocation[] {
  const input = edge as CodeEdge & { evidence?: unknown };
  if (Array.isArray(input.evidence) && input.evidence.length > 0) {
    return input.evidence.map((entry, index) => evidenceLocation(entry, edge, index));
  }
  return [evidenceLocation({}, edge, 0)];
}

function namespaceForNode(node: CodeNode): string | undefined {
  if (node.kind === 'namespace') {
    return node.label;
  }
  return node.kind === 'var' ? node.namespace : undefined;
}

export function namespaceFacts(graph: CodeGraph): NamespaceFacts {
  const namespaceNodes = graph.nodes.filter(node => node.kind === 'namespace');
  const knownNamespaces = new Set(namespaceNodes
    .filter(node => node.external !== true)
    .map(namespaceForNode)
    .filter((value): value is string => value !== undefined));
  const allNamespaces = new Set(namespaceNodes
    .map(namespaceForNode)
    .filter((value): value is string => value !== undefined));
  const externalNamespaces = new Set([...allNamespaces].filter(namespace => !knownNamespaces.has(namespace)));
  const namespaceByNode = new Map<string, string>();
  graph.nodes.forEach(node => {
    const namespace = namespaceForNode(node);
    if (namespace === undefined) return;
    namespaceByNode.set(node.id, namespace);
  });
  return { knownNamespaces, namespaceByNode, externalNamespaces };
}
