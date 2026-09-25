import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 1000;
const DEFAULT_NEAR_DUPLICATE_WINDOW_MS = 200;
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 500;
const LOCK_STALE_MS = 5000;
const DEFAULT_RUNTIME_DIR = path.join(os.homedir(), ".codewalk", "runtime");
const DIAGNOSTICS_LOG_NAME = "spool-diagnostics.log";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function acquire(directory, name, timeoutMs = LOCK_TIMEOUT_MS) {
  const lock = path.join(directory, `.${name}.lock`);
  const started = Date.now();
  while (true) {
    try {
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, "owner"), `${process.pid}\n`, { mode: 0o600 });
      return async () => fs.rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lock);
        const oldEnoughToReclaim = Date.now() - stat.mtimeMs >= LOCK_STALE_MS;
        let ownerAlive = true;
        try {
          const owner = Number.parseInt(await fs.readFile(path.join(lock, "owner"), "utf8"), 10);
          if (!Number.isSafeInteger(owner) || owner <= 0) ownerAlive = false;
          else {
            try { process.kill(owner, 0); } catch (probeError) {
              ownerAlive = probeError.code !== "ESRCH";
            }
          }
        } catch {
          // mkdir and owner-file creation are separate operations. A missing
          // owner marker on a fresh lock is still an active acquisition.
          ownerAlive = !oldEnoughToReclaim;
        }
        if (!ownerAlive && oldEnoughToReclaim) {
          await fs.rm(lock, { recursive: true, force: true });
        }
      } catch {}
      if (Date.now() - started >= timeoutMs) throw new Error(`spool ${name} lock timeout`);
      await sleep(LOCK_WAIT_MS);
    }
  }
}

async function withLock(directory, name, fn, timeoutMs) {
  const release = await acquire(directory, name, timeoutMs);
  try { return await fn(); } finally { await release(); }
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeResource(resource) {
  if (!resource || typeof resource !== "object") return undefined;
  const resourcePath = typeof resource.path === "string" &&
    !path.isAbsolute(resource.path) && !/^[A-Za-z]:[\\/]/.test(resource.path) &&
    !resource.path.split(/[\\/]/).includes("..")
    ? resource.path
    : undefined;
  return {
    path: resourcePath,
    action: typeof resource.action === "string" ? resource.action : undefined,
    kind: typeof resource.kind === "string" ? resource.kind : undefined,
    confidence: typeof resource.confidence === "string" ? resource.confidence : undefined,
    outsideRoot: resource.outsideRoot === true,
  };
}

function nearDuplicateFingerprint(event) {
  if (!event || event.source?.kind !== "hook" ||
      timestampMs(event.timestamp) === undefined) return undefined;
  const resources = Array.isArray(event.resources)
    ? event.resources.map(safeResource).filter(Boolean).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)))
    : [];
  const identity = {
    sessionId: event.sessionId,
    type: event.type,
    status: event.status,
    tool: event.tool,
    parentId: event.parentId,
    agentId: event.agentId,
    turnId: event.turnId,
    toolCallId: event.toolCallId,
    workspaceId: event.workspace?.id,
    providerEventType: event.metadata?.providerEventType,
    resources,
  };
  return crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function parseNearDuplicateRecord(value) {
  if (!value || typeof value !== "object" ||
      typeof value.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.fingerprint)) return undefined;
  const timestamp = timestampMs(value.timestamp);
  return timestamp === undefined ? undefined : { fingerprint: value.fingerprint, timestamp };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function recordIdentity(event) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(event))).digest("hex");
}

export class BoundedSpool {
  constructor(directory, {
    maxBytes = DEFAULT_MAX_BYTES,
    maxEvents = DEFAULT_MAX_EVENTS,
    nearDuplicateWindowMs = DEFAULT_NEAR_DUPLICATE_WINDOW_MS,
    maxNearDuplicateEntries = maxEvents,
    runtimeDir = process.env.CODEWALK_RUNTIME_DIR ?? DEFAULT_RUNTIME_DIR,
  } = {}) {
    this.directory = directory;
    this.file = path.join(directory, "events.jsonl");
    this.nearDuplicateFile = path.join(directory, "near-duplicates.jsonl");
    this.maxBytes = Math.max(1, maxBytes);
    this.maxEvents = Math.max(1, maxEvents);
    this.nearDuplicateWindowMs = Number.isFinite(Number(nearDuplicateWindowMs))
      ? Math.max(0, Number(nearDuplicateWindowMs))
      : DEFAULT_NEAR_DUPLICATE_WINDOW_MS;
    this.maxNearDuplicateEntries = Math.max(1, Number.isSafeInteger(Number(maxNearDuplicateEntries))
      ? Number(maxNearDuplicateEntries)
      : maxEvents);
    this.runtimeDir = runtimeDir;
    this.diagnosticsLog = path.join(runtimeDir, DIAGNOSTICS_LOG_NAME);
    // Set after every read() call to the number of spool lines that failed to
    // parse as JSON and were silently dropped from that read's result.
    this.lastDroppedLines = 0;
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { await fs.chmod(this.directory, 0o700); } catch {}
    try { await fs.chmod(this.file, 0o600); } catch {}
    try { await fs.chmod(this.nearDuplicateFile, 0o600); } catch {}
  }

