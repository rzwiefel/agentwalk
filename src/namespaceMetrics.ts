import type { CodeEdge, CodeGraph, CodeNode, ConnectionMode } from './types';
import { edgeEvidence, edgeOccurrenceCount } from './analysis/facts';

export interface MetricEvidence {
  file?: string;
  row?: number;
  col?: number;
}

export interface MetricContributions {
  weightedDegree: number;
  reversePageRank: number;
  betweenness: number;
  instability: number;
  fanOut: number;
  cycle: number;
  fanIn: number;
}

export interface NamespaceMetrics {
  namespace: string;
  fanIn: number;
  fanOut: number;
  degree: number;
  weightedDegree: number;
  betweenness: number;
  cycleSize: number;
  connectedness: number;
  overdependency: number;
  fanInPercentile: number;
  fanOutPercentile: number;
  degreePercentile: number;
  weightedDegreePercentile: number;
  betweennessPercentile: number;
  cyclePercentile: number;
  betweennessRaw: number;
  reversePageRank: number;
  reversePageRankRaw: number;
  cycleSeverity: number;
  selfLinks: number;
  cohesion: number;
  cohesionComponents: number;
  externalFanIn: number;
  externalFanOut: number;
  external: boolean;
  mentionCount: number;
  contributions: MetricContributions;
}

export interface NamespaceMetricOptions {
  includeExternal?: boolean;
  structuralEdgeKinds?: Array<CodeEdge['kind']>;
}

export interface NamespaceMetricSets {
  internal: Map<string, NamespaceMetrics>;
  external: Map<string, NamespaceMetrics>;
  combined: Map<string, NamespaceMetrics>;
}

type MetricEdge = CodeEdge & {
  occurrenceCount?: number;
  evidence?: MetricEvidence[];
};

interface NormalizedEdge {
  kind: CodeEdge['kind'];
  source: string;
  target: string;
  count: number;
  evidence: MetricEvidence[];
}

interface NamespaceInfo {
  name: string;
  external: boolean;
}

const maxBetweennessSources = 200;
const metricSetsCache = new WeakMap<object, Map<string, NamespaceMetricSets>>();
const emptyMetric = (namespace: string, external: boolean): NamespaceMetrics => ({
  namespace,
  fanIn: 0,
  fanOut: 0,
  degree: 0,
  weightedDegree: 0,
  betweenness: 0,
  cycleSize: 1,
  connectedness: 0,
  overdependency: 0,
  fanInPercentile: 0,
  fanOutPercentile: 0,
  degreePercentile: 0,
  weightedDegreePercentile: 0,
  betweennessPercentile: 0,
  cyclePercentile: 0,
  betweennessRaw: 0,
  reversePageRank: 0,
  reversePageRankRaw: 0,
  cycleSeverity: 0,
  selfLinks: 0,
  cohesion: 0,
  cohesionComponents: 0,
  externalFanIn: 0,
  externalFanOut: 0,
  external,
  mentionCount: 0,
  contributions: {
    weightedDegree: 0,
    reversePageRank: 0,
    betweenness: 0,
    instability: 0,
    fanOut: 0,
    cycle: 0,
    fanIn: 0,
  },
});

function asMetricEdge(edge: CodeEdge): MetricEdge {
  return edge as MetricEdge;
}

function evidenceFor(edge: MetricEdge): MetricEvidence[] {
  return edgeEvidence(edge).map(item => ({
    ...(item.file === undefined ? {} : { file: item.file }),
    ...(item.start === undefined ? {} : { row: item.start.line, col: item.start.column }),
  }));
}

function evidenceOrder(left: MetricEvidence, right: MetricEvidence): number {
  return (left.file ?? '').localeCompare(right.file ?? '')
    || (left.row ?? -1) - (right.row ?? -1)
    || (left.col ?? -1) - (right.col ?? -1);
}

function normalizedEdges(graph: CodeGraph): NormalizedEdge[] {
  const grouped = new Map<string, NormalizedEdge>();
  [...graph.edges]
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach(raw => {
      const edge = asMetricEdge(raw);
      const key = `${edge.kind}\u0000${edge.source}\u0000${edge.target}`;
      const evidence = evidenceFor(edge);
      const existing = grouped.get(key);
      if (existing) {
        existing.count += edgeOccurrenceCount(edge);
        existing.evidence.push(...evidence);
      } else {
        grouped.set(key, {
          kind: edge.kind,
          source: edge.source,
          target: edge.target,
          count: edgeOccurrenceCount(edge),
          evidence,
        });
      }
    });
  return [...grouped.values()].map(edge => ({
    ...edge,
    evidence: [...edge.evidence].sort(evidenceOrder),
  }));
}

