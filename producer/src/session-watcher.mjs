import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalWorkspaceRoot, normalizeEvent } from "./contract.mjs";
import { normalizeResourcePath } from "./paths.mjs";
import { redactString } from "./redact.mjs";

const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_LINE_BYTES = 256 * 1024;
const DEFAULT_MAX_SEEN_IDS = 2048;
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_KNOWN_FILES = 256;
const ACTIVITY_TYPES = new Map([
  ["session.start", "session.start"],
  ["session.resume", "session.resume"],
  ["session.idle", "session.idle"],
  ["session.shutdown", "session.shutdown"],
  ["session.error", "session.error"],
  ["session.warning", "session.warning"],
  ["session.context_changed", "session.context_changed"],
  ["session.task_complete", "session.task_complete"],
  ["user.message", "user.message"],
  ["assistant.message", "assistant.message"],
  ["assistant.message_delta", "assistant.message_delta"],
  ["tool.execution_start", "tool.execution_start"],
  ["tool.execution_complete", "tool.execution_complete"],
  ["permission.requested", "permission.requested"],
  ["permission.completed", "permission.completed"],
  ["subagent.started", "subagent.started"],
  ["subagent.completed", "subagent.completed"],
  ["subagent.failed", "subagent.failed"],
  ["external_tool.requested", "tool.execution_start"],
  ["external_tool.completed", "tool.execution_complete"],
]);

const WORKSPACE_KEYS = new Set([
  "cwd", "workingDirectory", "workspaceRoot", "repositoryPath", "repoPath",
]);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function sessionName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : undefined;
}

function displaySessionName(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return redactString(normalized, { preservePaths: true }).slice(0, 160);
}

function agentName(raw) {
  const data = objectValue(raw?.data);
  const candidates = [
    raw?.agentName, raw?.agentLabel,
    data?.agentName, data?.agentLabel,
    raw?.agent?.name, raw?.agent?.label,
    data?.agent?.name, data?.agent?.label,
  ];
  for (const value of candidates) {
    const name = displaySessionName(value);
    if (name) return name;
  }
  return undefined;
}

async function readSessionName(sessionDirectory) {
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(sessionDirectory, "vscode.metadata.json"), "utf8"));
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
    for (const value of [metadata.customTitle, metadata.sessionName, metadata.title]) {
      const name = displaySessionName(value);
      if (name) return name;
    }
    return undefined;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function sessionIdFromFile(file) {
  const name = path.basename(path.dirname(file));
  return sessionName(name);
}

function objectValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function workspaceCandidate(raw) {
  const data = objectValue(raw?.data);
  const candidates = [];
  for (const source of [raw, data]) {
    if (!source || typeof source !== "object") continue;
    for (const key of WORKSPACE_KEYS) {
      if (typeof source[key] === "string") candidates.push(source[key]);
    }
    if (source.context && typeof source.context === "object") {
      for (const key of WORKSPACE_KEYS) {
        if (typeof source.context[key] === "string") candidates.push(source.context[key]);
      }
    }
  }
  return candidates;
}

function dedupeKey(raw, sessionId) {
  if (typeof raw.id === "string" && raw.id) return `${sessionId}:${raw.id}`;
  return `${sessionId}:${crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex")}`;
}

function mappedEvent(raw) {
  const type = typeof raw?.type === "string" ? ACTIVITY_TYPES.get(raw.type) : undefined;
  if (!type) return undefined;
  const data = objectValue(raw.data);
  const source = data && typeof data === "object" ? { ...raw, ...data } : raw;
  const candidateArgs = source?.toolArgs ?? source?.toolArguments ?? source?.arguments;
  const toolArgs = candidateArgs && typeof candidateArgs === "object" ? candidateArgs : undefined;
  return toolArgs === undefined
    ? { ...raw, type }
    : { ...raw, type, data: { ...data, toolArgs } };
}

