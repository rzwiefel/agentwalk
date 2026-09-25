import { parseActivityEvent } from './contract';
import type {
  ActivityArchiveManifest,
  ActivityArchiveManifestSummary,
  ActivityEvent,
  ActivityReplayEvent,
  ActivityReplayPage,
  ActivityWorkspace,
} from './types';

export interface ActivityStream {
  close: () => void;
}

export interface ActivityRecordingSummary {
  recordingId: string;
  workspaceId?: string;
  sessionId?: string;
  sessionName?: string;
  agentName?: string;
  workspace?: ActivityWorkspace;
  startedAt?: string;
  endedAt?: string;
  eventCount?: number;
  complete?: boolean;
  partial?: boolean;
  [key: string]: unknown;
}

export interface ActivityRecordingsPage {
  recordings: readonly ActivityRecordingSummary[];
  nextCursor?: string;
}

export type ActivityRecordingManifest = ActivityArchiveManifest & {
  recordingId: string;
};

export interface ActivityRecordingsOptions {
  workspaceId?: string;
  sessionId?: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface ActivityRecordingEventsOptions {
  after?: string;
  limit?: number;
  signal?: AbortSignal;
}

export class ActivityApiError extends Error {
  readonly status?: number;
  readonly path: string;

  constructor(message: string, path: string, status?: number) {
    super(message);
    this.name = 'ActivityApiError';
    this.path = path;
    this.status = status;
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ActivityApiError(`Invalid activity response at ${path}.`, path);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ActivityApiError(`Expected a non-empty string at ${path}.`, path);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, path);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ActivityApiError(`Expected a boolean at ${path}.`, path);
  return value;
}

function optionalCount(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ActivityApiError(`Expected a non-negative integer at ${path}.`, path);
  }
  return value;
}

function optionalWorkspace(value: unknown, path: string): ActivityWorkspace | undefined {
  if (value === undefined || value === null) return undefined;
  const input = record(value, path);
  const result: ActivityWorkspace = {};
  for (const key of ['id', 'workspaceId', 'root', 'path', 'file', 'repository', 'branch'] as const) {
    const field = optionalString(input[key], `${path}.${key}`);
    if (field !== undefined) result[key] = field;
  }
  return result;
}

function validateSessionSummary(value: unknown, path: string): ActivityArchiveManifestSummary {
  const input = record(value, path);
  const sessionId = requiredString(input.sessionId, `${path}.sessionId`);
  const result: ActivityArchiveManifestSummary = {
    sessionId,
    ...(optionalString(input.sessionName, `${path}.sessionName`) ? { sessionName: input.sessionName as string } : {}),
    ...(optionalString(input.agentName, `${path}.agentName`) ? { agentName: input.agentName as string } : {}),
    ...(optionalWorkspace(input.workspace, `${path}.workspace`) ? { workspace: input.workspace as ActivityWorkspace } : {}),
    ...(optionalString(input.startedAt, `${path}.startedAt`) ? { startedAt: input.startedAt as string } : {}),
    ...(optionalString(input.endedAt, `${path}.endedAt`) ? { endedAt: input.endedAt as string } : {}),
    ...(optionalCount(input.eventCount, `${path}.eventCount`) !== undefined ? { eventCount: input.eventCount as number } : {}),
    ...(optionalBoolean(input.complete, `${path}.complete`) !== undefined ? { complete: input.complete as boolean } : {}),
  };
  return result;
}

