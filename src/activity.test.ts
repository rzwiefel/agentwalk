import { activityStreamUrl, allWorkspacesActivityStreamUrl } from './activity/api';
import { connectActivityStream } from './activity/api';
import { activityAgentColor, activityAgentIdentity, activityAgentLabel, activityGroupId, activitySnippet, activitySummary, activityType, parseActivityEvent } from './activity/contract';
import { buildActivityGraphIndexes, resolveActivityTarget, resolveActivityTargets } from './activity/graphResolver';
import { activityEventMatchesWorkspace } from './activity/hooks';
import { activityEventIdentity, activityReducer, activityRenderState, ACTIVITY_PULSE_COLORS, ACTIVITY_RAY_TTL_MS, ACTIVITY_SNIPPET_MARKER_HOLD_MS, ACTIVITY_SNIPPET_MARKER_TTL_MS, ACTIVITY_TARGET_BASELINE_OPACITY, ACTIVITY_TARGET_FADE_MS, ACTIVITY_TARGET_HOLD_MS, ACTIVITY_TARGET_TTL_MS, initialActivityState, MAX_ACTIVITY_EVENTS, MAX_ACTIVITY_PULSES, MAX_ACTIVITY_RAYS, MAX_ACTIVITY_SNIPPET_MARKERS, MAX_ACTIVITY_SNIPPET_MARKERS_PER_GROUP } from './activity/reducer';
import { ACTIVE_TELEMETRY_LIMIT, ACTIVITY_PAGE_SIZE, recentActiveTelemetry, recentActivityEvents } from './components/ActivityPanel';
import { ACTIVITY_AGENT_DEFAULT_FACING, ACTIVITY_SNIPPET_MARKER_MAX_SCALE, ACTIVITY_SNIPPET_MARKER_SCALE_FADE_MS, ACTIVITY_SNIPPET_MARKER_SCALE_HOLD_MS, activityAgentFacingAngle, activityAgentOpacity, activityAgentShortestAngle, activityAgentStatusBaseline, activityGroupOpacity, activityRayDashFlowOffset, activityRayOpacity, activityRayUsesDashPattern, activityRayWorkspaceCompatible, activitySnippetMarkerOpacity, activitySnippetMarkerScale, activityTargetOpacity } from './components/GraphCanvas';
import { ARCHITECTURE_DEFAULT_VISIBLE_KINDS, DEFAULT_EDGE_VISIBILITY, EMPTY_GRAPH, activityProjectKey, activityWorkspacePath, graphFromParserResult, isAgentActivityEvent, LIVE_DEFAULT_VISIBLE_KINDS } from './App';
import { activityGroupSpecs, computeLayout, withActivityAgentNodes } from './layout';
import type { ActivityEvent } from './activity/types';
import type { CodeGraph, LayoutGroup } from './types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Activity assertion failed: ${message}`);
}

const base = {
  schemaVersion: 1,
  id: 'event:1',
  sessionId: 'session:1',
  timestamp: '2026-08-26T12:00:00.000Z',
  type: 'file.read',
  resources: [{ file: 'src/app.clj', line: 12 }],
};

const graph: CodeGraph = {
  formatVersion: 1,
  generatedAt: base.timestamp,
  repo: { name: 'fixture', root: '/workspace' },
  nodes: [
    { id: 'namespace:app', kind: 'namespace', label: 'app', namespace: 'app', file: 'src/app.clj', row: 0, endRow: 80 },
    { id: 'var:app/run', kind: 'var', label: 'run', namespace: 'app', file: 'src/app.clj', row: 10, endRow: 15 },
  ],
  edges: [],
  stats: { nodes: 2, edges: 0 },
};

const groups: LayoutGroup[] = [{
  id: 'group:app',
  parentId: null,
  path: 'app',
  label: 'app',
  depth: 0,
  center: [0, 0, 0],
  size: [10, 10, 10],
  actualNamespace: 'app',
  namespaceNodeId: 'namespace:app',
  virtual: false,
  nodeCount: 2,
}];

