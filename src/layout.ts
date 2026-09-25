import { isGlobalNode } from './namespaceVisibility';
import type { CodeGraph, CodeNode, GlobalNamespaceLayoutMode, LayoutBounds, LayoutGroup, LayoutResult, ActivityAgentLayout } from './types';
import { activityGroupId, activityGroupLabel, activitySnippet } from './activity/contract';
import { activityFileGroupId, activityPathForResource, activityProjectGroupId, activityWorkspaceRoot, resourcesFor } from './activity/graphResolver';
import type { ActivityAgentNode, ActivityEvent, ActivityGroupSpec, ActivityRay, ActivityResource } from './activity/types';

type Point = [number, number, number];

// Math.max(...array)/Math.min(...array) spread a very wide array into call
// arguments and can throw "RangeError: Maximum call stack size exceeded" once
// the array is large (hierarchy arrays are unbounded in principle). These
// loop instead, matching Math.max()/Math.min()'s -Infinity/Infinity identity
// for an empty array.
function maxOf(values: readonly number[]): number {
  let result = -Infinity;
  for (const value of values) if (value > result) result = value;
  return result;
}

function minOf(values: readonly number[]): number {
  let result = Infinity;
  for (const value of values) if (value < result) result = value;
  return result;
}

interface Bounds {
  center: Point;
  size: Point;
}

interface NamespaceTreeNode {
  path: string;
  label: string;
  children: Map<string, NamespaceTreeNode>;
  actualNamespace?: string;
  directNodeCount: number;
  subtreeNodeCount: number;
}

const ROOT_BOUNDS: Bounds = {
  center: [0, 0, 0],
  size: [180, 150, 180],
};

// Same per-kind clearance idiom orbitPositions() uses to keep global nodes
// from touching: namespace nodes read as visually larger than vars, which
// read as larger than everything else, all scaled by the caller's nodeScale.
function nodeClearance(kind: CodeNode['kind'], nodeScale: number): number {
  return (kind === 'namespace' ? 1.4 : kind === 'var' ? 0.9 : 0.7) * nodeScale + 1.8;
}

const VOLUME_POINT_INSET = 0.88;

// A single candidate position within a namespace/global bucket's box: which
// density-sized grid cell `index` falls in, jittered by `amplitude` around
// that cell's center. `amplitude` is a fraction of one cell (0 = dead
// center, close to 1 = nearly the full cell) rather than a fixed absolute
// wobble, so a caller doing rejection sampling (see volumePositions below)
// can widen the search when the default small wobble isn't enough room to
// clear a neighboring node, without changing the grid itself.
function volumePoint(center: Point, size: Point, index: number, total: number, jitterSeed = 0, amplitude = 0.22): Point {
  const count = Math.max(1, total);
  const volume = Math.max(1, size[0] * size[1] * size[2]);
  const density = Math.cbrt(count / volume);
  const dimensions: [number, number, number] = [
    Math.max(1, Math.ceil(size[0] * density)),
    Math.max(1, Math.ceil(size[1] * density)),
    Math.max(1, Math.ceil(size[2] * density)),
  ];
  const [xCount, yCount, zCount] = dimensions;
  const xIndex = index % xCount;
  const yIndex = Math.floor(index / xCount) % yCount;
  const zIndex = Math.floor(index / (xCount * yCount)) % zCount;
  const jitter = (seed: number) => ((Math.sin(seed * 12.9898) * 43758.5453 % 1 + 1) % 1 - 0.5) * amplitude;
  const x = (xIndex + 0.5 + jitter(index + 1 + jitterSeed)) / xCount - 0.5;
  const y = (yIndex + 0.5 + jitter(index + 11 + jitterSeed)) / yCount - 0.5;
  const z = (zIndex + 0.5 + jitter(index + 29 + jitterSeed)) / zCount - 0.5;
  return [
    center[0] + x * size[0] * VOLUME_POINT_INSET,
    center[1] + y * size[1] * VOLUME_POINT_INSET,
    center[2] + z * size[2] * VOLUME_POINT_INSET,
  ];
}

// Places every node of a namespace/global bucket inside its box. The
// count/volume grid volumePoint() builds targets one node per unit of
// space on average, with no regard for how big a node actually renders
// (its half-extent grows with nodeScale/kind, same as orbitPositions'
// clearance below) -- so a crowded or deeply-nested namespace box packed
// nodes shoulder to shoulder regardless of how large they were drawn,
// worse the bigger nodeScale got. Each node keeps its density-assigned
// cell (so the overall spread across the box is unchanged) but, exactly
// like orbitPositions does for the global shell, widens its jitter search
// within that cell across a few attempts until it clears every
// already-placed sibling by both nodes' clearance, instead of committing
// to the first (narrow, ~10% of a cell) wobble regardless of who else
// ended up next door.
function volumePositions(nodes: CodeNode[], center: Point, size: Point, nodeScale: number): Map<string, Point> {
  const positions = new Map<string, Point>();
  const placed: Array<{ point: Point; clearance: number }> = [];
  const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  const total = ordered.length;
  const clears = (point: Point, clearance: number) => placed.every(previous => Math.hypot(
    point[0] - previous.point[0],
    point[1] - previous.point[1],
    point[2] - previous.point[2],
  ) >= clearance + previous.clearance);
  ordered.forEach((node, index) => {
    const clearance = nodeClearance(node.kind, nodeScale);
    let point = volumePoint(center, size, index, total);
    if (!clears(point, clearance)) {
      for (let attempt = 1; attempt < 24; attempt += 1) {
        // Widen toward the cell's full span across attempts (capped just
        // under 1 so a candidate can't land exactly on a cell boundary,
        // which volumePoint's modulo cell assignment already treats as
        // belonging to the neighboring cell).
        const amplitude = Math.min(0.96, 0.22 + attempt * 0.06);
        const candidate = volumePoint(center, size, index, total, attempt * 97, amplitude);
        if (clears(candidate, clearance)) {
          point = candidate;
          break;
        }
        point = candidate;
      }
    }
    positions.set(node.id, point);
    placed.push({ point, clearance });
  });
  return positions;
}

function namespaceGroupId(path: string) {
  return 'group:' + path;
}

function addTreePath(root: NamespaceTreeNode, namespace: string, hasAnchor = false): NamespaceTreeNode {
  let current = root;
  const parts = namespace.split('.');
  parts.forEach((part, index) => {
    const path = parts.slice(0, index + 1).join('.');
    let child = current.children.get(part);
    if (!child) {
      child = { path, label: part, children: new Map(), directNodeCount: 0, subtreeNodeCount: 0 };
      current.children.set(part, child);
    }
    current = child;
  });
  if (hasAnchor) current.actualNamespace = namespace;
  return current;
}

function calculateSubtreeWeight(node: NamespaceTreeNode): number {
  const descendantCount = [...node.children.values()].reduce((total, child) => total + calculateSubtreeWeight(child), 0);
  node.subtreeNodeCount = Math.max(1, node.directNodeCount + descendantCount);
  return node.subtreeNodeCount;
}

function balancedSplit(children: NamespaceTreeNode[]): [NamespaceTreeNode[], NamespaceTreeNode[]] {
  const partitions: [NamespaceTreeNode[], NamespaceTreeNode[]] = [[], []];
  const weights = [0, 0];
  [...children]
    .sort((left, right) => right.subtreeNodeCount - left.subtreeNodeCount || left.path.localeCompare(right.path))
    .forEach(child => {
      const partition = weights[0] <= weights[1] ? 0 : 1;
      partitions[partition].push(child);
      weights[partition] += child.subtreeNodeCount;
    });
  partitions.forEach(partition => partition.sort((left, right) => left.path.localeCompare(right.path)));
  return partitions;
}

function largestAxis(size: Point): number {
  if (size[1] >= size[0] && size[1] >= size[2]) return 1;
  if (size[2] >= size[0] && size[2] >= size[1]) return 2;
  return 0;
}

function splitBounds(parent: Bounds, leftChildren: NamespaceTreeNode[], rightChildren: NamespaceTreeNode[]): [Bounds, Bounds] {
  const axis = largestAxis(parent.size);
  const leftWeight = leftChildren.reduce((total, child) => total + child.subtreeNodeCount, 0);
  const rightWeight = rightChildren.reduce((total, child) => total + child.subtreeNodeCount, 0);
  const totalWeight = Math.max(1, leftWeight + rightWeight);
  const gap = Math.min(2.8, Math.max(0.7, parent.size[axis] * 0.035));
  const available = Math.max(1.4, parent.size[axis] - gap);
  const leftLength = available * (leftWeight / totalWeight);
  const rightLength = available - leftLength;
  const start = parent.center[axis] - parent.size[axis] / 2;
  const leftCenter = start + leftLength / 2;
  const rightCenter = start + leftLength + gap + rightLength / 2;
  const makeRegion = (centerAxis: number, rawAxisLength: number): Bounds => {
    const center: Point = [...parent.center];
    const size: Point = [
      Math.max(1.2, parent.size[0] * 0.88),
      Math.max(1.2, parent.size[1] * 0.88),
      Math.max(1.2, parent.size[2] * 0.88),
    ];
    center[axis] = centerAxis;
    size[axis] = Math.max(1.2, rawAxisLength * 0.88);
    return { center, size };
  };
  return [makeRegion(leftCenter, leftLength), makeRegion(rightCenter, rightLength)];
}

