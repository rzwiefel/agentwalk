// @ts-ignore The frontend tsconfig does not include Node's test-runner declarations.
import { test } from 'node:test';
import { createActivityStore } from './hooks';
import { createActivityReplay } from './replay';
import type { ActivityEvent, ActivityReplayEvent } from './types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Activity replay assertion failed: ${message}`);
}

const baseEvent: ActivityEvent = {
  schemaVersion: 1,
  id: 'event:base',
  sessionId: 'session:replay',
  timestamp: '2026-01-01T00:00:00.000Z',
  type: 'session.start',
};

function event(id: string, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return { ...baseEvent, id, ...overrides };
}

function recording(
  recordingSequence: number,
  capturedAt: string | number,
  replayEvent: ActivityEvent,
): ActivityReplayEvent {
  return { recordingSequence, capturedAt, event: replayEvent };
}

test('activity replay orders by recording sequence and retains provider metadata', () => {
  const first = recording(10, 1_000, event('first', {
    timestamp: '2026-01-01T00:00:30.000Z',
    sequence: 90,
  }));
  const second = recording(20, 2_000, event('second', {
    timestamp: '2026-01-01T00:00:30.000Z',
    sequence: 1,
  }));
  const third = recording(30, 3_000, event('third', {
    timestamp: '2026-01-01T00:00:30.000Z',
    sequence: 12,
  }));
  const replay = createActivityReplay({
    manifest: {
      sessions: [{ sessionId: 'session:replay', complete: false }],
      complete: false,
    },
    pages: [
      { events: [third, first], nextCursor: 'page-2' },
      { events: [second, third] },
    ],
  });

  expect(replay.getEvents().map(item => item.recordingSequence).join(',') === '10,20,30',
    'gapped recording sequences are sorted numerically');
  expect(replay.getEvents().map(item => item.event.id).join(',') === 'first,second,third',
    'duplicate page envelopes are removed without consulting provider timestamps');
  expect(replay.getEvents()[0].event.timestamp === '2026-01-01T00:00:30.000Z',
    'provider timestamp remains unchanged display metadata');
  expect(replay.getSnapshot().partial, 'manifest/page completeness is exposed for partial recordings');

  expect(replay.step(3) === 3, 'stepping consumes all ordered recording envelopes');
  expect(replay.getState().events.map(item => item.id).join(',') === 'first,second,third',
    'reducer history follows recording order even when provider timestamps tie');
  expect(replay.getState().events.map(item => item.recordingSequence).join(',') === '10,20,30',
    'replay order metadata is retained on reducer events');
});

test('activity replay uses a deterministic virtual clock independent of provider time', () => {
  const replay = createActivityReplay([
    recording(7, '2026-01-01T00:00:05.000Z', event('start', {
      type: 'session.start',
      timestamp: '2026-01-01T00:09:00.000Z',
    })),
    recording(9, '2026-01-01T00:00:08.500Z', event('end', {
      type: 'session.end',
      timestamp: '2025-01-01T00:00:00.000Z',
    })),
  ]);

  replay.step();
  const started = replay.getState().sessions.get('session:replay');
  expect(started?.startedAt === 0 && started.lastEventAt === 0,
    'the first event is anchored at virtual time zero');
  expect(replay.getEvents()[0].event.timestamp === '2026-01-01T00:09:00.000Z',
    'provider timestamps are not rewritten to virtual time');

  replay.step();
  const ended = replay.getState().sessions.get('session:replay');
  expect(ended?.endedAt === 3_500 && ended.lastEventAt === 3_500,
    'capturedAt deltas drive lifecycle timestamps on the virtual clock');
});

test('activity replay supports reset, play, pause, step, speed, and stop', () => {
  const replay = createActivityReplay([
    recording(1, 0, event('one')),
    recording(2, 100, event('two')),
    recording(3, 200, event('three')),
  ]);

  expect(replay.getSnapshot().status === 'idle' && replay.getSnapshot().cursor === 0,
    'a replay starts idle at its beginning');
  replay.play();
  expect(replay.getSnapshot().status === 'playing', 'play enters playing state');
  expect(replay.advance(0) === 1 && replay.getSnapshot().cursor === 1,
    'zero virtual time consumes an event captured at the beginning');

  replay.pause();
  expect(replay.advance(100) === 0 && replay.getSnapshot().virtualTime === 0,
    'pause prevents virtual clock progression');
  replay.setSpeed(2);
  replay.play();
  expect(replay.advance(50) === 1 && replay.getSnapshot().virtualTime === 100,
    'speed scales caller-supplied virtual time');

  expect(replay.step() === 1 && replay.getSnapshot().status === 'completed',
    'step consumes the final event and completes the replay');
  replay.reset();
  expect(replay.getSnapshot().status === 'idle'
    && replay.getSnapshot().cursor === 0
    && replay.getSnapshot().virtualTime === 0
    && replay.getState().events.length === 0,
  'reset restores empty reducer state and the virtual origin');

  replay.play();
  replay.advance(1_000);
  replay.stop();
  expect(replay.getSnapshot().status === 'stopped'
    && replay.getSnapshot().cursor === 0
    && replay.getState().events.length === 0,
  'stop halts and rewinds the isolated recording');
});

test('activity replay feeds tool lifecycle through the existing reducer path', () => {
  const replay = createActivityReplay([
    recording(100, 10_000, event('tool-start', {
      type: 'tool.start',
      status: 'started',
      toolCallId: 'call:replay',
      tool: 'shell',
      timestamp: '2026-01-01T10:00:00.000Z',
    })),
    recording(101, 11_500, event('tool-end', {
      type: 'tool.end',
      status: 'completed',
      toolCallId: 'call:replay',
      tool: 'shell',
      timestamp: '2026-01-01T09:00:00.000Z',
    })),
  ]);

  replay.step(2);
  const outcome = replay.getState().completedTools[0];
  expect(outcome?.toolCallId === 'call:replay'
    && outcome.startedAt === 0
    && outcome.endedAt === 1_500
    && outcome.durationMs === 1_500,
  'tool durations use reducer lifecycle pairing and virtual event time');
});

test('activity replay owns reducer state without mutating the live activity store', () => {
  const live = createActivityStore();
  live.dispatch({ type: 'event', event: event('live'), now: 4_000, eventNow: 4_000 });
  const liveState = live.getState();
  const replay = createActivityReplay([
    recording(1, 0, event('archived')),
  ]);

  replay.step();
  expect(live.getState() === liveState
    && live.getState().events.length === 1
    && live.getState().events[0].id === 'live',
  'replay events never enter or replace the live store state');
  expect(replay.getState() !== liveState && replay.getState().events[0].id === 'archived',
    'replay state is an independent reducer state');
});
