import { EMPTY_GRAPH } from './App';
import { activityAgentIdentity, parseActivityEvent } from './activity/contract';
import { ACTIVITY_PULSE_COLORS } from './activity/reducer';
import { buildActivityGraphIndexes, resolveActivityTarget } from './activity/graphResolver';
import { activityReducer, initialActivityState } from './activity/reducer';
import { activityFileLabelIds, MAX_ACTIVITY_FILE_LABELS } from './components/GraphCanvas';
import { activityGroupSpecs, computeLayout, withActivityGroups, ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS } from './layout';
import type { ActivityEvent, ActivityPulse } from './activity/types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Activity spatial polish assertion failed: ${message}`);
}

const timestamp = '2026-08-28T12:00:00.000Z';
const base = {
  schemaVersion: 1 as const,
  sessionId: 'session:spatial-polish',
  timestamp,
  type: 'tool.execution_start' as const,
  tool: 'apply_patch',
  workspace: { id: 'workspace:spatial-polish', root: '/workspace' },
};

function event(id: string, resources: ActivityEvent['resources'], extra: Record<string, unknown> = {}): ActivityEvent {
  return parseActivityEvent({ ...base, id, resources, ...extra }) as ActivityEvent;
}

function fileEvents(count: number): ActivityEvent[] {
  return [{
    schemaVersion: 1,
    id: 'sibling-set',
    sessionId: 'session:spatial-polish',
    timestamp,
    type: 'file.read',
    workspace: { id: 'workspace:spatial-polish', root: '/workspace' },
    resources: Array.from({ length: count }, (_, index) => ({
      file: `src/file-${String(index).padStart(2, '0')}.ts`,
      action: 'read' as const,
    })),
  }];
}

