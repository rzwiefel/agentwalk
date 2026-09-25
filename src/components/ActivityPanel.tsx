import { memo, useEffect, useRef, useState } from 'react';
import type { ActivityRecordingSummary } from '../activity/api';
import { activityEventLabel, activitySnippet, activitySummary, activityType } from '../activity/contract';
import type { ActivityReplayHookState } from '../activity/hooks';
import { activityEventIdentity, sessionStatus, turnDurationMs } from '../activity/reducer';
import type { ActivitySessionStatus, ActivityState, ActivityToolOutcome } from '../activity/types';
// Vite bundles the panel stylesheet from this import. It is dynamic and DOM-guarded
// because the repo's `node --test` loader transpiles .ts/.tsx only and cannot load a
// .css module — the ambient `*.css` module declaration now comes from src/vite-env.d.ts,
// so no @ts-ignore is needed here.
if (typeof document !== 'undefined') void import('./activity-panel.css');

export const ACTIVITY_PAGE_SIZE = 10;
export const ACTIVE_TELEMETRY_LIMIT = 10;
export const ACTIVITY_NOTIFICATIONS_STORAGE_KEY = 'codewalk.activityNotifications';

export interface ActivitySessionSummary {
  id: string;
  label: string;
  active: boolean;
  updatedAt: number;
  eventCount: number;
  status: ActivitySessionStatus;
  lastEventAt: number;
  waitingTool?: string;
  turnDurationMs?: number;
}

/**
 * A browser notification for a session that just became blocked or broken.
 * Deliberately carries only the session label and tool name — never prompt,
 * argument, output, or error text (roadmap §6).
 */
export interface ActivityNotification {
  key: string;
  sessionId: string;
  title: string;
  body: string;
}

function sessionVisible(sessionFilter: ReadonlySet<string> | null, sessionId: string): boolean {
  return sessionFilter === null || sessionFilter.has(sessionId);
}

