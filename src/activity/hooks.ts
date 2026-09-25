import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useState } from 'react';
import {
  getActivityRecording,
  getActivityRecordingEvents,
  listActivityRecordings,
  type ActivityRecordingManifest,
  type ActivityRecordingSummary,
} from './api';
import { connectActivityStream } from './api';
import { parseActivityEvent } from './contract';
import { activityReducer, initialActivityState } from './reducer';
import { resolveActivityTargets } from './graphResolver';
import { createActivityReplayController } from './replay';
import type {
  ActivityAction,
  ActivityEvent,
  ActivityGraphIndexes,
  ActivityReplay,
  ActivityReplayPage,
  ActivityReplaySnapshot,
  ActivityState,
  ActivityStore,
} from './types';

// Bound on how many parsed events accumulate while the stream is paused (T1-A).
// The stream connection itself stays open; only dispatch into the store is
// gated, so a very long pause degrades by dropping the oldest buffered events
// rather than growing without limit or losing the SSE connection.
const MAX_PAUSED_ACTIVITY_BUFFER = 500;

export function createActivityStore(): ActivityStore {
  let state = initialActivityState();
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action: ActivityAction) => {
      const next = activityReducer(state, action);
      if (next === state) return;
      state = next;
      listeners.forEach(listener => listener());
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => {
      state = initialActivityState();
      listeners.forEach(listener => listener());
    },
  };
}

export interface UseActivityStreamOptions {
  enabled: boolean;
  /** Optional scope for a single-workspace stream. Omit to receive all workspaces. */
  workspaceId?: string;
  /**
   * While true, parsed events keep arriving over the open connection but are
   * buffered instead of dispatched, so the canvas and panel stop changing;
   * flips back to false replays the buffer in order. Connection-status and
   * gap notifications are never buffered, so the reported connection state
   * stays honest while paused. Defaults to false.
   */
  paused?: boolean;
  indexes?: ActivityGraphIndexes;
}

export type ActivityStreamState = ActivityState & { clear: () => void };

export function activityEventMatchesWorkspace(event: ReturnType<typeof parseActivityEvent>, workspaceId: string | undefined): boolean {
  return !workspaceId || Boolean(event?.workspace
    && (event.workspace.id ?? event.workspace.workspaceId) === workspaceId);
}

export function useActivityStream({ enabled, paused = false, workspaceId, indexes }: UseActivityStreamOptions): ActivityStreamState {
  const storeRef = useRef<ActivityStore | null>(null);
  if (!storeRef.current) storeRef.current = createActivityStore();
  const store = storeRef.current;
  const indexesRef = useRef(indexes);
  indexesRef.current = indexes;
  const pausedRef = useRef(paused);
  const bufferedEventsRef = useRef<ActivityEvent[]>([]);
  const getSnapshot = useCallback(() => store.getState(), [store]);
  const state = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  const clear = useCallback(() => {
    bufferedEventsRef.current = [];
    store.reset();
  }, [store]);

  const dispatchParsedEvent = useCallback((event: ActivityEvent) => {
    // T2-B: an event's resources can fan out to several targets (a compound
    // shell command hitting more than one host, say); `target` stays the
    // first for callers that only look at one.
    const targets = indexesRef.current ? resolveActivityTargets(event, indexesRef.current) : [];
    store.dispatch({ type: 'event', event: targets.length > 0 ? { ...event, targets, target: targets[0] } : event });
  }, [store]);

  useEffect(() => {
    pausedRef.current = paused;
    if (paused || bufferedEventsRef.current.length === 0) return;
    const buffered = bufferedEventsRef.current.splice(0);
    buffered.forEach(dispatchParsedEvent);
  }, [dispatchParsedEvent, paused]);

  useEffect(() => {
    if (!enabled) {
      bufferedEventsRef.current = [];
      store.reset();
      return;
    }
    let stopped = false;
    const queued: Array<ReturnType<typeof parseActivityEvent> & {}> = [];
    let flushTimer: number | null = null;
    const flush = () => {
      flushTimer = null;
      if (stopped) return;
      queued.splice(0).forEach(event => {
        if (!event) return;
        if (event.type === 'telemetry.gap') {
          store.dispatch({
            type: 'gap',
            from: typeof event.metadata?.from === 'string' ? event.metadata.from : undefined,
            to: typeof event.metadata?.to === 'string' ? event.metadata.to : undefined,
            requestedId: typeof event.metadata?.requestedId === 'string' ? event.metadata.requestedId : undefined,
            oldestId: typeof event.metadata?.oldestId === 'string' ? event.metadata.oldestId : undefined,
            reason: typeof event.metadata?.reason === 'string' ? event.metadata.reason : 'Collector replay gap',
          });
          return;
        }
        if (pausedRef.current) {
          bufferedEventsRef.current.push(event);
          while (bufferedEventsRef.current.length > MAX_PAUSED_ACTIVITY_BUFFER) bufferedEventsRef.current.shift();
          return;
        }
        dispatchParsedEvent(event);
      });
    };
    const queueEvent = (event: ReturnType<typeof parseActivityEvent>) => {
      if (!event) return;
      if (!activityEventMatchesWorkspace(event, workspaceId)) return;
      queued.push(event);
      if (flushTimer === null) flushTimer = window.setTimeout(flush, 45);
    };
    const stream = connectActivityStream({
      url: '/api/activity/stream',
      ...(workspaceId ? { workspaceId } : { allWorkspaces: true }),
      onEvent: queueEvent,
      onGap: gap => store.dispatch({ type: 'gap', ...gap }),
      onState: connection => {
        if (connection.status === 'connecting') store.dispatch({ type: 'connection', status: 'connecting', attempt: connection.attempt, lastEventId: connection.lastEventId });
        if (connection.status === 'connected') store.dispatch({ type: 'connection', status: 'connected', attempt: connection.attempt, lastEventId: connection.lastEventId });
        if (connection.status === 'reconnecting') store.dispatch({ type: 'connection', status: 'reconnecting', attempt: connection.attempt, error: connection.error, lastEventId: connection.lastEventId });
        if (connection.status === 'error') store.dispatch({ type: 'connection', status: 'error', attempt: connection.attempt, error: connection.error, lastEventId: connection.lastEventId });
      },
    });
    const expiryTimer = window.setInterval(() => store.dispatch({ type: 'expire' }), 500);
    return () => {
      stopped = true;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      window.clearInterval(expiryTimer);
      stream.close();
      bufferedEventsRef.current = [];
    };
  }, [dispatchParsedEvent, enabled, store, workspaceId]);
  return { ...state, clear };
}

