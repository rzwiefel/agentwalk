import type { CodeEdge, CodeNode, HistoryCommit } from './types';

/**
 * The coupling result intentionally has its own type instead of extending the
 * graph interchange types. This keeps temporal analysis usable with history
 * returned by the live API as well as with older exported graph files.
 */
export interface TemporalCoverage {
  requestedCommitCount: number;
  uniqueCommitCount: number;
  duplicateCommitCount: number;
  knownCommitCount: number;
  unknownCommitCount: number;
  emptyCommitCount: number;
  observableCommitCount: number;
  commitsWithUnmappedChanges: number;
  mappedNamespaceChanges: number;
  unmappedChanges: number;
  commitCoverage: number;
  changeCoverage: number;
  /** Fraction of supplied commits that have an observable, complete mapping. */
  coverage: number;
  state: 'complete' | 'partial' | 'unavailable';
  reason: string | null;
  reasons: string[];
  complete: boolean;
  source: 'nodes' | 'files' | 'namespaces' | 'mixed' | 'none';
}

export interface TemporalLaggedCoupling {
  maxCommitLag: number;
  aThenBCount: number;
  bThenACount: number;
  totalCount: number;
  support: number;
  confidenceAtoB: number;
  confidenceBtoA: number;
}

export interface TemporalCoupling {
  pairKey: string;
  namespacePair: readonly [string, string];
  namespaceA: string;
  namespaceB: string;
  coChangeCount: number;
  namespaceAChangeCount: number;
  namespaceBChangeCount: number;
  observableCommitCount: number;
  /** Fraction of observable commits containing both namespaces. */
  support: number;
  /** Maximum observed directional confidence; it does not imply causality. */
  confidence: number;
  confidenceAtoB: number;
  confidenceBtoA: number;
  jaccard: number;
  lift: number | null;
  laggedCoupling?: TemporalLaggedCoupling;
  coverage: TemporalCoverage;
  coverageState: TemporalCoverage['state'];
  coverageReason: string | null;
  supportingCommitHashes: string[];
  supportingFiles: string[];
  /** Stable aliases for consumers that use the generic evidence vocabulary. */
  evidenceHashes: string[];
  changedFiles: string[];
  staticEdgePresent?: boolean;
  hiddenCouplingCandidate?: boolean;
}

export interface TemporalNamespaceObservation {
  commitHash: string;
  timestamp?: string;
  namespaces: string[];
  files: string[];
}

export interface TemporalCouplingAnalysis {
  couplings: TemporalCoupling[];
  hiddenCouplingCandidates: TemporalCoupling[];
  coverage: TemporalCoverage;
  coverageState: TemporalCoverage['state'];
  coverageReason: string | null;
  observations: TemporalNamespaceObservation[];
}

export interface TemporalCouplingOptions {
  maxCommitLag?: number;
  minCoChange?: number;
  minConfidence?: number;
  minSupport?: number;
  minLift?: number;
  maxPairs?: number;
  staticNamespaceEdges?: readonly (readonly [string, string])[];
}

export interface TemporalCouplingInput {
  commits?: readonly unknown[];
  timeline?: readonly unknown[];
  history?: {
    commits?: readonly unknown[];
    completeHistoricalSnapshots?: boolean;
    namespaceMappingsComplete?: boolean;
    coverageReasons?: readonly string[];
  } | readonly unknown[];
  observations?: readonly unknown[];
  nodes?: readonly unknown[];
  edges?: readonly unknown[];
  completeHistoricalSnapshots?: boolean;
  namespaceMappingsComplete?: boolean;
  coverageReasons?: readonly string[];
}

type RecordLike = Record<string, unknown>;

interface NormalizedCommit {
  hash: string;
  timestamp?: string;
  changedNodeIds: string[];
  changedFiles: string[];
  changedNamespaces: string[];
  hasChangeMetadata: boolean;
  hasNamespaceMetadata: boolean;
  mappingComplete: boolean;
  observable: boolean;
  originalIndex: number;
}

interface IndexedNode {
  id: string;
  namespace?: string;
  file?: string;
  kind?: string;
}

