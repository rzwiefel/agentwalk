import type { ActivityEvent, ActivityEventType, ActivityResource, ActivityWorkspace } from './types';

const MAX_TEXT = 180;
const MAX_METADATA_KEYS = 20;
const RESOURCE_ACTIONS = new Set(['read', 'write', 'search', 'execute', 'reference', 'network']);
const ACTIVITY_AGENT_COLORS = ['#4da3ff', '#ff4d5a', '#df8eff', '#49d8b0', '#7898ff'] as const;

/**
 * The provider's `PermissionResult.kind` enum (docs/copilot-payloads.md §2c).
 * Anything outside this list is dropped rather than rendered.
 */
export const ACTIVITY_PERMISSION_RESULTS = [
  'approved',
  'approved-for-session',
  'approved-for-location',
  'cancelled',
  'denied-by-rules',
  'denied-no-approval-rule-and-could-not-request-from-user',
  'denied-interactively-by-user',
  'denied-by-content-exclusion-policy',
  'denied-by-permission-request-hook',
] as const;

export type ActivityPermissionResult = typeof ACTIVITY_PERMISSION_RESULTS[number];

const PERMISSION_RESULTS = new Set<string>(ACTIVITY_PERMISSION_RESULTS);
/** Bounded metadata scalars: counts cap at 2^53, exit codes at a signed 32-bit range. */
const MAX_METADATA_COUNT = 2 ** 53;
const MIN_METADATA_EXIT_CODE = -(2 ** 31);
const MAX_METADATA_EXIT_CODE = 2 ** 31;
const METADATA_COUNT_KEYS = new Set(['bytes', 'count', 'durationMs']);

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function nestedObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().slice(0, max);
}

function sessionName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}

function redactedText(value: unknown, max = MAX_TEXT): string | undefined {
  const valueText = text(value, max);
  if (!valueText) return undefined;
  return valueText
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s@]+@)+/gi, '$1')
    .replace(/\b((?:Bearer|Basic|Token)\s*(?:[:=]\s*|\s+)|(?:password|passwd|token|secret|api[_-]?key|authorization|cookie|credential|access[_-]?key|private[_-]?key)\s*[:=]\s*(?!(?:Bearer|Basic|Token)\b))\S+/gi, '$1[redacted]');
}

function normalizedPath(value: string): string {
  const path = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  const drive = path.match(/^[a-zA-Z]:/);
  const absolute = path.startsWith('/') || Boolean(drive);
  const prefix = drive ? drive[0] : path.startsWith('/') ? '/' : '';
  const rest = drive ? path.slice(2).replace(/^\/+/, '') : path.replace(/^\/+/, '');
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (!absolute) segments.push(segment);
    } else {
      segments.push(segment);
    }
  }
  if (drive) return `${prefix}/${segments.join('/')}`.replace(/\/$/, '');
  return `${prefix}${segments.join('/')}` || (absolute ? prefix : '');
}

function absolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:\//.test(value);
}

function safeRelativePath(value: string): string | undefined {
  const path = normalizedPath(value).replace(/^\.\/+/, '');
  if (!path || absolutePath(path)) return undefined;
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || !/^[a-zA-Z0-9_.@+~() -]+$/.test(segment))) return undefined;
  return segments.join('/');
}

function relativeToRoot(value: string, root: string): string | undefined {
  const path = normalizedPath(value);
  const normalizedRoot = normalizedPath(root).replace(/\/+$/, '');
  if (!normalizedRoot || (path !== normalizedRoot && !path.startsWith(`${normalizedRoot}/`))) return undefined;
  return path.slice(normalizedRoot.length + 1);
}

function knownResourcePaths(event: ActivityEvent): string[] {
  const root = event.workspace?.root;
  const values = [
    ...(event.resources ?? []).flatMap(resource => [resource.file, resource.path]),
    event.workspace?.file,
    event.workspace?.path,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(values.flatMap(value => {
    const normalized = normalizedPath(value);
    const relative = root && absolutePath(normalized) ? relativeToRoot(normalized, root) : undefined;
    const display = relative !== undefined ? (relative || normalized) : normalized;
    return display ? [display] : [];
  }))];
}