export const ACTIVITY_REPLAY_LIST_LIMIT = 25;
export const MAX_ACTIVITY_REPLAY_RECORDING_PAGES = 16;
export const ACTIVITY_REPLAY_EVENT_PAGE_SIZE = 500;
export const MAX_ACTIVITY_REPLAY_PAGES = 64;
export const MAX_ACTIVITY_REPLAY_EVENTS = 50_000;

export interface ActivityReplayHookOptions {
  enabled: boolean;
  workspaceId?: string;
  sessionId?: string;
  indexes?: ActivityGraphIndexes;
  listLimit?: number;
  eventPageSize?: number;
  maxPages?: number;
  maxEvents?: number;
}

export interface ActivityReplayHookState {
  recordings: readonly ActivityRecordingSummary[];
  recordingsLoading: boolean;
  recordingsError?: string;
  selectedRecordingId: string | null;
  manifest?: ActivityRecordingManifest;
  loading: boolean;
  error?: string;
  open: boolean;
  snapshot: ActivityReplaySnapshot | null;
  /** Virtual timestamps keyed by archive sequence for replay-only layout expiry. */
  eventVirtualTimes: ReadonlyMap<number, number>;
  partial: boolean;
  selectRecording: (recordingId: string | null) => void;
  refresh: () => void;
  play: () => void;
  pause: () => void;
  reset: () => void;
  step: (count?: number) => number;
  setSpeed: (speed: number) => void;
  stop: () => void;
  close: () => void;
}

function replayErrorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function capturedAtMillis(value: string | number): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function replayVirtualTimes(pages: readonly ActivityReplayPage[]): ReadonlyMap<number, number> {
  const records = pages
    .flatMap(page => [...page.events])
    .sort((left, right) => left.recordingSequence - right.recordingSequence);
  const firstCapture = records
    .map(record => capturedAtMillis(record.capturedAt))
    .find((value): value is number => value !== undefined);
  let previousVirtualTime = 0;
  const result = new Map<number, number>();
  records.forEach(record => {
    const captured = capturedAtMillis(record.capturedAt);
    const relative = captured !== undefined && firstCapture !== undefined
      ? Math.max(0, captured - firstCapture)
      : previousVirtualTime;
    const virtualTime = Math.max(previousVirtualTime, relative);
    previousVirtualTime = virtualTime;
    if (!result.has(record.recordingSequence)) result.set(record.recordingSequence, virtualTime);
  });
  return result;
}

function replayPagesWithTargets(pages: readonly ActivityReplayPage[], indexes: ActivityGraphIndexes | undefined): ActivityReplayPage[] {
  if (!indexes) return pages.map(page => ({ ...page, events: [...page.events] }));
  return pages.map(page => ({
    ...page,
    events: page.events.map(record => {
      const targets = resolveActivityTargets(record.event, indexes);
      return targets.length > 0
        ? { ...record, event: { ...record.event, targets, target: targets[0] } }
        : record;
    }),
  }));
}

