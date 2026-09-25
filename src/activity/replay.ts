import { activityReducer, initialActivityState } from './reducer';
import type {
  ActivityCapturedAt,
  ActivityArchiveManifest,
  ActivityEvent,
  ActivityReplay,
  ActivityReplayEvent,
  ActivityReplayInput,
  ActivityReplayManifestInput,
  ActivityReplayPage,
  ActivityReplaySnapshot,
  ActivityReplayStatus,
  ActivityState,
} from './types';

interface IndexedReplayEvent {
  record: ActivityReplayEvent;
  pageIndex: number;
  itemIndex: number;
}

interface ScheduledReplayEvent extends ActivityReplayEvent {
  virtualTime: number;
}

type ReplayInput = ActivityReplayInput
  | readonly ActivityReplayEvent[]
  | readonly ActivityReplayPage[];

function isReplayInput(value: ReplayInput): value is ActivityReplayInput {
  return !Array.isArray(value);
}

function isReplayEvent(value: unknown): value is ActivityReplayEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ActivityReplayEvent>;
  return typeof candidate.recordingSequence === 'number'
    && Number.isFinite(candidate.recordingSequence)
    && typeof candidate.event === 'object'
    && candidate.event !== null;
}

function isReplayPage(value: unknown): value is ActivityReplayPage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ActivityReplayPage>;
  return Array.isArray(candidate.events);
}

function asInput(input: ReplayInput): ActivityReplayInput {
  if (isReplayInput(input)) return input;
  if (input.every(isReplayEvent)) return { events: input };
  if (input.every(isReplayPage)) return { pages: input };
  throw new TypeError('Activity replay input arrays must contain replay events or pages');
}

function isArchiveManifest(value: ActivityReplayManifestInput): value is ActivityArchiveManifest {
  return !Array.isArray(value);
}

function manifestIsPartial(manifest: ActivityReplayManifestInput | undefined): boolean {
  if (!manifest) return false;
  if (!isArchiveManifest(manifest)) return manifest.some(summary => summary.complete === false);
  return manifest.partial === true
    || manifest.complete === false
    || manifest.sessions.some(summary => summary.complete === false);
}

function pageIsPartial(page: ActivityReplayPage): boolean {
  return page.partial === true || page.complete === false || page.hasMore === true || page.nextCursor !== undefined;
}

function eventKey(record: ActivityReplayEvent): string {
  const event = record.event;
  return JSON.stringify([
    record.recordingSequence,
    record.capturedAt,
    event.sessionId,
    event.id,
    event.sseId,
  ]);
}

function collectEvents(input: ActivityReplayInput): {
  events: ActivityReplayEvent[];
  partial: boolean;
} {
  const indexed: IndexedReplayEvent[] = [];
  const directEvents = input.events ?? [];
  directEvents.forEach((record, itemIndex) => indexed.push({ record, pageIndex: 0, itemIndex }));

  const pages = input.pages ?? [];
  pages.forEach((page, pageIndex) => {
    page.events.forEach((record, itemIndex) => indexed.push({
      record,
      pageIndex: pageIndex + 1,
      itemIndex,
    }));
  });

  indexed.sort((left, right) => left.record.recordingSequence - right.record.recordingSequence
    || left.pageIndex - right.pageIndex
    || left.itemIndex - right.itemIndex);

  const seen = new Set<string>();
  const events = indexed.flatMap(({ record }) => {
    if (seen.has(eventKey(record))) return [];
    seen.add(eventKey(record));
    return [{ ...record }];
  });

  return {
    events,
    partial: manifestIsPartial(input.manifest) || pages.some(pageIsPartial),
  };
}

function captureMillis(value: ActivityCapturedAt): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const numeric = Number(value);
  if (value.trim() !== '' && Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function scheduleEvents(events: readonly ActivityReplayEvent[]): ScheduledReplayEvent[] {
  const firstCapture = events
    .map(event => captureMillis(event.capturedAt))
    .find((value): value is number => value !== undefined);
  let previousVirtualTime = 0;
  return events.map(record => {
    const captured = captureMillis(record.capturedAt);
    const relative = captured !== undefined && firstCapture !== undefined
      ? Math.max(0, captured - firstCapture)
      : previousVirtualTime;
    const virtualTime = Math.max(previousVirtualTime, relative);
    previousVirtualTime = virtualTime;
    return { ...record, virtualTime };
  });
}

function cloneState(state: ActivityState): ActivityState {
  return {
    ...state,
    events: [...state.events],
    unknownEvents: [...state.unknownEvents],
    activeSessions: new Map(state.activeSessions),
    activeAgents: new Map(state.activeAgents),
    agentNodes: new Map(state.agentNodes),
    activeTools: new Map(state.activeTools),
    sessions: new Map(state.sessions),
    completedTools: [...state.completedTools],
    pulses: [...state.pulses],
    rays: [...state.rays],
    snippetMarkers: [...state.snippetMarkers],
    seenIds: new Set(state.seenIds),
    connection: {
      ...state.connection,
      ...(state.connection.replayGap ? { replayGap: { ...state.connection.replayGap } } : {}),
    },
  };
}

function validateSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new RangeError('Activity replay speed must be a finite number greater than zero');
  }
  return speed;
}