function renderPath(value: string, event: ActivityEvent): string {
  const normalized = normalizedPath(value);
  const root = event.workspace?.root;
  if (root) {
    const relative = relativeToRoot(normalized, root);
    if (relative !== undefined) {
      return relative || normalized;
    }
    if (absolutePath(normalized)) return normalized;
  }
  const relative = safeRelativePath(normalized);
  if (relative) return relative;
  if (absolutePath(normalized)) {
    return normalized;
  }
  const basename = normalized.split('/').filter(Boolean).at(-1);
  return basename && /^[a-zA-Z0-9_.@+~() -]+$/.test(basename) ? basename : normalized;
}

function renderSnippetPath(value: string, event: ActivityEvent): string {
  const normalized = normalizedPath(value);
  return renderPath(normalized, event);
}

function safeSnippet(value: unknown, event?: ActivityEvent): string | undefined {
  const valueText = text(value, 140);
  if (!valueText) return undefined;
  const safe = valueText
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s@]+@)+/gi, '$1')
    .replace(/\b((?:Bearer|Basic|Token)\s*(?:[:=]\s*|\s+)|(?:password|passwd|token|secret|api[_-]?key|authorization|cookie|credential|access[_-]?key|private[_-]?key)\s*[:=]\s*(?!(?:Bearer|Basic|Token)\b))\S+/gi, '$1[redacted]')
    .replace(/[^\w .:/@+={}\[\]\\\-·]/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  if (!safe) return undefined;
  const hadPathPlaceholder = /\[(?:PATH|path|path redacted)\]/.test(safe);
  let rendered = event
    ? safe.replace(/(?<![\w./:-])(?:\/|[a-zA-Z]:\/)[^\s]+/g, path => renderSnippetPath(path, event))
    : safe.replace(/(?<![\w./:-])(?:\/|[a-zA-Z]:\/)[^\s]+/g, path => normalizedPath(path));
  if (event && hadPathPlaceholder) {
    const resources = knownResourcePaths(event);
    rendered = rendered.replace(/\[(?:PATH|path|path redacted)\]/g, resources.length === 1 ? resources[0] : 'unknown path');
  }
  return rendered.slice(0, 120) || undefined;
}

const UNSAFE_SNIPPET_KEY = /(argument|command|code|content|credential|environment|env|output|prompt|result|secret|stack|token)/i;

