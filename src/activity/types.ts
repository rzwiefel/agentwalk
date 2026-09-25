import type { CodeGraph, GraphPositions, LayoutGroup } from '../types';

export type ActivityMode = 'architecture' | 'activity';

export type ActivityEventType =
  | 'session.start'
  | 'session.end'
  | 'agent.start'
  | 'agent.stop'
  | 'agent.waiting'
  | 'agent.error'
  | 'tool.start'
  | 'tool.end'
  | 'tool.error'
  | 'file.read'
  | 'file.write'
  | 'search'
  | 'execute'
  | 'telemetry.gap'
  | (string & {});

export interface ActivityWorkspace {
  id?: string;
  workspaceId?: string;
  root?: string;
  path?: string;
  file?: string;
  repository?: string;
  branch?: string;
}

export interface ActivityResource {
  kind?: string;
  action?: 'read' | 'write' | 'search' | 'execute' | 'reference' | 'network';
  confidence?: 'exact' | 'observed' | 'inferred';
  outsideRoot?: boolean;
  name?: string;
  path?: string;
  ref?: string;
  provider?: string;
  file?: string;
  line?: number;
  endLine?: number;
  column?: number;
  endColumn?: number;
  nodeId?: string;
  span?: {
    start?: { line?: number; column?: number };
    end?: { line?: number; column?: number };
  };
}

export type ActivityResourceDomain = 'workspace' | 'web' | 'unknown';

export function activityResourceDomain(resource: ActivityResource): ActivityResourceDomain {
  if (['url', 'host', 'domain', 'endpoint', 'http'].includes(resource.kind ?? '')) return 'web';
  if (['file', 'directory', 'dir', 'path'].includes(resource.kind ?? '')) return 'workspace';
  return 'unknown';
}

export interface ActivityEvent {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  sessionName?: string;
  agentName?: string;
  timestamp: string;
  type: ActivityEventType;
  sequence?: number;
  parentId?: string;
  agentId?: string;
  turnId?: string;
  toolCallId?: string;
  source?: string | {
    client?: 'copilot-cli' | 'copilot-app' | 'unknown';
    kind?: 'hook' | 'sdk' | 'jsonl' | 'sqlite' | 'otel';
    version?: string;
  };
  status?: string;
  tool?: string;
  snippet?: string;
  workspace?: ActivityWorkspace;
  resources?: ActivityResource[];
  content?: {
    availability?: 'available' | 'unavailable' | 'redacted';
    localRef?: string;
    mimeType?: string;
    size?: number;
    sha256?: string;
    redacted?: boolean;
  };
  metadata?: Record<string, string | number | boolean>;
  sseId?: string;
  target?: ActivityTarget;
  targets?: ActivityTarget[];
  /**
   * Archive-local ordering metadata. Live events do not carry this field;
   * archived replay events add it without changing the provider timestamp.
   */
  recordingSequence?: number;
}

export type ActivityCapturedAt = string | number;

/**
 * The event envelope returned by the archived activity API. `recordingSequence`
 * is the only ordering key; `capturedAt` is used to derive replay time and the
 * nested provider timestamp remains display metadata on `event`.
 */
export interface ActivityReplayEvent {
  recordingSequence: number;
  capturedAt: ActivityCapturedAt;
  event: ActivityEvent;
}

export interface ActivityArchiveManifestSummary {
  sessionId: string;
  sessionName?: string;
  agentName?: string;
  workspace?: ActivityWorkspace;
  startedAt?: string;
  endedAt?: string;
  eventCount?: number;
  complete?: boolean;
  [key: string]: unknown;
}

export interface ActivityArchiveManifest {
  sessions: readonly ActivityArchiveManifestSummary[];
  partial?: boolean;
  complete?: boolean;
  eventCount?: number;
  [key: string]: unknown;
}

export interface ActivityReplayPage {
  events: readonly ActivityReplayEvent[];
  cursor?: string;
  nextCursor?: string;
  partial?: boolean;
  complete?: boolean;
  hasMore?: boolean;
}

export type ActivityReplayManifestInput = ActivityArchiveManifest | readonly ActivityArchiveManifestSummary[];

export interface ActivityReplayInput {
  manifest?: ActivityReplayManifestInput;
  pages?: readonly ActivityReplayPage[];
  events?: readonly ActivityReplayEvent[];
  initialState?: ActivityState;
  speed?: number;
}

export type ActivityReplayStatus = 'idle' | 'playing' | 'paused' | 'stopped' | 'completed';

