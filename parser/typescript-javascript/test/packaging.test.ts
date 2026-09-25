import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const adapterDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const checkoutRoot = path.resolve(adapterDir, '..', '..');
const bridge = path.join(checkoutRoot, 'parser', 'orchestration', 'typescript_adapter_bridge.mjs');
const fixtureRoot = path.join(adapterDir, 'fixtures', 'workspace');

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('clean build publishes the bridge entrypoint and analyzes a workspace', { timeout: 120_000 }, async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codewalk-ts-package-'));
  const cleanAdapterDir = path.join(temporaryRoot, 'typescript-javascript');
  try {
    fs.cpSync(adapterDir, cleanAdapterDir, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(adapterDir, source);
        const excludedDirectories = new Set(['dist', '.test-dist', 'node_modules']);
        const firstSegment = relative.split(path.sep, 1)[0];
        return !relative || !excludedDirectories.has(firstSegment);
      },
    });
    assert.equal(fs.existsSync(path.join(cleanAdapterDir, 'dist')), false);

    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    run(npm, ['ci'], cleanAdapterDir);
    run(npm, ['run', 'build'], cleanAdapterDir);

    const entrypoint = path.join(cleanAdapterDir, 'dist', 'index.js');
    assert.equal(fs.existsSync(entrypoint), true);
    assert.equal(fs.existsSync(path.join(cleanAdapterDir, 'dist', 'src', 'index.js')), false);
    const module = await import(pathToFileURL(entrypoint).href);
    assert.equal(typeof module.analyzeProject, 'function');

    const output = run(process.execPath, [bridge, fixtureRoot, path.join(fixtureRoot, 'tsconfig.json')], checkoutRoot);
    const graph = JSON.parse(output) as { formatVersion?: number; nodes?: unknown[]; edges?: unknown[] };
    assert.equal(graph.formatVersion, 1);
    assert.ok((graph.nodes?.length ?? 0) > 0);
    assert.ok((graph.edges?.length ?? 0) > 0);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
