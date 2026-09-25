import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { HistoryControls } from './components/HistoryControls';
import { GraphCanvas } from './components/GraphCanvas';
import { Inspector } from './components/Inspector';
import { NamespaceDossier } from './components/NamespaceDossier';
import { BlastRadiusPanel } from './components/BlastRadiusPanel';
import { CommunityView } from './components/CommunityView';
import { DsmView } from './components/DsmView';
import { TemporalCouplingPanel } from './components/TemporalCouplingPanel';
import { loadRepository, loadRevision } from './api';
import { analyzeParser, loadParserCapabilities, ParserApiError } from './parserApi';
import { neighborIds, nodeIndex, normalizeGraph } from './graph';
import { activityGroupSpecs, activityLayoutSignature, computeLayout, withActivityAgentNodes, withActivityGroups } from './layout';
import { buildNamespaceMetrics } from './namespaceMetrics';
import { explainNamespaceConnection, resolveNamespace } from './connectionExplain';
import { historyActivity as buildHistoryActivity, historyDurationMs, historyFrames, historyHeat as buildHistoryHeat, historyStaggerStepMs } from './history';
import { isGlobalNode, isTestNode, testNamespacesForGraph } from './namespaceVisibility';
import { temporalCouplingFromHistory } from './temporalCoupling';
import { ActivityPanel, activitySessionSummaries } from './components/ActivityPanel';
import { activityRenderState } from './activity/reducer';
import { activityWorkspaceId, buildActivityGraphIndexes } from './activity/graphResolver';
import { useActivityReplay, useActivityStream } from './activity/hooks';
import type { ActivityEvent, ActivityMode, ActivityRay } from './activity/types';
import { loadViewSettings, saveViewSettings } from './viewSettings';
import type { ActivityLayerToggles } from './viewSettings';
import type {
  AnalysisView,
  CodeEdge,
  CodeGraph,
  CodeNode,
  ConnectionMode,
  HistoryCommit,
  LayoutResult,
  NodeVisibilityMode,
  NodeVisibilityModes,
  ParserCapabilities,
  ParserDiagnostic,
  ParserLanguage,
  RepositoryAnalysisMode,
  RepositoryInfo,
  RevisionMetadata,
} from './types';

const allKinds = new Set<CodeNode['kind']>(['namespace', 'var', 'keyword']);
export const ARCHITECTURE_DEFAULT_VISIBLE_KINDS = new Set<CodeNode['kind']>(allKinds);
export const LIVE_DEFAULT_VISIBLE_KINDS = new Set<CodeNode['kind']>(['namespace']);
export const DEFAULT_EDGE_VISIBILITY: Record<CodeEdge['kind'], boolean> = { requires: false, calls: false, mentions: false };
const DEFAULT_ANALYSIS_MODE: RepositoryAnalysisMode = 'typescript-javascript';
export const EMPTY_GRAPH: CodeGraph = {
  formatVersion: 1,
  generatedAt: '1970-01-01T00:00:00.000Z',
  // Empty, not a personal path: an unloaded repository has no root yet, and an
  // empty repositoryPath is also the sentinel (see viewSettings.ts) meaning
  // "use the server's --repo-root default" once analysis is requested.
  repo: { name: 'No repository loaded', root: '' },
  nodes: [],
  edges: [],
  stats: { nodes: 0, edges: 0, namespaces: 0, vars: 0, keywords: 0 },
};

export function activityArchitectureContextVisible(viewMode: ActivityMode, requested: boolean): boolean {
  return viewMode !== 'activity' || requested;
}

// T1-G: a stable empty set so `dimmedSessionIds` doesn't hand GraphCanvas a
// fresh (but equivalent) Set every render when nothing is actually dimmed.
const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();

// Mirrors GraphCanvas's own `textInputActive()` (src/components/GraphCanvas.tsx) --
// duplicated rather than imported since GraphCanvas does not export it and this
// file does not otherwise depend on that component's internals. Used to keep the
// number-key session solo (T1-G) from firing while the repository path field (or
// any other text input) has focus.
function activityTextInputFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable);
}

function matches(node: CodeNode, query: string) {
  if (!query.trim()) return true;
  const needle = query.toLowerCase();
  return [node.label, node.namespace, node.fqn, node.file, node.id].some(value => value?.toLowerCase().includes(needle));
}

function revisionKey(repoRoot: string, hash: string) {
  return `${repoRoot}\u0000${hash}`;
}

function errorMessage(reason: unknown, fallback: string) {
  if (reason instanceof ParserApiError) {
    const details = typeof reason.details === 'string'
      ? reason.details
      : reason.details && typeof reason.details === 'object'
        ? ` ${JSON.stringify(reason.details)}`
        : '';
    return `[${reason.code}] ${reason.message}${details}`;
  }
  return reason instanceof Error ? reason.message : fallback;
}

function parserStatus(result: { status?: string }, graph: unknown) {
  if (result.status) return result.status;
  const input = typeof graph === 'object' && graph !== null ? graph as Record<string, unknown> : {};
  const analysis = typeof input.analysis === 'object' && input.analysis !== null ? input.analysis as Record<string, unknown> : {};
  return typeof analysis.result_status === 'string' ? analysis.result_status : 'complete';
}

function parserLanguage(value: string | null | undefined): 'python' | 'csharp' | 'typescript-javascript' | null {
  if (value === 'python') return 'python';
  if (value === 'csharp' || value === 'c#' || value === 'dotnet') return 'csharp';
  if (value === 'typescript-javascript' || value === 'typescript' || value === 'javascript' || value === 'ts' || value === 'js') return 'typescript-javascript';
  return null;
}

function absoluteActivityPath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
}

function normalizeActivityPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function activityWorkspacePath(event: ActivityEvent): string | undefined {
  const workspace = event.workspace;
  if (!workspace) return undefined;
  const candidates = [workspace.path, workspace.root, workspace.file, workspace.repository];
  const value = candidates.find((candidate): candidate is string => typeof candidate === 'string' && absoluteActivityPath(candidate));
  return value ? normalizeActivityPath(value) : undefined;
}

export function activityProjectKey(event: ActivityEvent): string | undefined {
  const path = activityWorkspacePath(event);
  if (!path) return undefined;
  return `${event.workspace?.id ?? ''}\u0000${path}`;
}

export function isAgentActivityEvent(event: ActivityEvent): boolean {
  return Boolean(event.agentId)
    || event.type === 'agent'
    || event.type.startsWith('agent.')
    || event.type.startsWith('subagent.')
    || event.type === 'session.start'
    || event.type === 'session.started'
    || event.type === 'session.status'
    || event.type === 'session' && ['started', 'resumed', 'active', 'updated'].includes(event.status ?? '');
}

// --- T1-G / Wave 1.5: follow-agent, dim-others, and number-key solo -----------
// Pure pieces of the App-side wiring for the three GraphCanvas props that
// landed inert in 25f3d4c (followTarget, dimmedSessionIds) plus the session
// solo shortcut, kept free of hooks/DOM so they're testable the same way as
// the activity helpers above: called directly, no component render required.

/**
 * Centroid of a followed agent's recent ray targets, in the same world space as
 * `layout.positions` -- what GraphCanvas's `followTarget` prop eases the camera
 * toward. Resolves each ray's target (a graph node or an activity group) to a
 * position and averages them, so the camera settles between wherever the agent
 * has recently been pointed rather than snapping to the newest one. Falls back
 * to the agent's own position when it has no (unexpired) ray targets, and to
 * `null` -- meaning "leave the camera alone", per the prop's own contract --
 * once the agent has no position at all (e.g. its session ended).
 */
export function activityFollowTargetCentroid(
  followedAgentId: string,
  rays: readonly Pick<ActivityRay, 'sourceAgentNodeId' | 'target'>[],
  layout: Pick<LayoutResult, 'positions' | 'groups' | 'activityAgents' | 'activityInactiveAgents'>,
): [number, number, number] | null {
  const groupCentersById = new Map(layout.groups.map(group => [group.id, group.center] as const));
  const points = rays
    .filter(ray => ray.sourceAgentNodeId === followedAgentId)
    .map(ray => ray.target.kind === 'group' ? groupCentersById.get(ray.target.id) : layout.positions.get(ray.target.id))
    .filter((point): point is [number, number, number] => point !== undefined);
  if (points.length > 0) {
    const sum = points.reduce<[number, number, number]>((total, point) => [total[0] + point[0], total[1] + point[1], total[2] + point[2]], [0, 0, 0]);
    return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
  }
  const agentLayout = [...(layout.activityAgents ?? []), ...(layout.activityInactiveAgents ?? [])].find(agent => agent.id === followedAgentId);
  return agentLayout?.center ?? null;
}

