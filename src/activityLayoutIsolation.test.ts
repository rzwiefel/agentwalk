import { activityArchitectureContextVisible, EMPTY_GRAPH } from './App';
import { buildActivityGraphIndexes, resolveActivityTarget } from './activity/graphResolver';
import { activityGroupSpecs, computeLayout, withActivityGroups } from './layout';
import type { ActivityEvent } from './activity/types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Activity layout assertion failed: ${message}`);
}

const base = {
  schemaVersion: 1 as const,
  id: 'layout-event',
  sessionId: 'session:layout',
  timestamp: '2026-08-26T12:00:00.000Z',
  type: 'file.read' as const,
};

export function runActivityLayoutIsolationAssertions(): void {
  const isolatedRoots = activityGroupSpecs([{
    ...base,
    id: 'multiple-absolute-roots',
    resources: [
      { action: 'read' as const, file: '/Users/alice/repo-a/README.md' },
      { action: 'read' as const, file: '/Users/alice/repo-a/src/index.ts' },
      { action: 'read' as const, file: '/Users/alice/repo-b/README.md' },
    ],
  } as ActivityEvent], Date.parse(base.timestamp));
  const projectRoots = isolatedRoots.filter(spec => spec.kind === 'project');
  expect(projectRoots.length === 2
    && projectRoots.map(spec => spec.label).sort().join('|') === 'repo-a|repo-b'
    && projectRoots.every(spec => spec.parentId === undefined), 'absolute activity roots become separate labeled top-level hierarchies');
  const repoA = projectRoots.find(spec => spec.label === 'repo-a');
  const repoAReadme = isolatedRoots.find(spec => spec.label === 'README.md' && spec.projectRoot === '/Users/alice/repo-a');
  const repoASrc = isolatedRoots.find(spec => spec.label === 'src' && spec.projectRoot === '/Users/alice/repo-a');
  const repoAIndex = isolatedRoots.find(spec => spec.label === 'index.ts' && spec.projectRoot === '/Users/alice/repo-a');
  expect(Boolean(repoA && repoAReadme?.parentId === repoA.id && repoASrc?.parentId === repoA.id && repoAIndex?.parentId === repoASrc?.id),
    'nested activity paths retain their repository, directory, and file parents');
  const repoADirectChildren = withActivityGroups(computeLayout(EMPTY_GRAPH), isolatedRoots).groups.filter(group => group.parentId === repoA?.id);
  expect(repoADirectChildren.length > 0 && repoADirectChildren.every(group => group.depth === 1),
    'direct project children use hierarchy depth one');

  const parentWorkspaceEvent = {
    ...base,
    id: 'parent-workspace-file',
    sessionId: 'session:parent-workspace',
    workspace: { id: 'workspace-repos', root: '/Users/alice/repos', repository: 'repos' },
    resources: [
      { action: 'read' as const, file: 'codewalk/src/shared.ts' },
      { action: 'read' as const, file: 'codewalk/README.md' },
    ],
  } as ActivityEvent;
  const repositoryWorkspaceEvent = {
    ...base,
    id: 'repository-workspace-file',
    sessionId: 'session:repository-workspace',
    workspace: { id: 'workspace-codewalk', root: '/Users/alice/repos/codewalk', repository: 'codewalk' },
    resources: [{ action: 'write' as const, file: 'src/shared.ts' }],
  } as ActivityEvent;
  const normalizedWorkspaceSpecs = activityGroupSpecs(
    [parentWorkspaceEvent, repositoryWorkspaceEvent],
    Date.parse(base.timestamp),
  );
  const normalizedProjects = normalizedWorkspaceSpecs.filter(spec => spec.kind === 'project');
  const normalizedSharedFiles = normalizedWorkspaceSpecs.filter(spec => spec.kind === 'file'
    && spec.path === '/Users/alice/repos/codewalk/src/shared.ts');
  const normalizedLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), normalizedWorkspaceSpecs);
  const parentWorkspaceTarget = resolveActivityTarget(
    parentWorkspaceEvent,
    buildActivityGraphIndexes(EMPTY_GRAPH, normalizedLayout.groups),
  );
  expect(normalizedProjects.length === 1
    && normalizedProjects[0].projectRoot === '/Users/alice/repos/codewalk'
    && normalizedProjects[0].label === 'codewalk'
    && normalizedSharedFiles.length === 1,
  'a repository and its parent container workspace share one canonical project hierarchy');
  expect(parentWorkspaceTarget?.id === normalizedSharedFiles[0].id,
    'parent-workspace activity rays target the canonical repository file group');

  const singletonEvent = {
    ...base,
    id: 'singleton-project',
    workspace: { id: 'workspace-singleton', root: '/Users/alice/repos', repository: 'repos' },
    resources: [
      { action: 'read' as const, file: 'src/index.ts' },
      { action: 'read' as const, file: 'docs/guide.md' },
    ],
  } as ActivityEvent;
  const singletonSpecs = activityGroupSpecs([singletonEvent], Date.parse(base.timestamp));
  const singletonProject = singletonSpecs.find(spec => spec.kind === 'project');
  const singletonLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), singletonSpecs);
  const promotedRoots = singletonLayout.groups.filter(group => group.activity && !group.parentId
    && group.activity.kind !== 'bash' && group.activity.kind !== 'tool');
  expect(singletonProject !== undefined
    && !singletonLayout.groups.some(group => group.id === singletonProject.id)
    && promotedRoots.map(group => group.label).sort().join('|') === 'docs|src'
    && promotedRoots.every(group => group.depth === 0),
  'a lone populated project wrapper is omitted and its immediate children become top-level hierarchies');

  const peerProjectEvent = {
    ...base,
    id: 'peer-project',
    sessionId: 'session:peer-project',
    workspace: { id: 'workspace-peer', root: '/Users/alice/peer', repository: 'peer' },
    resources: [{ action: 'read' as const, file: 'src/peer.ts' }],
  } as ActivityEvent;
  const restoredSpecs = activityGroupSpecs(
    [singletonEvent, peerProjectEvent],
    Date.parse(base.timestamp),
  );
  const restoredLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), restoredSpecs, singletonLayout);
  const restoredProject = restoredLayout.groups.find(group => group.id === singletonProject?.id);
  expect(restoredLayout.groups.filter(group => group.activity?.kind === 'project').length === 2
    && restoredProject !== undefined
    && restoredLayout.groups.filter(group => group.activity?.projectRoot === '/Users/alice/repos'
      && group.activity.kind !== 'project').every(group => group.parentId !== null),
  'the project wrapper is restored when another top-level project hierarchy appears');

  const screenshotFileNames = ['core.cljs', 'events.cljs', 'modal_test.cljs', 'routes.cljs', 'subs.cljs', 'views.cljs'];
  const screenshotSpecs = activityGroupSpecs([{
    ...base,
    id: 'screenshot-sibling-set',
    workspace: { id: 'workspace-screenshot', root: '/workspace' },
    resources: screenshotFileNames.map(file => ({ action: 'read' as const, file: `src/${file}` })),
  } as ActivityEvent], Date.parse(base.timestamp));
  const screenshotLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), screenshotSpecs);
  const screenshotDirectory = screenshotLayout.groups.find(group => group.activity?.kind === 'directory' && group.label === 'src');
  const screenshotFiles = screenshotLayout.groups.filter(group => group.parentId === screenshotDirectory?.id);
  expect(screenshotFiles.length === screenshotFileNames.length
    && new Set(screenshotFiles.map(file => `${file.center[0]},${file.center[2]}`)).size === screenshotFileNames.length,
  'realistic file names receive distinct hierarchy footprints even when their preferred slots collide');

  const largeResources = Array.from({ length: 82 }, (_, index) => ({
    action: 'read' as const,
    file: `/Users/alice/large-repo/src/file-${String(index).padStart(2, '0')}.ts`,
  }));
  const largeSpecs = activityGroupSpecs([{ ...base, id: 'large-sibling-set', resources: largeResources } as ActivityEvent], Date.parse(base.timestamp));
  const largeLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), largeSpecs);
  const largeFiles = largeLayout.groups.filter(group => group.activity?.projectRoot === '/Users/alice/large-repo' && group.activity.kind === 'file');
  let largeFilesOverlap = false;
  for (let index = 0; index < largeFiles.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < largeFiles.length; otherIndex += 1) {
      const first = largeFiles[index];
      const second = largeFiles[otherIndex];
      largeFilesOverlap = largeFilesOverlap
        || Math.abs(first.center[0] - second.center[0]) < (first.size[0] + second.size[0]) / 2
          && Math.abs(first.center[2] - second.center[2]) < (first.size[2] + second.size[2]) / 2;
    }
  }
  expect(largeFiles.length === 82 && !largeFilesOverlap, 'large activity sibling sets use deterministic non-overlapping placement');

  // Defect-2 regression: activityPacking()'s generic grid packer places a
  // lone child at offset [0, 0] -- dead center on its parent, in both X
  // and Z -- so a single-child directory/file chain (ordinary on a real
  // filesystem: one entry per level, e.g. src/cljc/some/ns/file.cljc)
  // collapsed onto the same X/Z point at every level down. Activity mode
  // always renders the full ancestor chain, not just leaves (see
  // displayGroups in GraphCanvas.tsx), and HierarchyEdges draws one box
  // outline per group, so that chain rendered as a stack of
  // near-concentric wireframe boxes wrapping whatever sits at the bottom
  // of it -- the reported "~5 boxes at nearly the same center" defect.
  // Mirrors the identical invariant layout.test.ts already enforces on the
  // static namespace tree's own single-child chains ("single-child
  // namespace chains receive visibly inset nested bounds").
  const chainFileEvent = {
    ...base,
    id: 'single-child-chain',
    resources: [{ action: 'read' as const, file: '/repo/src/cljc/sample_app/widgets/panel.cljc' }],
  } as ActivityEvent;
  const chainSpecs = activityGroupSpecs([chainFileEvent], Date.parse(base.timestamp));
  const chainLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), chainSpecs);
  const chainActivityGroups = chainLayout.groups.filter(group => group.activity).sort((left, right) => left.depth - right.depth);
  expect(chainActivityGroups.length === 5, 'a single nested file path produces one activity group per path segment (src/cljc/sample_app/widgets/panel.cljc)');
  expect(new Set(chainActivityGroups.map(group => `${group.center[0]},${group.center[2]}`)).size === chainActivityGroups.length,
  'single-child activity directory/file chains receive visibly distinct X/Z footprints at every level, not a stack of concentric boxes');
  expect(chainActivityGroups.slice(1).every((group, index) =>
    group.size.every((axis, sizeIndex) => axis < chainActivityGroups[index].size[sizeIndex])),
  'each level of a single-child activity chain still nests strictly inside its parent by size');

  expect(activityArchitectureContextVisible('activity', false) === false
    && activityArchitectureContextVisible('activity', true)
    && activityArchitectureContextVisible('architecture', false), 'live activity hides static architecture until explicitly requested');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('activity layout isolation', runActivityLayoutIsolationAssertions);
