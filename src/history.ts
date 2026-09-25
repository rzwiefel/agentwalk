import type { CodeGraph, CodeNode, HistoryCommit } from './types';

export interface HistoryActivity {
  values: Map<string, number>;
  baseline: number;
  elapsedMs: number;
  updatedAt: Map<string, number>;
}

export const HISTORY_FADE_MS = 30000;
export const HISTORY_HEAT_WINDOW = 20;
export const HISTORY_HEAT_THRESHOLD = 3;
export const HISTORY_HEAT_MAX_COUNT = 6;

export function historyHeat(commits: HistoryCommit[], index: number, windowSize = HISTORY_HEAT_WINDOW): Map<string, number> {
  if (index < 0 || commits.length === 0) return new Map();
  const end = Math.min(index, commits.length - 1);
  const start = Math.max(0, end - windowSize + 1);
  const counts = new Map<string, number>();
  for (let commitIndex = start; commitIndex <= end; commitIndex += 1) {
    for (const nodeId of new Set(commits[commitIndex].changedNodeIds)) {
      counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
    }
  }
  return new Map(Array.from(counts, ([nodeId, count]) => [
    nodeId,
    count < HISTORY_HEAT_THRESHOLD ? 0 : Math.min(1, (count - HISTORY_HEAT_THRESHOLD + 1) / (HISTORY_HEAT_MAX_COUNT - HISTORY_HEAT_THRESHOLD + 1)),
  ]));
}

export interface HistoryFrame {
  index: number;
  commit: HistoryCommit;
  changedNodeIds: Set<string>;
  addedNodeIds: Set<string>;
  changedEdgeIds: Set<string>;
  edgeChangesKnown: boolean;
  changedNodes: CodeNode[];
}

export function historyFrames(graph: CodeGraph, commits = graph.history?.commits ?? []): HistoryFrame[] {
  const nodeById = new Map(graph.nodes.map((node, order) => [node.id, { node, order }]));
  return commits.map((commit, index) => {
    const changedNodeIds = new Set(commit.changedNodeIds);
    const addedNodeIds = new Set(commit.addedNodeIds);
    const changedEdgeIds = new Set(commit.changedEdgeIds ?? []);
    const changedNodes = [...changedNodeIds]
      .map(nodeId => nodeById.get(nodeId))
      .filter((entry): entry is { node: CodeNode; order: number } => entry !== undefined)
      .sort((left, right) => left.order - right.order)
      .map(entry => entry.node);
    return {
      index,
      commit,
      changedNodeIds,
      addedNodeIds,
      changedEdgeIds,
      edgeChangesKnown: commit.changedEdgeIds !== undefined,
      changedNodes,
    };
  });
}

export function historyFrame(graph: CodeGraph, index: number): HistoryFrame | null {
  return historyFrames(graph)[index] ?? null;
}

export function historyDurationMs(changedNodeCount: number): number {
  if (changedNodeCount === 0) return 220;
  return Math.min(6500, Math.max(1400, 850 + changedNodeCount * 48));
}

export function historyStaggerStepMs(changedNodeCount: number): number {
  return historyDurationMs(changedNodeCount) / Math.max(1, changedNodeCount);
}

export function historyActivity(orders: string[][], index: number, elapsedMs: number, speed: number, intervalMs = 0): HistoryActivity | null {
  if (index < 0 || orders.length === 0) return null;
  const lastUpdated = new Map<string, number>();
  let timeline = 0;
  for (let frameIndex = 0; frameIndex <= index; frameIndex += 1) {
    const order = orders[frameIndex] ?? [];
    const duration = historyDurationMs(order.length);
    const frameWindow = Math.max(duration, intervalMs);
    const step = historyStaggerStepMs(order.length);
    const frameElapsed = frameIndex === index ? Math.min(frameWindow, Math.max(0, elapsedMs * speed)) : frameWindow;
    order.forEach((nodeId, nodeIndex) => {
      const updateAt = timeline + nodeIndex * step;
      if (frameIndex < index || updateAt <= timeline + frameElapsed) lastUpdated.set(nodeId, updateAt);
    });
    timeline += frameElapsed;
  }
  const baseline = Math.max(0, Math.min(1, 1 - timeline / HISTORY_FADE_MS));
  const values = new Map<string, number>();
  lastUpdated.forEach((updatedAt, nodeId) => {
    values.set(nodeId, Math.max(0, Math.min(1, 1 - (timeline - updatedAt) / HISTORY_FADE_MS)));
  });
  return { values, baseline, elapsedMs: timeline, updatedAt: new Map(lastUpdated) };
}

export function historyFadeValue(activity: HistoryActivity | null, id: string, fadeMs: number): number {
  if (!activity) return 1;
  const updatedAt = activity.updatedAt.get(id);
  const age = updatedAt === undefined ? activity.elapsedMs : Math.max(0, activity.elapsedMs - updatedAt);
  return Math.max(0, Math.min(1, 1 - age / fadeMs));
}
