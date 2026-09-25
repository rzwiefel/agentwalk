import { historyFrames } from './history';
import type { CodeGraph, CodeNode, HistoryCommit } from './types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`History assertion failed: ${message}`);
}

const nodes: CodeNode[] = [
  { id: 'node:a', kind: 'var', label: 'a', namespace: 'app' },
  { id: 'node:b', kind: 'var', label: 'b', namespace: 'app' },
  { id: 'node:c', kind: 'var', label: 'c', namespace: 'app' },
];

const commit: HistoryCommit = {
  id: 'commit:1',
  hash: 'commit:1',
  shortHash: 'commit:1',
  message: 'Changed selected nodes',
  timestamp: '2026-08-25T00:00:00.000Z',
  changedNodeIds: ['node:c', 'missing', 'node:a', 'node:c'],
  addedNodeIds: [],
};

const graph: CodeGraph = {
  formatVersion: 2,
  generatedAt: '2026-08-25T00:00:00.000Z',
  repo: { name: 'history-fixture', root: '/fixture' },
  nodes,
  edges: [],
  stats: { nodes: nodes.length, edges: 0 },
  history: { commits: [commit] },
};

export function runHistoryAssertions(): void {
  const frame = historyFrames(graph)[0];
  expect(frame !== undefined, 'history frame is created');
  expect(frame.changedNodeIds.has('missing'), 'changed IDs retain unmapped history metadata');
  expect(frame.changedNodes.map(node => node.id).join(',') === 'node:a,node:c',
    'changed nodes retain graph order while skipping missing IDs');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('history', runHistoryAssertions);