function weightedRegions(children: NamespaceTreeNode[], bounds: Bounds): Map<string, Bounds> {
  if (children.length === 0) return new Map();
  if (children.length === 1) {
    const size = bounds.size.map(axis => Math.max(1.2, axis * 0.88)) as Point;
    const center: Point = [
      bounds.center[0],
      bounds.center[1] - (bounds.size[1] - size[1]) * 0.3,
      bounds.center[2],
    ];
    return new Map([[children[0].path, { center, size }]]);
  }
  const [leftChildren, rightChildren] = balancedSplit(children);
  const [leftBounds, rightBounds] = splitBounds(bounds, leftChildren, rightChildren);
  return new Map([
    ...weightedRegions(leftChildren, leftBounds),
    ...weightedRegions(rightChildren, rightBounds),
  ]);
}

function stabilizedCenter(next: Point, previous: Point, previousSize: Point): Point {
  const maxShift = Math.max(2.5, Math.min(9, maxOf(previousSize) * 0.14));
  return next.map((value, axis) => {
    const delta = value - previous[axis];
    return previous[axis] + Math.max(-maxShift, Math.min(maxShift, delta));
  }) as Point;
}

function stabilizeGroups(groups: LayoutGroup[], previousLayout?: LayoutResult): LayoutGroup[] {
  if (!previousLayout) return groups;
  const previousById = new Map(previousLayout.groups.map(group => [group.id, group]));
  return groups.map(group => {
    const previous = previousById.get(group.id);
    return previous ? { ...group, center: stabilizedCenter(group.center, previous.center, previous.size) } : group;
  });
}

export interface LayoutOptions {
  globalNamespaceMode?: GlobalNamespaceLayoutMode;
  nodeScale?: number;
  showGlobalNamespace?: boolean;
}

export const ACTIVITY_AGENT_GLYPH_SCALE = 3;
export const ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
const ACTIVITY_AGENT_RING_SPACING = 10.8;
const ACTIVITY_AGENT_RING_MIN_RADIUS = 21;
const ACTIVITY_AGENT_RING_Y_OFFSET = 64;
const ACTIVITY_AGENT_INACTIVE_GRID_Y_OFFSET = 73.5;
const ACTIVITY_AGENT_GRID_COLUMN_SPACING = 14.4;
const ACTIVITY_AGENT_GRID_ROW_SPACING = 12;
const ACTIVITY_AGENT_PHASE_DAMPING = 0.025;
const ACTIVITY_AGENT_PHASE_MAX_STEP = 0.03;
const ACTIVITY_MAX_PROJECT_EXTENT = 108;

export const ACTIVITY_GROUP_RETENTION_MS = 10 * 60 * 1000;
export const ACTIVITY_GROUP_FADE_MS = 60 * 1000;
export const ACTIVITY_GROUP_TTL_MS = ACTIVITY_GROUP_RETENTION_MS + ACTIVITY_GROUP_FADE_MS;

function activityEventTime(event: ActivityEvent, now: number): number {
  const timestamp = Date.parse(event.timestamp);
  return Number.isNaN(timestamp) ? now : timestamp;
}

function activityProjectLabel(event: ActivityEvent, root: string): string {
  const workspaceRoot = activityWorkspaceRoot(event);
  const repository = !workspaceRoot || workspaceRoot === root
    ? event.workspace?.repository?.trim()
    : undefined;
  const candidate = repository
    && !repository.startsWith('/')
    && !/^[a-zA-Z]:[\\/]/.test(repository)
    ? repository.split(/[\\/]/).filter(Boolean).at(-1)
    : root.split('/').filter(Boolean).at(-1);
  const safe = candidate?.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return safe || 'activity repository';
}

function activityProjectLabelSuffix(root: string): string {
  const parts = root.split('/').filter(Boolean);
  const parent = parts.length > 1 ? parts[parts.length - 2] : undefined;
  const safe = parent?.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return safe || 'activity root';
}

function activityResourceKind(resource: ActivityResource): 'file' | 'directory' {
  return resource.kind?.toLowerCase().includes('dir') ? 'directory' : 'file';
}

// T2-C web root / per-domain groups. Group-id scheme is a cross-agent
// contract with the resolver (see docs/roadmap.md §3 T2-B): the web root is
// `group:activity:web`, each host is `group:activity:web:<host>` parented to
// it. Hosts are validated defensively even though the producer contract
// already constrains `name`.
const ACTIVITY_WEB_ROOT_ID = 'group:activity:web';
const ACTIVITY_HOST_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/;

function activityHostName(name: string | undefined): string | undefined {
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const lowered = name.toLowerCase();
  return ACTIVITY_HOST_PATTERN.test(lowered) ? lowered : undefined;
}

// Family toolbox groups for non-path command resources. Same id/label
// scheme as other `group:activity:tool:*` entries so they fall into the
// existing toolbox placement branch with no further changes.
const ACTIVITY_RESOURCE_FAMILY_GROUPS: Record<string, { id: string; label: string }> = {
  tests: { id: 'group:activity:tool:tests', label: 'Tests' },
  git: { id: 'group:activity:tool:git', label: 'Git' },
  build: { id: 'group:activity:tool:build', label: 'Build' },
};

// T2-D remainder: a bounded pass/fail read straight off the raw event's own
// metadata -- status/exitCode/errorClassification are exactly the fields the
// producer already sets (docs/roadmap.md §4's T2-D correction); this does not
// read the reducer's own derived ActivityToolOutcome (src/activity/reducer.ts
// is off limits while another brief edits it -- and activityGroupSpecs only
// ever receives raw events anyway). Priority: errorClassification (an
// explicit failure marker) beats exitCode (a reliable numeric signal) beats
// the raw status string, whose non-failure values aren't pinned by any file
// this brief may read, so an event that sets more than one never gets a
// contradictory answer. Returns undefined -- "this event has no opinion" --
// for the common case (most events carry no outcome at all), which update()
// below carries the previous known outcome through instead of blanking it.
function activityEventOutcome(event: ActivityEvent): ActivityGroupSpec['lastOutcome'] {
  const metadata = event.metadata;
  if (!metadata) return undefined;
  if (typeof metadata.errorClassification === 'string' && metadata.errorClassification) return 'failed';
  if (typeof metadata.exitCode === 'number') return metadata.exitCode === 0 ? 'completed' : 'failed';
  const status = typeof metadata.status === 'string' ? metadata.status.toLowerCase() : undefined;
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'completed' || status === 'success' || status === 'ok') return 'completed';
  return undefined;
}

// `weight` is an internal accumulator, not part of the public
// ActivityGroupSpec contract (./activity/types). It carries a per-domain
// hit count from activityGroupSpecs into withActivityGroups' leaf packing so
// a host hit repeatedly renders visibly larger than one hit once. It sums
// across repeated `update()` calls for the same id and is a no-op (stays
// unset/0) for every spec kind that never sets it.
interface ActivityGroupSpecWeighted extends ActivityGroupSpec {
  weight?: number;
}

