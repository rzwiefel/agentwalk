// T1-G / Wave 1.5 wiring: follow-agent (activityFollowTargetCentroid),
// dim-others (activityDimmedSessionIds), and number-key solo
// (activitySessionSoloFilter) -- the three App.tsx interactions that consume
// GraphCanvas's previously-inert followTarget/dimmedSessionIds props (25f3d4c).
// These are the pure pieces of that wiring, exported from App.tsx specifically
// so they're testable without rendering the component, matching how the other
// App.tsx helpers (activityWorkspacePath, isAgentActivityEvent, etc.) are
// tested elsewhere in this suite.
import { activityDimmedSessionIds, activityFollowTargetCentroid, activitySessionSoloFilter } from './App';
import type { ActivityRay } from './activity/types';
import type { ActivityAgentLayout, LayoutGroup, LayoutResult } from './types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Follow/dim assertion failed: ${message}`);
}

function group(id: string, center: [number, number, number]): LayoutGroup {
  return { id, parentId: null, path: id, label: id, depth: 0, center, size: [1, 1, 1], virtual: false, nodeCount: 0 };
}

function agentLayout(id: string, sessionId: string, center: [number, number, number]): ActivityAgentLayout {
  return { id, agentId: id, sessionId, label: id, status: 'active', activity: 'idle', color: '#fff', lastEventId: 'event:1', updatedAt: 1, center, size: [1, 1, 1] };
}

function ray(sourceAgentNodeId: string, target: ActivityRay['target']): Pick<ActivityRay, 'sourceAgentNodeId' | 'target'> {
  return { sourceAgentNodeId, target };
}

type PickedLayout = Pick<LayoutResult, 'positions' | 'groups' | 'activityAgents' | 'activityInactiveAgents'>;

function layoutOf(overrides: Partial<PickedLayout> = {}): PickedLayout {
  return { positions: new Map(), groups: [], activityAgents: [], activityInactiveAgents: [], ...overrides };
}

export function runActivityFollowAndDimAssertions(): void {
  // --- activityFollowTargetCentroid --------------------------------------
  const positions = new Map<string, [number, number, number]>([
    ['node:a', [0, 0, 0]],
    ['node:b', [10, 0, 0]],
  ]);
  const groups = [group('group:web', [0, 10, 0])];
  const rays = [
    ray('agent:one', { kind: 'node', id: 'node:a', match: 'node' }),
    ray('agent:one', { kind: 'node', id: 'node:b', match: 'node' }),
    ray('agent:two', { kind: 'node', id: 'node:a', match: 'node' }), // a different agent's ray must not leak in
  ];
  const centroidOfTwoNodes = activityFollowTargetCentroid('agent:one', rays, layoutOf({ positions, groups }));
  expect(centroidOfTwoNodes !== null && centroidOfTwoNodes[0] === 5 && centroidOfTwoNodes[1] === 0 && centroidOfTwoNodes[2] === 0,
    'centroid averages this agent\'s node-target ray positions and ignores another agent\'s rays');

  const mixedRays = [
    ray('agent:one', { kind: 'node', id: 'node:a', match: 'node' }),
    ray('agent:one', { kind: 'group', id: 'group:web', match: 'group' }),
  ];
  const centroidOfMixedTargets = activityFollowTargetCentroid('agent:one', mixedRays, layoutOf({ positions, groups }));
  expect(centroidOfMixedTargets !== null && centroidOfMixedTargets[0] === 0 && centroidOfMixedTargets[1] === 5 && centroidOfMixedTargets[2] === 0,
    'a group-kind ray target resolves through layout.groups, a node-kind one through layout.positions, and both fold into the same centroid');

  const danglingAndLiveRays = [
    ray('agent:one', { kind: 'node', id: 'node:missing', match: 'node' }),
    ray('agent:one', { kind: 'node', id: 'node:a', match: 'node' }),
  ];
  const centroidSkipsDangling = activityFollowTargetCentroid('agent:one', danglingAndLiveRays, layoutOf({ positions, groups }));
  expect(centroidSkipsDangling !== null && centroidSkipsDangling[0] === 0 && centroidSkipsDangling[1] === 0 && centroidSkipsDangling[2] === 0,
    'a ray target with no resolvable position is skipped rather than poisoning the centroid or throwing');

  const agents = [agentLayout('agent:one', 'session:one', [7, 7, 7])];
  const noRaysFallsBackToAgent = activityFollowTargetCentroid('agent:one', [], layoutOf({ positions, groups, activityAgents: agents }));
  expect(noRaysFallsBackToAgent !== null && noRaysFallsBackToAgent[0] === 7 && noRaysFallsBackToAgent[1] === 7 && noRaysFallsBackToAgent[2] === 7,
    'an agent with no recent ray targets falls back to following its own current position');

  const inactiveAgents = [agentLayout('agent:one', 'session:one', [3, 3, 3])];
  const fallsBackToInactiveGrid = activityFollowTargetCentroid('agent:one', [], layoutOf({ positions, groups, activityAgents: [], activityInactiveAgents: inactiveAgents }));
  expect(fallsBackToInactiveGrid !== null && fallsBackToInactiveGrid[0] === 3, 'the fallback also finds an agent that aged into the inactive grid');

  const unknownAgentReturnsNull = activityFollowTargetCentroid('agent:ghost', [], layoutOf({ positions, groups }));
  expect(unknownAgentReturnsNull === null, 'an agent with neither rays nor a known position resolves to null, meaning "leave the camera alone" per the followTarget contract');

  // --- activityDimmedSessionIds -------------------------------------------
  const knownSessions = ['session:a', 'session:b', 'session:c'];
  const noFilterDimsNothing = activityDimmedSessionIds(knownSessions, null);
  expect(noFilterDimsNothing.size === 0, 'no active session filter dims nothing, matching activityDimFactor\'s own "no filter" rule');

  const dimmed = activityDimmedSessionIds(knownSessions, new Set(['session:a']));
  expect(dimmed.size === 2 && dimmed.has('session:b') && dimmed.has('session:c') && !dimmed.has('session:a'),
    'dimmedSessionIds is the complement of the filter within the known session ids -- the selected session is never dimmed');

  const filterMentioningUnknownSession = activityDimmedSessionIds(['session:a'], new Set(['session:a', 'session:not-on-canvas']));
  expect(filterMentioningUnknownSession.size === 0,
    'a filter entry that is not among the known session ids does not produce a phantom dimmed entry');

  // --- activitySessionSoloFilter -------------------------------------------
  const soloFromNoFilter = activitySessionSoloFilter(null, 'session:a');
  expect(soloFromNoFilter !== null && soloFromNoFilter.size === 1 && soloFromNoFilter.has('session:a'),
    'soloing from no filter selects exactly that one session');

  const clearsOnSecondPress = activitySessionSoloFilter(new Set(['session:a']), 'session:a');
  expect(clearsOnSecondPress === null, 'soloing the session that is already the sole selection clears the filter (same-key-twice)');

  const switchesSolo = activitySessionSoloFilter(new Set(['session:a']), 'session:b');
  expect(switchesSolo !== null && switchesSolo.size === 1 && switchesSolo.has('session:b'),
    'soloing a different session switches the solo rather than clearing or adding to it');

  const multiSelectionSolos = activitySessionSoloFilter(new Set(['session:a', 'session:b']), 'session:a');
  expect(multiSelectionSolos !== null && multiSelectionSolos.size === 1 && multiSelectionSolos.has('session:a'),
    'soloing a session that is part of a larger manual multi-selection narrows to just that session rather than clearing (it was not already a solo)');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('activity follow and dim', runActivityFollowAndDimAssertions);