interface MappedCommit {
  commit: NormalizedCommit;
  namespaces: string[];
  files: string[];
  mappedChangeCount: number;
  unmappedChangeCount: number;
  sourceKinds: Set<'nodes' | 'files' | 'namespaces'>;
}

function record(value: unknown): RecordLike {
  return typeof value === 'object' && value !== null ? value as RecordLike : {};
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.trim();
  return result.length > 0 ? result : undefined;
}

function normalizedPath(value: unknown): string | undefined {
  const result = text(value)?.replaceAll('\\', '/').replace(/^\.\/+/, '');
  return result && result !== '.' ? result : undefined;
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(text).filter((item): item is string => item !== undefined))).sort(compareText);
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b);
}

function pairFor(a: string, b: string): readonly [string, string] {
  return compareText(a, b) <= 0 ? [a, b] : [b, a];
}

function pairKey(pair: readonly [string, string]): string {
  return `${pair[0]}\u001f${pair[1]}`;
}

function namespaceFromNode(node: IndexedNode): string | undefined {
  const explicit = text(node.namespace);
  if (explicit) return explicit;
  if (node.kind === 'namespace' && node.id.startsWith('namespace:')) {
    return text(node.id.slice('namespace:'.length));
  }
  return undefined;
}

function indexedNode(value: unknown, index: number): IndexedNode | null {
  if (typeof value === 'string') return { id: value };
  const input = record(value);
  const id = text(input.id) ?? text(input.fqn) ?? `node-${index}`;
  return {
    id,
    namespace: text(input.namespace),
    file: normalizedPath(input.file),
    kind: text(input.kind),
  };
}

function sourceCommits(input: TemporalCouplingInput | readonly unknown[]): readonly unknown[] {
  if (Array.isArray(input)) return input;
  const source = input as TemporalCouplingInput;
  if (Array.isArray(source.commits)) return source.commits;
  if (Array.isArray(source.timeline)) return source.timeline;
  if (Array.isArray(source.observations)) return source.observations;
  if (Array.isArray(source.history)) return source.history;
  const history = source.history;
  if (history && !Array.isArray(history)) {
    const commits = (history as { commits?: readonly unknown[] }).commits;
    if (Array.isArray(commits)) return commits;
  }
  return [];
}

