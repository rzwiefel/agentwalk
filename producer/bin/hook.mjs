#!/usr/bin/env node
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeHook } from "../src/contract.mjs";
import { ActivityTransport } from "../src/transport.mjs";

const hookName = process.argv[2];

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let payload = {};
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
  const event = normalizeHook(hookName, payload, {
    client: process.env.CODEWALK_CLIENT ?? "copilot-cli",
    version: process.env.COPILOT_VERSION,
    workspaceRoot: process.env.CODEWALK_WORKSPACE_ROOT ?? payload.cwd,
  });
  const transport = new ActivityTransport();
  try {
    await transport.enqueue(event);
  } catch {
    // Hooks must never alter or fail the agent's action because ingestion is down.
  }
  if (process.env.CODEWALK_DISABLE_TAILER !== "1") {
    try {
      const tailer = path.join(path.dirname(fileURLToPath(import.meta.url)), "tailer.mjs");
      const child = spawn(process.execPath, [tailer], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CODEWALK_SPOOL_DIR: transport.spool.directory },
      });
      child.unref();
    } catch {}
  }
} catch {
  // A telemetry failure must never block the Copilot action being observed.
}
process.stdout.write("{}");