export interface ActivityReplaySnapshot {
  /** Reducer state owned exclusively by this replay controller. */
  activity: ActivityState;
  status: ActivityReplayStatus;
  speed: number;
  /** Milliseconds on the replay's virtual clock, relative to its first capture. */
  virtualTime: number;
  /** Number of recording envelopes already fed through activityReducer. */
  cursor: number;
  eventCount: number;
  partial: boolean;
  current?: ActivityReplayEvent;
}

export interface ActivityReplay {
  getSnapshot: () => ActivityReplaySnapshot;
  getState: () => ActivityState;
  subscribe: (listener: () => void) => () => void;
  play: () => void;
  pause: () => void;
  reset: () => void;
  step: (count?: number) => number;
  setSpeed: (speed: number) => void;
  stop: () => void;
  getEvents: () => readonly ActivityReplayEvent[];
  getManifest: () => ActivityReplayManifestInput | undefined;
  /**
   * Advance a playing replay by a caller-supplied amount of virtual time.
   * This method never reads a wall clock or schedules a timer.
   */
  advance: (deltaMs: number) => number;
  /** Alias for `advance`, useful for animation-loop callers. */
  tick: (deltaMs: number) => number;
}

export interface ActivityTarget {
  kind: 'node' | 'group';
  id: string;
  match: 'node' | 'span' | 'file' | 'group' | 'external' | 'patch-file';
  sourceId?: string;
  workspaceId?: string;
  file?: string;
  line?: number;
  /** Display label for targets with no graph identity, e.g. a host or family name (T2-B). */
  label?: string;
}

export interface ActivityGraphIndexes {
  nodeById: Map<string, CodeGraph['nodes'][number]>;
  groupsById: Map<string, LayoutGroup>;
  groupsByNamespace: Map<string, LayoutGroup>;
  fileNodes: Map<string, CodeGraph['nodes'][number][]>;
  fileSuffixNodes: Map<string, CodeGraph['nodes'][number][]>;
  fileGroups: Map<string, LayoutGroup[]>;
  fileSuffixGroups: Map<string, LayoutGroup[]>;
  activityGroupsByPath: Map<string, LayoutGroup[]>;
  relativeRoot: string;
  repositoryName: string;
  workspaceId: string;
  identity: string;
}

export interface ActivityPulse {
  id: string;
  eventId: string;
  sessionId: string;
  target: ActivityTarget;
  kind: 'read' | 'write' | 'search' | 'execute' | 'session' | 'network' | 'failed' | 'unknown';
  color: string;
  startedAt: number;
  expiresAt: number;
}

export interface ActivityRayAgentLink {
  targetAgentId: string;
  targetAgentNodeId?: string;
  targetSessionId?: string;
  targetWorkspaceId?: string;
  flowDirection: 'source-to-target' | 'target-to-source';
}

export interface ActivityRay {
  id: string;
  eventId: string;
  sessionId: string;
  sourceId?: string;
  workspaceId?: string;
  sourceAgentNodeId?: string;
  sourceGroupId?: string;
  target: ActivityTarget;
  agentLink?: ActivityRayAgentLink;
  targetMarkerId?: string;
  color: string;
  startedAt: number;
  expiresAt: number;
}

export interface ActivitySnippetMarker {
  id: string;
  eventId: string;
  sessionId: string;
  groupId: string;
  text: string;
  sourceId?: string;
  workspaceId?: string;
  startedAt: number;
  expiresAt: number;
}

export type ActivityGroupKind = 'bash' | 'tool' | 'project' | 'file' | 'directory' | 'web' | 'domain';

export interface ActivityGroupSpec {
  id: string;
  label: string;
  kind: ActivityGroupKind;
  tool?: string;
  parentId?: string | null;
  projectId?: string;
  projectRoot?: string;
  path?: string;
  lastActivityAt: number;
  expiresAt: number;
  /**
   * Outcome of the most recent event that reported one for this group (T2-D
   * remainder). `activityGroupSpecs` (src/layout.ts) only ever sets this for
   * `tests`/`git`/`build` family groups and `domain` spheres, derived
   * straight off the raw event's `status`/`exitCode`/`errorClassification`
   * metadata; every other group kind leaves it undefined, and GroupVolume
   * (src/components/GraphCanvas.tsx) renders those exactly as before.
   */
  lastOutcome?: ActivityToolOutcome['outcome'];
}

export interface ActivityConnection {
  status: 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'gap' | 'unavailable' | 'error';
  reconnectAttempt: number;
  lastEventId?: string;
  lastError?: string;
  coverage: 'exact' | 'observed' | 'partial' | 'unavailable';
  replayGap?: { from?: string; to?: string; requestedId?: string; oldestId?: string; reason?: string };
}

export interface ActivityAgentState {
  id: string;
  sessionId: string;
  status: string;
  lastEventId: string;
  updatedAt: number;
}

