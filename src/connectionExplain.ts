import type { CodeEdge, CodeNode, EdgeKind } from './types';

export type GraphEdge = CodeEdge & {
  span?: unknown;
  sourceEvidence?: unknown;
  sources?: unknown;
};
export interface GraphLike {
  nodes: readonly CodeNode[];
  edges: readonly GraphEdge[];
}
export type NamespaceSelection = CodeNode | string | null | undefined;
export type RelationshipDirection = 'incoming' | 'outgoing';
export type PathDirection = 'outgoing' | 'incoming' | 'undirected';

export interface SourceEvidence {
  edgeId?: string;
  kind?: EdgeKind;
  file?: string;
  row?: number;
  col?: number;
  endRow?: number;
  endCol?: number;
  label?: string;
  href?: string;
  url?: string;
  location?: string;
  occurrenceCount?: number;
}

export interface NamespaceRelationship {
  namespace: string;
  otherNamespace: string;
  sourceNamespace: string;
  targetNamespace: string;
  direction: RelationshipDirection;
  kind: EdgeKind;
  multiplicity: number;
  occurrenceCount?: number;
  edgeIds: string[];
  evidence: SourceEvidence[];
  evidenceAvailable: boolean;
  external?: boolean;
}

export interface DirectRelationshipOptions {
  direction?: RelationshipDirection | 'both';
  /** Structural edge kinds. Mentions are excluded unless explicitly requested. */
  kinds?: readonly EdgeKind[];
  includeCalls?: boolean;
  includeMentions?: boolean;
}

export interface ConnectionPathStep {
  from: string;
  to: string;
  kind: EdgeKind;
  multiplicity: number;
  edgeIds: string[];
  evidence: SourceEvidence[];
  evidenceAvailable: boolean;
  relationships: NamespaceRelationship[];
}

export interface NamespacePath {
  namespaces: string[];
  steps: ConnectionPathStep[];
  length: number;
}

export interface ConnectionExplainOptions {
  direction?: PathDirection;
  maxDepth?: number;
  maxPaths?: number;
  /** Defaults to requires only. Mentions never become structural implicitly. */
  structuralKinds?: readonly EdgeKind[];
  includeCalls?: boolean;
  includeMentions?: boolean;
  /** Internal adapter flag used to collect the separate mention-only path view. */
  mentionOnly?: boolean;
}

export interface ConnectionExplanation {
  from?: string;
  to?: string;
  source?: string;
  target?: string;
  connected: boolean;
  paths: NamespacePath[];
  shortestPath?: NamespacePath;
  maxDepth: number;
  maxPaths: number;
  bounded: boolean;
  direct: boolean;
  explanation: string;
  structuralKinds: EdgeKind[];
  mentionPaths: NamespacePath[];
}

interface NamespaceIndex {
  nodeNamespaces: Map<string, string | undefined>;
  namespaces: Set<string>;
}

interface RelationshipGroup {
  source: string;
  target: string;
  kind: EdgeKind;
  edgeIds: string[];
  evidence: SourceEvidence[];
  occurrenceCount: number;
}

function structuralKinds(options: { structuralKinds?: readonly EdgeKind[]; includeCalls?: boolean } = {}): EdgeKind[] {
  const requested = options.structuralKinds
    ? [...options.structuralKinds].filter(kind => kind !== 'mentions')
    : ['requires' as EdgeKind];
  if (options.includeCalls && !requested.includes('calls')) requested.push('calls');
  return [...new Set(requested)].sort(compareKind);
}

const edgeKindOrder: EdgeKind[] = ['requires', 'calls', 'mentions'];
const directionOrder: RelationshipDirection[] = ['outgoing', 'incoming'];

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function namespaceForNode(node: CodeNode): string | undefined {
  if (node.kind === 'namespace') return node.namespace ?? node.label ?? node.fqn ?? node.id.replace(/^namespace:/, '');
  if (node.namespace) return node.namespace;
  if (node.kind === 'var' && node.fqn?.includes('/')) return node.fqn.slice(0, node.fqn.indexOf('/'));
  return undefined;
}

function evidenceKey(evidence: SourceEvidence): string {
  return [
    evidence.file ?? '',
    evidence.row ?? '',
    evidence.col ?? '',
    evidence.endRow ?? '',
    evidence.endCol ?? '',
    evidence.href ?? evidence.url ?? '',
    evidence.location ?? '',
  ].join('\u0000');
}

