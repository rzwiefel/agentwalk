import type { CodeEdge, CodeGraph, CodeNode, LayoutGroup } from './types';

type Point = [number, number, number];

interface Velocity { x: number; y: number; z: number; }

export interface PhysicsState {
  nodePositions: Map<string, Point>;
  groupPositions: Map<string, Point>;
  simulatedNodeIds: Set<string>;
  simulatedEdgeIds: Set<string>;
  nodeGroups: Map<string, string>;
  nodeById: Map<string, CodeNode>;
  baseNodePositions: Map<string, Point>;
  baseGroupPositions: Map<string, Point>;
  nodeVelocities: Map<string, Velocity>;
  groupVelocities: Map<string, Velocity>;
}

const MAX_SIMULATED_NODES = 1600;
const MAX_SIMULATED_EDGES = 7000;
const NODE_CELL_SIZE = 6;

function copyPoint(point: Point): Point { return [point[0], point[1], point[2]]; }
function makeVelocity(): Velocity { return { x: 0, y: 0, z: 0 }; }
function addForce(force: Velocity, x: number, y: number, z: number) {
  force.x += x;
  force.y += y;
  force.z += z;
}
function distanceSquared(a: Point, b: Point) {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return x * x + y * y + z * z;
}
function cellKey(point: Point): string {
  return Math.floor(point[0] / NODE_CELL_SIZE) + ':' + Math.floor(point[1] / NODE_CELL_SIZE) + ':' + Math.floor(point[2] / NODE_CELL_SIZE);
}

function clampInside(point: Point, center: Point, outerSize: Point, innerSize: Point, padding: number): void {
  for (let axis = 0; axis < 3; axis += 1) {
    const range = Math.max(0, (outerSize[axis] - innerSize[axis]) / 2 - padding);
    point[axis] = Math.max(center[axis] - range, Math.min(center[axis] + range, point[axis]));
  }
}