export function formatActivityDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatActivityAgo(elapsedMs: number): string {
  if (elapsedMs < 0) return 'just now';
  if (elapsedMs < 60_000) return `${Math.floor(elapsedMs / 1000)} s ago`;
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)} m ago`;
  return `${Math.floor(elapsedMs / 3_600_000)} h ago`;
}

export function recentActivityEvents(events: ActivityState['events'], visibleCount: number, sessionFilter: ReadonlySet<string> | null = null): ActivityState['events'] {
  return [...events].filter(event => sessionVisible(sessionFilter, event.sessionId)).reverse().slice(0, Math.max(ACTIVITY_PAGE_SIZE, visibleCount));
}

export function recentActiveTelemetry(state: ActivityState, limit = ACTIVE_TELEMETRY_LIMIT, sessionFilter: ReadonlySet<string> | null = null) {
  const entries = [
    ...[...state.activeTools.values()].filter(tool => sessionVisible(sessionFilter, tool.sessionId)).map(tool => ({ kind: 'tool' as const, id: tool.id, sessionId: tool.sessionId, label: tool.summary ?? tool.tool, status: tool.status, updatedAt: tool.updatedAt })),
    ...[...state.activeAgents.values()].filter(agent => sessionVisible(sessionFilter, agent.sessionId)).map(agent => ({ kind: 'agent' as const, id: agent.id, sessionId: agent.sessionId, label: agent.id, status: agent.status, updatedAt: agent.updatedAt })),
  ];
  return entries
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
    .slice(0, Math.max(0, limit));
}

function connectionLabel(state: ActivityState): string {
  if (state.connection.status === 'disabled') return 'Telemetry disabled';
  if (state.connection.status === 'unavailable') return 'Collector unavailable';
  if (state.connection.status === 'gap') return 'Replay gap detected';
  if (state.connection.status === 'reconnecting') return `Reconnecting (${state.connection.reconnectAttempt})`;
  if (state.connection.status === 'error') return state.connection.lastError ?? 'Stream error';
  return state.connection.status === 'connected' ? 'Live · all workspaces' : 'Connecting…';
}

function safeIdentifier(value: string, fallback: string): string {
  return /^[a-zA-Z0-9._:-]{1,80}$/.test(value) ? value : fallback;
}

function safeActivityLabel(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized && normalized.length <= 120 && /^[\w .:/@+={}[\]\\-]+$/.test(normalized) ? normalized : fallback;
}

function compactSessionId(id: string): string {
  return safeIdentifier(id.slice(-10), 'session');
}

function recordingLabel(recording: ActivityRecordingSummary): string {
  return safeActivityLabel(
    recording.sessionName ?? recording.agentName ?? recording.sessionId ?? recording.recordingId,
    `Recording · ${compactSessionId(recording.recordingId)}`,
  );
}

function recordingDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function replayStatusLabel(snapshot: NonNullable<ActivityReplayHookState['snapshot']>): string {
  if (snapshot.status === 'playing') return 'playing';
  if (snapshot.status === 'paused') return 'paused';
  if (snapshot.status === 'completed') return 'complete';
  if (snapshot.status === 'stopped') return 'stopped';
  return 'ready';
}

/**
 * Session chips (T1-F). `status`, the waiting tool, and the turn timer are read
 * from the reducer's derived session state; everything else is unchanged.
 */
export function activitySessionSummaries(state: ActivityState, now: number = Date.now()): ActivitySessionSummary[] {
  const summaries = new Map<string, ActivitySessionSummary>();
  const signals = (sessionId: string, fallbackUpdatedAt: number) => {
    const session = state.sessions.get(sessionId);
    if (!session) return { status: 'idle' as ActivitySessionStatus, lastEventAt: fallbackUpdatedAt };
    const turn = turnDurationMs(session, now);
    const status = sessionStatus(session, now);
    return {
      status,
      lastEventAt: session.lastEventAt,
      ...(session.waiting?.tool ? { waitingTool: session.waiting.tool } : {}),
      ...(turn === undefined || session.turn?.endedAt !== undefined ? {} : { turnDurationMs: turn }),
    };
  };
  state.events.forEach(event => {
    const existing = summaries.get(event.sessionId);
    const eventTime = Date.parse(event.timestamp);
    const updatedAt = Number.isNaN(eventTime) ? 0 : eventTime;
    summaries.set(event.sessionId, {
      id: event.sessionId,
      label: safeActivityLabel(event.sessionName ?? existing?.label, `Session · ${compactSessionId(event.sessionId)}`),
      active: existing?.active ?? false,
      updatedAt: Math.max(existing?.updatedAt ?? 0, updatedAt),
      eventCount: (existing?.eventCount ?? 0) + 1,
      ...signals(event.sessionId, Math.max(existing?.updatedAt ?? 0, updatedAt)),
    });
  });
  state.activeSessions.forEach((event, sessionId) => {
    const existing = summaries.get(sessionId);
    const eventTime = Date.parse(event.timestamp);
    const updatedAt = Math.max(existing?.updatedAt ?? 0, Number.isNaN(eventTime) ? 0 : eventTime);
    summaries.set(sessionId, {
      id: sessionId,
      label: safeActivityLabel(event.sessionName ?? existing?.label, `Session · ${compactSessionId(sessionId)}`),
      active: true,
      updatedAt,
      eventCount: existing?.eventCount ?? 0,
      ...signals(sessionId, updatedAt),
    });
  });
  state.agentNodes.forEach(agent => {
    const existing = summaries.get(agent.sessionId);
    if (!existing) {
      summaries.set(agent.sessionId, {
        id: agent.sessionId,
        label: safeActivityLabel(agent.sessionName ?? agent.agentName ?? agent.label, `Session · ${compactSessionId(agent.sessionId)}`),
        active: false,
        updatedAt: agent.updatedAt,
        eventCount: 0,
        ...signals(agent.sessionId, agent.updatedAt),
      });
    }
  });
  const labels = new Map<string, number>();
  [...summaries.values()].forEach(summary => labels.set(summary.label, (labels.get(summary.label) ?? 0) + 1));
  return [...summaries.values()]
    .map(summary => labels.get(summary.label)! > 1 ? { ...summary, label: `${summary.label} · ${compactSessionId(summary.id)}` } : summary)
    .sort((left, right) => Number(right.active) - Number(left.active) || right.updatedAt - left.updatedAt || left.label.localeCompare(right.label));
}

/** Newest-first slice of the completed-tool ring (T1-E), paged like the events list. */
export function recentCompletedTools(state: ActivityState, visibleCount: number, sessionFilter: ReadonlySet<string> | null = null): ActivityToolOutcome[] {
  return [...state.completedTools]
    .filter(entry => sessionVisible(sessionFilter, entry.sessionId))
    .reverse()
    .slice(0, Math.max(ACTIVITY_PAGE_SIZE, visibleCount));
}

/**
 * Sessions that are blocked on approval or have just failed, one entry per
 * distinct tool call so a re-render never re-notifies (T1-B/T1-C).
 */
export function activityNotifications(state: ActivityState, now: number = Date.now()): ActivityNotification[] {
  const summaries = new Map(activitySessionSummaries(state, now).map(summary => [summary.id, summary]));
  const notifications: ActivityNotification[] = [];
  state.sessions.forEach(session => {
    const status = sessionStatus(session, now);
    const label = summaries.get(session.id)?.label ?? `Session · ${compactSessionId(session.id)}`;
    if (status === 'waiting' && session.waiting) {
      const tool = safeActivityLabel(session.waiting.tool, 'a tool');
      notifications.push({
        key: `waiting:${session.waiting.toolCallId}`,
        sessionId: session.id,
        title: `${label} · waiting for approval`,
        body: `Approval requested for ${tool}.`,
      });
      return;
    }
    if (status !== 'failed') return;
    const failure = [...state.completedTools].reverse()
      .find(entry => entry.sessionId === session.id && entry.outcome === 'failed');
    const key = failure ? `failed:${failure.toolCallId}` : `error:${session.id}:${session.lastErrorAt ?? 0}`;
    const tool = safeActivityLabel(failure?.tool, 'a tool');
    notifications.push({
      key,
      sessionId: session.id,
      title: `${label} · failed`,
      body: failure ? `${tool} failed.` : 'The session reported an error.',
    });
  });
  return notifications;
}

function readNotificationPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(ACTIVITY_NOTIFICATIONS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeNotificationPreference(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(ACTIVITY_NOTIFICATIONS_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the
    // preference simply does not survive the reload.
  }
}

export const ActivityPanel = memo(function ActivityPanel({ state, liveState = state, sessionFilter, onSessionFilterChange, replay }: {
  state: ActivityState;
  liveState?: ActivityState;
  sessionFilter: ReadonlySet<string> | null;
  onSessionFilterChange: (filter: Set<string> | null) => void;
  replay?: ActivityReplayHookState;
}) {
  const [visibleCount, setVisibleCount] = useState(ACTIVITY_PAGE_SIZE);
  const [visibleToolCount, setVisibleToolCount] = useState(ACTIVITY_PAGE_SIZE);
  const [notify, setNotify] = useState(readNotificationPreference);
  // Elapsed times ("last event 12 s ago", "running 4m12s") move without new events.
  const [wallNow, setWallNow] = useState(() => Date.now());
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const timer = setInterval(() => setWallNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const replayOpen = Boolean(replay?.open && replay.snapshot);
  const now = replayOpen ? replay!.snapshot!.virtualTime : wallNow;
  const sessions = activitySessionSummaries(state, now);
  const visibleEvents = state.events.filter(event => sessionVisible(sessionFilter, event.sessionId));
  const visibleActiveSessions = [...state.activeSessions.values()].filter(event => sessionVisible(sessionFilter, event.sessionId));
  const visibleActiveAgents = [...state.activeAgents.values()].filter(agent => sessionVisible(sessionFilter, agent.sessionId));
  const visibleActiveTools = [...state.activeTools.values()].filter(tool => sessionVisible(sessionFilter, tool.sessionId));
  const recent = recentActivityEvents(state.events, visibleCount, sessionFilter);
  const recentTelemetry = recentActiveTelemetry(state, ACTIVE_TELEMETRY_LIMIT, sessionFilter);
  const visibleCompletedTools = state.completedTools.filter(entry => sessionVisible(sessionFilter, entry.sessionId));
  const recentTools = recentCompletedTools(state, visibleToolCount, sessionFilter);
  const visibleUnknownEvents = state.unknownEvents.filter(event => sessionVisible(sessionFilter, event.sessionId));
  useEffect(() => {
    if (state.events.length === 0) setVisibleCount(ACTIVITY_PAGE_SIZE);
  }, [state.events.length]);
  useEffect(() => {
    if (state.completedTools.length === 0) setVisibleToolCount(ACTIVITY_PAGE_SIZE);
  }, [state.completedTools.length]);
  useEffect(() => {
    if (!notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (replayOpen) return;
    activityNotifications(liveState, wallNow)
      .filter(notification => sessionVisible(sessionFilter, notification.sessionId))
      .forEach(notification => {
        if (notifiedRef.current.has(notification.key)) return;
        notifiedRef.current.add(notification.key);
        if (notifiedRef.current.size > 256) notifiedRef.current = new Set([...notifiedRef.current].slice(-128));
        try {
          new Notification(notification.title, { body: notification.body, tag: notification.key });
        } catch {
          // Notification construction can throw when the page is not permitted
          // to show one; the in-panel chip is the source of truth regardless.
        }
      });
  }, [liveState, notify, replayOpen, sessionFilter, wallNow]);
  const toggleNotify = () => {
    const next = !notify;
    setNotify(next);
    writeNotificationPreference(next);
    if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  };
  const toggleSession = (sessionId: string) => {
    const next = new Set(sessionFilter ?? []);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    onSessionFilterChange(next);
  };
  const selectedRecording = replay?.recordings.find(recording => recording.recordingId === replay.selectedRecordingId);
  const replaySnapshot = replay?.snapshot;
  return (
    <section className="activity-panel" aria-live="polite">
      <div className="activity-heading">
        <div><span className="eyebrow">{replayOpen ? 'Replay activity' : 'Live activity'}</span><h2>{replayOpen ? 'Recorded telemetry' : 'Agent telemetry'}</h2></div>
        <span className={`activity-status activity-status-${replayOpen ? `replay-${replayStatusLabel(replaySnapshot!)}` : liveState.connection.status}`}>
          {replayOpen ? `Replay · ${replayStatusLabel(replaySnapshot!)}` : connectionLabel(liveState)}
        </span>
      </div>
      <p className="activity-coverage">
        {replayOpen
          ? <>Replay source: <strong>recorded metadata</strong> · live stream remains connected in the background.</>
          : <>All workspaces · coverage: <strong>{liveState.connection.coverage}</strong> · reported file reads/writes, searches, and tool lifecycle only.</>}
      </p>
      {liveState.connection.replayGap && !replayOpen && (
        <div className="activity-gap" role="status">
          Some events may be missing. Activity is not evidence of inactivity.
        </div>
      )}
      {replay && (
        <section className="activity-recordings" aria-label="Activity recordings">
          <div className="activity-recordings-heading">
            <div><span className="eyebrow">Recordings</span><small>metadata only</small></div>
            <button type="button" className="activity-recordings-refresh" onClick={replay.refresh} disabled={replay.recordingsLoading}>
              {replay.recordingsLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          <label className="activity-recording-picker">
            <span>Select a recording</span>
            <select
              value={replay.selectedRecordingId ?? ''}
              onChange={event => replay.selectRecording(event.target.value || null)}
              disabled={replay.recordingsLoading && replay.recordings.length === 0}
            >
              <option value="">Live activity</option>
              {replay.recordings.map(recording => {
                const date = recordingDate(recording.startedAt);
                const count = recording.eventCount === undefined ? '' : ` · ${recording.eventCount} events`;
                return <option key={recording.recordingId} value={recording.recordingId}>{recordingLabel(recording)}{date ? ` · ${date}` : ''}{count}</option>;
              })}
            </select>
          </label>
          {replay.recordingsError && <p className="activity-replay-error">{replay.recordingsError}</p>}
          {replay.recordings.length === 0 && !replay.recordingsLoading && !replay.recordingsError && <p className="activity-muted">No archived metadata recordings are available.</p>}
          {selectedRecording && (
            <div className="activity-recording-summary">
              <strong>{recordingLabel(selectedRecording)}</strong>
              <small>
                {selectedRecording.eventCount === undefined ? 'event count unavailable' : `${selectedRecording.eventCount} events`}
                {recordingDate(selectedRecording.startedAt) ? ` · started ${recordingDate(selectedRecording.startedAt)}` : ''}
                {selectedRecording.complete === false || selectedRecording.partial === true ? ' · partial' : ''}
              </small>
            </div>
          )}
          {replay.loading && <p className="activity-muted">Loading recording pages…</p>}
          {replay.error && <p className="activity-replay-error">{replay.error}</p>}
          {replaySnapshot && replay.selectedRecordingId && (
            <div className="activity-replay-controls">
              <div className="activity-replay-progress">
                <span><strong>{replayStatusLabel(replaySnapshot)}</strong> · {replaySnapshot.cursor}/{replaySnapshot.eventCount} events</span>
                <span>{replaySnapshot.speed}×</span>
              </div>
              {replay.partial && <div className="activity-replay-warning" role="status">Partial recording: only the bounded archived pages are available.</div>}
              {replaySnapshot.current && <small className="activity-replay-current">Last event: {activityEventLabel(replaySnapshot.current.event)}</small>}
              <div className="activity-replay-buttons">
                <button type="button" onClick={replay.play} disabled={replaySnapshot.status === 'playing'}>Play</button>
                <button type="button" onClick={replay.pause} disabled={replaySnapshot.status !== 'playing'}>Pause</button>
                <button type="button" onClick={() => replay.step()} disabled={replaySnapshot.status === 'completed'}>Step</button>
                <button type="button" onClick={replay.reset}>Reset</button>
                <button type="button" onClick={replay.stop}>Stop · live</button>
                <button type="button" onClick={replay.close}>Close</button>
              </div>
              <label className="activity-replay-speed">
                <span>Speed</span>
                <select value={replaySnapshot.speed} onChange={event => replay.setSpeed(Number(event.target.value))}>
                  {[0.25, 0.5, 1, 2, 4, 8].map(speed => <option key={speed} value={speed}>{speed}×</option>)}
                </select>
              </label>
            </div>
          )}
        </section>
      )}
      <div className="activity-counts">
        <span><strong>{visibleActiveSessions.length}</strong> sessions</span>
        <span><strong>{visibleActiveAgents.length}</strong> agents</span>
        <span><strong>{visibleActiveTools.length}</strong> tools</span>
      </div>
      {sessions.length > 0 && (
        <div className="activity-sessions">
          <div className="activity-session-heading"><span className="eyebrow">Sessions</span><small>{sessionFilter === null ? 'all visible' : `${sessionFilter.size} selected`}</small></div>
          <label className="activity-session-row">
            <input type="checkbox" checked={sessionFilter === null} onChange={() => onSessionFilterChange(null)} />
            <strong>All sessions</strong>
            <small>{sessions.length}</small>
          </label>
          {sessions.map(session => (
            <label className="activity-session-row" key={session.id}>
              <input type="checkbox" checked={sessionFilter?.has(session.id) ?? false} onChange={() => toggleSession(session.id)} />
              <span className={`activity-dot activity-${session.active ? 'execute' : 'unknown'}`} />
              <strong>{session.label}</strong>
              <small>{session.eventCount}</small>
              <span className="activity-session-meta">
                <span className={`activity-chip activity-chip-${session.status}`}>{session.status}</span>
                {session.status === 'waiting' && session.waitingTool && <em>{safeActivityLabel(session.waitingTool, 'tool')}</em>}
                {session.status === 'active' && session.turnDurationMs !== undefined && <em>running {formatActivityDuration(session.turnDurationMs)}</em>}
                {session.lastEventAt > 0 && <span>last event {formatActivityAgo(now - session.lastEventAt)}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
      <label className="activity-notify">
        <input type="checkbox" checked={notify} onChange={toggleNotify} />
        <span>Notify me when a session waits or fails</span>
        <small>{typeof Notification === 'undefined' ? 'unsupported' : Notification.permission}</small>
      </label>
      {(visibleActiveTools.length > 0 || visibleActiveAgents.length > 0) && (
        <div className="activity-active-list">
          {recentTelemetry.map(entry => <div key={`${entry.kind}:${entry.id}`}><span className={`activity-dot activity-${entry.kind === 'tool' ? 'execute' : 'session'}`} /><strong>{entry.kind === 'agent' ? `Agent ${safeIdentifier(entry.id.slice(-12), 'active')}` : safeActivityLabel(entry.label, 'tool')}</strong><small>{safeIdentifier(entry.status, 'active')}</small></div>)}
        </div>
      )}
      <div className="activity-events">
        <span className="eyebrow">Recent reported events</span>
        {recent.length === 0 && <p className="activity-muted">Waiting for collector events.</p>}
        {recent.map(event => (
          <div className="activity-event" key={activityEventIdentity(event)}>
            <span className={`activity-dot activity-${activityType(event)}`} />
            <div><strong>{activityEventLabel(event)}</strong><small>{activitySummary(event)}</small>{activitySnippet(event) && <code className="activity-snippet">{activitySnippet(event)}</code>}</div>
            <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
          </div>
        ))}
        {visibleEvents.length > recent.length && (
          <button
            className="activity-load-more"
            type="button"
            onClick={() => setVisibleCount(count => Math.min(visibleEvents.length, count + ACTIVITY_PAGE_SIZE))}
          >
            Load 10 more
          </button>
        )}
      </div>
      {visibleCompletedTools.length > 0 && (
        <div className="activity-tools">
          <span className="eyebrow">Completed tools</span>
          {recentTools.map(entry => (
            <div className={`activity-tool${entry.outcome === 'failed' ? ' activity-tool-failed' : ''}`} key={entry.id}>
              <span className={`activity-dot activity-${entry.outcome === 'failed' ? 'error' : 'execute'}`} />
              <div>
                <strong>{safeActivityLabel(entry.tool, 'tool')}</strong>
                <small>{safeActivityLabel(entry.target?.id ?? entry.summary, '—')}</small>
              </div>
              <span className="activity-tool-duration">{entry.durationMs === undefined ? '—' : formatActivityDuration(entry.durationMs)}</span>
              <span className="activity-tool-outcome">
                {entry.outcome === 'failed'
                  ? safeActivityLabel(entry.errorCode ?? entry.errorClassification, 'failed')
                  : entry.exitCode === undefined ? 'ok' : `exit ${entry.exitCode}`}
              </span>
            </div>
          ))}
          {visibleCompletedTools.length > recentTools.length && (
            <button
              className="activity-load-more"
              type="button"
              onClick={() => setVisibleToolCount(count => Math.min(visibleCompletedTools.length, count + ACTIVITY_PAGE_SIZE))}
            >
              Load 10 more
            </button>
          )}
        </div>
      )}
      {visibleUnknownEvents.length > 0 && (
        <details className="activity-unknown">
          <summary>{visibleUnknownEvents.length} unrecognized event{visibleUnknownEvents.length === 1 ? '' : 's'} retained</summary>
          <p>Provider event types are retained without rendering raw payloads.</p>
        </details>
      )}
    </section>
  );
});