function completeReplayPages(pages: readonly ActivityReplayPage[], partial: boolean): ActivityReplayPage[] {
  return pages.map((page, index) => {
    const final = index === pages.length - 1;
    if (!final) return { ...page, nextCursor: undefined, complete: true };
    if (partial) return { ...page, partial: true };
    return { ...page, nextCursor: undefined, complete: true };
  });
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(callback);
  return window.setTimeout(() => callback(performance.now()), 16);
}

function cancelFrame(frame: number): void {
  if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
  else window.clearTimeout(frame);
}

/**
 * Archive replay is deliberately a second reducer/controller. The live SSE
 * store remains connected and keeps accumulating events while a recording is
 * selected, so closing replay immediately returns to the unchanged live view.
 */
export function useActivityReplay({
  enabled,
  workspaceId,
  sessionId,
  indexes,
  listLimit = ACTIVITY_REPLAY_LIST_LIMIT,
  eventPageSize = ACTIVITY_REPLAY_EVENT_PAGE_SIZE,
  maxPages = MAX_ACTIVITY_REPLAY_PAGES,
  maxEvents = MAX_ACTIVITY_REPLAY_EVENTS,
}: ActivityReplayHookOptions): ActivityReplayHookState {
  const [recordings, setRecordings] = useState<readonly ActivityRecordingSummary[]>([]);
  const [recordingsLoading, setRecordingsLoading] = useState(false);
  const [recordingsError, setRecordingsError] = useState<string>();
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ActivityRecordingManifest>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ActivityReplaySnapshot | null>(null);
  const [eventVirtualTimes, setEventVirtualTimes] = useState<ReadonlyMap<number, number>>(() => new Map());
  const [refreshToken, setRefreshToken] = useState(0);
  const controllerRef = useRef<ActivityReplay | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const listControllerRef = useRef<AbortController | null>(null);

  const clearController = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    controllerRef.current?.stop();
    controllerRef.current = null;
  }, []);

  useEffect(() => {
    setSelectedRecordingId(null);
    setManifest(undefined);
    setSnapshot(null);
    setEventVirtualTimes(new Map());
    setOpen(false);
  }, [sessionId, workspaceId]);

  useEffect(() => {
    if (!enabled) {
      listControllerRef.current?.abort();
      listControllerRef.current = null;
      setRecordings([]);
      setRecordingsLoading(false);
      setRecordingsError(undefined);
      setSelectedRecordingId(null);
      setManifest(undefined);
      setSnapshot(null);
      setOpen(false);
      setEventVirtualTimes(new Map());
      return;
    }
    const controller = new AbortController();
    listControllerRef.current?.abort();
    listControllerRef.current = controller;
    setRecordingsLoading(true);
    setRecordingsError(undefined);
    const loadRecordings = async () => {
      const pages: ActivityRecordingSummary[][] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < MAX_ACTIVITY_REPLAY_RECORDING_PAGES; pageIndex += 1) {
        const page = await listActivityRecordings({
          workspaceId,
          sessionId,
          limit: listLimit,
          cursor,
          signal: controller.signal,
        });
        pages.push([...page.recordings]);
        if (!page.nextCursor || seenCursors.has(page.nextCursor)) break;
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return pages.flat();
    };
    loadRecordings().then(nextRecordings => {
      if (controller.signal.aborted) return;
      setRecordings(nextRecordings);
    }).catch(reason => {
      if (controller.signal.aborted) return;
      setRecordingsError(replayErrorMessage(reason, 'Unable to list activity recordings.'));
    }).finally(() => {
      if (!controller.signal.aborted) setRecordingsLoading(false);
      if (listControllerRef.current === controller) listControllerRef.current = null;
    });
    return () => {
      controller.abort();
      if (listControllerRef.current === controller) listControllerRef.current = null;
    };
  }, [enabled, listLimit, refreshToken, sessionId, workspaceId]);

  useEffect(() => {
    if (!enabled || !selectedRecordingId) {
      clearController();
      setManifest(undefined);
      setSnapshot(null);
      setEventVirtualTimes(new Map());
      setLoading(false);
      setError(undefined);
      if (!selectedRecordingId) setOpen(false);
      return;
    }

    clearController();
    const requestController = new AbortController();
    let cancelled = false;
    setManifest(undefined);
    setSnapshot(null);
    setLoading(true);
    setError(undefined);
    setOpen(true);

    const load = async () => {
      try {
        const nextManifest = await getActivityRecording(selectedRecordingId, { signal: requestController.signal });
        const pages: ActivityReplayPage[] = [];
        const seenCursors = new Set<string>();
        let after: string | undefined;
        let totalEvents = 0;
        let partial = nextManifest.partial === true || nextManifest.complete === false;
        let pageIndex = 0;
        while (pageIndex < maxPages && totalEvents < maxEvents) {
          const page = await getActivityRecordingEvents(selectedRecordingId, {
            after,
            limit: eventPageSize,
            signal: requestController.signal,
          });
          const remaining = Math.max(0, maxEvents - totalEvents);
          const events = page.events.slice(0, remaining);
          const truncated = events.length < page.events.length;
          totalEvents += events.length;
          partial = partial || page.partial === true || page.complete === false || truncated;
          pages.push({ ...page, events, ...(truncated ? { partial: true } : {}) });
          pageIndex += 1;
          if (truncated || !page.nextCursor) break;
          if (seenCursors.has(page.nextCursor)) {
            partial = true;
            break;
          }
          seenCursors.add(page.nextCursor);
          after = page.nextCursor;
        }
        if (pageIndex >= maxPages && pages.at(-1)?.nextCursor) partial = true;
        if (totalEvents >= maxEvents && pages.at(-1)?.nextCursor) partial = true;
        if (cancelled || requestController.signal.aborted) return;
        const replayPages = replayPagesWithTargets(completeReplayPages(pages, partial), indexes);
        const replay = createActivityReplayController({
          manifest: nextManifest,
          pages: replayPages,
        });
        controllerRef.current = replay;
        unsubscribeRef.current = replay.subscribe(() => {
          if (!cancelled) setSnapshot(replay.getSnapshot());
        });
        setManifest(nextManifest);
        setSnapshot(replay.getSnapshot());
        setEventVirtualTimes(replayVirtualTimes(replayPages));
        setLoading(false);
        setOpen(true);
      } catch (reason) {
        if (cancelled || requestController.signal.aborted) return;
        setLoading(false);
        setOpen(false);
        setError(replayErrorMessage(reason, 'Unable to load the activity recording.'));
      }
    };
    void load();
    return () => {
      cancelled = true;
      requestController.abort();
      clearController();
    };
  }, [clearController, enabled, eventPageSize, indexes, maxEvents, maxPages, selectedRecordingId]);

  useEffect(() => {
    const replay = controllerRef.current;
    if (!replay || snapshot?.status !== 'playing') return;
    let frame: number | null = null;
    let previous: number | undefined;
    const tick = (timestamp: number) => {
      if (previous === undefined) {
        replay.advance(0);
      } else {
        replay.advance(Math.max(0, Math.min(1000, timestamp - previous)));
      }
      previous = timestamp;
      if (replay.getSnapshot().status === 'playing') frame = requestFrame(tick);
    };
    frame = requestFrame(tick);
    return () => {
      if (frame !== null) cancelFrame(frame);
    };
  }, [snapshot?.status]);

  useEffect(() => () => {
    listControllerRef.current?.abort();
    clearController();
  }, [clearController]);

  const selectRecording = useCallback((recordingId: string | null) => {
    setSelectedRecordingId(recordingId);
    setOpen(recordingId !== null);
  }, []);
  const refresh = useCallback(() => setRefreshToken(value => value + 1), []);
  const play = useCallback(() => {
    const replay = controllerRef.current;
    if (!replay) return;
    setOpen(true);
    replay.play();
  }, []);
  const pause = useCallback(() => controllerRef.current?.pause(), []);
  const reset = useCallback(() => {
    const replay = controllerRef.current;
    if (!replay) return;
    setOpen(true);
    replay.reset();
  }, []);
  const step = useCallback((count = 1) => {
    const replay = controllerRef.current;
    if (!replay) return 0;
    setOpen(true);
    return replay.step(count);
  }, []);
  const setSpeed = useCallback((speed: number) => controllerRef.current?.setSpeed(speed), []);
  const stop = useCallback(() => {
    clearController();
    setSelectedRecordingId(null);
    setManifest(undefined);
    setSnapshot(null);
    setEventVirtualTimes(new Map());
    setLoading(false);
    setError(undefined);
    setOpen(false);
  }, [clearController]);
  const close = useCallback(() => {
    clearController();
    setSelectedRecordingId(null);
    setManifest(undefined);
    setSnapshot(null);
    setEventVirtualTimes(new Map());
    setLoading(false);
    setError(undefined);
    setOpen(false);
  }, [clearController]);

  return {
    recordings,
    recordingsLoading,
    recordingsError,
    selectedRecordingId,
    manifest,
    loading,
    error,
    open,
    snapshot,
    eventVirtualTimes,
    partial: snapshot?.partial ?? (manifest?.partial === true || manifest?.complete === false),
    selectRecording,
    refresh,
    play,
    pause,
    reset,
    step,
    setSpeed,
    stop,
    close,
  };
}