function hasOwn(input: RecordLike, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function metadataBoolean(input: TemporalCouplingInput, key: 'completeHistoricalSnapshots' | 'namespaceMappingsComplete'): boolean | undefined {
  if (typeof input[key] === 'boolean') return input[key];
  const history = input.history;
  if (history && !Array.isArray(history)) {
    const value = (history as RecordLike)[key];
    return typeof value === 'boolean' ? value : undefined;
  }
  return undefined;
}

function metadataReasons(input: TemporalCouplingInput): string[] {
  const direct = stringValues(input.coverageReasons);
  const history = input.history;
  const nested = history && !Array.isArray(history) ? stringValues((history as RecordLike).coverageReasons) : [];
  return Array.from(new Set([...direct, ...nested])).sort(compareText);
}

function commitHash(input: RecordLike, index: number): string {
  return text(input.hash) ?? text(input.id) ?? `commit-${index}`;
}

function changedNodeIds(input: RecordLike): string[] {
  const ids = stringValues(input.changedNodeIds);
  if (ids.length > 0) return ids;
  if (!Array.isArray(input.changedNodes)) return [];
  return Array.from(new Set(input.changedNodes
    .map(item => typeof item === 'string' ? item : text(record(item).id))
    .filter((item): item is string => item !== undefined))).sort(compareText);
}

function changedNamespaces(input: RecordLike): string[] {
  const values = [
    input.namespaceChanges,
    input.changedNamespaces,
    input.namespaces,
  ].flatMap(stringValues);
  return Array.from(new Set(values)).sort(compareText);
}

function normalizeCommit(value: unknown, index: number): NormalizedCommit {
  const input = record(value);
  const nodeIds = changedNodeIds(input);
  const files = Array.from(new Set([
    ...stringValues(input.changedFiles).map(normalizedPath),
    ...stringValues(input.files).map(normalizedPath),
  ].filter((item): item is string => item !== undefined))).sort(compareText);
  const namespaces = changedNamespaces(input);
  const hasNamespaceMetadata = ['namespaceChanges', 'changedNamespaces', 'namespaces'].some(key => hasOwn(input, key));
  const explicitMapping = typeof input.mappingComplete === 'boolean'
    ? input.mappingComplete
    : typeof input.namespaceMappingComplete === 'boolean' ? input.namespaceMappingComplete : undefined;
  return {
    hash: commitHash(input, index),
    timestamp: text(input.timestamp) ?? text(input.date),
    changedNodeIds: nodeIds,
    changedFiles: files,
    changedNamespaces: namespaces,
    hasChangeMetadata: ['changedNodeIds', 'changedNodes', 'changedFiles', 'files',
      'namespaceChanges', 'changedNamespaces', 'namespaces'].some(key => hasOwn(input, key)),
    hasNamespaceMetadata,
    mappingComplete: explicitMapping ?? (hasNamespaceMetadata || nodeIds.length > 0 || files.length > 0),
    observable: input.observable !== false,
    originalIndex: index,
  };
}

function mergeDuplicateCommit(first: NormalizedCommit, duplicate: NormalizedCommit): NormalizedCommit {
  const timestamp = first.timestamp ?? duplicate.timestamp;
  return {
    ...first,
    timestamp,
    changedNodeIds: Array.from(new Set([...first.changedNodeIds, ...duplicate.changedNodeIds])).sort(compareText),
    changedFiles: Array.from(new Set([...first.changedFiles, ...duplicate.changedFiles])).sort(compareText),
    changedNamespaces: Array.from(new Set([...first.changedNamespaces, ...duplicate.changedNamespaces])).sort(compareText),
    hasChangeMetadata: first.hasChangeMetadata || duplicate.hasChangeMetadata,
    hasNamespaceMetadata: first.hasNamespaceMetadata || duplicate.hasNamespaceMetadata,
    mappingComplete: first.mappingComplete && duplicate.mappingComplete,
    observable: first.observable && duplicate.observable,
  };
}

function uniqueCommits(values: readonly unknown[]): { commits: NormalizedCommit[]; duplicateCount: number } {
  const byHash = new Map<string, NormalizedCommit>();
  let duplicateCount = 0;
  values.map(normalizeCommit).forEach(commit => {
    const existing = byHash.get(commit.hash);
    if (existing) {
      duplicateCount += 1;
      byHash.set(commit.hash, mergeDuplicateCommit(existing, commit));
    } else {
      byHash.set(commit.hash, commit);
    }
  });
  const commits = Array.from(byHash.values()).sort((a, b) => {
    if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) {
      return a.timestamp.localeCompare(b.timestamp);
    }
    return compareText(a.hash, b.hash) || a.originalIndex - b.originalIndex;
  });
  return { commits, duplicateCount };
}

function pathMatches(changed: string, known: string): boolean {
  return changed === known || changed.endsWith(`/${known}`) || known.endsWith(`/${changed}`);
}

function namespacesForFile(file: string, fileNamespaces: readonly (readonly [string, Set<string>])[]): string[] {
  return Array.from(new Set(fileNamespaces
    .filter(([known]) => pathMatches(file, known))
    .flatMap(([, namespaces]) => Array.from(namespaces)))).sort(compareText);
}

function nodeNamespaceIndex(nodes: readonly unknown[]): {
  byId: Map<string, string>;
  byFile: Array<readonly [string, Set<string>]>;
} {
  const byId = new Map<string, string>();
  const byFile = new Map<string, Set<string>>();
  nodes.map(indexedNode).filter((node): node is IndexedNode => node !== null).forEach(node => {
    const namespace = namespaceFromNode(node);
    if (!namespace) return;
    byId.set(node.id, namespace);
    if (node.file) {
      const namespaces = byFile.get(node.file) ?? new Set<string>();
      namespaces.add(namespace);
      byFile.set(node.file, namespaces);
    }
  });
  return {
    byId,
    byFile: Array.from(byFile.entries()).sort(([a], [b]) => compareText(a, b)),
  };
}

