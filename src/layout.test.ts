import { ACTIVITY_AGENT_GLYPH_SCALE, ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS, ACTIVITY_GROUP_TTL_MS, activityGroupSpecs, activityLayoutSignature, computeLayout, withActivityAgentNodes, withActivityGroups } from './layout';
import { isGlobalNode } from './namespaceVisibility';
import { createPhysicsState, stepPhysics } from './physics';
import type { ActivityAgentNode, ActivityEvent, ActivityRay } from './activity/types';
import type { CodeGraph, CodeNode, LayoutResult } from './types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Layout assertion failed: ${message}`);
}

const namespace = (id: string, name: string): CodeNode => ({
  id,
  kind: 'namespace',
  label: name,
  namespace: name,
});

const variable = (id: string, namespaceName?: string): CodeNode => ({
  id,
  kind: 'var',
  label: id,
  namespace: namespaceName,
});

function graph(nodes: CodeNode[]): CodeGraph {
  return {
    formatVersion: 2,
    generatedAt: '2026-08-25T00:00:00.000Z',
    repo: { name: 'layout-fixture', root: '/fixture' },
    nodes,
    edges: [{
      id: 'requires:app->global',
      kind: 'requires',
      source: 'namespace:app',
      target: 'namespace:global',
    }],
    stats: { nodes: nodes.length, edges: 1, namespaces: nodes.filter(node => node.kind === 'namespace').length, vars: nodes.filter(node => node.kind === 'var').length },
  };
}

function distance(left: [number, number, number], right: [number, number, number]): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function fixture(extraGlobalCount = 2): CodeGraph {
  const globals = [
    namespace('namespace:global', '<global>'),
    ...Array.from({ length: extraGlobalCount }, (_, index) => variable(`var:global/${index}`, '<global>')),
    variable('var:unscoped'),
  ];
  return graph([
    namespace('namespace:app', 'app'),
    namespace('namespace:app.ui', 'app.ui'),
    variable('var:app/start', 'app'),
    variable('var:app.ui/render', 'app.ui'),
    ...globals,
    { id: 'unresolved:external', kind: 'var', label: 'Missing.Type', namespace: undefined, synthetic: true, external: true },
  ]);
}