export interface ActivityAgentNode {
  id: string;
  agentId: string;
  sessionId: string;
  sessionName?: string;
  agentName?: string;
  label: string;
  status: string;
  activity: string;
  color: string;
  lastEventId: string;
  updatedAt: number;
  workspaceId?: string;
  source?: string;
  parentId?: string;
  /** Set while a permission request owned by this agent is unresolved (T1-B). */
  waitingSince?: number;
  waitingToolCallId?: string;
  /** Last time a permission this agent owned resolved to a `denied-*` kind (T1-B). */
  lastDeniedAt?: number;
}

export interface ActivityToolState {
  id: string;
  sessionId: string;
  agentId?: string;
  tool?: string;
  status: string;
  summary?: string;
  startedAt: number;
  updatedAt: number;
}

/**
 * One finished tool call in the bounded completed ring (T1-E). Durations are
 * either reported by the producer (`metadata.durationMs`) or derived by pairing
 * the completion with its `toolCallId` start; a completion whose start was
 * never seen keeps `durationMs` undefined rather than guessing.
 */
export interface ActivityToolOutcome {
  id: string;
  toolCallId: string;
  tool?: string;
  sessionId: string;
  agentId?: string;
  startedAt?: number;
  endedAt: number;
  durationMs?: number;
  outcome: 'completed' | 'failed';
  errorClassification?: string;
  errorCode?: string;
  exitCode?: number;
  count?: number;
  bytes?: number;
  target?: ActivityTarget;
  summary?: string;
}

/** An open turn is one with no `endedAt` (T1-D). */
export interface ActivitySessionTurn {
  startedAt: number;
  endedAt?: number;
  lastEventAt: number;
}

/** An unresolved permission request; `since` drives the amber halo (T1-B). */
export interface ActivitySessionWaiting {
  toolCallId: string;
  since: number;
  tool?: string;
  agentId?: string;
  permissionKind?: string;
}

export type ActivitySessionStatus = 'waiting' | 'failed' | 'stalled' | 'active' | 'idle' | 'ended';

/**
 * Derived per-session signal state (T1-B/T1-D/T1-F). Everything here is a
 * bounded scalar or timestamp — never prompt, argument, output, or error text.
 */
export interface ActivitySessionState {
  id: string;
  startedAt: number;
  lastEventAt: number;
  endedAt?: number;
  turn?: ActivitySessionTurn;
  waiting?: ActivitySessionWaiting;
  lastDeniedAt?: number;
  lastPermissionResult?: string;
  lastErrorAt?: number;
  lastErrorClassification?: string;
  lastToolOutcome?: ActivityToolOutcome['outcome'];
  lastToolOutcomeAt?: number;
}

export interface ActivityState {
  events: ActivityEvent[];
  unknownEvents: ActivityEvent[];
  activeSessions: Map<string, ActivityEvent>;
  activeAgents: Map<string, ActivityAgentState>;
  agentNodes: Map<string, ActivityAgentNode>;
  activeTools: Map<string, ActivityToolState>;
  /** Bounded by MAX_ACTIVITY_SESSIONS, keyed by sessionId. */
  sessions: Map<string, ActivitySessionState>;
  /** Bounded by MAX_COMPLETED_TOOLS, newest last. */
  completedTools: ActivityToolOutcome[];
  pulses: ActivityPulse[];
  rays: ActivityRay[];
  snippetMarkers: ActivitySnippetMarker[];
  seenIds: Set<string>;
  connection: ActivityConnection;
  revision: number;
}

export type ActivityAction =
  | {
      type: 'event';
      event: ActivityEvent;
      now?: number;
      /**
       * Optional reducer time for lifecycle/session state. Live callers retain
       * the existing provider-timestamp fallback; replay supplies its
       * virtual clock explicitly.
       */
      eventNow?: number;
    }
  | { type: 'connection'; status: ActivityConnection['status']; error?: string; attempt?: number; lastEventId?: string }
  | { type: 'gap'; from?: string; to?: string; requestedId?: string; oldestId?: string; reason?: string }
  | { type: 'expire'; now?: number }
  | { type: 'reset' };

export interface ActivityRenderState {
  pulses: ActivityPulse[];
  rays: ActivityRay[];
  snippetMarkers: ActivitySnippetMarker[];
  activeNodeIds: Set<string>;
  activeGroupIds: Set<string>;
}

export interface ActivityStore {
  getState: () => ActivityState;
  dispatch: (action: ActivityAction) => void;
  subscribe: (listener: () => void) => () => void;
  reset: () => void;
}

export type ActivityPositionIndex = {
  positions: GraphPositions;
  groups: Map<string, LayoutGroup>;
};
