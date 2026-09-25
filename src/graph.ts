import type { CodeEdge, CodeGraph, CodeNode, EdgeEvidence, EdgeKind, GraphAnalysis, GraphHistory, HistoryCommit, NodeKind, RevisionMetadata, RevisionMode } from './types';

const nodeKinds = new Set<NodeKind>(['namespace', 'var', 'keyword']);
const edgeKinds = new Set<EdgeKind>(['requires', 'calls', 'mentions']);

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parserIdentity(value: string): boolean {
  return /^(?:namespace:module:|var:(?:namespace|module):|package:)/.test(value);
}

function concisePath(value: string): string {
  const normalized = value.replace(/^(?:namespace:module:|var:(?:namespace|module):)/, '').replace(/^\.?[\\/]+/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('/') : normalized;
}

export function displayNamespaceLabel(namespace: string | undefined): string {
  if (!namespace) return 'global';
  return concisePath(namespace);
}

export function displayLabel(node: CodeNode): string {
  if (!parserIdentity(node.id) && !parserIdentity(node.label)) return node.label;
  if (node.id.startsWith('package:') || node.label.startsWith('package:')) {
    return (node.label || node.id).replace(/^package:/, '').trim() || 'package';
  }
  const raw = node.kind === 'namespace'
    ? node.file ?? node.namespace ?? node.label ?? node.fqn ?? node.id
    : node.label || node.fqn || node.id;
  const stripped = raw
    .replace(/^(?:namespace:module:|var:(?:namespace|module):|package:)/, '')
    .replace(/@[0-9]+(?::[0-9]+)?$/, '')
    .replace(/\([^)]*\).*$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1)
    ?.split('#')
    .at(-1)
    ?.split(':')
    .at(-1)
    ?.trim();
  return stripped || (node.kind === 'namespace' ? 'module' : 'symbol');
}

export function displayLabels(nodes: readonly CodeNode[]): Map<string, string> {
  const labels = new Map(nodes.map(node => [node.id, displayLabel(node)]));
  const collisions = new Map<string, CodeNode[]>();
  nodes.forEach(node => {
    const key = `${node.namespace ?? ''}\u0000${node.kind}\u0000${labels.get(node.id)}`;
    const group = collisions.get(key) ?? [];
    group.push(node);
    collisions.set(key, group);
  });
  collisions.forEach(group => {
    if (group.length < 2) return;
    group.sort((left, right) => left.id.localeCompare(right.id)).forEach(node => {
      const qualifier = node.fqn?.split(/[./\\]/).filter(Boolean).at(-2) ?? node.id.slice(-8);
      labels.set(node.id, `${labels.get(node.id)} · ${qualifier}`);
    });
  });
  return labels;
}

export function isTopLevelFolderNode(node: CodeNode): boolean {
  if (node.kind !== 'namespace' || !parserIdentity(node.id)) return false;
  const value = (node.namespace ?? node.file ?? node.label ?? node.id)
    .replace(/^namespace:module:/, '')
    .replace(/\.[a-z0-9]+$/i, '');
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.length === 1 && !segments[0].includes('.');
}

export function filterTopLevelFolderConnections(
  edges: readonly CodeEdge[],
  nodes: readonly CodeNode[],
  show: boolean,
): CodeEdge[] {
  if (show) return [...edges];
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  return edges.filter(edge => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    return !(source && isTopLevelFolderNode(source)) && !(target && isTopLevelFolderNode(target));
  });
}