function normalizeEvidence(value: unknown): SourceEvidence | undefined {
  const input = record(value);
  const start = record(input.start);
  const end = record(input.end);
  const file = nonEmptyString(input.file) ?? nonEmptyString(input.filename) ?? nonEmptyString(input.path);
  const row = finiteNumber(input.row) ?? finiteNumber(input.line) ?? finiteNumber(start.row) ?? finiteNumber(start.line);
  const col = finiteNumber(input.col) ?? finiteNumber(input.column) ?? finiteNumber(start.col) ?? finiteNumber(start.column);
  const endRow = finiteNumber(input.endRow) ?? finiteNumber(input.endLine) ?? finiteNumber(end.row) ?? finiteNumber(end.line);
  const endCol = finiteNumber(input.endCol) ?? finiteNumber(input.endColumn) ?? finiteNumber(end.col) ?? finiteNumber(end.column);
  const label = nonEmptyString(input.label) ?? nonEmptyString(input.title);
  const href = nonEmptyString(input.href);
  const url = nonEmptyString(input.url);
  const location = nonEmptyString(input.location);
  if (!file && row === undefined && col === undefined && endRow === undefined && endCol === undefined && !label && !href && !url && !location) {
    return undefined;
  }
  return { ...(file ? { file } : {}), ...(row === undefined ? {} : { row }), ...(col === undefined ? {} : { col }), ...(endRow === undefined ? {} : { endRow }), ...(endCol === undefined ? {} : { endCol }), ...(label ? { label } : {}), ...(href ? { href } : {}), ...(url ? { url } : {}), ...(location ? { location } : {}) };
}

function edgeEvidence(edge: GraphEdge): SourceEvidence[] {
  const input = record(edge as unknown);
  const values: SourceEvidence[] = [];
  const rawEvidence = input.evidence ?? input.sourceEvidence ?? input.sources;
  if (Array.isArray(rawEvidence)) rawEvidence.forEach(value => { const item = normalizeEvidence(value); if (item) values.push(item); });
  else if (rawEvidence !== undefined) {
    const item = normalizeEvidence(rawEvidence);
    if (item) values.push(item);
  }
  const rawSpan = input.span;
  if (Array.isArray(rawSpan)) rawSpan.forEach(value => { const item = normalizeEvidence(value); if (item) values.push(item); });
  else if (rawSpan !== undefined) {
    const item = normalizeEvidence(rawSpan);
    if (item) values.push(item);
  }
  const location = normalizeEvidence(input.source ?? input.location);
  if (location) values.push(location);
  const direct = normalizeEvidence(edge);
  if (direct) values.push(direct);
  const occurrenceCount = typeof input.occurrenceCount === 'number' && Number.isFinite(input.occurrenceCount)
    ? Math.max(1, Math.floor(input.occurrenceCount))
    : 1;
  return [...new Map(values.map(item => [evidenceKey(item), {
    ...item,
    edgeId: edge.id,
    kind: edge.kind,
    occurrenceCount,
  }])).values()]
    .sort(compareEvidence);
}

function compareEvidence(a: SourceEvidence, b: SourceEvidence): number {
  return (a.file ?? a.location ?? '').localeCompare(b.file ?? b.location ?? '')
    || (a.row ?? Number.MAX_SAFE_INTEGER) - (b.row ?? Number.MAX_SAFE_INTEGER)
    || (a.col ?? Number.MAX_SAFE_INTEGER) - (b.col ?? Number.MAX_SAFE_INTEGER)
    || (a.href ?? a.url ?? '').localeCompare(b.href ?? b.url ?? '');
}

function compareKind(a: EdgeKind, b: EdgeKind): number {
  return edgeKindOrder.indexOf(a) - edgeKindOrder.indexOf(b) || a.localeCompare(b);
}

function namespaceIndex(graph: GraphLike): NamespaceIndex {
  const nodeNamespaces = new Map(graph.nodes.map(node => [node.id, namespaceForNode(node)]));
  const namespaces = new Set<string>();
  graph.nodes.forEach(node => {
    const namespace = namespaceForNode(node);
    if (namespace) namespaces.add(namespace);
  });
  return { nodeNamespaces, namespaces };
}

