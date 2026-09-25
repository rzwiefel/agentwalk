import type { CodeEdge, CodeGraph, CodeNode, EdgeKind } from './types';

export type RelationshipCounts = Record<EdgeKind, number>;
export type EvidenceSource = 'v1-span' | 'v2';

export interface ArchitectureEvidence {
  file?: string;
  row?: number;
  col?: number;
  endRow?: number;
  endCol?: number;
  source: EvidenceSource;
  partial: boolean;
}

export interface NamespaceProjectionOptions {
  includeRequires?: boolean;
  includeCalls?: boolean;
  includeMentions?: boolean;
  edgeKinds?: EdgeKind[];
}

export interface NamespaceProjectionEdge {
  id: string;
  source: string;
  target: string;
  counts: RelationshipCounts;
  weight: number;
  occurrenceWeight: number;
  edgeIds: string[];
  evidence: ArchitectureEvidence[];
}

export interface NamespaceProjection {
  namespaces: string[];
  edges: NamespaceProjectionEdge[];
  externalNodes: ExternalBoundaryNode[];
  boundaryByNamespace: Map<string, { weight: number; edgeIds: string[] }>;
  limitations: string[];
  coverage: 'complete' | 'partial';
  evidenceCoverage: 'complete' | 'partial';
}

export interface ExternalBoundaryNode {
  id: string;
  label: string;
  edgeCount: number;
  weight: number;
}

export interface CommunityBoundary {
  sourceCommunityId: string;
  targetCommunityId: string;
  source: string;
  target: string;
  counts: RelationshipCounts;
  occurrenceWeight: number;
  edgeIds: string[];
  evidence: ArchitectureEvidence[];
}

export interface Community {
  id: string;
  label: string;
  members: string[];
  internalWeight: number;
  boundaryWeight: number;
  boundaryStrength: number;
  boundaryEdges: CommunityBoundary[];
  boundaryEdgeIds: string[];
  edgeIds: string[];
}

export interface CommunityAnalysis {
  projection: NamespaceProjection;
  communities: Community[];
  assignment: Map<string, string>;
  assignmentRecord: Record<string, string>;
  algorithm: 'weighted-label-propagation';
  driftCandidates: HierarchyDriftCandidate[];
  limitations: string[];
}

export interface HierarchyDriftCandidate {
  namespace: string;
  communityId: string;
  hierarchyRoot: string;
  communityRoot: string;
  score: number;
  reason: string;
}

export interface CommunitySnapshot {
  snapshotId?: string;
  assignments: Map<string, string> | Record<string, string>;
  namespaceIds?: string[];
}

export interface CommunityDrift {
  available: boolean;
  partial: boolean;
  coverage: 'unavailable' | 'partial' | 'complete';
  reason: string;
  movedNamespaces: string[];
  matches: Array<{
    previousCommunityId: string;
    currentCommunityId: string;
    overlap: number;
    previousMembers: string[];
    currentMembers: string[];
  }>;
}

export interface DsmNamespace {
  namespace: string;
  index: number;
  depth: number;
  groupId: string;
}

export interface DsmCell {
  id: string;
  source: string;
  target: string;
  sourceIndex: number;
  targetIndex: number;
  counts: RelationshipCounts;
  kindCounts: RelationshipCounts;
  total: number;
  weight: number;
  occurrenceWeight: number;
  edgeIds: string[];
  evidence: ArchitectureEvidence[];
  direction: 'forward' | 'backward' | 'diagonal';
  cyclic: boolean;
}

export interface DsmGroup {
  id: string;
  label: string;
  start: number;
  end: number;
  namespaces: string[];
}

export interface DsmModel {
  namespaces: DsmNamespace[];
  groups: DsmGroup[];
  rows: Array<{ source: string; cells: DsmCell[] }>;
  cells: DsmCell[];
  cycleNamespaces: string[];
  cycleCells: string[];
  forwardWeight: number;
  backwardWeight: number;
  cycleSignal: 'acyclic' | 'layered' | 'backward-heavy' | 'cyclic';
  coverage: 'complete' | 'partial';
  evidenceCoverage: 'complete' | 'partial';
  limitations: string[];
}

