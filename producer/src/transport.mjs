import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BoundedSpool } from "./spool.mjs";

const DEFAULT_INGEST_URL = "http://127.0.0.1:4180/api/activity/events";
const DEFAULT_RUNTIME_DIR = path.join(os.homedir(), ".codewalk", "runtime");
const REJECTION_LOG_NAME = "activity-transport.log";

function localIngestUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) &&
      (url.protocol === "http:" || url.protocol === "https:") ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function permanentlyRejected(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) && status >= 400 && status < 500 &&
    status !== 408 && status !== 429;
}

export class ActivityTransport {
  constructor({
    ingestUrl = process.env.CODEWALK_INGEST_URL ?? DEFAULT_INGEST_URL,
    activityToken = process.env.CODEWALK_ACTIVITY_TOKEN,
    activityTokenFile = process.env.CODEWALK_ACTIVITY_TOKEN_FILE ?? path.join(os.homedir(), ".codewalk", "activity", "token"),
    spool,
    fetchImpl = globalThis.fetch,
    timeoutMs = 1500,
    runtimeDir = process.env.CODEWALK_RUNTIME_DIR ?? DEFAULT_RUNTIME_DIR,
  } = {}) {
    this.ingestUrl = localIngestUrl(ingestUrl);
    this.spool = spool ?? new BoundedSpool(process.env.CODEWALK_SPOOL_DIR ?? path.join(os.homedir(), ".codewalk", "activity"));
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.activityToken = typeof activityToken === "string" && activityToken ? activityToken : undefined;
    this.activityTokenFile = activityTokenFile;
    this.runtimeDir = runtimeDir;
    this.rejectionLog = path.join(runtimeDir, REJECTION_LOG_NAME);
    this.rejectionCount = 0;
    this.flushing = false;
    this.flushPromise = undefined;
  }

  async enqueue(event) {
    // Hook processes only append. Network delivery belongs to the long-lived
    // extension worker so a stalled collector cannot block an agent action.
    return this.spool.append(event);
  }

  async resolveActivityToken() {
    if (this.activityToken) return this.activityToken;
    try {
      const token = (await fs.readFile(this.activityTokenFile, "utf8")).trim();
      return token || undefined;
    } catch {
      return undefined;
    }
  }

  async recordPermanentRejection(response) {
    this.rejectionCount += 1;
    let details;
    try {
      if (typeof response?.json === "function") details = await response.json();
    } catch {}
    const diagnostic = {
      status: Number(response?.status),
      ...(typeof details?.code === "string" ? { code: details.code.slice(0, 128) } : {}),
      fields: Array.isArray(details?.fields)
        ? details.fields.filter(field => typeof field === "string").slice(0, 32).map(field => field.slice(0, 128))
        : [],
    };
    try {
      await fs.mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
      try { await fs.chmod(this.runtimeDir, 0o700); } catch {}
      await fs.appendFile(this.rejectionLog, `${JSON.stringify(diagnostic)}\n`, { mode: 0o600 });
      try { await fs.chmod(this.rejectionLog, 0o600); } catch {}
    } catch {}
  }

  async flush() {
    if (this.flushing) {
      await this.flushPromise;
      return this.flush();
    }
    if (!this.ingestUrl || typeof this.fetchImpl !== "function") return false;
    this.flushing = true;
    this.flushPromise = (async () => {
      try {
        return await this.spool.withLock("collector", async () => {
          const pending = await this.spool.read();
          for (const event of pending) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);
            timer.unref?.();
            try {
              const headers = { "content-type": "application/json" };
              const activityToken = await this.resolveActivityToken();
              if (activityToken) headers["X-Codewalk-Activity-Token"] = activityToken;
              const response = await this.fetchImpl(this.ingestUrl, {
                method: "POST", headers, body: JSON.stringify(event), signal: controller.signal,
              });
              if (permanentlyRejected(response)) {
                // Do not retry a collector-level validation/auth rejection.
                // Acknowledge only this canonical record. Diagnostics retain
                // only the collector's status, code, and field names.
                await this.recordPermanentRejection(response);
                await this.spool.acknowledge(event);
                continue;
              }
              if (!response?.ok) break;
              await this.spool.acknowledge(event);
            } catch {
              break;
            } finally {
              clearTimeout(timer);
            }
          }
          return (await this.spool.read()).length === 0;
        });
      } finally {
        this.flushing = false;
        this.flushPromise = undefined;
      }
    })();
    return this.flushPromise;
  }
}
