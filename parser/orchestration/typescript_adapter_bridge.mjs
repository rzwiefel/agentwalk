#!/usr/bin/env node
/*
 * Thin translation wrapper for the TypeScript adapter. Build it first:
 * npm --prefix parser/typescript-javascript run build
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dispatcherRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rootDir = path.resolve(process.argv[2] ?? ".");
const projectFile = process.argv[3] ? path.resolve(rootDir, process.argv[3]) : undefined;
const moduleUrl = pathToFileURL(path.join(dispatcherRoot, "parser", "typescript-javascript", "dist", "index.js")).href;
try {
  const { analyzeProject } = await import(moduleUrl);
  const graph = analyzeProject({ rootDir, projectFile });
  process.stdout.write(JSON.stringify(graph) + "\n");
} catch (error) {
  process.stderr.write(`TypeScript adapter bridge failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