export function activityGroupSpecs(events: ActivityEvent[], now = Date.now()): ActivityGroupSpec[] {
  const specs = new Map<string, ActivityGroupSpecWeighted>();
  const update = (spec: ActivityGroupSpecWeighted) => {
    const previous = specs.get(spec.id);
    specs.set(spec.id, {
      ...spec,
      ...(previous?.label ? { label: previous.label } : {}),
      lastActivityAt: Math.max(previous?.lastActivityAt ?? 0, spec.lastActivityAt),
      expiresAt: Math.max(previous?.expiresAt ?? 0, spec.expiresAt),
      weight: (previous?.weight ?? 0) + (spec.weight ?? 0),
      // Same carry-forward idiom as `weight` above: most calls for an id that
      // already has a known outcome don't report a new one (e.g. a tool.start
      // sharing this id's resources has nothing to say about pass/fail yet),
      // and should not blank out the last one this function did learn.
      lastOutcome: spec.lastOutcome ?? previous?.lastOutcome,
    });
  };
  events.forEach(event => {
    const lastActivityAt = activityEventTime(event, now);
    if (now - lastActivityAt > ACTIVITY_GROUP_TTL_MS) return;
    const outcome = activityEventOutcome(event);
    const id = activityGroupId(event);
    if (id) {
      const kind = id === 'group:activity:bash' ? 'bash' : 'tool';
      const tool = kind === 'tool' && event.tool ? event.tool.toLowerCase() : undefined;
      update({
        id,
        label: activityGroupLabel(event),
        kind,
        ...(tool ? { tool } : {}),
        lastActivityAt,
        expiresAt: lastActivityAt + ACTIVITY_GROUP_TTL_MS,
      });
    }

    const workspaceRoot = activityWorkspaceRoot(event);
    const resources = resourcesFor(event);
    const entries = resources.length
      ? resources.map(resource => ({ resource, entry: activityPathForResource(event, resource) }))
        .filter((item): item is { resource: ActivityResource; entry: NonNullable<ReturnType<typeof activityPathForResource>> } => Boolean(item.entry))
      : workspaceRoot
        ? [{ resource: {}, entry: { root: workspaceRoot, path: workspaceRoot, outside: false } }]
        : [];
    const projects = new Map<string, { root: string; identity: string; outside: boolean; entries: Array<{ path: string; resource: ActivityResource }> }>();
    entries.forEach(({ resource, entry }) => {
      const identity = entry.root;
      const project = projects.get(identity) ?? { identity, root: entry.root, outside: entry.outside, entries: [] };
      project.entries.push({ path: entry.path, resource });
      projects.set(identity, project);
    });
    projects.forEach(entry => {
      const projectId = activityProjectGroupId(event, entry.root);
      update({
        id: projectId,
        label: activityProjectLabel(event, entry.root),
        kind: 'project',
        projectId: entry.identity,
        projectRoot: entry.root,
        lastActivityAt,
        expiresAt: lastActivityAt + ACTIVITY_GROUP_TTL_MS,
      });
      entry.entries
        .sort((left, right) => left.path.localeCompare(right.path))
        .forEach(resourceEntry => {
          if (resourceEntry.path === entry.root && !entry.outside) return;
          const relative = resourceEntry.path === entry.root
            ? ''
            : resourceEntry.path.slice(entry.root.length).replace(/^\/+/, '');
          const parts = relative.split('/').filter(Boolean);
          let parentId = projectId;
          parts.forEach((part, index) => {
            const kind = index === parts.length - 1 ? activityResourceKind(resourceEntry.resource) : 'directory';
            const path = `${entry.root}/${parts.slice(0, index + 1).join('/')}`.replace(/\/+/g, '/');
            const groupId = activityFileGroupId(projectId, path, kind);
            update({
              id: groupId,
              parentId,
              label: part,
              kind,
              projectId: entry.identity,
              projectRoot: entry.root,
              path,
              lastActivityAt,
              expiresAt: lastActivityAt + ACTIVITY_GROUP_TTL_MS,
            });
            parentId = groupId;
          });
        });
    });

    const webHits = new Map<string, number>();
    resources.forEach(resource => {
      if (resource.kind !== 'url') return;
      const host = activityHostName(resource.name);
      if (host) webHits.set(host, (webHits.get(host) ?? 0) + 1);
    });
    if (webHits.size > 0) {
      update({
        id: ACTIVITY_WEB_ROOT_ID,
        label: 'Web',
        kind: 'web',
        lastActivityAt,
        expiresAt: lastActivityAt + ACTIVITY_GROUP_TTL_MS,
      });
      webHits.forEach((hits, host) => {
        update({
          id: `${ACTIVITY_WEB_ROOT_ID}:${host}`,
          parentId: ACTIVITY_WEB_ROOT_ID,
          label: host,
          kind: 'domain',
          lastActivityAt,
          expiresAt: lastActivityAt + ACTIVITY_GROUP_TTL_MS,
          weight: hits,
          ...(outcome ? { lastOutcome: outcome } : {}),
        });
      });
    }

    resources.forEach(resource => {
      const family = resource.kind ? ACTIVITY_RESOURCE_FAMILY_GROUPS[resource.kind] : undefined;
      if (!family) return;
      update({
        id: family.id,
        label: family.label,
        kind: 'tool',
        lastActivityAt,
        expiresAt: lastActivityAt + ACTIVITY_GROUP_TTL_MS,
        ...(outcome ? { lastOutcome: outcome } : {}),
      });
    });
  });
  const result = [...specs.values()].sort((left, right) => left.id.localeCompare(right.id));
  const projectLabels = new Map<string, ActivityGroupSpec[]>();
  result.filter(spec => spec.kind === 'project').forEach(spec => {
    const entries = projectLabels.get(spec.label) ?? [];
    entries.push(spec);
    projectLabels.set(spec.label, entries);
  });
  const usedLabels = new Set<string>();
  return result.map(spec => {
    const duplicates = projectLabels.get(spec.label);
    if (spec.kind !== 'project' || !duplicates || duplicates.length === 1) return spec;
    const duplicateIndex = duplicates.indexOf(spec);
    const base = `${spec.label} - ${activityProjectLabelSuffix(spec.projectRoot ?? '')}`;
    const label = usedLabels.has(base) ? `${base} #${duplicateIndex + 1}` : base;
    usedLabels.add(label);
    return { ...spec, label };
  });
}

// A cheap fingerprint of exactly what withActivityGroups/withActivityAgentNodes
// pack: the live group specs (derived from `events`, already threshold-filtered
// by `activityGroupSpecs`) and the live agents' active/inactive partition.
// `now` never appears in the output directly, only via the liveness/threshold
// decisions it drives, so the string is stable across ticks where nothing
// actually crossed a threshold and callers can memoize the expensive packing
// on this value instead of on `now` itself.
export function activityLayoutSignature(events: ActivityEvent[], agents: ActivityAgentNode[], now: number): string {
  const groupSignature = activityGroupSpecs(events, now).map(spec => [
    spec.id,
    spec.parentId ?? null,
    spec.label,
    spec.kind,
    spec.tool ?? null,
    spec.lastActivityAt,
  ]);
  const uniqueAgents = new Map<string, ActivityAgentNode>();
  agents.forEach(agent => {
    const previous = uniqueAgents.get(agent.id);
    if (!previous || agent.updatedAt >= previous.updatedAt) uniqueAgents.set(agent.id, agent);
  });
  const agentSignature = [...uniqueAgents.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(agent => [
      agent.id,
      agent.parentId ?? null,
      agent.label,
      agent.updatedAt,
      now - agent.updatedAt >= ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS,
    ]);
  return JSON.stringify([groupSignature, agentSignature]);
}

type ActivitySlot = [number, number];

interface ActivityGridPacking {
  size: [number, number];
  offsets: Map<string, [number, number]>;
}

interface ActivityTreePacking {
  size: Point;
  slots: Map<string, ActivitySlot>;
  offsets: Map<string, [number, number]>;
}

function slotKey(slot: ActivitySlot): string {
  return `${slot[0]}:${slot[1]}`;
}

interface ActivityPriority {
  lastActivityAt: number;
  subtreeWeight: number;
}

function compareActivityPriority(left: ActivityPriority, right: ActivityPriority): number {
  return right.lastActivityAt - left.lastActivityAt
    || right.subtreeWeight - left.subtreeWeight;
}

function compareActivitySlots(left: ActivitySlot, right: ActivitySlot): number {
  const leftDistance = left[0] ** 2 + left[1] ** 2;
  const rightDistance = right[0] ** 2 + right[1] ** 2;
  return leftDistance - rightDistance
    || Math.abs(left[1]) - Math.abs(right[1])
    || left[1] - right[1]
    || left[0] - right[0];
}

function centralActivitySlots(count: number, occupied = new Set<string>()): ActivitySlot[] {
  const candidates: ActivitySlot[] = [];
  for (let radius = 0; candidates.length < count; radius += 1) {
    const ring: ActivitySlot[] = [];
    for (let x = -radius; x <= radius; x += 1) {
      for (let z = -radius; z <= radius; z += 1) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== radius) continue;
        ring.push([x, z]);
      }
    }
    ring.sort(compareActivitySlots).forEach(slot => {
      if (!occupied.has(slotKey(slot))) candidates.push(slot);
    });
  }
  return candidates.slice(0, count);
}