function namespaceForNode(node: CodeNode): string | undefined {
  if (node.kind === 'namespace') return node.namespace ?? node.label;
  if (node.kind === 'var') return node.namespace;
  return undefined;
}

function namespaceInfos(graph: CodeGraph): Map<string, NamespaceInfo> {
  const infos = new Map<string, NamespaceInfo>();
  graph.nodes.forEach(node => {
    const namespace = namespaceForNode(node);
    if (!namespace) return;
    const external = node.external === true;
    const existing = infos.get(namespace);
    infos.set(namespace, {
      name: namespace,
      external: existing ? existing.external && external : external,
    });
  });
  return infos;
}

function percentile(value: number, values: number[]): number {
  const nonZero = values.filter(candidate => candidate > 0);
  if (value <= 0 || nonZero.length === 0) return 0;
  const below = nonZero.filter(candidate => candidate < value).length;
  const equal = nonZero.filter(candidate => candidate === value).length;
  return (below + equal) / nonZero.length;
}

function maxValue(values: Iterable<number>): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, value);
  return maximum;
}

function metricValue(values: Map<string, number>, key: string): number {
  return values.get(key) ?? 0;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sortedNeighbors(adjacency: Map<string, Set<string>>, node: string): string[] {
  return [...(adjacency.get(node) ?? [])].sort();
}

function stronglyConnectedComponents(nodes: string[], outgoing: Map<string, Set<string>>): Map<string, number> {
  const reverse = new Map(nodes.map(node => [node, new Set<string>()]));
  nodes.forEach(source => sortedNeighbors(outgoing, source).forEach(target => reverse.get(target)?.add(source)));
  const visited = new Set<string>();
  const order: string[] = [];
  nodes.slice().sort().forEach(start => {
    if (visited.has(start)) return;
    const stack: Array<[string, boolean]> = [[start, false]];
    while (stack.length > 0) {
      const [node, entered] = stack.pop() as [string, boolean];
      if (entered) {
        order.push(node);
        continue;
      }
      if (visited.has(node)) continue;
      visited.add(node);
      stack.push([node, true]);
      sortedNeighbors(outgoing, node).reverse().forEach(target => {
        if (!visited.has(target)) stack.push([target, false]);
      });
    }
  });

  const sizes = new Map<string, number>();
  const assigned = new Set<string>();
  order.slice().reverse().forEach(start => {
    if (assigned.has(start)) return;
    const component: string[] = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length > 0) {
      const node = stack.pop() as string;
      component.push(node);
      [...(reverse.get(node) ?? [])].sort().reverse().forEach(source => {
        if (!assigned.has(source)) {
          assigned.add(source);
          stack.push(source);
        }
      });
    }
    component.forEach(node => sizes.set(node, component.length));
  });
  return sizes;
}

function betweennessCentrality(nodes: string[], outgoing: Map<string, Set<string>>): Map<string, number> {
  const scores = new Map(nodes.map(node => [node, 0]));
  const sources = nodes.slice().sort((left, right) => stableHash(left) - stableHash(right) || left.localeCompare(right))
    .slice(0, maxBetweennessSources);
  sources.forEach(source => {
    const stack: string[] = [];
    const predecessors = new Map(nodes.map(node => [node, [] as string[]]));
    const paths = new Map(nodes.map(node => [node, 0]));
    const distance = new Map(nodes.map(node => [node, -1]));
    paths.set(source, 1);
    distance.set(source, 0);
    const queue = [source];
    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const node = queue[queueIndex++];
      stack.push(node);
      sortedNeighbors(outgoing, node).forEach(target => {
        if (distance.get(target) === -1) {
          distance.set(target, (distance.get(node) ?? 0) + 1);
          queue.push(target);
        }
        if (distance.get(target) === (distance.get(node) ?? 0) + 1) {
          paths.set(target, (paths.get(target) ?? 0) + (paths.get(node) ?? 0));
          predecessors.get(target)?.push(node);
        }
      });
    }
    const dependency = new Map(nodes.map(node => [node, 0]));
    while (stack.length > 0) {
      const node = stack.pop() as string;
      predecessors.get(node)?.forEach(predecessor => {
        const pathCount = paths.get(node) ?? 1;
        const contribution = ((paths.get(predecessor) ?? 0) / pathCount)
          * (1 + (dependency.get(node) ?? 0));
        dependency.set(predecessor, (dependency.get(predecessor) ?? 0) + contribution);
      });
      if (node !== source) scores.set(node, (scores.get(node) ?? 0) + (dependency.get(node) ?? 0));
    }
  });
  const scale = sources.length > 0 ? nodes.length / sources.length : 0;
  return new Map(nodes.map(node => [node, (scores.get(node) ?? 0) * scale]));
}