function namespaceForEndpoint(endpoint: string, index: NamespaceIndex): string | undefined {
  return index.nodeNamespaces.get(endpoint) ?? (index.namespaces.has(endpoint) ? endpoint : undefined);
}

function selectedNode(graph: GraphLike, selection: NamespaceSelection): CodeNode | undefined {
  if (!selection || typeof selection !== 'string') return selection && typeof selection === 'object' ? selection : undefined;
  return graph.nodes.find(node => node.id === selection)
    ?? graph.nodes.find(node => node.fqn === selection)
    ?? graph.nodes.find(node => node.label === selection)
    ?? graph.nodes.find(node => node.namespace === selection);
}

/** Resolve a namespace node, var, or metadata-bearing keyword to its namespace. */
export function resolveNamespace(graph: GraphLike, selection: NamespaceSelection): string | undefined {
  const index = namespaceIndex(graph);
  if (typeof selection === 'string' && index.namespaces.has(selection)) return selection;
  const node = selectedNode(graph, selection);
  if (!node || node.kind === 'keyword') return node?.namespace;
  return namespaceForNode(node);
}

function relationshipGroups(graph: GraphLike, kinds: readonly EdgeKind[] = edgeKindOrder): RelationshipGroup[] {
  const index = namespaceIndex(graph);
  const groups = new Map<string, RelationshipGroup>();
  graph.edges.forEach(edge => {
    if (!kinds.includes(edge.kind)) return;
    const source = namespaceForEndpoint(edge.source, index);
    const target = namespaceForEndpoint(edge.target, index);
    if (!source || !target || source === target) return;
    const key = `${source}\u0000${target}\u0000${edge.kind}`;
    const occurrenceCount = typeof (edge as CodeEdge & { occurrenceCount?: unknown }).occurrenceCount === 'number'
      && Number.isFinite((edge as CodeEdge & { occurrenceCount?: number }).occurrenceCount)
      ? Math.max(1, Math.floor((edge as CodeEdge & { occurrenceCount?: number }).occurrenceCount as number))
      : 1;
    const group = groups.get(key) ?? { source, target, kind: edge.kind, edgeIds: [], evidence: [], occurrenceCount: 0 };
    group.edgeIds.push(edge.id);
    group.evidence.push(...edgeEvidence(edge));
    group.occurrenceCount += occurrenceCount;
    groups.set(key, group);
  });
  return [...groups.values()].map(group => ({
    ...group,
    edgeIds: [...new Set(group.edgeIds)].sort(),
    evidence: [...new Map(group.evidence.map(item => [evidenceKey(item), item])).values()].sort(compareEvidence),
  })).sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || compareKind(a.kind, b.kind));
}

function relationshipFromGroup(group: RelationshipGroup, direction: RelationshipDirection, namespace: string): NamespaceRelationship {
  return {
    namespace,
    otherNamespace: direction === 'outgoing' ? group.target : group.source,
    sourceNamespace: group.source,
    targetNamespace: group.target,
    direction,
    kind: group.kind,
    multiplicity: group.edgeIds.length,
    occurrenceCount: group.occurrenceCount,
    edgeIds: group.edgeIds,
    evidence: group.evidence,
    evidenceAvailable: group.evidence.length > 0,
  };
}

/** List collapsed namespace-level relationships for a selected namespace, preserving edge evidence. */
export function listDirectRelationships(graph: GraphLike, selection: NamespaceSelection, options: DirectRelationshipOptions = {}): NamespaceRelationship[] {
  const namespace = resolveNamespace(graph, selection);
  if (!namespace) return [];
  const direction = options.direction ?? 'both';
  const kinds = options.kinds
    ? [...options.kinds]
    : structuralKinds(options);
  if (options.includeMentions) kinds.push('mentions');
  return relationshipGroups(graph, [...new Set(kinds)])
    .flatMap(group => {
      const result: NamespaceRelationship[] = [];
      if ((direction === 'both' || direction === 'outgoing') && group.source === namespace) result.push(relationshipFromGroup(group, 'outgoing', namespace));
      if ((direction === 'both' || direction === 'incoming') && group.target === namespace) result.push(relationshipFromGroup(group, 'incoming', namespace));
      return result;
    })
    .sort((a, b) => directionOrder.indexOf(a.direction) - directionOrder.indexOf(b.direction)
      || a.otherNamespace.localeCompare(b.otherNamespace)
      || compareKind(a.kind, b.kind));
}

