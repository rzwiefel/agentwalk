import { isGlobalNode, isTestNode, testNamespacesForGraph } from './namespaceVisibility';
import type { CodeNode } from './types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Namespace visibility assertion failed: ${message}`);
}

export function runNamespaceVisibilityAssertions(): void {
  const production: CodeNode = { id: 'namespace:prod', kind: 'namespace', label: 'contest', namespace: 'contest', file: 'src/contest.ts' };
  const testAnchor: CodeNode = { id: 'namespace:test', kind: 'namespace', label: 'Acme', namespace: 'Acme', file: 'tests/fixtures/acme.ts' };
  const ownedTestNode: CodeNode = { id: 'var:test-node', kind: 'var', label: 'run', namespace: 'Acme' };
  const global: CodeNode = { id: 'namespace:global', kind: 'namespace', label: '<global>', namespace: '<global>' };
  const unscoped: CodeNode = { id: 'var:unscoped', kind: 'var', label: 'run' };
  const unresolved: CodeNode = { id: 'unresolved:hash', kind: 'var', label: 'Missing.Type', namespace: '<global>', synthetic: true };
  const testNamespaces = testNamespacesForGraph({ nodes: [production, testAnchor, ownedTestNode, global, unscoped, unresolved] });
  expect(testNamespaces.has('Acme'), 'test path classification propagates to an anchor');
  expect(isTestNode(ownedTestNode, testNamespaces), 'owned nodes share anchor classification');
  expect(!isTestNode(production, testNamespaces), 'production names containing test substrings remain visible');
  expect(isGlobalNode(global), 'synthetic global anchor is global-owned');
  expect(isGlobalNode(unscoped), 'namespace-less nodes are global-owned');
  expect(!isGlobalNode(unresolved), 'unresolved targets are not treated as global-owned');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('namespace visibility', runNamespaceVisibilityAssertions);