export function filterEdgesByVisibleNodes(edges: readonly CodeEdge[], visibleNodeIds: ReadonlySet<string>): CodeEdge[] {
  return edges.filter(edge => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
}

function location(value: unknown): { line: number; column: number } | undefined {
  const input = record(value);
  const line = optionalNumber(input.line) ?? optionalNumber(input.row);
  const column = optionalNumber(input.column) ?? optionalNumber(input.col);
  return line === undefined || column === undefined ? undefined : { line, column };
}

function normalizeNode(value: unknown, index: number): CodeNode {
  const input = record(value);
  const kind = nodeKinds.has(input.kind as NodeKind) ? input.kind as NodeKind : 'var';
  const id = stringValue(input.id, `${kind}:${index}`);
  return {
    id,
    kind,
    label: stringValue(input.label, id),
    namespace: optionalString(input.namespace),
    keywordQualifier: optionalString(input.keywordQualifier) ?? optionalString(input.qualifier),
    fqn: optionalString(input.fqn),
    file: optionalString(input.file),
    projectId: optionalString(input.projectId),
    projectName: optionalString(input.projectName),
    assemblyName: optionalString(input.assemblyName),
    projectPath: optionalString(input.projectPath),
    row: optionalNumber(input.row),
    col: optionalNumber(input.col),
    endRow: optionalNumber(input.endRow),
    endCol: optionalNumber(input.endCol),
    doc: optionalString(input.doc),
    external: optionalBoolean(input.external) ?? false,
    private: optionalBoolean(input.private),
    macro: optionalBoolean(input.macro),
    deprecated: optionalBoolean(input.deprecated),
    synthetic: optionalBoolean(input.synthetic),
    resolutionStatus: optionalString(input.resolutionStatus),
    usageCount: optionalNumber(input.usageCount),
    arities: Array.isArray(input.arities)
      ? input.arities.filter((item): item is number => typeof item === 'number')
      : undefined,
    arglists: Array.isArray(input.arglists)
      ? input.arglists.filter((item): item is string => typeof item === 'string')
      : undefined,
    lexicalNamespaces: Array.isArray(input.lexicalNamespaces)
      ? input.lexicalNamespaces.filter((item): item is string => typeof item === 'string')
      : undefined,
  };
}

function normalizeEvidence(value: unknown, edge: CodeEdge, occurrenceIndex: number): EdgeEvidence | undefined {
  const input = record(value);
  const source = optionalString(input.source)
    ?? optionalString(input.sourceNode)
    ?? edge.source;
  const file = optionalString(input.file) ?? edge.file;
  const start = location(input.start) ?? location({
    line: input.startLine ?? input.row ?? edge.row,
    column: input.startColumn ?? input.col ?? edge.col,
  });
  const end = location(input.end) ?? location({
    line: input.endLine ?? input.endRow ?? edge.endRow,
    column: input.endColumn ?? input.endCol ?? edge.endCol,
  });
  return {
    source,
    ...(file === undefined ? {} : { file }),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    occurrenceIndex,
  };
}

function normalizeEdge(value: unknown, index: number): CodeEdge {
  const input = record(value);
  const kind = edgeKinds.has(input.kind as EdgeKind) ? input.kind as EdgeKind : 'calls';
  const edge: CodeEdge = {
    id: stringValue(input.id, `${kind}:${index}`),
    kind,
    source: stringValue(input.source, ''),
    target: stringValue(input.target, ''),
    file: optionalString(input.file),
    row: optionalNumber(input.row),
    col: optionalNumber(input.col),
    endRow: optionalNumber(input.endRow),
    endCol: optionalNumber(input.endCol),
  };
  const rawEvidence = Array.isArray(input.evidence) ? input.evidence : [];
  const evidence = rawEvidence
    .map((item, evidenceIndex) => normalizeEvidence(item, edge, evidenceIndex))
    .filter((item): item is EdgeEvidence => item !== undefined);
  const rawOccurrenceCount = optionalNumber(input.occurrenceCount);
  const legacyEvidenceEntry = evidence.length > 0 ? undefined : normalizeEvidence(edge, edge, 0);
  const normalizedEvidence = evidence.length > 0
    ? evidence
    : legacyEvidenceEntry ? [legacyEvidenceEntry] : [];
  return {
    ...edge,
    occurrenceCount: normalizedEvidence.length > 0
      ? Math.max(1, normalizedEvidence.length)
      : rawOccurrenceCount === undefined ? 1 : Math.max(1, Math.floor(rawOccurrenceCount)),
    evidence: normalizedEvidence,
  };
}


function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return values.length > 0 ? values : undefined;
}

function normalizeCommit(value: unknown, index: number): HistoryCommit {
  const input = record(value);
  const hash = stringValue(input.hash, stringValue(input.id, 'commit-' + index));
  const changedNodeIds = stringArray(input.changedNodeIds) ?? stringArray(input.changedNodes) ?? [];
  const changedEdgeIds = Array.isArray(input.changedEdgeIds)
    ? stringArray(input.changedEdgeIds) ?? []
    : undefined;
  return {
    id: stringValue(input.id, hash),
    hash,
    shortHash: stringValue(input.shortHash, hash.slice(0, 8)),
    message: stringValue(input.message, 'Untitled commit'),
    author: optionalString(input.author),
    timestamp: stringValue(input.timestamp, new Date(index * 1000).toISOString()),
    changedNodeIds,
    addedNodeIds: stringArray(input.addedNodeIds) ?? [],
    ...(changedEdgeIds === undefined ? {} : { changedEdgeIds }),
    changedFiles: stringArray(input.changedFiles),
    addedFiles: stringArray(input.addedFiles),
  };
}