/**
 * Dim-others (T1-G): the complement of `sessionFilter` within `sessionIds` --
 * the sessions the user did *not* select, which GraphCanvas renders at reduced
 * opacity via `dimmedSessionIds` instead of the layout omitting them outright.
 * `null` (no filter active) dims nothing, matching `activityDimFactor`'s own
 * "no filter -> full opacity" rule in GraphCanvas.tsx.
 */
export function activityDimmedSessionIds(sessionIds: Iterable<string>, sessionFilter: ReadonlySet<string> | null): ReadonlySet<string> {
  if (sessionFilter === null) return EMPTY_SESSION_IDS;
  const dimmed = new Set<string>();
  for (const id of sessionIds) {
    if (!sessionFilter.has(id)) dimmed.add(id);
  }
  return dimmed;
}

/**
 * The next session filter for soloing `sessionId` (number-key shortcut or a
 * future click-to-solo affordance): toggles back to "no filter" if `sessionId`
 * is already the sole selection, otherwise solos it. Mirrors the toggle already
 * used for click-to-follow below, so both shortcuts behave the same way on a
 * second press.
 */
export function activitySessionSoloFilter(current: ReadonlySet<string> | null, sessionId: string): Set<string> | null {
  return current !== null && current.size === 1 && current.has(sessionId) ? null : new Set([sessionId]);
}

export function graphFromParserResult(result: { graph: unknown; revision?: RevisionMetadata }) {
  const input = typeof result.graph === 'object' && result.graph !== null
    ? result.graph as Record<string, unknown>
    : result.graph;
  return normalizeGraph(result.revision && typeof input === 'object' && input !== null
    ? { ...input, revision: result.revision }
    : input);
}

// Activity-layer post-filter helper (T1-A). A group with no `.activity` kind
// (i.e. an architecture-context group) is never hidden by these toggles.
function isActivityGroupHidden(kind: string | undefined, layers: ActivityLayerToggles): boolean {
  if (!kind) return false;
  if ((kind === 'bash' || kind === 'tool') && !layers.toolbox) return true;
  if ((kind === 'project' || kind === 'directory' || kind === 'file') && !layers.filePlane) return true;
  return false;
}

const DetailPanel = memo(function DetailPanel({
  graph,
  selectedNode,
  error,
  namespaceMetrics,
  temporalAnalysis,
  analysisView,
  explanationTarget,
  onFocus,
  onSelectNode,
  onSelectNamespace,
  onExplainConnection,
}: {
  graph: CodeGraph;
  selectedNode: CodeNode | null;
  error: string | null;
  namespaceMetrics: ReturnType<typeof buildNamespaceMetrics>;
  temporalAnalysis: ReturnType<typeof temporalCouplingFromHistory>;
  analysisView: AnalysisView;
  explanationTarget: string | null;
  onFocus: () => void;
  onSelectNode: (id: string) => void;
  onSelectNamespace: (namespace: string) => void;
  onExplainConnection: (namespace: string) => void;
}) {
  const selectedNamespace = selectedNode ? resolveNamespace(graph, selectedNode) : null;
  const selectedMetric = selectedNamespace ? namespaceMetrics.get(selectedNamespace) : undefined;
  const explanation = explanationTarget && selectedNamespace
    ? explainNamespaceConnection(graph, selectedNamespace, explanationTarget, { direction: 'outgoing', maxDepth: 6, maxPaths: 3 })
    : null;
  const coChangeCandidates = selectedNamespace
    ? temporalAnalysis.couplings
      .filter(coupling => coupling.namespaceA === selectedNamespace || coupling.namespaceB === selectedNamespace)
      .slice(0, 8)
      .map(coupling => ({
        namespace: coupling.namespaceA === selectedNamespace ? coupling.namespaceB : coupling.namespaceA,
        label: coupling.hiddenCouplingCandidate ? 'Hidden coupling candidate' : 'Co-change partner',
        reason: `${coupling.coChangeCount} shared commits · lift ${coupling.lift === null ? '—' : coupling.lift.toFixed(2)}`,
        score: coupling.confidence,
      }))
    : [];
  return (
    <aside className="detail-panel">
      <Inspector node={selectedNode} namespaceMetrics={namespaceMetrics} onFocus={onFocus} />
      {analysisView === 'dossier' && <NamespaceDossier key={`dossier:${selectedNode?.id ?? 'none'}`} graph={graph} selection={selectedNode} metrics={selectedMetric} coChangeCandidates={coChangeCandidates} onSelectNamespace={onSelectNamespace} onExplainConnection={onExplainConnection} />}
      {analysisView === 'blast-radius' && <BlastRadiusPanel key={`blast:${selectedNode?.id ?? 'none'}`} graph={graph} root={selectedNode?.id ?? null} onSelectNode={onSelectNode} />}
      {analysisView === 'temporal' && <TemporalCouplingPanel key={`temporal:${selectedNode?.id ?? 'none'}`} analysis={temporalAnalysis} selectedNamespace={selectedNamespace} onSelectNamespace={onSelectNamespace} />}
      {analysisView === 'communities' && <CommunityView key={`communities:${selectedNode?.id ?? 'none'}`} graph={graph} selectedNamespace={selectedNamespace} onSelectNamespace={onSelectNamespace} />}
      {analysisView === 'dsm' && <DsmView key={`dsm:${selectedNode?.id ?? 'none'}`} graph={graph} selectedNamespace={selectedNamespace} onSelectNamespace={onSelectNamespace} />}
      {explanation && (
        <section className="connection-explanation">
          <span className="eyebrow">Connection explanation</span>
          <h3>{selectedNamespace} → {explanationTarget}</h3>
          <p>{explanation.explanation}</p>
          {explanation.paths.length > 0 && <ol>{explanation.paths.map(path => <li key={path.namespaces.join('→')}><code>{path.namespaces.join(' → ')}</code></li>)}</ol>}
          {explanation.bounded && <small>Search was bounded by depth or path limits.</small>}
        </section>
      )}
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="legend"><span className="eyebrow">Reading the map</span><p><span className="kind-dot kind-namespace" /> Namespace anchors</p><p><span className="kind-dot kind-var" /> Vars orbit their namespace</p><p><span className="kind-dot kind-keyword" /> Keyword usage</p><p><span className="edge-line edge-calls" /> Calls <span className="edge-line edge-requires" /> Requires</p></div>
      <footer>Graph format v{graph.formatVersion} / indexed {new Date(graph.generatedAt).toLocaleDateString()}{graph.analysis && ` / ${graph.analysis.mode} ${graph.analysis.files} files`}</footer>
    </aside>
  );
});

