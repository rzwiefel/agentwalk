import { activityArchitectureContextVisible, EMPTY_GRAPH } from './App';
import { buildActivityGraphIndexes, resolveActivityTarget } from './activity/graphResolver';
import { activityAgentIdentity, activityGroupId } from './activity/contract';
import { activityReducer, ACTIVITY_PULSE_COLORS, initialActivityState, MAX_ACTIVITY_RAYS } from './activity/reducer';
import type { ActivityEvent } from './activity/types';
import { activityGroupSpecs, computeLayout, withActivityGroups } from './layout';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Live file ray assertion failed: ${message}`);
}

const timestamp = '2026-08-28T12:00:00.000Z';

function event(id: string, file: string, workspace?: ActivityEvent['workspace']): ActivityEvent {
  return {
    schemaVersion: 1,
    id,
    sessionId: 'session:live-file-rays',
    timestamp,
    type: 'tool',
    status: 'started',
    tool: 'bash',
    workspace,
    resources: [{ action: 'read', file }],
  };
}

export function runLiveFileRayAssertions(): void {
  const indexes = buildActivityGraphIndexes(EMPTY_GRAPH, []);
  const workspace = { id: 'workspace:repo', root: '/workspace', repository: 'owner/repository' };
  const relative = event('relative-with-root', 'src/lib/app.ts', workspace);
  const relativeSpecs = activityGroupSpecs([relative], Date.parse(timestamp));
  const relativeTarget = resolveActivityTarget(relative, indexes);
  const relativeLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), relativeSpecs);
  const relativeProject = relativeSpecs.find(spec => spec.kind === 'project');
  const relativeFile = relativeLayout.groups.find(group => group.activity?.kind === 'file' && group.activity.path === '/workspace/src/lib/app.ts');
  expect(relativeProject?.label === 'repository'
    && relativeFile !== undefined
    && relativeTarget?.kind === 'group'
    && relativeTarget.id === relativeFile.id, 'workspace-relative reads use the repository hierarchy and target its file group');
  const relativeState = activityReducer(initialActivityState(), { type: 'event', event: { ...relative, target: relativeTarget }, now: 100 });
  expect(relativeTarget !== undefined && relativeState.rays.some(ray => ray.sourceAgentNodeId === activityAgentIdentity(relative)
    && ray.target.id === relativeTarget.id
    && ray.sourceGroupId === undefined
    && ray.color === ACTIVITY_PULSE_COLORS.read),
  'workspace-relative reads emit a direct blue agent-to-file ray');
  const fileRead = { ...relative, id: 'file-read-without-tool', type: 'file.read' as const, tool: undefined };
  const fileReadTarget = resolveActivityTarget(fileRead, indexes);
  const fileReadState = activityReducer(initialActivityState(), { type: 'event', event: { ...fileRead, target: fileReadTarget }, now: 110 });
  expect(activityGroupId(fileRead) === undefined
    && fileReadTarget !== undefined
    && fileReadState.rays.some(ray => ray.sourceAgentNodeId === activityAgentIdentity(fileRead)
      && ray.target.id === fileReadTarget.id
      && ray.sourceGroupId === undefined
      && ray.color === ACTIVITY_PULSE_COLORS.read),
  'file.read events without a tool still emit a direct blue agent-to-file ray');

  const withoutRoot = event('relative-without-root', 'src/ad-hoc.ts', { id: 'workspace:ad-hoc', repository: 'ad-hoc-repository' });
  const withoutRootSpecs = activityGroupSpecs([withoutRoot], Date.parse(timestamp));
  const withoutRootTarget = resolveActivityTarget(withoutRoot, indexes);
  const withoutRootFile = withoutRootSpecs.find(spec => spec.kind === 'file' && spec.path === 'src/ad-hoc.ts');
  expect(withoutRootSpecs.some(spec => spec.kind === 'project' && spec.label === 'ad-hoc-repository')
    && withoutRootTarget?.id === withoutRootFile?.id, 'relative reads without a root use a deterministic repository fallback without inventing an absolute root');

  const absolute = event('absolute', '/Users/alice/repository/src/absolute.ts');
  const absoluteSpecs = activityGroupSpecs([absolute], Date.parse(timestamp));
  const absoluteTarget = resolveActivityTarget(absolute, indexes);
  const absoluteFile = absoluteSpecs.find(spec => spec.kind === 'file' && spec.path === '/Users/alice/repository/src/absolute.ts');
  expect(absoluteTarget?.id === absoluteFile?.id && absoluteSpecs.some(spec => spec.kind === 'project' && spec.label === 'repository'),
    'absolute reads use the same deterministic target ID as their nested layout file');

  let bounded = initialActivityState();
  const boundedEvents = Array.from({ length: MAX_ACTIVITY_RAYS + 12 }, (_, index) => {
    const current = event(`bounded-${index}`, `src/file-${index}.ts`);
    return { ...current, target: resolveActivityTarget(current, indexes) };
  });
  boundedEvents.forEach((current, index) => {
    bounded = activityReducer(bounded, { type: 'event', event: current, now: 1_000 + index });
  });
  expect(bounded.rays.length === MAX_ACTIVITY_RAYS
    && bounded.rays.some(ray => ray.eventId === `bounded-${MAX_ACTIVITY_RAYS + 11}`), 'distinct file accesses emit one ray each while retaining the bounded newest rays');

  const activityLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), activityGroupSpecs([relative], Date.parse(timestamp)));
  const activityBaseLayout = computeLayout(EMPTY_GRAPH);
  const activityHierarchyRoot = activityLayout.groups.find(group => group.activity
    && group.parentId === null
    && group.activity.kind !== 'bash'
    && group.activity.kind !== 'tool');
  const activityTool = activityLayout.groups.find(group => group.activity?.kind === 'bash');
  const spatialDistance = activityHierarchyRoot && activityTool
    ? Math.hypot(...activityHierarchyRoot.center.map((axis, index) => axis - activityTool.center[index]))
    : 0;
  const requiredClearance = activityHierarchyRoot && activityTool
    ? Math.hypot(...activityHierarchyRoot.size) / 2
      + Math.hypot(...activityTool.size) / 2
    : Infinity;
  expect(activityArchitectureContextVisible('activity', false) === false
    && activityArchitectureContextVisible('activity', true)
    && activityLayout.groups.every(group => Boolean(group.activity))
    && activityHierarchyRoot !== undefined
    && activityTool !== undefined
    && activityTool.center[2] === activityBaseLayout.hierarchyBounds.center[2]
    && spatialDistance >= requiredClearance,
  'static architecture remains hidden by default while activity hierarchies spread clear of the central operator hub');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('live file rays', runLiveFileRayAssertions);
