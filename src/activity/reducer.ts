import { activityAgentColor, activityAgentId, activityAgentIdentity, activityAgentLabel, activityAgentStatus, activityGroupId, activityPermissionDenied, activityPermissionResult, activitySnippet, activitySourceIdentity, activitySummary, activityType, permissionLifecycle, toolLifecycle } from './contract';
import type { ActivityAction, ActivityAgentNode, ActivityAgentState, ActivityEvent, ActivityPulse, ActivityRay, ActivitySessionState, ActivitySessionStatus, ActivitySessionTurn, ActivitySnippetMarker, ActivityState, ActivityTarget, ActivityToolOutcome, ActivityToolState } from './types';

export const MAX_ACTIVITY_EVENTS = 500;
export const MAX_UNKNOWN_ACTIVITY_EVENTS = 100;
export const MAX_ACTIVITY_RAYS = 128;
export const MAX_ACTIVITY_PULSES = 256;
export const MAX_ACTIVITY_SNIPPET_MARKERS = 64;
export const MAX_ACTIVITY_SNIPPET_MARKERS_PER_GROUP = 12;
export const MAX_COMPLETED_TOOLS = 64;
export const MAX_ACTIVITY_SESSIONS = 64;
export const ACTIVITY_SNIPPET_MARKER_HOLD_MS = 20000;
export const ACTIVITY_SNIPPET_MARKER_TTL_MS = 30000;
export const ACTIVITY_TARGET_HOLD_MS = 30000;
export const ACTIVITY_TARGET_FADE_MS = 30000;
export const ACTIVITY_TARGET_TTL_MS = ACTIVITY_TARGET_HOLD_MS + ACTIVITY_TARGET_FADE_MS;
export const ACTIVITY_TARGET_BASELINE_OPACITY = 0.16;
export const ACTIVITY_RAY_TTL_MS = 30000;
export const ACTIVITY_PULSE_TTL_MS = ACTIVITY_TARGET_TTL_MS;
/** Failures linger twice as long as ordinary activity so they cannot be missed (T1-C). */
export const ACTIVITY_FAILED_PULSE_TTL_MS = ACTIVITY_TARGET_TTL_MS * 2;
/** An open turn with no events for this long reads as stalled (T1-D). */
export const STALL_AFTER_MS = 3 * 60_000;
/** How long a session keeps reading as failed after an error or a failed tool (T1-C/T1-F). */
export const ACTIVITY_FAILURE_WINDOW_MS = 60_000;

export const ACTIVITY_PULSE_COLORS = {
  read: '#4da3ff',
  write: '#ff4d5a',
  search: '#df8eff',
  execute: '#49d8b0',
  session: '#7898ff',
  network: '#ffb347',
  failed: '#ff5c68',
  unknown: '#a0abc2',
} as const;