function namespacesFromChangedNodes(commit: NormalizedCommit, nodes: {
  byId: Map<string, string>;
}): { namespaces: string[]; unmapped: number } {
  const namespaces = new Set<string>();
  let unmapped = 0;
  commit.changedNodeIds.forEach(id => {
    const namespace = nodes.byId.get(id) ?? (id.startsWith('namespace:') ? text(id.slice(10)) : undefined);
    if (namespace) namespaces.add(namespace);
    else unmapped += 1;
  });
  return { namespaces: Array.from(namespaces).sort(compareText), unmapped };
}

function mapCommits(
  commits: readonly NormalizedCommit[],
  nodes: readonly unknown[],
): { mapped: MappedCommit[]; source: TemporalCoverage['source'] } {
  const nodeIndex = nodeNamespaceIndex(nodes);
  const mapped = commits.map(commit => {
    const sourceKinds = new Set<'nodes' | 'files' | 'namespaces'>();
    const namespaces = new Set<string>();
    const files = new Set(commit.changedFiles);
    let unmapped = 0;
    let mappedChanges = 0;
    if (commit.changedNodeIds.length > 0 || hasKnownNodeMetadata(commit)) {
      sourceKinds.add('nodes');
      const nodeMapping = namespacesFromChangedNodes(commit, nodeIndex);
      nodeMapping.namespaces.forEach(namespace => namespaces.add(namespace));
      unmapped += nodeMapping.unmapped;
      mappedChanges += commit.changedNodeIds.length - nodeMapping.unmapped;
    }
    if (commit.changedFiles.length > 0 || hasKnownFileMetadata(commit)) {
      sourceKinds.add('files');
      commit.changedFiles.forEach(file => {
        const fileMapping = namespacesForFile(file, nodeIndex.byFile);
        fileMapping.forEach(namespace => namespaces.add(namespace));
        if (fileMapping.length > 0) mappedChanges += fileMapping.length;
        else unmapped += 1;
      });
    }
    if (commit.hasNamespaceMetadata) {
      sourceKinds.add('namespaces');
      commit.changedNamespaces.forEach(namespace => namespaces.add(namespace));
      mappedChanges += commit.changedNamespaces.length;
    }
    return {
      commit,
      namespaces: Array.from(namespaces).sort(compareText),
      files: Array.from(files).sort(compareText),
      mappedChangeCount: mappedChanges,
      unmappedChangeCount: commit.mappingComplete ? unmapped : Math.max(1, unmapped),
      sourceKinds,
    };
  });
  const kinds = new Set(Array.from(mapped).flatMap(item => Array.from(item.sourceKinds)));
  const source: TemporalCoverage['source'] = kinds.size === 0 ? 'none'
    : kinds.size === 1 ? (Array.from(kinds)[0] ?? 'none') : 'mixed';
  return { mapped, source };
}

function hasKnownNodeMetadata(commit: NormalizedCommit): boolean {
  return commit.hasChangeMetadata && commit.changedNodeIds.length === 0 && commit.changedFiles.length === 0
    && commit.changedNamespaces.length === 0;
}

function hasKnownFileMetadata(commit: NormalizedCommit): boolean {
  return commit.hasChangeMetadata && commit.changedFiles.length === 0 && commit.changedNodeIds.length === 0
    && commit.changedNamespaces.length === 0;
}

/**
 * Collect only observations that can be mapped completely. Unmapped commits
 * are deliberately omitted from this collection and are reported by
 * `analyzeTemporalCoupling(...).coverage`.
 */
export function collectTemporalNamespaceObservations(
  input: TemporalCouplingInput | readonly unknown[],
): TemporalNamespaceObservation[] {
  const sourceInput = (Array.isArray(input) ? {} : input) as TemporalCouplingInput;
  const commitsResult = uniqueCommits(sourceCommits(input));
  return mapCommits(commitsResult.commits, sourceInput.nodes ?? []).mapped
    .filter(item => item.commit.observable
      && item.commit.hasChangeMetadata
      && item.unmappedChangeCount === 0
      && (item.commit.hasNamespaceMetadata
        || item.commit.changedNodeIds.length > 0
        || item.commit.changedFiles.length > 0))
    .map(item => ({
      commitHash: item.commit.hash,
      ...(item.commit.timestamp ? { timestamp: item.commit.timestamp } : {}),
      namespaces: item.namespaces,
      files: item.files,
    }));
}

function ratio(value: number, denominator: number): number {
  return denominator > 0 ? value / denominator : 0;
}

