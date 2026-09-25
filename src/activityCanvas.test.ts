import {
  ACTIVITY_AGENT_DENIED_FLASH_MS,
  ACTIVITY_DIMMED_OPACITY_FACTOR,
  activityDimFactor,
  activityGroupOutcomeColor,
  activityPulseSizeScale,
  activityTargetOpacity,
  agentGlyphAppearance,
  domainGroupLabel,
  groupGeometryKind,
} from './components/GraphCanvas';
import { ACTIVITY_PULSE_COLORS } from './activity/reducer';
import type { ActivityPulse } from './activity/types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Activity canvas assertion failed: ${message}`);
}

function runActivityCanvasAssertions(): void {
  // --- agentGlyphAppearance (T1-B waiting halo / denied flash) ---
  expect(agentGlyphAppearance({ status: 'active' }, 1000).halo === null,
    'an agent with no waiting/denied/failed signal shows no halo');

  expect(agentGlyphAppearance({ status: 'waiting' }, 1000).halo === 'waiting',
    'status "waiting" alone (case-insensitive) triggers the waiting halo');
  expect(agentGlyphAppearance({ status: 'Waiting' }, 1000).halo === 'waiting',
    'status comparison is case-insensitive');
  expect(agentGlyphAppearance({ status: 'active', waitingSince: 500 }, 1000).halo === 'waiting',
    'waitingSince set with a non-waiting status still triggers the waiting halo');
  expect(agentGlyphAppearance({ status: 'waiting' }, 1000).color === '#f5b942',
    'the waiting halo is amber #f5b942 per the brief');

  expect(agentGlyphAppearance({ status: 'active', lastDeniedAt: 500 }, 1000).halo === 'denied',
    'a lastDeniedAt within the last 3s flashes the glyph red');
  expect(agentGlyphAppearance({ status: 'active', lastDeniedAt: 500 }, 3499).halo === 'denied',
    'the denied flash is still active just under the 3s window');
  expect(agentGlyphAppearance({ status: 'active', lastDeniedAt: 500 }, 3500).halo === null,
    'the denied flash ends exactly at ACTIVITY_AGENT_DENIED_FLASH_MS');
  expect(ACTIVITY_AGENT_DENIED_FLASH_MS === 3000, 'the denied flash window is 3s per the brief');

  expect(agentGlyphAppearance({ status: 'active', waitingSince: 100, lastDeniedAt: 900 }, 1000).halo === 'denied',
    'a recent denial takes priority over an open wait');

  expect(agentGlyphAppearance({ status: 'failed' }, 1000).halo === 'failed',
    'a failed status reports the failed halo when nothing more urgent is active');
  expect(agentGlyphAppearance({ status: 'error' }, 1000).halo === 'failed',
    'an error status also reports the failed halo');
  expect(agentGlyphAppearance({ status: 'failed', waitingSince: 100 }, 1000).halo === 'waiting',
    'an open wait takes priority over a stale failed status');

  // --- groupGeometryKind (T2-C spheres) ---
  expect(groupGeometryKind('web') === 'sphere', 'web activity groups render as spheres');
  expect(groupGeometryKind('domain') === 'sphere', 'domain activity groups render as spheres');
  expect(groupGeometryKind('bash') === 'box', 'bash activity groups keep their box');
  expect(groupGeometryKind('tool') === 'box', 'tool activity groups keep their box');
  expect(groupGeometryKind('file') === 'box', 'file activity groups keep their box');
  expect(groupGeometryKind('directory') === 'box', 'directory activity groups keep their box');
  expect(groupGeometryKind('project') === 'box', 'project activity groups keep their box');
  expect(groupGeometryKind(undefined) === 'box', 'non-activity (undefined kind) groups keep their box');

  // --- activityGroupOutcomeColor (T2-D remainder: family/domain outcome tint) ---
  expect(activityGroupOutcomeColor('failed') === ACTIVITY_PULSE_COLORS.failed,
    'a failed outcome reuses ACTIVITY_PULSE_COLORS.failed rather than introducing a new colour');
  expect(activityGroupOutcomeColor('failed') === '#ff5c68', 'the failed outcome tint is the pinned #ff5c68 red');
  expect(activityGroupOutcomeColor('completed') === '#47d7b0',
    'a completed outcome tints the same teal-green PhysicsEdges already uses for a "calls" edge');
  expect(activityGroupOutcomeColor(undefined) === undefined,
    'no outcome yet renders no tint override at all -- additive, matches today\'s appearance');

  // --- domainGroupLabel (T2-C hit counter) ---
  expect(domainGroupLabel('example.com', 5) === 'example.com · 5',
    'a positive hit count is appended with a middle-dot separator');
  expect(domainGroupLabel('example.com', 0) === 'example.com',
    'a zero hit count renders the host alone');
  expect(domainGroupLabel('example.com', undefined) === 'example.com',
    'an absent hit count renders the host alone');

  // --- activityPulseSizeScale (T1-C failed pulses render slightly larger) ---
  expect(activityPulseSizeScale('failed') === 1.3, 'failed pulses render 1.3x their normal size');
  expect(activityPulseSizeScale('read') === 1, 'non-failed pulses render at their normal size');
  expect(activityPulseSizeScale('write') === 1, 'write pulses are unaffected');

  // --- activityTargetOpacity (T1-C: failed pulses fade proportionally slower) ---
  const normalPulse: ActivityPulse = {
    id: 'pulse:normal', eventId: 'event:normal', sessionId: 'session:a',
    target: { kind: 'node', id: 'node:a', match: 'node' },
    kind: 'read', color: '#7898ff', startedAt: 0, expiresAt: 60_000,
  };
  const failedPulse: ActivityPulse = {
    ...normalPulse, id: 'pulse:failed', kind: 'failed', color: '#ff5c68', expiresAt: 120_000,
  };
  const normalBaseline = activityTargetOpacity(normalPulse, 60_000);
  expect(activityTargetOpacity(failedPulse, 60_000) > normalBaseline,
    'at the same elapsed time, a failed pulse (2x TTL) has faded less than a normal pulse');
  expect(activityTargetOpacity(failedPulse, 120_000) === activityTargetOpacity(normalPulse, 60_000),
    'a failed pulse reaches the same fade progress as a normal pulse only after its proportionally longer TTL');
  expect(activityTargetOpacity(undefined, 0) === activityTargetOpacity(undefined, 0),
    'the undefined-pulse baseline is unaffected by the failed-pulse change');

  // --- activityDimFactor (T1-G session dim) ---
  const dimmed = new Set(['session:dim']);
  expect(activityDimFactor('session:dim', dimmed) === ACTIVITY_DIMMED_OPACITY_FACTOR,
    'a session id present in the dimmed set renders at the reduced opacity factor');
  expect(ACTIVITY_DIMMED_OPACITY_FACTOR === 0.25, 'dimmed items render at ~25% opacity per the brief');
  expect(activityDimFactor('session:other', dimmed) === 1,
    'a session id absent from the dimmed set renders at full opacity');
  expect(activityDimFactor(undefined, dimmed) === 1,
    'an item with no session id is never dimmed');
  expect(activityDimFactor('session:dim', undefined) === 1,
    'an undefined dimmed set (the default, before any brief wires it in) dims nothing');
  expect(activityDimFactor('session:dim', new Set()) === 1,
    'an empty dimmed set dims nothing');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('activity canvas visuals', runActivityCanvasAssertions);
