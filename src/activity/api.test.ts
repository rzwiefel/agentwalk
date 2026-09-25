// @ts-ignore The frontend tsconfig does not include Node's test-runner declarations.
import { test } from 'node:test';
import {
  ActivityApiError,
  activityRecordingEventsUrl,
  activityRecordingsUrl,
  getActivityRecording,
  getActivityRecordingEvents,
  listActivityRecordings,
} from './api';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Activity API assertion failed: ${message}`);
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const event = {
  schemaVersion: 1,
  id: 'event:1',
  sessionId: 'session:1',
  timestamp: '2026-01-01T00:00:00.000Z',
  type: 'session.start',
  content: 'must not be retained',
};

test('activity recording URLs encode bounded query parameters', () => {
  expect(
    activityRecordingsUrl({ workspaceId: 'workspace/a', sessionId: 'session 1', limit: 25, cursor: 'next/1' })
      === '/api/activity/recordings?workspaceId=workspace%2Fa&sessionId=session+1&limit=25&cursor=next%2F1',
    'recording list filters are encoded',
  );
  expect(
    activityRecordingEventsUrl('recording/a', { after: 'cursor 1', limit: 50 })
      === '/api/activity/recordings/recording%2Fa/events?after=cursor+1&limit=50',
    'event page cursors are encoded',
  );
});

test('activity recording clients validate and sanitize metadata envelopes', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async input => {
    const path = String(input);
    requests.push(path);
    if (path.startsWith('/api/activity/recordings?')) {
      return response({
        recordings: [{ recordingId: 'recording:1', sessionName: 'Replay 1', eventCount: 1, prompt: 'must not be retained' }],
        nextCursor: null,
      });
    }
    if (path.endsWith('/events?limit=50')) {
      return response({ events: [{ recordingSequence: 4, capturedAt: 1000, event }], nextCursor: '5' });
    }
    return response({
      recording: {
        recordingId: 'recording:1',
        sessions: [{ sessionId: 'session:1', eventCount: 1, prompt: 'must not be retained' }],
        closedAt: null,
        complete: true,
        prompt: 'must not be retained',
      },
    });
  }) as typeof fetch;
  try {
    const summaries = await listActivityRecordings({ workspaceId: 'workspace:1' });
    const manifest = await getActivityRecording('recording:1');
    const page = await getActivityRecordingEvents('recording:1', { limit: 50 });
    expect(summaries.recordings[0]?.recordingId === 'recording:1' && summaries.recordings[0]?.prompt === undefined, 'list responses expose IDs without raw content');
    expect(manifest.recordingId === 'recording:1' && manifest.complete === true && manifest.prompt === undefined && manifest.sessions[0]?.prompt === undefined, 'manifest responses are tied to the requested ID without raw content');
    expect(page.events[0]?.recordingSequence === 4
      && page.nextCursor === '5'
      && page.events[0]?.event.content === undefined,
    'event responses retain metadata only and preserve bounded cursors');
    expect(requests[1] === '/api/activity/recordings/recording%3A1', 'manifest path encodes the recording ID');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('activity recording clients reject malformed event pages', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response({
    events: [{ recordingSequence: -1, capturedAt: 1000, event }],
  })) as typeof fetch;
  try {
    let rejected = false;
    try {
      await getActivityRecordingEvents('recording:bad');
    } catch (reason) {
      rejected = reason instanceof ActivityApiError;
    }
    expect(rejected, 'malformed recording sequence is rejected as an API error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
