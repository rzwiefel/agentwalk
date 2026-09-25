/**
 * Network/family resources and multi-target fan-out (roadmap T2-B / A2-B).
 *
 * The producer's intent parser (T2-A, a parallel wave) emits pathless
 * resources for URLs and command families instead of files:
 *   {kind:'url', name:<host[:port]>, ref:<origin+pathname>, provider, action:'network'}
 *   {kind:'tests'|'git'|'build', name:<runner/subcommand/tool>, action}
 * These tests pin the frontend half: `safeResource` accepts and bounds the
 * new fields, `activityType` classifies network events, `resolveActivityTargets`
 * fans a single event out to every resource's target, and the reducer builds
 * a pulse and a ray per target.
 */
import { activityType, parseActivityEvent } from './contract';
import { buildActivityGraphIndexes, MAX_ACTIVITY_TARGETS, resolveActivityTarget, resolveActivityTargets } from './graphResolver';
import { ACTIVITY_PULSE_COLORS, activityReducer, initialActivityState } from './reducer';
import type { ActivityEvent, ActivityResource } from './types';
import type { CodeGraph, LayoutGroup } from '../types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Activity targets assertion failed: ${message}`);
}

const base = {
  schemaVersion: 1 as const,
  id: 'event:1',
  sessionId: 'session:1',
  timestamp: '2026-09-01T12:00:00.000Z',
  type: 'tool',
};

// Mirrors the fixture in src/activity.test.ts: one namespace node and one var
// node in the same file, so a path resource with a line still picks the
// smaller span and one without a line falls back to the namespace.
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

