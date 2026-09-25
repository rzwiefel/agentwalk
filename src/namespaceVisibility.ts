import type { CodeGraph, CodeNode } from './types';

const GLOBAL_NAMESPACE = '<global>';
const EXACT_TEST_SEGMENTS = new Set([
  'test',
  'tests',
  'unittest',
  'unittests',
  'integrationtest',
  'integrationtests',
  'functionaltest',
  'functionaltests',
  'acceptancetest',
  'acceptancetests',
  'spec',
  'specs',
]);
const TEST_PATH_SEGMENT = /^(?:test|tests|spec|specs|unit[-_.]?tests?|integration[-_.]?tests?|functional[-_.]?tests?|acceptance[-_.]?tests?)$/i;
const TEST_SUFFIX = /(?:Test|Tests|Spec|Specs)$/;

function pathSegments(value: string | undefined): string[] {
  return value?.split(/[/.\\_-]+/).filter(Boolean) ?? [];
}

function hasTestSegment(value: string | undefined): boolean {
  return pathSegments(value).some(segment => {
    const normalized = segment.toLowerCase();
    return EXACT_TEST_SEGMENTS.has(normalized) || TEST_SUFFIX.test(segment);
  });
}

function hasTestPath(value: string | undefined): boolean {
  if (!value) return false;
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.slice(0, -1).some(segment => TEST_PATH_SEGMENT.test(segment))
    || TEST_PATH_SEGMENT.test(segments.at(-1)?.replace(/\.[^.]+$/, '') ?? '')
    || TEST_SUFFIX.test(segments.at(-1)?.replace(/\.[^.]+$/, '') ?? '');
}

export function isGlobalNamespaceName(namespace: string | undefined): boolean {
  return namespace === undefined || namespace === GLOBAL_NAMESPACE || namespace === '';
}

export function isGlobalNode(node: CodeNode): boolean {
  return !node.synthetic && isGlobalNamespaceName(node.namespace);
}

export function isTestNamespaceName(namespace: string | undefined): boolean {
  return namespace !== undefined && hasTestSegment(namespace);
}

export function testNamespacesForGraph(graph: Pick<CodeGraph, 'nodes'>): Set<string> {
  const testNamespaces = new Set<string>();
  graph.nodes
    .filter(node => node.kind === 'namespace')
    .forEach(node => {
      const namespace = node.namespace ?? node.label;
      if (isTestNamespaceName(namespace)
        || hasTestPath(node.file)
        || hasTestPath(node.projectPath)
        || hasTestSegment(node.projectName)
        || hasTestSegment(node.assemblyName)
        || hasTestSegment(node.projectId)) {
        testNamespaces.add(namespace);
      }
    });
  return testNamespaces;
}

export function isTestNode(node: CodeNode, testNamespaces?: ReadonlySet<string>): boolean {
  const namespace = node.kind === 'namespace' ? node.namespace ?? node.label : node.namespace;
  return (namespace !== undefined && (testNamespaces?.has(namespace) === true || isTestNamespaceName(namespace)))
    || hasTestPath(node.file)
    || hasTestPath(node.projectPath)
    || hasTestSegment(node.projectName)
    || hasTestSegment(node.assemblyName)
    || hasTestSegment(node.projectId);
}