type RawEdge = CodeEdge & Record<string, unknown>;

const DEFAULT_EDGE_WEIGHTS: Record<EdgeKind, number> = { requires: 3, calls: 2, mentions: 1 };
const EDGE_KINDS: EdgeKind[] = ['requires', 'calls', 'mentions'];

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function multiplicity(edge: RawEdge): number {
  for (const key of ['occurrenceWeight', 'occurrenceCount', 'occurrences', 'multiplicity', 'count', 'weight']) {
    const value = finiteNumber(edge[key]);
    if (value !== undefined && value >= 0) return value;
  }
  return 1;
}

function namespaceForNode(node: CodeNode, allowedKeywordNamespaces?: Set<string>): string | undefined {
  if (node.kind === 'keyword') return node.namespace && (!allowedKeywordNamespaces || allowedKeywordNamespaces.has(node.namespace)) ? node.namespace : undefined;
  if (node.namespace) return node.namespace;
  if (node.kind === 'namespace') return node.label || node.id;
  return node.fqn?.split('/')[0];
}

function pathParts(namespace: string): string[] {
  return namespace.split(/[./:]/).filter(Boolean);
}

export function compareNamespaces(left: string, right: string): number {
  const a = pathParts(left);
  const b = pathParts(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const comparison = a[index].localeCompare(b[index], undefined, { numeric: true, sensitivity: 'base' });
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length || left.localeCompare(right);
}

function emptyCounts(): RelationshipCounts {
  return { requires: 0, calls: 0, mentions: 0 };
}

function evidenceFrom(value: unknown, source: EvidenceSource, partial: boolean): ArchitectureEvidence | undefined {
  const input = objectValue(value);
  const file = typeof input.file === 'string' ? input.file : typeof input.filename === 'string' ? input.filename : undefined;
  const row = finiteNumber(input.row);
  const col = finiteNumber(input.col);
  const endRow = finiteNumber(input.endRow ?? input['end-row']);
  const endCol = finiteNumber(input.endCol ?? input['end-col']);
  if (!file && row === undefined && col === undefined && endRow === undefined && endCol === undefined) return undefined;
  return { ...(file ? { file } : {}), ...(row === undefined ? {} : { row }), ...(col === undefined ? {} : { col }), ...(endRow === undefined ? {} : { endRow }), ...(endCol === undefined ? {} : { endCol }), source, partial };
}

export function edgeEvidence(edge: CodeEdge): ArchitectureEvidence[] {
  const raw = edge as RawEdge;
  const declared = raw.evidence ?? raw.evidences ?? raw.locations ?? (Array.isArray(raw.occurrences) ? raw.occurrences : undefined);
  const declaredObject = objectValue(declared);
  const nested = declaredObject.spans ?? declaredObject.locations ?? declaredObject.evidence;
  const v2 = nested ?? declared;
  const items = Array.isArray(v2) ? v2 : v2 && typeof v2 === 'object' ? [v2] : [];
  const v2Evidence = items.map(item => evidenceFrom(item, 'v2', false)).filter((item): item is ArchitectureEvidence => item !== undefined);
  if (v2Evidence.length > 0) return v2Evidence;
  const span = objectValue(raw.span ?? raw.sourceSpan ?? raw['source-span']);
  const legacy = evidenceFrom({
    file: raw.file ?? span.file ?? span.filename,
    row: raw.row ?? span.row,
    col: raw.col ?? span.col,
    endRow: raw.endRow ?? span.endRow ?? span['end-row'],
    endCol: raw.endCol ?? span.endCol ?? span['end-col'],
  }, 'v1-span', true);
  return legacy ? [legacy] : [];
}

function selectedKinds(options: NamespaceProjectionOptions): Set<EdgeKind> {
  if (options.edgeKinds) return new Set(options.edgeKinds);
  return new Set<EdgeKind>([
    ...(options.includeRequires === false ? [] : ['requires' as const]),
    ...(options.includeCalls ? ['calls' as const] : []),
    ...(options.includeMentions ? ['mentions' as const] : []),
  ]);
}

function project(graph: CodeGraph, options: NamespaceProjectionOptions = {}): NamespaceProjection {
  const namespaceByNode = new Map<string, string>();
  const knownNamespaces = new Set<string>();
  graph.nodes.forEach(node => {
    const namespace = node.kind === 'keyword' ? undefined : namespaceForNode(node);
    if (namespace && !node.external) knownNamespaces.add(namespace);
  });
  graph.nodes.forEach(node => {
    const namespace = namespaceForNode(node, knownNamespaces);
    if (namespace && !node.external) namespaceByNode.set(node.id, namespace);
  });
  const namespaces = [...new Set(namespaceByNode.values())].sort(compareNamespaces);
  const selected = selectedKinds(options);
  const pairs = new Map<string, NamespaceProjectionEdge>();
  const externalNodes = new Map<string, ExternalBoundaryNode>();
  const boundaryByNamespace = new Map<string, { weight: number; edgeIds: string[] }>();
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  let partial = false;
  let evidencePartial = false;

  graph.edges.forEach(edge => {
    if (!selected.has(edge.kind)) return;
    const source = namespaceByNode.get(edge.source);
    const target = namespaceByNode.get(edge.target);
    if (!source || !target) {
      partial = true;
      const boundaryNamespace = source ?? target;
      const boundaryNodeId = source ? edge.target : target ? edge.source : undefined;
      const boundaryNode = boundaryNodeId ? nodeById.get(boundaryNodeId) : undefined;
      if (boundaryNamespace && boundaryNode?.external) {
        const weight = multiplicity(edge as RawEdge) * DEFAULT_EDGE_WEIGHTS[edge.kind];
        const boundary = boundaryByNamespace.get(boundaryNamespace) ?? { weight: 0, edgeIds: [] };
        boundary.weight += weight;
        boundary.edgeIds.push(edge.id);
        boundaryByNamespace.set(boundaryNamespace, boundary);
        const external = externalNodes.get(boundaryNode.id) ?? {
          id: boundaryNode.id,
          label: boundaryNode.fqn ?? boundaryNode.label ?? boundaryNode.id,
          edgeCount: 0,
          weight: 0,
        };
        external.edgeCount += 1;
        external.weight += weight;
        externalNodes.set(boundaryNode.id, external);
      }
      return;
    }
    const raw = edge as RawEdge;
    const weight = multiplicity(raw);
    const evidence = edgeEvidence(edge);
    if (evidence.length === 0 || evidence.some(item => item.partial)) evidencePartial = true;
    const key = `${source}\u0000${target}`;
    const pair = pairs.get(key) ?? { id: key, source, target, counts: emptyCounts(), weight: 0, occurrenceWeight: 0, edgeIds: [], evidence: [] };
    pair.counts[edge.kind] += weight;
    pair.weight += weight * DEFAULT_EDGE_WEIGHTS[edge.kind];
    pair.occurrenceWeight += weight;
    pair.edgeIds.push(edge.id);
    pair.evidence.push(...evidence);
    pairs.set(key, pair);
  });
  return {
    namespaces,
    edges: [...pairs.values()].map(edge => ({ ...edge, edgeIds: [...new Set(edge.edgeIds)].sort() })).sort((a, b) => compareNamespaces(a.source, b.source) || compareNamespaces(a.target, b.target)),
    externalNodes: [...externalNodes.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
    boundaryByNamespace: new Map([...boundaryByNamespace.entries()].map(([namespace, value]) => [
      namespace,
      { weight: value.weight, edgeIds: [...new Set(value.edgeIds)].sort() },
    ])),
    coverage: partial ? 'partial' : 'complete',
    evidenceCoverage: evidencePartial ? 'partial' : 'complete',
    limitations: [
      'Projection is namespace-level; vars and keywords are aggregated only when their namespace is explicit.',
      'Requires edges are enabled by default; calls and mentions are opt-in.',
      'External or unresolved endpoints are excluded from community members.',
      'External nodes are retained as boundary evidence, not folded into internal communities.',
    ],
  };
}

export function buildNamespaceProjection(graph: CodeGraph, options: NamespaceProjectionOptions = {}): NamespaceProjection {
  return project(graph, options);
}

export function namespaceHierarchyOrder(graph: CodeGraph, options: NamespaceProjectionOptions = {}): string[] {
  return project(graph, options).namespaces;
}

function stableCommunityId(members: string[]): string {
  return `community:${members.slice().sort(compareNamespaces).join('|')}`;
}

function detectLabels(projection: NamespaceProjection): Map<string, string> {
  const adjacency = new Map(projection.namespaces.map(namespace => [namespace, new Map<string, number>()]));
  projection.edges.forEach(edge => {
    if (edge.source === edge.target) return;
    adjacency.get(edge.source)?.set(edge.target, (adjacency.get(edge.source)?.get(edge.target) ?? 0) + edge.weight);
    adjacency.get(edge.target)?.set(edge.source, (adjacency.get(edge.target)?.get(edge.source) ?? 0) + edge.weight);
  });
  const labels = new Map(projection.namespaces.map(namespace => [namespace, namespace]));
  const maxIterations = Math.max(1, projection.namespaces.length * 2);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let changed = false;
    projection.namespaces.forEach(namespace => {
      const scores = new Map<string, number>();
      adjacency.get(namespace)?.forEach((weight, neighbor) => {
        const label = labels.get(neighbor) ?? neighbor;
        scores.set(label, (scores.get(label) ?? 0) + weight);
      });
      if (scores.size === 0) return;
      const best = [...scores.entries()].sort((a, b) => b[1] - a[1] || compareNamespaces(a[0], b[0]))[0][0];
      if (best !== labels.get(namespace)) {
        labels.set(namespace, best);
        changed = true;
      }
    });
    if (!changed) break;
  }
  return labels;
}

function communityLabel(members: string[]): string {
  const parts = members.map(pathParts);
  let common = 0;
  const shortest = parts.reduce((minimum, value) => Math.min(minimum, value.length), Number.MAX_SAFE_INTEGER);
  while (parts.length > 0 && common < shortest && parts.every(value => value[common] === parts[0][common])) common += 1;
  return parts[0]?.slice(0, common).join('.') || members[0] || 'community';
}

export function detectCommunities(graph: CodeGraph, options: NamespaceProjectionOptions = {}): CommunityAnalysis {
  const projection = project(graph, options);
  const labels = detectLabels(projection);
  const groups = new Map<string, string[]>();
  projection.namespaces.forEach(namespace => {
    const label = labels.get(namespace) ?? namespace;
    groups.set(label, [...(groups.get(label) ?? []), namespace]);
  });
  const assignment = new Map<string, string>();
  const communities = [...groups.values()].map(members => {
    members.sort(compareNamespaces);
    const id = stableCommunityId(members);
    members.forEach(member => assignment.set(member, id));
    return { id, members };
  }).sort((a, b) => compareNamespaces(a.members[0] ?? '', b.members[0] ?? ''));
  const boundaries: CommunityBoundary[] = [];
  const projectionEdgeById = new Map(projection.edges.map(edge => [edge.id, edge]));
  projection.edges.forEach(edge => {
    const sourceCommunityId = assignment.get(edge.source);
    const targetCommunityId = assignment.get(edge.target);
    if (!sourceCommunityId || !targetCommunityId || sourceCommunityId === targetCommunityId) return;
    boundaries.push({
      sourceCommunityId,
      targetCommunityId,
      source: edge.source,
      target: edge.target,
      counts: edge.counts,
      occurrenceWeight: edge.occurrenceWeight,
      edgeIds: edge.edgeIds,
      evidence: edge.evidence,
    });
  });
  const result = communities.map(group => {
    const memberSet = new Set(group.members);
    const internalWeight = projection.edges.filter(edge => memberSet.has(edge.source) && memberSet.has(edge.target)).reduce((sum, edge) => sum + edge.weight, 0);
    const boundaryEdges = boundaries.filter(edge => edge.sourceCommunityId === group.id || edge.targetCommunityId === group.id);
    const boundaryWeight = boundaryEdges.reduce((sum, edge) => {
      const projectionEdge = projectionEdgeById.get(`${edge.source}\u0000${edge.target}`);
      return sum + (projectionEdge?.weight ?? edge.occurrenceWeight);
    }, 0) + group.members.reduce((sum, namespace) => sum + (projection.boundaryByNamespace.get(namespace)?.weight ?? 0), 0);
    const boundaryEdgeIds = [
      ...boundaryEdges.flatMap(edge => edge.edgeIds),
      ...group.members.flatMap(namespace => projection.boundaryByNamespace.get(namespace)?.edgeIds ?? []),
    ];
    return {
      id: group.id,
      label: communityLabel(group.members),
      members: group.members,
      internalWeight,
      boundaryWeight,
      boundaryStrength: boundaryWeight / Math.max(1, internalWeight + boundaryWeight),
      boundaryEdges,
      boundaryEdgeIds: [...new Set(boundaryEdgeIds)].sort(),
      edgeIds: [...new Set([...boundaryEdgeIds, ...projection.edges.filter(edge => memberSet.has(edge.source) && memberSet.has(edge.target)).flatMap(edge => edge.edgeIds)])].sort(),
    };
  });
  const assignmentRecord = Object.fromEntries([...assignment.entries()].sort(([a], [b]) => compareNamespaces(a, b)));
  const driftCandidates = result.flatMap(community => {
    const roots = new Map<string, number>();
    community.members.forEach(namespace => {
      const root = pathParts(namespace)[0] ?? namespace;
      roots.set(root, (roots.get(root) ?? 0) + 1);
    });
    const communityRoot = [...roots.entries()].sort((a, b) => b[1] - a[1] || compareNamespaces(a[0], b[0]))[0]?.[0] ?? '';
    return community.members
      .filter(namespace => (pathParts(namespace)[0] ?? namespace) !== communityRoot)
      .map(namespace => ({
        namespace,
        communityId: community.id,
        hierarchyRoot: pathParts(namespace)[0] ?? namespace,
        communityRoot,
        score: Math.min(1, 0.5 + (roots.get(communityRoot) ?? 0) / Math.max(1, community.members.length) / 2),
        reason: `Shares a dependency community with the ${communityRoot} hierarchy despite its ${pathParts(namespace)[0] ?? namespace} prefix.`,
      }));
  }).sort((a, b) => b.score - a.score || compareNamespaces(a.namespace, b.namespace));
  return {
    projection,
    communities: result,
    assignment,
    assignmentRecord,
    algorithm: 'weighted-label-propagation',
    driftCandidates,
    limitations: [
      ...projection.limitations,
      'Label propagation is deterministic and weighted; it is not a substitute for Leiden/Louvain modularity optimization.',
      'Hierarchy drift compares top-level namespace prefixes and is a review candidate, not an architectural rule.',
    ],
  };
}

// buildCommunityAnalysis is not a redundant alias: src/components/CommunityView.tsx
// imports it directly. Keep the name even though detectCommunities is the
// canonical export elsewhere.
export const buildCommunityAnalysis = detectCommunities;

function assignmentMap(snapshot: CommunitySnapshot | CommunityAnalysis): Map<string, string> {
  if ('assignment' in snapshot) return new Map(snapshot.assignment);
  return snapshot.assignments instanceof Map ? new Map(snapshot.assignments) : new Map(Object.entries(snapshot.assignments));
}

export function snapshotCommunities(result: CommunityAnalysis, snapshotId?: string): CommunitySnapshot {
  return { snapshotId, assignments: new Map(result.assignment), namespaceIds: [...result.assignment.keys()] };
}

export function compareCommunityDrift(previous?: CommunitySnapshot | CommunityAnalysis, current?: CommunitySnapshot | CommunityAnalysis): CommunityDrift {
  if (!previous || !current) return { available: false, partial: true, coverage: 'unavailable', reason: 'Two supplied snapshots or assignments are required; history is not fabricated.', movedNamespaces: [], matches: [] };
  const oldAssignments = assignmentMap(previous);
  const newAssignments = assignmentMap(current);
  if (oldAssignments.size === 0 || newAssignments.size === 0) return { available: false, partial: true, coverage: 'unavailable', reason: 'A supplied snapshot contains no assignments.', movedNamespaces: [], matches: [] };
  const namespaces = [...new Set([...oldAssignments.keys(), ...newAssignments.keys()])].sort(compareNamespaces);
  const partial = namespaces.some(namespace => !oldAssignments.has(namespace) || !newAssignments.has(namespace));
  const oldGroups = new Map<string, Set<string>>();
  const newGroups = new Map<string, Set<string>>();
  oldAssignments.forEach((id, namespace) => oldGroups.set(id, new Set([...(oldGroups.get(id) ?? []), namespace])));
  newAssignments.forEach((id, namespace) => newGroups.set(id, new Set([...(newGroups.get(id) ?? []), namespace])));
  const matches = [...oldGroups.entries()].map(([previousCommunityId, members]) => {
    const match = [...newGroups.entries()].map(([currentCommunityId, currentMembers]) => {
      const intersection = [...members].filter(member => currentMembers.has(member)).length;
      const union = new Set([...members, ...currentMembers]).size;
      return { currentCommunityId, currentMembers, overlap: union ? intersection / union : 0 };
    }).sort((a, b) => b.overlap - a.overlap || a.currentCommunityId.localeCompare(b.currentCommunityId))[0];
    return { previousCommunityId, currentCommunityId: match?.currentCommunityId ?? '', overlap: match?.overlap ?? 0, previousMembers: [...members].sort(compareNamespaces), currentMembers: [...(match?.currentMembers ?? [])].sort(compareNamespaces) };
  });
  return {
    available: true,
    partial,
    coverage: partial ? 'partial' : 'complete',
    reason: partial ? 'Compared supplied assignments with incomplete namespace coverage.' : 'Compared the two supplied assignments.',
    movedNamespaces: namespaces.filter(namespace => oldAssignments.get(namespace) !== newAssignments.get(namespace)),
    matches,
  };
}

function stronglyConnectedComponents(namespaces: string[], edges: NamespaceProjectionEdge[]): Set<string>[] {
  const outgoing = new Map(namespaces.map(namespace => [namespace, [] as string[]]));
  const reverse = new Map(namespaces.map(namespace => [namespace, [] as string[]]));
  edges.forEach(edge => { outgoing.get(edge.source)?.push(edge.target); reverse.get(edge.target)?.push(edge.source); });
  const visitOrder: string[] = [];
  const visited = new Set<string>();
  const visit = (start: string, graph: Map<string, string[]>) => {
    const stack: Array<[string, boolean]> = [[start, false]];
    while (stack.length) {
      const [node, expanded] = stack.pop() as [string, boolean];
      if (expanded) { visitOrder.push(node); continue; }
      if (visited.has(node)) continue;
      visited.add(node);
      stack.push([node, true]);
      [...(graph.get(node) ?? [])].sort(compareNamespaces).reverse().forEach(next => stack.push([next, false]));
    }
  };
  namespaces.forEach(namespace => { if (!visited.has(namespace)) visit(namespace, outgoing); });
  const assigned = new Set<string>();
  const components: Set<string>[] = [];
  [...visitOrder].reverse().forEach(start => {
    if (assigned.has(start)) return;
    const component = new Set<string>();
    const stack = [start];
    assigned.add(start);
    while (stack.length) {
      const node = stack.pop() as string;
      component.add(node);
      (reverse.get(node) ?? []).forEach(next => { if (!assigned.has(next)) { assigned.add(next); stack.push(next); } });
    }
    components.push(component);
  });
  return components;
}

export function dsmCellId(source: string, target: string): string {
  return `${source}\u0000${target}`;
}

export function buildDsmModel(graph: CodeGraph, options: NamespaceProjectionOptions & { includeSelf?: boolean } = {}): DsmModel {
  const projection = project(graph, options);
  const namespaces = projection.namespaces.map((namespace, index) => ({ namespace, index, depth: pathParts(namespace).length, groupId: `group:${pathParts(namespace)[0] ?? namespace}` }));
  const indexByNamespace = new Map(namespaces.map(item => [item.namespace, item.index]));
  const cycleNamespaces = stronglyConnectedComponents(projection.namespaces, projection.edges).filter(component => component.size > 1).flatMap(component => [...component]).sort(compareNamespaces);
  const cycleSet = new Set(cycleNamespaces);
  const cells = projection.edges.filter(edge => options.includeSelf || edge.source !== edge.target).map(edge => {
    const sourceIndex = indexByNamespace.get(edge.source) ?? 0;
    const targetIndex = indexByNamespace.get(edge.target) ?? 0;
    const direction: DsmCell['direction'] = sourceIndex === targetIndex ? 'diagonal' : sourceIndex < targetIndex ? 'forward' : 'backward';
    return { id: dsmCellId(edge.source, edge.target), source: edge.source, target: edge.target, sourceIndex, targetIndex, counts: edge.counts, kindCounts: edge.counts, total: edge.occurrenceWeight, weight: edge.weight, occurrenceWeight: edge.occurrenceWeight, edgeIds: edge.edgeIds, evidence: edge.evidence, direction, cyclic: cycleSet.has(edge.source) && cycleSet.has(edge.target) };
  }).sort((a, b) => a.sourceIndex - b.sourceIndex || a.targetIndex - b.targetIndex);
  const groups = [...new Set(namespaces.map(item => item.groupId))].map(groupId => {
    const items = namespaces.filter(item => item.groupId === groupId);
    return { id: groupId, label: groupId.slice(6), start: items[0]?.index ?? 0, end: items[items.length - 1]?.index ?? 0, namespaces: items.map(item => item.namespace) };
  });
  const rows = namespaces.map(namespace => ({ source: namespace.namespace, cells: cells.filter(cell => cell.source === namespace.namespace) }));
  const forwardWeight = cells.filter(cell => cell.direction === 'forward').reduce((sum, cell) => sum + cell.weight, 0);
  const backwardWeight = cells.filter(cell => cell.direction === 'backward').reduce((sum, cell) => sum + cell.weight, 0);
  return {
    namespaces, groups, rows, cells, cycleNamespaces, cycleCells: cells.filter(cell => cell.cyclic).map(cell => cell.id),
    forwardWeight, backwardWeight, cycleSignal: cycleNamespaces.length ? 'cyclic' : backwardWeight === 0 ? 'layered' : backwardWeight > forwardWeight ? 'backward-heavy' : 'acyclic',
    coverage: projection.coverage, evidenceCoverage: projection.evidenceCoverage,
    limitations: [...projection.limitations, 'Rows are directed sources and columns are targets in hierarchy-sorted namespace order.', 'The sparse matrix omits empty cells.'],
  };
}

export function relationshipKinds(counts: RelationshipCounts): string {
  return EDGE_KINDS.filter(kind => counts[kind] > 0).map(kind => `${kind[0]}${counts[kind] > 1 ? counts[kind] : ''}`).join(' ');
}