function validateDelta(deltaMs: number): number {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    throw new RangeError('Activity replay time delta must be a finite non-negative number');
  }
  return deltaMs;
}

function validateStepCount(count: number): number {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError('Activity replay step count must be a non-negative integer');
  }
  return count;
}

function replayEventForReducer(record: ActivityReplayEvent): ActivityEvent {
  // Keep the provider envelope, including its timestamp and live stream
  // sequence, untouched for display/correlation. The archive sequence is an
  // additional local key used only to keep reducer history in replay order.
  return record.event.recordingSequence === record.recordingSequence
    ? record.event
    : { ...record.event, recordingSequence: record.recordingSequence };
}

function publicReplayEvent(record: ScheduledReplayEvent): ActivityReplayEvent {
  return {
    recordingSequence: record.recordingSequence,
    capturedAt: record.capturedAt,
    event: record.event,
  };
}

export function createActivityReplay(input: ReplayInput): ActivityReplay {
  const normalized = asInput(input);
  const collected = collectEvents(normalized);
  const scheduled = scheduleEvents(collected.events);
  const manifest = normalized.manifest;
  const listeners = new Set<() => void>();
  const initial = cloneState(normalized.initialState ?? initialActivityState());
  let state = initial;
  let status: ActivityReplayStatus = 'idle';
  let speed = validateSpeed(normalized.speed ?? 1);
  let virtualTime = 0;
  let cursor = 0;
  let current: ActivityReplayEvent | undefined;

  const notify = () => {
    listeners.forEach(listener => listener());
  };

  const snapshot = (): ActivityReplaySnapshot => ({
    activity: state,
    status,
    speed,
    virtualTime,
    cursor,
    eventCount: scheduled.length,
    partial: collected.partial,
    ...(current ? { current } : {}),
  });

  const expire = (now: number) => {
    state = activityReducer(state, { type: 'expire', now });
  };

  const consumeNext = (): boolean => {
    const record = scheduled[cursor];
    if (!record) return false;
    const eventNow = record.virtualTime;
    virtualTime = Math.max(virtualTime, eventNow);
    state = activityReducer(state, {
      type: 'event',
      event: replayEventForReducer(record),
      now: eventNow,
      eventNow,
    });
    cursor += 1;
    current = publicReplayEvent(record);
    return true;
  };

  const consumeDue = (): number => {
    let consumed = 0;
    while (cursor < scheduled.length && scheduled[cursor].virtualTime <= virtualTime) {
      if (!consumeNext()) break;
      consumed += 1;
    }
    expire(virtualTime);
    return consumed;
  };

  const resetInternal = () => {
    state = cloneState(initial);
    status = 'idle';
    virtualTime = 0;
    cursor = 0;
    current = undefined;
  };

  const replay: ActivityReplay = {
    getSnapshot: snapshot,
    getState: () => state,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    play: () => {
      if (cursor >= scheduled.length) {
        status = 'completed';
        notify();
        return;
      }
      status = 'playing';
      notify();
    },
    pause: () => {
      if (status === 'playing') {
        status = 'paused';
        notify();
      }
    },
    reset: () => {
      resetInternal();
      notify();
    },
    step: (requestedCount = 1) => {
      const count = validateStepCount(requestedCount);
      if (count === 0) return 0;
      let consumed = 0;
      status = 'paused';
      while (consumed < count && consumeNext()) consumed += 1;
      expire(virtualTime);
      if (cursor >= scheduled.length && scheduled.length > 0) status = 'completed';
      notify();
      return consumed;
    },
    setSpeed: requestedSpeed => {
      const nextSpeed = validateSpeed(requestedSpeed);
      if (nextSpeed === speed) return;
      speed = nextSpeed;
      notify();
    },
    stop: () => {
      resetInternal();
      status = 'stopped';
      notify();
    },
    getEvents: () => collected.events.map(record => ({ ...record })),
    getManifest: () => manifest,
    advance: delta => {
      const deltaMs = validateDelta(delta);
      if (status !== 'playing') return 0;
      virtualTime += deltaMs * speed;
      const consumed = consumeDue();
      if (cursor >= scheduled.length && scheduled.length > 0) status = 'completed';
      notify();
      return consumed;
    },
    tick: delta => replay.advance(delta),
  };

  return replay;
}

/** Alias kept for callers that name the returned object a controller. */
export const createActivityReplayController = createActivityReplay;

/** Normalize archive pages into their deterministic recording order. */
export function activityReplayEvents(input: ReplayInput): readonly ActivityReplayEvent[] {
  return collectEvents(asInput(input)).events;
}