export function directOutgoingRelationships(graph: GraphLike, selection: NamespaceSelection): NamespaceRelationship[] {
  return listDirectRelationships(graph, selection, { direction: 'outgoing' });
}

export function directIncomingRelationships(graph: GraphLike, selection: NamespaceSelection): NamespaceRelationship[] {
  return listDirectRelationships(graph, selection, { direction: 'incoming' });
}

function pathStep(relations: NamespaceRelationship[], from: string, to: string): ConnectionPathStep {
  const sorted = [...relations].sort((a, b) => compareKind(a.kind, b.kind));
  const first = sorted[0];
  return {
    from,
    to,
    kind: first.kind,
    multiplicity: first.multiplicity,
    edgeIds: first.edgeIds,
    evidence: first.evidence,
    evidenceAvailable: first.evidenceAvailable,
    relationships: sorted,
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value as number))) : fallback;
}

/** Explain deterministic shortest namespace paths, or several bounded shortest paths when requested. */
export function explainNamespaceConnection(graph: GraphLike, fromSelection: NamespaceSelection, toSelection: NamespaceSelection, options: ConnectionExplainOptions = {}): ConnectionExplanation {
  const from = resolveNamespace(graph, fromSelection);
  const to = resolveNamespace(graph, toSelection);
  const structural = options.mentionOnly ? ['mentions' as EdgeKind] : structuralKinds(options);
  const maxDepth = boundedInteger(options.maxDepth, 8, 0, 100);
  const maxPaths = boundedInteger(options.maxPaths, 1, 1, 50);
  const direction = options.direction ?? 'outgoing';
  if (!from || !to) return {
    from, to, source: from, target: to, connected: false, direct: false, paths: [], mentionPaths: [],
    structuralKinds: structural, maxDepth, maxPaths, bounded: false,
    explanation: 'Connection cannot be explained because one endpoint could not be resolved.',
  };
  if (from === to) {
    const path: NamespacePath = { namespaces: [from], steps: [], length: 0 };
    return {
      from, to, source: from, target: to, connected: true, direct: false, paths: [path], mentionPaths: [],
      shortestPath: path, structuralKinds: structural, maxDepth, maxPaths, bounded: false,
      explanation: 'Both endpoints resolve to the same namespace; self-links are shown separately.',
    };
  }

  const groups = relationshipGroups(graph, structural);
  const adjacency = new Map<string, Array<{ target: string; relations: NamespaceRelationship[] }>>();
  const add = (source: string, target: string, relation: NamespaceRelationship) => {
    const entries = adjacency.get(source) ?? [];
    const entry = entries.find(item => item.target === target);
    if (entry) entry.relations.push(relation);
    else entries.push({ target, relations: [relation] });
    adjacency.set(source, entries);
  };
  groups.forEach(group => {
    const outgoing = relationshipFromGroup(group, 'outgoing', group.source);
    const incoming = relationshipFromGroup(group, 'incoming', group.target);
    if (direction === 'outgoing' || direction === 'undirected') add(group.source, group.target, outgoing);
    if (direction === 'incoming' || direction === 'undirected') add(group.target, group.source, incoming);
  });
  adjacency.forEach(entries => entries.sort((a, b) => a.target.localeCompare(b.target)
    || compareKind(a.relations[0].kind, b.relations[0].kind)));

  const queue: string[][] = [[from]];
  let shortestDepth: number | undefined;
  let hitDepthLimit = false;
  const paths: NamespacePath[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string[];
    const depth = current.length - 1;
    if (shortestDepth !== undefined && depth >= shortestDepth) continue;
    const last = current[current.length - 1];
    if (depth >= maxDepth) {
      if (adjacency.get(last)?.some(entry => !current.includes(entry.target))) hitDepthLimit = true;
      continue;
    }
    adjacency.get(last)?.forEach(entry => {
      if (current.includes(entry.target)) return;
      const next = [...current, entry.target];
      if (entry.target === to) {
        shortestDepth = shortestDepth ?? depth + 1;
        if (depth + 1 === shortestDepth && paths.length < maxPaths) {
          const steps = next.slice(0, -1).map((source, index) => {
            const target = next[index + 1];
            const relationEntry = adjacency.get(source)?.find(item => item.target === target);
            return pathStep(relationEntry?.relations ?? [], source, target);
          });
          paths.push({ namespaces: next, steps, length: steps.length });
        }
      } else if (shortestDepth === undefined || depth + 1 < shortestDepth) {
        queue.push(next);
      }
    });
  }
  const shortestPath = paths[0];
  const mentionPaths = options.includeMentions === false
    ? []
    : explainNamespaceConnection(graph, fromSelection, toSelection, {
      ...options,
      structuralKinds: ['mentions'],
      includeMentions: false,
      mentionOnly: true,
    }).paths;
  const direct = paths.some(path => path.length === 1);
  const explanation = paths.length > 0
    ? direct
      ? `Direct ${structural.join(' + ')} connection found.`
      : `Connected by ${paths[0].length} ${structural.join(' + ')} hop${paths[0].length === 1 ? '' : 's'}.`
    : `No connection found using ${structural.join(' + ')}.${mentionPaths.length > 0 ? ' Mentions are present separately and are not structural.' : ''}`;
  return {
    from,
    to,
    source: from,
    target: to,
    connected: paths.length > 0,
    direct,
    paths,
    mentionPaths,
    ...(shortestPath ? { shortestPath } : {}),
    structuralKinds: structural,
    maxDepth,
    maxPaths,
    bounded: shortestPath === undefined && hitDepthLimit,
    explanation,
  };
}