function structuredArguments(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = nestedObject(input.data);
  const candidate = input.toolArgs ?? input.toolArguments ?? input.arguments ?? input.args ?? input.parameters
    ?? data.toolArgs ?? data.toolArguments ?? data.arguments ?? data.args ?? data.parameters;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate as Record<string, unknown>;
  if (typeof candidate === 'string') {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function structuredArgumentValue(value: unknown, event: ActivityEvent, key: string): string | undefined {
  const pathLike = /(?:paths?|file(?:name|path)?|directory|dir|cwd|workspace|uri)$/i.test(key);
  const values = Array.isArray(value) ? value.slice(0, 4) : [value];
  const rendered = values.map(item => {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') return undefined;
    if (pathLike && typeof item === 'string' && !absolutePath(normalizedPath(item))) {
      return safeRelativePath(item);
    }
    return safeSnippet(item, event);
  }).filter((item): item is string => Boolean(item));
  return rendered.length ? rendered.join(',') : undefined;
}

function structuredSnippet(input: Record<string, unknown>, event: ActivityEvent): string | undefined {
  const data = nestedObject(input.data);
  const tool = safeToolName(text(input.tool, 120) ?? text(input.toolName, 120) ?? text(data.toolName, 120));
  const args = structuredArguments(input);
  if (!tool || !args) return undefined;
  const candidate = args.command ?? args.cmd ?? input.command ?? input.cmd;
  if (typeof candidate === 'string' && candidate.trim()) return safeSnippet(candidate, event);
  const normalizedTool = tool.toLowerCase();
  if (/^view(?:[-_]|$)|read[-_]?file|cat/.test(normalizedTool)) {
    const path = structuredArgumentValue(args.path ?? args.filePath ?? args.file ?? args.filename ?? args.directory, event, 'path');
    return [tool, path].filter(Boolean).join(' · ').slice(0, 120);
  }
  if (/sql|query/.test(normalizedTool)) {
    const query = args.query ?? args.sql ?? args.statement ?? args.operation ?? args.action;
    const operation = typeof query === 'string' ? query.match(/^\s*(select|insert|update|delete|with|create|alter|drop|pragma)\b/i)?.[1] : undefined;
    return [tool, operation?.toUpperCase()].filter(Boolean).join(' · ');
  }
  const parts = Object.entries(args)
    .filter(([key]) => /^[a-zA-Z0-9_.-]{1,48}$/.test(key) && !UNSAFE_SNIPPET_KEY.test(key))
    .slice(0, 4)
    .map(([key, value]) => {
      const rendered = structuredArgumentValue(value, event, key);
      return rendered ? `${key}=${rendered}` : undefined;
    })
    .filter((item): item is string => Boolean(item));
  return [tool, ...parts].join(' · ').slice(0, 120);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeContent(value: unknown): ActivityEvent['content'] | undefined {
  const input = objectValue(value);
  const result: NonNullable<ActivityEvent['content']> = {};
  if (input.availability === 'available' || input.availability === 'unavailable' || input.availability === 'redacted') {
    result.availability = input.availability;
  }
  for (const key of ['localRef', 'mimeType', 'sha256'] as const) {
    const value = text(input[key], key === 'localRef' ? 1024 : key === 'mimeType' ? 128 : 128);
    if (value) result[key] = value;
  }
  const size = numberValue(input.size);
  if (size !== undefined && size >= 0) result.size = size;
  if (typeof input.redacted === 'boolean') result.redacted = input.redacted;
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeWorkspace(value: unknown): ActivityWorkspace | undefined {
  const input = objectValue(value);
  const result: ActivityWorkspace = {};
  for (const key of ['id', 'workspaceId', 'root', 'path', 'file', 'repository', 'branch'] as const) {
    const value = text(input[key], 500);
    if (value) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Resource kinds are a bounded slug: `file`/`directory` today, `url`/`tests`/`git`/`build` from T2-A. */
const RESOURCE_KIND = /^[a-z][a-z0-9-]{0,31}$/;
/** A `url` resource's `name` is `host[:port]` — never a path, query, or credential (roadmap §6). */
const URL_RESOURCE_NAME = /^[a-z0-9.\-]+(:\d{1,5})?$/;
const URL_RESOURCE_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
const RESOURCE_PROVIDER = /^[A-Za-z0-9_.\-]+$/;

function safeResourceKind(value: unknown): string | undefined {
  const raw = text(value, 32);
  return raw && RESOURCE_KIND.test(raw) ? raw : undefined;
}

function safeResourceName(value: unknown, kind: string | undefined): string | undefined {
  const raw = text(value, 256);
  if (!raw) return undefined;
  if (kind !== 'url') return raw;
  const normalized = raw.toLowerCase();
  return URL_RESOURCE_NAME.test(normalized) ? normalized : undefined;
}

/**
 * Parses with `new URL` and rebuilds from `origin + pathname` only, so search,
 * hash, and userinfo are dropped even if the producer's own redaction missed
 * them (roadmap §6: never a full URL beyond origin+path).
 */
function safeResourceRef(value: unknown): string | undefined {
  const raw = text(value, 512);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!URL_RESOURCE_SCHEMES.has(url.protocol)) return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function safeResourceProvider(value: unknown): string | undefined {
  const raw = text(value, 64);
  return raw && RESOURCE_PROVIDER.test(raw) ? raw : undefined;
}

function safeResource(value: unknown): ActivityResource | undefined {
  const input = objectValue(value);
  const result: ActivityResource = {};
  const kind = safeResourceKind(input.kind);
  if (kind) result.kind = kind;
  for (const key of ['path', 'file', 'nodeId'] as const) {
    const value = text(input[key], 500);
    if (value) result[key] = value;
  }
  if (!result.path) {
    const relativePath = text(input.relativePath, 500);
    if (relativePath) result.path = relativePath;
  }
  const name = safeResourceName(input.name, kind);
  if (name) result.name = name;
  const ref = safeResourceRef(input.ref);
  if (ref) result.ref = ref;
  const provider = safeResourceProvider(input.provider);
  if (provider) result.provider = provider;
  if (typeof input.action === 'string' && RESOURCE_ACTIONS.has(input.action)) {
    result.action = input.action as ActivityResource['action'];
  }
  if (input.confidence === 'exact' || input.confidence === 'observed' || input.confidence === 'inferred') result.confidence = input.confidence;
  if (typeof input.outsideRoot === 'boolean') result.outsideRoot = input.outsideRoot;
  for (const key of ['line', 'endLine', 'column', 'endColumn'] as const) {
    const value = numberValue(input[key]);
    if (value !== undefined) result[key] = Math.max(0, Math.floor(value));
  }
  const span = objectValue(input.span);
  const start = objectValue(span.start);
  const end = objectValue(span.end);
  if (Object.keys(start).length > 0 || Object.keys(end).length > 0) {
    result.span = {
      ...(numberValue(start.line) === undefined ? {} : { start: { line: Math.max(0, Math.floor(numberValue(start.line) as number)), ...(numberValue(start.column) === undefined ? {} : { column: Math.max(0, Math.floor(numberValue(start.column) as number)) }) } }),
      ...(numberValue(end.line) === undefined ? {} : { end: { line: Math.max(0, Math.floor(numberValue(end.line) as number)), ...(numberValue(end.column) === undefined ? {} : { column: Math.max(0, Math.floor(numberValue(end.column) as number)) }) } }),
    };
  }
  // A `url` resource with no valid host cannot be routed to a domain group;
  // drop the resource rather than keep a kind:'url' shape nothing can resolve.
  if (result.kind === 'url' && !result.name) return undefined;
  return Object.keys(result).length > 0 ? result : undefined;
}

function resourceCandidates(value: unknown, depth = 0): unknown[] {
  if (depth > 2 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(item => resourceCandidates(item, depth + 1)).slice(0, 32);
  if (typeof value !== 'object') return [];
  const input = objectValue(value);
  const resource = safeResource(input);
  const nested = ['resources', 'resource', 'targets', 'files', 'paths']
    .flatMap(key => resourceCandidates(input[key], depth + 1));
  return resource ? [resource, ...nested] : nested;
}

function providerResources(input: Record<string, unknown>, data: Record<string, unknown>): ActivityResource[] {
  const metadata = objectValue(input.metadata ?? data.metadata);
  const candidates = [
    ...resourceCandidates(input.resources ?? data.resources),
    ...resourceCandidates(input.resource ?? data.resource),
    ...resourceCandidates(metadata.resources ?? metadata.resource ?? metadata.files ?? metadata.paths),
    ...resourceCandidates({
      path: input.path ?? input.file ?? input.filePath ?? data.path ?? data.file ?? data.filePath ?? metadata.path ?? metadata.file,
      kind: input.kind ?? data.kind ?? metadata.kind,
      action: input.action ?? data.action ?? metadata.action,
      confidence: input.confidence ?? data.confidence ?? metadata.confidence,
    }),
  ];
  const seen = new Set<string>();
  return candidates
    .map(safeResource)
    .filter((resource): resource is ActivityResource => Boolean(resource))
    .filter(resource => {
      const key = JSON.stringify(resource);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 32);
}

function boundedMetadataCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer < 0 || integer > MAX_METADATA_COUNT ? undefined : integer;
}

function boundedMetadataExitCode(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.trunc(value);
  return integer < MIN_METADATA_EXIT_CODE || integer > MAX_METADATA_EXIT_CODE ? undefined : integer;
}

function boundedPermissionResult(value: unknown): ActivityPermissionResult | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return PERMISSION_RESULTS.has(normalized) ? normalized as ActivityPermissionResult : undefined;
}

function safeMetadata(value: unknown): Record<string, string | number | boolean> | undefined {
  const input = objectValue(value);
  const result: Record<string, string | number | boolean> = {};
  Object.entries(input).slice(0, MAX_METADATA_KEYS).forEach(([key, value]) => {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key)) return;
    if (key === 'permissionResult') {
      const permissionResult = boundedPermissionResult(value);
      if (permissionResult) result[key] = permissionResult;
      return;
    }
    if (key === 'exitCode') {
      const exitCode = boundedMetadataExitCode(value);
      if (exitCode !== undefined) result[key] = exitCode;
      return;
    }
    if (METADATA_COUNT_KEYS.has(key)) {
      const count = boundedMetadataCount(value);
      if (count !== undefined) result[key] = count;
      return;
    }
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'string' && value.trim() && !/prompt|content|result|output|argument|command/i.test(key)) {
      const redacted = /^(file|path|line|endLine|column|endColumn)$/.test(key) ? text(value) : redactedText(value);
      if (redacted) result[key] = redacted;
    }

  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeSource(value: unknown): ActivityEvent['source'] {
  if (typeof value === 'string') return text(value, 120);
  const input = objectValue(value);
  const client = input.client === 'copilot-cli' || input.client === 'copilot-app' || input.client === 'unknown'
    ? input.client
    : undefined;
  const kind = input.kind === 'hook' || input.kind === 'sdk' || input.kind === 'jsonl' || input.kind === 'sqlite' || input.kind === 'otel'
    ? input.kind
    : undefined;
  const version = text(input.version, 64);
  return client || kind || version ? { ...(client ? { client } : {}), ...(kind ? { kind } : {}), ...(version ? { version } : {}) } : undefined;
}

export function activitySourceIdentity(event: ActivityEvent): string {
  if (typeof event.source === 'string') return event.source;
  if (!event.source) return 'codewalk.local';
  return JSON.stringify([event.source.client ?? '', event.source.kind ?? '', event.source.version ?? '']);
}

const TOP_LEVEL_SESSION_TYPES = new Set([
  'session.start', 'session.started', 'session.resume', 'session.resumed',
  'session.status', 'session.updated', 'session.idle', 'session.end',
  'session.ended', 'session.shutdown', 'session.completed', 'session.failed',
  'session.stopped', 'session.error', 'session.warning',
]);

function agentEvent(event: ActivityEvent): boolean {
  return Boolean(event.agentId)
    || event.type === 'agent'
    || event.type.startsWith('agent.')
    || event.type.startsWith('subagent.')
    || topLevelSessionEvent(event)
    || Boolean((event.workspace?.id ?? event.workspace?.workspaceId) && event.sessionId && (
      event.type === 'file.read'
      || event.type === 'file.write'
      || event.type === 'search'
      || event.type === 'execute'
      || event.type === 'tool'
      || event.type.startsWith('tool.')
      || event.type === 'permission'
      || event.type.startsWith('permission.')
      || event.resources?.some(resource => resource.action)
    ));
}

function topLevelSessionEvent(event: ActivityEvent): boolean {
  if (event.agentId || !(event.workspace?.id ?? event.workspace?.workspaceId)) return false;
  if (TOP_LEVEL_SESSION_TYPES.has(event.type)) return true;
  return event.type === 'session' && [
    'started', 'resumed', 'active', 'updated', 'idle', 'completed',
    'complete', 'ended', 'failed', 'stopped', 'error', 'warning',
  ].includes(event.status ?? '');
}

/**
 * Session lifecycle envelopes use `session:<id>` as a synthetic agent ID.
 * Treat that alias and events without an agent ID as the same session marker,
 * while keeping provider agent IDs and concurrent sessions distinct.
 */
export function activityAgentId(event: ActivityEvent): string {
  return !event.agentId || event.agentId === `session:${event.sessionId}`
    ? event.sessionId
    : event.agentId;
}

export function activityAgentIdentity(event: ActivityEvent): string | undefined {
  if (!agentEvent(event)) return undefined;
  const agentId = activityAgentId(event);
  const workspaceId = event.workspace?.id ?? event.workspace?.workspaceId ?? '';
  return `agent:${encodeURIComponent(JSON.stringify([workspaceId, event.sessionId, agentId]))}`;
}

function safeAgentLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 64 || !/^[a-zA-Z0-9._:@+ -]+$/.test(normalized)) return undefined;
  return normalized;
}

export function activityAgentLabel(event: ActivityEvent, fallback?: string): string {
  const metadata = event.metadata ?? {};
  const metadataLabel = safeAgentLabel(event.agentName) ?? safeAgentLabel(metadata.agentLabel) ?? safeAgentLabel(metadata.agentName);
  const eventSessionName = sessionName(event.sessionName);
  if (eventSessionName && metadataLabel && eventSessionName !== metadataLabel) return `${eventSessionName} · ${metadataLabel}`;
  if (eventSessionName) return eventSessionName;
  if (metadataLabel) return metadataLabel;
  if (fallback) return fallback;
  const kind = topLevelSessionEvent(event) ? 'Session' : event.type.toLowerCase().includes('subagent') ? 'Subagent' : 'Agent';
  const identity = activityAgentId(event);
  const compact = identity.length > 12 ? identity.slice(-12) : identity;
  return `${kind} · ${safeAgentLabel(compact) ?? 'active'}`;
}

export function activityAgentColor(identity: string): string {
  let hash = 2166136261;
  for (const character of identity) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ACTIVITY_AGENT_COLORS[(hash >>> 0) % ACTIVITY_AGENT_COLORS.length];
}

export function activityAgentStatus(event: ActivityEvent): string {
  const permission = permissionLifecycle(event);
  if (permission === 'requested') return 'waiting';
  // A resolved permission is not a finished agent — `status:"completed"` here
  // describes the approval, so never let safeStatus() retire the agent on it.
  if (permission === 'completed') return 'active';
  return safeStatus(event.status)
    ?? (event.type.includes('waiting') ? 'waiting'
      : event.type.includes('completed') || event.type.includes('stop') || event.type.includes('end') ? 'completed'
        : event.type.includes('failed') || event.type.includes('error') ? 'failed'
          : event.type.includes('idle') ? 'idle'
            : 'active');
}

/**
 * Parse an untrusted collector envelope. Unknown provider event types are
 * retained, but envelopes without the versioned identity fields are dropped.
 */
export function parseActivityEvent(value: unknown, sseId?: string): ActivityEvent | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  const input = objectValue(parsed);
  if (input.schemaVersion !== 1) return null;
  const data = nestedObject(input.data);
  const id = text(input.id, 240);
  const sessionId = text(input.sessionId, 240);
  const timestamp = text(input.timestamp, 80);
  const type = text(input.type, 120);
  if (!id || !sessionId || !timestamp || !type || Number.isNaN(Date.parse(timestamp))) return null;
  const sequence = numberValue(input.sequence);
  const resources = providerResources(input, data);
  const normalizedType: ActivityEventType = type;
  const workspace = safeWorkspace(input.workspace ?? data.workspace);
  const parsedSessionName = sessionName(input.sessionName ?? data.sessionName);
  const parsedAgentName = sessionName(input.agentName ?? input.agentLabel ?? data.agentName ?? data.agentLabel);
  const parentId = text(input.parentId, 240) ?? text(data.parentId, 240);
  const agentId = text(input.agentId, 240) ?? text(data.agentId, 240);
  const turnId = text(input.turnId, 240) ?? text(data.turnId, 240);
  const toolCallId = text(input.toolCallId, 240) ?? text(data.toolCallId, 240);
  const tool = text(input.tool, 120) ?? text(input.toolName, 120) ?? text(data.tool, 120) ?? text(data.toolName, 120);
  const safeTool = safeToolName(tool);
  const status = text(input.status, 80) ?? text(data.status, 80);
  const event: ActivityEvent = {
    schemaVersion: 1,
    id,
    sessionId,
    ...(parsedSessionName ? { sessionName: parsedSessionName } : {}),
    ...(parsedAgentName ? { agentName: parsedAgentName } : {}),
    timestamp: new Date(timestamp).toISOString(),
    type: normalizedType,
    ...(sequence === undefined ? {} : { sequence: Math.max(0, Math.floor(sequence)) }),
    ...(parentId ? { parentId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(safeSource(input.source) ? { source: safeSource(input.source) } : {}),
    ...(status ? { status } : {}),
    ...(safeTool ? { tool: safeTool } : {}),
    ...(workspace ? { workspace } : {}),
    ...(resources.length > 0 ? { resources } : {}),
    ...(safeContent(input.content) ? { content: safeContent(input.content) } : {}),
    ...(safeMetadata(input.metadata) ? { metadata: safeMetadata(input.metadata) } : {}),
    ...(sseId ? { sseId: text(sseId, 240) } : {}),
  };
  const snippet = safeSnippet(input.snippet ?? data.snippet, event) ?? structuredSnippet(input, event);
  return snippet ? { ...event, snippet } : event;
}

export type ActivityKind = 'read' | 'write' | 'search' | 'execute' | 'session' | 'permission' | 'network' | 'error' | 'unknown';

/**
 * Permission envelopes are classified before their resources: a request to
 * edit a file is an approval prompt, not a write, and rendering it as a write
 * would claim the edit already happened.
 *
 * `network` only wins when nothing else on the event outranks it: a resource
 * carrying one of the other actions (a file read/write alongside an incidental
 * URL, say) is searched for first regardless of resource order, so a network
 * resource ordered before it can never mask the primary classification (T2-B).
 */
export function activityType(event: ActivityEvent): ActivityKind {
  if (permissionEvent(event)) return 'permission';
  const resources = event.resources ?? [];
  const primary = resources.find(resource =>
    resource.action === 'read' || resource.action === 'reference' || resource.action === 'write'
    || resource.action === 'search' || resource.action === 'execute');
  if (primary) {
    if (primary.action === 'read' || primary.action === 'reference') return 'read';
    if (primary.action === 'write') return 'write';
    if (primary.action === 'search') return 'search';
    return 'execute';
  }
  if (resources.some(resource => resource.action === 'network')) return 'network';
  if (event.type === 'file.read') return 'read';
  if (event.type === 'file.write') return 'write';
  if (event.type === 'search') return 'search';
  if (event.type === 'execute' || event.type === 'tool' || event.type.startsWith('tool.')) return 'execute';
  if (event.type.startsWith('session.') || event.type.startsWith('agent.')) return 'session';
  if (event.type === 'error' || event.type.startsWith('error.')) return 'error';
  return 'unknown';
}

function permissionEvent(event: ActivityEvent): boolean {
  return event.type === 'permission' || event.type.startsWith('permission.');
}

export type PermissionLifecycle = 'requested' | 'completed' | undefined;

/**
 * `permission.requested` opens the wait, `permission.completed` closes it
 * (docs/copilot-payloads.md §2c — there is no granted/denied event pair).
 */
export function permissionLifecycle(event: ActivityEvent): PermissionLifecycle {
  if (!permissionEvent(event)) return undefined;
  if (event.type === 'permission.requested') return 'requested';
  if (event.type === 'permission.completed') return 'completed';
  if (event.status === 'requested' || event.status === 'pending') return 'requested';
  if (event.status === 'completed' || event.status === 'complete' || activityPermissionResult(event)) return 'completed';
  return event.status === undefined ? 'requested' : undefined;
}

export function activityPermissionResult(event: ActivityEvent): ActivityPermissionResult | undefined {
  return boundedPermissionResult(event.metadata?.permissionResult);
}

export function activityPermissionDenied(event: ActivityEvent): boolean {
  return activityPermissionResult(event)?.startsWith('denied') ?? false;
}

export type ToolLifecycle = 'started' | 'completed' | 'failed' | undefined;

export function toolLifecycle(event: ActivityEvent): ToolLifecycle {
  if (event.type === 'tool.started' || event.type === 'tool.start') return 'started';
  if (event.type === 'tool.completed' || event.type === 'tool.end') return 'completed';
  if (event.type === 'tool.failed' || event.type === 'tool.error') return 'failed';
  if (event.type !== 'tool') return undefined;
  if (event.status === 'started' || event.status === 'running') return 'started';
  if (event.status === 'completed' || event.status === 'complete') return 'completed';
  if (event.status === 'failed' || event.status === 'error') return 'failed';
  return undefined;
}

function safeToolName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (/^(?:\/|[a-zA-Z]:[\\/])/.test(normalized) || normalized.includes('\\') || normalized.includes('/')) return undefined;
  return /^[a-zA-Z0-9._:-]{1,80}$/.test(normalized) ? normalized : undefined;
}

function normalizedToolName(value: string | undefined): string | undefined {
  const tool = safeToolName(value);
  return tool?.toLowerCase();
}

export function activityGroupId(event: ActivityEvent): string | undefined {
  const tool = normalizedToolName(event.tool);
  const executeLike = Boolean(tool) || activityType(event) === 'execute' || event.type.startsWith('tool.') || event.type === 'tool';
  if (!executeLike) return undefined;
  if (!tool || /^(bash|sh|shell|zsh|fish|cmd|powershell|pwsh|terminal|exec|run(?:_command)?|command)$/.test(tool)) {
    return 'group:activity:bash';
  }
  return `group:activity:tool:${encodeURIComponent(tool)}`;
}

export function activityGroupLabel(event: ActivityEvent): string {
  const id = activityGroupId(event);
  if (id === 'group:activity:bash') return 'bash commands';
  const tool = normalizedToolName(event.tool);
  return tool ? `tool · ${tool}` : 'bash commands';
}

export function activitySnippet(event: ActivityEvent): string | undefined {
  return event.snippet ? safeSnippet(event.snippet, event) : undefined;
}

function safeStatus(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().trim();
  return ['started', 'running', 'waiting', 'completed', 'complete', 'failed', 'error', 'stopped', 'active', 'idle', 'resumed'].includes(normalized)
    ? normalized
    : undefined;
}

function safeEventType(value: string): string {
  return /^[a-zA-Z0-9_.:-]{1,80}$/.test(value) ? value : 'provider event';
}

export function activitySummary(event: ActivityEvent): string {
  const kind = activityType(event);
  if (kind === 'read' || kind === 'write') {
    const resource = event.resources?.find(item => item.file || item.path);
    const file = resource?.file ?? resource?.path ?? event.workspace?.file ?? event.workspace?.path;
    const action = kind === 'read' ? 'Read' : 'Wrote';
    return file ? `${action} ${renderPath(file, event)}` : kind === 'read' ? 'File read' : 'File write';
  }
  if (kind === 'execute') {
    const snippet = activitySnippet(event);
    if (snippet) return snippet;
    const tool = safeToolName(event.tool);
    return tool ? `Tool: ${tool}` : 'Tool execution';
  }
  if (kind === 'search') {
    const tool = safeToolName(event.tool);
    return tool ? `Search: ${tool}` : 'Search';
  }
  if (kind === 'permission') {
    const tool = safeToolName(event.tool);
    if (permissionLifecycle(event) === 'completed') {
      const result = activityPermissionResult(event) ?? 'resolved';
      return tool ? `Permission ${result} · ${tool}` : `Permission ${result}`;
    }
    return tool ? `Awaiting approval · ${tool}` : 'Awaiting approval';
  }
  const status = safeStatus(event.status);
  return status ? `${safeEventType(event.type)} · ${status}` : safeEventType(event.type);
}

export function activityEventLabel(event: ActivityEvent): string {
  return safeEventType(event.type);
}