function activityPackedSlots(
  ids: string[],
  previousById: Map<string, LayoutGroup>,
  priorities: Map<string, ActivityPriority>,
): Map<string, ActivitySlot> {
  const slots = new Map<string, ActivitySlot>();
  const occupied = new Set<string>();
  const byPriority = (left: string, right: string) =>
    compareActivityPriority(
      priorities.get(left) ?? { lastActivityAt: 0, subtreeWeight: 1 },
      priorities.get(right) ?? { lastActivityAt: 0, subtreeWeight: 1 },
    ) || left.localeCompare(right);
  [...ids].sort(byPriority).forEach(id => {
    const previous = previousById.get(id)?.activitySlot;
    if (!previous || !previous.every(Number.isFinite) || occupied.has(slotKey(previous))) return;
    const slot: ActivitySlot = [previous[0], previous[1]];
    slots.set(id, slot);
    occupied.add(slotKey(slot));
  });

  const pending = ids.filter(id => !slots.has(id)).sort(byPriority);
  if (slots.size === 0) {
    centralActivitySlots(pending.length).forEach((slot, index) => {
      slots.set(pending[index], slot);
      occupied.add(slotKey(slot));
    });
    return slots;
  }

  centralActivitySlots(pending.length, occupied).forEach((slot, index) => {
    slots.set(pending[index], slot);
    occupied.add(slotKey(slot));
  });

  const idsBySlot = new Map([...slots].map(([id, slot]) => [slotKey(slot), id]));
  const rankedSlots = [...slots.values()].sort(compareActivitySlots);
  const changedIds = ids
    .filter(id => {
      const previous = previousById.get(id);
      return !previous || (priorities.get(id)?.lastActivityAt ?? 0) > (previous.activity?.lastActivityAt ?? 0);
    })
    .sort(byPriority);
  changedIds.forEach(id => {
    const currentSlot = slots.get(id);
    if (!currentSlot) return;
    const desiredRank = [...ids].sort(byPriority).indexOf(id);
    const desiredSlot = rankedSlots[desiredRank];
    const occupantId = desiredSlot ? idsBySlot.get(slotKey(desiredSlot)) : undefined;
    if (!desiredSlot || !occupantId || occupantId === id
      || compareActivitySlots(desiredSlot, currentSlot) >= 0
      || compareActivityPriority(
        priorities.get(id) ?? { lastActivityAt: 0, subtreeWeight: 1 },
        priorities.get(occupantId) ?? { lastActivityAt: 0, subtreeWeight: 1 },
      ) >= 0) return;
    slots.set(id, desiredSlot);
    slots.set(occupantId, currentSlot);
    idsBySlot.set(slotKey(desiredSlot), id);
    idsBySlot.set(slotKey(currentSlot), occupantId);
  });
  return slots;
}

const PROJECT_EQUATOR_BASE_CAPACITY = 4;
const PROJECT_SHELL_BASE_CAPACITY = 12;
const PROJECT_VERTICAL_STRETCH = 1.65;

function projectShellCapacity(shell: number): number {
  return PROJECT_SHELL_BASE_CAPACITY * (shell + 1) ** 2;
}

function spreadCircleOrder(capacity: number): number[] {
  const selected: number[] = [];
  while (selected.length < capacity) {
    let bestSector = 0;
    let bestDistance = -1;
    for (let sector = 0; sector < capacity; sector += 1) {
      if (selected.includes(sector)) continue;
      const distance = selected.length === 0
        ? 0
        : minOf(selected.map(existing => {
          const difference = Math.abs(sector - existing);
          return Math.min(difference, capacity - difference);
        }));
      if (distance > bestDistance) {
        bestSector = sector;
        bestDistance = distance;
      }
    }
    selected.push(bestSector);
  }
  return selected;
}