export function findNamespacePaths(graph: GraphLike, fromSelection: NamespaceSelection, toSelection: NamespaceSelection, options: ConnectionExplainOptions = {}): NamespacePath[] {
  return explainNamespaceConnection(graph, fromSelection, toSelection, { ...options, maxPaths: options.maxPaths ?? 5 }).paths;
}

export function sourceEvidenceForEdge(edge: GraphEdge): SourceEvidence[] {
  return edgeEvidence(edge);
}

export interface DossierRelationship extends Omit<NamespaceRelationship, 'direction'> {
  direction: RelationshipDirection | 'self';
  self: boolean;
  external: boolean;
}

export interface NamespaceDossierData {
  namespace: string;
  selectedNode?: CodeNode;
  incoming: DossierRelationship[];
  outgoing: DossierRelationship[];
  selfLinks: DossierRelationship[];
  mentions: {
    incoming: DossierRelationship[];
    outgoing: DossierRelationship[];
    selfLinks: DossierRelationship[];
  };
  counts: {
    members: number;
    vars: number;
    keywords: number;
    incoming: number;
    outgoing: number;
    selfLinks: number;
    externalIncoming: number;
    externalOutgoing: number;
    structuralEdges: number;
    structuralOccurrences: number;
    mentionEdges: number;
    mentionOccurrences: number;
  };
}

export interface NamespaceDossierOptions {
  structuralKinds?: readonly EdgeKind[];
  includeCalls?: boolean;
  includeMentions?: boolean;
}