async function statFile(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

async function prefixFingerprint(file, offset) {
  if (offset <= 0) return "";
  let handle;
  try {
    handle = await fs.open(file, "r");
    const start = Math.max(0, offset - 128);
    const buffer = Buffer.alloc(offset - start);
    const result = await handle.read(buffer, 0, buffer.length, start);
    return crypto.createHash("sha256").update(buffer.subarray(0, result.bytesRead)).digest("hex");
  } catch {
    return undefined;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export class SessionEventWatcher {
  constructor({
    sessionStateDirectory,
    workspaceRoot,
    allWorkspaces = false,
    onEvent,
    maxFiles = DEFAULT_MAX_FILES,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    maxSeenIds = DEFAULT_MAX_SEEN_IDS,
    maxKnownFiles = DEFAULT_MAX_KNOWN_FILES,
    maxConcurrent = 4,
    readChunkBytes = DEFAULT_READ_CHUNK_BYTES,
  } = {}) {
    if (!sessionStateDirectory || !workspaceRoot || typeof onEvent !== "function") {
      throw new TypeError("sessionStateDirectory, workspaceRoot, and onEvent are required");
    }
    this.sessionStateDirectory = path.resolve(sessionStateDirectory);
    this.workspaceRoot = canonicalWorkspaceRoot(workspaceRoot);
    this.allWorkspaces = allWorkspaces;
    this.onEvent = onEvent;
    this.maxFiles = positiveInteger(maxFiles, DEFAULT_MAX_FILES);
    this.maxLineBytes = positiveInteger(maxLineBytes, DEFAULT_MAX_LINE_BYTES);
    this.maxSeenIds = positiveInteger(maxSeenIds, DEFAULT_MAX_SEEN_IDS);
    this.maxKnownFiles = Math.max(this.maxFiles, positiveInteger(maxKnownFiles, DEFAULT_MAX_KNOWN_FILES));
    this.maxConcurrent = positiveInteger(maxConcurrent, 4);
    this.readChunkBytes = positiveInteger(readChunkBytes, DEFAULT_READ_CHUNK_BYTES);
    this.files = new Map();
    this.sessionNames = new Map();
    this.knownFiles = new Map();
    this.evictedFiles = new Map();
    this.seenIds = new Set();
    this.pollNumber = 0;
    this.initialSnapshotComplete = false;
    this.started = false;
    this.stopped = false;
  }

  async discover() {
    let entries;
    try {
      entries = await fs.readdir(this.sessionStateDirectory, { withFileTypes: true });
    } catch (error) {
      // A session-state directory that does not exist yet means "no sessions",
      // which is expected and benign. Anything else (EACCES, EPERM, a stale
      // mount, ...) is a real problem and must not be reported as "no
      // sessions" -- surface it so the caller's poll() loop (which already
      // catches and reports poll errors) sees it.
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    const files = [];
    const unavailable = [];
    for (const entry of entries) {
      const id = sessionName(entry.name);
      if (!id || !entry.isDirectory()) continue;
      const file = path.join(this.sessionStateDirectory, id, "events.jsonl");
      try {
        const stat = await fs.stat(file);
        if (stat.isFile()) files.push({ file, modified: stat.mtimeMs });
      } catch (error) {
        if (error.code !== "ENOENT" && this.files.has(file)) unavailable.push(file);
      }
    }
    files.sort((left, right) => right.modified - left.modified);
    const selected = files.slice(0, this.maxFiles);
    const sessionNames = new Map();
    for (const { file } of selected) {
      const name = await readSessionName(path.dirname(file));
      if (name) sessionNames.set(file, name);
    }
    return {
      allFiles: files.map(({ file }) => file),
      files: selected.map(({ file }) => file),
      sessionNames,
      unavailable,
    };
  }

  async contextScan(file, state, size) {
    let handle;
    let position = 0;
    let remainder = Buffer.alloc(0);
    try {
      handle = await fs.open(file, "r");
      const buffer = Buffer.alloc(this.readChunkBytes);
      while (position < size) {
        const length = Math.min(buffer.length, size - position);
        const result = await handle.read(buffer, 0, length, position);
        if (!result.bytesRead) break;
        position += result.bytesRead;
        let chunk = buffer.subarray(0, result.bytesRead);
        if (remainder.length) {
          chunk = Buffer.concat([remainder, chunk]);
          remainder = Buffer.alloc(0);
        }
        let start = 0;
        while (start < chunk.length) {
          const end = chunk.indexOf(0x0a, start);
          if (end < 0) {
            const pending = chunk.subarray(start);
            remainder = pending.length <= this.maxLineBytes ? Buffer.from(pending) : Buffer.alloc(0);
            break;
          }
          const line = chunk.subarray(start, end);
          start = end + 1;
          if (!line.length || line.length > this.maxLineBytes) continue;
          try {
            const raw = JSON.parse(line.toString("utf8"));
            if (raw && typeof raw === "object" && !Array.isArray(raw)) {
              const attributed = this.workspaceAttribution(raw);
              if (attributed !== undefined) state.attributed = attributed;
            }
          } catch {
            // Historical malformed lines do not affect attribution.
          }
        }
      }
    } catch {
      // The file may disappear while its skipped prefix is being scanned.
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async createFileState(file, mode) {
    const stat = await statFile(file);
    if (!stat) return;
    const state = {
      identity: `${stat.dev}:${stat.ino}`,
      offset: mode === "new" ? 0 : stat.size,
      readOffset: mode === "new" ? 0 : stat.size,
      remainder: Buffer.alloc(0),
      oversize: false,
      attributed: false,
      tailHash: undefined,
    };
    if (mode !== "new") await this.contextScan(file, state, stat.size);
    state.tailHash = await prefixFingerprint(file, state.offset);
    return state;
  }

  async initializeFile(file) {
    const known = this.knownFiles.get(file);
    if (known?.state) return known.state;
    const evicted = this.evictedFiles.get(file);
    const mode = !this.initialSnapshotComplete
      ? "initial"
      : known?.safeResume || evicted
        ? "resume"
        : "new";
    const state = await this.createFileState(file, mode);
    if (!state) return;
    this.evictedFiles.delete(file);
    this.knownFiles.set(file, {
      state,
      safeResume: false,
      lastSeen: this.pollNumber,
    });
    return state;
  }

  pruneKnownFiles() {
    while (this.knownFiles.size > this.maxKnownFiles) {
      const dormant = [...this.knownFiles.entries()]
        .filter(([file]) => !this.files.has(file))
        .sort((left, right) => left[1].lastSeen - right[1].lastSeen);
      const candidate = dormant[0];
      if (!candidate) break;
      const [file, known] = candidate;
      if (known.state) {
        known.state = undefined;
        known.safeResume = true;
        continue;
      }
      this.knownFiles.delete(file);
      this.evictedFiles.set(file, { lastSeen: known.lastSeen });
      while (this.evictedFiles.size > this.maxKnownFiles) {
        this.evictedFiles.delete(this.evictedFiles.keys().next().value);
      }
    }
  }

  async discoverFiles() {
    const discovered = await this.discover();
    if (!discovered) {
      if (!this.initialSnapshotComplete) this.initialSnapshotComplete = true;
      return;
    }
    const { allFiles, files, sessionNames, unavailable } = discovered;
    this.sessionNames = sessionNames;
    if (!this.initialSnapshotComplete) {
      for (const file of allFiles.slice(0, this.maxKnownFiles)) {
        if (!this.knownFiles.has(file)) {
          this.knownFiles.set(file, {
            state: undefined,
            safeResume: true,
            lastSeen: this.pollNumber,
          });
        }
      }
    }
    const unavailableSet = new Set(unavailable);
    this.files.clear();
    for (const file of files) {
      const state = await this.initializeFile(file);
      if (!state) continue;
      this.files.set(file, state);
      const known = this.knownFiles.get(file);
      if (known) known.lastSeen = this.pollNumber;
    }
    for (const file of unavailableSet) {
      const known = this.knownFiles.get(file);
      if (known) known.lastSeen = this.pollNumber;
    }
    this.initialSnapshotComplete = true;
    this.pruneKnownFiles();
  }

  remember(id) {
    this.seenIds.add(id);
    while (this.seenIds.size > this.maxSeenIds) this.seenIds.delete(this.seenIds.values().next().value);
  }

  workspaceAttribution(raw) {
    const candidates = workspaceCandidate(raw);
    if (!candidates.length) return undefined;
    for (const value of candidates) {
      if (this.allWorkspaces) {
        const candidate = path.isAbsolute(value) ? value : path.resolve(this.workspaceRoot, value);
        return canonicalWorkspaceRoot(candidate);
      }
      const resource = normalizeResourcePath(value, this.workspaceRoot);
      if (resource && !resource.outsideRoot) return true;
    }
    return false;
  }

  async processLine(line, file, state) {
    if (!line.length || line.length > this.maxLineBytes) return false;
    let raw;
    try { raw = JSON.parse(line.toString("utf8")); } catch { return false; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const attributed = this.workspaceAttribution(raw);
    if (attributed !== undefined) state.attributed = attributed;
    if (!state.attributed) return false;
    const normalizedRaw = mappedEvent(raw);
    if (!normalizedRaw) return false;
    const sessionId = sessionIdFromFile(file);
    if (!sessionId) return false;
    const key = dedupeKey(normalizedRaw, sessionId);
    if (this.seenIds.has(key)) return false;
    const event = normalizeEvent(normalizedRaw, {
      client: "unknown",
      sourceKind: "jsonl",
      sessionId,
      workspaceRoot: this.allWorkspaces && typeof state.attributed === "string"
        ? state.attributed
        : this.workspaceRoot,
      sessionName: this.sessionNames.get(file),
      agentName: agentName(normalizedRaw),
    }, {
      workspaceRoot: this.allWorkspaces && typeof state.attributed === "string"
        ? state.attributed
        : this.workspaceRoot,
    });
    await this.onEvent(event);
    this.remember(key);
    return true;
  }

  async readFile(file) {
    const state = this.files.get(file);
    if (!state) return;
    const stat = await statFile(file);
    if (!stat) {
      this.files.delete(file);
      return;
    }
    const identity = `${stat.dev}:${stat.ino}`;
    const changedPrefix = state.tailHash && state.offset > 0
      ? (await prefixFingerprint(file, state.offset)) !== state.tailHash
      : false;
    if (state.identity !== identity || stat.size < state.offset || stat.size < state.readOffset || changedPrefix) {
      state.identity = identity;
      state.offset = 0;
      state.readOffset = 0;
      state.remainder = Buffer.alloc(0);
      state.oversize = false;
      state.attributed = false;
      state.tailHash = undefined;
    }
    if (stat.size === state.readOffset) return;
    let handle;
    try {
      handle = await fs.open(file, "r");
      const buffer = Buffer.alloc(this.readChunkBytes);
      while (state.readOffset < stat.size) {
        const priorRemainderLength = state.remainder.length;
        const chunkStart = state.readOffset - priorRemainderLength;
        const length = Math.min(buffer.length, stat.size - state.readOffset);
        const result = await handle.read(buffer, 0, length, state.readOffset);
        if (!result.bytesRead) break;
        state.readOffset += result.bytesRead;
        let chunk = buffer.subarray(0, result.bytesRead);
        if (state.remainder.length) {
          chunk = Buffer.concat([state.remainder, chunk]);
          state.remainder = Buffer.alloc(0);
        }
        let start = 0;
        while (start < chunk.length) {
          const end = chunk.indexOf(0x0a, start);
          if (end < 0) {
            const pending = chunk.subarray(start);
            if (state.oversize || pending.length > this.maxLineBytes) {
              state.remainder = Buffer.alloc(0);
              state.oversize = true;
            } else {
              state.remainder = Buffer.from(pending);
            }
            break;
          }
          const line = chunk.subarray(start, end);
          const lineStart = chunkStart + start;
          const lineEnd = chunkStart + end + 1;
          start = end + 1;
          if (state.oversize) {
            state.oversize = false;
            state.offset = lineEnd;
            continue;
          }
          try {
            await this.processLine(line, file, state);
            state.offset = lineEnd;
            state.remainder = Buffer.alloc(0);
          } catch {
            state.offset = lineStart;
            state.readOffset = lineStart;
            state.remainder = Buffer.alloc(0);
            state.oversize = false;
            state.tailHash = await prefixFingerprint(file, state.offset);
            return;
          }
        }
      }
      state.tailHash = await prefixFingerprint(file, state.offset);
    } catch {
      // Session files can be removed or replaced while they are being read.
      state.readOffset = state.offset;
      state.remainder = Buffer.alloc(0);
      state.oversize = false;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async poll() {
    this.pollNumber += 1;
    await this.discoverFiles();
    const files = [...this.files.keys()];
    let next = 0;
    const worker = async () => {
      while (next < files.length && !this.stopped) {
        const index = next++;
        await this.readFile(files[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxConcurrent, files.length) }, worker));
    this.started = true;
    return files.length;
  }

  stop() {
    this.stopped = true;
  }
}