function chooseSimulatedNodes(graph: CodeGraph, visibleNodeIds: Set<string>): Set<string> {
  const selected = new Set<string>();
  const byNamespace = new Map<string, CodeNode[]>();
  graph.nodes
    .filter(node => visibleNodeIds.has(node.id) && !node.external)
    .forEach(node => {
      const namespace = node.namespace ?? '__unscoped__';
      const nodes = byNamespace.get(namespace) ?? [];
      nodes.push(node);
      byNamespace.set(namespace, nodes);
    });
  for (const nodes of byNamespace.values()) {
    const namespaceAnchor = nodes.find(node => node.kind === 'namespace');
    if (namespaceAnchor && selected.size < MAX_SIMULATED_NODES) selected.add(namespaceAnchor.id);
  }
  graph.nodes
    .filter(node => visibleNodeIds.has(node.id) && !node.external && !selected.has(node.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, Math.max(0, MAX_SIMULATED_NODES - selected.size))
    .forEach(node => selected.add(node.id));
  return selected;
}

export function createPhysicsState(
  graph: CodeGraph,
  positions: Map<string, Point>,
  groups: LayoutGroup[],
  visibleNodeIds: Set<string>,
  visibleEdges: CodeEdge[],
): PhysicsState {
  const nodePositions = new Map([...positions].map(([id, point]) => [id, copyPoint(point)]));
  const groupPositions = new Map(groups.map(group => [group.id, copyPoint(group.center)]));
  const baseNodePositions = new Map([...positions].map(([id, point]) => [id, copyPoint(point)]));
  const baseGroupPositions = new Map(groups.map(group => [group.id, copyPoint(group.center)]));
  const groupsByPath = new Map(groups.map(group => [group.path, group]));
  const nodeGroups = new Map<string, string>();
  graph.nodes.forEach(node => {
    const groupId = node.namespace ? groupsByPath.get(node.namespace)?.id : 'group:unscoped';
    if (groupId) nodeGroups.set(node.id, groupId);
  });
  const simulatedNodeIds = chooseSimulatedNodes(graph, visibleNodeIds);
  const simulatedEdgeIds = new Set(visibleEdges
    .filter(edge => simulatedNodeIds.has(edge.source) && simulatedNodeIds.has(edge.target))
    .slice(0, MAX_SIMULATED_EDGES)
    .map(edge => edge.id));
  return {
    nodePositions,
    groupPositions,
    simulatedNodeIds,
    simulatedEdgeIds,
    nodeGroups,
    nodeById: new Map(graph.nodes.map(node => [node.id, node])),
    baseNodePositions,
    baseGroupPositions,
    nodeVelocities: new Map([...simulatedNodeIds].map(id => [id, makeVelocity()])),
    groupVelocities: new Map(groups.map(group => [group.id, makeVelocity()])),
  };
}

function moveGroups(state: PhysicsState, groups: LayoutGroup[], delta: number) {
  const forces = new Map(groups.map(group => [group.id, makeVelocity()]));
  const groupsById = new Map(groups.map(group => [group.id, group]));
  groups.forEach(group => {
    const force = forces.get(group.id);
    const position = state.groupPositions.get(group.id);
    const base = state.baseGroupPositions.get(group.id);
    if (!force || !position || !base) return;
    const parent = group.parentId ? groupsById.get(group.parentId) : undefined;
    const parentPosition = parent ? state.groupPositions.get(parent.id) : undefined;
    const parentBase = parent ? state.baseGroupPositions.get(parent.id) : undefined;
    const target: Point = parentPosition && parentBase
      ? [
          base[0] + parentPosition[0] - parentBase[0],
          base[1] + parentPosition[1] - parentBase[1],
          base[2] + parentPosition[2] - parentBase[2],
        ]
      : base;
    addForce(force, (target[0] - position[0]) * 0.18, (target[1] - position[1]) * 0.18, (target[2] - position[2]) * 0.18);
  });
  for (let index = 0; index < groups.length; index += 1) {
    const first = groups[index];
    const firstPosition = state.groupPositions.get(first.id);
    const firstForce = forces.get(first.id);
    if (!firstPosition || !firstForce) continue;
    for (let otherIndex = index + 1; otherIndex < groups.length; otherIndex += 1) {
      const second = groups[otherIndex];
      if (first.parentId !== second.parentId || first.depth !== second.depth) continue;
      const secondPosition = state.groupPositions.get(second.id);
      const secondForce = forces.get(second.id);
      if (!secondPosition || !secondForce) continue;
      const overlapX = (first.size[0] + second.size[0]) / 2 + 4 - Math.abs(firstPosition[0] - secondPosition[0]);
      const overlapY = (first.size[1] + second.size[1]) / 2 + 4 - Math.abs(firstPosition[1] - secondPosition[1]);
      const overlapZ = (first.size[2] + second.size[2]) / 2 + 4 - Math.abs(firstPosition[2] - secondPosition[2]);
      if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) continue;
      const axis = overlapX <= overlapY && overlapX <= overlapZ ? 0 : overlapY <= overlapZ ? 1 : 2;
      const direction = (firstPosition[axis] ?? 0) >= (secondPosition[axis] ?? 0) ? 1 : -1;
      const overlap = axis === 0 ? overlapX : axis === 1 ? overlapY : overlapZ;
      const push = Math.min(3, overlap * 0.12);
      const axisName = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
      firstForce[axisName] += direction * push;
      secondForce[axisName] -= direction * push;
    }
  }
  groups.forEach(group => {
    const position = state.groupPositions.get(group.id);
    const currentVelocity = state.groupVelocities.get(group.id);
    const force = forces.get(group.id);
    if (!position || !currentVelocity || !force) return;
    currentVelocity.x = (currentVelocity.x + force.x * delta) * 0.86;
    currentVelocity.y = (currentVelocity.y + force.y * delta) * 0.86;
    currentVelocity.z = (currentVelocity.z + force.z * delta) * 0.86;
    position[0] += Math.max(-0.22, Math.min(0.22, currentVelocity.x * delta));
    position[1] += Math.max(-0.22, Math.min(0.22, currentVelocity.y * delta));
    position[2] += Math.max(-0.22, Math.min(0.22, currentVelocity.z * delta));
  });
  [...groups].sort((left, right) => left.depth - right.depth).forEach(group => {
    if (!group.parentId) return;
    const parent = groupsById.get(group.parentId);
    const position = state.groupPositions.get(group.id);
    const parentPosition = parent ? state.groupPositions.get(parent.id) : undefined;
    if (!parent || !position || !parentPosition) return;
    clampInside(position, parentPosition, parent.size, group.size, 0.8);
  });
}