  async withLock(name, fn, timeoutMs) {
    await this.initialize();
    return withLock(this.directory, name, fn, timeoutMs);
  }

  async append(event) {
    await this.initialize();
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line) > this.maxBytes) return false;
    return this.withLock("mutate", async () => {
      // The ledger is shared by hook processes and stores only hashes plus time.
      const fingerprint = nearDuplicateFingerprint(event);
      const eventTimestamp = timestampMs(event?.timestamp);
      const nearDuplicates = fingerprint ? await this.readNearDuplicates() : [];
      if (fingerprint && eventTimestamp !== undefined &&
          nearDuplicates.some(record => record.fingerprint === fingerprint &&
            Math.abs(eventTimestamp - record.timestamp) <= this.nearDuplicateWindowMs)) return false;
      await fs.appendFile(this.file, line, { mode: 0o600, flag: "a" });
      await this.compactUnlocked();
      if (fingerprint && eventTimestamp !== undefined) {
        nearDuplicates.push({ fingerprint, timestamp: eventTimestamp });
        await this.writeNearDuplicates(nearDuplicates.slice(-this.maxNearDuplicateEntries));
      }
      return true;
    });
  }

  async readNearDuplicates() {
    try {
      const text = await fs.readFile(this.nearDuplicateFile, "utf8");
      return text.split("\n").map(line => {
        try { return parseNearDuplicateRecord(JSON.parse(line)); } catch { return undefined; }
      }).filter(Boolean).slice(-this.maxNearDuplicateEntries);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async writeNearDuplicates(records) {
    const text = records.map(record => JSON.stringify(record)).join("\n");
    await fs.writeFile(this.nearDuplicateFile, text ? `${text}\n` : "", { mode: 0o600 });
  }

  async read() {
    try {
      const text = await fs.readFile(this.file, "utf8");
      let dropped = 0;
      const events = text.split("\n").filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { dropped += 1; return undefined; }
      }).filter(Boolean);
      this.lastDroppedLines = dropped;
      if (dropped > 0) await this.recordDroppedLines(dropped);
      return events;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  // Corrupt lines are dropped from read()'s result with no other trace, so a
  // truncated or otherwise malformed spool file could previously lose events
  // silently. Record only a count -- never line content -- to a small
  // diagnostics log, mirroring transport.mjs's recordPermanentRejection.
  async recordDroppedLines(count) {
    try {
      await fs.mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
      try { await fs.chmod(this.runtimeDir, 0o700); } catch {}
      await fs.appendFile(this.diagnosticsLog, `${JSON.stringify({ droppedLines: count })}\n`, { mode: 0o600 });
      try { await fs.chmod(this.diagnosticsLog, 0o600); } catch {}
    } catch {}
  }

  async compactUnlocked() {
    const events = await this.read();
    let kept = events.slice(-this.maxEvents);
    let text = kept.map(event => JSON.stringify(event)).join("\n");
    while (Buffer.byteLength(text) + (text ? 1 : 0) > this.maxBytes && kept.length > 1) {
      kept = kept.slice(1);
      text = kept.map(event => JSON.stringify(event)).join("\n");
    }
    await fs.writeFile(this.file, text ? `${text}\n` : "", { mode: 0o600 });
  }

  async acknowledge(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    const identity = recordIdentity(event);
    return this.withLock("mutate", async () => {
      const events = await this.read();
      const index = events.findIndex(candidate => recordIdentity(candidate) === identity);
      if (index < 0) return false;
      const remaining = [...events.slice(0, index), ...events.slice(index + 1)];
      if (remaining.length !== events.length) {
        await fs.writeFile(this.file, remaining.map(event => JSON.stringify(event)).join("\n") + (remaining.length ? "\n" : ""), { mode: 0o600 });
        return true;
      }
      return false;
    });
  }

  async size() {
    try { return (await fs.stat(this.file)).size; } catch (error) { return error.code === "ENOENT" ? 0 : Promise.reject(error); }
  }
}