function staticPairs(
  edges: readonly unknown[] | undefined,
  nodes: readonly unknown[],
  configured: readonly (readonly [string, string])[] | undefined,
): Set<string> {
  const nodeIndex = nodeNamespaceIndex(nodes).byId;
  const pairs = new Set<string>();
  (configured ?? []).forEach(pair => {
    const a = text(pair[0]);
    const b = text(pair[1]);
    if (a && b && a !== b) pairs.add(pairKey(pairFor(a, b)));
  });
  (edges ?? []).forEach(value => {
    const edge = record(value);
    const source = text(edge.source);
    const target = text(edge.target);
    if (!source || !target) return;
    const a = nodeIndex.get(source) ?? (source.startsWith('namespace:') ? text(source.slice(10)) : source);
    const b = nodeIndex.get(target) ?? (target.startsWith('namespace:') ? text(target.slice(10)) : target);
    if (a && b && a !== b) pairs.add(pairKey(pairFor(a, b)));
  });
  return pairs;
}

function coverageFor(
  commits: readonly NormalizedCommit[],
  mapped: readonly MappedCommit[],
  duplicateCount: number,
  source: TemporalCoverage['source'],
  completeHistoricalSnapshots: boolean,
  namespaceMappingsComplete: boolean | undefined,
  suppliedReasons: readonly string[],
): TemporalCoverage {
  const known = commits.filter(commit => commit.hasChangeMetadata);
  const empty = mapped.filter(item => item.commit.hasChangeMetadata && item.namespaces.length === 0
    && item.commit.changedNodeIds.length === 0 && item.commit.changedFiles.length === 0
    && item.commit.changedNamespaces.length === 0).length;
  const observable = mapped.filter(item => item.commit.observable
    && item.commit.hasChangeMetadata
    && item.unmappedChangeCount === 0
    && (item.commit.hasNamespaceMetadata
      || item.commit.changedNodeIds.length > 0
      || item.commit.changedFiles.length > 0)).length;
  const unmappedCommits = mapped.filter(item => item.unmappedChangeCount > 0).length;
  const mappedChanges = mapped.reduce((sum, item) => sum + item.mappedChangeCount, 0);
  const unmappedChanges = mapped.reduce((sum, item) => sum + item.unmappedChangeCount, 0);
  const reasons = [...suppliedReasons];
  if (!completeHistoricalSnapshots) {
    reasons.push('Complete historical snapshots were not declared; deleted or renamed historical namespaces may be unavailable.');
  }
  if (known.length !== commits.length) reasons.push('Some supplied commits have no change metadata.');
  if (unmappedCommits > 0 || namespaceMappingsComplete === false) {
    reasons.push('One or more commits do not have a complete namespace mapping.');
  }
  const state: TemporalCoverage['state'] = commits.length === 0
    ? 'unavailable'
    : completeHistoricalSnapshots
      && namespaceMappingsComplete !== false
      && known.length === commits.length
      && unmappedCommits === 0
      ? 'complete'
      : 'partial';
  if (commits.length === 0) reasons.push('No historical commits were supplied.');
  const finalReasons = Array.from(new Set(reasons)).sort(compareText);
  return {
    requestedCommitCount: commits.length + duplicateCount,
    uniqueCommitCount: commits.length,
    duplicateCommitCount: duplicateCount,
    knownCommitCount: known.length,
    unknownCommitCount: commits.length - known.length,
    emptyCommitCount: empty,
    observableCommitCount: observable,
    commitsWithUnmappedChanges: unmappedCommits,
    mappedNamespaceChanges: mappedChanges,
    unmappedChanges,
    commitCoverage: ratio(known.length, commits.length),
    changeCoverage: ratio(mappedChanges, mappedChanges + unmappedChanges),
    coverage: ratio(observable, commits.length),
    state,
    reason: finalReasons[0] ?? null,
    reasons: finalReasons,
    complete: state === 'complete',
    source,
  };
}