function dossierRelationships(graph: GraphLike, namespace: string, kinds: readonly EdgeKind[]): {
  incoming: DossierRelationship[];
  outgoing: DossierRelationship[];
  selfLinks: DossierRelationship[];
} {
  const index = namespaceIndex(graph);
  const external = new Map<string, boolean>();
  graph.nodes.forEach(node => {
    const name = namespaceForNode(node);
    if (name && node.external === true) external.set(name, true);
  });
  const groups = new Map<string, {
    source: string;
    target: string;
    kind: EdgeKind;
    edgeIds: string[];
    evidence: SourceEvidence[];
    occurrenceCount: number;
  }>();
  graph.edges.forEach(edge => {
    if (!kinds.includes(edge.kind)) return;
    const source = namespaceForEndpoint(edge.source, index);
    const target = namespaceForEndpoint(edge.target, index);
    if (!source || !target) return;
    const key = `${source}\u0000${target}\u0000${edge.kind}`;
    const occurrenceCount = typeof (edge as CodeEdge & { occurrenceCount?: unknown }).occurrenceCount === 'number'
      && Number.isFinite((edge as CodeEdge & { occurrenceCount?: number }).occurrenceCount)
      ? Math.max(1, Math.floor((edge as CodeEdge & { occurrenceCount?: number }).occurrenceCount as number))
      : 1;
    const group = groups.get(key) ?? { source, target, kind: edge.kind, edgeIds: [], evidence: [], occurrenceCount: 0 };
    group.edgeIds.push(edge.id);
    group.evidence.push(...edgeEvidence(edge));
    group.occurrenceCount += occurrenceCount;
    groups.set(key, group);
  });
  const result: DossierRelationship[] = [];
  groups.forEach(group => {
    const self = group.source === group.target;
    const direction: RelationshipDirection | 'self' | undefined = self ? 'self' : group.source === namespace ? 'outgoing' : group.target === namespace ? 'incoming' : undefined;
    if (!direction) return;
    const otherNamespace = self ? namespace : direction === 'outgoing' ? group.target : group.source;
    result.push({
      namespace,
      otherNamespace,
      sourceNamespace: group.source,
      targetNamespace: group.target,
      direction,
      kind: group.kind,
      multiplicity: group.edgeIds.length,
      occurrenceCount: group.occurrenceCount,
      edgeIds: [...new Set(group.edgeIds)].sort(),
      evidence: [...new Map(group.evidence.map(item => [evidenceKey(item), item])).values()].sort(compareEvidence),
      evidenceAvailable: group.evidence.length > 0,
      self,
      external: external.get(otherNamespace) === true,
    });
  });
  result.sort((a, b) => (a.otherNamespace.localeCompare(b.otherNamespace)
    || compareKind(a.kind, b.kind)
    || a.direction.localeCompare(b.direction)));
  return {
    incoming: result.filter(item => item.direction === 'incoming'),
    outgoing: result.filter(item => item.direction === 'outgoing'),
    selfLinks: result.filter(item => item.self),
  };
}

/** Build an evidence-first dossier. Structural relationships default to requires only. */
export function buildNamespaceDossier(
  graph: GraphLike,
  selection: NamespaceSelection,
  options: NamespaceDossierOptions = {},
): NamespaceDossierData | undefined {
  const namespace = resolveNamespace(graph, selection);
  if (!namespace) return undefined;
  const selectedNode = typeof selection === 'object' && selection !== null
    ? selection
    : graph.nodes.find(node => node.id === selection || node.namespace === namespace || (node.kind === 'namespace' && node.label === namespace));
  const structural = structuralKinds(options);
  const structuralRelationships = dossierRelationships(graph, namespace, structural);
  const mentions = options.includeMentions === false ? { incoming: [], outgoing: [], selfLinks: [] } : dossierRelationships(graph, namespace, ['mentions']);
  const members = graph.nodes.filter(node => namespaceForNode(node) === namespace);
  const allStructural = [...structuralRelationships.incoming, ...structuralRelationships.outgoing, ...structuralRelationships.selfLinks];
  const allMentions = [...mentions.incoming, ...mentions.outgoing, ...mentions.selfLinks];
  return {
    namespace,
    ...(selectedNode ? { selectedNode } : {}),
    ...structuralRelationships,
    mentions,
    counts: {
      members: members.length,
      vars: members.filter(node => node.kind === 'var').length,
      keywords: members.filter(node => node.kind === 'keyword').length,
      incoming: structuralRelationships.incoming.length,
      outgoing: structuralRelationships.outgoing.length,
      selfLinks: structuralRelationships.selfLinks.length,
      externalIncoming: structuralRelationships.incoming.filter(item => externalNamespace(graph, item.otherNamespace)).length,
      externalOutgoing: structuralRelationships.outgoing.filter(item => externalNamespace(graph, item.otherNamespace)).length,
      structuralEdges: new Set(allStructural.flatMap(item => item.edgeIds)).size,
      structuralOccurrences: allStructural.reduce((sum, item) => sum + (item.occurrenceCount ?? item.multiplicity), 0),
      mentionEdges: new Set(allMentions.flatMap(item => item.edgeIds)).size,
      mentionOccurrences: allMentions.reduce((sum, item) => sum + (item.occurrenceCount ?? item.multiplicity), 0),
    },
  };
}

function externalNamespace(graph: GraphLike, namespace: string): boolean {
  return graph.nodes.some(node => namespaceForNode(node) === namespace && node.external === true);
}