function eventCompare(left: ActivityEvent, right: ActivityEvent): number {
  if (left.recordingSequence !== undefined && right.recordingSequence !== undefined
    && left.recordingSequence !== right.recordingSequence) {
    return left.recordingSequence - right.recordingSequence;
  }
  if (left.sessionId === right.sessionId && left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  return left.timestamp.localeCompare(right.timestamp)
    || (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)
    || activityEventIdentity(left).localeCompare(activityEventIdentity(right));
}

function activeSessionEvent(event: ActivityEvent): boolean {
  return event.type === 'session.start' || event.type === 'session.started' || event.type === 'session.status'
    || event.type === 'agent.start'
    || event.type === 'session' && ['started', 'resumed', 'active', 'updated'].includes(event.status ?? '');
}

function isSessionEnd(event: ActivityEvent): boolean {
  return event.type === 'session.end' || event.type === 'session.ended' || event.type === 'agent.stop' || event.type === 'agent.error'
    || event.type === 'session' && ['completed', 'ended', 'failed', 'stopped'].includes(event.status ?? '');
}

function activeAgentEvent(event: ActivityEvent): boolean {
  return event.type.startsWith('agent.') || event.type.startsWith('subagent.') || Boolean(event.agentId);
}

function toolState(state: ActivityState, event: ActivityEvent, now: number): ActivityToolState | null {
  const lifecycle = toolLifecycle(event);
  const id = event.toolCallId ?? (lifecycle === 'started' ? event.id : undefined);
  if (!id) return null;
  const previous = state.activeTools.get(id);
  return {
    id,
    sessionId: event.sessionId,
    ...(event.agentId ?? previous?.agentId ? { agentId: event.agentId ?? previous?.agentId } : {}),
    ...(event.tool ?? previous?.tool ? { tool: event.tool ?? previous?.tool } : {}),
    summary: activitySummary(event),
    status: event.status ?? (lifecycle === 'failed' ? 'failed' : lifecycle === 'completed' ? 'completed' : 'running'),
    // The first start wins so a later update cannot shorten the derived duration.
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
  };
}

function metadataNumber(event: ActivityEvent, key: string): number | undefined {
  const value = event.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Pair a completion with its `toolCallId` start and fold it into the completed
 * ring (T1-E). Producer-reported durations win; otherwise the duration is
 * derived, and a completion whose start was never seen has none at all.
 */
function toolOutcome(state: ActivityState, event: ActivityEvent, eventNow: number): ActivityToolOutcome | null {
  const lifecycle = toolLifecycle(event);
  if (lifecycle !== 'completed' && lifecycle !== 'failed') return null;
  const toolCallId = event.toolCallId;
  if (!toolCallId) return null;
  const started = state.activeTools.get(toolCallId);
  const reportedDuration = metadataNumber(event, 'durationMs');
  const durationMs = reportedDuration ?? (started ? Math.max(0, eventNow - started.startedAt) : undefined);
  const tool = event.tool ?? started?.tool;
  const agentId = event.agentId ?? started?.agentId;
  const errorClassification = metadataString(event, 'errorClassification');
  const errorCode = metadataString(event, 'errorCode');
  const exitCode = metadataNumber(event, 'exitCode');
  const count = metadataNumber(event, 'count');
  const bytes = metadataNumber(event, 'bytes');
  return {
    id: activityEventIdentity(event),
    toolCallId,
    ...(tool ? { tool } : {}),
    sessionId: event.sessionId,
    ...(agentId ? { agentId } : {}),
    ...(started ? { startedAt: started.startedAt } : {}),
    endedAt: eventNow,
    ...(durationMs === undefined ? {} : { durationMs }),
    outcome: lifecycle,
    ...(errorClassification ? { errorClassification } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(count === undefined ? {} : { count }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(event.target ? { target: event.target } : {}),
    summary: activitySummary(event),
  };
}

function sessionIdleEvent(event: ActivityEvent): boolean {
  return event.type === 'session.idle' || event.type === 'session' && event.status === 'idle';
}

/** `user.message` normalises to `{type:'prompt', status:'submitted'}` upstream. */
function turnOpeningEvent(event: ActivityEvent): boolean {
  if (event.type === 'user.message') return true;
  if (event.type !== 'prompt' && !event.type.startsWith('prompt.')) return false;
  return event.status === undefined || event.status === 'submitted' || event.status === 'started';
}

/** Only the session's own top-level agent closes a turn; subagents finish inside one. */
function turnClosingEvent(event: ActivityEvent): boolean {
  if (sessionIdleEvent(event) || isSessionEnd(event)) return true;
  if (activityAgentId(event) !== event.sessionId) return false;
  const agentish = event.type === 'agent' || event.type === 'subagent'
    || event.type.startsWith('agent.') || event.type.startsWith('subagent.');
  return agentish && (['completed', 'complete'].includes(event.status ?? '') || /completed$/.test(event.type));
}

/**
 * A session-level error, as distinct from the `{type:'error', status:'unknown'}`
 * envelope the producer uses to retain provider events it does not recognise —
 * an unrecognised event is not a failure, and neither is a warning.
 */
function sessionErrorEvent(event: ActivityEvent): boolean {
  return activityType(event) === 'error'
    && event.metadata?.unknownEvent !== true
    && event.status !== 'warning'
    && event.status !== 'unknown';
}

function updateSessions(state: ActivityState, event: ActivityEvent, eventNow: number, outcome: ActivityToolOutcome | null): Map<string, ActivitySessionState> {
  const sessions = new Map(state.sessions);
  const previous = sessions.get(event.sessionId);
  const permission = permissionLifecycle(event);
  const denied = permission === 'completed' && activityPermissionDenied(event);
  const ended = isSessionEnd(event);

  let turn: ActivitySessionTurn | undefined = previous?.turn;
  if (turnOpeningEvent(event)) turn = { startedAt: eventNow, lastEventAt: eventNow };
  else if (turn && turn.endedAt === undefined) turn = { ...turn, lastEventAt: Math.max(turn.lastEventAt, eventNow) };
  if (turn && turn.endedAt === undefined && turnClosingEvent(event)) turn = { ...turn, endedAt: eventNow };

  let waiting = previous?.waiting;
  if (permission === 'requested' && event.toolCallId) {
    waiting = {
      toolCallId: event.toolCallId,
      since: eventNow,
      ...(event.tool ? { tool: event.tool } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(metadataString(event, 'permissionKind') ? { permissionKind: metadataString(event, 'permissionKind') } : {}),
    };
  } else if (permission === 'completed') {
    waiting = undefined;
  } else if (waiting && event.toolCallId === waiting.toolCallId && toolLifecycle(event)) {
    // The gated tool ran (or failed), so the request resolved even if the
    // resolution envelope never arrived. Without this a halo could stick.
    waiting = undefined;
  }

  const error = sessionErrorEvent(event);
  const permissionResult = permission === 'completed' ? activityPermissionResult(event) : undefined;
  const errorClassification = error ? metadataString(event, 'errorClassification') : undefined;
  const endedAt = ended ? eventNow : activeSessionEvent(event) ? undefined : previous?.endedAt;
  const lastDeniedAt = denied ? eventNow : previous?.lastDeniedAt;
  const lastPermissionResult = permissionResult ?? previous?.lastPermissionResult;
  const lastErrorAt = error ? eventNow : previous?.lastErrorAt;
  const lastErrorClassification = error ? errorClassification : previous?.lastErrorClassification;
  const lastToolOutcome = outcome?.outcome ?? previous?.lastToolOutcome;
  const lastToolOutcomeAt = outcome ? outcome.endedAt : previous?.lastToolOutcomeAt;
  const session: ActivitySessionState = {
    id: event.sessionId,
    startedAt: previous?.startedAt ?? eventNow,
    lastEventAt: Math.max(previous?.lastEventAt ?? 0, eventNow),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(turn ? { turn } : {}),
    ...(waiting ? { waiting } : {}),
    ...(lastDeniedAt === undefined ? {} : { lastDeniedAt }),
    ...(lastPermissionResult === undefined ? {} : { lastPermissionResult }),
    ...(lastErrorAt === undefined ? {} : { lastErrorAt }),
    ...(lastErrorClassification === undefined ? {} : { lastErrorClassification }),
    ...(lastToolOutcome === undefined ? {} : { lastToolOutcome }),
    ...(lastToolOutcomeAt === undefined ? {} : { lastToolOutcomeAt }),
  };
  sessions.set(event.sessionId, session);
  if (sessions.size > MAX_ACTIVITY_SESSIONS) {
    [...sessions.values()]
      .filter(entry => entry.id !== event.sessionId)
      .sort((left, right) => left.lastEventAt - right.lastEventAt || left.id.localeCompare(right.id))
      .slice(0, sessions.size - MAX_ACTIVITY_SESSIONS)
      .forEach(entry => sessions.delete(entry.id));
  }
  return sessions;
}

/**
 * The agent that owns a permission request: first, whichever existing node in
 * this session is already waiting on this exact `toolCallId` — a completion
 * can carry a missing or different `agentId` than the request it resolves,
 * but the two always share `toolCallId` (`ActivityAgentNode.waitingToolCallId`
 * exists for exactly this correlation). Only when no node is waiting on this
 * call does identity take over: the one named directly on the envelope,
 * otherwise the session's top-level agent (whose synthetic agent id is the
 * session id, see `activityAgentId`), otherwise the session's most recently
 * active agent.
 */
function permissionOwnerAgentNodeId(event: ActivityEvent, agentNodes: Map<string, ActivityAgentNode>): string | undefined {
  const candidates = [...agentNodes.values()].filter(node => node.sessionId === event.sessionId);
  const toolCallId = event.toolCallId;
  if (toolCallId) {
    const waiting = candidates
      .filter(node => node.waitingToolCallId === toolCallId)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0];
    if (waiting) return waiting.id;
  }
  const direct = activityAgentIdentity(event);
  if (direct) return direct;
  const named = event.agentId ? candidates.find(node => node.agentId === event.agentId) : undefined;
  if (named) return named.id;
  const topLevel = candidates.find(node => node.agentId === event.sessionId);
  if (topLevel) return topLevel.id;
  return candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0]?.id;
}

function updateActors(state: ActivityState, event: ActivityEvent, eventNow: number, outcome: ActivityToolOutcome | null) {
  const activeSessions = new Map(state.activeSessions);
  const activeAgents = new Map(state.activeAgents);
  const agentNodes = new Map(state.agentNodes);
  const activeTools = new Map(state.activeTools);
  const permission = permissionLifecycle(event);
  if (activeSessionEvent(event)) activeSessions.set(event.sessionId, event);
  if (isSessionEnd(event)) activeSessions.delete(event.sessionId);
  if (activeAgentEvent(event)) {
    const agentId = activityAgentId(event);
    const terminalAgentEvent = (event.type === 'agent' || event.type === 'subagent'
      || event.type.startsWith('agent.') || event.type.startsWith('subagent.'))
      && (['completed', 'complete', 'failed', 'error', 'stopped'].includes(event.status ?? '')
        || /(?:completed|failed|stopped|error)$/.test(event.type));
    if (isSessionEnd(event) || terminalAgentEvent) {
      activeAgents.delete(agentId);
    } else {
      activeAgents.set(agentId, {
        id: agentId,
        sessionId: event.sessionId,
        status: permission ? activityAgentStatus(event) : event.status ?? (event.type === 'agent.waiting' ? 'waiting' : 'active'),
        lastEventId: activityEventIdentity(event),
        updatedAt: eventNow,
      });
    }
  }
  const agentNodeId = activityAgentIdentity(event);
  // A permission completion can name a missing or different agent than its
  // request; `permissionOwnerAgentNodeId` resolves the node that actually owns
  // the open request (preferring the shared `toolCallId` over identity — see
  // its doc comment). Resolve ownership against the state as of *before* this
  // event so a mismatched completion cannot synthesise a fresh node for its
  // own (wrong) identity and then separately patch the real owner: when the
  // owner is a different, already-existing node, only it is touched below.
  const ownerId = permission ? permissionOwnerAgentNodeId(event, agentNodes) : undefined;
  const directNodeIsOwner = !permission || ownerId === undefined || ownerId === agentNodeId;
  if (agentNodeId && directNodeIsOwner) {
    const previousAgentNode = state.agentNodes.get(agentNodeId);
    const sessionName = event.sessionName ?? previousAgentNode?.sessionName;
    const agentName = event.agentName ?? previousAgentNode?.agentName;
    const waiting = agentWaiting(event, previousAgentNode, eventNow, permission);
    const lastDeniedAt = permission === 'completed' && activityPermissionDenied(event) ? eventNow : previousAgentNode?.lastDeniedAt;
    const agentNode: ActivityAgentNode = {
      id: agentNodeId,
      agentId: previousAgentNode?.agentId ?? activityAgentId(event),
      sessionId: event.sessionId,
      ...(sessionName ? { sessionName } : {}),
      ...(agentName ? { agentName } : {}),
      label: activityAgentLabel(event, previousAgentNode?.label),
      status: waiting ? 'waiting' : activityAgentStatus(event),
      activity: activitySummary(event),
      color: activityAgentColor(agentNodeId),
      lastEventId: activityEventIdentity(event),
      updatedAt: eventNow,
      ...(event.workspace?.id ? { workspaceId: event.workspace.id } : {}),
      source: activitySourceIdentity(event),
      ...(event.parentId ? { parentId: event.parentId } : {}),
      ...(waiting ?? {}),
      ...(lastDeniedAt === undefined ? {} : { lastDeniedAt }),
    };
    agentNodes.set(agentNodeId, agentNode);
  } else if (ownerId) {
    const owner = agentNodes.get(ownerId);
    if (owner) {
      const waiting = agentWaiting(event, owner, eventNow, permission);
      const lastDeniedAt = permission === 'completed' && activityPermissionDenied(event) ? eventNow : owner.lastDeniedAt;
      const { waitingSince, waitingToolCallId, ...rest } = owner;
      void waitingSince;
      void waitingToolCallId;
      agentNodes.set(owner.id, {
        ...rest,
        // status/activity/lastEventId/updatedAt are all recomputed fresh from
        // this event rather than reused from the owner's prior values, matching
        // the direct-node branch above. Diverging here would leave this branch's
        // node with stale display text (`activity`, rendered verbatim in
        // GraphCanvas as "status · activity") and, more importantly, a stale
        // `updatedAt`: src/layout.ts sorts agents into the active/inactive grid
        // on `now - agent.updatedAt >= ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS`
        // (5 minutes). A permission left unanswered past that window and then
        // resolved here would otherwise get its denied flash rendered from
        // inside the inactive grid, at the exact moment it should read as
        // freshly active.
        status: waiting ? 'waiting' : activityAgentStatus(event),
        activity: activitySummary(event),
        lastEventId: activityEventIdentity(event),
        updatedAt: eventNow,
        ...(waiting ?? {}),
        ...(lastDeniedAt === undefined ? {} : { lastDeniedAt }),
      });
    }
  }
  const tool = toolState(state, event, eventNow);
  if (tool) {
    if (toolLifecycle(event) === 'completed' || toolLifecycle(event) === 'failed') activeTools.delete(tool.id);
    else activeTools.set(tool.id, tool);
  }
  const completedTools = outcome
    ? [...state.completedTools.filter(entry => entry.toolCallId !== outcome.toolCallId), outcome].slice(-MAX_COMPLETED_TOOLS)
    : state.completedTools;
  return { activeSessions, activeAgents, agentNodes, activeTools, completedTools };
}

type AgentWaiting = { waitingSince: number; waitingToolCallId?: string } | undefined;

function agentWaiting(event: ActivityEvent, previous: ActivityAgentNode | undefined, eventNow: number, permission: ReturnType<typeof permissionLifecycle>): AgentWaiting {
  if (permission === 'requested') {
    return { waitingSince: eventNow, ...(event.toolCallId ? { waitingToolCallId: event.toolCallId } : {}) };
  }
  if (permission === 'completed') return undefined;
  if (previous?.waitingSince === undefined) return undefined;
  if (previous.waitingToolCallId && event.toolCallId === previous.waitingToolCallId && toolLifecycle(event)) return undefined;
  return { waitingSince: previous.waitingSince, ...(previous.waitingToolCallId ? { waitingToolCallId: previous.waitingToolCallId } : {}) };
}

/**
 * Pure session triage (T1-D/T1-F). Precedence is fixed: a blocked session is
 * the most actionable thing on screen, then a recent failure, then a turn that
 * has gone quiet, then ordinary progress.
 */
export function sessionStatus(session: ActivitySessionState, now: number): ActivitySessionStatus {
  if (session.waiting) return 'waiting';
  const failedRecently = (session.lastErrorAt !== undefined && now - session.lastErrorAt <= ACTIVITY_FAILURE_WINDOW_MS)
    || (session.lastToolOutcome === 'failed' && session.lastToolOutcomeAt !== undefined && now - session.lastToolOutcomeAt <= ACTIVITY_FAILURE_WINDOW_MS);
  if (failedRecently) return 'failed';
  const openTurn = session.turn !== undefined && session.turn.endedAt === undefined;
  if (openTurn && now - session.lastEventAt > STALL_AFTER_MS) return 'stalled';
  if (openTurn) return 'active';
  return session.endedAt === undefined ? 'idle' : 'ended';
}

/** Elapsed time in the session's current turn, or its last one once closed. */
export function turnDurationMs(session: ActivitySessionState, now: number): number | undefined {
  if (!session.turn) return undefined;
  return Math.max(0, (session.turn.endedAt ?? now) - session.turn.startedAt);
}

export function initialActivityState(): ActivityState {
  return {
    events: [],
    unknownEvents: [],
    activeSessions: new Map(),
    activeAgents: new Map(),
    agentNodes: new Map(),
    activeTools: new Map(),
    sessions: new Map(),
    completedTools: [],
    pulses: [],
    rays: [],
    snippetMarkers: [],
    seenIds: new Set(),
    connection: { status: 'disabled', reconnectAttempt: 0, coverage: 'unavailable' },
    revision: 0,
  };
}

function boundedSeenIds(ids: Set<string>, events: ActivityEvent[]): Set<string> {
  const retained = new Set(ids);
  events.forEach(event => {
    retained.add(activityEventIdentity(event));
    retained.add(providerEventIdentity(event));
  });
  // Retain recent IDs only; old events are no longer in the bounded replay window.
  return new Set([...retained].slice(-1000));
}

function providerEventIdentity(event: ActivityEvent): string {
  return `provider:${JSON.stringify([activitySourceIdentity(event), event.sessionId, event.id])}`;
}

function directFileToolEvent(event: ActivityEvent, agentNodeId: string | undefined): boolean {
  const explicitFileEvent = event.type === 'file.read' || event.type === 'file.write';
  if (!agentNodeId || (!explicitFileEvent && !event.tool && event.type !== 'tool' && !event.type.startsWith('tool.'))) return false;
  const hasFileTarget = Boolean(event.target?.file || event.resources?.some(resource => resource.file || resource.path));
  if (!hasFileTarget) return false;
  const action = event.resources?.find(resource => resource.action)?.action;
  if (action === 'read' || action === 'reference' || action === 'write') return true;
  const tool = event.tool?.toLowerCase().replace(/[_-]+/g, '.');
  return Boolean(tool && /^(?:view(?:\.file)?|read(?:\.file)?|apply.patch|write(?:\.file)?|update(?:\.file)?|edit(?:\.file)?|file\.(?:read|write|update))$/.test(tool));
}

function directFileActivityKind(event: ActivityEvent, fallback: ReturnType<typeof activityType>): ReturnType<typeof activityType> {
  const action = event.resources?.find(resource => resource.action)?.action;
  if (action === 'read' || action === 'reference') return 'read';
  if (action === 'write') return 'write';
  const tool = event.tool?.toLowerCase().replace(/[_-]+/g, '.');
  if (tool && /^(?:view(?:\.file)?|read(?:\.file)?|file\.read)$/.test(tool)) return 'read';
  if (tool && /^(?:apply.patch|write(?:\.file)?|update(?:\.file)?|edit(?:\.file)?|file\.(?:write|update))$/.test(tool)) return 'write';
  return fallback;
}

function metadataString(event: ActivityEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function canonicalAgentNodeId(workspaceId: string | undefined, sessionId: string, agentId: string): string {
  return `agent:${encodeURIComponent(JSON.stringify([workspaceId ?? '', sessionId, agentId]))}`;
}

interface ResolvedActivityAgentLinkTarget {
  target: ActivityTarget;
  link: NonNullable<ActivityRay['agentLink']>;
}

function agentLinkTarget(event: ActivityEvent, state: ActivityState): ResolvedActivityAgentLinkTarget | undefined {
  const tool = event.tool?.toLowerCase().replace(/[_-]+/g, '.');
  if (tool !== 'read.agent' && tool !== 'write.agent') return undefined;
  const targetAgentId = metadataString(event, 'targetAgentId');
  if (!targetAgentId) return undefined;
  const targetNodeId = metadataString(event, 'targetAgentNodeId');
  const targetSessionId = metadataString(event, 'targetSessionId');
  const targetWorkspaceSelector = metadataString(event, 'targetWorkspaceId');
  const targetWorkspaceId = targetWorkspaceSelector ?? event.workspace?.id;
  const candidates = [...state.agentNodes.values()].filter(agent => agent.agentId === targetAgentId
    && (!targetWorkspaceId || !agent.workspaceId || agent.workspaceId === targetWorkspaceId));
  const sessionCandidate = targetSessionId ? candidates.filter(agent => agent.sessionId === targetSessionId) : [];
  const candidate = sessionCandidate.length === 1 ? sessionCandidate[0] : candidates.length === 1 ? candidates[0] : undefined;
  const id = targetNodeId ?? (targetAgentId.startsWith('agent:') ? targetAgentId : undefined)
    ?? candidate?.id
    ?? canonicalAgentNodeId(targetWorkspaceId, targetSessionId ?? event.sessionId, targetAgentId);
  return {
    target: {
      kind: 'node',
      id,
      match: 'node',
      ...(targetWorkspaceId ? { workspaceId: targetWorkspaceId } : {}),
    },
    link: {
      targetAgentId,
      ...(targetNodeId ? { targetAgentNodeId: targetNodeId } : {}),
      ...(targetSessionId ? { targetSessionId } : {}),
      ...(targetWorkspaceSelector ? { targetWorkspaceId: targetWorkspaceSelector } : {}),
      flowDirection: tool === 'read.agent' ? 'target-to-source' : 'source-to-target',
    },
  };
}

function directAgentActivityKind(event: ActivityEvent, fallback: ReturnType<typeof activityType>): ReturnType<typeof activityType> {
  const tool = event.tool?.toLowerCase().replace(/[_-]+/g, '.');
  if (tool === 'read.agent') return 'read';
  if (tool === 'write.agent') return 'write';
  return fallback;
}

export function activityEventIdentity(event: ActivityEvent): string {
  return event.sseId ? `sse:${event.sseId}` : providerEventIdentity(event);
}

export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  if (action.type === 'reset') return initialActivityState();
  if (action.type === 'connection') {
    return {
      ...state,
      connection: {
        ...state.connection,
        status: action.status,
        reconnectAttempt: action.attempt ?? state.connection.reconnectAttempt,
        ...(action.error ? { lastError: action.error } : {}),
        ...(action.lastEventId ? { lastEventId: action.lastEventId } : {}),
        coverage: action.status === 'unavailable' ? 'unavailable' : state.connection.coverage === 'unavailable' ? 'observed' : state.connection.coverage,
      },
      revision: state.revision + 1,
    };
  }
  if (action.type === 'gap') {
    return {
      ...state,
      connection: {
        ...state.connection,
        status: 'gap',
        coverage: 'partial',
        replayGap: {
          ...(action.from ? { from: action.from } : {}),
          ...(action.to ? { to: action.to } : {}),
          ...(action.requestedId ? { requestedId: action.requestedId } : {}),
          ...(action.oldestId ? { oldestId: action.oldestId } : {}),
          ...(action.reason ? { reason: action.reason } : {}),
        },
      },
      revision: state.revision + 1,
    };
  }
  if (action.type === 'expire') {
    const now = action.now ?? Date.now();
    const pulses = state.pulses.filter(pulse => pulse.expiresAt > now);
    const rays = state.rays.filter(ray => ray.expiresAt > now);
    const snippetMarkers = state.snippetMarkers.filter(marker => marker.expiresAt > now);
    if (pulses.length === state.pulses.length && rays.length === state.rays.length && snippetMarkers.length === state.snippetMarkers.length) return state;
    return { ...state, pulses, rays, snippetMarkers, revision: state.revision + 1 };
  }

  const now = action.now ?? Date.now();
  const event = action.event;
  const eventKey = activityEventIdentity(event);
  const providerKey = providerEventIdentity(event);
  if (state.seenIds.has(eventKey) || state.seenIds.has(providerKey)) return state;

  const events = [...state.events, event].sort(eventCompare).slice(-MAX_ACTIVITY_EVENTS);
  const kind = activityType(event);
  // `{type:'error', status:'unknown'}` is the producer's envelope for a provider
  // event it does not recognise; it stays in the unrecognised bucket even though
  // the frontend now classifies bare `error` events as failures.
  const unknown = kind === 'unknown' || event.metadata?.unknownEvent === true
    ? [...state.unknownEvents, event].sort(eventCompare).slice(-MAX_UNKNOWN_ACTIVITY_EVENTS)
    : state.unknownEvents;
  const providerTime = Date.parse(event.timestamp);
  const eventNow = action.eventNow ?? (Number.isNaN(providerTime) ? now : providerTime);
  const outcome = toolOutcome(state, event, eventNow);
  const { activeSessions, activeAgents, agentNodes, activeTools, completedTools } = updateActors(state, event, eventNow, outcome);
  const sessions = updateSessions(state, event, eventNow, outcome);
  // Multi-resource events (T2-B) resolve to several targets — a compound
  // `curl a.example && curl b.example` fans out to two domain groups. Callers
  // that only ever set `event.target` (every existing caller and test) still
  // work: a single target degrades to a one-element list.
  const targets: ActivityTarget[] = event.targets && event.targets.length > 0
    ? event.targets
    : event.target
      ? [event.target]
      : [];
  const agentNodeId = activityAgentIdentity(event);
  const directFileTarget = directFileToolEvent(event, agentNodeId);
  const agentTargetLink = agentNodeId ? agentLinkTarget(event, state) : undefined;
  const agentTarget = agentTargetLink?.target;
  // Approvals and session errors are panel/glyph state, not spatial activity:
  // a permission request has not touched the file it asks about.
  const suppressVisuals = kind === 'permission' || kind === 'error';
  const displayKind = suppressVisuals
    ? kind
    : directFileTarget
      ? directFileActivityKind(event, kind)
      : agentTarget
        ? directAgentActivityKind(event, kind)
        : kind;
  const failedTool = toolLifecycle(event) === 'failed';
  const pulseKind: ActivityPulse['kind'] = failedTool ? 'failed'
    : displayKind === 'permission' || displayKind === 'error' ? 'unknown'
      : displayKind;
  const pulseColor = ACTIVITY_PULSE_COLORS[pulseKind];
  const pulseTtl = failedTool ? ACTIVITY_FAILED_PULSE_TTL_MS : ACTIVITY_TARGET_TTL_MS;
  const visible = !suppressVisuals && displayKind !== 'unknown' && displayKind !== 'session';
  const pulses: ActivityPulse[] = [...state.pulses.filter(pulse => pulse.expiresAt > now)];
  const rays: ActivityRay[] = [...state.rays.filter(ray => ray.expiresAt > now)];
  const snippetMarkers: ActivitySnippetMarker[] = [...state.snippetMarkers.filter(marker => marker.expiresAt > now)];
  if (visible) {
    for (const target of targets) {
      pulses.push({
        id: `${eventKey}:${target.id}`,
        eventId: event.id,
        sessionId: event.sessionId,
        target,
        kind: pulseKind,
        color: pulseColor,
        startedAt: now,
        expiresAt: now + pulseTtl,
      });
      while (pulses.length > MAX_ACTIVITY_PULSES) pulses.shift();
    }
  }
  const groupId = suppressVisuals ? undefined : activityGroupId(event);
  if (groupId) {
    pulses.push({
      id: `${eventKey}:${groupId}`,
      eventId: event.id,
      sessionId: event.sessionId,
      target: { kind: 'group', id: groupId, match: 'group' },
      kind: pulseKind,
      color: pulseColor,
      startedAt: now,
      expiresAt: now + pulseTtl,
    });
    while (pulses.length > MAX_ACTIVITY_PULSES) pulses.shift();
    if (!directFileTarget && !agentTarget) {
      for (const target of targets) {
        const rayId = `${eventKey}:${groupId}:${target.sourceId ?? 'local'}:${target.id}`;
        const ray = {
          id: rayId,
          eventId: event.id,
          sessionId: event.sessionId,
          ...(target.sourceId ? { sourceId: target.sourceId } : {}),
          ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
          sourceGroupId: groupId,
          target,
          color: pulseColor,
          startedAt: now,
          expiresAt: now + ACTIVITY_RAY_TTL_MS,
        } satisfies ActivityRay;
        const withoutDuplicate = rays.filter(existing => existing.id !== ray.id);
        rays.splice(0, rays.length, ...withoutDuplicate, ray);
        while (rays.length > MAX_ACTIVITY_RAYS) rays.shift();
      }
    }
    const markerText = activitySnippet(event) ?? activitySummary(event);
    const markerId = `${eventKey}:${groupId}:snippet`;
    const marker: ActivitySnippetMarker = {
      id: markerId,
      eventId: event.id,
      sessionId: event.sessionId,
      groupId,
      text: markerText.slice(0, 120),
      ...(targets[0]?.sourceId ? { sourceId: targets[0].sourceId } : {}),
      ...(event.workspace?.id ? { workspaceId: event.workspace.id } : {}),
      startedAt: now,
      expiresAt: now + ACTIVITY_SNIPPET_MARKER_TTL_MS,
    };
    snippetMarkers.push(marker);
    const retainedForGroup = new Set(snippetMarkers
      .filter(existing => existing.groupId === groupId)
      .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
      .slice(-MAX_ACTIVITY_SNIPPET_MARKERS_PER_GROUP)
      .map(existing => existing.id));
    snippetMarkers.splice(0, snippetMarkers.length, ...snippetMarkers.filter(existing => existing.groupId !== groupId || retainedForGroup.has(existing.id)));
    snippetMarkers.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
    while (snippetMarkers.length > MAX_ACTIVITY_SNIPPET_MARKERS) snippetMarkers.shift();
    // One agent→toolbox hop per event, not per target — the fan-out to each
    // target happens on the toolbox→target rays above. Borrows the first
    // target's graph identity, matching the single-target behaviour exactly
    // when there is only one.
    if (agentNodeId && targets.length > 0 && !directFileTarget && !agentTarget) {
      const sourceTarget = targets[0];
      const agentRay: ActivityRay = {
        id: `${eventKey}:${agentNodeId}:${groupId}:agent`,
        eventId: event.id,
        sessionId: event.sessionId,
        ...(sourceTarget.sourceId ? { sourceId: sourceTarget.sourceId } : {}),
        ...(event.workspace?.id ? { workspaceId: event.workspace.id } : {}),
        sourceAgentNodeId: agentNodeId,
        sourceGroupId: groupId,
        target: {
          kind: 'group',
          id: groupId,
          match: 'group',
          ...(sourceTarget.sourceId ? { sourceId: sourceTarget.sourceId } : {}),
          ...(event.workspace?.id ? { workspaceId: event.workspace.id } : {}),
        },
        targetMarkerId: markerId,
        color: pulseColor,
        startedAt: now,
        expiresAt: now + ACTIVITY_PULSE_TTL_MS,
      };
      const withoutDuplicate = rays.filter(existing => existing.id !== agentRay.id);
      rays.splice(0, rays.length, ...withoutDuplicate, agentRay);
      while (rays.length > MAX_ACTIVITY_RAYS) rays.shift();
    }
  }
  if ((!groupId || directFileTarget) && visible && agentNodeId) {
    for (const target of targets) {
      const ray: ActivityRay = {
        id: `${eventKey}:${agentNodeId}:target:${target.id}`,
        eventId: event.id,
        sessionId: event.sessionId,
        ...(target.sourceId ? { sourceId: target.sourceId } : {}),
        ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
        sourceAgentNodeId: agentNodeId,
        target,
        color: pulseColor,
        startedAt: now,
        expiresAt: now + ACTIVITY_RAY_TTL_MS,
      };
      const withoutDuplicate = rays.filter(existing => existing.id !== ray.id);
      rays.splice(0, rays.length, ...withoutDuplicate, ray);
      while (rays.length > MAX_ACTIVITY_RAYS) rays.shift();
    }
  }
  if (agentNodeId && agentTarget && visible) {
    const ray: ActivityRay = {
      id: `${eventKey}:${agentNodeId}:agent-target:${agentTarget.id}`,
      eventId: event.id,
      sessionId: event.sessionId,
      ...(event.workspace?.id ? { workspaceId: event.workspace.id } : {}),
      sourceAgentNodeId: agentNodeId,
      target: agentTarget,
      ...(agentTargetLink ? { agentLink: agentTargetLink.link } : {}),
      color: pulseColor,
      startedAt: now,
      expiresAt: now + ACTIVITY_RAY_TTL_MS,
    };
    const withoutDuplicate = rays.filter(existing => existing.id !== ray.id);
    rays.splice(0, rays.length, ...withoutDuplicate, ray);
    while (rays.length > MAX_ACTIVITY_RAYS) rays.shift();
  }
  const seenIds = new Set(state.seenIds);
  seenIds.add(eventKey);
  seenIds.add(providerKey);
  return {
    ...state,
    events,
    unknownEvents: unknown,
    activeSessions,
    activeAgents,
    agentNodes,
    activeTools,
    sessions,
    completedTools,
    pulses,
    rays,
    snippetMarkers,
    seenIds: boundedSeenIds(seenIds, events),
    connection: {
      ...state.connection,
      lastEventId: event.sseId ?? state.connection.lastEventId,
      coverage: state.connection.coverage === 'unavailable' ? 'observed' : state.connection.coverage === 'partial' ? 'partial' : 'exact',
    },
    revision: state.revision + 1,
  };
}

export function activityRenderState(state: ActivityState, sessionFilter: ReadonlySet<string> | null = null): { pulses: ActivityPulse[]; rays: ActivityRay[]; snippetMarkers: ActivitySnippetMarker[]; activeNodeIds: Set<string>; activeGroupIds: Set<string> } {
  const visible = (sessionId: string) => sessionFilter === null || sessionFilter.has(sessionId);
  const pulses = state.pulses.filter(pulse => visible(pulse.sessionId));
  const rays = state.rays.filter(ray => visible(ray.sessionId));
  const snippetMarkers = state.snippetMarkers.filter(marker => visible(marker.sessionId));
  const activeNodeIds = new Set<string>();
  const activeGroupIds = new Set<string>();
  pulses.forEach(pulse => {
    if (pulse.target.kind === 'node') activeNodeIds.add(pulse.target.id);
    else activeGroupIds.add(pulse.target.id);
  });
  return { pulses, rays, snippetMarkers, activeNodeIds, activeGroupIds };
}