function lagged(
  pair: readonly [string, string],
  observations: readonly TemporalNamespaceObservation[],
  aCount: number,
  bCount: number,
  maxCommitLag: number,
  observableCommitCount: number,
): TemporalLaggedCoupling {
  let aThenBCount = 0;
  let bThenACount = 0;
  observations.forEach((observation, index) => {
    if (!observation.namespaces.includes(pair[0])) return;
    for (let next = index + 1; next <= Math.min(observations.length - 1, index + maxCommitLag); next += 1) {
      if (observations[next].namespaces.includes(pair[1])) {
        aThenBCount += 1;
        break;
      }
    }
  });
  observations.forEach((observation, index) => {
    if (!observation.namespaces.includes(pair[1])) return;
    for (let next = index + 1; next <= Math.min(observations.length - 1, index + maxCommitLag); next += 1) {
      if (observations[next].namespaces.includes(pair[0])) {
        bThenACount += 1;
        break;
      }
    }
  });
  return {
    maxCommitLag,
    aThenBCount,
    bThenACount,
    totalCount: aThenBCount + bThenACount,
    support: ratio(aThenBCount + bThenACount, observableCommitCount),
    confidenceAtoB: ratio(aThenBCount, aCount),
    confidenceBtoA: ratio(bThenACount, bCount),
  };
}