export function runActivitySpatialPolishAssertions(): void {
  expect(ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS === 300000, 'agents enter the inactive grid after exactly five minutes');

  const projectEvents = [{
    schemaVersion: 1 as const,
    id: 'three-projects',
    sessionId: 'session:projects',
    timestamp,
    type: 'file.read' as const,
    resources: [
      { file: '/Users/alice/repo-a/src/a.ts', action: 'read' as const },
      { file: '/Users/alice/repo-b/src/b.ts', action: 'read' as const },
      { file: '/Users/alice/repo-c/src/c.ts', action: 'read' as const },
    ],
  } as ActivityEvent];
  const projectSpecs = activityGroupSpecs(projectEvents, Date.parse(timestamp));
  const projectLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), projectSpecs);
  const projects = projectLayout.groups.filter(group => group.activity?.kind === 'project');
  expect(projects.length === 3 && new Set(projects.map(project => project.center.join(','))).size === 3,
    'three project roots occupy distinct deterministic positions around the center');
  expect(projects.every((left, leftIndex) => projects.every((right, rightIndex) => leftIndex === rightIndex || [0, 1, 2].some(axis =>
    Math.abs(left.center[axis] - right.center[axis]) >= (left.size[axis] + right.size[axis]) / 2 + 6,
  ))), 'top-level project volumes keep a visible gap and do not overlap');
  expect(new Set(projects.map(project => project.center[1].toFixed(4))).size === 1,
    'the highest-priority project positions begin on an equatorial ring');
  const projectAngles = new Set(projects.map(project =>
    Math.atan2(project.center[2] - projectLayout.hierarchyBounds.center[2], project.center[0] - projectLayout.hierarchyBounds.center[0]).toFixed(4)));
  expect(projectAngles.size === projects.length,
    'the preferred equatorial positions spread around the operator hub');
  const operatorHub: [number, number, number] = [
    projectLayout.hierarchyBounds.center[0],
    projectLayout.hierarchyBounds.center[1] + projectLayout.hierarchyBounds.size[1] / 2 + 52,
    projectLayout.hierarchyBounds.center[2],
  ];
  expect(projects.every(project => Math.hypot(...project.center.map((axis, index) => axis - operatorHub[index])) < 100),
    'default project roots stay close to the operator hub');
  expect(new Set(projects.map(project => project.label)).size === projects.length,
    'duplicate repository names are disambiguated');

  const priorityEvents = Array.from({ length: 13 }, (_, index) => ({
    ...projectEvents[0],
    id: `priority-project-${index}`,
    timestamp: `2026-08-28T11:59:${String(index).padStart(2, '0')}.000Z`,
    resources: [{ file: `/Users/alice/repo-priority-${index}/src/file.ts`, action: 'read' as const }],
  })) as ActivityEvent[];
  const priorityLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), activityGroupSpecs(priorityEvents, Date.parse(timestamp)));
  const hotProject = priorityLayout.groups.find(group => group.activity?.projectRoot === '/Users/alice/repo-priority-12');
  const coldProject = priorityLayout.groups.find(group => group.activity?.projectRoot === '/Users/alice/repo-priority-0');
  expect(hotProject?.activitySlot?.[0] === 0 && coldProject?.activitySlot?.[0] === 1,
    'more recently active projects occupy inner spherical shells before colder projects');
  const innerProjects = priorityLayout.groups.filter(group => group.activity?.kind === 'project' && group.activitySlot?.[0] === 0);
  const equatorialProjects = innerProjects.filter(group => (group.activitySlot?.[1] ?? Infinity) < 4);
  const latitudeProjects = innerProjects.filter(group => (group.activitySlot?.[1] ?? -1) >= 4);
  expect(equatorialProjects.length === 4
    && new Set(equatorialProjects.map(group => group.center[1].toFixed(4))).size === 1
    && latitudeProjects.some(group => group.center[1].toFixed(4) !== equatorialProjects[0].center[1].toFixed(4)),
  'each spherical shell fills its equatorial ring before using upper and lower latitudes');

  const subtreePrioritySpecs = activityGroupSpecs([{
    ...projectEvents[0],
    id: 'subtree-priority',
    resources: [
      { file: '/Users/alice/repo-priority/README.md', action: 'read' as const },
      { file: '/Users/alice/repo-priority/src/a.ts', action: 'read' as const },
      { file: '/Users/alice/repo-priority/src/b.ts', action: 'read' as const },
    ],
  }], Date.parse(timestamp));
  const subtreePriorityLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), subtreePrioritySpecs);
  const sourceDirectory = subtreePriorityLayout.groups.find(group => group.activity?.path === '/Users/alice/repo-priority/src');
  expect(sourceDirectory?.activitySlot?.join(',') === '0,0',
    'the larger equally recent subtree receives the closest hierarchy slot');

  const promotionBeforeEvents = [
    event('promotion-a', [{ file: 'src/a.ts', action: 'read' }], { timestamp: '2026-08-28T11:55:00.000Z' }),
    event('promotion-b', [{ file: 'src/b.ts', action: 'read' }], { timestamp: '2026-08-28T11:52:00.000Z' }),
  ];
  const promotionBefore = withActivityGroups(computeLayout(EMPTY_GRAPH), activityGroupSpecs(promotionBeforeEvents, Date.parse(timestamp)));
  const promotionAfterEvents = [
    ...promotionBeforeEvents,
    event('promotion-b-hot', [{ file: 'src/b.ts', action: 'read' }], { timestamp: '2026-08-28T11:58:00.000Z' }),
  ];
  const promotionAfter = withActivityGroups(
    computeLayout(EMPTY_GRAPH),
    activityGroupSpecs(promotionAfterEvents, Date.parse(timestamp)),
    promotionBefore,
  );
  const promotedFile = promotionAfter.groups.find(group => group.activity?.path === '/workspace/src/b.ts');
  expect(promotedFile?.activitySlot?.join(',') === '0,0',
    'new activity promotes the hot file inward without globally repacking the hierarchy');

  const largeSpecs = activityGroupSpecs(fileEvents(82), Date.parse(timestamp));
  const largeLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), largeSpecs);
  const largeFiles = largeLayout.groups.filter(group => group.activity?.kind === 'file');
  const largeHierarchyRoot = largeLayout.groups.find(group => group.activity?.projectRoot === '/workspace'
    && group.parentId === null
    && group.activity.kind !== 'bash'
    && group.activity.kind !== 'tool');
  expect(largeFiles.length === 82 && new Set(largeFiles.map(file => file.center.join(','))).size === 82,
    'large sibling sets receive unique stable slots');
  expect(largeHierarchyRoot !== undefined
    && Math.max(...largeHierarchyRoot.size) <= 108
    && largeFiles.every(file => file.center.every((axis, index) =>
      Math.abs(axis - largeHierarchyRoot.center[index]) + file.size[index] / 2 <= largeHierarchyRoot.size[index] / 2 + 0.001)),
  'large activity hierarchies stay compact and contain their file volumes');

  const yValues = new Set(largeFiles.map(file => file.center[1].toFixed(4)));
  expect(yValues.size === 1, 'file siblings share a stable depth lane inside their parent');

  const before = withActivityGroups(computeLayout(EMPTY_GRAPH), activityGroupSpecs(fileEvents(5), Date.parse(timestamp)));
  const after = withActivityGroups(computeLayout(EMPTY_GRAPH), activityGroupSpecs([{
    ...fileEvents(5)[0],
    resources: fileEvents(5)[0].resources?.filter(resource => !resource.file?.endsWith('02.ts')),
  }], Date.parse(timestamp)), before);
  const beforeByPath = new Map(before.groups.filter(group => group.activity?.kind === 'file').map(group => [group.activity?.path, group.center]));
  const unchanged = after.groups
    .filter(group => group.activity?.kind === 'file')
    .every(group => {
      const path = group.activity?.path;
      return path ? group.center.every((axis, index) => axis === beforeByPath.get(path)?.[index]) : false;
    });
  expect(unchanged, 'removing a sibling does not index-shift the remaining sibling positions');

  const filePulses = largeFiles.map((file, index) => ({
    id: `pulse:${index}`,
    eventId: `event:${index}`,
    sessionId: 'session:spatial-polish',
    target: { kind: 'group', id: file.id, match: 'group' },
    kind: 'read',
    color: ACTIVITY_PULSE_COLORS.read,
    startedAt: index,
    expiresAt: index + 60_000,
  })) as ActivityPulse[];
  const visibleFileLabels = activityFileLabelIds(largeLayout.groups, filePulses, largeFiles[0]?.id ?? null, false);
  expect(visibleFileLabels.size === MAX_ACTIVITY_FILE_LABELS
    && visibleFileLabels.has(largeFiles[0].id)
    && visibleFileLabels.has(largeFiles[largeFiles.length - 1].id),
  'dense hierarchies retain the selected file and newest activity labels within the label budget');
  expect(activityFileLabelIds(largeLayout.groups, filePulses, null, true).size === largeFiles.length,
    'show-all-labels explicitly restores every file label');

  const structured = event('apply-patch-structured', [{ path: 'src/app.clj', kind: 'file', action: 'write' }]);
  const metadata = event('apply-patch-metadata', undefined, { metadata: { path: 'src/app.clj', action: 'write' } });
  const provider = event('apply-patch-provider', undefined, { data: { resources: [{ path: 'src/app.clj', kind: 'file', action: 'write' }] } });
  [structured, metadata, provider].forEach(current => {
    const specs = activityGroupSpecs([current], Date.parse(timestamp));
    const layout = withActivityGroups(computeLayout(EMPTY_GRAPH), specs);
    const indexes = buildActivityGraphIndexes(EMPTY_GRAPH, layout.groups);
    const target = resolveActivityTarget(current, indexes);
    const state = activityReducer(initialActivityState(), { type: 'event', event: { ...current, target }, now: 100 });
    expect(target?.kind === 'group'
      && layout.groups.some(group => group.id === target.id)
      && state.rays.some(ray => ray.sourceAgentNodeId === activityAgentIdentity(current)
        && ray.target.id === target.id
        && ray.sourceGroupId === undefined
        && ray.color === ACTIVITY_PULSE_COLORS.write),
    'apply_patch resources resolve to a live file group and emit a bounded red agent-to-file ray');
  });
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('activity spatial polish', runActivitySpatialPolishAssertions);
