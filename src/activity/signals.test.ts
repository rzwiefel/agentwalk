/**
 * The free signals (roadmap T1-B..T1-F): waiting on approval, failures,
 * turns and stalls, the completed-tool ring, and session chips.
 *
 * Built against the T1-P wire contract with synthetic envelopes, so these
 * transitions are pinned before the producer starts emitting them live.
 */
import {
  ACTIVITY_PERMISSION_RESULTS,
  activityAgentStatus,
  activityPermissionResult,
  activitySummary,
  activityType,
  parseActivityEvent,
  permissionLifecycle,
} from './contract';
import {
  ACTIVITY_FAILED_PULSE_TTL_MS,
  ACTIVITY_FAILURE_WINDOW_MS,
  ACTIVITY_PULSE_COLORS,
  ACTIVITY_TARGET_TTL_MS,
  MAX_COMPLETED_TOOLS,
  STALL_AFTER_MS,
  activityEventIdentity,
  activityReducer,
  initialActivityState,
  sessionStatus,
  turnDurationMs,
} from './reducer';
import {
  ACTIVITY_NOTIFICATIONS_STORAGE_KEY,
  ACTIVITY_PAGE_SIZE,
  activityNotifications,
  activitySessionSummaries,
  formatActivityAgo,
  formatActivityDuration,
  recentCompletedTools,
} from '../components/ActivityPanel';
import { ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS } from '../layout';
import type { ActivityEvent, ActivitySessionState, ActivityState, ActivityTarget } from './types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Activity signal assertion failed: ${message}`);
}

const T0 = Date.parse('2026-09-01T12:00:00.000Z');

const base = {
  schemaVersion: 1 as const,
  sessionId: 'session:1',
  workspace: { id: 'local-9-abcdef12', root: '/workspace' },
  source: { client: 'copilot-cli' as const, kind: 'sdk' as const },
};

function envelope(overrides: Record<string, unknown>): ActivityEvent {
  const parsed = parseActivityEvent({ ...base, timestamp: new Date(T0).toISOString(), ...overrides });
  if (!parsed) throw new Error(`envelope rejected: ${JSON.stringify(overrides)}`);
  return parsed;
}

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function apply(state: ActivityState, event: ActivityEvent, now = T0, target?: ActivityTarget): ActivityState {
  return activityReducer(state, { type: 'event', event: target ? { ...event, target } : event, now });
}

const nodeTarget: ActivityTarget = { kind: 'node', id: 'namespace:app', match: 'node' };

