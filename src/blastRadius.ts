import type { CodeEdge, CodeGraph, CodeNode, EdgeKind } from './types';

export type BlastRadiusDirection = 'forward' | 'reverse' | 'both';
export type BlastRadiusScope = 'internal' | 'external' | 'all';
export type BlastRadiusRelation = Extract<EdgeKind, 'requires' | 'calls' | 'mentions'>;

export interface BlastRadiusOptions {
  direction: BlastRadiusDirection;
  relationKinds: readonly BlastRadiusRelation[];
  includeMentions: boolean;
  maxDepth: number;
  maxPaths: number;
  scope: BlastRadiusScope;
}

export interface BlastRadiusQuery extends Partial<BlastRadiusOptions> {
  root: string | null;
}

export const DEFAULT_BLAST_RADIUS_OPTIONS: BlastRadiusOptions = {
  direction: 'both',
  relationKinds: ['requires'],
  includeMentions: false,
  maxDepth: 3,
  maxPaths: 100,
  scope: 'internal',
};

export interface BlastRadiusRelationFilter {
  kinds: BlastRadiusRelation[];
  structuralKinds: BlastRadiusRelation[];
  nonStructuralKinds: BlastRadiusRelation[];
}

export interface BlastRadiusPath {
  direction: Exclude<BlastRadiusDirection, 'both'>;
  nodeIds: string[];
  edgeIds: string[];
  distance: number;
}

export interface BlastRadiusEvidenceReference {
  source: 'v1-location' | 'v2-evidence';
  partial: boolean;
  nodeId?: string;
  edgeId?: string;
  file?: string;
  row?: number;
  col?: number;
  reference?: string;
  occurrenceCount?: number;
}

export interface BlastRadiusBounds {
  maxDepth: number;
  maxPaths: number;
  pathsConsidered: number;
  pathsReturned: number;
  depthTruncated: boolean;
  pathTruncated: boolean;
  truncated: boolean;
}

export interface BlastRadiusResult {
  analysisType: 'structural-reachability';
  label: 'Structural reachability';
  root: string | null;
  rootNodeIds: string[];
  direction: BlastRadiusDirection;
  relationFilter: BlastRadiusRelationFilter;
  scope: BlastRadiusScope;
  affectedNodeIds: string[];
  affectedNamespaceIds: string[];
  shortestDistance: Record<string, number>;
  directionsByNode: Record<string, Array<Exclude<BlastRadiusDirection, 'both'>>>;
  paths: BlastRadiusPath[];
  sourceEvidenceReferences: BlastRadiusEvidenceReference[];
  occurrenceCountByEdge: Record<string, number>;
  bounds: BlastRadiusBounds;
  notes: string[];
}

interface TraversalPath {
  direction: Exclude<BlastRadiusDirection, 'both'>;
  nodeIds: string[];
  edgeIds: string[];
  distance: number;
}

interface TraversalResult {
  pathsByNode: Map<string, TraversalPath>;
  depthTruncated: boolean;
}

interface UnknownRecord {
  [key: string]: unknown;
}

const relationOrder: BlastRadiusRelation[] = ['requires', 'calls', 'mentions'];

function asRecord(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null ? value as UnknownRecord : {};
}

function finiteNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function normalizeRelationKinds(options: Partial<BlastRadiusOptions>): BlastRadiusRelation[] {
  const requested = options.relationKinds ?? DEFAULT_BLAST_RADIUS_OPTIONS.relationKinds;
  const relationSet = new Set<BlastRadiusRelation>();
  requested.forEach(kind => {
    if (relationOrder.includes(kind)) relationSet.add(kind);
  });
  if (options.includeMentions === true) relationSet.add('mentions');
  return relationOrder.filter(kind => relationSet.has(kind));
}

export function normalizeBlastRadiusOptions(options: Partial<BlastRadiusOptions> = {}): BlastRadiusOptions {
  const direction = options.direction === 'forward' || options.direction === 'reverse' || options.direction === 'both'
    ? options.direction
    : DEFAULT_BLAST_RADIUS_OPTIONS.direction;
  const scope = options.scope === 'internal' || options.scope === 'external' || options.scope === 'all'
    ? options.scope
    : DEFAULT_BLAST_RADIUS_OPTIONS.scope;
  return {
    direction,
    relationKinds: normalizeRelationKinds(options),
    includeMentions: options.includeMentions ?? DEFAULT_BLAST_RADIUS_OPTIONS.includeMentions,
    maxDepth: finiteNonNegativeInteger(options.maxDepth, DEFAULT_BLAST_RADIUS_OPTIONS.maxDepth),
    maxPaths: finiteNonNegativeInteger(options.maxPaths, DEFAULT_BLAST_RADIUS_OPTIONS.maxPaths),
    scope,
  };
}

