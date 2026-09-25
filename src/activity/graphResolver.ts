import type { CodeNode, CodeGraph, LayoutGroup } from '../types';
import type { ActivityEvent, ActivityGraphIndexes, ActivityResource, ActivityTarget } from './types';

function slash(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

function absolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:\//.test(value);
}

function withinRoot(value: string, root: string): boolean {
  const path = slash(value);
  const normalizedRoot = slash(root).replace(/\/+$/, '');
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

function relativePath(value: string, root: string): string {
  const path = slash(value);
  const normalizedRoot = slash(root).replace(/\/$/, '');
  if (normalizedRoot && (path === normalizedRoot || path.startsWith(`${normalizedRoot}/`))) return path.slice(normalizedRoot.length + 1);
  return path;
}

function pathKey(value: string, root: string): string {
  return relativePath(value, root);
}

function suffixes(value: string): string[] {
  const parts = value.split('/').filter(Boolean);
  return [...new Set([
    ...parts.slice(1).map((_, index) => parts.slice(index + 1).join('/')),
    parts[parts.length - 1],
  ].filter(Boolean))];
}

function addNode(map: Map<string, CodeNode[]>, key: string, node: CodeNode) {
  if (!key) return;
  const entries = map.get(key) ?? [];
  entries.push(node);
  map.set(key, entries);
}

function workspaceIdentity(root: string): string {
  const normalized = slash(root).replace(/\/+$/, '');
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `local-${normalized.length.toString(16)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function activityWorkspaceId(root: string): string {
  return workspaceIdentity(root);
}

function graphIdentity(graph: CodeGraph, groups: LayoutGroup[]): string {
  let hash = 2166136261;
  const update = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  graph.nodes.forEach(node => update(`${node.id}\0${node.file ?? ''}\0${node.row ?? ''}\0${node.endRow ?? ''}`));
  graph.edges.forEach(edge => update(`${edge.id}\0${edge.source}\0${edge.target}`));
  groups.forEach(group => update(`${group.id}\0${group.actualNamespace ?? ''}\0${group.namespaceNodeId ?? ''}`));
  return `${slash(graph.repo.root)}\0${graph.repo.name}\0${graph.generatedAt}\0${graph.revision?.commit ?? ''}\0${graph.nodes.length}\0${graph.edges.length}\0${hash >>> 0}`;
}

function workspaceMatches(event: ActivityEvent, indexes: ActivityGraphIndexes): boolean {
  const workspace = event.workspace;
  if (!workspace) return true;
  const workspaceId = workspace.id ?? workspace.workspaceId;
  if (workspaceId && workspaceId !== indexes.workspaceId) return false;
  if (workspace.repository && workspace.repository !== indexes.repositoryName) return false;
  if (workspace.root) {
    const eventRoot = slash(workspace.root).replace(/\/+$/, '');
    if (eventRoot !== indexes.relativeRoot) return false;
  }
  return true;
}

function explicitNodeId(event: ActivityEvent): string | undefined {
  const metadata = event.metadata ?? {};
  const candidates = [
    metadata.graphNodeId,
    metadata.nodeId,
    event.resources?.find(resource => resource.nodeId)?.nodeId,
  ];
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
}

function lineRange(node: CodeNode): { start: number; end: number } | null {
  if (node.row === undefined) return null;
  return { start: node.row, end: node.endRow ?? node.row };
}

function nodeMatchesLine(node: CodeNode, line: number): boolean {
  const range = lineRange(node);
  if (!range) return false;
  return line >= range.start && line <= range.end
    || line - 1 >= range.start && line - 1 <= range.end;
}

function groupForNamespace(namespace: string | undefined, indexes: ActivityGraphIndexes): LayoutGroup | undefined {
  if (!namespace) return undefined;
  return indexes.groupsByNamespace.get(namespace) ?? indexes.groupsById.get(`group:${namespace}`);
}

export function activityWorkspaceRoot(event: ActivityEvent): string | undefined {
  const values = [event.workspace?.root, event.workspace?.path, event.workspace?.repository];
  const root = values.find(value => typeof value === 'string' && absolutePath(value));
  return root ? slash(root).replace(/\/+$/, '') : undefined;
}

function activityOutsideRoot(value: string, kind: 'file' | 'directory' = 'file'): string {
  const path = slash(value);
  const parts = path.split('/').filter(Boolean);
  if (!path || (!path.startsWith('/') && parts.length <= 1)) return 'activity';
  if (path.startsWith('/') && parts[0] === 'tmp') return '/tmp';
  const copilotIndex = parts.indexOf('.copilot');
  if (path.startsWith('/') && copilotIndex >= 0) return `/${parts.slice(0, copilotIndex + 1).join('/')}`;
  const lastIndex = Math.max(0, parts.length - (kind === 'directory' ? 0 : 1));
  const markerIndex = parts.findIndex((part, index) => index > 0 && index < lastIndex && ACTIVITY_REPOSITORY_SUBDIRECTORIES.has(part.toLowerCase()));
  const rootParts = markerIndex > 0
    ? parts.slice(0, markerIndex)
    : parts.slice(0, Math.max(1, lastIndex));
  return `${path.startsWith('/') ? '/' : ''}${rootParts.join('/')}` || 'activity';
}

const ACTIVITY_REPOSITORY_SUBDIRECTORIES = new Set([
  '.devcontainer', '.github', '.gitlab', '.vscode', 'bin', 'components',
  'config', 'docs', 'examples', 'fixtures', 'lib', 'packages', 'producer',
  'public', 'resources', 'scripts', 'src', 'test', 'tests',
]);

const ACTIVITY_WORKSPACE_CONTAINERS = new Set([
  'code', 'dev', 'development', 'git', 'github', 'projects', 'repos',
  'repositories', 'source', 'sources', 'workspace', 'workspaces',
]);

export interface ActivityPathResolution {
  root: string;
  path: string;
  outside: boolean;
}

function activityResourceKind(resource: ActivityResource): 'file' | 'directory' {
  return resource.kind?.toLowerCase().includes('dir') ? 'directory' : 'file';
}

function activityProjectRoot(path: string, workspaceRoot: string): string {
  const relative = relativePath(path, workspaceRoot);
  const parts = relative.split('/').filter(Boolean);
  if (parts.length <= 1) return workspaceRoot;
  const workspaceName = workspaceRoot.split('/').filter(Boolean).at(-1)?.toLowerCase();
  if (!workspaceName || !ACTIVITY_WORKSPACE_CONTAINERS.has(workspaceName)) return workspaceRoot;
  return ACTIVITY_REPOSITORY_SUBDIRECTORIES.has(parts[0].toLowerCase())
    ? workspaceRoot
    : `${workspaceRoot}/${parts[0]}`.replace(/\/+/g, '/');
}

export function activityPathForResource(event: ActivityEvent, resource: ActivityResource): ActivityPathResolution | undefined {
  const value = resource.file ?? resource.path;
  if (!value || typeof value !== 'string') return undefined;
  const normalized = slash(value).replace(/\/+$/, '');
  if (!normalized) return undefined;
  const workspaceRoot = activityWorkspaceRoot(event);
  const outside = Boolean(resource.outsideRoot)
    || !workspaceRoot
    || (absolutePath(normalized) && !withinRoot(normalized, workspaceRoot));
  if (outside) {
    const root = activityOutsideRoot(normalized, activityResourceKind(resource));
    const path = absolutePath(normalized) || normalized === root || normalized.startsWith(`${root}/`)
      ? normalized
      : `${root}/${normalized}`.replace(/\/+/g, '/');
    return { root, path, outside: true };
  }
  const path = absolutePath(normalized) ? normalized : `${workspaceRoot}/${normalized}`.replace(/\/+/g, '/');
  return { root: activityProjectRoot(path, workspaceRoot), path, outside: false };
}

export function activityProjectGroupId(event: ActivityEvent, root: string): string {
  return `group:activity:project:${encodeURIComponent(root)}`;
}

export function activityFileGroupId(projectId: string, path: string, kind: 'file' | 'directory'): string {
  return `${projectId}:${kind}:${encodeURIComponent(path)}`;
}

export function resourcesFor(event: ActivityEvent): ActivityResource[] {
  const metadata = event.metadata ?? {};
  const resource: ActivityResource = {
    ...(typeof metadata.file === 'string' ? { file: metadata.file } : {}),
    ...(typeof metadata.path === 'string' ? { path: metadata.path } : {}),
    ...(typeof metadata.line === 'number' ? { line: metadata.line } : {}),
    ...(typeof metadata.endLine === 'number' ? { endLine: metadata.endLine } : {}),
    ...(typeof metadata.column === 'number' ? { column: metadata.column } : {}),
    ...(typeof metadata.endColumn === 'number' ? { endColumn: metadata.endColumn } : {}),
  };
  const workspaceResource = event.workspace?.file ? [{ file: event.workspace.file }] : [];
  return Object.keys(resource).length > 0 || workspaceResource.length > 0
    ? [...(Object.keys(resource).length > 0 ? [resource] : []), ...workspaceResource, ...(event.resources ?? [])]
    : event.resources ?? [];
}

function activityTargetForResource(event: ActivityEvent, resource: ActivityResource, force = false): ActivityTarget | undefined {
  const entry = activityPathForResource(event, resource);
  if (!entry || (!force && !resource.action && !resource.kind)) return undefined;
  const projectId = activityProjectGroupId(event, entry.root);
  const workspaceId = event.workspace?.id ?? event.workspace?.workspaceId;
  if (!entry.outside && entry.path === entry.root) {
    return { kind: 'group', id: projectId, match: 'group', sourceId: projectId, workspaceId, file: resource.file ?? resource.path };
  }
  const kind = activityResourceKind(resource);
  const line = resource.line ?? resource.span?.start?.line;
  return {
    kind: 'group',
    id: activityFileGroupId(projectId, entry.path, kind),
    match: 'group',
    sourceId: projectId,
    workspaceId,
    file: resource.file ?? resource.path,
    ...(line === undefined ? {} : { line }),
  };
}

/**
 * Build all lookup tables once per graph/layout. Resolution never scans the
 * graph; event payloads must carry structured file/span data.
 */
export function buildActivityGraphIndexes(graph: CodeGraph, groups: LayoutGroup[]): ActivityGraphIndexes {
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const groupsById = new Map(groups.map(group => [group.id, group]));
  const groupsByNamespace = new Map(groups.flatMap(group => group.actualNamespace ? [[group.actualNamespace, group] as const] : []));
  const fileNodes = new Map<string, CodeNode[]>();
  const fileSuffixNodes = new Map<string, CodeNode[]>();
  const fileGroups = new Map<string, LayoutGroup[]>();
  const fileSuffixGroups = new Map<string, LayoutGroup[]>();
  const activityGroupsByPath = new Map<string, LayoutGroup[]>();
  graph.nodes.forEach(node => {
    if (!node.file) return;
    const path = pathKey(node.file, graph.repo.root);
    addNode(fileNodes, path, node);
    suffixes(path).forEach(suffix => addNode(fileSuffixNodes, suffix, node));
  });
  groups.forEach(group => {
    if (group.activity?.path) {
      const keys = new Set([slash(group.activity.path)]);
      if (group.activity.projectRoot) keys.add(relativePath(group.activity.path, group.activity.projectRoot));
      keys.forEach(key => {
        const entries = activityGroupsByPath.get(key) ?? [];
        entries.push(group);
        activityGroupsByPath.set(key, entries);
      });
    }
    if (!group.actualNamespace) return;
    const namespaceNode = group.namespaceNodeId ? nodeById.get(group.namespaceNodeId) : undefined;
    if (!namespaceNode?.file) return;
    const path = pathKey(namespaceNode.file, graph.repo.root);
    const entries = fileGroups.get(path) ?? [];
    entries.push(group);
    fileGroups.set(path, entries);
    suffixes(path).forEach(suffix => {
      const suffixEntries = fileSuffixGroups.get(suffix) ?? [];
      suffixEntries.push(group);
      fileSuffixGroups.set(suffix, suffixEntries);
    });
  });
  fileNodes.forEach(nodes => nodes.sort((left, right) => (left.row ?? 0) - (right.row ?? 0) || left.id.localeCompare(right.id)));
  fileSuffixNodes.forEach(nodes => nodes.sort((left, right) => (left.row ?? 0) - (right.row ?? 0) || left.id.localeCompare(right.id)));
  return {
    nodeById,
    groupsById,
    groupsByNamespace,
    fileNodes,
    fileSuffixNodes,
    fileGroups,
    fileSuffixGroups,
    activityGroupsByPath,
    relativeRoot: slash(graph.repo.root).replace(/\/+$/, ''),
    repositoryName: graph.repo.name,
    workspaceId: workspaceIdentity(graph.repo.root),
    identity: graphIdentity(graph, groups),
  };
}

function uniqueUnderlyingFile(nodes: CodeNode[]): CodeNode[] | undefined {
  const files = new Map<string, CodeNode[]>();
  nodes.forEach(node => {
    const key = slash(node.file ?? node.id);
    const entries = files.get(key) ?? [];
    entries.push(node);
    files.set(key, entries);
  });
  return files.size === 1 ? [...files.values()][0] : undefined;
}

function pathNodeCandidates(path: string, indexes: ActivityGraphIndexes): CodeNode[] | undefined {
  const exact = indexes.fileNodes.get(path);
  if (exact) return exact;
  for (const suffix of suffixes(path)) {
    const unique = uniqueUnderlyingFile(indexes.fileSuffixNodes.get(suffix) ?? []);
    if (unique) return unique;
  }
  return undefined;
}

function pathGroupCandidates(path: string, indexes: ActivityGraphIndexes): LayoutGroup[] | undefined {
  const exact = indexes.fileGroups.get(path);
  if (exact) return exact;
  for (const suffix of suffixes(path)) {
    const groups = indexes.fileSuffixGroups.get(suffix) ?? [];
    const unique = new Map(groups.map(group => [group.id, group]));
    if (unique.size === 1) return [...unique.values()];
  }
  return undefined;
}

/** Fan-out cap for one event's resolved targets (roadmap §6: 32 targets/event). */
export const MAX_ACTIVITY_TARGETS = 32;

const FAMILY_RESOURCE_LABELS: Record<string, string> = { tests: 'Tests', git: 'Git', build: 'Build' };

/**
 * Resources with no path — `url` and the command families — route to a fixed
 * toolbox group instead of the code graph. Group-id scheme is shared with the
 * layout agent (T2-C): per-host `group:activity:web:<host>`, families
 * `group:activity:tool:tests|git|build`.
 */
function externalActivityTarget(resource: ActivityResource): ActivityTarget | undefined {
  if (resource.kind === 'url') {
    if (!resource.name) return undefined;
    return { kind: 'group', id: `group:activity:web:${resource.name}`, match: 'external', label: resource.name };
  }
  const label = resource.kind ? FAMILY_RESOURCE_LABELS[resource.kind] : undefined;
  if (!label) return undefined;
  return { kind: 'group', id: `group:activity:tool:${resource.kind}`, match: 'external', label };
}

/**
 * Resolve every target an event's resources map to, in resource order,
 * deduped by `kind:id` and capped at `MAX_ACTIVITY_TARGETS`. An explicit node
 * id (metadata or a resource's `nodeId`) still short-circuits to a single
 * node target exactly as before — it names one graph node directly, not a
 * set of resources to fan out over.
 *
 * Path-shaped resources reuse the original node → file → directory → project
 * cascade unchanged, one target per resource. `url`/family resources resolve
 * via `externalActivityTarget` instead of the path cascade.
 */
export function resolveActivityTargets(event: ActivityEvent, indexes: ActivityGraphIndexes): ActivityTarget[] {
  const matchesWorkspace = workspaceMatches(event, indexes);
  const activityOnly = indexes.nodeById.size === 0;
  const nodeId = explicitNodeId(event);
  const explicitNode = matchesWorkspace && nodeId ? indexes.nodeById.get(nodeId) : undefined;
  if (explicitNode) {
    return [{ kind: 'node', id: explicitNode.id, match: 'node', sourceId: indexes.identity, workspaceId: indexes.workspaceId, ...(explicitNode.file ? { file: explicitNode.file } : {}) }];
  }

  const targets: ActivityTarget[] = [];
  const seen = new Set<string>();
  const push = (target: ActivityTarget | undefined): void => {
    if (!target || targets.length >= MAX_ACTIVITY_TARGETS) return;
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  for (const resource of resourcesFor(event)) {
    if (targets.length >= MAX_ACTIVITY_TARGETS) break;

    const external = externalActivityTarget(resource);
    if (external) { push(external); continue; }

    const path = resource.file ?? resource.path;
    if (!path) continue;
    if (!matchesWorkspace) {
      push(activityTargetForResource(event, resource, activityOnly || Boolean(resource.action)));
      continue;
    }
    if (resource.outsideRoot) {
      push(activityTargetForResource(event, resource, activityOnly || Boolean(resource.action)));
      continue;
    }
    if (absolutePath(slash(path)) && !withinRoot(path, indexes.relativeRoot)) {
      if (activityOnly) push(activityTargetForResource(event, resource, true));
      continue;
    }
    const normalizedPath = pathKey(path, indexes.relativeRoot);
    const fileNodes = pathNodeCandidates(normalizedPath, indexes);
    if (!fileNodes) {
      push(activityTargetForResource(event, resource, activityOnly || Boolean(resource.action)));
      continue;
    }
    const line = resource.line ?? resource.span?.start?.line;
    const lineNodes = line === undefined ? [] : fileNodes.filter(node => nodeMatchesLine(node, line));
    const node = lineNodes.sort((left, right) => {
      const leftSpan = (left.endRow ?? left.row ?? 0) - (left.row ?? 0);
      const rightSpan = (right.endRow ?? right.row ?? 0) - (right.row ?? 0);
      return leftSpan - rightSpan || left.id.localeCompare(right.id);
    })[0];
    if (node) { push({ kind: 'node', id: node.id, match: 'span', sourceId: indexes.identity, workspaceId: indexes.workspaceId, file: path, ...(line === undefined ? {} : { line }) }); continue; }
    if (line === undefined) {
      const namespaceNode = fileNodes.find(candidate => candidate.kind === 'namespace');
      if (namespaceNode) { push({ kind: 'node', id: namespaceNode.id, match: 'file', sourceId: indexes.identity, workspaceId: indexes.workspaceId, file: path }); continue; }
    }
    const namespace = fileNodes.find(candidate => candidate.namespace)?.namespace;
    const group = pathGroupCandidates(normalizedPath, indexes)?.[0] ?? groupForNamespace(namespace, indexes);
    if (group) { push({ kind: 'group', id: group.id, match: 'group', sourceId: indexes.identity, workspaceId: indexes.workspaceId, file: path, ...(line === undefined ? {} : { line }) }); continue; }
    push(activityTargetForResource(event, resource, activityOnly || Boolean(resource.action)));
  }
  return targets;
}

export function resolveActivityTarget(event: ActivityEvent, indexes: ActivityGraphIndexes): ActivityTarget | undefined {
  return resolveActivityTargets(event, indexes)[0];
}
