import { EMPTY_GRAPH } from './App';
import { ACTIVITY_GROUP_TTL_MS, activityGroupSpecs, activityLayoutSignature, computeLayout, withActivityGroups } from './layout';
import type { ActivityAgentNode, ActivityEvent } from './activity/types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Activity web layout assertion failed: ${message}`);
}

const base = {
  schemaVersion: 1 as const,
  id: 'web-event',
  sessionId: 'session:web',
  timestamp: '2026-08-31T12:00:00.000Z',
  type: 'tool' as const,
  tool: 'bash',
};

function finite(point: [number, number, number]): boolean {
  return point.every(Number.isFinite);
}

function overlaps(
  first: { center: [number, number, number]; size: [number, number, number] },
  second: { center: [number, number, number]; size: [number, number, number] },
): boolean {
  return [0, 1, 2].every(axis =>
    Math.abs(first.center[axis] - second.center[axis]) < (first.size[axis] + second.size[axis]) / 2);
}

export function runActivityWebAssertions(): void {
  // --- two distinct hosts produce one web root + two domain specs ---
  const twoHostEvents: ActivityEvent[] = [
    {
      ...base,
      id: 'web-api-hit',
      resources: [{ kind: 'url', name: 'api.example.com', ref: 'https://api.example.com/v1/users', provider: 'http', action: 'network' }],
    },
    {
      ...base,
      id: 'web-localhost-hit',
      timestamp: '2026-08-31T12:00:01.000Z',
      resources: [{ kind: 'url', name: 'localhost:4180', ref: 'http://localhost:4180/health', provider: 'http', action: 'network' }],
    },
  ];
  const twoHostNow = Date.parse('2026-08-31T12:00:01.000Z');
  const twoHostSpecs = activityGroupSpecs(twoHostEvents, twoHostNow);
  const webRoot = twoHostSpecs.find(spec => spec.kind === 'web');
  const domains = twoHostSpecs.filter(spec => spec.kind === 'domain');
  expect(webRoot !== undefined && webRoot.id === 'group:activity:web' && webRoot.label === 'Web' && !webRoot.parentId,
    'exactly one web root is created with the fixed id, label, and no parent');
  expect(domains.length === 2
    && domains.every(domain => domain.parentId === webRoot?.id)
    && domains.map(domain => domain.label).sort().join('|') === 'api.example.com|localhost:4180'
    && domains.every(domain => domain.id === `group:activity:web:${domain.label}`),
  'exactly one domain spec per distinct host, correctly parented to the web root and labeled with the host');

  // --- a repeat hit on an existing host grows its weight/size but adds no new spec ---
  const repeatedHitEvents: ActivityEvent[] = [
    ...twoHostEvents,
    {
      ...base,
      id: 'web-api-hit-2',
      timestamp: '2026-08-31T12:00:02.000Z',
      // Differently-cased repeat: hosts are lowercased before matching, so
      // this must still merge into the existing api.example.com domain.
      resources: [{ kind: 'url', name: 'API.EXAMPLE.COM', ref: 'https://api.example.com/v1/orders', provider: 'http', action: 'network' }],
    },
  ];
  const repeatedHitNow = Date.parse('2026-08-31T12:00:02.000Z');
  const repeatedHitSpecs = activityGroupSpecs(repeatedHitEvents, repeatedHitNow);
  const repeatedDomains = repeatedHitSpecs.filter(spec => spec.kind === 'domain');
  expect(repeatedDomains.length === 2, 'a repeat hit on an already-seen host adds no new domain spec');
  expect(repeatedDomains.filter(domain => domain.label === 'api.example.com').length === 1,
    'a differently-cased repeat hit merges into the same lowercased domain rather than creating a second one');
  const initialLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), twoHostSpecs);
  const repeatedLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), repeatedHitSpecs);
  const initialApiGroup = initialLayout.groups.find(group => group.label === 'api.example.com');
  const repeatedApiGroup = repeatedLayout.groups.find(group => group.label === 'api.example.com');
  const initialLocalhostGroup = initialLayout.groups.find(group => group.label === 'localhost:4180');
  const repeatedLocalhostGroup = repeatedLayout.groups.find(group => group.label === 'localhost:4180');
  expect(initialApiGroup !== undefined && repeatedApiGroup !== undefined
    && repeatedApiGroup.size.every((axis, index) => axis > initialApiGroup.size[index]),
  'a second hit on an existing host visibly grows that domain group\'s packed box size');
  expect(initialLocalhostGroup !== undefined && repeatedLocalhostGroup !== undefined
    && repeatedLocalhostGroup.size.every((axis, index) => Math.abs(axis - initialLocalhostGroup.size[index]) < 1e-9),
  'a host that received no additional hits keeps its size unchanged');

  // --- a resource name that fails host validation is rejected defensively ---
  const invalidHostEvent: ActivityEvent = {
    ...base,
    id: 'web-invalid-host',
    resources: [{ kind: 'url', name: 'not a host/with slash', ref: 'https://example.com', provider: 'http', action: 'network' }],
  };
  const invalidHostSpecs = activityGroupSpecs([invalidHostEvent], Date.parse(base.timestamp));
  expect(invalidHostSpecs.every(spec => spec.kind !== 'web' && spec.kind !== 'domain'),
    'a resource name that fails ^[a-z0-9.-]+(:\\d{1,5})?$ after lowercasing produces no web root or domain spec'
    + ' (the event still produces its own incidental bash-tool group, which is unrelated pre-existing behavior)');

  // --- family resources (tests/git/build) produce the three toolbox specs ---
  const familyEvents: ActivityEvent[] = [
    { ...base, id: 'family-tests', resources: [{ kind: 'tests', name: 'npm test', action: 'execute' }] },
    { ...base, id: 'family-git', timestamp: '2026-08-31T12:00:01.000Z', resources: [{ kind: 'git', name: 'git push', action: 'execute' }] },
    { ...base, id: 'family-build', timestamp: '2026-08-31T12:00:02.000Z', resources: [{ kind: 'build', name: 'npm run build', action: 'execute' }] },
  ];
  const familySpecs = activityGroupSpecs(familyEvents, Date.parse('2026-08-31T12:00:02.000Z'));
  const familyIds = ['group:activity:tool:tests', 'group:activity:tool:git', 'group:activity:tool:build'];
  const familyToolSpecs = familySpecs.filter(spec => familyIds.includes(spec.id));
  expect(familyToolSpecs.length === 3 && familyToolSpecs.every(spec => spec.kind === 'tool' && !spec.parentId),
    'tests/git/build resources each produce one unparented tool-kind family spec, placed in the toolbox like other tool groups');
  expect(familyToolSpecs.find(spec => spec.id === 'group:activity:tool:tests')?.label === 'Tests'
    && familyToolSpecs.find(spec => spec.id === 'group:activity:tool:git')?.label === 'Git'
    && familyToolSpecs.find(spec => spec.id === 'group:activity:tool:build')?.label === 'Build',
  'family tool specs use the Tests/Git/Build labels');

  // --- TTL: domain specs expire per the same retention/fade window as every other activity group ---
  const ttlEvent: ActivityEvent = {
    ...base,
    id: 'web-ttl-hit',
    resources: [{ kind: 'url', name: 'expiring.example.com', ref: 'https://expiring.example.com', provider: 'http', action: 'network' }],
  };
  const ttlEventTime = Date.parse(base.timestamp);
  const freshTtlSpecs = activityGroupSpecs([ttlEvent], ttlEventTime + 1000);
  const expiredTtlSpecs = activityGroupSpecs([ttlEvent], ttlEventTime + ACTIVITY_GROUP_TTL_MS + 1000);
  expect(freshTtlSpecs.some(spec => spec.kind === 'domain' && spec.label === 'expiring.example.com'),
    'a fresh web hit produces a live domain spec');
  expect(expiredTtlSpecs.length === 0,
    'domain (and its web root) specs expire per the same ACTIVITY_GROUP_RETENTION_MS/ACTIVITY_GROUP_FADE_MS as every other activity group');

  // --- placement: the web root and its domains sit beside project hierarchies without overlap ---
  const projectAEvent: ActivityEvent = {
    ...base,
    id: 'project-a-file',
    type: 'file.read',
    resources: [{ action: 'read', file: '/Users/alice/repo-a/src/index.ts' }],
  };
  const projectBEvent: ActivityEvent = {
    ...base,
    id: 'project-b-file',
    type: 'file.read',
    timestamp: '2026-08-31T12:00:01.000Z',
    resources: [{ action: 'read', file: '/Users/alice/repo-b/README.md' }],
  };
  const mixedSpecs = activityGroupSpecs([...twoHostEvents, projectAEvent, projectBEvent], twoHostNow);
  const mixedLayout = withActivityGroups(computeLayout(EMPTY_GRAPH), mixedSpecs);
  const mixedWebRoot = mixedLayout.groups.find(group => group.activity?.kind === 'web');
  const mixedDomains = mixedLayout.groups.filter(group => group.activity?.kind === 'domain');
  const mixedProjectRoots = mixedLayout.groups.filter(group => group.activity?.kind === 'project' && !group.parentId);
  expect(mixedWebRoot !== undefined && !mixedWebRoot.parentId && finite(mixedWebRoot.center) && finite(mixedWebRoot.size),
    'the web root is placed as its own top-level hierarchy root (not the toolbox) with a finite box');
  expect(mixedDomains.length === 2
    && mixedDomains.every(domain => domain.parentId === mixedWebRoot?.id && finite(domain.center) && finite(domain.size)),
  'both domains are placed as leaves under the placed web root with finite boxes');
  expect(mixedProjectRoots.length === 2 && mixedProjectRoots.every(project => finite(project.center)),
    'two project hierarchy roots are still placed alongside the web root');
  const allHierarchyRoots = [mixedWebRoot, ...mixedProjectRoots].filter((group): group is NonNullable<typeof group> => Boolean(group));
  let anyRootsOverlap = false;
  for (let index = 0; index < allHierarchyRoots.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < allHierarchyRoots.length; otherIndex += 1) {
      if (overlaps(allHierarchyRoots[index], allHierarchyRoots[otherIndex])) anyRootsOverlap = true;
    }
  }
  expect(allHierarchyRoots.length === 3 && !anyRootsOverlap,
    'the web root and two project roots sit side by side without overlapping, the same separation that keeps two project roots apart');

  // --- activityLayoutSignature: reacts to a new host, stable across now alone ---
  const noAgents: ActivityAgentNode[] = [];
  const signatureBefore = activityLayoutSignature(twoHostEvents, noAgents, twoHostNow);
  const signatureLaterSameEvents = activityLayoutSignature(twoHostEvents, noAgents, twoHostNow + 5000);
  expect(signatureBefore === signatureLaterSameEvents,
    'the activity layout signature is stable across now ticks when no new host appears and nothing expires');
  const thirdHostEvent: ActivityEvent = {
    ...base,
    id: 'web-third-host',
    timestamp: '2026-08-31T12:00:01.000Z',
    resources: [{ kind: 'url', name: 'cdn.example.net', ref: 'https://cdn.example.net/asset.js', provider: 'http', action: 'network' }],
  };
  const signatureWithNewHost = activityLayoutSignature([...twoHostEvents, thirdHostEvent], noAgents, twoHostNow);
  expect(signatureBefore !== signatureWithNewHost, 'the activity layout signature changes once a new host appears');

  // --- T2-D remainder: family (tests/git/build) and domain groups carry a last-outcome status ---
  const testsPassEvent: ActivityEvent = {
    ...base, id: 'outcome-tests-pass',
    resources: [{ kind: 'tests', name: 'npm test', action: 'execute' }],
    metadata: { exitCode: 0 },
  };
  const testsPassSpec = activityGroupSpecs([testsPassEvent], Date.parse(base.timestamp))
    .find(spec => spec.id === 'group:activity:tool:tests');
  expect(testsPassSpec?.lastOutcome === 'completed',
    'a tests-family event with metadata.exitCode 0 marks the Tests family spec completed');

  const testsFailEvent: ActivityEvent = {
    ...base, id: 'outcome-tests-fail',
    resources: [{ kind: 'tests', name: 'npm test', action: 'execute' }],
    metadata: { exitCode: 1 },
  };
  const testsFailSpecs = activityGroupSpecs([testsFailEvent], Date.parse(base.timestamp));
  const testsFailSpec = testsFailSpecs.find(spec => spec.id === 'group:activity:tool:tests');
  expect(testsFailSpec?.lastOutcome === 'failed',
    'a tests-family event with a nonzero metadata.exitCode marks the Tests family spec failed');

  const gitErrorClassificationEvent: ActivityEvent = {
    ...base, id: 'outcome-git-error-classification',
    resources: [{ kind: 'git', name: 'git push', action: 'execute' }],
    metadata: { exitCode: 0, errorClassification: 'network' },
  };
  const gitErrorSpec = activityGroupSpecs([gitErrorClassificationEvent], Date.parse(base.timestamp))
    .find(spec => spec.id === 'group:activity:tool:git');
  expect(gitErrorSpec?.lastOutcome === 'failed',
    'errorClassification marks the Git family spec failed even when exitCode is 0 -- explicit failure info outranks the exit code');

  const buildStatusOnlyEvent: ActivityEvent = {
    ...base, id: 'outcome-build-status-only',
    resources: [{ kind: 'build', name: 'npm run build', action: 'execute' }],
    metadata: { status: 'failed' },
  };
  const buildStatusSpec = activityGroupSpecs([buildStatusOnlyEvent], Date.parse(base.timestamp))
    .find(spec => spec.id === 'group:activity:tool:build');
  expect(buildStatusSpec?.lastOutcome === 'failed',
    'a metadata.status of "failed" alone (no exitCode/errorClassification) marks the Build family spec failed');

  const untouchedFamilyEvent: ActivityEvent = {
    ...base, id: 'outcome-tests-no-metadata',
    resources: [{ kind: 'tests', name: 'npm test', action: 'execute' }],
  };
  const untouchedFamilySpecs = activityGroupSpecs([untouchedFamilyEvent], Date.parse(base.timestamp));
  const untouchedFamilySpec = untouchedFamilySpecs.find(spec => spec.id === 'group:activity:tool:tests');
  expect(untouchedFamilySpec !== undefined && untouchedFamilySpec.lastOutcome === undefined,
    'a family event with no outcome metadata leaves lastOutcome undefined -- additive, no visual change yet');

  // Last write wins, but a later event with no opinion on outcome must not blank out a known one.
  const sequentialOutcomeEvents: ActivityEvent[] = [
    { ...base, id: 'seq-1-fail', resources: [{ kind: 'tests', name: 'npm test', action: 'execute' }], metadata: { exitCode: 1 } },
    { ...base, id: 'seq-2-start', timestamp: '2026-08-31T12:00:01.000Z', resources: [{ kind: 'tests', name: 'npm test', action: 'execute' }] },
  ];
  const sequentialSpec = activityGroupSpecs(sequentialOutcomeEvents, Date.parse('2026-08-31T12:00:01.000Z'))
    .find(spec => spec.id === 'group:activity:tool:tests');
  expect(sequentialSpec?.lastOutcome === 'failed',
    'a later event touching the same family id but reporting no outcome does not blank out the last known outcome');

  const sequentialRecoveryEvents: ActivityEvent[] = [
    ...sequentialOutcomeEvents,
    { ...base, id: 'seq-3-pass', timestamp: '2026-08-31T12:00:02.000Z', resources: [{ kind: 'tests', name: 'npm test', action: 'execute' }], metadata: { exitCode: 0 } },
  ];
  const sequentialRecoverySpec = activityGroupSpecs(sequentialRecoveryEvents, Date.parse('2026-08-31T12:00:02.000Z'))
    .find(spec => spec.id === 'group:activity:tool:tests');
  expect(sequentialRecoverySpec?.lastOutcome === 'completed',
    'a subsequent passing run flips the family spec from failed to completed -- last outcome, not first');

  // Domain spheres carry the same signal; the web root itself never does.
  const domainOutcomeEvent: ActivityEvent = {
    ...base, id: 'outcome-domain-fail',
    resources: [{ kind: 'url', name: 'api.example.com', ref: 'https://api.example.com/v1', provider: 'http', action: 'network' }],
    metadata: { exitCode: 7 },
  };
  const domainOutcomeSpecs = activityGroupSpecs([domainOutcomeEvent], Date.parse(base.timestamp));
  const domainOutcomeSpec = domainOutcomeSpecs.find(spec => spec.kind === 'domain');
  const webRootOutcomeSpec = domainOutcomeSpecs.find(spec => spec.kind === 'web');
  expect(domainOutcomeSpec?.lastOutcome === 'failed', 'a domain-hit event with a nonzero exitCode marks the domain spec failed');
  expect(webRootOutcomeSpec !== undefined && webRootOutcomeSpec.lastOutcome === undefined,
    'the web root itself never receives a lastOutcome -- only the per-host domain leaves do, per the brief');

  // withActivityGroups forwards lastOutcome from the spec onto LayoutGroup.activity.
  const familyOutcomeLayoutGroup = withActivityGroups(computeLayout(EMPTY_GRAPH), testsFailSpecs)
    .groups.find(group => group.id === 'group:activity:tool:tests');
  expect(familyOutcomeLayoutGroup?.activity?.lastOutcome === 'failed',
    'withActivityGroups forwards lastOutcome from the spec onto LayoutGroup.activity for a family (toolbox) group');
  const domainOutcomeLayoutGroup = withActivityGroups(computeLayout(EMPTY_GRAPH), domainOutcomeSpecs)
    .groups.find(group => group.activity?.kind === 'domain');
  expect(domainOutcomeLayoutGroup?.activity?.lastOutcome === 'failed',
    'withActivityGroups forwards lastOutcome from the spec onto LayoutGroup.activity for a domain sphere');
  const noOutcomeLayoutGroup = withActivityGroups(computeLayout(EMPTY_GRAPH), untouchedFamilySpecs)
    .groups.find(group => group.id === 'group:activity:tool:tests');
  expect(noOutcomeLayoutGroup !== undefined && noOutcomeLayoutGroup.activity?.lastOutcome === undefined,
    'a family group with no reported outcome carries no lastOutcome onto the layout group either -- looks exactly as before');

  // activityLayoutSignature deliberately excludes lastOutcome, the same way it already excludes
  // weight: an outcome only ever changes alongside a new event, which layout's own useMemo in
  // App.tsx already depends on directly, so the signature does not need to cover it too (and
  // covering it would defeat the "now alone must not invalidate it" property pinned above).
  const signatureNoOutcome = activityLayoutSignature([untouchedFamilyEvent], noAgents, Date.parse(base.timestamp));
  const signatureWithOutcome = activityLayoutSignature([testsFailEvent], noAgents, Date.parse(base.timestamp));
  expect(signatureNoOutcome === signatureWithOutcome,
    'activityLayoutSignature is unchanged by lastOutcome, matching how it already ignores weight');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('activity web layout', runActivityWebAssertions);