export default function App() {
  const [viewMode, setViewMode] = useState<ActivityMode>(() => loadViewSettings().viewMode);
  const [graph, setGraph] = useState<CodeGraph>(EMPTY_GRAPH);
  const [repositoryPath, setRepositoryPath] = useState(() => loadViewSettings().repositoryPath);
  const [repository, setRepository] = useState<RepositoryInfo | null>(null);
  const [repositoryLoading, setRepositoryLoading] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<RepositoryAnalysisMode>(DEFAULT_ANALYSIS_MODE);
  const [parserCapabilities, setParserCapabilities] = useState<ParserCapabilities | null>(null);
  const [parserCapabilitiesLoading, setParserCapabilitiesLoading] = useState(false);
  const [parserAnalysisLoading, setParserAnalysisLoading] = useState(false);
  const [parserDiagnostics, setParserDiagnostics] = useState<ParserDiagnostic[]>([]);
  const [activeLanguage, setActiveLanguage] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<string | null>(null);
  const [timelineCommits, setTimelineCommits] = useState<HistoryCommit[]>([]);
  const [historySource, setHistorySource] = useState<'clojure' | 'parser' | null>(null);
  const [revisionMetadata, setRevisionMetadata] = useState<RevisionMetadata | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [focusedIds, setFocusedIds] = useState<Set<string> | null>(null);
  const [visibleKinds, setVisibleKinds] = useState(() => new Set(LIVE_DEFAULT_VISIBLE_KINDS));
  const [visibilityModes, setVisibilityModes] = useState<NodeVisibilityModes>({ var: 'updated', keyword: 'updated' });
  const [showExternal, setShowExternal] = useState(false);
  const [showTestNamespaces, setShowTestNamespaces] = useState(true);
  const [showGlobalNamespace, setShowGlobalNamespace] = useState(true);
  const [orbitGlobalNamespace, setOrbitGlobalNamespace] = useState(false);
  const [showTopLevelFolderConnections, setShowTopLevelFolderConnections] = useState(true);
  const [edgeVisibility, setEdgeVisibility] = useState(DEFAULT_EDGE_VISIBILITY);
  const [relationshipVisibilityMode, setRelationshipVisibilityMode] = useState<NodeVisibilityMode>('updated');
  const [showLabels, setShowLabels] = useState(() => loadViewSettings().showLabels);
  const [showHierarchy, setShowHierarchy] = useState(() => loadViewSettings().showHierarchy);
  const [hierarchyLeavesOnly, setHierarchyLeavesOnly] = useState(true);
  const [heatEnabled, setHeatEnabled] = useState(false);
  const [fullOpacity, setFullOpacity] = useState(false);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('off');
  const [analysisView, setAnalysisView] = useState<AnalysisView>('dossier');
  const [explanationTarget, setExplanationTarget] = useState<string | null>(null);
  const [physicsEnabled, setPhysicsEnabled] = useState(false);
  const [nodeScale, setNodeScale] = useState(() => loadViewSettings().nodeScale);
  const [activityLayers, setActivityLayers] = useState<ActivityLayerToggles>(() => loadViewSettings().activityLayers);
  const [showInactiveAgents, setShowInactiveAgents] = useState(() => loadViewSettings().showInactiveAgents);
  // Paused state is deliberately not persisted: session ids and connection
  // state are ephemeral, and silently staying paused across a reload would
  // hide live data with no visible cause.
  const [activityPaused, setActivityPaused] = useState(false);
  const [activityNow, setActivityNow] = useState(() => Date.now());
  const [activitySessionFilter, setActivitySessionFilter] = useState<ReadonlySet<string> | null>(null);
  // Dim-others mode (T1-G / Wave 1.5): a persisted preference, unlike the session
  // filter/solo selection itself. When on, sessions excluded by
  // activitySessionFilter stay on the canvas at reduced opacity (dimmedSessionIds)
  // instead of being removed from layout entirely -- the pre-existing remove
  // behaviour is unchanged when this is off (the default).
  const [activityDimOthers, setActivityDimOthers] = useState<boolean>(() => loadViewSettings().activityDimOthers);
  // Which agent's recent targets the camera is easing toward (T1-G). Transient --
  // agent identities are as ephemeral as session ids, so this deliberately is not
  // persisted (see the session-filter comment below).
  const [followedAgentId, setFollowedAgentId] = useState<string | null>(null);
  const [architectureContextRequested, setArchitectureContextRequested] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyPlaying, setHistoryPlaying] = useState(false);
  const [historyIntervalMs, setHistoryIntervalMs] = useState(4750);
  const [historyElapsed, setHistoryElapsed] = useState(0);
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const historyRequest = useRef(0);
  const parserAnalysisRequest = useRef(0);
  const parserRequestController = useRef<AbortController | null>(null);
  const activityProjectRequest = useRef(0);
  const activityProjectController = useRef<AbortController | null>(null);
  const activityProjectKeyRef = useRef<string | null>(null);
  const architectureVisibleKinds = useRef(new Set(ARCHITECTURE_DEFAULT_VISIBLE_KINDS));
  const liveVisibleKinds = useRef(new Set(LIVE_DEFAULT_VISIBLE_KINDS));
  const viewModeRef = useRef(viewMode);
  const revisionCache = useRef(new Map<string, CodeGraph>());
  const revisionRequests = useRef(new Map<string, Promise<CodeGraph>>());
  const parserRevisionRequests = useRef(new Map<string, Promise<CodeGraph>>());
  const lastHistoryTarget = useRef<{ index: number; playing: boolean } | null>(null);
  const previousLayout = useRef<LayoutResult | undefined>(undefined);
  const previousActivityLayout = useRef<LayoutResult | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const selectedIdRef = useRef(selectedId);
  // Session ids in the same order ActivityPanel numbers/lists them (most recently
  // active first), so the 1-9 solo shortcut below always matches what's on screen.
  // Mirrored into a ref, not read directly in the keydown handler, so that handler
  // can keep an empty dependency array instead of tearing down and re-adding the
  // window listener on every activity tick.
  const activitySessionOrderRef = useRef<string[]>([]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  // Persisted view settings (T1-A). The session filter is deliberately never
  // persisted here: session ids are ephemeral and a stale filter would just
  // hide a future session that happens to reuse nothing meaningful.
  useEffect(() => {
    saveViewSettings({ viewMode });
  }, [viewMode]);
  useEffect(() => {
    saveViewSettings({ repositoryPath });
  }, [repositoryPath]);
  useEffect(() => {
    saveViewSettings({ activityLayers });
  }, [activityLayers]);
  useEffect(() => {
    saveViewSettings({ activityDimOthers });
  }, [activityDimOthers]);
  useEffect(() => {
    saveViewSettings({ showInactiveAgents });
  }, [showInactiveAgents]);
  useEffect(() => {
    saveViewSettings({ showLabels, showHierarchy, nodeScale });
  }, [showLabels, showHierarchy, nodeScale]);

  const baseLayout = useMemo(() => computeLayout(graph, previousLayout.current, {
    globalNamespaceMode: orbitGlobalNamespace ? 'orbit' : 'bottom',
    nodeScale,
    showGlobalNamespace,
  }), [graph, nodeScale, orbitGlobalNamespace, showGlobalNamespace]);
  useEffect(() => {
    previousLayout.current = baseLayout;
  }, [baseLayout]);
  const nodes = useMemo(() => nodeIndex(graph), [graph]);
  const activityIndexes = useMemo(() => {
    const includeArchitecture = activityArchitectureContextVisible(viewMode, architectureContextRequested);
    return includeArchitecture
      ? buildActivityGraphIndexes(graph, baseLayout.groups)
      : buildActivityGraphIndexes(EMPTY_GRAPH, []);
  }, [architectureContextRequested, baseLayout.groups, graph, viewMode]);
  const activityReplayWorkspaceId = graph.repo.root ? activityWorkspaceId(graph.repo.root) : undefined;
  const liveActivityState = useActivityStream({
    enabled: viewMode === 'activity',
    paused: activityPaused,
    indexes: activityIndexes,
  });
  const activityReplay = useActivityReplay({
    enabled: viewMode === 'activity',
    workspaceId: activityReplayWorkspaceId,
    indexes: activityIndexes,
  });
  const replayActive = activityReplay.open && activityReplay.snapshot !== null;
  const activityState = replayActive ? activityReplay.snapshot!.activity : liveActivityState;
  const activityClockNow = replayActive ? activityReplay.snapshot!.virtualTime : activityNow;
  // Layout expiry uses event timestamps, while replay reducer state uses a
  // virtual clock. Rewrite only layout input to that clock; the panel and
  // event list continue to display provider timestamps.
  const layoutActivityEvents = useMemo(() => {
    if (!replayActive || activityReplay.eventVirtualTimes.size === 0) return activityState.events;
    return activityState.events.map(event => {
      const virtualTime = event.recordingSequence === undefined
        ? undefined
        : activityReplay.eventVirtualTimes.get(event.recordingSequence);
      return virtualTime === undefined
        ? event
        : { ...event, timestamp: new Date(virtualTime).toISOString() };
    });
  }, [activityReplay.eventVirtualTimes, activityState.events, replayActive]);
  useEffect(() => {
    activitySessionOrderRef.current = activitySessionSummaries(activityState, activityClockNow).map(session => session.id);
  }, [activityClockNow, activityState]);
  // Dim-others (T1-G): when active, the session filter no longer removes
  // non-selected sessions from what gets laid out/rendered -- it only decides
  // what ends up in dimmedSessionIds below. Passing null here reuses the
  // existing "no filter" path everywhere below unchanged.
  const activityLayoutSessionFilter = activityDimOthers ? null : activitySessionFilter;
  // activityNow ticks every second (see the interval below) so it cannot sit in this
  // useMemo's own deps without forcing the full recursive group/agent packing to
  // re-run every tick even when nothing changed. activityLayoutSignature reduces
  // (visible events, visible agents, now) to a string that only changes when the
  // live set actually changes or a group/agent crosses a liveness threshold, so it
  // stands in for activityNow here; the packing itself still reads the current
  // activityNow via closure whenever it does run.
  const activityLayoutKey = useMemo(() => {
    const visibleEvents = activityLayoutSessionFilter === null
      ? layoutActivityEvents
      : layoutActivityEvents.filter(event => activityLayoutSessionFilter.has(event.sessionId));
    const visibleAgents = [...activityState.agentNodes.values()].filter(agent => activityLayoutSessionFilter === null || activityLayoutSessionFilter.has(agent.sessionId));
    return activityLayoutSignature(visibleEvents, visibleAgents, activityClockNow);
  }, [activityClockNow, layoutActivityEvents, activityLayoutSessionFilter, activityState.agentNodes]);
  const layout = useMemo(() => {
    const visibleEvents = activityLayoutSessionFilter === null
      ? layoutActivityEvents
      : layoutActivityEvents.filter(event => activityLayoutSessionFilter.has(event.sessionId));
    const visibleAgents = [...activityState.agentNodes.values()].filter(agent => activityLayoutSessionFilter === null || activityLayoutSessionFilter.has(agent.sessionId));
    const visibleRays = activityState.rays.filter(ray => activityLayoutSessionFilter === null || activityLayoutSessionFilter.has(ray.sessionId));
    const withGroups = withActivityGroups(baseLayout, activityGroupSpecs(visibleEvents, activityClockNow), previousActivityLayout.current);
    return viewMode === 'activity'
      ? withActivityAgentNodes(withGroups, visibleAgents, activityClockNow, visibleRays, previousActivityLayout.current)
      : withGroups;
  }, [activityClockNow, layoutActivityEvents, activityLayoutKey, activityLayoutSessionFilter, activityState.agentNodes, activityState.rays, baseLayout, viewMode]);
  useEffect(() => {
    previousActivityLayout.current = layout;
  }, [layout]);
  const activityRender = useMemo(() => activityRenderState(activityState, activityLayoutSessionFilter), [activityLayoutSessionFilter, activityState]);
  // T1-G: the complement of activitySessionFilter, only populated in dim-others
  // mode -- the sessions the user did *not* select, which GraphCanvas renders at
  // reduced opacity instead of the layout omitting them outright. ActivityPanel's
  // checkboxes keep reading/writing activitySessionFilter directly and are
  // unaffected by this mode; only what happens to the non-selected sessions
  // downstream changes.
  const dimmedSessionIds = useMemo<ReadonlySet<string>>(() => {
    if (!activityDimOthers || viewMode !== 'activity') return EMPTY_SESSION_IDS;
    return activityDimmedSessionIds(activitySessionSummaries(activityState, activityClockNow).map(session => session.id), activitySessionFilter);
  }, [activityClockNow, activityDimOthers, activitySessionFilter, activityState, viewMode]);
  // T1-G: centroid of the followed agent's recent ray targets, in world space, for
  // GraphCanvas's camera-easing followTarget prop. Recomputed live (not a one-shot
  // snapshot at click time) so the camera keeps drifting toward wherever the agent
  // is currently pointed, which reads as "following" rather than "jumped once".
  const followTarget = useMemo<[number, number, number] | null>(
    () => followedAgentId && viewMode === 'activity' ? activityFollowTargetCentroid(followedAgentId, activityState.rays, layout) : null,
    [activityState.rays, followedAgentId, layout, viewMode],
  );
  // --- Activity layer post-filters (T1-A) ------------------------------------
  // These run strictly after the layout/activityRender memos above and never
  // change their inputs or dependency arrays; they only decide the subset of
  // groups/pulses/rays/markers that reaches <GraphCanvas>. Holes left by a
  // hidden group are acceptable for v1 (no re-pack).
  const visibleLayout = useMemo(() => {
    if (viewMode !== 'activity') return layout;
    const groups = layout.groups.filter(group => !isActivityGroupHidden(group.activity?.kind, activityLayers));
    return groups.length === layout.groups.length ? layout : { ...layout, groups };
  }, [activityLayers, layout, viewMode]);
  const hiddenActivityGroupIds = useMemo(() => {
    if (viewMode !== 'activity' || (activityLayers.filePlane && activityLayers.toolbox)) return null;
    const hidden = new Set<string>();
    layout.groups.forEach(group => {
      if (isActivityGroupHidden(group.activity?.kind, activityLayers)) hidden.add(group.id);
    });
    return hidden;
  }, [activityLayers, layout.groups, viewMode]);
  const visibleActivityRender = useMemo(() => {
    if (viewMode !== 'activity') return activityRender;
    const pulses = activityLayers.pulses ? activityRender.pulses : [];
    const rays = !activityLayers.rays
      ? []
      : hiddenActivityGroupIds
        ? activityRender.rays.filter(ray => !(ray.target.kind === 'group' && hiddenActivityGroupIds.has(ray.target.id)))
        : activityRender.rays;
    const snippetMarkers = activityLayers.snippetMarkers ? activityRender.snippetMarkers : [];
    const activeNodeIds = new Set<string>();
    const activeGroupIds = new Set<string>();
    pulses.forEach(pulse => {
      if (pulse.target.kind === 'node') activeNodeIds.add(pulse.target.id);
      else activeGroupIds.add(pulse.target.id);
    });
    return { pulses, rays, snippetMarkers, activeNodeIds, activeGroupIds };
  }, [activityLayers.pulses, activityLayers.rays, activityLayers.snippetMarkers, activityRender, hiddenActivityGroupIds, viewMode]);
  const selectedNode = selectedId ? nodes.get(selectedId) ?? null : null;
  const testNamespaceNames = useMemo(() => testNamespacesForGraph(graph), [graph]);
  useEffect(() => {
    if (!selectedNode) return;
    const isVisible = visibleKinds.has(selectedNode.kind)
      && (showExternal || !selectedNode.external)
      && (showTestNamespaces || !isTestNode(selectedNode, testNamespaceNames))
      && (showGlobalNamespace || !isGlobalNode(selectedNode));
    if (isVisible) return;
    const fallback = graph.nodes.find(node => node.kind === 'namespace'
      && visibleKinds.has(node.kind)
      && (showExternal || !node.external)
      && (showTestNamespaces || !isTestNode(node, testNamespaceNames))
      && (showGlobalNamespace || !isGlobalNode(node)))
      ?? graph.nodes.find(node => visibleKinds.has(node.kind)
        && (showExternal || !node.external)
        && (showTestNamespaces || !isTestNode(node, testNamespaceNames))
        && (showGlobalNamespace || !isGlobalNode(node)));
    setSelectedId(fallback?.id ?? null);
    setSelectedGroupId(null);
    setExplanationTarget(null);
  }, [graph.nodes, selectedNode, showExternal, showGlobalNamespace, showTestNamespaces, testNamespaceNames, visibleKinds]);
  const namespaceMetrics = useMemo(() => buildNamespaceMetrics(graph, showExternal), [graph, showExternal]);
  const temporalAnalysis = useMemo(
    () => temporalCouplingFromHistory(timelineCommits, graph.nodes, graph.edges, {
      maxCommitLag: 2,
      maxPairs: 48,
    }),
    [graph.edges, graph.nodes, timelineCommits],
  );
  const matchingIds = useMemo(() => new Set(graph.nodes.filter(node => matches(node, search)).map(node => node.id)), [graph.nodes, search]);
  const searchMatchIds = viewMode === 'architecture' && search.trim() ? matchingIds : null;
  const history = useMemo(() => historyFrames(graph, timelineCommits), [graph, timelineCommits]);
  const heatLevels = useMemo(() => buildHistoryHeat(timelineCommits, historyIndex), [historyIndex, timelineCommits]);
  const activeHistoryFrame = historyIndex >= 0 ? history[historyIndex] ?? null : null;
  const activityActiveHistoryFrame = viewMode === 'activity' ? null : activeHistoryFrame;
  const historyNodeOrders = useMemo(() => history.map(frame => [...frame.changedNodeIds].filter(id => {
    const node = nodes.get(id);
    return node !== undefined && visibleKinds.has(node.kind)
      && (showExternal || !node.external)
      && (showTestNamespaces || !isTestNode(node, testNamespaceNames))
      && (showGlobalNamespace || !isGlobalNode(node));
  })), [history, nodes, showExternal, showGlobalNamespace, showTestNamespaces, testNamespaceNames, visibleKinds]);
  const historyNodeOrder = activeHistoryFrame ? historyNodeOrders[historyIndex] ?? [] : [];
  const displayedHistoryNodeOrder = viewMode === 'activity' ? [] : historyNodeOrder;
  const historyActivityElapsed = historyElapsed;
  const historyActivity = useMemo(() => buildHistoryActivity(historyNodeOrders, historyIndex, historyActivityElapsed, 1, historyIntervalMs), [historyActivityElapsed, historyIndex, historyIntervalMs, historyNodeOrders]);

  const historyStep = activeHistoryFrame ? historyStaggerStepMs(historyNodeOrder.length) : 1;
  const revealedNodeCount = Math.min(historyNodeOrder.length, Math.floor(historyElapsed / historyStep));
  const historyRevealedNodeIds = useMemo(() => new Set(historyNodeOrder.slice(0, revealedNodeCount)), [historyNodeOrder, revealedNodeCount]);
  const displayedHistoryRevealedNodeIds = useMemo(
    () => viewMode === 'activity' ? new Set<string>() : historyRevealedNodeIds,
    [historyRevealedNodeIds, viewMode],
  );
  const historyAddedNodeIds = activeHistoryFrame?.addedNodeIds ?? new Set<string>();
  const displayedHistoryAddedNodeIds = useMemo(
    () => viewMode === 'activity' ? new Set<string>() : historyAddedNodeIds,
    [historyAddedNodeIds, viewMode],
  );
  const displayedHistoryActivity = viewMode === 'activity' ? null : historyActivity;
  const requestRevision = useCallback((repoRoot: string, hash: string) => {
    const key = revisionKey(repoRoot, hash);
    const cached = revisionCache.current.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = revisionRequests.current.get(key);
    if (pending) return pending;
    let request: Promise<CodeGraph>;
    request = loadRevision(repoRoot, hash).then(
      snapshot => {
        revisionCache.current.set(key, snapshot);
        if (revisionRequests.current.get(key) === request) revisionRequests.current.delete(key);
        return snapshot;
      },
      reason => {
        if (revisionRequests.current.get(key) === request) revisionRequests.current.delete(key);
        throw reason;
      },
    );
    revisionRequests.current.set(key, request);
    return request;
  }, []);

  const importGraph = useCallback((value: unknown, options: { commits?: HistoryCommit[]; index?: number; playing?: boolean } = {}) => {
    try {
      const nextGraph = normalizeGraph(value);
      const loadedCommit = nextGraph.history?.commits[0];
      const sourceCommits = options.commits ?? nextGraph.history?.commits ?? [];
      const commits = loadedCommit
        ? sourceCommits.map(commit => commit.hash === loadedCommit.hash ? { ...commit, ...loadedCommit } : commit)
        : sourceCommits;
      const hasHistory = commits.length > 0;
      setGraph(nextGraph);
      setTimelineCommits(commits);
      const retainedSelection = selectedIdRef.current && nextGraph.nodes.some(node => node.id === selectedIdRef.current) ? selectedIdRef.current : null;
      setSelectedId(retainedSelection ?? nextGraph.nodes.find(node => node.kind === 'namespace')?.id ?? nextGraph.nodes[0]?.id ?? null);
      setSelectedGroupId(null);
      setFocusedIds(null);
      setHistoryIndex(options.index ?? (hasHistory ? 0 : -1));
      setHistoryPlaying(options.playing ?? false);
      setHistoryElapsed(0);
      setHistoryEpoch(current => current + 1);
      setError(null);
      setRevisionMetadata(nextGraph.revision ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to read that graph.');
    }
  }, []);

  const loadLiveRepository = useCallback(async () => {
    parserAnalysisRequest.current += 1;
    parserRequestController.current?.abort();
    setRepositoryLoading(true);
    setError(null);
    historyRequest.current += 1;
    revisionCache.current.clear();
    revisionRequests.current.clear();
    try {
      const info = await loadRepository(repositoryPath);
      const snapshot = await requestRevision(info.root, info.head);
      setRepository(info);
      setRepositoryPath(info.root);
      setArchitectureContextRequested(true);
      importGraph(snapshot, { commits: info.commits, index: info.commitCount - 1, playing: false });
      setActiveLanguage('clojure');
      setActiveSource(info.root);
      setAnalysisStatus('live');
      setHistorySource('clojure');
      setRevisionMetadata(null);
      setHistoryError(null);
      setParserDiagnostics([]);
    } catch (reason) {
      setError(errorMessage(reason, 'Unable to load that repository.'));
    } finally {
      setRepositoryLoading(false);
    }
  }, [importGraph, repositoryPath, requestRevision]);

  const analyzeStaticRepository = useCallback(async () => {
   const requestId = parserAnalysisRequest.current + 1;
   parserAnalysisRequest.current = requestId;
   parserRequestController.current?.abort();
   const controller = new AbortController();
   parserRequestController.current = controller;
   setParserAnalysisLoading(true);
   setParserCapabilitiesLoading(true);
   setError(null);
   setHistoryError(null);
   setParserDiagnostics([]);
   try {
     const capabilities = await loadParserCapabilities(repositoryPath, controller.signal);
     setParserCapabilities(capabilities);
     setParserCapabilitiesLoading(false);
     // An empty repositoryPath means "use the server's --repo-root default";
     // /api/parser/analyze has no such fallback of its own (unlike
     // /api/parser/capabilities and /api/repository), so resolve it from the
     // capabilities response, which always reports the directory it resolved.
     const resolvedRepositoryPath = repositoryPath.trim()
       || (typeof capabilities.path === 'string' && capabilities.path.trim() ? capabilities.path : repositoryPath);
     const detection = capabilities.repository;
     const selectedAdapter = analysisMode === 'auto' ? detection?.selected ?? null : analysisMode;
     if (analysisMode === 'auto' && detection?.ambiguous) {
       throw new ParserApiError('AMBIGUOUS_REPOSITORY', detection.reason ?? 'Auto-detection found multiple language candidates.', detection);
     }
     if (analysisMode === 'auto' && !selectedAdapter) {
       throw new ParserApiError('NO_ADAPTER', detection?.reason ?? 'No supported parser language was detected.', detection);
     }
     const adapter = capabilities.adapters?.find(candidate => candidate.name === selectedAdapter);
     if (adapter?.available === false || adapter?.adapterAvailable === false || adapter?.runtimeAvailable === false || adapter?.missingRuntime === true) {
       throw new ParserApiError(
         'RUNTIME_UNAVAILABLE',
         adapter.message ?? `The ${adapter.displayName ?? adapter.name} parser runtime is unavailable.`,
         { adapter: adapter.name, runtime: adapter.runtime, reason: adapter.reason },
       );
     }
     const language = analysisMode === 'auto' ? 'auto' : analysisMode as Exclude<RepositoryAnalysisMode, 'clojure' | 'auto'>;
     let timeline: RepositoryInfo | null = null;
     try {
       timeline = await loadRepository(resolvedRepositoryPath, { signal: controller.signal });
     } catch {
       // Parser analysis also supports working trees outside Git.
     }
     const selectedLanguage = parserLanguage(selectedAdapter) ?? parserLanguage(language);
     if (!selectedLanguage) {
       throw new ParserApiError('NO_ADAPTER', 'No supported parser language was selected.');
     }
     const result = await analyzeParser(resolvedRepositoryPath, language, {
       commit: timeline?.head,
       signal: controller.signal,
     });
     if (parserAnalysisRequest.current !== requestId) return;
     const nextGraph = graphFromParserResult(result);
     setRepository(timeline);
     // Only overwrite what's in the path field when it was empty (i.e. we
     // just resolved the server default); an explicitly typed path is left
     // exactly as the user entered it, matching today's behavior.
     if (!repositoryPath.trim()) setRepositoryPath(resolvedRepositoryPath);
     setArchitectureContextRequested(true);
     historyRequest.current += 1;
     revisionCache.current.clear();
     revisionRequests.current.clear();
     parserRevisionRequests.current.clear();
     importGraph(nextGraph, {
       commits: timeline?.commits ?? [],
       index: timeline ? timeline.commitCount - 1 : -1,
       playing: false,
     });
     setHistorySource(timeline ? 'parser' : null);
     setRevisionMetadata(nextGraph.revision ?? result.revision ?? null);
     setHistoryError(null);
     setActiveLanguage(result.language ?? selectedLanguage);
     setActiveSource(timeline?.root ?? resolvedRepositoryPath);
     setAnalysisStatus(`${parserStatus(result, result.graph)}${timeline ? '' : ' · working tree (no Git history)'}`);
     setParserDiagnostics(result.diagnostics ?? []);
   } catch (reason) {
     if (parserAnalysisRequest.current === requestId) {
       setError(errorMessage(reason, 'Unable to analyze that repository.'));
     }
   } finally {
     if (parserAnalysisRequest.current === requestId) {
       if (parserRequestController.current === controller) parserRequestController.current = null;
       setParserCapabilitiesLoading(false);
       setParserAnalysisLoading(false);
     }
   }
  }, [analysisMode, importGraph, repositoryPath]);

  const analyzeRepository = useCallback(() => {
   if (analysisMode === 'clojure') {
     void loadLiveRepository();
   } else {
     void analyzeStaticRepository();
   }
  }, [analysisMode, analyzeStaticRepository, loadLiveRepository]);

  const loadActivityProject = useCallback(async (event: ActivityEvent) => {
   const projectPath = activityWorkspacePath(event);
   const projectKey = activityProjectKey(event);
   if (!projectPath || !projectKey || viewModeRef.current !== 'activity') return;
   if (activityProjectKeyRef.current === projectKey || graph.nodes.length > 0) return;
   activityProjectKeyRef.current = projectKey;
   const requestId = activityProjectRequest.current + 1;
   activityProjectRequest.current = requestId;
   activityProjectController.current?.abort();
   const controller = new AbortController();
   activityProjectController.current = controller;
   setRepositoryLoading(true);
   setError(null);
   setHistoryError(null);
   setParserDiagnostics([]);
   setActiveSource(projectPath);
   setRepositoryPath(projectPath);
   setAnalysisStatus('loading activity project');
   const current = () => activityProjectRequest.current === requestId
     && !controller.signal.aborted
     && viewModeRef.current === 'activity';
   try {
     let capabilities: ParserCapabilities | null = null;
     try {
       capabilities = await loadParserCapabilities(projectPath, controller.signal);
     } catch (reason) {
       if (controller.signal.aborted) throw reason;
     }
     if (!current()) return;
     setParserCapabilities(capabilities);
     const selected = parserLanguage(capabilities?.repository?.selected ?? null);
     const adapter = selected && capabilities?.adapters?.find(candidate => candidate.name === selected);
     if (selected && adapter && (adapter.available === false || adapter.adapterAvailable === false || adapter.runtimeAvailable === false || adapter.missingRuntime === true)) {
       throw new ParserApiError(
         'RUNTIME_UNAVAILABLE',
         adapter.message ?? `The ${adapter.displayName ?? adapter.name} parser runtime is unavailable.`,
         { adapter: adapter.name, runtime: adapter.runtime, reason: adapter.reason },
       );
     }
     if (selected) {
       const result = await analyzeParser(projectPath, selected, { signal: controller.signal });
       if (!current()) return;
       const nextGraph = graphFromParserResult(result);
       importGraph(nextGraph);
       setRepositoryPath(projectPath);
       setActiveLanguage(result.language ?? selected);
       setActiveSource(projectPath);
       setAnalysisStatus(`${parserStatus(result, result.graph)} · activity project`);
       setParserDiagnostics(result.diagnostics ?? []);
       return;
     }
     const info = await loadRepository(projectPath, { signal: controller.signal });
     const snapshot = await loadRevision(info.root, info.head, { signal: controller.signal });
     if (!current()) return;
     setRepository(info);
     setRepositoryPath(info.root);
     importGraph(snapshot, { commits: info.commits, index: info.commitCount - 1, playing: false });
     setActiveLanguage('clojure');
     setActiveSource(info.root);
     setAnalysisStatus('live · activity project');
     setHistorySource('clojure');
     setRevisionMetadata(null);
     setHistoryError(null);
   } catch (reason) {
     if (current()) setError(errorMessage(reason, 'Unable to load the activity project.'));
   } finally {
     if (activityProjectRequest.current === requestId) {
       if (activityProjectController.current === controller) activityProjectController.current = null;
       setRepositoryLoading(false);
     }
   }
  }, [graph.nodes.length, importGraph]);

  const activityProjectEvent = useMemo(
   () => [...liveActivityState.events].reverse().find(event => isAgentActivityEvent(event) && activityProjectKey(event)),
   [liveActivityState.events],
  );
  useEffect(() => {
   if (viewMode !== 'activity') return;
   if (activityProjectEvent) void loadActivityProject(activityProjectEvent);
  }, [activityProjectEvent, loadActivityProject, viewMode]);
  useEffect(() => {
   if (viewMode === 'activity') return;
   activityProjectRequest.current += 1;
   activityProjectController.current?.abort();
   activityProjectController.current = null;
   activityProjectKeyRef.current = null;
  }, [viewMode]);

  const requestParserRevision = useCallback((repoRoot: string, language: ParserLanguage, hash: string, previousCommit?: string, signal?: AbortSignal) => {
    const key = `${repoRoot}\u0000${hash}\u0000${previousCommit ?? ''}`;
    const cached = revisionCache.current.get(revisionKey(repoRoot, hash));
    if (cached && !previousCommit) return Promise.resolve(cached);
    const pending = parserRevisionRequests.current.get(key);
    if (pending) return pending;
    const request = analyzeParser(repoRoot, language, { commit: hash, previousCommit, signal })
      .then(result => {
        const snapshot = graphFromParserResult(result);
        revisionCache.current.set(revisionKey(repoRoot, hash), snapshot);
        if (parserRevisionRequests.current.get(key) === request) parserRevisionRequests.current.delete(key);
        return snapshot;
      }, reason => {
        if (parserRevisionRequests.current.get(key) === request) parserRevisionRequests.current.delete(key);
        throw reason;
      });
    parserRevisionRequests.current.set(key, request);
    return request;
  }, []);

  const selectHistoryCommit = useCallback((index: number, shouldPlay = false) => {
    const frame = history[index];
    if (!frame) return;
    const displayedHash = graph.history?.commits[0]?.hash ?? revisionMetadata?.commit ?? null;
    const displayedIndex = displayedHash ? timelineCommits.findIndex(commit => commit.hash === displayedHash) : -1;
    const previousIndex = displayedIndex >= 0 ? displayedIndex : historyIndex;
    lastHistoryTarget.current = { index, playing: shouldPlay };
    setHistoryIndex(index);
    setHistoryPlaying(shouldPlay);
    setHistoryEpoch(current => current + 1);
    setHistoryError(null);
    if (!repository || displayedHash === frame.commit.hash) return;

    const request = historyRequest.current + 1;
    historyRequest.current = request;
    const commits = timelineCommits.length > 0 ? timelineCommits : repository.commits;
    const previousCommit = historySource === 'parser' && previousIndex >= 0 && Math.abs(index - previousIndex) === 1
      ? displayedHash ?? commits[previousIndex]?.hash
      : undefined;
    if (historySource === 'parser') {
      const language = parserLanguage(activeLanguage) ?? parserLanguage(analysisMode);
      if (!language) {
        setHistoryPlaying(false);
        setHistoryIndex(previousIndex);
        setError('Unable to determine the active parser language for that revision.');
        return;
      }
      parserRequestController.current?.abort();
      const controller = new AbortController();
      parserRequestController.current = controller;
      setRepositoryLoading(true);
      setError(null);
      requestParserRevision(repository.root, language, frame.commit.hash, previousCommit, controller.signal)
        .then(snapshot => {
          if (historyRequest.current !== request) return;
          importGraph(snapshot, { commits, index, playing: shouldPlay });
        })
        .catch(reason => {
          if (historyRequest.current !== request) return;
          setHistoryIndex(previousIndex);
          setHistoryPlaying(false);
          const message = errorMessage(reason, 'Unable to render that parser revision.');
          setHistoryError(message);
          setError(message);
        })
        .finally(() => {
          if (historyRequest.current === request) setRepositoryLoading(false);
          if (parserRequestController.current === controller) parserRequestController.current = null;
        });
      return;
    }
    const cachedSnapshot = revisionCache.current.get(revisionKey(repository.root, frame.commit.hash));
    if (cachedSnapshot) {
      setRepositoryLoading(false);
      importGraph(cachedSnapshot, { commits, index, playing: shouldPlay });
      return;
    }
    setRepositoryLoading(true);
    requestRevision(repository.root, frame.commit.hash)
      .then(snapshot => {
        if (historyRequest.current !== request) return;
        importGraph(snapshot, { commits, index, playing: shouldPlay });
      })
      .catch(reason => {
        if (historyRequest.current !== request) return;
        setHistoryPlaying(false);
        setError(reason instanceof Error ? reason.message : 'Unable to render that commit.');
      })
      .finally(() => {
        if (historyRequest.current === request) setRepositoryLoading(false);
      });
  }, [activeLanguage, analysisMode, graph.history, history, historyIndex, historySource, importGraph, repository, requestParserRevision, requestRevision, revisionMetadata, timelineCommits]);

  useEffect(() => {
    if (!historyPlaying || historyIndex < 0 || !activeHistoryFrame) return;
    setHistoryElapsed(0);
    const startedAt = performance.now();
    let timer = 0;
    const tick = () => {
      setHistoryElapsed(performance.now() - startedAt);
      timer = window.setTimeout(tick, 50);
    };
    timer = window.setTimeout(tick, 50);
    return () => window.clearTimeout(timer);
  }, [historyEpoch, historyIndex, historyPlaying]);

  useEffect(() => {
    if (viewMode === 'activity') setHistoryPlaying(false);
  }, [viewMode]);
  useEffect(() => {
    if (viewMode !== 'activity') return;
    setActivityNow(Date.now());
    const timer = window.setInterval(() => setActivityNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [viewMode]);

  useEffect(() => {
    if (!historyPlaying || !activeHistoryFrame || repositoryLoading) return;
    const duration = Math.max(historyDurationMs(historyNodeOrder.length), historyIntervalMs);
    const timer = window.setTimeout(() => {
      if (historyIndex >= history.length - 1) {
        setHistoryPlaying(false);
        return;
      }
      selectHistoryCommit(historyIndex + 1, true);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [activeHistoryFrame, history, historyIndex, historyIntervalMs, historyNodeOrder.length, historyPlaying, repositoryLoading, selectHistoryCommit]);

  useEffect(() => {
    if (historySource !== 'clojure' || !repository || repositoryLoading || historyIndex < 0 || !activeHistoryFrame) return;
    if (graph.history?.commits[0]?.hash !== activeHistoryFrame.commit.hash) return;
    const nextIndices = [historyIndex + 1, historyIndex + 2].filter(index => index < history.length);
    let cancelled = false;
    const prefetch = async () => {
      for (const index of nextIndices) {
        if (cancelled) return;
        const commit = history[index]?.commit;
        if (!commit) continue;
        try {
          await requestRevision(repository.root, commit.hash);
        } catch (reason) {
          if (!cancelled) console.warn('Codewalk could not prefetch commit', commit.shortHash, reason);
          return;
        }
      }
    };
    void prefetch();
    return () => { cancelled = true; };
  }, [activeHistoryFrame, graph.history, history, historyIndex, historySource, repository, repositoryLoading, requestRevision]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '/' && viewModeRef.current === 'architecture' && document.activeElement?.tagName !== 'INPUT') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('.search-box input')?.focus();
      }
      if (event.key === 'Escape') {
        setSearch('');
        setFocusedIds(null);
        // T1-G: Escape also clears a number-key solo and an agent follow, same as
        // clicking empty canvas would -- unconditionally, matching the search/focus
        // clears just above, since Escape is also how a user blurs out of the
        // repository path field below.
        setActivitySessionFilter(null);
        setFollowedAgentId(null);
        (document.activeElement as HTMLElement | null)?.blur();
      }
      // T1-G: 1-9 solos the Nth session in ActivityPanel's own order, 0 clears it.
      // Guarded on activity mode and on focus not being in a text input -- the
      // repository path field is a text input a repo path could easily contain a
      // digit in, so a bare textInputActive-style check (not just the '/' handler's
      // narrower INPUT-tag check above) is required here.
      if (viewModeRef.current === 'activity' && !event.metaKey && !event.ctrlKey && !event.altKey
        && !activityTextInputFocused() && /^[0-9]$/.test(event.key)) {
        if (event.key === '0') {
          setActivitySessionFilter(null);
        } else {
          const sessionId = activitySessionOrderRef.current[Number(event.key) - 1];
          if (sessionId) {
            setActivitySessionFilter(current => activitySessionSoloFilter(current, sessionId));
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // T1-G click-agent-to-follow: wired here so it activates the moment GraphCanvas
  // reports an agent id through onSelect, exactly like it already does for a
  // node/group click -- an id activityState.agentNodes recognizes is an agent, not
  // a graph node, so this toggles follow instead of the normal node-selection
  // behaviour below. Any other click -- including empty space, which arrives here
  // as '' from GraphCanvas's onPointerMissed -- releases a follow in progress and
  // falls through to normal selection.
  //
  // KNOWN GAP, reported rather than patched around: as of this change,
  // ActivityAgentGlyph in src/components/GraphCanvas.tsx has no pointer/click
  // handler at all and nothing in that file calls onSelect (or any callback) with
  // an agent id, so in the running app this branch is not reachable yet -- clicking
  // an agent glyph today does nothing. Fixing that means adding an onClick to
  // ActivityAgentGlyph's <group>, which is a GraphCanvas.tsx change outside this
  // brief's file grant ("stop and report rather than editing it"). This is the
  // App-side half of the feature, ready to light up once that lands.
  const selectNode = useCallback((id: string) => {
    if (viewMode === 'activity' && id && activityState.agentNodes.has(id)) {
      setFollowedAgentId(current => current === id ? null : id);
      return;
    }
    setFollowedAgentId(null);
    setSelectedGroupId(null);
    setSelectedId(id || null);
    setExplanationTarget(null);
  }, [activityState.agentNodes, viewMode]);
  const selectNamespace = useCallback((namespace: string) => {
    const node = graph.nodes.find(candidate => candidate.kind === 'namespace'
      && (candidate.namespace === namespace || candidate.label === namespace));
    if (node) selectNode(node.id);
  }, [graph.nodes, selectNode]);
  const explainConnection = useCallback((namespace: string) => {
    setAnalysisView('dossier');
    setExplanationTarget(namespace);
  }, []);
  const selectGroup = useCallback((id: string) => {
    const group = layout.groups.find(candidate => candidate.id === id);
    setSelectedGroupId(id);
    setSelectedId(group?.namespaceNodeId ?? null);
    setFocusedIds(null);
  }, [layout.groups]);
  const focusNode = useCallback((id: string) => {
    setSelectedGroupId(null);
    setSelectedId(id);
    setFocusedIds(neighborIds(graph, id));
  }, [graph]);
  const visibleKindsToggle = useCallback((kind: CodeNode['kind']) => setVisibleKinds(current => {
    const next = new Set(current);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    (viewMode === 'activity' ? liveVisibleKinds : architectureVisibleKinds).current = new Set(next);
    return next;
  }), [viewMode]);
  const changeViewMode = useCallback((nextMode: ActivityMode) => {
    if (nextMode === viewMode) return;
    (viewMode === 'activity' ? liveVisibleKinds : architectureVisibleKinds).current = new Set(visibleKinds);
    setVisibleKinds(new Set((nextMode === 'activity' ? liveVisibleKinds : architectureVisibleKinds).current));
    setActivitySessionFilter(null);
    // T1-G: solo/follow are activity-mode concepts (see their declarations above);
    // activitySessionFilter above already covers solo, this covers follow.
    setFollowedAgentId(null);
    if (nextMode === 'architecture') setArchitectureContextRequested(true);
    setViewMode(nextMode);
  }, [viewMode, visibleKinds]);
  const edgeToggle = useCallback((kind: CodeEdge['kind']) => setEdgeVisibility(current => ({ ...current, [kind]: !current[kind] })), []);
  const activityLayerToggle = useCallback((key: keyof ActivityLayerToggles) => setActivityLayers(current => ({ ...current, [key]: !current[key] })), []);
  const activityPausedToggle = useCallback(() => setActivityPaused(current => !current), []);
  const activityDimOthersToggle = useCallback(() => setActivityDimOthers(current => !current), []);
  const visibilityModeChange = useCallback((kind: keyof NodeVisibilityModes, mode: NodeVisibilityMode) => setVisibilityModes(current => ({ ...current, [kind]: mode })), []);
  const relationshipVisibilityModeChange = useCallback((mode: NodeVisibilityMode) => setRelationshipVisibilityMode(mode), []);
  const toggleHistory = useCallback(() => {
    if (history.length === 0) return;
    if (historyIndex < 0) {
      selectHistoryCommit(0, true);
      return;
    }
    setHistoryPlaying(current => !current);
  }, [history, historyIndex, selectHistoryCommit]);
  const stepHistory = useCallback((direction: number) => {
    if (history.length === 0) return;
    const base = historyIndex < 0 ? (direction > 0 ? -1 : 0) : historyIndex;
    const nextIndex = (base + direction + history.length) % history.length;
    selectHistoryCommit(nextIndex);
  }, [history, historyIndex, selectHistoryCommit]);
  const readFile = useCallback((file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setRepository(null);
        setArchitectureContextRequested(true);
        setHistorySource(null);
        setRevisionMetadata(null);
        importGraph(JSON.parse(String(reader.result)));
        setActiveLanguage('graph import');
        setActiveSource(file.name);
        setAnalysisStatus('imported');
      } catch {
        setError('That file is not valid JSON.');
      }
    };
    reader.onerror = () => setError('The graph file could not be read.');
    reader.readAsText(file);
  }, [importGraph]);
  const historyCommits = useMemo(() => history.map(frame => frame.commit), [history]);
  const previousHistory = useCallback(() => stepHistory(-1), [stepHistory]);
  const nextHistory = useCallback(() => stepHistory(1), [stepHistory]);
  const jumpBackHistory = useCallback((amount: number) => {
    if (history.length === 0) return;
    const base = historyIndex < 0 ? 0 : historyIndex;
    selectHistoryCommit(Math.max(0, base - amount));
  }, [history.length, historyIndex, selectHistoryCommit]);
  const retryHistory = useCallback(() => {
    const target = lastHistoryTarget.current;
    if (target) selectHistoryCommit(target.index, target.playing);
  }, [selectHistoryCommit]);
  const historyExplanation = activeLanguage && activeLanguage !== 'clojure' && activeLanguage !== 'graph import' && historySource !== 'parser'
    ? 'This working-tree graph has no Git timeline. Revision playback is unavailable until the repository has Git commits.'
    : null;
  const clearFocus = useCallback(() => setFocusedIds(null), []);
  const openImport = useCallback(() => fileInput.current?.click(), []);
  const resetView = useCallback(() => setResetSignal(value => value + 1), []);
  const inspectorFocus = useCallback(() => { if (selectedId) focusNode(selectedId); }, [focusNode, selectedId]);

  return (
    <main className="app-shell">
      <ControlPanel
        viewMode={viewMode}
        onViewMode={changeViewMode}
        activityConnection={liveActivityState.connection}
        repositoryPath={repositoryPath}
        repository={repository}
        repositoryLoading={repositoryLoading}
        onRepositoryPath={setRepositoryPath}
        onLoadRepository={analyzeRepository}
        analysisMode={analysisMode}
        onAnalysisMode={mode => {
          setAnalysisMode(mode);
          setError(null);
          if (mode === 'clojure') {
            setParserCapabilities(null);
            setParserDiagnostics([]);
          }
        }}
        parserCapabilities={parserCapabilities}
        parserCapabilitiesLoading={parserCapabilitiesLoading}
        parserAnalysisLoading={parserAnalysisLoading}
        parserDiagnostics={parserDiagnostics}
        activeLanguage={activeLanguage}
        activeSource={activeSource}
        analysisStatus={analysisStatus}
        historySource={historySource}
        revision={revisionMetadata}
        search={search}
        onSearch={setSearch}
        visibleKinds={visibleKinds}
        onToggleKind={visibleKindsToggle}
        visibilityModes={visibilityModes}
        onVisibilityMode={visibilityModeChange}
        showExternal={showExternal}
        onShowExternal={setShowExternal}
        showTestNamespaces={showTestNamespaces}
        onShowTestNamespaces={setShowTestNamespaces}
        showGlobalNamespace={showGlobalNamespace}
        onShowGlobalNamespace={setShowGlobalNamespace}
        orbitGlobalNamespace={orbitGlobalNamespace}
        onOrbitGlobalNamespace={setOrbitGlobalNamespace}
        showTopLevelFolderConnections={showTopLevelFolderConnections}
        onShowTopLevelFolderConnections={setShowTopLevelFolderConnections}
        edgeVisibility={edgeVisibility}
        onToggleEdge={edgeToggle}
        relationshipVisibilityMode={relationshipVisibilityMode}
        onRelationshipVisibilityMode={relationshipVisibilityModeChange}
        showLabels={showLabels}
        onShowLabels={setShowLabels}
        showHierarchy={showHierarchy}
        onShowHierarchy={setShowHierarchy}
        hierarchyLeavesOnly={hierarchyLeavesOnly}
        onHierarchyLeavesOnly={setHierarchyLeavesOnly}
        heatEnabled={heatEnabled}
        onHeatEnabled={setHeatEnabled}
        fullOpacity={fullOpacity}
        onFullOpacity={setFullOpacity}
        connectionMode={connectionMode}
        onConnectionMode={setConnectionMode}
        analysisView={analysisView}
        onAnalysisView={setAnalysisView}
        physicsEnabled={physicsEnabled}
        onPhysicsEnabled={setPhysicsEnabled}
        nodeScale={nodeScale}
        onNodeScale={setNodeScale}
        onImport={openImport}
        onReset={resetView}
        activityLayers={activityLayers}
        onToggleActivityLayer={activityLayerToggle}
        activityPaused={activityPaused}
        onToggleActivityPaused={activityPausedToggle}
        onClearActivity={liveActivityState.clear}
        activityDimOthers={activityDimOthers}
        onToggleActivityDimOthers={activityDimOthersToggle}
        showInactiveAgents={showInactiveAgents}
        onShowInactiveAgents={setShowInactiveAgents}
      />
      <input ref={fileInput} className="hidden-input" type="file" accept="application/json,.json" onChange={event => readFile(event.target.files?.[0])} />
      <section className="stage">
        <div className="stage-header">
          <div>
            <span className="eyebrow">{viewMode === 'activity' ? replayActive ? 'Replay activity / ' : 'Live activity / ' : 'Repository / '}{graph.repo.name}</span>
            <h2>{viewMode === 'activity' ? replayActive ? 'Recorded activity constellation' : 'Agent activity constellation' : 'Codebase constellation'}</h2>
            <span className="stage-source">{viewMode === 'activity' ? replayActive ? 'Recorded metadata replay · live SSE remains separate' : 'Static graph context · explicitly reported telemetry only' : `${activeLanguage ?? 'unknown'} / ${activeSource ?? graph.repo.root}${historyExplanation ? ` · ${historyExplanation}` : historySource === 'parser' ? ' · Git revisions analyzed on demand' : ''}`}</span>
          </div>
          <div className="stats">{[['namespaces', graph.stats.namespaces], ['vars', graph.stats.vars], ['edges', graph.stats.edges]].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
        </div>
        <div className="canvas-wrap">
          <GraphCanvas
            graph={graph}
            positions={layout.positions}
            groups={visibleLayout.groups}
            showArchitectureContext={activityArchitectureContextVisible(viewMode, architectureContextRequested)}
            activityAgents={layout.activityAgents ?? []}
            activityInactiveAgents={layout.activityInactiveAgents ?? []}
            showInactiveAgents={showInactiveAgents}
            showHierarchy={showHierarchy}
            hierarchyLeavesOnly={hierarchyLeavesOnly}
            heatEnabled={heatEnabled}
            heatLevels={heatLevels}
            fullOpacity={fullOpacity}
            connectionMode={connectionMode}
            namespaceMetrics={namespaceMetrics}
            physicsEnabled={physicsEnabled}
            continuousRendering={historyPlaying || physicsEnabled || viewMode === 'activity' && (
              layout.activityAgents !== undefined
              || showInactiveAgents && layout.activityInactiveAgents !== undefined
              || visibleActivityRender.pulses.length > 0
              || visibleActivityRender.rays.length > 0
              || visibleActivityRender.snippetMarkers.length > 0
            )}
            selectedId={selectedId}
            selectedGroupId={selectedGroupId}
            focusedIds={focusedIds}
            searchMatchIds={searchMatchIds}
            visibleKinds={visibleKinds}
            visibilityModes={visibilityModes}
            relationshipVisibilityMode={relationshipVisibilityMode}
            showExternal={showExternal}
            showTestNamespaces={showTestNamespaces}
            showGlobalNamespace={showGlobalNamespace}
            orbitGlobalNamespace={orbitGlobalNamespace}
            showTopLevelFolderConnections={showTopLevelFolderConnections}
            edgeVisibility={edgeVisibility}
            showLabels={showLabels}
            nodeScale={nodeScale}
            historyNodeOrder={displayedHistoryNodeOrder}
            historyElapsed={historyElapsed}
            historyStepMs={historyStep}
            resetSignal={resetSignal}
            activeHistoryFrame={activityActiveHistoryFrame}
            historyRevealedNodeIds={displayedHistoryRevealedNodeIds}
            historyAddedNodeIds={displayedHistoryAddedNodeIds}
            historyActivity={displayedHistoryActivity}
            activityMode={viewMode === 'activity'}
            activityPulses={visibleActivityRender.pulses}
            activityRays={visibleActivityRender.rays}
            activitySnippetMarkers={visibleActivityRender.snippetMarkers}
            activeActivityNodeIds={visibleActivityRender.activeNodeIds}
            activeActivityGroupIds={visibleActivityRender.activeGroupIds}
            followTarget={followTarget}
            dimmedSessionIds={dimmedSessionIds}
            onSelect={selectNode}
            onSelectGroup={selectGroup}
            onFocus={focusNode}
          />
          {viewMode === 'architecture' && search && <div className="search-result"><strong>{matchingIds.size}</strong> matches for <code>{search}</code></div>}
          {focusedIds && <button className="clear-focus" onClick={clearFocus}>Clear focus</button>}
          {viewMode === 'architecture' && <HistoryControls loading={repositoryLoading && repository !== null} liveMode={repository !== null} loadedCommitHash={graph.history?.commits[0]?.hash ?? null} commits={historyCommits} index={historyIndex} playing={historyPlaying} intervalMs={historyIntervalMs} revision={revisionMetadata} historyExplanation={historyExplanation} error={historySource === 'parser' ? historyError : null} onRetry={retryHistory} onTogglePlaying={toggleHistory} onPrevious={previousHistory} onNext={nextHistory} onJumpBack={jumpBackHistory} onIndex={selectHistoryCommit} onInterval={setHistoryIntervalMs} />}
        </div>
      </section>
      {viewMode === 'activity'
        ? <aside className="detail-panel"><ActivityPanel state={activityState} liveState={liveActivityState} sessionFilter={activitySessionFilter} onSessionFilterChange={setActivitySessionFilter} replay={activityReplay} />{error && <div className="error-box" role="alert">{error}</div>}<footer>{replayActive ? 'Replay mode · live activity remains connected' : 'Activity mode · graph layout and history remain unchanged'}</footer></aside>
        : <DetailPanel graph={graph} selectedNode={selectedNode} error={error} namespaceMetrics={namespaceMetrics} temporalAnalysis={temporalAnalysis} analysisView={analysisView} explanationTarget={explanationTarget} onFocus={inspectorFocus} onSelectNode={selectNode} onSelectNamespace={selectNamespace} onExplainConnection={explainConnection} />}
    </main>
  );
}