function validateRecordingSummary(value: unknown, index: number): ActivityRecordingSummary {
  const path = `recordings[${index}]`;
  const input = record(value, path);
  const recordingId = requiredString(input.recordingId, `${path}.recordingId`);
  const workspaceId = optionalString(input.workspaceId, `${path}.workspaceId`);
  const sessionId = optionalString(input.sessionId, `${path}.sessionId`);
  const sessionName = optionalString(input.sessionName, `${path}.sessionName`);
  const agentName = optionalString(input.agentName, `${path}.agentName`);
  const workspace = optionalWorkspace(input.workspace, `${path}.workspace`);
  const startedAt = optionalString(input.startedAt, `${path}.startedAt`);
  const endedAt = optionalString(input.endedAt, `${path}.endedAt`);
  const eventCount = optionalCount(input.eventCount, `${path}.eventCount`);
  const complete = optionalBoolean(input.complete, `${path}.complete`);
  const partial = optionalBoolean(input.partial, `${path}.partial`);
  return {
    recordingId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(sessionName === undefined ? {} : { sessionName }),
    ...(agentName === undefined ? {} : { agentName }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(eventCount === undefined ? {} : { eventCount }),
    ...(complete === undefined ? {} : { complete }),
    ...(partial === undefined ? {} : { partial }),
  };
}

function captureValue(value: unknown, path: string): string | number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) || !Number.isNaN(Date.parse(value))) return value;
  }
  throw new ActivityApiError(`Expected a timestamp at ${path}.`, path);
}

function validateReplayEvent(value: unknown, index: number): ActivityReplayEvent {
  const path = `events[${index}]`;
  const input = record(value, path);
  const sequence = input.recordingSequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new ActivityApiError(`Expected a non-negative recording sequence at ${path}.`, path);
  }
  const capturedAt = captureValue(input.capturedAt, `${path}.capturedAt`);
  const eventInput = record(input.event, `${path}.event`);
  const event = parseActivityEvent(eventInput);
  if (!event) throw new ActivityApiError(`Invalid metadata-only activity event at ${path}.event.`, path);
  return { recordingSequence: sequence, capturedAt, event };
}

function validateRecordingsPage(value: unknown): ActivityRecordingsPage {
  const input = record(value, 'recordings');
  if (!Array.isArray(input.recordings)) throw new ActivityApiError('Expected recordings to be an array.', 'recordings');
  const nextCursor = optionalString(input.nextCursor, 'nextCursor');
  return {
    recordings: input.recordings.map(validateRecordingSummary),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function validateManifest(value: unknown, recordingId: string): ActivityRecordingManifest {
  const envelope = record(value, 'manifest');
  const input = record(envelope.manifest ?? envelope.recording ?? envelope, 'manifest');
  if (!Array.isArray(input.sessions)) throw new ActivityApiError('Expected manifest.sessions to be an array.', 'manifest.sessions');
  const eventCount = optionalCount(input.eventCount, 'manifest.eventCount');
  const partial = optionalBoolean(input.partial, 'manifest.partial');
  const complete = optionalBoolean(input.complete, 'manifest.complete');
  const responseRecordingId = optionalString(input.recordingId, 'manifest.recordingId');
  if (responseRecordingId !== undefined && responseRecordingId !== recordingId) {
    throw new ActivityApiError('Manifest recordingId does not match the requested recording.', 'manifest.recordingId');
  }
  return {
    recordingId,
    sessions: input.sessions.map((summary, index) => validateSessionSummary(summary, `manifest.sessions[${index}]`)),
    ...(eventCount === undefined ? {} : { eventCount }),
    ...(partial === undefined ? {} : { partial }),
    ...(complete === undefined ? {} : { complete }),
  };
}

function validateEventsPage(value: unknown): ActivityReplayPage {
  const input = record(value, 'events');
  if (!Array.isArray(input.events)) throw new ActivityApiError('Expected events to be an array.', 'events');
  const nextCursor = optionalString(input.nextCursor, 'nextCursor');
  const complete = optionalBoolean(input.complete, 'complete');
  const partial = optionalBoolean(input.partial, 'partial');
  return {
    events: input.events.map(validateReplayEvent),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(complete === undefined ? {} : { complete }),
    ...(partial === undefined ? {} : { partial }),
  };
}

async function readJson(response: Response, path: string): Promise<unknown> {
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (reason) {
    if (!response.ok) throw new ActivityApiError(`Activity request failed (${response.status}).`, path, response.status);
    throw reason;
  }
  if (!response.ok) {
    const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const message = typeof input.error === 'string' ? input.error : `Activity request failed (${response.status}).`;
    throw new ActivityApiError(message, path, response.status);
  }
  return value;
}

function boundedLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError('Activity API limits must be integers between 1 and 1000.');
  }
  return limit;
}

