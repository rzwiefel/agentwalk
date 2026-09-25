import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject, ParserGraph, stableJson } from '../src/index.js';

const root = path.resolve('fixtures/workspace');

function graphProjection(graph: ParserGraph): unknown {
  return {
    nodes: graph.nodes,
    edges: graph.edges,
    diagnostics: graph.diagnostics,
  };
}

function digest(graph: ParserGraph): string {
  return crypto.createHash('sha256').update(stableJson(graphProjection(graph))).digest('hex');
}

test('compiler API graph is deterministic and semantically rich', () => {
  const first = analyzeProject({ rootDir: root });
  const second = analyzeProject({ rootDir: root });
  assert.equal(digest(first), digest(second));
  assert.ok(first.nodes.some((node) => node.id === 'namespace:package:@fixture/core'));
  assert.ok(first.nodes.some((node) => node.varKind === 'interface' && node.label === 'SharedThing'));
  assert.ok(first.nodes.some((node) => node.varKind === 'jsx-intrinsic' && node.label === 'section'));
  assert.ok(first.edges.some((edge) => edge.kind === 'requires' && edge.provenance === 'commonjs-require'));
  assert.ok(first.edges.some((edge) => edge.kind === 'reexports'));
  assert.ok(first.edges.some((edge) => edge.kind === 'extends'));
  assert.ok(first.edges.some((edge) => edge.kind === 'implements'));
  assert.ok(first.edges.some((edge) => edge.kind === 'overrides'));
  assert.ok(first.edges.some((edge) => edge.kind === 'calls' && edge.resolution === 'resolved'));
  assert.ok(first.edges.some((edge) => edge.kind === 'mentions' && edge.detail?.jsxKind === 'intrinsic'));
  assert.ok(first.edges.some((edge) => edge.kind === 'mentions' && edge.detail?.jsxKind === 'component'));
  assert.ok(first.edges.some((edge) => edge.resolution === 'unresolved'));
  assert.ok(first.diagnostics.some((diagnostic) => diagnostic.category === 'error'));
  const golden = JSON.parse(fs.readFileSync(path.resolve('fixtures/golden.json'), 'utf8')) as { algorithm: string; digest: string };
  assert.equal(golden.algorithm, 'sha256');
  assert.equal(digest(first), golden.digest);
});

test('spans are repository-relative and slice the original source', () => {
  const graph = analyzeProject({ rootDir: root });
  for (const node of graph.nodes) {
    if (!node.span || node.external) continue;
    const text = fs.readFileSync(path.join(root, node.span.file), 'utf8');
    assert.ok(!path.isAbsolute(node.span.file));
    assert.ok(node.span.row >= 1 && node.span.col >= 1);
    for (const occurrence of node.occurrences) {
      const occurrenceText = fs.readFileSync(path.join(root, occurrence.span.file), 'utf8');
      assert.equal(occurrenceText.slice(occurrence.span.start, occurrence.span.end), occurrence.text);
    }
  }
});

test('equivalent workspaces in different absolute directories produce the same projection', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codewalk-ts-portable-'));
  const firstParent = path.join(temporaryRoot, 'with-host-dependency');
  const secondParent = path.join(temporaryRoot, 'without-host-dependency');
  const firstRoot = path.join(firstParent, 'parser-integration-qa');
  const secondRoot = path.join(secondParent, 'parser-integration');
  try {
    fs.mkdirSync(path.join(firstParent, 'node_modules', 'react'), { recursive: true });
    fs.writeFileSync(
      path.join(firstParent, 'node_modules', 'react', 'package.json'),
      JSON.stringify({ name: 'react', types: 'index.d.ts' }),
    );
    fs.writeFileSync(
      path.join(firstParent, 'node_modules', 'react', 'index.d.ts'),
      'export namespace JSX { interface Element {} interface IntrinsicElements { [name: string]: unknown } }\n',
    );
    fs.writeFileSync(
      path.join(firstParent, 'node_modules', 'react', 'jsx-runtime.d.ts'),
      'export declare const Fragment: unknown;\nexport declare function jsx(): unknown;\nexport declare function jsxs(): unknown;\n',
    );
    fs.cpSync(root, firstRoot, { recursive: true });
    fs.cpSync(root, secondRoot, { recursive: true });
    const first = analyzeProject({ rootDir: firstRoot });
    const second = analyzeProject({ rootDir: secondRoot });
    assert.deepEqual(first, second);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('incremental ownership invalidation converges to full analysis', () => {
  const full = analyzeProject({ rootDir: root, mode: 'full' });
  const incremental = analyzeProject({
    rootDir: root,
    mode: 'incremental',
    previous: full,
    changedFiles: ['packages/shared/src/util.ts'],
  });
  assert.deepEqual(graphProjection(incremental), graphProjection(full));
  assert.deepEqual(incremental.analysis.changedFiles, ['packages/shared/src/util.ts']);
  assert.ok(incremental.analysis.invalidatedFiles.includes('packages/shared/src/util.ts'));
  assert.ok(incremental.analysis.ownership.some((item) => item.file === 'packages/core/src/core.ts'));
});

test('compiler libraries stay external and never leak host paths', () => {
  const temporaryRoots = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'codewalk-ts-lib-a-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'codewalk-ts-lib-b-')),
  ];
  try {
    for (const temporaryRoot of temporaryRoots) {
      fs.writeFileSync(
        path.join(temporaryRoot, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { lib: ['dom', 'es2022'], strict: true }, include: ['src/**/*.ts'] }),
      );
      fs.mkdirSync(path.join(temporaryRoot, 'src'));
      fs.writeFileSync(
        path.join(temporaryRoot, 'src', 'window.ts'),
        'declare global { interface Window { codewalkMarker: string; } }\nexport function readWindow(window: Window, document: Document): string { return document.title + window.location.href; }\n',
      );
    }
    const graph = analyzeProject({ rootDir: temporaryRoots[0] });
    const relocated = analyzeProject({ rootDir: temporaryRoots[1] });
    const serialized = JSON.stringify(graph);
    assert.deepEqual(graphProjection(relocated), graphProjection(graph));
    assert.doesNotMatch(serialized, /(?:^|[/\\])\.\.(?:[/\\]|$)/);
    assert.doesNotMatch(serialized, /(?:^|[/\\])Users[/\\].*worktrees/);
    assert.ok(graph.nodes.some((node) => node.external && node.label === 'Document' && node.id.includes('typescript/lib/lib.dom.d.ts')));
    for (const node of graph.nodes) {
      if (node.file) assertSafeRelativePath(node.file);
      for (const occurrence of node.occurrences) assertSafeRelativePath(occurrence.span.file);
    }
    for (const edge of graph.edges) assertSafeRelativePath(edge.span.file);
    for (const ownership of graph.analysis.ownership) assertSafeRelativePath(ownership.file);
  } finally {
    for (const temporaryRoot of temporaryRoots) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function assertSafeRelativePath(file: string): void {
  assert.equal(path.isAbsolute(file), false);
  assert.equal(file === '..' || file.startsWith('../'), false);
}