function normalizeAnalysis(value: unknown): GraphAnalysis | undefined {
  const input = record(value);
  const mode = input.mode === 'full' || input.mode === 'incremental' || input.mode === 'incremental-map' || input.mode === 'cached' ? input.mode : undefined;
  return mode && typeof input.files === 'number' ? { mode, files: input.files } : undefined;
}

function normalizeRevision(value: unknown): RevisionMetadata | undefined {
  const input = record(value);
  const mode = input.mode === 'full' || input.mode === 'cached' || input.mode === 'incremental-map'
    ? input.mode as RevisionMode
    : undefined;
  const commit = optionalString(input.commit);
  if (!mode || !commit) return undefined;
  return {
    commit,
    parentCommit: optionalString(input.parentCommit),
    mode,
    changedFiles: stringArray(input.changedFiles) ?? [],
    addedFiles: stringArray(input.addedFiles) ?? [],
    deletedFiles: stringArray(input.deletedFiles) ?? [],
    renamedFiles: stringArray(input.renamedFiles) ?? [],
    limitations: stringArray(input.limitations) ?? [],
  };
}

function normalizeHistory(value: unknown): GraphHistory | undefined {
  const input = record(value);
  if (!Array.isArray(input.commits)) return undefined;
  const commits = input.commits
    .map(normalizeCommit)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  return { commits };
}

function statsFor(nodes: CodeNode[], edges: CodeEdge[]): Record<string, number> {
  const nodeCounts = { namespace: 0, var: 0, keyword: 0 };
  const edgeCounts = { requires: 0, calls: 0, mentions: 0 };
  let externalNodes = 0;
  nodes.forEach(node => {
    nodeCounts[node.kind] += 1;
    if (node.external) externalNodes += 1;
  });
  edges.forEach(edge => {
    edgeCounts[edge.kind] += 1;
  });
  return {
    nodes: nodes.length,
    edges: edges.length,
    namespaces: nodeCounts.namespace,
    vars: nodeCounts.var,
    keywords: nodeCounts.keyword,
    requires: edgeCounts.requires,
    calls: edgeCounts.calls,
    mentions: edgeCounts.mentions,
    externalNodes,
  };
}

export function normalizeGraph(value: unknown): CodeGraph {
  const input = record(value);
  const repoInput = record(input.repo);
  const rawNodes = Array.isArray(input.nodes) ? input.nodes.map(normalizeNode) : [];
  const nodes = [...new Map(rawNodes.map(node => [node.id, node])).values()];
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = (Array.isArray(input.edges) ? input.edges.map(normalizeEdge) : [])
    .filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const graph: CodeGraph = {
    formatVersion: typeof input.formatVersion === 'number' ? input.formatVersion : 1,
    generatedAt: stringValue(input.generatedAt, new Date().toISOString()),
    analysis: normalizeAnalysis(input.analysis),
    repo: {
      name: stringValue(repoInput.name, 'local repository'),
      root: stringValue(repoInput.root, ''),
    },
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
    stats: statsFor(nodes, edges),
    history: normalizeHistory(input.history),
    revision: normalizeRevision(input.revision),
  };
  if (graph.nodes.length === 0 && !Array.isArray(input.nodes)) {
    throw new Error('The graph contains no nodes. Export at least one source path first.');
  }
  return graph;
}

export function nodeIndex(graph: CodeGraph): Map<string, CodeNode> {
  return new Map(graph.nodes.map(node => [node.id, node]));
}

export function neighborIds(graph: CodeGraph, nodeId: string): Set<string> {
  const neighbors = new Set<string>([nodeId]);
  graph.edges.forEach(edge => {
    if (edge.source === nodeId) neighbors.add(edge.target);
    if (edge.target === nodeId) neighbors.add(edge.source);
  });
  return neighbors;
}