export function analyzeTemporalCoupling(
  input: TemporalCouplingInput | readonly unknown[],
  options: TemporalCouplingOptions = {},
): TemporalCouplingAnalysis {
  const sourceInput = (Array.isArray(input) ? {} : input) as TemporalCouplingInput;
  const nodes = sourceInput.nodes ?? [];
  const commitsResult = uniqueCommits(sourceCommits(input));
  const mappedResult = mapCommits(commitsResult.commits, nodes);
  const coverage = coverageFor(
    commitsResult.commits,
    mappedResult.mapped,
    commitsResult.duplicateCount,
    mappedResult.source,
    metadataBoolean(sourceInput, 'completeHistoricalSnapshots') === true,
    metadataBoolean(sourceInput, 'namespaceMappingsComplete'),
    metadataReasons(sourceInput),
  );
  const observations = mappedResult.mapped
    .filter(item => item.commit.observable
      && item.commit.hasChangeMetadata
      && item.unmappedChangeCount === 0
      && (item.commit.hasNamespaceMetadata
        || item.commit.changedNodeIds.length > 0
        || item.commit.changedFiles.length > 0))
    .map(item => ({
      commitHash: item.commit.hash,
      ...(item.commit.timestamp ? { timestamp: item.commit.timestamp } : {}),
      namespaces: item.namespaces,
      files: item.files,
    }));
  const observableCommitCount = observations.length;
  const namespaceCounts = new Map<string, number>();
  observations.forEach(observation => observation.namespaces.forEach(namespace => {
    namespaceCounts.set(namespace, (namespaceCounts.get(namespace) ?? 0) + 1);
  }));
  const pairStats = new Map<string, {
    pair: readonly [string, string];
    coChangeCount: number;
    hashes: Set<string>;
    files: Set<string>;
  }>();
  observations.forEach(observation => {
    for (let left = 0; left < observation.namespaces.length; left += 1) {
      for (let right = left + 1; right < observation.namespaces.length; right += 1) {
        const pair = pairFor(observation.namespaces[left], observation.namespaces[right]);
        const key = pairKey(pair);
        const stats = pairStats.get(key) ?? {
          pair,
          coChangeCount: 0,
          hashes: new Set<string>(),
          files: new Set<string>(),
        };
        stats.coChangeCount += 1;
        stats.hashes.add(observation.commitHash);
        observation.files.forEach(file => stats.files.add(file));
        pairStats.set(key, stats);
      }
    }
  });
  const hasStaticEdgeData = Array.isArray(sourceInput.edges) || options.staticNamespaceEdges !== undefined;
  const staticEdgeKeys = staticPairs(sourceInput.edges, nodes, options.staticNamespaceEdges);
  const maxCommitLag = Math.max(0, Math.floor(options.maxCommitLag ?? 0));
  const couplings = Array.from(pairStats.values()).map(stats => {
    const [namespaceA, namespaceB] = stats.pair;
    const namespaceAChangeCount = namespaceCounts.get(namespaceA) ?? 0;
    const namespaceBChangeCount = namespaceCounts.get(namespaceB) ?? 0;
    const support = ratio(stats.coChangeCount, observableCommitCount);
    const confidenceAtoB = ratio(stats.coChangeCount, namespaceAChangeCount);
    const confidenceBtoA = ratio(stats.coChangeCount, namespaceBChangeCount);
    const jaccard = ratio(stats.coChangeCount, namespaceAChangeCount + namespaceBChangeCount - stats.coChangeCount);
    const lift = namespaceAChangeCount > 0 && namespaceBChangeCount > 0 && observableCommitCount > 0
      ? stats.coChangeCount * observableCommitCount
        / (namespaceAChangeCount * namespaceBChangeCount)
      : null;
    const staticEdgePresent = hasStaticEdgeData ? staticEdgeKeys.has(pairKey(stats.pair)) : undefined;
    const confidence = Math.max(confidenceAtoB, confidenceBtoA);
    const hiddenCouplingCandidate = staticEdgePresent === false
      && stats.coChangeCount >= (options.minCoChange ?? 2)
      && confidence >= (options.minConfidence ?? 0.5)
      && support >= (options.minSupport ?? 0);
    return {
      pairKey: stats.pair.join('|'),
      namespacePair: stats.pair,
      namespaceA,
      namespaceB,
      coChangeCount: stats.coChangeCount,
      namespaceAChangeCount,
      namespaceBChangeCount,
      observableCommitCount,
      support,
      confidence,
      confidenceAtoB,
      confidenceBtoA,
      jaccard,
      lift,
      ...(maxCommitLag > 0 ? {
        laggedCoupling: lagged(
          stats.pair,
          observations,
          namespaceAChangeCount,
          namespaceBChangeCount,
          maxCommitLag,
          observableCommitCount,
        ),
      } : {}),
      coverage,
      coverageState: coverage.state,
      coverageReason: coverage.reason,
      supportingCommitHashes: Array.from(stats.hashes).sort(compareText),
      supportingFiles: Array.from(stats.files).sort(compareText),
      evidenceHashes: Array.from(stats.hashes).sort(compareText),
      changedFiles: Array.from(stats.files).sort(compareText),
      ...(staticEdgePresent === undefined ? {} : { staticEdgePresent }),
      ...(staticEdgePresent === undefined ? {} : { hiddenCouplingCandidate }),
    };
  }).filter(coupling => coupling.coChangeCount >= (options.minCoChange ?? 1)
    && coupling.confidence >= (options.minConfidence ?? 0)
    && coupling.support >= (options.minSupport ?? 0)
    && (coupling.lift === null || coupling.lift >= (options.minLift ?? 0)))
    .sort((a, b) => b.coChangeCount - a.coChangeCount
      || (b.lift ?? Number.NEGATIVE_INFINITY) - (a.lift ?? Number.NEGATIVE_INFINITY)
      || b.confidence - a.confidence
      || compareText(a.namespaceA, b.namespaceA)
      || compareText(a.namespaceB, b.namespaceB))
    .slice(0, options.maxPairs === undefined ? undefined : Math.max(0, Math.floor(options.maxPairs)));
  return {
    couplings,
    hiddenCouplingCandidates: couplings.filter(coupling => coupling.hiddenCouplingCandidate === true),
    coverage,
    coverageState: coverage.state,
    coverageReason: coverage.reason,
    observations,
  };
}

export function temporalCouplingFromHistory(
  commits: readonly HistoryCommit[] | readonly unknown[],
  nodes: readonly CodeNode[] | readonly unknown[] = [],
  edges: readonly CodeEdge[] | readonly unknown[] = [],
  options: TemporalCouplingOptions = {},
): TemporalCouplingAnalysis {
  return analyzeTemporalCoupling({ commits, nodes, edges }, options);
}

export function detectHiddenCouplingCandidates(
  analysis: TemporalCouplingAnalysis,
  options: Pick<TemporalCouplingOptions, 'minCoChange' | 'minConfidence' | 'minSupport'> = {},
): TemporalCoupling[] {
  return analysis.couplings.filter(coupling => coupling.staticEdgePresent === false
    && coupling.coChangeCount >= (options.minCoChange ?? 2)
    && coupling.confidence >= (options.minConfidence ?? 0.5)
    && coupling.support >= (options.minSupport ?? 0));
}