export function runActivitySignalAssertions(): void {
  // ---- contract: bounded metadata (T1-P wire contract) --------------------
  const permissionRequest = envelope({
    id: 'permission-1',
    type: 'permission',
    status: 'requested',
    toolCallId: 'call:1',
    tool: 'shell',
    metadata: { permissionKind: 'shell' },
  });
  expect(activityType(permissionRequest) === 'permission', 'permission envelopes classify as permission, not unknown');
  expect(permissionLifecycle(permissionRequest) === 'requested', 'requested permissions open a wait');
  expect(activityAgentStatus(permissionRequest) === 'waiting', 'a requested permission puts its agent in waiting');
  expect(activitySummary(permissionRequest) === 'Awaiting approval · shell', 'permission summaries name the tool and nothing else');

  const approved = envelope({
    id: 'permission-2',
    type: 'permission',
    status: 'completed',
    toolCallId: 'call:1',
    metadata: { permissionResult: 'approved-for-session' },
  });
  expect(activityPermissionResult(approved) === 'approved-for-session', 'declared permission results survive parsing');
  expect(activityAgentStatus(approved) !== 'completed', 'a resolved permission never retires the agent');
  const bogus = envelope({ id: 'permission-3', type: 'permission', status: 'completed', metadata: { permissionResult: 'probably-fine' } });
  expect(bogus.metadata?.permissionResult === undefined, 'permission results outside the provider enum are dropped');
  expect(ACTIVITY_PERMISSION_RESULTS.length === 9, 'the permission enum matches the nine SDK kinds');

  const bounded = envelope({
    id: 'bounded-metadata',
    type: 'tool',
    status: 'completed',
    toolCallId: 'call:bounds',
    metadata: { exitCode: 2.7, count: 12.9, bytes: -1, durationMs: 2 ** 60 },
  });
  expect(bounded.metadata?.exitCode === 2, 'exit codes are truncated to integers');
  expect(bounded.metadata?.count === 12, 'counts are floored to integers');
  expect(bounded.metadata?.bytes === undefined, 'negative byte counts are dropped');
  expect(bounded.metadata?.durationMs === undefined, 'durations beyond the 2^53 cap are dropped');
  const outOfRange = envelope({ id: 'bounded-exit', type: 'tool', status: 'failed', toolCallId: 'call:x', metadata: { exitCode: 2 ** 40 } });
  expect(outOfRange.metadata?.exitCode === undefined, 'exit codes outside the signed 32-bit range are dropped');

  // ---- T1-B: waiting for approval ---------------------------------------
  let state = initialActivityState();
  state = apply(state, envelope({ id: 'session-start', type: 'session.start', status: 'started', timestamp: at(0) }), T0);
  state = apply(state, envelope({ ...permissionRequest, id: 'permission-req', timestamp: at(1_000) } as unknown as Record<string, unknown>), T0 + 1_000);
  const waitingSession = state.sessions.get('session:1');
  expect(waitingSession?.waiting?.toolCallId === 'call:1' && waitingSession.waiting.since === T0 + 1_000,
    'a requested permission records the session wait with its tool call and timestamp');
  expect(waitingSession?.waiting?.tool === 'shell', 'the wait names the tool the approval is for');
  expect(sessionStatus(waitingSession!, T0 + 1_000) === 'waiting', 'a pending permission makes the session read as waiting');
  const waitingAgent = [...state.agentNodes.values()].find(agent => agent.sessionId === 'session:1');
  expect(waitingAgent?.status === 'waiting' && waitingAgent.waitingToolCallId === 'call:1',
    'the owning agent glyph carries the waiting status and its tool call');
  expect(state.pulses.length === 0 && state.rays.length === 0 && state.snippetMarkers.length === 0,
    'permission envelopes never create pulses, rays, or snippet markers');

  let cleared = apply(state, envelope({
    id: 'permission-done',
    type: 'permission',
    status: 'completed',
    toolCallId: 'call:1',
    timestamp: at(2_000),
    metadata: { permissionResult: 'approved' },
  }), T0 + 2_000);
  expect(cleared.sessions.get('session:1')?.waiting === undefined, 'a completed permission clears the session wait');
  expect(cleared.sessions.get('session:1')?.lastDeniedAt === undefined, 'an approval does not record a denial');
  const clearedAgent = [...cleared.agentNodes.values()].find(agent => agent.sessionId === 'session:1');
  expect(clearedAgent?.waitingSince === undefined && clearedAgent?.status !== 'waiting', 'the agent glyph stops waiting once the permission resolves');

  const denied = apply(state, envelope({
    id: 'permission-denied',
    type: 'permission',
    status: 'completed',
    toolCallId: 'call:1',
    timestamp: at(2_000),
    metadata: { permissionResult: 'denied-interactively-by-user' },
  }), T0 + 2_000);
  const deniedSession = denied.sessions.get('session:1');
  expect(deniedSession?.lastDeniedAt === T0 + 2_000 && deniedSession.lastPermissionResult === 'denied-interactively-by-user',
    'a denied permission records when it was denied and which kind it was');
  expect(deniedSession?.waiting === undefined, 'a denial also clears the wait');
  expect([...denied.agentNodes.values()].some(agent => agent.lastDeniedAt === T0 + 2_000),
    'the owning agent records the denial for the canvas to flash');

  // A completion whose agentId is missing or different from its request's
  // must still resolve to the node that owns the open request — matched by
  // the toolCallId the two events share — never to a freshly synthesised
  // node (reducer.ts `permissionOwnerAgentNodeId`). Otherwise the waiting
  // agent never receives `lastDeniedAt` and the canvas has nothing to flash.
  let missingAgentId = initialActivityState();
  missingAgentId = apply(missingAgentId, envelope({
    id: 'owner-request-missing',
    type: 'permission',
    status: 'requested',
    agentId: 'sub-missing',
    toolCallId: 'call:owner-missing',
    tool: 'shell',
    timestamp: at(1_000),
  }), T0 + 1_000);
  const requesterMissing = [...missingAgentId.agentNodes.values()].find(agent => agent.agentId === 'sub-missing');
  expect(requesterMissing !== undefined && requesterMissing.waitingToolCallId === 'call:owner-missing' && requesterMissing.status === 'waiting',
    'the requesting subagent has its own node, waiting on its tool call');
  const nodeCountBeforeMissing = missingAgentId.agentNodes.size;
  expect(nodeCountBeforeMissing === 1, 'only the requesting subagent has a node before its completion arrives');

  const resolvedMissingAgentId = apply(missingAgentId, envelope({
    id: 'owner-completion-missing',
    type: 'permission',
    status: 'completed',
    // No agentId at all on the completion, unlike the request.
    toolCallId: 'call:owner-missing',
    timestamp: at(2_000),
    metadata: { permissionResult: 'denied-interactively-by-user' },
  }), T0 + 2_000);
  expect(resolvedMissingAgentId.agentNodes.size === nodeCountBeforeMissing,
    'a completion with no agentId does not synthesise a second agent node');
  const resolvedRequesterMissing = resolvedMissingAgentId.agentNodes.get(requesterMissing!.id);
  expect(resolvedRequesterMissing?.lastDeniedAt === T0 + 2_000,
    'the denial lands on the node that actually owns the open request, resolved by its shared toolCallId');
  expect(resolvedRequesterMissing?.waitingSince === undefined && resolvedRequesterMissing?.status !== 'waiting',
    'the requester stops waiting once its permission resolves, even though the completion carries no agentId');

  let mismatchedAgentId = initialActivityState();
  mismatchedAgentId = apply(mismatchedAgentId, envelope({
    id: 'owner-request-mismatch',
    type: 'permission',
    status: 'requested',
    agentId: 'sub-a',
    toolCallId: 'call:owner-mismatch',
    tool: 'shell',
    timestamp: at(1_000),
  }), T0 + 1_000);
  const requesterA = [...mismatchedAgentId.agentNodes.values()].find(agent => agent.agentId === 'sub-a');
  const nodeCountBeforeMismatch = mismatchedAgentId.agentNodes.size;
  expect(nodeCountBeforeMismatch === 1, 'only the requesting subagent "sub-a" has a node before its completion arrives');

  const resolvedMismatchedAgentId = apply(mismatchedAgentId, envelope({
    id: 'owner-completion-mismatch',
    type: 'permission',
    status: 'completed',
    agentId: 'sub-b', // names a different agent than the one that opened the request
    toolCallId: 'call:owner-mismatch',
    timestamp: at(2_000),
    metadata: { permissionResult: 'denied-by-rules' },
  }), T0 + 2_000);
  expect(resolvedMismatchedAgentId.agentNodes.size === nodeCountBeforeMismatch,
    'a completion naming a different agentId than the request does not synthesise a second agent node');
  expect(resolvedMismatchedAgentId.agentNodes.get(requesterA!.id)?.lastDeniedAt === T0 + 2_000,
    'the denial still lands on the original requester "sub-a", not on the mismatched "sub-b"');
  expect(![...resolvedMismatchedAgentId.agentNodes.values()].some(agent => agent.agentId === 'sub-b'),
    'no node is ever created for the mismatched agentId "sub-b" named only on the completion');

  // A permission that sits open past the agent-inactivity threshold and is
  // then denied must still land on a node layout.ts classifies as active —
  // not one already sorted into the inactive grid the instant its flash
  // fires (src/layout.ts:1186-1187, :493 — `now - agent.updatedAt >=
  // ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS`). This exercises the same
  // else-if(ownerId) branch as the mismatch cases above, but with a >5-minute
  // gap between request and completion, so `updatedAt` — and, kept paired
  // with it, `activity` and `lastEventId` — must come from the completion,
  // not the stale request.
  let staleGap = initialActivityState();
  staleGap = apply(staleGap, envelope({
    id: 'owner-request-stale-gap',
    type: 'permission',
    status: 'requested',
    agentId: 'sub-stale',
    toolCallId: 'call:owner-stale-gap',
    tool: 'shell',
    timestamp: at(1_000),
  }), T0 + 1_000);
  const requesterStale = [...staleGap.agentNodes.values()].find(agent => agent.agentId === 'sub-stale');
  expect(requesterStale?.updatedAt === T0 + 1_000, 'the requester is timestamped at the request');

  const pastThresholdOffset = 1_000 + ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS + 30_000; // comfortably over 5 minutes
  expect(pastThresholdOffset - 1_000 >= ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS,
    'sanity check on the fixture itself: the gap is long enough to actually exercise the inactive threshold');
  const staleGapCompletion = envelope({
    id: 'owner-completion-stale-gap',
    type: 'permission',
    status: 'completed',
    agentId: 'sub-other', // mismatched, same shape as the owner-attribution cases above
    toolCallId: 'call:owner-stale-gap',
    timestamp: at(pastThresholdOffset),
    metadata: { permissionResult: 'denied-interactively-by-user' },
  });
  const resolvedStaleGap = apply(staleGap, staleGapCompletion, T0 + pastThresholdOffset);
  const resolvedRequesterStale = resolvedStaleGap.agentNodes.get(requesterStale!.id);
  expect(resolvedRequesterStale?.lastDeniedAt === T0 + pastThresholdOffset,
    'the denial still lands on the original requester even after a multi-minute gap');
  expect(resolvedRequesterStale !== undefined
    && (T0 + pastThresholdOffset) - resolvedRequesterStale.updatedAt < ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS,
    'updatedAt refreshes to the completion, so layout.ts reads the owner as active — not inactive — the instant the denied flash fires');
  expect(resolvedRequesterStale?.lastEventId === activityEventIdentity(staleGapCompletion),
    'lastEventId also advances to the completion, staying paired with updatedAt');
  expect(resolvedRequesterStale?.activity === 'Permission denied-interactively-by-user',
    'the stale "Awaiting approval" text is replaced instead of outliving the resolution');

  // ---- T1-C: failures are red -------------------------------------------
  let failing = initialActivityState();
  failing = apply(failing, envelope({ id: 'tool-start', type: 'tool', status: 'started', toolCallId: 'call:9', tool: 'shell', timestamp: at(0) }), T0);
  failing = apply(failing, envelope({
    id: 'tool-fail',
    type: 'tool',
    status: 'failed',
    toolCallId: 'call:9',
    tool: 'shell',
    timestamp: at(1_500),
    metadata: { errorClassification: 'timeout', errorCode: 'ETIMEDOUT', exitCode: 124 },
  }), T0 + 1_500, nodeTarget);
  const failedPulse = failing.pulses.find(pulse => pulse.eventId === 'tool-fail' && pulse.target.id === 'namespace:app');
  expect(failedPulse?.kind === 'failed' && failedPulse.color === ACTIVITY_PULSE_COLORS.failed && ACTIVITY_PULSE_COLORS.failed === '#ff5c68',
    'a failed tool pulses red on its resolved target');
  expect(failedPulse !== undefined && failedPulse.expiresAt - failedPulse.startedAt === ACTIVITY_FAILED_PULSE_TTL_MS
    && ACTIVITY_FAILED_PULSE_TTL_MS === ACTIVITY_TARGET_TTL_MS * 2, 'failed pulses linger twice as long as ordinary pulses');
  expect(failing.pulses.filter(pulse => pulse.eventId === 'tool-fail').every(pulse => pulse.kind === 'failed'),
    'the tool-group pulse turns red with the target pulse');
  expect(failing.pulses.some(pulse => pulse.eventId === 'tool-start' && pulse.kind === 'execute'),
    'only the failure turns red — the tool start keeps its ordinary pulse');
  expect(!failing.activeTools.has('call:9'), 'a failed tool still leaves the active set');
  const failedEntry = failing.completedTools.at(-1);
  expect(failedEntry?.outcome === 'failed' && failedEntry.toolCallId === 'call:9',
    'a failed tool is kept in the completed ring instead of vanishing');
  expect(failedEntry?.errorClassification === 'timeout' && failedEntry.errorCode === 'ETIMEDOUT' && failedEntry.exitCode === 124,
    'the ring keeps the bounded failure classification, code, and exit code');
  expect(failedEntry?.durationMs === 1_500 && failedEntry.startedAt === T0, 'a failed tool still gets its derived duration');
  const failedSession = failing.sessions.get('session:1');
  expect(sessionStatus(failedSession!, T0 + 1_500) === 'failed', 'the most recent tool failing makes the session read as failed');
  expect(sessionStatus(failedSession!, T0 + 1_500 + ACTIVITY_FAILURE_WINDOW_MS + 1) !== 'failed',
    'the failed reading expires with the failure window');

  const errored = apply(initialActivityState(), envelope({
    id: 'session-error',
    type: 'error',
    status: 'failed',
    timestamp: at(500),
    metadata: { errorClassification: 'timeout', errorCode: 'ETIMEDOUT' },
  }), T0 + 500);
  expect(activityType(envelope({ id: 'error-kind', type: 'error', status: 'failed' })) === 'error',
    'session errors classify as error rather than unknown');
  const erroredSession = errored.sessions.get('session:1');
  expect(erroredSession?.lastErrorAt === T0 + 500 && erroredSession.lastErrorClassification === 'timeout',
    'a session error records its time and bounded classification');
  expect(erroredSession !== undefined && Object.values(erroredSession).every(value => typeof value !== 'string' || !value.includes('ETIMEDOUT')),
    'session error state carries a classification, never the raw code or message');
  expect(errored.unknownEvents.length === 0, 'a real session error is not filed as an unrecognized event');

  const unrecognized = apply(initialActivityState(), envelope({
    id: 'provider-unknown',
    type: 'error',
    status: 'unknown',
    timestamp: at(500),
    metadata: { unknownEvent: true, providerEventType: 'hook.start' },
  }), T0 + 500);
  expect(unrecognized.unknownEvents.length === 1, 'the producer’s unknown-event envelope stays in the unrecognized bucket');
  expect(unrecognized.sessions.get('session:1')?.lastErrorAt === undefined, 'an unrecognized provider event is not a session failure');

  // ---- T1-E: completed-tool ring with derived durations ------------------
  let ring = initialActivityState();
  ring = apply(ring, envelope({ id: 'ok-start', type: 'tool', status: 'started', toolCallId: 'call:ok', tool: 'grep', timestamp: at(0) }), T0);
  ring = apply(ring, envelope({
    id: 'ok-end',
    type: 'tool',
    status: 'completed',
    toolCallId: 'call:ok',
    tool: 'grep',
    timestamp: at(2_500),
    metadata: { count: 12, bytes: 4_096 },
  }), T0 + 2_500);
  const completedEntry = ring.completedTools.at(-1);
  expect(completedEntry?.outcome === 'completed' && completedEntry.durationMs === 2_500,
    'a completed tool derives its duration from the paired start');
  expect(completedEntry?.count === 12 && completedEntry.bytes === 4_096, 'reported counts and bytes ride along on the ring entry');
  expect(ring.sessions.get('session:1')?.lastToolOutcome === 'completed', 'the session remembers the newest tool outcome');

  const reported = apply(ring, envelope({
    id: 'reported-end',
    type: 'tool',
    status: 'completed',
    toolCallId: 'call:reported',
    tool: 'agent',
    timestamp: at(9_000),
    metadata: { durationMs: 77 },
  }), T0 + 9_000);
  expect(reported.completedTools.at(-1)?.durationMs === 77, 'a producer-reported duration wins over the derived one');
  const orphan = apply(ring, envelope({ id: 'orphan-end', type: 'tool', status: 'completed', toolCallId: 'call:orphan', tool: 'grep', timestamp: at(3_000) }), T0 + 3_000);
  const orphanEntry = orphan.completedTools.at(-1);
  expect(orphanEntry?.toolCallId === 'call:orphan' && orphanEntry.durationMs === undefined && orphanEntry.startedAt === undefined,
    'a completion with no known start is still recorded, without inventing a duration');

  let capped = initialActivityState();
  for (let index = 0; index < MAX_COMPLETED_TOOLS + 6; index += 1) {
    capped = apply(capped, envelope({
      id: `bulk-${index}`,
      type: 'tool',
      status: 'completed',
      toolCallId: `call:bulk:${index}`,
      tool: 'grep',
      timestamp: at(index * 10),
    }), T0 + index * 10);
  }
  expect(capped.completedTools.length === MAX_COMPLETED_TOOLS && MAX_COMPLETED_TOOLS === 64,
    'the completed ring is capped at sixty-four entries');
  expect(capped.completedTools.at(-1)?.toolCallId === `call:bulk:${MAX_COMPLETED_TOOLS + 5}`, 'the ring keeps the newest completions last');

  // ---- T1-D: turns and stalls -------------------------------------------
  let turns = initialActivityState();
  turns = apply(turns, envelope({ id: 'prompt-1', type: 'prompt', status: 'submitted', timestamp: at(0) }), T0);
  const openTurn = turns.sessions.get('session:1');
  expect(openTurn?.turn?.startedAt === T0 && openTurn.turn.endedAt === undefined, 'a submitted prompt opens a turn');
  expect(sessionStatus(openTurn!, T0 + 5_000) === 'active', 'an open turn reads as active');
  expect(turnDurationMs(openTurn!, T0 + 5_000) === 5_000, 'an open turn reports elapsed time');
  expect(sessionStatus(openTurn!, T0 + STALL_AFTER_MS + 1) === 'stalled' && STALL_AFTER_MS === 180_000,
    'an open turn with no events for three minutes reads as stalled');
  expect(sessionStatus(openTurn!, T0 + STALL_AFTER_MS) === 'active', 'a turn is not stalled until the threshold passes');

  const workedOn = apply(turns, envelope({ id: 'tool-mid', type: 'tool', status: 'started', toolCallId: 'call:mid', tool: 'grep', timestamp: at(60_000) }), T0 + 60_000);
  expect(workedOn.sessions.get('session:1')?.turn?.lastEventAt === T0 + 60_000, 'any event refreshes the open turn');
  expect(sessionStatus(workedOn.sessions.get('session:1')!, T0 + 60_000 + STALL_AFTER_MS - 1) === 'active',
    'activity inside a turn pushes the stall threshold out');

  const closedByAgent = apply(turns, envelope({ id: 'agent-done', type: 'agent', status: 'completed', timestamp: at(4_000) }), T0 + 4_000);
  const closedTurn = closedByAgent.sessions.get('session:1');
  expect(closedTurn?.turn?.endedAt === T0 + 4_000, 'the session’s top-level agent completing closes the turn');
  expect(sessionStatus(closedTurn!, T0 + 4_000) === 'idle', 'a session with no open turn reads as idle');
  expect(turnDurationMs(closedTurn!, T0 + 90_000) === 4_000, 'a closed turn reports its final duration');

  const subagentDone = apply(turns, envelope({ id: 'subagent-done', type: 'agent', status: 'completed', agentId: 'sub-1', timestamp: at(3_000) }), T0 + 3_000);
  expect(subagentDone.sessions.get('session:1')?.turn?.endedAt === undefined, 'a subagent completing does not close the session turn');

  const closedByIdle = apply(turns, envelope({ id: 'idle-1', type: 'session', status: 'idle', timestamp: at(6_000) }), T0 + 6_000);
  expect(closedByIdle.sessions.get('session:1')?.turn?.endedAt === T0 + 6_000, 'session idle closes the turn');

  const reprompted = apply(closedByIdle, envelope({ id: 'prompt-2', type: 'prompt', status: 'submitted', timestamp: at(7_000) }), T0 + 7_000);
  expect(reprompted.sessions.get('session:1')?.turn?.startedAt === T0 + 7_000
    && reprompted.sessions.get('session:1')?.turn?.endedAt === undefined, 'a new prompt opens a fresh turn');

  const ended = apply(closedByIdle, envelope({ id: 'session-end', type: 'session.end', status: 'completed', timestamp: at(8_000) }), T0 + 8_000);
  expect(sessionStatus(ended.sessions.get('session:1')!, T0 + 8_000) === 'ended', 'a session reads as ended once it ends');

  // ---- sessionStatus precedence -----------------------------------------
  const stressed: ActivitySessionState = {
    id: 'session:1',
    startedAt: T0,
    lastEventAt: T0,
    endedAt: T0,
    turn: { startedAt: T0, lastEventAt: T0 },
    waiting: { toolCallId: 'call:1', since: T0 },
    lastErrorAt: T0,
    lastToolOutcome: 'failed',
    lastToolOutcomeAt: T0,
  };
  expect(sessionStatus(stressed, T0) === 'waiting', 'waiting outranks every other signal');
  const { waiting: _waiting, ...withoutWaiting } = stressed;
  void _waiting;
  expect(sessionStatus(withoutWaiting, T0) === 'failed', 'failed outranks stalled, active, idle, and ended');
  const { lastErrorAt: _errorAt, lastToolOutcome: _outcome, lastToolOutcomeAt: _outcomeAt, ...withoutFailure } = withoutWaiting;
  void _errorAt; void _outcome; void _outcomeAt;
  expect(sessionStatus(withoutFailure, T0 + STALL_AFTER_MS + 1) === 'stalled', 'stalled outranks active, idle, and ended');
  expect(sessionStatus(withoutFailure, T0) === 'active', 'active outranks idle and ended');
  const { turn: _turn, ...withoutTurn } = withoutFailure;
  void _turn;
  expect(sessionStatus(withoutTurn, T0) === 'ended', 'an ended session with no open turn reads as ended');
  const { endedAt: _endedAt, ...alive } = withoutTurn;
  void _endedAt;
  expect(sessionStatus(alive, T0) === 'idle', 'a live session with no open turn reads as idle');

  // ---- T1-F: session chips and the panel --------------------------------
  const summaries = activitySessionSummaries(state, T0 + 1_000);
  const summary = summaries.find(entry => entry.id === 'session:1');
  expect(summary?.status === 'waiting' && summary.lastEventAt === T0 + 1_000,
    'session summaries carry the derived status and the last event time');
  expect(summary?.waitingTool === 'shell', 'a waiting chip names the tool it is blocked on');
  const activeSummary = activitySessionSummaries(turns, T0 + 252_000).find(entry => entry.id === 'session:1');
  expect(activeSummary?.status === 'stalled', 'the chip turns stalled once the open turn goes quiet');
  const runningSummary = activitySessionSummaries(turns, T0 + 4_000).find(entry => entry.id === 'session:1');
  expect(runningSummary?.status === 'active' && runningSummary.turnDurationMs === 4_000,
    'an active chip exposes the running turn timer');
  expect(formatActivityDuration(252_000) === '4m12s' && formatActivityDuration(900) === '900ms' && formatActivityDuration(2_500) === '2s',
    'durations render compactly');
  expect(formatActivityAgo(12_000) === '12 s ago' && formatActivityAgo(120_000) === '2 m ago', 'elapsed times render as "12 s ago"');

  const paged = recentCompletedTools(capped, ACTIVITY_PAGE_SIZE);
  expect(paged.length === ACTIVITY_PAGE_SIZE && paged[0].toolCallId === `call:bulk:${MAX_COMPLETED_TOOLS + 5}`,
    'the completed-tool list starts with the ten newest outcomes');
  expect(recentCompletedTools(capped, ACTIVITY_PAGE_SIZE * 2).length === ACTIVITY_PAGE_SIZE * 2, 'the completed-tool list pages ten at a time');
  expect(recentCompletedTools(capped, ACTIVITY_PAGE_SIZE, new Set(['session:other'])).length === 0,
    'the completed-tool list honours the session filter');

  const waitingNotifications = activityNotifications(state, T0 + 1_000);
  expect(waitingNotifications.length === 1 && waitingNotifications[0].key === 'waiting:call:1',
    'a blocked session notifies once, keyed by its tool call');
  expect(waitingNotifications[0].body.includes('shell') && !waitingNotifications[0].body.includes('rm -rf'),
    'notifications name the tool and never carry snippet or prompt text');
  expect(activityNotifications(cleared, T0 + 2_000).length === 0, 'a resolved permission stops notifying');
  const failureNotifications = activityNotifications(failing, T0 + 1_500);
  expect(failureNotifications.length === 1 && failureNotifications[0].key === 'failed:call:9',
    'a failed session notifies once, keyed by the failing tool call');
  expect(ACTIVITY_NOTIFICATIONS_STORAGE_KEY === 'codewalk.activityNotifications', 'the notification opt-in persists under the documented key');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('activity signals', runActivitySignalAssertions);