function moveNodes(state: PhysicsState, groups: LayoutGroup[], visibleEdges: CodeEdge[], delta: number) {
  const groupsById = new Map(groups.map(group => [group.id, group]));
  const forces = new Map([...state.simulatedNodeIds].map(id => [id, makeVelocity()]));
  const cellBuckets = new Map<string, string[]>();
  state.simulatedNodeIds.forEach(id => {
    const position = state.nodePositions.get(id);
    if (!position) return;
    const key = cellKey(position);
    const bucket = cellBuckets.get(key) ?? [];
    bucket.push(id);
    cellBuckets.set(key, bucket);
  });
  state.simulatedNodeIds.forEach(id => {
    const position = state.nodePositions.get(id);
    const base = state.baseNodePositions.get(id);
    const force = forces.get(id);
    const groupId = state.nodeGroups.get(id);
    const groupPosition = groupId ? state.groupPositions.get(groupId) : undefined;
    const baseGroupPosition = groupId ? state.baseGroupPositions.get(groupId) : undefined;
    const node = state.nodeById.get(id);
    if (!position || !base || !force || !node) return;
    if (groupPosition && baseGroupPosition) {
      addForce(force, (base[0] + groupPosition[0] - baseGroupPosition[0] - position[0]) * 0.08, (base[1] + groupPosition[1] - baseGroupPosition[1] - position[1]) * 0.08, (base[2] + groupPosition[2] - baseGroupPosition[2] - position[2]) * 0.08);
    }
    if (node.kind !== 'namespace') {
      const [cx, cy, cz] = position.map(value => Math.floor(value / NODE_CELL_SIZE));
      for (let x = cx - 1; x <= cx + 1; x += 1) for (let y = cy - 1; y <= cy + 1; y += 1) for (let z = cz - 1; z <= cz + 1; z += 1) {
        (cellBuckets.get(x + ':' + y + ':' + z) ?? []).forEach(otherId => {
          if (otherId <= id) return;
          const other = state.nodePositions.get(otherId);
          const otherNode = state.nodeById.get(otherId);
          const otherForce = forces.get(otherId);
          if (!other || !otherNode || !otherForce || otherNode.kind === 'namespace' || otherNode.namespace !== node.namespace) return;
          const squared = distanceSquared(position, other);
          if (squared >= 30) return;
          const distance = Math.sqrt(squared) || 0.1;
          const push = Math.min(0.8, (Math.sqrt(30) - distance) * 0.045 / distance);
          const dx = (position[0] - other[0]) * push;
          const dy = (position[1] - other[1]) * push;
          const dz = (position[2] - other[2]) * push;
          addForce(force, dx, dy, dz);
          addForce(otherForce, -dx, -dy, -dz);
        });
      }
    }
  });
  visibleEdges.forEach(edge => {
    if (!state.simulatedEdgeIds.has(edge.id)) return;
    const source = state.nodePositions.get(edge.source);
    const target = state.nodePositions.get(edge.target);
    const sourceForce = forces.get(edge.source);
    const targetForce = forces.get(edge.target);
    if (!source || !target || !sourceForce || !targetForce) return;
    const dx = target[0] - source[0];
    const dy = target[1] - source[1];
    const dz = target[2] - source[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.1;
    const attraction = Math.max(-0.45, Math.min(0.45, (distance - 7) * 0.006));
    const fx = dx / distance * attraction;
    const fy = dy / distance * attraction;
    const fz = dz / distance * attraction;
    addForce(sourceForce, fx, fy, fz);
    addForce(targetForce, -fx, -fy, -fz);
  });
  state.simulatedNodeIds.forEach(id => {
    const position = state.nodePositions.get(id);
    const currentVelocity = state.nodeVelocities.get(id);
    const node = state.nodeById.get(id);
    const groupId = state.nodeGroups.get(id);
    const groupPosition = groupId ? state.groupPositions.get(groupId) : undefined;
    if (!position || !currentVelocity || !node) return;
    if (node.kind === 'namespace' && groupPosition) {
      position[0] = groupPosition[0];
      position[1] = groupPosition[1];
      position[2] = groupPosition[2];
      currentVelocity.x = 0;
      currentVelocity.y = 0;
      currentVelocity.z = 0;
      return;
    }
    const force = forces.get(id);
    if (!force) return;
    currentVelocity.x = (currentVelocity.x + force.x * delta) * 0.9;
    currentVelocity.y = (currentVelocity.y + force.y * delta) * 0.9;
    currentVelocity.z = (currentVelocity.z + force.z * delta) * 0.9;
    position[0] += Math.max(-0.25, Math.min(0.25, currentVelocity.x * delta));
    position[1] += Math.max(-0.25, Math.min(0.25, currentVelocity.y * delta));
    position[2] += Math.max(-0.25, Math.min(0.25, currentVelocity.z * delta));
  });
  state.nodePositions.forEach((position, id) => {
    if (state.simulatedNodeIds.has(id)) return;
    const base = state.baseNodePositions.get(id);
    const groupId = state.nodeGroups.get(id);
    const groupPosition = groupId ? state.groupPositions.get(groupId) : undefined;
    const baseGroupPosition = groupId ? state.baseGroupPositions.get(groupId) : undefined;
    if (!base || !groupPosition || !baseGroupPosition) return;
    position[0] = base[0] + groupPosition[0] - baseGroupPosition[0];
    position[1] = base[1] + groupPosition[1] - baseGroupPosition[1];
    position[2] = base[2] + groupPosition[2] - baseGroupPosition[2];
  });
  state.nodePositions.forEach((position, id) => {
    const groupId = state.nodeGroups.get(id);
    const group = groupId ? groupsById.get(groupId) : undefined;
    const groupPosition = groupId ? state.groupPositions.get(groupId) : undefined;
    const node = state.nodeById.get(id);
    if (!group || !groupPosition || !node) return;
    const nodeExtent = node.kind === 'namespace' ? 2.8 : node.kind === 'var' ? 1.8 : 1.4;
    clampInside(position, groupPosition, group.size, [nodeExtent, nodeExtent, nodeExtent], 0.8);
  });
}

export function stepPhysics(state: PhysicsState, graph: CodeGraph, groups: LayoutGroup[], visibleEdges: CodeEdge[], delta: number) {
  const frameDelta = Math.min(0.035, Math.max(0.001, delta));
  moveGroups(state, groups, frameDelta);
  moveNodes(state, groups, visibleEdges, frameDelta);
}