function recordingIdPath(recordingId: string): string {
  return requiredString(recordingId, 'recordingId');
}

export function activityRecordingsUrl(options: Omit<ActivityRecordingsOptions, 'signal'> = {}): string {
  const query = new URLSearchParams();
  if (options.workspaceId) query.set('workspaceId', options.workspaceId);
  if (options.sessionId) query.set('sessionId', options.sessionId);
  const limit = boundedLimit(options.limit);
  if (limit !== undefined) query.set('limit', String(limit));
  if (options.cursor) query.set('cursor', options.cursor);
  const queryString = query.toString();
  return `/api/activity/recordings${queryString ? `?${queryString}` : ''}`;
}

export function activityRecordingUrl(recordingId: string): string {
  return `/api/activity/recordings/${encodeURIComponent(recordingIdPath(recordingId))}`;
}

export function activityRecordingEventsUrl(recordingId: string, options: Omit<ActivityRecordingEventsOptions, 'signal'> = {}): string {
  const query = new URLSearchParams();
  if (options.after) query.set('after', options.after);
  const limit = boundedLimit(options.limit);
  if (limit !== undefined) query.set('limit', String(limit));
  const queryString = query.toString();
  return `${activityRecordingUrl(recordingId)}/events${queryString ? `?${queryString}` : ''}`;
}

export async function listActivityRecordings(options: ActivityRecordingsOptions = {}): Promise<ActivityRecordingsPage> {
  const path = activityRecordingsUrl(options);
  const value = await readJson(await fetch(path, { signal: options.signal }), path);
  return validateRecordingsPage(value);
}

export async function getActivityRecording(recordingId: string, options: { signal?: AbortSignal } = {}): Promise<ActivityRecordingManifest> {
  const path = activityRecordingUrl(recordingId);
  const value = await readJson(await fetch(path, { signal: options.signal }), path);
  return validateManifest(value, recordingIdPath(recordingId));
}

export async function getActivityRecordingEvents(recordingId: string, options: ActivityRecordingEventsOptions = {}): Promise<ActivityReplayPage> {
  const path = activityRecordingEventsUrl(recordingId, options);
  const value = await readJson(await fetch(path, { signal: options.signal }), path);
  return validateEventsPage(value);
}

// Keep the naming parallel with the existing repository/revision clients.
export const loadActivityRecordings = listActivityRecordings;
export const loadActivityRecording = getActivityRecording;
export const loadActivityRecordingEvents = getActivityRecordingEvents;

export interface ActivityStreamOptions {
  url?: string;
  workspaceId?: string;
  allWorkspaces?: boolean;
  lastEventId?: string;
  onEvent: (event: ActivityEvent) => void;
  onGap?: (gap: { from?: string; to?: string; requestedId?: string; oldestId?: string; reason?: string }) => void;
  onState?: (state: { status: 'connecting' | 'connected' | 'reconnecting' | 'error'; attempt: number; error?: string; lastEventId?: string }) => void;
  eventSourceFactory?: (url: string) => EventSource;
  maxReconnectDelayMs?: number;
}

export function activityStreamUrl(lastEventId?: string, base = '/api/activity/stream', workspaceId?: string): string {
  // EventSource sends Last-Event-ID automatically when reconnecting. A query
  // cursor would be a second, non-standard replay protocol.
  void lastEventId;
  if (!workspaceId) return base;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}workspaceId=${encodeURIComponent(workspaceId)}`;
}

export function allWorkspacesActivityStreamUrl(base = '/api/activity/stream'): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}allWorkspaces=true`;
}