export function runActivityTargetsAssertions(): void {
  const indexes = buildActivityGraphIndexes(graph, groups);

  // ---- safeResource: url fields -------------------------------------------
  const curlEvent = parseActivityEvent({
    ...base,
    id: 'curl-1',
    tool: 'bash',
    resources: [{ kind: 'url', name: 'Example.com:8443', ref: 'https://Example.com:8443/api/v1/thing?token=secret#frag', provider: 'curl', action: 'network', confidence: 'inferred' }],
  }) as ActivityEvent;
  const curlResource = curlEvent.resources?.[0];
  expect(curlEvent.resources?.length === 1, 'a well-formed url resource is accepted');
  expect(curlResource?.kind === 'url', 'kind survives parsing');
  expect(curlResource?.name === 'example.com:8443', 'the host name is lowercased and bounded to host[:port]');
  expect(curlResource?.ref === 'https://example.com:8443/api/v1/thing', 'ref is rebuilt from origin + pathname, dropping query and fragment');
  expect(curlResource?.provider === 'curl', 'provider survives parsing');
  expect(curlResource?.confidence === 'inferred', 'the inferred confidence level is accepted');

  const withCredentials = parseActivityEvent({
    ...base,
    id: 'with-credentials',
    resources: [{ kind: 'url', name: 'example.com', ref: 'https://user:pw@example.com/path?token=abc', action: 'network' }],
  }) as ActivityEvent;
  expect(withCredentials.resources?.[0]?.ref === 'https://example.com/path',
    'userinfo and query strings never survive into the stored ref, even if the producer forwarded them');

  const badHost = parseActivityEvent({
    ...base,
    id: 'bad-host',
    resources: [{ kind: 'url', name: 'not a host!', ref: 'https://example.com/', action: 'network' }],
  }) as ActivityEvent;
  expect((badHost.resources ?? []).length === 0, 'a url resource with an invalid host name is dropped entirely, not just stripped of its name');

  const noName = parseActivityEvent({ ...base, id: 'no-name', resources: [{ kind: 'url', ref: 'https://example.com/', action: 'network' }] }) as ActivityEvent;
  expect((noName.resources ?? []).length === 0, 'a url resource missing a name entirely is dropped');

  const badScheme = parseActivityEvent({
    ...base,
    id: 'bad-scheme',
    resources: [{ kind: 'url', name: 'example.com', ref: 'ftp://example.com/file', action: 'network' }],
  }) as ActivityEvent;
  const schemeResource = badScheme.resources?.[0];
  expect(schemeResource !== undefined && schemeResource.name === 'example.com' && schemeResource.ref === undefined,
    'a non-http(s)/ws(s) ref is dropped while a valid host keeps the resource');

  const badKind = parseActivityEvent({ ...base, id: 'bad-kind', resources: [{ kind: 'UPPERCASE_KIND', file: 'src/app.clj' }] }) as ActivityEvent;
  expect(badKind.resources?.[0]?.kind === undefined && badKind.resources?.[0]?.file === 'src/app.clj',
    'a malformed kind is dropped while the rest of a non-url resource survives');

  const badProvider = parseActivityEvent({ ...base, id: 'bad-provider', resources: [{ kind: 'url', name: 'example.com', provider: 'curl tool!', action: 'network' }] }) as ActivityEvent;
  expect(badProvider.resources?.[0]?.name === 'example.com' && badProvider.resources?.[0]?.provider === undefined,
    'a malformed provider is dropped while a valid host keeps the resource');

  // ---- safeResource: command families -------------------------------------
  const testsEvent = parseActivityEvent({ ...base, id: 'tests-1', resources: [{ kind: 'tests', name: 'pytest', action: 'execute', confidence: 'inferred' }] }) as ActivityEvent;
  const gitEvent = parseActivityEvent({ ...base, id: 'git-1', resources: [{ kind: 'git', name: 'push', action: 'network' }] }) as ActivityEvent;
  const buildEvent = parseActivityEvent({ ...base, id: 'build-1', resources: [{ kind: 'build', name: 'webpack', action: 'execute' }] }) as ActivityEvent;
  expect(testsEvent.resources?.[0]?.kind === 'tests' && testsEvent.resources[0].name === 'pytest', 'a tests family resource is accepted');
  expect(gitEvent.resources?.[0]?.kind === 'git', 'a git family resource is accepted');
  expect(buildEvent.resources?.[0]?.kind === 'build', 'a build family resource is accepted');

  // ---- activityType: network vs. incidental network -----------------------
  expect(activityType(curlEvent) === 'network', 'a pure network-resource event classifies as network');
  const incidentalRead = parseActivityEvent({
    ...base,
    id: 'incidental-read',
    resources: [
      { kind: 'url', name: 'example.com', ref: 'https://example.com/', action: 'network' },
      { action: 'read', file: 'src/app.clj' },
    ],
  }) as ActivityEvent;
  const incidentalWrite = parseActivityEvent({
    ...base,
    id: 'incidental-write',
    resources: [
      { action: 'write', file: 'src/app.clj' },
      { kind: 'url', name: 'example.com', ref: 'https://example.com/', action: 'network' },
    ],
  }) as ActivityEvent;
  expect(activityType(incidentalRead) === 'read', 'a read resource wins over an incidental network resource regardless of order');
  expect(activityType(incidentalWrite) === 'write', 'a write resource wins over a trailing incidental network resource');

  // ---- resolveActivityTargets: exact group ids ----------------------------
  const curlTargets = resolveActivityTargets(curlEvent, indexes);
  expect(curlTargets.length === 1
    && curlTargets[0].kind === 'group'
    && curlTargets[0].id === 'group:activity:web:example.com:8443'
    && curlTargets[0].match === 'external'
    && curlTargets[0].label === 'example.com:8443', 'a url resource resolves to its exact per-host web group id and label');
  expect(resolveActivityTargets(testsEvent, indexes)[0]?.id === 'group:activity:tool:tests'
    && resolveActivityTargets(testsEvent, indexes)[0]?.label === 'Tests', 'a tests resource resolves to the fixed tests family group');
  expect(resolveActivityTargets(gitEvent, indexes)[0]?.id === 'group:activity:tool:git', 'a git resource resolves to the fixed git family group');
  expect(resolveActivityTargets(buildEvent, indexes)[0]?.id === 'group:activity:tool:build', 'a build resource resolves to the fixed build family group');

  // ---- resolveActivityTargets: path resources are unchanged ---------------
  const pathEvent = parseActivityEvent({ ...base, id: 'path-event', type: 'file.read', resources: [{ file: 'src/app.clj', line: 12 }] }) as ActivityEvent;
  const pathTargets = resolveActivityTargets(pathEvent, indexes);
  expect(pathTargets.length === 1 && pathTargets[0].id === 'var:app/run' && pathTargets[0].match === 'span',
    'a path resource still resolves through the node -> file -> directory -> project cascade, unchanged');
  expect(resolveActivityTarget(pathEvent, indexes)?.id === 'var:app/run', 'resolveActivityTarget still returns the same single result for path-only events');

  const mixedTargets = resolveActivityTargets(incidentalRead, indexes);
  expect(mixedTargets.length === 2 && mixedTargets[0].id === 'group:activity:web:example.com' && mixedTargets[1].id === 'namespace:app' && mixedTargets[1].match === 'file',
    'a mixed event resolves one target per resource, in resource order, mixing an external group with a graph node');

  // ---- resolveActivityTargets: fan-out, dedup, and the cap -----------------
  const twoUrlEvent = parseActivityEvent({
    ...base,
    id: 'two-curl',
    tool: 'bash',
    resources: [
      { kind: 'url', name: 'a.example', ref: 'https://a.example/', provider: 'curl', action: 'network' },
      { kind: 'url', name: 'b.example', ref: 'https://b.example/', provider: 'curl', action: 'network' },
    ],
  }) as ActivityEvent;
  const twoTargets = resolveActivityTargets(twoUrlEvent, indexes);
  expect(twoTargets.length === 2
    && twoTargets[0].id === 'group:activity:web:a.example'
    && twoTargets[1].id === 'group:activity:web:b.example', 'two url resources resolve to two distinct targets in resource order');
  expect(resolveActivityTarget(twoUrlEvent, indexes)?.id === twoTargets[0].id, 'resolveActivityTarget keeps returning the first of the resolved targets');

  const duplicateHostEvent: ActivityEvent = {
    ...twoUrlEvent,
    id: 'dup-host',
    resources: [
      { kind: 'url', name: 'dup.example', action: 'network' },
      { kind: 'url', name: 'dup.example', action: 'network' },
    ],
  };
  expect(resolveActivityTargets(duplicateHostEvent, indexes).length === 1, 'repeated resources resolving to the same group id are deduped');

  const manyResources: ActivityResource[] = Array.from({ length: 40 }, (_, index): ActivityResource => ({ kind: 'url', name: `host${index}.example`, action: 'network' }));
  const manyTargetsEvent: ActivityEvent = { ...twoUrlEvent, id: 'many-targets', resources: manyResources };
  const cappedTargets = resolveActivityTargets(manyTargetsEvent, indexes);
  expect(cappedTargets.length === MAX_ACTIVITY_TARGETS && MAX_ACTIVITY_TARGETS === 32, 'resolveActivityTargets caps fan-out at thirty-two targets');

  // ---- reducer: every target gets its own pulse and ray --------------------
  let fanOutState = initialActivityState();
  fanOutState = activityReducer(fanOutState, { type: 'event', event: { ...twoUrlEvent, targets: twoTargets, target: twoTargets[0] }, now: 1_000 });
  const fanOutRays = fanOutState.rays.filter(ray => ray.eventId === 'two-curl');
  expect(fanOutRays.length === 2 && new Set(fanOutRays.map(ray => ray.target.id)).size === 2, 'two url targets on one event produce two distinct rays');
  expect(fanOutRays.every(ray => ray.color === ACTIVITY_PULSE_COLORS.network), 'network fan-out rays use the network pulse colour');
  const fanOutTargetPulses = fanOutState.pulses.filter(pulse => pulse.eventId === 'two-curl'
    && (pulse.target.id === 'group:activity:web:a.example' || pulse.target.id === 'group:activity:web:b.example'));
  expect(fanOutTargetPulses.length === 2 && fanOutTargetPulses.every(pulse => pulse.color === ACTIVITY_PULSE_COLORS.network),
    'each fanned-out target gets its own network-coloured pulse');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('activity targets', runActivityTargetsAssertions);