function nodeIsInScope(node: CodeNode, scope: BlastRadiusScope): boolean {
  return scope === 'all' || (scope === 'external' ? node.external === true : node.external !== true);
}

function compareStringArrays(left: string[], right: string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function comparePaths(left: TraversalPath, right: TraversalPath): number {
  return left.distance - right.distance
    || left.nodeIds[left.nodeIds.length - 1].localeCompare(right.nodeIds[right.nodeIds.length - 1])
    || compareStringArrays(left.edgeIds, right.edgeIds);
}

function edgeSort(left: CodeEdge, right: CodeEdge): number {
  return left.id.localeCompare(right.id)
    || left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target)
    || left.kind.localeCompare(right.kind);
}

function resolveRootNodeIds(graph: CodeGraph, root: string | null): string[] {
  if (!root) return [];
  const exact = graph.nodes.find(node => node.id === root);
  if (exact) return [exact.id];
  return graph.nodes
    .filter(node => node.kind === 'namespace' && (node.label === root || node.namespace === root || node.id === `namespace:${root}`))
    .map(node => node.id)
    .sort((left, right) => left.localeCompare(right));
}

function traverse(
  graph: CodeGraph,
  rootNodeIds: string[],
  options: BlastRadiusOptions,
  direction: Exclude<BlastRadiusDirection, 'both'>,
): TraversalResult {
  const nodeIndex = new Map(graph.nodes.map(node => [node.id, node]));
  const adjacency = new Map<string, CodeEdge[]>();
  graph.edges
    .filter(edge => options.relationKinds.includes(edge.kind as BlastRadiusRelation))
    .sort(edgeSort)
    .forEach(edge => {
      const from = direction === 'forward' ? edge.source : edge.target;
      const edges = adjacency.get(from) ?? [];
      edges.push(edge);
      adjacency.set(from, edges);
    });

  const pathsByNode = new Map<string, TraversalPath>();
  const queue: TraversalPath[] = rootNodeIds
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .map(nodeId => ({ direction, nodeIds: [nodeId], edgeIds: [], distance: 0 }));
  const visited = new Map<string, TraversalPath>();
  queue.forEach(path => visited.set(path.nodeIds[0], path));
  let depthTruncated = false;

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const currentNodeId = current.nodeIds[current.nodeIds.length - 1];
    const outgoing = adjacency.get(currentNodeId) ?? [];
    for (const edge of outgoing) {
      const nextNodeId = direction === 'forward' ? edge.target : edge.source;
      const nextNode = nodeIndex.get(nextNodeId);
      if (!nextNode) continue;
      if (current.distance >= options.maxDepth) {
        if (!visited.has(nextNodeId) && nodeIsInScope(nextNode, options.scope)) depthTruncated = true;
        continue;
      }
      if (!nodeIsInScope(nextNode, options.scope) || current.nodeIds.includes(nextNodeId)) continue;
      const candidate: TraversalPath = {
        direction,
        nodeIds: [...current.nodeIds, nextNodeId],
        edgeIds: [...current.edgeIds, edge.id],
        distance: current.distance + 1,
      };
      const previous = visited.get(nextNodeId);
      if (previous && (previous.distance < candidate.distance || (previous.distance === candidate.distance && comparePaths(previous, candidate) <= 0))) continue;
      visited.set(nextNodeId, candidate);
      pathsByNode.set(nextNodeId, candidate);
      queue.push(candidate);
    }
  }
  return { pathsByNode, depthTruncated };
}

