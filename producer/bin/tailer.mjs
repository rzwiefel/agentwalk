#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ActivityTransport } from "../src/transport.mjs";
import { SessionEventWatcher } from "../src/session-watcher.mjs";

const spoolDirectory = process.env.CODEWALK_SPOOL_DIR ?? path.join(os.homedir(), ".codewalk", "activity");
const sessionStateDirectory = process.env.COPILOT_SESSION_STATE_DIR ??
  path.join(process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot"), "session-state");
const sessionMode = process.env.CODEWALK_TAILER_MODE === "session-state";
const pidFile = path.join(spoolDirectory, sessionMode ? ".session-tailer.pid" : ".tailer.pid");
const intervalMs = Math.max(100, Number(process.env.CODEWALK_TAILER_INTERVAL_MS) || 250);
const maxRuntimeMs = Math.max(intervalMs, Number(process.env.CODEWALK_TAILER_MAX_RUNTIME_MS) || 30_000);
const idleExitMs = Math.max(intervalMs, Number(process.env.CODEWALK_TAILER_IDLE_EXIT_MS) || 2_000);
const lastReportedError = new Map();

function reportError(stage, error) {
  const now = Date.now();
  if (now - (lastReportedError.get(stage) ?? 0) < 5000) return;
  lastReportedError.set(stage, now);
  const code = typeof error?.code === "string" ? error.code : error?.name === "Error" ? "ERROR" : "UNKNOWN";
  console.error(`[codewalk activity] ${stage} failed (${code})`);
}

async function claim() {
  await fs.mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(pidFile, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") return false;
    try {
      const owner = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
      process.kill(owner, 0);
      return false;
    } catch (probeError) {
      if (probeError.code !== "ESRCH") return false;
      await fs.rm(pidFile, { force: true });
      return claim();
    }
  }
}

async function release() {
  try {
    const owner = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
    if (owner === process.pid) await fs.rm(pidFile, { force: true });
  } catch {}
}

if (await claim()) {
  let watcher;
  const stop = async () => {
    watcher?.stop();
    await release();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const transport = new ActivityTransport({ spool: undefined });
  try {
    if (sessionMode) {
      const workspaceRoot = process.env.CODEWALK_WORKSPACE_ROOT;
      if (!workspaceRoot) throw new Error("CODEWALK_WORKSPACE_ROOT is required for session-state mode");
      watcher = new SessionEventWatcher({
        sessionStateDirectory,
        workspaceRoot,
        allWorkspaces: process.env.CODEWALK_SESSION_ALL_WORKSPACES === "true",
        onEvent: event => transport.enqueue(event),
        maxFiles: process.env.CODEWALK_SESSION_MAX_FILES,
        maxLineBytes: process.env.CODEWALK_SESSION_MAX_LINE_BYTES,
        maxSeenIds: process.env.CODEWALK_SESSION_MAX_SEEN_IDS,
        maxKnownFiles: process.env.CODEWALK_SESSION_MAX_KNOWN_FILES,
        maxConcurrent: process.env.CODEWALK_SESSION_MAX_CONCURRENT,
      });
      while (!watcher.stopped) {
        try {
          await watcher.poll();
        } catch (error) {
          reportError("session watcher poll", error);
        }
        try {
          await transport.flush();
        } catch (error) {
          reportError("session watcher delivery", error);
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    } else {
      const started = Date.now();
      let lastPendingAt = started;
      while (Date.now() - started < maxRuntimeMs) {
        const pending = await transport.spool.read();
        if (pending.length) {
          lastPendingAt = Date.now();
          await transport.flush();
        } else if (Date.now() - lastPendingAt >= idleExitMs) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
  } catch (error) {
    reportError(sessionMode ? "session watcher" : "spool tailer", error);
  }
  await release();
}