/**
 * A small EventSource wrapper. Native EventSource owns reconnect and forwards
 * the last received SSE id as Last-Event-ID; the browser/collector remain the
 * source of truth for replay and deduplication.
 */
export function connectActivityStream(options: ActivityStreamOptions): ActivityStream {
  const create = options.eventSourceFactory ?? ((url: string) => new EventSource(url));
  let source: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let lastEventId = options.lastEventId;
  const notify = (status: 'connecting' | 'connected' | 'reconnecting' | 'error', error?: string) => options.onState?.({ status, attempt, ...(error ? { error } : {}), ...(lastEventId ? { lastEventId } : {}) });
  const handleMessage = (message: MessageEvent<string>) => {
    if (message.lastEventId) lastEventId = message.lastEventId;
    const event = parseActivityEvent(message.data, message.lastEventId || undefined);
    if (event) options.onEvent(event);
  };
  const handleGap = (message: MessageEvent<string>) => {
    const event = parseActivityEvent(message.data, message.lastEventId || undefined);
    if (event) {
      let payload: { requestedId?: string; oldestId?: string; from?: string; to?: string } = {};
      try {
        const input = JSON.parse(message.data) as Record<string, unknown>;
        payload = {
          requestedId: typeof input.requestedId === 'string' ? input.requestedId : typeof input.requested === 'string' ? input.requested : undefined,
          oldestId: typeof input.oldestId === 'string' ? input.oldestId : typeof input.oldest === 'string' ? input.oldest : undefined,
          from: typeof input.from === 'string' ? input.from : undefined,
          to: typeof input.to === 'string' ? input.to : undefined,
        };
      } catch {
        // The parsed envelope still carries a safe fallback reason below.
      }
      options.onGap?.({
        from: payload.from ?? (typeof event.metadata?.from === 'string' ? event.metadata.from : undefined),
        to: payload.to ?? (typeof event.metadata?.to === 'string' ? event.metadata.to : undefined),
        reason: typeof event.metadata?.reason === 'string' ? event.metadata.reason : 'Collector replay gap',
        requestedId: payload.requestedId ?? (typeof event.metadata?.requestedId === 'string' ? event.metadata.requestedId : undefined),
        oldestId: payload.oldestId ?? (typeof event.metadata?.oldestId === 'string' ? event.metadata.oldestId : undefined),
      });
      return;
    }
    try {
      const input = JSON.parse(message.data) as {
        from?: string; to?: string; requested?: string; oldest?: string;
        requestedId?: string; oldestId?: string; reason?: string;
      };
      options.onGap?.({
        from: input.from,
        to: input.to,
        requestedId: input.requestedId ?? input.requested,
        oldestId: input.oldestId ?? input.oldest,
        reason: input.reason ?? 'Collector replay gap',
      });
    } catch {
      options.onGap?.({ reason: 'Collector replay gap' });
    }
  };
  const open = () => {
    if (closed) return;
    notify('connecting');
    source = create(options.allWorkspaces
      ? allWorkspacesActivityStreamUrl(options.url ?? '/api/activity/stream')
      : activityStreamUrl(undefined, options.url, options.workspaceId));
    source.onopen = () => {
      attempt = 0;
      notify('connected');
    };
    source.onmessage = handleMessage;
    source.addEventListener?.('activity', handleMessage as EventListener);
    source.addEventListener?.('replay-gap', handleGap as EventListener);
    source.addEventListener?.('gap', handleGap as EventListener);
    source.onerror = () => {
      if (closed) return;
      const error = 'Activity stream disconnected';
      attempt += 1;
      notify('reconnecting', error);
    };
  };
  open();
  return {
    close: () => {
      closed = true;
      source?.close();
      source = null;
    },
  };
}