function reversePageRank(nodes: string[], outgoing: Map<string, Set<string>>): Map<string, number> {
  if (nodes.length === 0) return new Map();
  const damping = 0.85;
  const size = nodes.length;
  let ranks = new Map(nodes.map(node => [node, 1 / size]));
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const next = new Map(nodes.map(node => [node, (1 - damping) / size]));
    let dangling = 0;
    nodes.forEach(source => {
      const targets = outgoing.get(source);
      if (!targets || targets.size === 0) {
        dangling += ranks.get(source) ?? 0;
        return;
      }
      const share = (ranks.get(source) ?? 0) / targets.size;
      targets.forEach(target => next.set(target, (next.get(target) ?? 0) + damping * share));
    });
    const danglingShare = damping * dangling / size;
    nodes.forEach(node => next.set(node, (next.get(node) ?? 0) + danglingShare));
    ranks = next;
  }
  return ranks;
}

function cohesionByNamespace(
  graph: CodeGraph,
  namespaces: Set<string>,
  allEdges: NormalizedEdge[],
): Map<string, { components: number; cohesion: number }> {
  const vars = new Map<string, string[]>();
  const namespaceByVar = new Map<string, string>();
  graph.nodes.forEach(node => {
    if (node.kind === 'var' && node.namespace && namespaces.has(node.namespace)) {
      vars.set(node.namespace, [...(vars.get(node.namespace) ?? []), node.id]);
      namespaceByVar.set(node.id, node.namespace);
    }
  });
  const adjacencyByNamespace = new Map<string, Map<string, Set<string>>>();
  namespaces.forEach(namespace => {
    const members = (vars.get(namespace) ?? []).sort();
    adjacencyByNamespace.set(namespace, new Map(members.map(member => [member, new Set<string>()])));
  });
  allEdges.filter(edge => edge.kind === 'calls').forEach(edge => {
    const sourceNamespace = namespaceByVar.get(edge.source);
    const targetNamespace = namespaceByVar.get(edge.target);
    if (!sourceNamespace || sourceNamespace !== targetNamespace) return;
    const adjacency = adjacencyByNamespace.get(sourceNamespace);
    if (!adjacency) return;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  });
  const result = new Map<string, { components: number; cohesion: number }>();
  namespaces.forEach(namespace => {
    const members = (vars.get(namespace) ?? []).sort();
    if (members.length === 0) {
      result.set(namespace, { components: 0, cohesion: 0 });
      return;
    }
    const adjacency = adjacencyByNamespace.get(namespace) as Map<string, Set<string>>;
    const visited = new Set<string>();
    let components = 0;
    members.forEach(start => {
      if (visited.has(start)) return;
      components += 1;
      const stack = [start];
      visited.add(start);
      while (stack.length > 0) {
        const node = stack.pop() as string;
        [...(adjacency.get(node) ?? [])].sort().forEach(neighbor => {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            stack.push(neighbor);
          }
        });
      }
    });
    result.set(namespace, {
      components,
      cohesion: members.length > 1 ? 1 - ((components - 1) / (members.length - 1)) : 1,
    });
  });
  return result;
}

