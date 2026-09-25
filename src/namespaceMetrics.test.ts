import { buildNamespaceMetrics } from './namespaceMetrics';
import type { CodeGraph, CodeNode } from './types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Namespace metrics assertion failed: ${message}`);
}

const nodes: CodeNode[] = [
  { id: 'namespace:app', kind: 'namespace', label: 'app', namespace: 'app' },
  { id: 'var:app/a', kind: 'var', label: 'a', namespace: 'app' },
  { id: 'var:app/b', kind: 'var', label: 'b', namespace: 'app' },
  { id: 'namespace:lib', kind: 'namespace', label: 'lib', namespace: 'lib' },
  { id: 'var:lib/c', kind: 'var', label: 'c', namespace: 'lib' },
  { id: 'namespace:external', kind: 'namespace', label: 'external', namespace: 'external', external: true },
];

const graph: CodeGraph = {
  formatVersion: 2,
  generatedAt: '2026-08-25T00:00:00.000Z',
  repo: { name: 'metrics-fixture', root: '/fixture' },
  nodes,
  edges: [
    { id: 'calls:app', kind: 'calls', source: 'var:app/a', target: 'var:app/b' },
    { id: 'requires:app-lib', kind: 'requires', source: 'var:app/a', target: 'var:lib/c' },
  ],
  stats: { nodes: nodes.length, edges: 2 },
};

export function runNamespaceMetricsAssertions(): void {
  const metrics = buildNamespaceMetrics(graph);
  const internalMetrics = buildNamespaceMetrics(graph, false);
  expect(metrics.get('app')?.cohesion === 1, 'connected vars have full cohesion');
  expect(metrics.get('lib')?.cohesion === 1, 'single-var namespaces have full cohesion');
  expect(metrics.get('app')?.cohesionComponents === 1, 'connected vars form one cohesion component');
  expect(!internalMetrics.has('external'), 'internal-only metrics omit external namespaces');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('namespace metrics', runNamespaceMetricsAssertions);