function namespaceIdsFor(nodes: CodeNode[], affectedNodeIds: string[]): string[] {
  const namespaceNodes = nodes.filter(node => node.kind === 'namespace');
  const byName = new Map<string, string>();
  namespaceNodes.forEach(node => {
    byName.set(node.id, node.id);
    if (node.namespace) byName.set(node.namespace, node.id);
    byName.set(node.label, node.id);
  });
  return [...new Set(affectedNodeIds.flatMap(nodeId => {
    const node = nodes.find(candidate => candidate.id === nodeId);
    if (!node) return [];
    if (node.kind === 'namespace') return [node.id];
    return node.namespace && byName.has(node.namespace) ? [byName.get(node.namespace)!] : [];
  }))].sort((left, right) => left.localeCompare(right));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function locationReference(
  value: unknown,
  owner: { nodeId?: string; edgeId?: string },
  source: BlastRadiusEvidenceReference['source'],
  partial: boolean,
  occurrenceCount?: number,
): BlastRadiusEvidenceReference | undefined {
  const record = asRecord(value);
  const nested = asRecord(record.location);
  const file = stringValue(record.file) ?? stringValue(record.path) ?? stringValue(record.sourceFile)
    ?? stringValue(nested.file) ?? stringValue(nested.path);
  const row = numberValue(record.row) ?? numberValue(record.line) ?? numberValue(nested.row) ?? numberValue(nested.line);
  const col = numberValue(record.col) ?? numberValue(record.column) ?? numberValue(nested.col) ?? numberValue(nested.column);
  const reference = typeof value === 'string' ? value : stringValue(record.reference) ?? stringValue(record.id);
  if (!file && row === undefined && col === undefined && !reference) return undefined;
  return { ...owner, source, partial, file, row, col, reference, occurrenceCount };
}

function evidenceFor(
  value: CodeNode | CodeEdge,
  owner: { nodeId?: string; edgeId?: string },
): BlastRadiusEvidenceReference[] {
  const record = value as unknown as UnknownRecord;
  const occurrenceCount = numberValue(record.occurrenceCount);
  const references: BlastRadiusEvidenceReference[] = [];
  if (Array.isArray(record.evidence)) {
    record.evidence.forEach(item => {
      const itemOccurrenceCount = numberValue(asRecord(item).occurrenceCount) ?? occurrenceCount;
      const reference = locationReference(item, owner, 'v2-evidence', false, itemOccurrenceCount);
      if (reference) references.push(reference);
    });
  }
  const v1 = locationReference(record, owner, 'v1-location', true, occurrenceCount);
  if (v1) references.push(v1);
  return references;
}

function evidenceKey(reference: BlastRadiusEvidenceReference): string {
  return [
    reference.source,
    reference.nodeId ?? '',
    reference.edgeId ?? '',
    reference.file ?? '',
    reference.row ?? '',
    reference.col ?? '',
    reference.reference ?? '',
  ].join('|');
}

function collectEvidence(
  graph: CodeGraph,
  nodeIdsToExplain: string[],
  paths: BlastRadiusPath[],
): BlastRadiusEvidenceReference[] {
  const nodeIndex = new Map(graph.nodes.map(node => [node.id, node]));
  const edgeIndex = new Map(graph.edges.map(edge => [edge.id, edge]));
  const references = [
    ...nodeIdsToExplain.flatMap(nodeId => {
      const node = nodeIndex.get(nodeId);
      return node ? evidenceFor(node, { nodeId }) : [];
    }),
    ...[...new Set(paths.flatMap(path => path.edgeIds))].sort((left, right) => left.localeCompare(right)).flatMap(edgeId => {
      const edge = edgeIndex.get(edgeId);
      return edge ? evidenceFor(edge, { edgeId }) : [];
    }),
  ];
  return [...new Map(references.map(reference => [evidenceKey(reference), reference])).values()];
}

function emptyResult(root: string | null, options: BlastRadiusOptions, rootNodeIds: string[]): BlastRadiusResult {
  const relationKinds = options.relationKinds.slice();
  return {
    analysisType: 'structural-reachability',
    label: 'Structural reachability',
    root,
    rootNodeIds,
    direction: options.direction,
    relationFilter: {
      kinds: relationKinds,
      structuralKinds: relationKinds.filter(kind => kind !== 'mentions'),
      nonStructuralKinds: relationKinds.filter(kind => kind === 'mentions'),
    },
    scope: options.scope,
    affectedNodeIds: [],
    affectedNamespaceIds: [],
    shortestDistance: {},
    directionsByNode: {},
    paths: [],
    sourceEvidenceReferences: [],
    occurrenceCountByEdge: {},
    bounds: {
      maxDepth: options.maxDepth,
      maxPaths: options.maxPaths,
      pathsConsidered: 0,
      pathsReturned: 0,
      depthTruncated: false,
      pathTruncated: false,
      truncated: false,
    },
    notes: ['This is structural reachability, not a causal impact prediction.'],
  };
}

export function analyzeBlastRadius(
  graph: CodeGraph,
  root: string | null,
  options?: Partial<BlastRadiusOptions>,
): BlastRadiusResult;
export function analyzeBlastRadius(graph: CodeGraph, query: BlastRadiusQuery): BlastRadiusResult;
export function analyzeBlastRadius(
  graph: CodeGraph,
  rootOrQuery: string | null | BlastRadiusQuery,
  suppliedOptions: Partial<BlastRadiusOptions> = {},
): BlastRadiusResult {
  const query = typeof rootOrQuery === 'object' && rootOrQuery !== null
    ? rootOrQuery
    : { ...suppliedOptions, root: rootOrQuery };
  const root = query.root;
  const options = normalizeBlastRadiusOptions(query);
  const rootNodeIds = resolveRootNodeIds(graph, root);
  if (rootNodeIds.length === 0) return emptyResult(root, options, rootNodeIds);

  const traversals: TraversalResult[] = [];
  if (options.direction === 'forward' || options.direction === 'both') traversals.push(traverse(graph, rootNodeIds, options, 'forward'));
  if (options.direction === 'reverse' || options.direction === 'both') traversals.push(traverse(graph, rootNodeIds, options, 'reverse'));

  const traversalPaths = traversals.flatMap(traversal => [...traversal.pathsByNode.values()]);
  const affectedNodeIds = [...new Set(traversalPaths.map(path => path.nodeIds[path.nodeIds.length - 1]))]
    .filter(nodeId => !rootNodeIds.includes(nodeId))
    .sort((left, right) => left.localeCompare(right));
  const shortestDistance: Record<string, number> = {};
  const directionsByNode: Record<string, Array<Exclude<BlastRadiusDirection, 'both'>>> = {};
  affectedNodeIds.forEach(nodeId => {
    const paths = traversalPaths.filter(path => path.nodeIds[path.nodeIds.length - 1] === nodeId).sort(comparePaths);
    shortestDistance[nodeId] = paths[0].distance;
    directionsByNode[nodeId] = [...new Set(paths.map(path => path.direction))].sort();
  });
  const directionRank = (direction: TraversalPath['direction']) => direction === 'reverse' ? 0 : 1;
  const representativeCandidates = traversalPaths
    .filter(path => !rootNodeIds.includes(path.nodeIds[path.nodeIds.length - 1]))
    .sort((left, right) => left.distance - right.distance
      || directionRank(left.direction) - directionRank(right.direction)
      || left.nodeIds[left.nodeIds.length - 1].localeCompare(right.nodeIds[right.nodeIds.length - 1])
      || compareStringArrays(left.edgeIds, right.edgeIds));
  const paths = representativeCandidates.slice(0, options.maxPaths).map(path => ({
    direction: path.direction,
    nodeIds: path.nodeIds,
    edgeIds: path.edgeIds,
    distance: path.distance,
  }));
  const pathTruncated = representativeCandidates.length > options.maxPaths;
  const occurrenceCountByEdge: Record<string, number> = {};
  graph.edges.forEach(edge => {
    const occurrenceCount = numberValue((edge as unknown as UnknownRecord).occurrenceCount);
    if (occurrenceCount !== undefined) occurrenceCountByEdge[edge.id] = occurrenceCount;
  });
  const depthTruncated = traversals.some(traversal => traversal.depthTruncated);
  return {
    ...emptyResult(root, options, rootNodeIds),
    affectedNodeIds,
    affectedNamespaceIds: namespaceIdsFor(graph.nodes, affectedNodeIds),
    shortestDistance,
    directionsByNode,
    paths,
    sourceEvidenceReferences: collectEvidence(graph, [...rootNodeIds, ...affectedNodeIds], paths),
    occurrenceCountByEdge,
    bounds: {
      maxDepth: options.maxDepth,
      maxPaths: options.maxPaths,
      pathsConsidered: representativeCandidates.length,
      pathsReturned: paths.length,
      depthTruncated,
      pathTruncated,
      truncated: depthTruncated || pathTruncated,
    },
  };
}