function computeMetrics(
  graph: CodeGraph,
  infos: Map<string, NamespaceInfo>,
  selected: Set<string>,
  allEdges: NormalizedEdge[],
  structuralEdgeKinds: Set<CodeEdge['kind']>,
): Map<string, NamespaceMetrics> {
  const namespaces = [...selected].sort();
  const metrics = new Map(namespaces.map(namespace => [namespace, emptyMetric(namespace, infos.get(namespace)?.external === true)]));
  const namespaceByNode = new Map(
    graph.nodes
      .map(node => [node.id, namespaceForNode(node)] as const)
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const requires = allEdges.filter(edge => structuralEdgeKinds.has(edge.kind));
  const outgoing = new Map(namespaces.map(namespace => [namespace, new Set<string>()]));
  const incoming = new Map(namespaces.map(namespace => [namespace, new Set<string>()]));
  const weighted = new Map(namespaces.map(namespace => [namespace, 0]));
  const selfLinks = new Map(namespaces.map(namespace => [namespace, 0]));

  requires.forEach(edge => {
    const source = namespaceByNode.get(edge.source);
    const target = namespaceByNode.get(edge.target);
    if (!source || !target || !selected.has(source) || !selected.has(target)) return;
    outgoing.get(source)?.add(target);
    incoming.get(target)?.add(source);
    const weight = Math.log1p(edge.count);
    weighted.set(source, (weighted.get(source) ?? 0) + weight);
    if (target !== source) weighted.set(target, (weighted.get(target) ?? 0) + weight);
    if (source === target) selfLinks.set(source, (selfLinks.get(source) ?? 0) + edge.count);
  });

  const sccSizes = stronglyConnectedComponents(namespaces, outgoing);
  const betweennessRaw = betweennessCentrality(namespaces, outgoing);
  const reversePageRankRaw = reversePageRank(namespaces, outgoing);
  const maxCycle = maxValue(sccSizes.values());
  const cohesion = cohesionByNamespace(graph, selected, allEdges);
  const rawFanIn = new Map(namespaces.map(namespace => [namespace, incoming.get(namespace)?.size ?? 0]));
  const rawFanOut = new Map(namespaces.map(namespace => [namespace, outgoing.get(namespace)?.size ?? 0]));
  const rawDegree = new Map(namespaces.map(namespace => [
    namespace,
    new Set([...(incoming.get(namespace) ?? []), ...(outgoing.get(namespace) ?? [])]).size,
  ]));
  const rawWeighted = weighted;
  const rawReversePageRank = reversePageRankRaw;
  const mentionCounts = new Map(namespaces.map(namespace => [namespace, 0]));
  allEdges.filter(edge => edge.kind === 'mentions').forEach(edge => {
    const source = namespaceByNode.get(edge.source);
    if (source && selected.has(source)) mentionCounts.set(source, (mentionCounts.get(source) ?? 0) + edge.count);
  });
  const values = (map: Map<string, number>) => namespaces.map(namespace => map.get(namespace) ?? 0);

  namespaces.forEach(namespace => {
    const fanIn = rawFanIn.get(namespace) ?? 0;
    const fanOut = rawFanOut.get(namespace) ?? 0;
    const degree = rawDegree.get(namespace) ?? 0;
    const weightedDegree = rawWeighted.get(namespace) ?? 0;
    const rawBetweenness = betweennessRaw.get(namespace) ?? 0;
    const cycleSize = sccSizes.get(namespace) ?? 1;
    const cycleSeverity = cycleSize > 1
      ? Math.min(1, Math.log2(cycleSize) / Math.max(1, Math.log2(maxCycle)))
      : 0;
    const metric = metrics.get(namespace) as NamespaceMetrics;
    metric.fanIn = fanIn;
    metric.fanOut = fanOut;
    metric.degree = degree;
    metric.weightedDegree = weightedDegree;
    metric.betweennessRaw = rawBetweenness;
    metric.betweenness = percentile(rawBetweenness, values(betweennessRaw));
    metric.reversePageRankRaw = rawReversePageRank.get(namespace) ?? 0;
    metric.reversePageRank = percentile(metric.reversePageRankRaw, values(rawReversePageRank));
    metric.cycleSize = cycleSize;
    metric.cycleSeverity = cycleSeverity;
    metric.selfLinks = selfLinks.get(namespace) ?? 0;
    metric.cohesionComponents = cohesion.get(namespace)?.components ?? 0;
    metric.cohesion = cohesion.get(namespace)?.cohesion ?? 0;
    metric.fanInPercentile = percentile(fanIn, values(rawFanIn));
    metric.fanOutPercentile = percentile(fanOut, values(rawFanOut));
    metric.degreePercentile = percentile(degree, values(rawDegree));
    metric.weightedDegreePercentile = percentile(weightedDegree, values(rawWeighted));
    metric.betweennessPercentile = metric.betweenness;
    metric.cyclePercentile = percentile(cycleSeverity, namespaces.map(candidate => {
      const size = sccSizes.get(candidate) ?? 1;
      return size > 1 ? Math.min(1, Math.log2(size) / Math.max(1, Math.log2(maxCycle))) : 0;
    }));
    const rawIn = metricValue(rawFanIn, namespace);
    const rawOut = metricValue(rawFanOut, namespace);
    const instability = rawIn + rawOut === 0 ? 0 : rawOut / (rawIn + rawOut);
    const instabilityPercentile = percentile(instability, namespaces.map(candidate => {
      const candidateIn = metricValue(rawFanIn, candidate);
      const candidateOut = metricValue(rawFanOut, candidate);
      return candidateIn + candidateOut === 0 ? 0 : candidateOut / (candidateIn + candidateOut);
    }));
    metric.contributions = {
      weightedDegree: 0.4 * metric.weightedDegreePercentile,
      reversePageRank: 0.35 * metric.reversePageRank,
      betweenness: 0.25 * metric.betweenness,
      instability: 0.35 * instabilityPercentile,
      fanOut: 0.25 * metric.fanOutPercentile,
      cycle: 0.25 * metric.cycleSeverity,
      fanIn: 0.15 * metric.fanInPercentile,
    };
    metric.connectedness = metric.contributions.weightedDegree
      + metric.contributions.reversePageRank
      + metric.contributions.betweenness;
    metric.overdependency = metric.contributions.instability
      + metric.contributions.fanOut
      + metric.contributions.cycle
      + metric.contributions.fanIn;
    metric.mentionCount = mentionCounts.get(namespace) ?? 0;
  });
  return metrics;
}

function addExternalSurface(
  graph: CodeGraph,
  infos: Map<string, NamespaceInfo>,
  internal: Map<string, NamespaceMetrics>,
  edges: NormalizedEdge[],
  structuralEdgeKinds: Set<CodeEdge['kind']>,
): void {
  const namespaceByNode = new Map(
    graph.nodes
      .map(node => [node.id, namespaceForNode(node)] as const)
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  edges.filter(edge => structuralEdgeKinds.has(edge.kind)).forEach(edge => {
    const source = namespaceByNode.get(edge.source);
    const target = namespaceByNode.get(edge.target);
    if (!source || !target) return;
    const sourceInfo = infos.get(source);
    const targetInfo = infos.get(target);
    if (!sourceInfo || !targetInfo || sourceInfo.external === targetInfo.external) return;
    if (sourceInfo.external) {
      const metric = internal.get(target);
      if (metric) metric.externalFanIn += edge.count;
    } else {
      const metric = internal.get(source);
      if (metric) metric.externalFanOut += edge.count;
    }
  });
}

export function buildNamespaceMetricSets(graph: CodeGraph, options: NamespaceMetricOptions = {}): NamespaceMetricSets {
  const structuralEdgeKinds = new Set<CodeEdge['kind']>(options.structuralEdgeKinds ?? ['requires']);
  const includeExternal = options.includeExternal !== false;
  const cacheKey = `${includeExternal ? 'all' : 'internal'}:${[...structuralEdgeKinds].sort().join(',')}`;
  const cachedEntry = metricSetsCache.get(graph as object);
  const cached = cachedEntry?.get(cacheKey);
  if (cached) return cached;
  const infos = namespaceInfos(graph);
  const allEdges = normalizedEdges(graph);
  const internalNames = new Set([...infos.values()].filter(info => !info.external).map(info => info.name));
  const externalNames = new Set([...infos.values()].filter(info => info.external).map(info => info.name));
  const internal = computeMetrics(graph, infos, internalNames, allEdges, structuralEdgeKinds);
  const external = includeExternal
    ? computeMetrics(graph, infos, externalNames, allEdges, structuralEdgeKinds)
    : new Map<string, NamespaceMetrics>();
  addExternalSurface(graph, infos, internal, allEdges, structuralEdgeKinds);
  const combined = includeExternal ? new Map([...internal, ...external]) : internal;
  const result = { internal, external, combined };
  const nextCache = cachedEntry ?? new Map<string, NamespaceMetricSets>();
  nextCache.set(cacheKey, result);
  if (!cachedEntry) metricSetsCache.set(graph as object, nextCache);
  return result;
}

export function buildNamespaceMetrics(graph: CodeGraph, includeExternal = true, options: NamespaceMetricOptions = {}): Map<string, NamespaceMetrics> {
  const sets = buildNamespaceMetricSets(graph, { ...options, includeExternal });
  return includeExternal ? sets.combined : sets.internal;
}

export function connectionScore(metrics: NamespaceMetrics | undefined, mode: ConnectionMode): number {
  if (!metrics || mode === 'off') return 0;
  return mode === 'connected' ? metrics.connectedness : metrics.overdependency;
}
