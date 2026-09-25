import { displayLabel, displayLabels, filterEdgesByVisibleNodes, filterTopLevelFolderConnections, isTopLevelFolderNode } from './graph';
import type { CodeNode } from './types';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Graph presentation assertion failed: ${message}`);
}

const tsNamespace: CodeNode = {
  id: 'namespace:module:frontend/src/components/action-panel',
  kind: 'namespace',
  label: 'namespace:module:frontend/src/components/action-panel',
  file: 'frontend/src/components/action-panel/index.ts',
};

const tsMember: CodeNode = {
  id: 'var:namespace:frontend/src/components/action-panel:activate@42',
  kind: 'var',
  label: 'var:namespace:frontend/src/components/action-panel:activate@42',
  fqn: 'frontend/src/components/action-panel.activate',
  namespace: tsNamespace.id,
};

export function runGraphPresentationAssertions(): void {
  expect(displayLabel(tsNamespace) === 'index.ts', 'module labels use a concise source basename');
  expect(displayLabel(tsMember) === 'activate', 'member labels strip parser identity and locations');
  expect(!displayLabel(tsNamespace).includes('namespace:module:'), 'module labels hide identity prefixes');
  expect(!displayLabel(tsMember).includes('var:namespace:'), 'member labels hide identity prefixes');
  expect(isTopLevelFolderNode({
    ...tsNamespace,
    id: 'namespace:module:sample-app',
    namespace: 'sample-app',
    file: undefined,
  }), 'top-level module folders are recognized');
  expect(!isTopLevelFolderNode(tsNamespace), 'nested modules are not top-level folders');
  const sampleApp = { ...tsNamespace, id: 'namespace:module:sample-app', namespace: 'sample-app', file: undefined };
  const sampleAppApi = { ...tsNamespace, id: 'namespace:module:sample-app-api', namespace: 'sample-app-api', file: undefined };
  const feature = { ...tsNamespace, id: 'namespace:module:packages/feature', namespace: 'packages/feature', file: 'packages/feature/index.ts' };
  const folderEdges = [
    { id: 'folder', kind: 'requires' as const, source: sampleApp.id, target: feature.id },
    { id: 'api', kind: 'requires' as const, source: sampleAppApi.id, target: feature.id },
    { id: 'feature', kind: 'requires' as const, source: feature.id, target: feature.id },
  ];
  expect(filterTopLevelFolderConnections(folderEdges, [sampleApp, sampleAppApi, feature], true).length === 3,
    'top-level folder connections are shown by default');
  expect(filterTopLevelFolderConnections(folderEdges, [sampleApp, sampleAppApi, feature], false).length === 1,
    'hiding top-level folder connections leaves feature relationships intact');
  expect(filterEdgesByVisibleNodes(folderEdges, new Set([feature.id])).length === 1,
    'edge endpoints are filtered when their nodes are hidden');
  expect(displayLabel({ id: 'package:@fixture/core', kind: 'var', label: 'package:@fixture/core' }) === '@fixture/core',
    'external package labels remain concise and non-empty');
  expect(displayLabel({ id: 'unresolved:hash', kind: 'var', label: 'unresolved:hash' }) === 'unresolved:hash',
    'unresolved labels retain a clear non-empty fallback');
  const collisions = displayLabels([
    { ...tsMember, id: `${tsMember.id}:a`, fqn: 'alpha.activate' },
    { ...tsMember, id: `${tsMember.id}:b`, fqn: 'beta.activate' },
  ]);
  expect(new Set(collisions.values()).size === 2, 'visible sibling collisions retain deterministic qualifiers');
  expect(displayLabel({ id: 'var:python.make_service', kind: 'var', label: 'make_service' }) === 'make_service',
    'Python labels are unchanged');
  expect(displayLabel({ id: 'var:demo.core/run', kind: 'var', label: 'run' }) === 'run',
    'Clojure labels are unchanged');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('graph presentation', runGraphPresentationAssertions);
