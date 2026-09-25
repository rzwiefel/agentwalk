import crypto from 'node:crypto';
import path from 'node:path';
import { analyzeProject, ParserGraph, stableJson } from '../src/index.js';

const graph = analyzeProject({ rootDir: path.resolve('fixtures/workspace') });
const projection: Pick<ParserGraph, 'nodes' | 'edges' | 'diagnostics'> = {
  nodes: graph.nodes,
  edges: graph.edges,
  diagnostics: graph.diagnostics,
};
const digest = crypto.createHash('sha256').update(stableJson(projection)).digest('hex');
console.log(JSON.stringify({ algorithm: 'sha256', digest }, null, 2));