export function runLayoutAssertions(): void {
  const base = fixture();
  const bottom = computeLayout(base);
  const globalGroup = bottom.groups.find(group => group.global);
  expect(globalGroup !== undefined, 'default mode retains a global bottom box');
  expect(globalGroup?.nodeCount === 4, 'default global box includes namespace-less nodes');
  expect((globalGroup?.center[1] ?? 0) < 0, 'default global box remains below the hierarchy');
  expect(bottom.orbit === undefined, 'default mode does not expose orbit metadata');
  expect(isGlobalNode(base.nodes.find(node => node.id === 'unresolved:external') as CodeNode) === false,
    'external unresolved nodes are not global-owned');

  const orbit = computeLayout(base, undefined, { globalNamespaceMode: 'orbit', nodeScale: 1 });
  expect(orbit.groups.every(group => !group.global), 'orbit mode suppresses the global hierarchy box');
  expect(orbit.orbit !== undefined, 'orbit mode reports shell geometry');
  const shell = orbit.orbit;
  if (!shell) return;
  expect(shell.globalNodeIds.includes('var:unscoped'), 'orbit mode includes namespace-less nodes');
  const hierarchyExtent = orbit.hierarchyBounds.diagonal / 2;
  shell.globalNodeIds.forEach(id => {
    const point = orbit.positions.get(id);
    expect(point !== undefined && distance(point, shell.center) > hierarchyExtent, 'global nodes clear hierarchy bounds');
  });
  expect(shell.radius > hierarchyExtent, 'shell radius clears hierarchy diagonal with margin');
  const globalNodes = new Map(base.nodes.filter(isGlobalNode).map(node => [node.id, node]));
  for (let index = 0; index < shell.globalNodeIds.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < shell.globalNodeIds.length; otherIndex += 1) {
      const first = shell.globalNodeIds[index];
      const second = shell.globalNodeIds[otherIndex];
      const firstPoint = orbit.positions.get(first);
      const secondPoint = orbit.positions.get(second);
      const firstNode = globalNodes.get(first);
      const secondNode = globalNodes.get(second);
      if (!firstPoint || !secondPoint || !firstNode || !secondNode) continue;
      const firstClearance = (firstNode.kind === 'namespace' ? 1.4 : firstNode.kind === 'var' ? 0.9 : 0.7) + 1.8;
      const secondClearance = (secondNode.kind === 'namespace' ? 1.4 : secondNode.kind === 'var' ? 0.9 : 0.7) + 1.8;
      expect(distance(firstPoint, secondPoint) >= firstClearance + secondClearance,
        'shell collision spacing keeps global nodes separated');
    }
  }

  const reversed = computeLayout({ ...base, nodes: [...base.nodes].reverse() }, undefined, { globalNamespaceMode: 'orbit' });
  base.nodes.forEach(node => {
    const first = orbit.positions.get(node.id);
    const second = reversed.positions.get(node.id);
    expect(first !== undefined && second !== undefined && distance(first, second) < 0.000001, 'positions are input-order independent');
  });

  const added = computeLayout(graph([...base.nodes, variable('var:global/new', '<global>')]), undefined, { globalNamespaceMode: 'orbit' });
  shell.globalNodeIds.forEach(id => {
    const first = orbit.positions.get(id);
    const second = added.positions.get(id);
    expect(first !== undefined && second !== undefined && distance(first, second) < 0.000001, 'unchanged global IDs keep their shell positions');
  });

  expect(computeLayout(fixture(0), undefined, { globalNamespaceMode: 'orbit' }).orbit?.globalNodeIds.length === 2,
    'global and namespace-less nodes receive shell positions');
  expect(computeLayout(fixture(20), undefined, { globalNamespaceMode: 'orbit' }).orbit?.globalNodeIds.length === 22,
    'many global nodes receive deterministic shell positions');
  expect(computeLayout(graph([namespace('namespace:app', 'app')]), undefined, { globalNamespaceMode: 'orbit' }).orbit === undefined,
    'empty global ownership has no shell');
  expect(computeLayout(base, undefined, { globalNamespaceMode: 'bottom', showGlobalNamespace: false }).groups.every(group => !group.global),
    'show global namespace false suppresses the global composition');

  const chainGraph = graph([
    namespace('namespace:chain', 'chain'),
    namespace('namespace:chain.one', 'chain.one'),
    namespace('namespace:chain.one.two', 'chain.one.two'),
  ]);
  const chainLayout = computeLayout(chainGraph);
  const chainGroups = ['chain', 'chain.one', 'chain.one.two'].map(path => chainLayout.groups.find(group => group.path === path));
  expect(chainGroups.every(Boolean)
    && chainGroups.slice(1).every((group, index) => group !== undefined
      && chainGroups[index] !== undefined
      && group.size.every((axis, sizeIndex) => axis < chainGroups[index]!.size[sizeIndex]))
    && new Set(chainGroups.map(group => group?.center.join(','))).size === chainGroups.length,
  'single-child namespace chains receive visibly inset nested bounds');

  // Defect-3 regression: volumePoint() sized its packing grid from
  // count/volume alone, with zero regard for how large a node actually
  // renders (nodeScale, and orbitPositions' own per-kind clearance) -- so
  // vars packed into a tightly-nested namespace could interpenetrate
  // regardless of nodeScale, and cranking nodeScale up (bigger diamonds)
  // never widened the gap between them to compensate. Build a namespace
  // tree with real depth and fan-out (mirroring a mid-size ClojureScript
  // app) so a few leaf namespaces end up in genuinely small boxes, the
  // same regime as tightly nested feature directories.
  const packingTopSegments = ['sample-app', 'other-lib', 'shared'];
  const packingMidSegments = ['cljs', 'cljc', 'clj'];
  const packingFeatureSegments = ['widgets', 'panels', 'views', 'events', 'subs', 'routes', 'modal', 'nav', 'core', 'utils'];
  const packingLeafSegments = ['a', 'b', 'c', 'd'];
  const packingNamespaceNames: string[] = [];
  packingTopSegments.forEach(top => packingMidSegments.forEach(mid => packingFeatureSegments.forEach(feature => {
    packingNamespaceNames.push(`${top}.${mid}.${feature}`);
    packingLeafSegments.forEach(leaf => packingNamespaceNames.push(`${top}.${mid}.${feature}.${leaf}`));
  })));
  const packingTargetNamespaces = ['sample-app.cljc.widgets.panels.a', 'sample-app.cljc.widgets.panels', 'sample-app.cljs.views.a'];
  const packingVarNodes = packingTargetNamespaces.flatMap(ns =>
    Array.from({ length: 5 }, (_, i) => variable(`var:${ns}/fn${i}`, ns)));
  const packingGraph = graph([
    ...packingNamespaceNames.map(name => namespace(`ns:${name}`, name)),
    ...packingVarNodes,
  ]);
  const packingClearance = 2 * (0.9 * 1 + 1.8); // 'var' kind, nodeScale 1 -- matches orbitPositions' own clearance formula
  const packingLayoutDefault = computeLayout(packingGraph, undefined, { nodeScale: 1 });
  const minDistanceAt = (layout: LayoutResult, ns: string) => {
    const positions = packingVarNodes.filter(node => node.namespace === ns).map(node => layout.positions.get(node.id)!);
    let min = Infinity;
    for (let index = 0; index < positions.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < positions.length; otherIndex += 1) {
        min = Math.min(min, distance(positions[index], positions[otherIndex]));
      }
    }
    return min;
  };
  expect(packingTargetNamespaces.every(ns => minDistanceAt(packingLayoutDefault, ns) >= packingClearance),
  'var nodes packed into a realistically tight leaf namespace clear 2x their orbitPositions-equivalent clearance at the default nodeScale');

  // The bug this replaces: packing density came from count/volume alone,
  // so minimum spacing never moved even as nodeScale (and so each node's
  // rendered half-extent) grew. Confirm spacing now actually responds.
  const packingLayoutLargeScale = computeLayout(packingGraph, undefined, { nodeScale: 4 });
  expect(packingTargetNamespaces.some(ns => Math.abs(minDistanceAt(packingLayoutDefault, ns) - minDistanceAt(packingLayoutLargeScale, ns)) > 0.01),
  'packing spacing responds to nodeScale instead of being fixed by count/volume alone');

  const revised = computeLayout({ ...base, revision: { commit: 'next', mode: 'full', changedFiles: [], addedFiles: [], deletedFiles: [], renamedFiles: [], limitations: [] } }, bottom, { globalNamespaceMode: 'orbit', nodeScale: 1.6 });
  expect(revised.orbit?.radius !== shell.radius, 'layout inputs recompute shell geometry');
  const edge = base.edges[0];
  expect(revised.positions.has(edge.source) && revised.positions.has(edge.target), 'edge endpoints retain positions across layout recomputation');

  const agents: ActivityAgentNode[] = [
    { id: 'agent:one', agentId: 'one', sessionId: 'session:one', label: 'Agent · one', status: 'running', activity: 'Search: search', color: '#df8eff', lastEventId: 'event:one', updatedAt: 1 },
    { id: 'agent:two', agentId: 'two', sessionId: 'session:two', label: 'Agent · two', status: 'waiting', activity: 'agent.waiting · waiting', color: '#7898ff', lastEventId: 'event:two', updatedAt: 2 },
  ];
  const agentLayout = withActivityAgentNodes(bottom, agents, 2);
  expect(agentLayout.activityAgents?.length === 2, 'activity layout includes one marker per distinct agent');
  expect(agentLayout.activityAgents?.every(agent => (agent.center[1] > bottom.hierarchyBounds.center[1] + bottom.hierarchyBounds.size[1] / 2)) ?? false, 'activity markers sit above the hierarchy');
  const firstAgent = agentLayout.activityAgents?.[0];
  const secondAgent = agentLayout.activityAgents?.[1];
  expect(firstAgent !== undefined && secondAgent !== undefined && distance(firstAgent.center, secondAgent.center) > 0, 'activity markers use a circular arrangement');
  expect(firstAgent?.center[1] === bottom.hierarchyBounds.center[1] + bottom.hierarchyBounds.size[1] / 2 + 64, 'activity ring stays above the operator tool boxes with deliberate vertical separation from the hierarchy');
  expect(ACTIVITY_AGENT_GLYPH_SCALE === 3
    && firstAgent?.size.join(',') === '16.2,13.8,11.4'
    && secondAgent !== undefined
    && distance(firstAgent?.center ?? [0, 0, 0], secondAgent.center) > 21.6, 'agent glyphs use the integrated 50 percent size increase and expanded ring spacing');
  const inactiveLayout = withActivityAgentNodes(bottom, agents, ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS + 2);
  const inactivePositions = inactiveLayout.activityInactiveAgents?.map(agent => agent.center) ?? [];
  expect(inactiveLayout.activityAgents === undefined
    && inactiveLayout.activityInactiveAgents?.length === 2
    && new Set(inactivePositions.map(position => position.join(','))).size === 2
    && inactivePositions.every(position => position[1] === inactivePositions[0]?.[1])
    && Math.abs(inactivePositions[0]?.[0] ?? 0) < 15
    && Math.abs(inactivePositions[1]?.[0] ?? 0) < 15
    && (inactivePositions[0]?.[1] ?? 0) - (firstAgent?.center[1] ?? 0) >= 73.5, 'agents cross the named ten-minute boundary into a compact upper inactive grid');
  const manyInactiveAgents = Array.from({ length: 100 }, (_, index) => ({
    ...agents[0],
    id: `agent:inactive:${index}`,
    agentId: `inactive:${index}`,
    sessionId: `session:inactive:${index}`,
  }));
  const manyInactiveLayout = withActivityAgentNodes(bottom, manyInactiveAgents, ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS + 2);
  const manyInactivePositions = manyInactiveLayout.activityInactiveAgents?.map(agent => agent.center) ?? [];
  const inactiveXExtent = Math.max(...manyInactivePositions.map(position => position[0]))
    - Math.min(...manyInactivePositions.map(position => position[0]));
  const inactiveZExtent = Math.max(...manyInactivePositions.map(position => position[2]))
    - Math.min(...manyInactivePositions.map(position => position[2]));
  expect(manyInactivePositions.length === 100 && inactiveXExtent <= 130 && inactiveZExtent <= 109,
    'many inactive agents stay within a compact grid instead of expanding into a count-sized ring');
  const revivedLayout = withActivityAgentNodes(bottom, [{ ...agents[0], updatedAt: ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS + 2 }, agents[1]], ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS + 2);
  expect(Boolean(revivedLayout.activityAgents?.some(agent => agent.id === agents[0].id)
    && revivedLayout.activityInactiveAgents?.some(agent => agent.id === agents[1].id)), 'new activity revives an inactive agent into the active ring');
  expect(withActivityAgentNodes(bottom, []).activityAgents === undefined, 'empty activity telemetry has no agent markers');

  const northTarget = { ...bottom.groups[0], id: 'group:activity:north', center: [0, 0, 100] as [number, number, number] };
  const southTarget = { ...bottom.groups[0], id: 'group:activity:south', center: [0, 0, -100] as [number, number, number] };
  const targetedLayout = { ...bottom, groups: [...bottom.groups, northTarget, southTarget] };
  const initialAgentLayout = withActivityAgentNodes(targetedLayout, agents, 2);
  const targetRays: ActivityRay[] = [
    { id: 'ray:one', eventId: 'event:ray-one', sessionId: agents[0].sessionId, sourceAgentNodeId: agents[0].id, target: { kind: 'group', id: northTarget.id, match: 'group' }, color: '#4da3ff', startedAt: 10, expiresAt: 100 },
    { id: 'ray:two', eventId: 'event:ray-two', sessionId: agents[1].sessionId, sourceAgentNodeId: agents[1].id, target: { kind: 'group', id: southTarget.id, match: 'group' }, color: '#4da3ff', startedAt: 10, expiresAt: 100 },
  ];
  const attractedAgentLayout = withActivityAgentNodes(targetedLayout, agents, 3, targetRays, initialAgentLayout);
  const easedAgentLayout = withActivityAgentNodes(targetedLayout, agents, 4, targetRays, attractedAgentLayout);
  const initialOne = initialAgentLayout.activityAgents?.find(agent => agent.id === agents[0].id);
  const attractedOne = attractedAgentLayout.activityAgents?.find(agent => agent.id === agents[0].id);
  const easedOne = easedAgentLayout.activityAgents?.find(agent => agent.id === agents[0].id);
  expect(initialOne !== undefined && attractedOne !== undefined && easedOne !== undefined
    && distance(attractedOne.center, northTarget.center) < distance(initialOne.center, northTarget.center)
    && distance(easedOne.center, northTarget.center) < distance(attractedOne.center, northTarget.center)
    && distance(initialOne.center, attractedOne.center) < 1
    && distance(attractedOne.center, easedOne.center) < 1,
  'the agent ring eases toward current hierarchy targets in small consistent steps');

  // T1-G: withActivityAgentNodes must forward the three T1-B signal fields
  // (waitingSince/waitingToolCallId/lastDeniedAt) from ActivityAgentNode onto the
  // ActivityAgentLayout it builds. GraphCanvas's agentGlyphAppearance reads them
  // directly off the layout object, not off the source ActivityAgentNode, so a
  // builder that dropped them would silently blank the waiting halo and denied
  // flash with no error anywhere -- exactly the kind of gap this pins.
  const waitingDeniedAgents: ActivityAgentNode[] = [
    { id: 'agent:waiting', agentId: 'waiting', sessionId: 'session:waiting', label: 'Agent · waiting', status: 'waiting', activity: 'permission', color: '#f5b942', lastEventId: 'event:waiting', updatedAt: 5, waitingSince: 3, waitingToolCallId: 'call:1' },
    { id: 'agent:denied', agentId: 'denied', sessionId: 'session:denied', label: 'Agent · denied', status: 'active', activity: 'permission', color: '#ff5c68', lastEventId: 'event:denied', updatedAt: 6, lastDeniedAt: 6 },
  ];
  const signalLayout = withActivityAgentNodes(bottom, waitingDeniedAgents, 6);
  const waitingLayoutAgent = signalLayout.activityAgents?.find(agent => agent.id === 'agent:waiting');
  const deniedLayoutAgent = signalLayout.activityAgents?.find(agent => agent.id === 'agent:denied');
  expect(waitingLayoutAgent?.waitingSince === 3 && waitingLayoutAgent?.waitingToolCallId === 'call:1',
    'the layout builder carries waitingSince/waitingToolCallId from the agent node onto ActivityAgentLayout, or the amber halo never appears');
  expect(deniedLayoutAgent?.lastDeniedAt === 6,
    'the layout builder carries lastDeniedAt from the agent node onto ActivityAgentLayout, or the denied flash never appears');
  expect(waitingLayoutAgent?.lastDeniedAt === undefined && deniedLayoutAgent?.waitingSince === undefined && deniedLayoutAgent?.waitingToolCallId === undefined,
    'agents without a signal field do not pick one up from a different agent in the same layout pass');

  const physics = createPhysicsState(base, bottom.positions, bottom.groups, new Set(base.nodes.map(node => node.id)), base.edges);
  const appGroup = bottom.groups.find(group => group.path === 'app');
  const uiGroup = bottom.groups.find(group => group.path === 'app.ui');
  const appNode = physics.nodePositions.get('var:app/start');
  if (appGroup && uiGroup && appNode) {
    physics.groupPositions.set(uiGroup.id, [1_000, 1_000, 1_000]);
    appNode.splice(0, 3, 1_000, 1_000, 1_000);
    stepPhysics(physics, base, bottom.groups, base.edges, 1 / 60);
    const parentPosition = physics.groupPositions.get(appGroup.id);
    const childPosition = physics.groupPositions.get(uiGroup.id);
    const constrainedNode = physics.nodePositions.get('var:app/start');
    expect(parentPosition !== undefined && childPosition !== undefined && constrainedNode !== undefined
      && childPosition.every((axis, index) =>
        Math.abs(axis - parentPosition[index]) <= Math.max(0, (appGroup.size[index] - uiGroup.size[index]) / 2 - 0.8) + 0.001)
      && constrainedNode.every((axis, index) =>
        Math.abs(axis - parentPosition[index]) <= appGroup.size[index] / 2),
    'local gravity keeps child groups and code nodes inside their parent hierarchy');
  } else {
    expect(false, 'physics containment fixture includes app hierarchy members');
  }

  // P1-7: activityLayoutSignature must be stable across `now` values that
  // cross no liveness threshold, so App.tsx can gate the expensive
  // withActivityGroups/withActivityAgentNodes packing on it instead of on the
  // raw 1 Hz `now` tick, and that gating must not change what gets packed.
  const activityPackingBase = Date.parse('2026-08-30T12:00:00.000Z');
  const activityPackingEvents: ActivityEvent[] = [
    {
      schemaVersion: 1,
      id: 'packing:read',
      sessionId: 'session:packing',
      timestamp: '2026-08-30T12:00:00.000Z',
      type: 'file.read',
      agentId: 'packing-agent',
      workspace: { root: '/workspace' },
      resources: [{ action: 'read', file: '/workspace/src/app.ts' }],
    },
    {
      schemaVersion: 1,
      id: 'packing:write',
      sessionId: 'session:packing',
      timestamp: '2026-08-30T12:00:01.000Z',
      type: 'file.write',
      agentId: 'packing-agent',
      workspace: { root: '/workspace' },
      resources: [{ action: 'write', file: '/workspace/src/util.ts' }],
    },
    {
      schemaVersion: 1,
      id: 'packing:bash',
      sessionId: 'session:packing',
      timestamp: '2026-08-30T12:00:02.000Z',
      type: 'tool',
      agentId: 'packing-agent',
      tool: 'bash',
      snippet: 'echo hi',
    },
  ];
  const activityPackingAgents: ActivityAgentNode[] = [
    { id: 'agent:packing', agentId: 'packing-agent', sessionId: 'session:packing', label: 'Agent · packing', status: 'active', activity: 'Tool: bash', color: '#4da3ff', lastEventId: 'packing:bash', updatedAt: activityPackingBase + 2000 },
  ];
  const activityPackingNow1 = activityPackingBase + 4000;
  const activityPackingNow2 = activityPackingBase + 9000;
  const activityPackingSignature1 = activityLayoutSignature(activityPackingEvents, activityPackingAgents, activityPackingNow1);
  const activityPackingSignature2 = activityLayoutSignature(activityPackingEvents, activityPackingAgents, activityPackingNow2);
  expect(activityPackingSignature1 === activityPackingSignature2, 'the activity layout signature is stable across now values that cross no liveness threshold');
  const activityPackingResultAtNow1 = withActivityAgentNodes(withActivityGroups(bottom, activityGroupSpecs(activityPackingEvents, activityPackingNow1)), activityPackingAgents, activityPackingNow1);
  const activityPackingResultAtNow2 = withActivityAgentNodes(withActivityGroups(bottom, activityGroupSpecs(activityPackingEvents, activityPackingNow2)), activityPackingAgents, activityPackingNow2);
  expect(JSON.stringify(activityPackingResultAtNow1.groups) === JSON.stringify(activityPackingResultAtNow2.groups),
    'packed activity group positions are identical for now values that do not cross a liveness threshold');
  expect(JSON.stringify(activityPackingResultAtNow1.activityAgents) === JSON.stringify(activityPackingResultAtNow2.activityAgents),
    'packed activity agent positions are identical for now values that do not cross a liveness threshold');

  // Mirrors the useMemo(..., [activityLayoutKey, ...]) gating App.tsx performs:
  // a single-slot cache keyed by the signature. Two "renders" at now1/now2
  // below any threshold must invoke the expensive pack exactly once.
  let activityPackCallCount = 0;
  const computeActivityPacking = (now: number): LayoutResult => {
    activityPackCallCount += 1;
    return withActivityAgentNodes(withActivityGroups(bottom, activityGroupSpecs(activityPackingEvents, now)), activityPackingAgents, now);
  };
  let memoizedActivitySignature: string | undefined;
  let memoizedActivityResult: LayoutResult | undefined;
  const memoizedActivityPack = (now: number): LayoutResult => {
    const signature = activityLayoutSignature(activityPackingEvents, activityPackingAgents, now);
    if (signature !== memoizedActivitySignature) {
      memoizedActivityResult = computeActivityPacking(now);
      memoizedActivitySignature = signature;
    }
    return memoizedActivityResult as LayoutResult;
  };
  const firstMemoizedActivityPack = memoizedActivityPack(activityPackingNow1);
  const secondMemoizedActivityPack = memoizedActivityPack(activityPackingNow2);
  expect(activityPackCallCount === 1, 'gating the expensive pack on activityLayoutSignature (as App.tsx does) skips recompute across a now tick that changes nothing');
  expect(firstMemoizedActivityPack === secondMemoizedActivityPack, 'the signature-gated cache returns the same layout reference when now alone changes');

  const activityPackingInactiveNow = activityPackingBase + ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS + 5000;
  const activityPackingSignatureInactive = activityLayoutSignature(activityPackingEvents, activityPackingAgents, activityPackingInactiveNow);
  expect(activityPackingSignature1 !== activityPackingSignatureInactive, 'the activity layout signature changes once an agent crosses the inactive-grid threshold');
  const activityPackingInactiveResult = withActivityAgentNodes(withActivityGroups(bottom, activityGroupSpecs(activityPackingEvents, activityPackingInactiveNow)), activityPackingAgents, activityPackingInactiveNow);
  expect(activityPackingInactiveResult.activityAgents === undefined && activityPackingInactiveResult.activityInactiveAgents?.length === 1,
    'agents still move to the inactive grid after ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS once packing re-runs for a changed signature');

  const activityPackingExpiredNow = activityPackingBase + ACTIVITY_GROUP_TTL_MS + 5000;
  const activityPackingSignatureExpired = activityLayoutSignature(activityPackingEvents, activityPackingAgents, activityPackingExpiredNow);
  expect(activityPackingSignature1 !== activityPackingSignatureExpired, 'the activity layout signature changes once a group crosses its retention/fade expiry');
  expect(activityGroupSpecs(activityPackingEvents, activityPackingExpiredNow).length === 0,
    'groups still expire per ACTIVITY_GROUP_RETENTION_MS / ACTIVITY_GROUP_FADE_MS once now advances past their TTL');

  // T2-C: activityGroupSpecs also emits 'web'/'domain' kinds (see
  // src/activity/types.ts ActivityGroupKind) for {kind:'url', name} resources.
  // The signature must pick up a newly-seen host exactly like a newly-seen
  // file, and stay stable across now alone when no host is added. Full
  // web/domain spec-shape and placement coverage lives in activityWeb.test.ts.
  const webSignatureBase = Date.parse('2026-08-31T09:00:00.000Z');
  const webSignatureEvents: ActivityEvent[] = [{
    schemaVersion: 1,
    id: 'web-signature-hit',
    sessionId: 'session:web-signature',
    timestamp: '2026-08-31T09:00:00.000Z',
    type: 'tool',
    tool: 'bash',
    resources: [{ kind: 'url', name: 'api.example.com', ref: 'https://api.example.com/v1', provider: 'http', action: 'network' }],
  }];
  const webSignatureNow1 = webSignatureBase + 3000;
  const webSignatureNow2 = webSignatureBase + 8000;
  const webSignature1 = activityLayoutSignature(webSignatureEvents, [], webSignatureNow1);
  const webSignature2 = activityLayoutSignature(webSignatureEvents, [], webSignatureNow2);
  expect(webSignature1 === webSignature2,
    'the activity layout signature is stable across now ticks for web/domain groups when no new host appears');
  const webSignatureWithNewHost = activityLayoutSignature([
    ...webSignatureEvents,
    {
      schemaVersion: 1,
      id: 'web-signature-second-host',
      sessionId: 'session:web-signature',
      timestamp: '2026-08-31T09:00:00.000Z',
      type: 'tool',
      tool: 'bash',
      resources: [{ kind: 'url', name: 'cdn.example.net', ref: 'https://cdn.example.net/a.js', provider: 'http', action: 'network' }],
    },
  ], [], webSignatureNow1);
  expect(webSignature1 !== webSignatureWithNewHost,
    'the activity layout signature changes once a new host appears, the same as a newly-seen file');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('layout', runLayoutAssertions);