function projectShellDirections(shell: number): Point[] {
  const capacity = projectShellCapacity(shell);
  const equatorCapacity = PROJECT_EQUATOR_BASE_CAPACITY * (shell + 1);
  const equator = spreadCircleOrder(equatorCapacity).map(sector => {
    const angle = -Math.PI / 2 + (sector / equatorCapacity) * Math.PI * 2;
    return [Math.cos(angle), 0, Math.sin(angle)] as Point;
  });
  const poolSize = Math.max(96, capacity * 8);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const pool: Point[] = Array.from({ length: poolSize }, (_, index) => {
    const y = 1 - (2 * (index + 0.5)) / poolSize;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = index * goldenAngle;
    return [Math.cos(angle) * radius, y, Math.sin(angle) * radius] as Point;
  });
  const selected: Point[] = [...equator];
  const remaining = [...pool];
  while (selected.length < capacity && remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = -1;
    remaining.forEach((candidate, index) => {
      const distance = minOf(selected.map(existing => Math.hypot(
        candidate[0] - existing[0],
        candidate[1] - existing[1],
        candidate[2] - existing[2],
      )));
      if (distance > bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    });
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function projectShellSlots(
  ids: string[],
  previousById: Map<string, LayoutGroup>,
  priorities: Map<string, ActivityPriority>,
): Map<string, ActivitySlot> {
  const slots = new Map<string, ActivitySlot>();
  const occupied = new Set<string>();
  const byPriority = (left: string, right: string) =>
    compareActivityPriority(
      priorities.get(left) ?? { lastActivityAt: 0, subtreeWeight: 1 },
      priorities.get(right) ?? { lastActivityAt: 0, subtreeWeight: 1 },
    ) || left.localeCompare(right);
  const candidates: ActivitySlot[] = [];
  for (let shell = 0; candidates.length < ids.length * 2 + PROJECT_SHELL_BASE_CAPACITY; shell += 1) {
    for (let sector = 0; sector < projectShellCapacity(shell); sector += 1) {
      candidates.push([shell, sector]);
    }
  }
  [...ids].sort(byPriority).forEach(id => {
    const previousGroup = previousById.get(id);
    const previousSlot = previousGroup?.activitySlot;
    if (previousGroup?.parentId !== null || !previousSlot || !previousSlot.every(Number.isInteger)
      || previousSlot[0] < 0 || previousSlot[1] < 0
      || previousSlot[1] >= projectShellCapacity(previousSlot[0])
      || occupied.has(slotKey(previousSlot))) return;
    const slot: ActivitySlot = [previousSlot[0], previousSlot[1]];
    slots.set(id, slot);
    occupied.add(slotKey(slot));
  });
  ids.filter(id => !slots.has(id)).sort(byPriority).forEach(id => {
    const slot = candidates.find(candidate => !occupied.has(slotKey(candidate)));
    if (!slot) return;
    slots.set(id, slot);
    occupied.add(slotKey(slot));
  });

  const idsBySlot = new Map([...slots].map(([id, slot]) => [slotKey(slot), id]));
  const rankedSlots = [...slots.values()].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const priorityOrder = [...ids].sort(byPriority);
  priorityOrder
    .filter(id => {
      const previous = previousById.get(id);
      return !previous || (priorities.get(id)?.lastActivityAt ?? 0) > (previous.activity?.lastActivityAt ?? 0);
    })
    .forEach(id => {
      const currentSlot = slots.get(id);
      const desiredSlot = rankedSlots[priorityOrder.indexOf(id)];
      const occupantId = desiredSlot ? idsBySlot.get(slotKey(desiredSlot)) : undefined;
      if (!currentSlot || !desiredSlot || !occupantId || occupantId === id
        || desiredSlot[0] >= currentSlot[0]
        || compareActivityPriority(
          priorities.get(id) ?? { lastActivityAt: 0, subtreeWeight: 1 },
          priorities.get(occupantId) ?? { lastActivityAt: 0, subtreeWeight: 1 },
        ) >= 0) return;
      slots.set(id, desiredSlot);
      slots.set(occupantId, currentSlot);
      idsBySlot.set(slotKey(desiredSlot), id);
      idsBySlot.set(slotKey(currentSlot), occupantId);
    });
  return slots;
}

function projectShellRadii(slots: ActivitySlot[], shellCount: number, operatorRadius: number, projectRadius: number, gap: number): number[] {
  const diameter = projectRadius * 2;
  const radii: number[] = [];
  for (let shell = 0; shell < shellCount; shell += 1) {
    const shellDirections = projectShellDirections(shell);
    const occupiedSectors = [...new Set(slots.filter(slot => slot[0] === shell).map(slot => slot[1]))];
    const directions = occupiedSectors.map(sector => shellDirections[sector]).filter((direction): direction is Point => Boolean(direction));
    const minimumChord = minOf(directions.flatMap((direction, index) =>
      directions.slice(index + 1).map(other => Math.hypot(
        direction[0] - other[0],
        (direction[1] - other[1]) * PROJECT_VERTICAL_STRETCH,
        direction[2] - other[2],
      ))));
    const surfaceRadius = Number.isFinite(minimumChord) && minimumChord > 0
      ? (diameter + gap) / minimumChord
      : 0;
    radii.push(Math.max(
      surfaceRadius,
      shell === 0 ? operatorRadius + projectRadius + gap : radii[shell - 1] + diameter + gap,
    ));
  }
  return radii;
}

function packedAxis(
  ids: string[],
  sizes: Map<string, Point>,
  slots: Map<string, ActivitySlot>,
  axis: 0 | 1,
  sizeAxis: 0 | 2,
  gap: number,
): { extent: number; centers: Map<number, number> } {
  const coordinates = [...new Set(ids.map(id => slots.get(id)?.[axis] ?? 0))].sort((left, right) => left - right);
  const extents = new Map(coordinates.map(coordinate => [
    coordinate,
    maxOf(ids.filter(id => (slots.get(id)?.[axis] ?? 0) === coordinate).map(id => sizes.get(id)?.[sizeAxis] ?? 0)),
  ]));
  const extent = [...extents.values()].reduce((total, value) => total + value, 0) + Math.max(0, coordinates.length - 1) * gap;
  const centers = new Map<number, number>();
  let cursor = -extent / 2;
  coordinates.forEach(coordinate => {
    const size = extents.get(coordinate) ?? 0;
    centers.set(coordinate, cursor + size / 2);
    cursor += size + gap;
  });
  return { extent, centers };
}

function activityGridPacking(ids: string[], sizes: Map<string, Point>, slots: Map<string, ActivitySlot>, gap = 4, padding = 8): ActivityGridPacking {
  if (ids.length === 0) return { size: [0, 0], offsets: new Map() };
  const x = packedAxis(ids, sizes, slots, 0, 0, gap);
  const z = packedAxis(ids, sizes, slots, 1, 2, gap);
  return {
    size: [x.extent + padding, z.extent + padding],
    offsets: new Map(ids.map(id => {
      const slot = slots.get(id) ?? [0, 0];
      return [id, [x.centers.get(slot[0]) ?? 0, z.centers.get(slot[1]) ?? 0]];
    })),
  };
}

function activityPackedPoint(center: Point, size: Point, childSize: Point, offset: [number, number], scale: number): Point {
  const yPadding = Math.min(1.2 * scale, Math.max(0, (size[1] - childSize[1]) / 2));
  return [
    center[0] + offset[0] * scale,
    center[1] - (size[1] - childSize[1]) / 2 + yPadding,
    center[2] + offset[1] * scale,
  ];
}

function activityDisplaySpecs(specs: ActivityGroupSpec[]): ActivityGroupSpec[] {
  const projectRoots = specs.filter(spec => !spec.parentId && spec.kind === 'project');
  if (projectRoots.length !== 1) return specs;
  const project = projectRoots[0];
  const children = specs.filter(spec => spec.parentId === project.id);
  if (children.length === 0) return specs;
  return specs.flatMap(spec => {
    if (spec.id === project.id) return [];
    return spec.parentId === project.id ? [{ ...spec, parentId: undefined }] : [spec];
  });
}

export function withActivityGroups(layout: LayoutResult, specs: ActivityGroupSpec[], previousLayout?: LayoutResult): LayoutResult {
  if (specs.length === 0) return layout;
  const displaySpecs = activityDisplaySpecs(specs);
  const roots = displaySpecs.filter(spec => !spec.parentId);
  const toolbox = roots.filter(spec => spec.kind === 'bash' || spec.kind === 'tool');
  const hierarchies = roots.filter(spec => spec.kind !== 'bash' && spec.kind !== 'tool');
  const hierarchyRootIds = new Set(hierarchies.map(spec => spec.id));
  const previousById = new Map(previousLayout?.groups.filter(group => group.activity).map(group => [group.id, group]) ?? []);
  const toolboxColumns = Math.min(4, Math.max(1, toolbox.length));
  const toolboxRows = Math.ceil(toolbox.length / toolboxColumns);
  const childrenByParent = new Map<string, ActivityGroupSpec[]>();
  displaySpecs.filter(spec => spec.parentId).forEach(spec => {
    const entries = childrenByParent.get(spec.parentId as string) ?? [];
    entries.push(spec);
    childrenByParent.set(spec.parentId as string, entries);
  });
  const priorityCache = new Map<string, ActivityPriority>();
  const activityPriority = (spec: ActivityGroupSpec): ActivityPriority => {
    const cached = priorityCache.get(spec.id);
    if (cached) return cached;
    const children = childrenByParent.get(spec.id) ?? [];
    const childPriorities = children.map(activityPriority);
    const priority = {
      lastActivityAt: maxOf([spec.lastActivityAt, ...childPriorities.map(child => child.lastActivityAt)]),
      subtreeWeight: Math.max(1, childPriorities.reduce((total, child) => total + child.subtreeWeight, 0)),
    };
    priorityCache.set(spec.id, priority);
    return priority;
  };
  const priorities = new Map(displaySpecs.map(spec => [spec.id, activityPriority(spec)]));
  const packingCache = new Map<string, ActivityTreePacking>();
  const activityPacking = (spec: ActivityGroupSpec): ActivityTreePacking => {
    const cached = packingCache.get(spec.id);
    if (cached) return cached;
    const children = [...(childrenByParent.get(spec.id) ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    if (children.length === 0) {
      // Domain leaves carry a per-host hit count on `weight` (see
      // activityGroupSpecs). Scaling every axis by its cube root keeps box
      // volume proportional to hit count, the same idiom bottomGroup() uses
      // for count-driven sizing. Specs that never set weight (files,
      // directories, ...) fall back to Math.max(1, undefined ?? 1) = 1 and
      // keep today's fixed leaf size.
      const scale = Math.cbrt(Math.max(1, (spec as ActivityGroupSpecWeighted).weight ?? 1));
      const leaf: ActivityTreePacking = { size: [12 * scale, 6 * scale, 10 * scale], slots: new Map(), offsets: new Map() };
      packingCache.set(spec.id, leaf);
      return leaf;
    }
    if (children.length === 1) {
      // activityGridPacking's offset for a single item is always [0, 0]
      // (dead center on the parent, in both X and Z), which collapses a
      // single-child directory/file chain -- ordinary on a real
      // filesystem, e.g. src/cljc/some/ns/file.cljc, one entry per level
      // -- onto the same X/Z point at every level down. HierarchyEdges
      // draws one box outline per group, and activity mode always renders
      // the whole ancestor chain (not just leaves, see displayGroups in
      // GraphCanvas.tsx), so that chain draws as a stack of near-concentric
      // boxes around whatever sits at the bottom of it. The static
      // namespace tree hits the identical degenerate case in
      // weightedRegions()'s own children.length === 1 branch and solves it
      // by insetting the lone child off dead-center by 30% of its
      // shrink-derived slack; mirror that fraction here, off the padding
      // this packer already reserves around a child on every other path
      // (the `padding` default in activityGridPacking, and the +8 below),
      // rather than inventing a new constant.
      const only = children[0];
      const childSize = activityPacking(only).size;
      const size: Point = [
        Math.max(18, childSize[0] + 8),
        Math.max(10, childSize[1] + 7),
        Math.max(16, childSize[2] + 8),
      ];
      const inset = 8 * 0.3;
      const result: ActivityTreePacking = {
        size,
        slots: new Map([[only.id, [0, 0]]]),
        offsets: new Map([[only.id, [inset, inset]]]),
      };
      packingCache.set(spec.id, result);
      return result;
    }
    const childSizes = new Map(children.map(child => [child.id, activityPacking(child).size]));
    const slots = activityPackedSlots(children.map(child => child.id), previousById, priorities);
    const grid = activityGridPacking(children.map(child => child.id), childSizes, slots);
    const result: ActivityTreePacking = {
      size: [
        Math.max(18, grid.size[0]),
        Math.max(10, maxOf([...childSizes.values()].map(size => size[1])) + 7),
        Math.max(16, grid.size[1]),
      ],
      slots,
      offsets: grid.offsets,
    };
    packingCache.set(spec.id, result);
    return result;
  };
  const activitySize = (spec: ActivityGroupSpec): Point => activityPacking(spec).size;
  function projectGroupSizeForActivity(spec: ActivityGroupSpec): Point {
    const natural = activitySize(spec);
    return [
      Math.max(58, natural[0] + 8),
      Math.max(32, natural[1] + 12),
      Math.max(54, natural[2] + 8),
    ];
  }
  const projectNaturalSizes = hierarchies.map(projectGroupSizeForActivity);
  const projectScale = new Map<string, number>();
  const projectSizes = new Map<string, Point>();
  hierarchies.forEach((spec, index) => {
    const scale = Math.min(1, ACTIVITY_MAX_PROJECT_EXTENT / maxOf(projectNaturalSizes[index]));
    const previousSize = previousById.get(spec.id)?.size;
    const scaledSize = projectNaturalSizes[index].map(axis => axis * scale) as Point;
    projectScale.set(spec.id, scale);
    projectSizes.set(spec.id, previousSize
      ? scaledSize.map((axis, sizeIndex) => Math.max(axis, previousSize[sizeIndex])) as Point
      : scaledSize);
  });
  const projectSlots = projectShellSlots(hierarchies.map(spec => spec.id), previousById, priorities);
  const activityToolY = layout.hierarchyBounds.center[1] + layout.hierarchyBounds.size[1] / 2 + 40;
  const activityAgentY = layout.hierarchyBounds.center[1] + layout.hierarchyBounds.size[1] / 2 + ACTIVITY_AGENT_RING_Y_OFFSET;
  const projectCenter: Point = [
    layout.hierarchyBounds.center[0],
    (activityToolY + activityAgentY) / 2,
    layout.hierarchyBounds.center[2],
  ];
  const projectRadius = maxOf([1, ...[...projectSizes.values()].map(size => Math.hypot(...size) / 2)]);
  const toolboxHalfWidth = Math.max(10, (toolboxColumns - 1) * 14 + 10);
  const toolboxHalfDepth = Math.max(9, (toolboxRows - 1) * 9 + 9);
  const toolRadius = Math.hypot(toolboxHalfWidth, Math.abs(activityToolY - projectCenter[1]) + 5, toolboxHalfDepth);
  const agentRadius = Math.hypot(
    ACTIVITY_AGENT_RING_MIN_RADIUS + 8.1,
    Math.abs(activityAgentY - projectCenter[1]) + 6.9,
    5.7,
  );
  const operatorRadius = Math.max(toolRadius, agentRadius);
  const projectGap = 8;
  const shellCount = maxOf([1, ...[...projectSlots.values()].map(slot => slot[0] + 1)]);
  const shellRadii = projectShellRadii([...projectSlots.values()], shellCount, operatorRadius, projectRadius, projectGap);
  const directionsByShell = new Map(Array.from({ length: shellCount }, (_, shell) =>
    [shell, projectShellDirections(shell)]));
  const projectCenters = new Map(hierarchies.map(spec => {
    const [shell, sector] = projectSlots.get(spec.id) ?? [0, 0];
    const direction = directionsByShell.get(shell)?.[sector] ?? [0, 0, -1];
    const radius = shellRadii[shell] ?? shellRadii[0];
    return [spec.id, [
      projectCenter[0] + direction[0] * radius,
      projectCenter[1] + direction[1] * radius * PROJECT_VERTICAL_STRETCH,
      projectCenter[2] + direction[2] * radius,
    ] as Point];
  }));
  const centerById = new Map<string, Point>();
  const sizeById = new Map<string, Point>();
  const slotById = new Map<string, ActivitySlot>(projectSlots);
  hierarchies.forEach(spec => {
    const center = projectCenters.get(spec.id) ?? layout.hierarchyBounds.center;
    const scale = projectScale.get(spec.id) ?? 1;
    const size = projectSizes.get(spec.id) ?? projectGroupSizeForActivity(spec).map(axis => axis * scale) as Point;
    centerById.set(spec.id, center);
    sizeById.set(spec.id, size);
    const place = (parent: ActivityGroupSpec) => {
      const parentCenter = centerById.get(parent.id) ?? center;
      const parentSize = sizeById.get(parent.id) ?? size;
      const siblings = [...(childrenByParent.get(parent.id) ?? [])].sort((left, right) => left.id.localeCompare(right.id));
      const packing = activityPacking(parent);
      siblings.forEach(child => {
        const naturalChildSize = sizeById.get(child.id) ?? activitySize(child).map(axis => axis * scale) as Point;
        const slot = packing.slots.get(child.id) ?? [0, 0];
        const offset = packing.offsets.get(child.id) ?? [0, 0];
        const previousChild = previousById.get(child.id);
        const previousParent = previousById.get(parent.id);
        const childSize = previousChild
          ? naturalChildSize.map((axis, sizeIndex) => Math.max(axis, previousChild.size[sizeIndex])) as Point
          : naturalChildSize;
        const packedCenter = activityPackedPoint(parentCenter, parentSize, childSize, offset, scale);
        const previousCenter = previousChild && previousParent
          ? previousChild.center.map((axis, index) => {
            const parentDelta = parentCenter[index] - previousParent.center[index];
            return Math.abs(parentDelta) < 1e-9 ? axis : axis + parentDelta;
          }) as Point
          : undefined;
        const contained = previousCenter?.every((axis, index) =>
          Math.abs(axis - parentCenter[index]) + childSize[index] / 2 <= parentSize[index] / 2,
        );
        centerById.set(child.id, previousCenter && contained ? previousCenter : packedCenter);
        sizeById.set(child.id, childSize);
        slotById.set(child.id, slot);
        place(child);
      });
    };
    place(spec);
  });
  // Tool groups and agents form the operator hub; visible hierarchy roots
  // occupy priority-ordered spherical shells around it.
  const activityToolDepth = layout.hierarchyBounds.center[2];
  const groups = displaySpecs.map(spec => {
    if (hierarchyRootIds.has(spec.id)) {
      const children = childrenByParent.get(spec.id) ?? [];
      const center = centerById.get(spec.id) ?? layout.hierarchyBounds.center;
      const scale = projectScale.get(spec.id) ?? 1;
      const size = sizeById.get(spec.id) ?? projectGroupSizeForActivity(spec).map(axis => axis * scale) as Point;
      return {
        id: spec.id,
        parentId: null,
        path: spec.path ?? spec.id.replace(/^group:/, ''),
        label: spec.label,
        depth: 0,
        center,
        size,
        virtual: true,
        nodeCount: priorities.get(spec.id)?.subtreeWeight ?? children.length,
        activitySlot: slotById.get(spec.id),
        activity: { kind: spec.kind, projectId: spec.projectId, projectRoot: spec.projectRoot, path: spec.path, lastActivityAt: spec.lastActivityAt, expiresAt: spec.expiresAt, lastOutcome: spec.lastOutcome },
      } satisfies LayoutGroup;
    }
    if (spec.parentId) {
      const center = centerById.get(spec.id) ?? layout.hierarchyBounds.center;
      const size = sizeById.get(spec.id) ?? activitySize(spec);
      return {
        id: spec.id,
        parentId: spec.parentId,
        path: spec.path ?? spec.id.replace(/^group:/, ''),
        label: spec.label,
        depth: (() => {
          let depth = 0;
          let parentId: string | null | undefined = spec.parentId;
          while (parentId) {
            depth += 1;
            parentId = displaySpecs.find(candidate => candidate.id === parentId)?.parentId;
          }
          return depth;
        })(),
        center,
        size,
        virtual: true,
        // Domain groups carry their accumulated hit count on `weight`
        // (activityGroupSpecs); surface it here so a busy host reports a
        // higher nodeCount than the default subtree weight of 1, giving the
        // canvas agent a ready-made number for the sphere's hit counter.
        nodeCount: Math.max(priorities.get(spec.id)?.subtreeWeight ?? 1, (spec as ActivityGroupSpecWeighted).weight ?? 0),
        activitySlot: slotById.get(spec.id),
        activity: { kind: spec.kind, projectId: spec.projectId, projectRoot: spec.projectRoot, path: spec.path, lastActivityAt: spec.lastActivityAt, expiresAt: spec.expiresAt, lastOutcome: spec.lastOutcome },
      } satisfies LayoutGroup;
    }
    const index = toolbox.indexOf(spec);
    const column = index % toolboxColumns;
    const row = Math.floor(index / toolboxColumns);
    const width = Math.max(24, toolboxColumns * 28);
    return {
      id: spec.id,
      parentId: null,
      path: spec.id.replace(/^group:/, ''),
      label: spec.label,
      depth: 0,
      center: [
        layout.hierarchyBounds.center[0] + (column - (toolboxColumns - 1) / 2) * 28,
        activityToolY,
        activityToolDepth + (row - (toolboxRows - 1) / 2) * 18,
      ] as Point,
      size: [Math.max(20, width / toolboxColumns - 4), 10, 18] as Point,
      virtual: true,
      nodeCount: 0,
      activity: { kind: spec.kind, ...(spec.tool ? { tool: spec.tool } : {}), lastActivityAt: spec.lastActivityAt, expiresAt: spec.expiresAt, lastOutcome: spec.lastOutcome },
    } satisfies LayoutGroup;
  });
  return { ...layout, groups: [...layout.groups.filter(group => !group.activity), ...groups] };
}

function normalizedAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function activityAgentTargetAngles(layout: LayoutResult, rays: ActivityRay[], center: Point): Map<string, { angle: number; startedAt: number }> {
  const groupsById = new Map(layout.groups.map(group => [group.id, group]));
  const targets = new Map<string, { angle: number; startedAt: number }>();
  rays.forEach(ray => {
    if (!ray.sourceAgentNodeId || ray.target.id.startsWith('agent:')) return;
    const point = ray.target.kind === 'group'
      ? groupsById.get(ray.target.id)?.center
      : layout.positions.get(ray.target.id);
    if (!point) return;
    const x = point[0] - center[0];
    const z = point[2] - center[2];
    if (Math.hypot(x, z) < 0.001) return;
    const previous = targets.get(ray.sourceAgentNodeId);
    if (!previous || ray.startedAt > previous.startedAt) {
      targets.set(ray.sourceAgentNodeId, { angle: Math.atan2(z, x), startedAt: ray.startedAt });
    }
  });
  return targets;
}

function activityAgentAngles(
  members: ActivityAgentNode[],
  center: Point,
  targets: Map<string, { angle: number; startedAt: number }>,
  previousLayout?: LayoutResult,
): Map<string, number> {
  const previousAgents = new Map([
    ...(previousLayout?.activityAgents ?? []),
    ...(previousLayout?.activityInactiveAgents ?? []),
  ].map(agent => [agent.id, agent]));
  const previousAngles = new Map(members.map(agent => {
    const previous = previousAgents.get(agent.id);
    return [agent.id, previous
      ? Math.atan2(previous.center[2] - center[2], previous.center[0] - center[0])
      : undefined] as const;
  }));
  const spacing = Math.PI * 2 / Math.max(1, members.length);
  const phaseCandidates = new Set<number>([-Math.PI / 2]);
  members.forEach((agent, index) => {
    const target = targets.get(agent.id)?.angle;
    if (target !== undefined) phaseCandidates.add(normalizedAngle(target - index * spacing));
  });
  let targetPhase = -Math.PI / 2;
  let bestCost = Infinity;
  phaseCandidates.forEach(phase => {
    const cost = members.reduce((total, agent, index) => {
      const target = targets.get(agent.id)?.angle;
      const previous = previousAngles.get(agent.id);
      const desired = target ?? previous ?? (-Math.PI / 2 + index * spacing);
      return total + Math.abs(normalizedAngle(desired - (phase + index * spacing))) * (target === undefined ? 0.15 : 1);
    }, 0);
    if (cost < bestCost) {
      targetPhase = phase;
      bestCost = cost;
    }
  });
  const previousPhaseOffsets = members.flatMap((agent, index) => {
    const previous = previousAngles.get(agent.id);
    return previous === undefined ? [] : [normalizedAngle(previous - index * spacing)];
  });
  const previousPhase = previousPhaseOffsets.length === 0
    ? undefined
    : Math.atan2(
      previousPhaseOffsets.reduce((total, angle) => total + Math.sin(angle), 0),
      previousPhaseOffsets.reduce((total, angle) => total + Math.cos(angle), 0),
    );
  const phase = previousPhase === undefined
    ? targetPhase
    : previousPhase + Math.max(
      -ACTIVITY_AGENT_PHASE_MAX_STEP,
      Math.min(
        ACTIVITY_AGENT_PHASE_MAX_STEP,
        normalizedAngle(targetPhase - previousPhase) * ACTIVITY_AGENT_PHASE_DAMPING,
      ),
    );
  return new Map(members.map((agent, index) => [agent.id, phase + index * spacing]));
}

export function withActivityAgentNodes(
  layout: LayoutResult,
  agents: ActivityAgentNode[],
  now = Date.now(),
  rays: ActivityRay[] = [],
  previousLayout?: LayoutResult,
): LayoutResult {
  if (agents.length === 0) return { ...layout, activityAgents: undefined, activityInactiveAgents: undefined };
  const uniqueAgents = new Map<string, ActivityAgentNode>();
  agents.forEach(agent => {
    const previous = uniqueAgents.get(agent.id);
    if (!previous || agent.updatedAt >= previous.updatedAt) uniqueAgents.set(agent.id, agent);
  });
  const ordered = [...uniqueAgents.values()].sort((left, right) => left.id.localeCompare(right.id));
  const active = ordered.filter(agent => now - agent.updatedAt < ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS);
  const inactive = ordered.filter(agent => now - agent.updatedAt >= ACTIVITY_AGENT_INACTIVE_THRESHOLD_MS);
  const center: Point = [
    layout.hierarchyBounds.center[0],
    layout.hierarchyBounds.center[1] + layout.hierarchyBounds.size[1] / 2 + ACTIVITY_AGENT_RING_Y_OFFSET,
    layout.hierarchyBounds.center[2],
  ];
  const radius = Math.max(ACTIVITY_AGENT_RING_MIN_RADIUS, active.length * ACTIVITY_AGENT_RING_SPACING);
  const inactiveCenter: Point = [center[0], center[1] + ACTIVITY_AGENT_INACTIVE_GRID_Y_OFFSET, center[2]];
  const size: Point = [16.2, 13.8, 11.4];
  const targetAngles = activityAgentTargetAngles(layout, rays, center);
  const placeAgentsOnRing = (members: ActivityAgentNode[], ringCenter: Point, ringRadius: number): ActivityAgentLayout[] => {
    const angles = activityAgentAngles(members, ringCenter, targetAngles, previousLayout);
    return members.map((agent, index) => {
      const angle = angles.get(agent.id) ?? (index / Math.max(1, members.length)) * Math.PI * 2 - Math.PI / 2;
      const position: Point = [
        ringCenter[0] + Math.cos(angle) * ringRadius,
        ringCenter[1],
        ringCenter[2] + Math.sin(angle) * ringRadius,
      ];
      // The spread deliberately carries every ActivityAgentNode field forward onto
      // ActivityAgentLayout, not just the ones named here -- in particular T1-B's
      // waitingSince/waitingToolCallId/lastDeniedAt (src/activity/types.ts), which
      // GraphCanvas's agentGlyphAppearance (T1-G) reads off the layout object, never
      // off the source node. Do not replace this with an explicit field list without
      // adding those three back by hand; see the withActivityAgentNodes coverage in
      // layout.test.ts that pins this.
      return { ...agent, center: position, size };
    });
  };
  const activityAgents = placeAgentsOnRing(active, center, radius);
  const inactiveColumns = Math.max(1, Math.ceil(Math.sqrt(inactive.length)));
  const inactiveRows = Math.max(1, Math.ceil(inactive.length / inactiveColumns));
  const activityInactiveAgents = inactive.map((agent, index) => {
    const column = index % inactiveColumns;
    const row = Math.floor(index / inactiveColumns);
    const position: Point = [
      inactiveCenter[0] + (column - (inactiveColumns - 1) / 2) * ACTIVITY_AGENT_GRID_COLUMN_SPACING,
      inactiveCenter[1],
      inactiveCenter[2] + (row - (inactiveRows - 1) / 2) * ACTIVITY_AGENT_GRID_ROW_SPACING,
    ];
    return { ...agent, center: position, size };
  });
  const positions = new Map(layout.positions);
  [...activityAgents, ...activityInactiveAgents].forEach(agent => positions.set(agent.id, agent.center));
  return {
    ...layout,
    positions,
    activityAgents: activityAgents.length > 0 ? activityAgents : undefined,
    activityInactiveAgents: activityInactiveAgents.length > 0 ? activityInactiveAgents : undefined,
  };
}

function hashString(value: string, salt = ''): number {
  let hash = 2166136261;
  for (const character of `${salt}\u0000${value}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function orbitDirection(id: string, attempt = 0): Point {
  const azimuth = (hashString(id, `azimuth:${attempt}`) / 0xffffffff) * Math.PI * 2;
  const elevation = hashString(id, `elevation:${attempt}`) / 0xffffffff * 2 - 1;
  const radius = Math.sqrt(Math.max(0, 1 - elevation * elevation));
  return [radius * Math.cos(azimuth), elevation, radius * Math.sin(azimuth)];
}

function hierarchyBounds(groups: LayoutGroup[]): LayoutBounds {
  const visibleGroups = groups.filter(group => !group.global);
  if (visibleGroups.length === 0) {
    const [x, y, z] = ROOT_BOUNDS.size;
    return {
      center: [...ROOT_BOUNDS.center],
      size: [x, y, z],
      diagonal: Math.hypot(x, y, z),
    };
  }
  const minimum: Point = [Infinity, Infinity, Infinity];
  const maximum: Point = [-Infinity, -Infinity, -Infinity];
  visibleGroups.forEach(group => {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], group.center[axis] - group.size[axis] / 2);
      maximum[axis] = Math.max(maximum[axis], group.center[axis] + group.size[axis] / 2);
    }
  });
  const size: Point = [
    Math.max(12, maximum[0] - minimum[0]),
    Math.max(12, maximum[1] - minimum[1]),
    Math.max(12, maximum[2] - minimum[2]),
  ];
  const center: Point = [
    (minimum[0] + maximum[0]) / 2,
    (minimum[1] + maximum[1]) / 2,
    (minimum[2] + maximum[2]) / 2,
  ];
  return { center, size, diagonal: Math.hypot(size[0], size[1], size[2]) };
}

function orbitRadius(bounds: LayoutBounds, nodeScale: number): number {
  const margin = Math.min(28, Math.max(12, 9 + nodeScale * 3));
  return Math.max(42, bounds.diagonal / 2 + margin, maxOf(bounds.size) * 0.65 + margin);
}

function orbitPositions(
  nodes: CodeNode[],
  center: Point,
  radius: number,
  nodeScale: number,
): Map<string, Point> {
  const positions = new Map<string, Point>();
  const placed: Array<{ point: Point; clearance: number }> = [];
  const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  ordered.forEach(node => {
    const clearance = nodeClearance(node.kind, nodeScale);
    let point: Point = [...center];
    let found = false;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const direction = orbitDirection(node.id, attempt);
      const layer = Math.floor(attempt / 12);
      const candidateRadius = radius + layer * Math.min(8, 2.5 + nodeScale);
      point = [
        center[0] + direction[0] * candidateRadius,
        center[1] + direction[1] * candidateRadius,
        center[2] + direction[2] * candidateRadius,
      ];
      if (placed.every(previous => Math.hypot(
        point[0] - previous.point[0],
        point[1] - previous.point[1],
        point[2] - previous.point[2],
      ) >= clearance + previous.clearance)) {
        found = true;
        break;
      }
    }
    if (!found) {
      const direction = orbitDirection(node.id, 24);
      point = [
        center[0] + direction[0] * (radius + Math.min(16, 4 + nodeScale * 2)),
        center[1] + direction[1] * (radius + Math.min(16, 4 + nodeScale * 2)),
        center[2] + direction[2] * (radius + Math.min(16, 4 + nodeScale * 2)),
      ];
    }
    positions.set(node.id, point);
    placed.push({ point, clearance });
  });
  return positions;
}

function bottomGroup(nodes: CodeNode[], id: string, label: string, global = false): LayoutGroup {
  const extent = Math.max(18, Math.cbrt(Math.max(1, nodes.length)) * 1.3);
  return {
    id,
    parentId: null,
    path: id === 'group:global' ? '<global>' : 'unscoped',
    label,
    depth: 0,
    center: [0, -ROOT_BOUNDS.size[1] * 0.43, 0],
    size: [Math.max(32, extent * 1.8), Math.max(18, extent), Math.max(32, extent * 1.8)],
    virtual: true,
    actualNamespace: global ? '<global>' : undefined,
    namespaceNodeId: global ? nodes.find(node => node.kind === 'namespace')?.id : undefined,
    nodeCount: nodes.length,
    global,
  };
}

export function computeLayout(graph: CodeGraph, previousLayout?: LayoutResult, options: LayoutOptions = {}): LayoutResult {
  const globalNamespaceMode = options.globalNamespaceMode ?? 'bottom';
  const nodeScale = options.nodeScale ?? 1;
  const showGlobalNamespace = options.showGlobalNamespace ?? true;
  const positions = new Map<string, Point>();
  const groups: LayoutGroup[] = [];
  const globalNodes = graph.nodes.filter(isGlobalNode).sort((a, b) => a.id.localeCompare(b.id));
  const namespaceNodes = graph.nodes
    .filter(node => node.kind === 'namespace' && node.namespace && !isGlobalNode(node))
    .sort((a, b) => a.id.localeCompare(b.id));
  const namespaceNodeByName = new Map(namespaceNodes.map(node => [node.namespace as string, node]));
  const namespaceTreeByName = new Map<string, NamespaceTreeNode>();
  const root: NamespaceTreeNode = { path: '', label: 'root', children: new Map(), directNodeCount: 0, subtreeNodeCount: 0 };
  namespaceNodes.forEach(node => {
    const namespace = node.namespace as string;
    namespaceTreeByName.set(namespace, addTreePath(root, namespace, true));
  });

  const nodesByNamespace = new Map<string | null, CodeNode[]>();
  graph.nodes.filter(node => node.kind !== 'namespace' && !isGlobalNode(node)).forEach(node => {
    const namespace = node.namespace ?? null;
    const nodes = nodesByNamespace.get(namespace) ?? [];
    nodes.push(node);
    nodesByNamespace.set(namespace, nodes);
  });
  nodesByNamespace.forEach((_, namespace) => {
    if (namespace && !namespaceTreeByName.has(namespace)) {
      namespaceTreeByName.set(namespace, addTreePath(root, namespace));
    }
  });
  namespaceNodes.forEach(node => {
    const namespace = node.namespace as string;
    const treeNode = namespaceTreeByName.get(namespace);
    if (treeNode) treeNode.directNodeCount += 1;
  });
  nodesByNamespace.forEach((nodes, namespace) => {
    if (!namespace) return;
    const treeNode = namespaceTreeByName.get(namespace);
    if (treeNode) treeNode.directNodeCount += nodes.length;
  });
  calculateSubtreeWeight(root);

  const namespaceBounds = new Map<string, Bounds>();
  const placeTree = (treeNode: NamespaceTreeNode, bounds: Bounds, parentId: string | null, depth: number) => {
    const children = [...treeNode.children.values()].sort((a, b) => a.path.localeCompare(b.path));
    const regions = weightedRegions(children, bounds);
    children.forEach(child => {
      const childRegion = regions.get(child.path);
      if (!childRegion) return;
      const id = namespaceGroupId(child.path);
      groups.push({
        id,
        parentId,
        path: child.path,
        label: child.label,
        depth,
        center: childRegion.center,
        size: childRegion.size,
        actualNamespace: child.actualNamespace,
        namespaceNodeId: child.actualNamespace ? namespaceNodeByName.get(child.actualNamespace)?.id : undefined,
        virtual: !child.actualNamespace,
        nodeCount: child.subtreeNodeCount,
      });
      if (namespaceTreeByName.has(child.path)) namespaceBounds.set(child.path, childRegion);
      if (child.actualNamespace) {
        const namespaceNode = namespaceNodeByName.get(child.actualNamespace);
        if (namespaceNode) positions.set(namespaceNode.id, childRegion.center);
      }
      placeTree(child, childRegion, id, depth + 1);
    });
  };

  placeTree(root, ROOT_BOUNDS, null, 0);

  const unscopedNodes = nodesByNamespace.get(null);
  if (unscopedNodes) {
    groups.push(bottomGroup(unscopedNodes, 'group:unscoped', 'unscoped'));
  }
  if (globalNodes.length > 0 && globalNamespaceMode === 'bottom' && showGlobalNamespace) {
    groups.push(bottomGroup(globalNodes, 'group:global', 'global', true));
  }
  const layoutGroups = stabilizeGroups(groups, previousLayout);
  const layoutGroupsById = new Map(layoutGroups.map(group => [group.id, group]));
  layoutGroups.forEach(group => {
    const bounds = namespaceBounds.get(group.path);
    if (bounds) bounds.center = group.center;
  });
  positions.clear();
  namespaceNodes.forEach(node => {
    const group = node.namespace ? layoutGroupsById.get(namespaceGroupId(node.namespace)) : undefined;
    if (group) positions.set(node.id, group.center);
  });

  nodesByNamespace.forEach((nodes, namespace) => {
    let center: Point;
    let size: Point;
    const group = namespace
      ? layoutGroupsById.get(namespaceGroupId(namespace))
      : layoutGroupsById.get('group:unscoped');
    center = group?.center ?? [0, 0, 0];
    size = group?.size ?? [12, 12, 12];
    volumePositions(nodes, center, size, nodeScale).forEach((point, id) => positions.set(id, point));
  });

  const bounds = hierarchyBounds(layoutGroups);
  const orbit = globalNodes.length > 0 && globalNamespaceMode === 'orbit'
    ? { center: bounds.center, radius: orbitRadius(bounds, nodeScale) }
    : null;
  if (globalNodes.length > 0) {
    if (orbit) {
      orbitPositions(globalNodes, orbit.center, orbit.radius, nodeScale).forEach((point, id) => positions.set(id, point));
    } else {
      const group = layoutGroupsById.get('group:global');
      const center = group?.center ?? [0, -ROOT_BOUNDS.size[1] * 0.43, 0];
      const size = group?.size ?? [32, 18, 32];
      volumePositions(globalNodes, center, size, nodeScale).forEach((point, id) => positions.set(id, point));
    }
  }

  const unpositioned = graph.nodes.filter(node => !positions.has(node.id));
  volumePositions(unpositioned, ROOT_BOUNDS.center, ROOT_BOUNDS.size, nodeScale).forEach((point, id) => positions.set(id, point));

  return {
    positions,
    groups: layoutGroups,
    hierarchyBounds: bounds,
    ...(orbit ? {
      orbit: {
        center: orbit.center,
        radius: orbit.radius,
        globalNodeIds: globalNodes.map(node => node.id),
      },
    } : {}),
  };
}