export function runActivityAssertions(): void {
  expect(EMPTY_GRAPH.nodes.length === 0 && EMPTY_GRAPH.edges.length === 0 && EMPTY_GRAPH.stats.namespaces === 0, 'startup graph is empty until analysis');
  expect(LIVE_DEFAULT_VISIBLE_KINDS.size === 1 && LIVE_DEFAULT_VISIBLE_KINDS.has('namespace')
    && ARCHITECTURE_DEFAULT_VISIBLE_KINDS.size === 3
    && !DEFAULT_EDGE_VISIBILITY.requires, 'live mode starts with namespace/file visibility while architecture keeps all node kinds and requires relationships off');
  expect(graphFromParserResult({ graph }).nodes.length === graph.nodes.length, 'analyzed graph replaces the empty startup graph');
  expect(parseActivityEvent(base)?.schemaVersion === 1, 'contract accepts schema version one');
  expect(parseActivityEvent({ ...base, id: undefined }) === null, 'contract rejects missing identity');
  expect(parseActivityEvent({ ...base, type: 'provider.future.event' })?.type === 'provider.future.event', 'unknown event types are retained');
  const producerSource = parseActivityEvent({ ...base, source: { client: 'copilot-cli', kind: 'hook', version: '1.0.81-12' } });
  expect(typeof producerSource?.source === 'object' && producerSource.source.client === 'copilot-cli', 'structured producer sources are retained');
  const agentStart = parseActivityEvent({ ...base, id: 'agent-start', type: 'subagent.started', agentId: 'opaque-agent-1', status: 'started', metadata: { agentName: 'Reviewer' } }) as ActivityEvent;
  const agentUpdate = parseActivityEvent({ ...base, id: 'agent-update', type: 'tool.started', agentId: 'opaque-agent-1', status: 'running', tool: 'search' }) as ActivityEvent;
  expect(activityAgentIdentity(agentStart) === activityAgentIdentity(agentUpdate), 'agent identity is stable across repeated events');
  expect(activityAgentColor(activityAgentIdentity(agentStart) as string) === activityAgentColor(activityAgentIdentity(agentStart) as string), 'agent colors are deterministic');
  expect(activityAgentIdentity(parseActivityEvent({ ...base, id: 'session-only', type: 'session.start' }) as ActivityEvent) === undefined, 'session telemetry does not invent an agent node');
  const topLevelSessionStart = parseActivityEvent({
   ...base,
   id: 'top-level-session-start',
   type: 'session.start',
   workspace: { id: 'local-9-abcdef12' },
   source: { client: 'copilot-cli', kind: 'jsonl' },
   status: 'started',
  }) as ActivityEvent;
  const topLevelSessionUpdate = parseActivityEvent({
   ...topLevelSessionStart,
   id: 'top-level-session-update',
   type: 'session',
   status: 'idle',
  }) as ActivityEvent;
  expect(activityAgentIdentity(topLevelSessionStart) === activityAgentIdentity(topLevelSessionUpdate), 'attributed top-level session events share one scoped agent identity');
  const syntheticSessionAgent = parseActivityEvent({
    ...topLevelSessionStart,
    id: 'synthetic-session-agent',
    agentId: `session:${topLevelSessionStart.sessionId}`,
  }) as ActivityEvent;
  expect(activityAgentIdentity(syntheticSessionAgent) === activityAgentIdentity(topLevelSessionStart), 'synthetic session agent IDs share the session fallback identity');
  let syntheticSessionState = initialActivityState();
  syntheticSessionState = activityReducer(syntheticSessionState, { type: 'event', event: syntheticSessionAgent, now: 100 });
  syntheticSessionState = activityReducer(syntheticSessionState, { type: 'event', event: parseActivityEvent({
    ...topLevelSessionStart,
    id: 'session-file-activity',
    type: 'file.read',
    agentId: undefined,
  }) as ActivityEvent, now: 200 });
  expect(syntheticSessionState.agentNodes.size === 1 && syntheticSessionState.activeAgents.size === 1, 'synthetic and un-attributed session events produce one agent glyph and active agent');
  let topLevelState = initialActivityState();
  topLevelState = activityReducer(topLevelState, { type: 'event', event: topLevelSessionStart, now: 100 });
  topLevelState = activityReducer(topLevelState, { type: 'event', event: topLevelSessionUpdate, now: 200 });
  topLevelState = activityReducer(topLevelState, { type: 'event', event: parseActivityEvent({ ...base, id: 'unrelated-file', workspace: { id: 'local-9-abcdef12' } }) as ActivityEvent, now: 300 });
  expect(topLevelState.agentNodes.size === 1
   && topLevelState.agentNodes.get(activityAgentIdentity(topLevelSessionStart) as string)?.label.startsWith('Session ·') === true
   && topLevelState.agentNodes.get(activityAgentIdentity(topLevelSessionStart) as string)?.status === 'active', 'session lifecycle and attributed file activity update one session robot');
  expect(ACTIVITY_AGENT_DEFAULT_FACING === Math.PI
   && activityAgentFacingAngle([0, 0, 0], [1, 0, 0]) === Math.PI / 2
   && activityAgentFacingAngle([0, 0, 0]) === Math.PI
   && activityAgentFacingAngle([0, 0, 0], [0, 0, 0]) === Math.PI
   && Math.abs(activityAgentShortestAngle(1.9 * Math.PI, 0) - 0.1 * Math.PI) < 0.000001, 'agent orientation targets rays, takes the shortest turn, and falls back safely');
  const activityAgent = { id: 'agent:activity', agentId: 'activity', sessionId: 'session:activity', label: 'Agent · activity', status: 'active', activity: 'Tool: search', color: '#4da3ff', lastEventId: 'activity:1', updatedAt: 1_000, center: [0, 0, 0] as [number, number, number], size: [1, 1, 1] as [number, number, number] } as const;
  expect(activityAgentStatusBaseline('active') > activityAgentStatusBaseline('idle')
    && activityAgentOpacity(activityAgent, 1_000 + ACTIVITY_TARGET_HOLD_MS) === 1
    && activityAgentOpacity(activityAgent, 1_000 + ACTIVITY_TARGET_HOLD_MS + ACTIVITY_TARGET_FADE_MS / 2) < 1
    && activityAgentOpacity(activityAgent, 1_000 + ACTIVITY_TARGET_TTL_MS) === activityAgentStatusBaseline('active'), 'agent glyphs promote to solid on activity then fade toward their status baseline');
  expect(activityAgentOpacity(activityAgent, 1_000, 1_000, true) === 0.3
    && activityAgentOpacity(activityAgent, 1_000 + ACTIVITY_TARGET_HOLD_MS / 2, 1_000, true) === 0.3, 'inactive agents stay on the dim inactive opacity baseline');
  const indexes = buildActivityGraphIndexes(graph, groups);
  const mapped = resolveActivityTarget(parseActivityEvent(base) as ActivityEvent, indexes);
  expect(mapped?.id === 'var:app/run' && mapped.match === 'span', 'file and line map to the smallest source span');
  const explicit = resolveActivityTarget(parseActivityEvent({ ...base, metadata: { graphNodeId: 'namespace:app' } }) as ActivityEvent, indexes);
  expect(explicit?.id === 'namespace:app' && explicit.match === 'node', 'explicit node IDs win');
  const unknown = resolveActivityTarget(parseActivityEvent({ ...base, resources: [{ file: 'not-in-graph.txt' }] }) as ActivityEvent, indexes);
  expect(unknown === undefined, 'unmapped files remain unmapped');
  const shellOnly = resolveActivityTarget(parseActivityEvent({ ...base, resources: undefined, content: 'cat src/app.clj' }) as ActivityEvent, indexes);
  expect(shellOnly === undefined, 'shell text never infers a file target');
  expect(activityStreamUrl('a/b') === '/api/activity/stream', 'native EventSource owns Last-Event-ID replay');
  expect(activityStreamUrl(undefined, '/api/activity/stream', 'local-9-abcdef12') === '/api/activity/stream?workspaceId=local-9-abcdef12', 'activity stream selects a workspace without exposing the token');
  expect(allWorkspacesActivityStreamUrl() === '/api/activity/stream?allWorkspaces=true', 'live mode subscribes to all workspaces');
  const selectedWorkspaceEvent = parseActivityEvent({ ...base, workspace: { id: 'local-9-abcdef12' } });
  const otherWorkspaceEvent = parseActivityEvent({ ...base, id: 'other-workspace-event', workspace: { id: 'local-8-abcdef12' } });
  expect(activityEventMatchesWorkspace(selectedWorkspaceEvent, 'local-9-abcdef12'), 'selected workspace events enter the activity history');
  expect(!activityEventMatchesWorkspace(selectedWorkspaceEvent, 'local-8-abcdef12'), 'explicitly scoped streams can still reject other workspace events');
  expect(activityEventMatchesWorkspace(otherWorkspaceEvent, undefined), 'unscoped live streams accept events from every workspace');
  expect(activityEventMatchesWorkspace(otherWorkspaceEvent, ''), 'empty workspace filters behave as unscoped');
  const selectedWorkspaceAliasEvent = parseActivityEvent({ ...base, workspace: { workspaceId: 'local-9-abcdef12' } });
  expect(activityEventMatchesWorkspace(selectedWorkspaceAliasEvent, 'local-9-abcdef12'), 'workspaceId aliases enter the selected activity history');
  const projectEvent = parseActivityEvent({ ...base, type: 'agent.start', agentId: 'agent:1', workspace: { id: 'workspace-a', path: '/Users/alice/project' } }) as ActivityEvent;
  const otherProjectEvent = parseActivityEvent({ ...projectEvent, id: 'project-b', workspace: { id: 'workspace-b', path: '/Users/alice/other' } }) as ActivityEvent;
  expect(isAgentActivityEvent(projectEvent)
    && activityWorkspacePath(projectEvent) === '/Users/alice/project'
    && activityProjectKey(projectEvent) !== activityProjectKey(otherProjectEvent), 'agent activity yields distinct usable project identities for project switching');
  expect(isAgentActivityEvent(parseActivityEvent({ ...base, id: 'top-level-session', type: 'session.start', workspace: { id: 'workspace-a', path: '/Users/alice/project' } }) as ActivityEvent), 'top-level session activity can drive live project loading without an agentId');
  expect(activityWorkspacePath(parseActivityEvent({ ...base, type: 'agent.start', agentId: 'agent:2', workspace: { id: 'opaque-only' } }) as ActivityEvent) === undefined, 'opaque-only telemetry does not trigger graph loading');
  const actionRead = parseActivityEvent({ ...base, type: 'provider.file', resources: [{ action: 'read', file: 'src/app.clj', line: 12 }] }) as ActivityEvent;
  expect(activityType(actionRead) === 'read', 'structured resource actions map file reads across provider event types');
  expect(activitySummary(parseActivityEvent({ ...actionRead, workspace: { root: '/Users/alice/project' }, resources: [{ action: 'read', file: '/Users/alice/project/src/app.clj' }] }) as ActivityEvent) === 'Read src/app.clj', 'absolute paths are rendered workspace-relative');
  expect(activitySummary(parseActivityEvent({ ...actionRead, resources: [{ action: 'read', file: '/Users/alice/project/src/app.clj' }] }) as ActivityEvent) === 'Read /Users/alice/project/src/app.clj', 'absolute resources retain their full local path without workspace context');
  const workspaceSnippet = parseActivityEvent({
    ...actionRead,
    type: 'tool',
    tool: 'bash',
    workspace: { root: '/Users/alice/project' },
    resources: [{ action: 'execute', file: '/Users/alice/project/src/app.clj' }],
    snippet: 'cat /Users/alice/project/src/app.clj',
  }) as ActivityEvent;
  expect(activitySnippet(workspaceSnippet) === 'cat src/app.clj', 'tool snippets render absolute workspace paths relatively');
  const redactedWorkspaceSnippet = parseActivityEvent({
    ...workspaceSnippet,
    id: 'redacted-workspace-snippet',
    snippet: 'cat [PATH]',
    resources: [{ action: 'read', file: 'src/app.clj' }],
  }) as ActivityEvent;
  expect(activitySnippet(redactedWorkspaceSnippet) === 'cat src/app.clj', 'known resources restore a useful path from a producer placeholder');
  expect(activitySummary(parseActivityEvent({
    ...actionRead,
    workspace: { root: '/Users/alice/project' },
    resources: [{ action: 'read', file: '/Users/alice/project/../private.txt' }],
  }) as ActivityEvent) === 'Read /Users/alice/private.txt', 'path traversal remains visible so outside-worktree activity can be identified');
  expect(activitySummary(parseActivityEvent({ ...base, type: 'tool', status: 'started', tool: '/Users/alice/private/tool' }) as ActivityEvent) === 'Tool execution', 'path-like tool names are never displayed');
  const unsafeSummary = parseActivityEvent({ ...base, metadata: { summary: 'prompt cat /Users/alice/project/src/app.clj', command: 'cat /Users/alice/project/src/app.clj', result: 'secret output' } }) as ActivityEvent;
  expect(!activitySummary(unsafeSummary).includes('/Users') && !activitySummary(unsafeSummary).includes('prompt'), 'raw summaries and command-like metadata are not displayed');
  const bash = parseActivityEvent({ ...base, type: 'tool', tool: 'bash', snippet: 'cat /Users/alice/project/src/app.clj' }) as ActivityEvent;
  expect(activityGroupId(bash) === 'group:activity:bash', 'bash events use a stable command group');
  expect(activitySnippet(bash) === 'cat /Users/alice/project/src/app.clj', 'unknown absolute paths remain visible for local activity attribution');
  const diff = parseActivityEvent({ ...base, type: 'tool', tool: 'bash', snippet: 'git diff -- src/app.clj' }) as ActivityEvent;
  expect(activitySnippet(diff) === 'git diff -- src/app.clj', 'shell snippets retain option separators');
  const tool = parseActivityEvent({ ...base, type: 'tool', tool: 'read_file', snippet: 'read src/app.clj' }) as ActivityEvent;
  expect(activityGroupId(tool) === 'group:activity:tool:read_file', 'named tools use stable per-tool groups');
  const structured = parseActivityEvent({
    ...base,
    id: 'structured-tool',
    type: 'tool',
    toolName: 'custom_tool',
    toolArgs: { path: 'src/app.clj', mode: 'preview', content: 'private code' },
  }) as ActivityEvent;
  expect(activitySnippet(structured) === 'custom_tool · path=src/app.clj · mode=preview', 'structured provider arguments produce a safe client snippet');
  expect(activitySummary(structured) === 'custom_tool · path=src/app.clj · mode=preview', 'tool summaries prefer intent snippets over generic labels');
  expect(activityGroupId(structured) === 'group:activity:tool:custom_tool', 'structured provider tool names select their named group');
  const groupSpec = activityGroupSpecs([structured], Date.parse(structured.timestamp)).find(spec => spec.id === activityGroupId(structured));
  expect(groupSpec?.label === 'tool · custom_tool', 'tool groups display a stable tool label');
  const nestedStructured = parseActivityEvent({
    ...base,
    id: 'nested-structured-tool',
    data: JSON.stringify({ toolName: 'view', toolArgs: { path: 'src/app.clj' } }),
  }) as ActivityEvent;
  expect(nestedStructured.tool === 'view' && activitySnippet(nestedStructured) === 'view · src/app.clj', 'nested provider fields survive client parsing');
  const nestedView = parseActivityEvent({
    ...base,
    id: 'nested-view',
    type: 'tool.execution_start',
    agentId: 'opaque-agent-view',
    tool: 'view',
    resources: [{ action: 'read', file: 'src/app.clj' }],
    data: JSON.stringify({ toolName: 'view', arguments: { path: 'src/app.clj' } }),
  }) as ActivityEvent;
  const nestedViewTarget = resolveActivityTarget(nestedView, indexes);
  let nestedViewState = activityReducer(initialActivityState(), {
    type: 'event',
    event: { ...nestedView, target: nestedViewTarget },
    now: 1250,
  });
  expect(nestedViewTarget?.id === 'namespace:app'
    && nestedViewTarget.match === 'file'
    && nestedViewState.rays.some(item => item.eventId === 'nested-view'
      && item.sourceAgentNodeId === activityAgentIdentity(nestedView)
      && item.sourceGroupId === undefined
      && item.target.id === 'namespace:app'
      && item.color === ACTIVITY_PULSE_COLORS.read), 'nested view events resolve to the file node and create a blue agent-to-file ray');
  const dynamicGraph: CodeGraph = { ...graph, nodes: [], edges: [], stats: { nodes: 0, edges: 0 } };
  const dynamicIndexes = buildActivityGraphIndexes(dynamicGraph, []);
  const dynamicRead = parseActivityEvent({
    ...base,
    id: 'dynamic-read',
    workspace: { id: 'workspace:dynamic', root: '/workspace' },
    resources: [{ action: 'read', file: 'src/missing.ts' }],
  }) as ActivityEvent;
  const dynamicTarget = resolveActivityTarget(dynamicRead, dynamicIndexes);
  const dynamicState = activityReducer(initialActivityState(), {
    type: 'event',
    event: { ...dynamicRead, target: dynamicTarget },
    now: 1300,
  });
  expect(dynamicTarget?.kind === 'group'
    && dynamicTarget.id.includes(':file:')
    && dynamicState.rays.some(item => item.eventId === 'dynamic-read'
      && item.sourceAgentNodeId === activityAgentIdentity(dynamicRead)
      && item.target.id === dynamicTarget.id), 'file activity falls back to the live hierarchy and creates an agent-to-file ray without a tool group');
  const pagedEvents = Array.from({ length: 25 }, (_, index) => ({ ...base, id: `page:${index}`, sequence: index })) as ActivityEvent[];
  const firstPage = recentActivityEvents(pagedEvents, ACTIVITY_PAGE_SIZE);
  const secondPage = recentActivityEvents(pagedEvents, ACTIVITY_PAGE_SIZE * 2);
  expect(firstPage.length === 10 && firstPage[0].id === 'page:24' && firstPage[9].id === 'page:15', 'activity starts with ten newest entries');
  expect(secondPage.length === 20 && secondPage[10].id === 'page:14', 'activity pagination reveals the next ten in newest-first order');
  const activePreviewState = initialActivityState();
  for (let index = 0; index < 8; index += 1) {
    activePreviewState.activeTools.set(`tool:${index}`, { id: `tool:${index}`, sessionId: 'session:1', tool: `tool-${index}`, status: 'running', startedAt: index, updatedAt: index });
  }
  for (let index = 0; index < 8; index += 1) {
    activePreviewState.activeAgents.set(`agent:${index}`, { id: `agent:${index}`, sessionId: 'session:1', status: 'active', lastEventId: `event:${index}`, updatedAt: 100 + index });
  }
  const activePreview = recentActiveTelemetry(activePreviewState);
  expect(activePreview.length === ACTIVE_TELEMETRY_LIMIT && activePreview[0].id === 'agent:7' && activePreview[9].id === 'tool:6', 'active telemetry renders only the ten newest tool/agent entries');
  expect(activePreviewState.activeTools.size === 8 && activePreviewState.activeAgents.size === 8, 'active telemetry display cap does not change counts');

  const duplicateGraph: CodeGraph = {
    ...graph,
    nodes: [
      ...graph.nodes,
      { id: 'namespace:other', kind: 'namespace', label: 'other', namespace: 'other', file: 'other/app.clj', row: 0, endRow: 20 },
    ],
  };
  const duplicateIndexes = buildActivityGraphIndexes(duplicateGraph, groups);
  const duplicateSuffix = resolveActivityTarget(parseActivityEvent({ ...base, resources: [{ file: 'app.clj' }] }) as ActivityEvent, duplicateIndexes);
  expect(duplicateSuffix === undefined, 'duplicate suffixes remain unmapped');
  const exactPath = resolveActivityTarget(parseActivityEvent({ ...base, resources: [{ file: 'src/app.clj' }] }) as ActivityEvent, duplicateIndexes);
  expect(exactPath?.id === 'namespace:app', 'exact workspace-relative paths beat suffix fallback');
  const wrongWorkspace = resolveActivityTarget(parseActivityEvent({ ...base, workspace: { root: '/other-workspace' } }) as ActivityEvent, indexes);
  expect(wrongWorkspace === undefined, 'events from another workspace cannot target this graph');
  const wrongWorkspaceId = resolveActivityTarget(parseActivityEvent({ ...base, workspace: { id: 'local-not-this-repository' } }) as ActivityEvent, indexes);
  expect(wrongWorkspaceId === undefined, 'opaque workspace identities prevent cross-repository replay');
  const outsideResource = resolveActivityTarget(parseActivityEvent({ ...base, workspace: { root: '/workspace' }, resources: [{ file: '/other/src/app.clj', action: 'read' }] }) as ActivityEvent, indexes);
  expect(outsideResource === undefined, 'absolute resources outside the selected workspace remain unmapped');

  let agentState = initialActivityState();
  agentState = activityReducer(agentState, { type: 'event', event: agentStart, now: 2000 });
  agentState = activityReducer(agentState, { type: 'event', event: agentUpdate, now: 2100 });
  expect(agentState.agentNodes.size === 1, 'repeated agent events update one node');
  expect(agentState.agentNodes.get(activityAgentIdentity(agentStart) as string)?.label === 'Reviewer'
    && agentState.agentNodes.get(activityAgentIdentity(agentStart) as string)?.activity === 'Tool: search', 'agent node preserves safe label and latest activity');
  agentState = activityReducer(agentState, { type: 'event', event: { ...agentUpdate, id: 'agent-other-session', sessionId: 'session:2' }, now: 2200 });
  expect(agentState.agentNodes.size === 2, 'session identity keeps concurrent agents distinct');
  const topLevelSession = parseActivityEvent({ ...base, id: 'top-level-session', type: 'session.start', agentId: 'session:session:1', workspace: { id: 'workspace:1' } }) as ActivityEvent;
  agentState = activityReducer(agentState, { type: 'event', event: topLevelSession, now: 2300 });
  expect(agentState.agentNodes.has(activityAgentIdentity(topLevelSession) as string)
    && agentState.agentNodes.get(activityAgentIdentity(topLevelSession) as string)?.agentId === 'session:1', 'session lifecycle envelopes render one deduplicated top-level agent node');
  const namedSession = parseActivityEvent({
    ...topLevelSession,
    id: 'named-session',
    sessionName: 'Naming agent glyphs',
  }) as ActivityEvent;
  agentState = activityReducer(agentState, { type: 'event', event: namedSession, now: 2400 });
  expect(namedSession.sessionName === 'Naming agent glyphs'
    && activityAgentLabel(namedSession) === 'Naming agent glyphs'
    && agentState.agentNodes.get(activityAgentIdentity(namedSession) as string)?.sessionName === 'Naming agent glyphs'
    && agentState.agentNodes.get(activityAgentIdentity(namedSession) as string)?.agentId === 'session:1', 'session names become primary agent labels while stable IDs remain attached');
  const namedAgent = parseActivityEvent({ ...namedSession, id: 'named-agent', agentName: 'Implementer' }) as ActivityEvent;
  expect(namedAgent.agentName === 'Implementer' && activityAgentLabel(namedAgent) === 'Naming agent glyphs · Implementer', 'provider agent names complement readable session names');
  const canonicalAgent = agentState.agentNodes.get(activityAgentIdentity(agentStart) as string);
  const dedupedAgentLayout = withActivityAgentNodes(computeLayout(EMPTY_GRAPH), canonicalAgent ? [canonicalAgent, { ...canonicalAgent }] : [], 2_400);
  expect((dedupedAgentLayout.activityAgents?.length ?? 0) + (dedupedAgentLayout.activityInactiveAgents?.length ?? 0) === 1, 'the same canonical agent identity is rendered once');
  const workspaceAgent = parseActivityEvent({ ...agentStart, id: 'agent-other-workspace', workspace: { id: 'workspace:other' } }) as ActivityEvent;
  let isolatedAgents = initialActivityState();
  isolatedAgents = activityReducer(isolatedAgents, { type: 'event', event: agentStart, now: 2_500 });
  isolatedAgents = activityReducer(isolatedAgents, { type: 'event', event: workspaceAgent, now: 2_600 });
  expect(isolatedAgents.agentNodes.size === 2
    && activityAgentIdentity(agentStart) !== activityAgentIdentity(workspaceAgent), 'workspace identity keeps otherwise matching agents distinct');
  let state = initialActivityState();
  const first = parseActivityEvent(base) as ActivityEvent;
  const later = parseActivityEvent({ ...base, id: 'event:2', sequence: 2, timestamp: '2026-08-26T12:00:02.000Z' }) as ActivityEvent;
  const earlier = parseActivityEvent({ ...base, id: 'event:0', sequence: 1, timestamp: '2026-08-26T12:00:01.000Z' }) as ActivityEvent;
  state = activityReducer(state, { type: 'event', event: { ...first, target: mapped }, now: 1000 });
  expect(ACTIVITY_TARGET_HOLD_MS === 30000 && ACTIVITY_TARGET_FADE_MS === 30000 && ACTIVITY_TARGET_TTL_MS === 60000, 'activity prominence holds thirty seconds then fades for thirty seconds');
  const firstPulse = state.pulses.find(pulse => pulse.eventId === first.id);
  expect(firstPulse !== undefined
    && activityTargetOpacity(firstPulse, firstPulse.startedAt + ACTIVITY_TARGET_HOLD_MS) === 1
    && activityTargetOpacity(firstPulse, firstPulse.startedAt + ACTIVITY_TARGET_HOLD_MS + ACTIVITY_TARGET_FADE_MS / 2) > ACTIVITY_TARGET_BASELINE_OPACITY
    && activityTargetOpacity(firstPulse, firstPulse.startedAt + ACTIVITY_TARGET_HOLD_MS + ACTIVITY_TARGET_FADE_MS / 2) < 1
    && activityTargetOpacity(firstPulse, firstPulse.startedAt + ACTIVITY_TARGET_TTL_MS) === ACTIVITY_TARGET_BASELINE_OPACITY
    && activityGroupOpacity(firstPulse, firstPulse.startedAt + ACTIVITY_TARGET_TTL_MS) === ACTIVITY_TARGET_BASELINE_OPACITY, 'activity targets hold full opacity, fade continuously, and reach baseline at sixty seconds');
  state = activityReducer(state, { type: 'event', event: { ...later, target: mapped }, now: 1100 });
  state = activityReducer(state, { type: 'event', event: { ...earlier, target: mapped }, now: 1050 });
  expect(state.events.map(event => event.id).join(',') === 'event:1,event:0,event:2', 'out-of-order events are sequence ordered');
  expect(state.pulses.length === 3, 'mapped events create expiring pulses');
  state = activityReducer(state, { type: 'event', event: { ...first, target: mapped }, now: 1200 });
  expect(state.events.length === 3, 'duplicate contract IDs are ignored');
  const sameIdOtherSession = parseActivityEvent({ ...base, sessionId: 'session:2' }) as ActivityEvent;
  const sameIdOtherSource = parseActivityEvent({ ...base, source: 'other-provider' }) as ActivityEvent;
  state = activityReducer(state, { type: 'event', event: sameIdOtherSession, now: 1250 });
  state = activityReducer(state, { type: 'event', event: sameIdOtherSource, now: 1250 });
  expect(state.events.filter(event => event.id === first.id).length === 3, 'provider IDs are scoped by session and source');
  const replayed = parseActivityEvent({ ...base, id: 'sse-event' }, '42') as ActivityEvent;
  state = activityReducer(state, { type: 'event', event: replayed, now: 1250 });
  const replayState = activityReducer(state, { type: 'event', event: { ...replayed } });
  expect(replayState.events.length === state.events.length && activityEventIdentity(replayed) === 'sse:42', 'replayed SSE events are deduplicated by collector ID');
  const latestTargetExpiry = Math.max(...state.pulses.map(pulse => pulse.expiresAt));
  state = activityReducer(state, { type: 'expire', now: latestTargetExpiry - 1 });
  expect(state.pulses.length > 0, 'activity target state remains through the opacity window');
  state = activityReducer(state, { type: 'expire', now: latestTargetExpiry + 1 });
  expect(state.pulses.length === 0, 'activity target state expires after the opacity window');
  state = activityReducer(state, { type: 'gap', from: '4', to: '8', reason: 'retention' });
  expect(state.connection.status === 'gap' && state.connection.coverage === 'partial', 'replay gaps are visible');
  state = activityReducer(state, { type: 'gap', requestedId: '4', oldestId: '8', reason: 'retention' });
  expect(state.connection.replayGap?.requestedId === '4' && state.connection.replayGap?.oldestId === '8', 'replay gap IDs are retained in coverage state');
  state = activityReducer(state, { type: 'event', event: parseActivityEvent({ ...base, id: 'session-start', type: 'session.start', sequence: 3 }) as ActivityEvent });
  state = activityReducer(state, { type: 'event', event: parseActivityEvent({ ...base, id: 'tool-start', type: 'tool.start', sequence: 4, toolCallId: 'tool:1', tool: 'shell' }) as ActivityEvent });
  expect(state.activeSessions.has('session:1') && state.activeTools.has('tool:1'), 'session and tool lifecycle state is tracked');
  state = activityReducer(state, { type: 'event', event: parseActivityEvent({ ...base, id: 'tool-end', type: 'tool.end', sequence: 5, toolCallId: 'tool:1', status: 'complete' }) as ActivityEvent });
  expect(!state.activeTools.has('tool:1'), 'completed tools leave the active set');
  state = activityReducer(state, { type: 'event', event: parseActivityEvent({ ...base, id: 'provider-tool-start', type: 'tool', status: 'started', sequence: 6, toolCallId: 'tool:2', tool: 'search' }) as ActivityEvent });
  expect(state.activeTools.has('tool:2'), 'provider-shaped started tool events are active');
  state = activityReducer(state, { type: 'event', event: parseActivityEvent({ ...base, id: 'provider-tool-failed', type: 'tool', status: 'failed', sequence: 7, toolCallId: 'tool:2', tool: 'search' }) as ActivityEvent });
  expect(!state.activeTools.has('tool:2'), 'provider-shaped failed tool events leave the active set');
  state = activityReducer(state, { type: 'event', event: parseActivityEvent({ ...base, id: 'dotted-tool-start', type: 'tool.started', sequence: 8, toolCallId: 'tool:3', tool: 'shell' }) as ActivityEvent });
  state = activityReducer(state, { type: 'event', event: parseActivityEvent({ ...base, id: 'dotted-tool-complete', type: 'tool.completed', sequence: 9, toolCallId: 'tool:3', tool: 'shell' }) as ActivityEvent });
  expect(!state.activeTools.has('tool:3'), 'canonical dotted tool lifecycle events are normalized');
  const resourceWrite = parseActivityEvent({ ...base, id: 'resource-write', type: 'provider.operation', resources: [{ action: 'write', file: 'src/app.clj' }] }) as ActivityEvent;
  state = activityReducer(state, { type: 'event', event: { ...resourceWrite, target: resolveActivityTarget(resourceWrite, indexes) }, now: 1300 });
  expect(state.pulses.some(pulse => pulse.eventId === 'resource-write' && pulse.kind === 'write' && pulse.color === ACTIVITY_PULSE_COLORS.write), 'structured write actions create red write pulses');
  const applyPatch = parseActivityEvent({
    ...base,
    id: 'apply-patch',
    type: 'tool.execution_start',
    agentId: 'opaque-agent-1',
    tool: 'apply_patch',
    resources: [{ action: 'write', file: 'src/app.clj' }],
  }) as ActivityEvent;
  const applyPatchTarget = resolveActivityTarget(applyPatch, indexes);
  const applyPatchState = activityReducer(initialActivityState(), {
    type: 'event',
    event: { ...applyPatch, target: applyPatchTarget },
    now: 1350,
  });
  expect(applyPatchTarget?.id === 'namespace:app'
    && applyPatchTarget.match === 'file'
    && applyPatchState.rays.some(item => item.eventId === 'apply-patch'
      && item.sourceAgentNodeId === activityAgentIdentity(applyPatch)
      && item.sourceGroupId === undefined
      && item.target.id === 'namespace:app'
      && item.color === ACTIVITY_PULSE_COLORS.write), 'known apply-patch files resolve to the graph node and create a red agent-to-file ray');
  const resourceRead = parseActivityEvent({ ...base, id: 'resource-read', type: 'provider.operation', resources: [{ action: 'read', file: 'src/app.clj' }] }) as ActivityEvent;
  state = activityReducer(state, { type: 'event', event: { ...resourceRead, target: resolveActivityTarget(resourceRead, indexes) }, now: 1400 });
  expect(state.pulses.some(pulse => pulse.eventId === 'resource-read' && pulse.kind === 'read' && pulse.color === ACTIVITY_PULSE_COLORS.read), 'structured read actions create blue read pulses');
  expect(activityRenderState(state, new Set(['session:1'])).pulses.every(pulse => pulse.sessionId === 'session:1'), 'render artifacts retain session identity for filtering');
  const toolTarget = parseActivityEvent({ ...base, id: 'tool-target', type: 'tool', status: 'started', tool: 'bash', resources: [{ action: 'read', file: 'src/app.clj', line: 12 }] }) as ActivityEvent;
  state = activityReducer(state, { type: 'event', event: { ...toolTarget, target: resolveActivityTarget(toolTarget, indexes) }, now: 1500 });
  const ray = state.rays.find(item => item.eventId === 'tool-target');
  expect(ray?.sourceGroupId === 'group:activity:bash' && ray.target.sourceId === indexes.identity && ray.target.workspaceId === indexes.workspaceId, 'tool target rays retain source and workspace identity');
  expect(ray !== undefined && ray.expiresAt === ray.startedAt + ACTIVITY_RAY_TTL_MS && activityRayOpacity(ray, ray.startedAt) === 1 && activityRayOpacity(ray, ray.expiresAt) === 0, 'tool target rays retain their existing thirty-second bounded lifetime');
  const groupPulse = state.pulses.find(item => item.eventId === 'tool-target' && item.target.kind === 'group');
  expect(groupPulse !== undefined
    && activityGroupOpacity(groupPulse, groupPulse.startedAt + ACTIVITY_TARGET_HOLD_MS) === 1
    && activityGroupOpacity(groupPulse, groupPulse.startedAt + ACTIVITY_TARGET_HOLD_MS + ACTIVITY_TARGET_FADE_MS / 2) > ACTIVITY_TARGET_BASELINE_OPACITY
    && activityGroupOpacity(groupPulse, groupPulse.startedAt + ACTIVITY_TARGET_HOLD_MS + ACTIVITY_TARGET_FADE_MS / 2) < 1
    && activityGroupOpacity(groupPulse, groupPulse.startedAt + ACTIVITY_TARGET_TTL_MS) === ACTIVITY_TARGET_BASELINE_OPACITY, 'activity groups use the same hold and fade opacity window');
  state = activityReducer(state, { type: 'expire', now: ray!.startedAt + ACTIVITY_RAY_TTL_MS + 1 });
  expect(!state.rays.some(item => item.eventId === 'tool-target') && state.pulses.some(item => item.eventId === 'tool-target'), 'rays expire after thirty seconds while target prominence remains');
  const agentToolTarget = parseActivityEvent({ ...toolTarget, id: 'agent-tool-target', agentId: 'opaque-agent-1' }) as ActivityEvent;
  state = activityReducer(state, { type: 'event', event: { ...agentToolTarget, target: resolveActivityTarget(agentToolTarget, indexes) }, now: 1510 });
  const agentRay = state.rays.find(item => item.eventId === 'agent-tool-target' && item.sourceAgentNodeId);
  expect(agentRay !== undefined && agentRay.sourceAgentNodeId === activityAgentIdentity(agentToolTarget)
    && agentRay.target.id === resolveActivityTarget(agentToolTarget, indexes)?.id
    && agentRay.target.kind === 'node'
    && agentRay.color === ACTIVITY_PULSE_COLORS.read, 'explicit file reads target the resolved file node directly from the agent');
  expect(state.rays.filter(item => item.eventId === 'agent-tool-target').length === 1, 'explicit file activity bypasses the tool-box ray');
  const targetAgent = parseActivityEvent({
    ...base,
    id: 'target-agent',
    type: 'agent.start',
    sessionId: 'target-session',
    agentId: 'target-agent-id',
    workspace: { id: 'workspace:agents' },
  }) as ActivityEvent;
  const readAgent = parseActivityEvent({
    ...base,
    id: 'read-agent',
    type: 'tool.execution_start',
    tool: 'read_agent',
    agentId: 'source-agent-id',
    workspace: { id: 'workspace:agents' },
    metadata: { targetAgentId: targetAgent.agentId as string, targetSessionId: targetAgent.sessionId, targetWorkspaceId: 'workspace:agents' },
  }) as ActivityEvent;
  let agentLinkState = activityReducer(initialActivityState(), { type: 'event', event: targetAgent, now: 1_600 });
  agentLinkState = activityReducer(agentLinkState, { type: 'event', event: readAgent, now: 1_610 });
  const readAgentRay = agentLinkState.rays.find(item => item.eventId === 'read-agent');
  expect(readAgentRay !== undefined
    && readAgentRay.sourceAgentNodeId === activityAgentIdentity(readAgent)
    && readAgentRay.target.id === activityAgentIdentity(targetAgent)
    && readAgentRay.sourceGroupId === undefined
    && readAgentRay.color === ACTIVITY_PULSE_COLORS.read
    && readAgentRay.agentLink?.flowDirection === 'target-to-source'
    && activityRayDashFlowOffset(readAgentRay, readAgentRay.startedAt + 1_000) < 0
    && activityRayDashFlowOffset(readAgentRay, readAgentRay.startedAt + 1_000) > -0.05
    && activityRayDashFlowOffset(readAgentRay, readAgentRay.startedAt + 1_000, true) === 0
    && activityRayUsesDashPattern(readAgentRay)
    && agentLinkState.rays.filter(item => item.eventId === 'read-agent').length === 1, 'read_agent creates one direct blue dashed agent-to-agent ray without a tool-box hop');
  const writeAgent = parseActivityEvent({
    ...readAgent,
    id: 'write-agent',
    tool: 'write_agent',
  }) as ActivityEvent;
  const writeAgentState = activityReducer(agentLinkState, { type: 'event', event: writeAgent, now: 1_620 });
  const writeAgentRay = writeAgentState.rays.find(item => item.eventId === 'write-agent');
  expect(writeAgentRay !== undefined
    && writeAgentRay.sourceAgentNodeId === activityAgentIdentity(writeAgent)
    && writeAgentRay.target.id === activityAgentIdentity(targetAgent)
    && writeAgentRay.sourceGroupId === undefined
    && writeAgentRay.color === ACTIVITY_PULSE_COLORS.write
    && writeAgentRay.agentLink?.flowDirection === 'source-to-target'
    && activityRayDashFlowOffset(writeAgentRay, writeAgentRay.startedAt + 1_000) > 0
    && activityRayDashFlowOffset(writeAgentRay, writeAgentRay.startedAt + 1_000) < 0.05
    && activityRayUsesDashPattern(writeAgentRay)
    && writeAgentState.rays.filter(item => item.eventId === 'write-agent').length === 1, 'write_agent creates one direct red dashed agent-to-agent ray without a tool-box hop');
  const sameWorkspaceVisibleAgents = [
    {
      id: activityAgentIdentity(readAgent) as string,
      agentId: readAgent.agentId as string,
      sessionId: readAgent.sessionId,
      workspaceId: 'workspace:agents',
    },
    {
      id: activityAgentIdentity(targetAgent) as string,
      agentId: targetAgent.agentId as string,
      sessionId: targetAgent.sessionId,
      workspaceId: 'workspace:agents',
    },
  ];
  const otherWorkspaceDuplicate = {
    id: 'agent:other-workspace-duplicate',
    agentId: targetAgent.agentId as string,
    sessionId: 'other-target-session',
    workspaceId: 'workspace:other',
  };
  expect(readAgentRay !== undefined
    && activityRayWorkspaceCompatible(readAgentRay, sameWorkspaceVisibleAgents, [...sameWorkspaceVisibleAgents, otherWorkspaceDuplicate]), 'same-workspace selector matches retain their legacy ray despite an unselected duplicate elsewhere');
  const crossWorkspaceTarget = parseActivityEvent({
    ...targetAgent,
    id: 'cross-workspace-target',
    sessionId: 'remote-target-session',
    agentId: 'remote-target-agent',
    workspace: { id: 'workspace:remote' },
  }) as ActivityEvent;
  const crossWorkspaceRead = parseActivityEvent({
    ...readAgent,
    id: 'cross-workspace-read',
    sessionId: 'local-source-session',
    agentId: 'local-source-agent',
    workspace: { id: 'workspace:local' },
    metadata: {
      targetAgentId: crossWorkspaceTarget.agentId as string,
      targetAgentNodeId: activityAgentIdentity(crossWorkspaceTarget) as string,
      targetSessionId: crossWorkspaceTarget.sessionId,
      targetWorkspaceId: 'workspace:remote',
    },
  }) as ActivityEvent;
  let crossWorkspaceState = activityReducer(initialActivityState(), { type: 'event', event: crossWorkspaceTarget, now: 1_700 });
  crossWorkspaceState = activityReducer(crossWorkspaceState, { type: 'event', event: crossWorkspaceRead, now: 1_710 });
  const crossWorkspaceReadRay = crossWorkspaceState.rays.find(item => item.eventId === 'cross-workspace-read');
  const crossWorkspaceVisibleAgents = [
    {
      id: activityAgentIdentity(crossWorkspaceRead) as string,
      agentId: crossWorkspaceRead.agentId as string,
      sessionId: crossWorkspaceRead.sessionId,
      workspaceId: 'workspace:local',
    },
    {
      id: activityAgentIdentity(crossWorkspaceTarget) as string,
      agentId: crossWorkspaceTarget.agentId as string,
      sessionId: crossWorkspaceTarget.sessionId,
      workspaceId: 'workspace:remote',
    },
  ];
  expect(crossWorkspaceReadRay !== undefined
    && crossWorkspaceReadRay.agentLink?.targetAgentId === crossWorkspaceTarget.agentId
    && crossWorkspaceReadRay.agentLink?.targetAgentNodeId === activityAgentIdentity(crossWorkspaceTarget)
    && crossWorkspaceReadRay.agentLink?.targetSessionId === crossWorkspaceTarget.sessionId
    && crossWorkspaceReadRay.agentLink?.targetWorkspaceId === 'workspace:remote'
    && activityRayWorkspaceCompatible(crossWorkspaceReadRay, crossWorkspaceVisibleAgents), 'read_agent renders a cross-workspace ray only for its explicit, uniquely visible recipient');
  expect(crossWorkspaceReadRay !== undefined
    && !activityRayWorkspaceCompatible(crossWorkspaceReadRay, [crossWorkspaceVisibleAgents[0]], crossWorkspaceVisibleAgents), 'a hidden cross-workspace recipient is not treated as rendered');
  const mismatchedTargetWorkspaceRay = {
    ...crossWorkspaceReadRay!,
    agentLink: { ...crossWorkspaceReadRay!.agentLink!, targetWorkspaceId: 'workspace:mismatch' },
  };
  const mismatchedTargetSessionRay = {
    ...crossWorkspaceReadRay!,
    agentLink: { ...crossWorkspaceReadRay!.agentLink!, targetSessionId: 'session:mismatch' },
  };
  const mismatchedTargetNodeRay = {
    ...crossWorkspaceReadRay!,
    agentLink: { ...crossWorkspaceReadRay!.agentLink!, targetAgentNodeId: 'agent:mismatch' },
  };
  expect(!activityRayWorkspaceCompatible(mismatchedTargetWorkspaceRay, crossWorkspaceVisibleAgents)
    && !activityRayWorkspaceCompatible(mismatchedTargetSessionRay, crossWorkspaceVisibleAgents)
    && !activityRayWorkspaceCompatible(mismatchedTargetNodeRay, crossWorkspaceVisibleAgents), 'a cross-workspace recipient that mismatches any supplied selector stays hidden');
  const crossWorkspaceWrite = parseActivityEvent({
    ...crossWorkspaceRead,
    id: 'cross-workspace-write',
    tool: 'write_agent',
  }) as ActivityEvent;
  const crossWorkspaceWriteState = activityReducer(crossWorkspaceState, { type: 'event', event: crossWorkspaceWrite, now: 1_720 });
  const crossWorkspaceWriteRay = crossWorkspaceWriteState.rays.find(item => item.eventId === 'cross-workspace-write');
  expect(crossWorkspaceWriteRay !== undefined
    && crossWorkspaceWriteRay.color === ACTIVITY_PULSE_COLORS.write
    && activityRayUsesDashPattern(crossWorkspaceWriteRay)
    && activityRayWorkspaceCompatible(crossWorkspaceWriteRay, crossWorkspaceVisibleAgents), 'write_agent keeps its red dashed appearance across workspaces for an explicit recipient');
  const crossWorkspaceResourceRay = {
    ...crossWorkspaceReadRay!,
    target: { ...crossWorkspaceReadRay!.target, id: 'var:app', workspaceId: 'workspace:remote' },
  };
  delete crossWorkspaceResourceRay.workspaceId;
  expect(!activityRayWorkspaceCompatible(crossWorkspaceResourceRay, crossWorkspaceVisibleAgents), 'cross-workspace file targets remain blocked even when the source workspace is implicit');
  const unresolvedCrossWorkspaceRead = parseActivityEvent({
    ...crossWorkspaceRead,
    id: 'unresolved-cross-workspace-read',
    metadata: {
      targetAgentId: 'missing-remote-agent',
      targetSessionId: 'missing-remote-session',
      targetWorkspaceId: 'workspace:remote',
    },
  }) as ActivityEvent;
  const unresolvedCrossWorkspaceState = activityReducer(initialActivityState(), { type: 'event', event: unresolvedCrossWorkspaceRead, now: 1_730 });
  const unresolvedCrossWorkspaceRay = unresolvedCrossWorkspaceState.rays.find(item => item.eventId === 'unresolved-cross-workspace-read');
  const unresolvedSourceAgent = [{
    id: activityAgentIdentity(unresolvedCrossWorkspaceRead) as string,
    agentId: unresolvedCrossWorkspaceRead.agentId as string,
    sessionId: unresolvedCrossWorkspaceRead.sessionId,
    workspaceId: 'workspace:local',
  }];
  expect(unresolvedCrossWorkspaceRay !== undefined
    && !activityRayWorkspaceCompatible(unresolvedCrossWorkspaceRay, unresolvedSourceAgent), 'an unresolved cross-workspace recipient stays hidden');
  const ambiguousFirstTarget = parseActivityEvent({
    ...crossWorkspaceTarget,
    id: 'ambiguous-first-target',
    sessionId: 'ambiguous-source-session',
    agentId: 'shared-remote-agent',
  }) as ActivityEvent;
  const ambiguousSecondTarget = parseActivityEvent({
    ...ambiguousFirstTarget,
    id: 'ambiguous-second-target',
    sessionId: 'other-remote-session',
  }) as ActivityEvent;
  const ambiguousCrossWorkspaceRead = parseActivityEvent({
    ...crossWorkspaceRead,
    id: 'ambiguous-cross-workspace-read',
    sessionId: 'ambiguous-source-session',
    metadata: {
      targetAgentId: 'shared-remote-agent',
      targetWorkspaceId: 'workspace:remote',
    },
  }) as ActivityEvent;
  let ambiguousCrossWorkspaceState = activityReducer(initialActivityState(), { type: 'event', event: ambiguousFirstTarget, now: 1_740 });
  ambiguousCrossWorkspaceState = activityReducer(ambiguousCrossWorkspaceState, { type: 'event', event: ambiguousSecondTarget, now: 1_745 });
  ambiguousCrossWorkspaceState = activityReducer(ambiguousCrossWorkspaceState, { type: 'event', event: ambiguousCrossWorkspaceRead, now: 1_750 });
  const ambiguousCrossWorkspaceRay = ambiguousCrossWorkspaceState.rays.find(item => item.eventId === 'ambiguous-cross-workspace-read');
  const ambiguousVisibleAgents = [
    {
      id: activityAgentIdentity(ambiguousCrossWorkspaceRead) as string,
      agentId: ambiguousCrossWorkspaceRead.agentId as string,
      sessionId: ambiguousCrossWorkspaceRead.sessionId,
      workspaceId: 'workspace:local',
    },
    ...[ambiguousFirstTarget, ambiguousSecondTarget].map(agent => ({
      id: activityAgentIdentity(agent) as string,
      agentId: agent.agentId as string,
      sessionId: agent.sessionId,
      workspaceId: 'workspace:remote',
    })),
  ];
  expect(ambiguousCrossWorkspaceRay !== undefined
    && !activityRayWorkspaceCompatible(ambiguousCrossWorkspaceRay, ambiguousVisibleAgents), 'an ambiguous cross-workspace recipient is not guessed from the source session');
  const sourcedAgentToolTarget = parseActivityEvent({
    ...toolTarget,
    id: 'sourced-agent-tool-target',
    agentId: 'opaque-agent-1',
    source: { client: 'copilot-cli', kind: 'jsonl' },
  }) as ActivityEvent;
  const sourcedTarget = resolveActivityTarget(sourcedAgentToolTarget, indexes);
  const sourcedState = activityReducer(initialActivityState(), {
    type: 'event',
    event: { ...sourcedAgentToolTarget, target: sourcedTarget },
    now: 1520,
  });
  const sourcedAgentRay = sourcedState.rays.find(item => item.eventId === 'sourced-agent-tool-target' && item.sourceAgentNodeId);
  expect(sourcedAgentRay !== undefined
    && sourcedAgentRay.sourceId === sourcedTarget?.sourceId
    && sourcedAgentRay.target.sourceId === sourcedTarget?.sourceId, 'agent rays use the resolved graph identity even when producer source metadata is structured');
  const snippetEvent = parseActivityEvent({ ...toolTarget, id: 'tool-snippet', snippet: 'git diff -- /workspace/src/app.clj', workspace: { root: '/workspace' }, resources: [{ action: 'read', file: '/workspace/src/app.clj' }] }) as ActivityEvent;
  state = activityReducer(state, { type: 'event', event: { ...snippetEvent, target: resolveActivityTarget(snippetEvent, indexes) }, now: 1550 });
  const marker = state.snippetMarkers.find(item => item.eventId === 'tool-snippet');
  expect(marker?.groupId === 'group:activity:bash' && marker.text === 'git diff -- src/app.clj', 'tool snippets create bounded markers with relative paths');
  expect(marker !== undefined && activitySnippetMarkerOpacity(marker, marker.startedAt) === 1 && activitySnippetMarkerOpacity(marker, marker.startedAt + ACTIVITY_SNIPPET_MARKER_HOLD_MS) === 1 && activitySnippetMarkerOpacity(marker, marker.startedAt + ACTIVITY_SNIPPET_MARKER_TTL_MS) === 0, 'snippet markers hold twenty seconds then fade over ten seconds');
  expect(marker !== undefined
    && ACTIVITY_SNIPPET_MARKER_MAX_SCALE === 2.5
    && activitySnippetMarkerScale(marker, marker.startedAt) === ACTIVITY_SNIPPET_MARKER_MAX_SCALE
    && activitySnippetMarkerScale(marker, marker.startedAt + ACTIVITY_SNIPPET_MARKER_SCALE_HOLD_MS) === ACTIVITY_SNIPPET_MARKER_MAX_SCALE
    && activitySnippetMarkerScale(marker, marker.startedAt + ACTIVITY_SNIPPET_MARKER_SCALE_HOLD_MS + ACTIVITY_SNIPPET_MARKER_SCALE_FADE_MS / 2) > 1
    && activitySnippetMarkerScale(marker, marker.startedAt + ACTIVITY_SNIPPET_MARKER_SCALE_HOLD_MS + ACTIVITY_SNIPPET_MARKER_SCALE_FADE_MS / 2) < ACTIVITY_SNIPPET_MARKER_MAX_SCALE
    && activitySnippetMarkerScale(marker, marker.startedAt + ACTIVITY_SNIPPET_MARKER_SCALE_HOLD_MS + ACTIVITY_SNIPPET_MARKER_SCALE_FADE_MS) === 1, 'snippet marker text stays oversized, then eases to normal size');
  const secondSnippetEvent = parseActivityEvent({ ...toolTarget, id: 'tool-snippet-2', snippet: 'git status' }) as ActivityEvent;
  state = activityReducer(state, { type: 'event', event: { ...secondSnippetEvent, target: resolveActivityTarget(secondSnippetEvent, indexes) }, now: 1560 });
  expect(state.snippetMarkers.filter(item => item.eventId === 'tool-snippet' || item.eventId === 'tool-snippet-2').length === 2, 'new tool events add distinct markers while older markers continue fading');
  for (let index = 0; index < MAX_ACTIVITY_RAYS + 12; index += 1) {
    const event = parseActivityEvent({ ...toolTarget, id: `ray:${index}` }) as ActivityEvent;
    state = activityReducer(state, { type: 'event', event: { ...event, target: resolveActivityTarget(event, indexes) }, now: 1600 + index });
  }
  expect(state.rays.length === MAX_ACTIVITY_RAYS && state.rays.some(item => item.eventId === `ray:${MAX_ACTIVITY_RAYS + 11}`), 'transient target rays are capped while retaining newest activity');
  expect(state.snippetMarkers.length <= MAX_ACTIVITY_SNIPPET_MARKERS && state.snippetMarkers.filter(item => item.groupId === 'group:activity:bash').length <= MAX_ACTIVITY_SNIPPET_MARKERS_PER_GROUP, 'snippet markers remain bounded globally and per tool group');
  for (let index = 0; index < 300; index += 1) {
    const event = parseActivityEvent({ ...toolTarget, id: `pulse:${index}` }) as ActivityEvent;
    state = activityReducer(state, { type: 'event', event: { ...event, target: resolveActivityTarget(event, indexes) }, now: 2000 + index });
  }
  expect(state.pulses.length === MAX_ACTIVITY_PULSES && state.pulses.some(item => item.eventId === 'pulse:299'), 'activity pulses are capped like rays while retaining newest activity');
  for (let index = 0; index < MAX_ACTIVITY_EVENTS + 20; index += 1) {
    state = activityReducer(state, { type: 'event', event: { ...first, id: `bounded:${index}`, sequence: index, timestamp: new Date(2000 + index).toISOString() } });
  }
  expect(state.events.length === MAX_ACTIVITY_EVENTS, 'event history is bounded');
  expect(state.activeSessions.has('session:1'), 'active lifecycle state survives event history rollover');

  let replayGap: { requestedId?: string; oldestId?: string } | undefined;
  let closed = false;
  let requestedUrl = '';
  const listeners = new Map<string, EventListener>();
  const fakeSource = {
    onopen: null,
    onmessage: null,
    onerror: null,
    readyState: 1,
    addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
    close: () => { closed = true; },
  } as unknown as EventSource;
  const stream = connectActivityStream({
    lastEventId: 'cursor',
    workspaceId: 'local-9-abcdef12',
    eventSourceFactory: url => {
      requestedUrl = url;
      return fakeSource;
    },
    onEvent: () => undefined,
    onGap: gap => { replayGap = gap; },
  });
  expect(requestedUrl === '/api/activity/stream?workspaceId=local-9-abcdef12', 'EventSource URL carries only the selected workspace');
  listeners.get('replay-gap')?.({ data: JSON.stringify({ requestedId: '12', oldestId: '20' }) } as MessageEvent<string>);
  expect(replayGap?.requestedId === '12' && replayGap?.oldestId === '20', 'canonical replay-gap events expose requested and oldest IDs');
  fakeSource.onerror?.(new Event('error'));
  expect(!closed, 'native EventSource remains open for ordinary reconnect errors');
  stream.close();
  expect(closed, 'stream close cleans up the native EventSource');

  // ---- T2-B: network resources fan out to multiple targets ---------------
  // Full coverage lives in src/activity/targets.test.ts; this pins the same
  // `graph`/`indexes` fixture used above for path resolution to confirm a
  // curl-shaped event fans out through the real reducer without disturbing it.
  const curlEvent = parseActivityEvent({
    ...base,
    id: 'curl-integration',
    type: 'tool',
    tool: 'bash',
    resources: [
      { kind: 'url', name: 'a.example', ref: 'https://a.example/', provider: 'curl', action: 'network' },
      { kind: 'url', name: 'b.example', ref: 'https://b.example/', provider: 'curl', action: 'network' },
    ],
  }) as ActivityEvent;
  expect(activityType(curlEvent) === 'network', 'a curl event with only network resources classifies as network');
  const curlTargets = resolveActivityTargets(curlEvent, indexes);
  expect(curlTargets.length === 2
    && curlTargets[0].id === 'group:activity:web:a.example'
    && curlTargets[1].id === 'group:activity:web:b.example', 'a compound curl command resolves to one target per host');
  const networkState = activityReducer(initialActivityState(), { type: 'event', event: { ...curlEvent, targets: curlTargets, target: curlTargets[0] }, now: 5_000 });
  expect(networkState.rays.filter(item => item.eventId === 'curl-integration').length === 2, 'curl a.example && curl b.example produces two rays');
  const pathOnly = resolveActivityTarget(parseActivityEvent(base) as ActivityEvent, indexes);
  expect(pathOnly?.id === mapped?.id && pathOnly?.match === mapped?.match,
    'the original graph fixture still resolves an ordinary path resource exactly as before, now that resolveActivityTarget delegates to resolveActivityTargets');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('activity', runActivityAssertions);
