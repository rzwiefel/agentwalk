import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeEvent, normalizeHook, validateEnvelope, workspaceIdentity } from "../src/contract.mjs";
import { normalizeResourcePath } from "../src/paths.mjs";
import { redactMetadata, redactString } from "../src/redact.mjs";
import { BoundedSpool } from "../src/spool.mjs";
import { ActivityTransport } from "../src/transport.mjs";
import { approveExtensionPermission, attachToSession, OBSERVED_SESSION_EVENTS } from "../src/sdk-adapter.mjs";
import { reportCapabilities } from "../src/capabilities.mjs";
import { SessionEventWatcher } from "../src/session-watcher.mjs";

const testRoot = path.join(process.cwd(), ".test-work");

test.beforeEach(async () => fs.rm(testRoot, { recursive: true, force: true }));
test.after(async () => fs.rm(testRoot, { recursive: true, force: true }));

test("normalizes supported hook lifecycle without content", () => {
  const event = normalizeHook("preToolUse", {
    sessionId: "s1",
    timestamp: Date.parse("2026-08-26T12:00:00Z"),
    cwd: testRoot,
    toolName: "edit_file",
    toolArgs: { path: "src/a.ts", content: "private code" },
    prompt: "private prompt",
  }, { client: "copilot-cli", version: "1.0.81-12" });
  assert.equal(event.type, "tool");
  assert.equal(event.status, "started");
  assert.equal(event.tool, "edit_file");
  assert.equal(event.resources[0].path, "src/a.ts");
  assert.equal(event.resources[0].action, "write");
  assert.equal(event.source.kind, "hook");
  assert.equal(event.source.client, "copilot-cli");
  assert.equal(validateEnvelope(event), true);
  assert.equal(JSON.stringify(event).includes("private prompt"), false);
  assert.equal(JSON.stringify(event).includes("private code"), false);
});

test("keeps shell snippets bounded and privacy-safe", () => {
  const event = normalizeHook("preToolUse", {
    sessionId: "snippet-session",
    workingDirectory: testRoot,
    toolName: "bash",
    toolArgs: { command: `cat ${os.homedir()}/private.txt && echo token=secret-value` },
  }, {}, { workspaceRoot: testRoot });
  assert.equal(event.snippet.includes(os.homedir()), true);
  assert.equal(event.snippet.includes("secret-value"), false);
  assert.ok(event.snippet.length <= 120);
});

test("falls back to safe snippets for structured tool arguments", () => {
  const view = normalizeHook("preToolUse", {
    sessionId: "argument-snippet-session",
    toolName: "view",
    toolArgs: { path: "src/main.ts", content: "private code" },
  });
  const rg = normalizeHook("preToolUse", {
    sessionId: "argument-snippet-session",
    toolName: "rg",
    toolArgs: { pattern: "TODO", paths: ["src", "test"], prompt: "private prompt" },
  });
  const sql = normalizeHook("preToolUse", {
    sessionId: "argument-snippet-session",
    toolName: "sql",
    toolArgs: { query: "SELECT secret_column FROM users WHERE token='secret-value'" },
  });
  const patch = normalizeHook("preToolUse", {
    sessionId: "argument-snippet-session",
    toolName: "apply_patch",
    toolArgs: {
      patch: "*** Begin Patch\n*** Update File: src/main.ts\n@@\n-const privateCode = true;\n+const privateCode = false;\n*** End Patch",
    },
  });
  const rawPatch = normalizeEvent({
    type: "tool.execution_start",
    data: {
      toolName: "apply_patch",
      arguments: "*** Begin Patch\n*** Add File: src/new.ts\n*** End Patch",
    },
  }, { sessionId: "argument-snippet-session" });

  assert.equal(view.snippet, "view · src/main.ts");
  assert.equal(rg.snippet, "rg · TODO · src,test");
  assert.equal(sql.snippet, "sql · SELECT");
  assert.equal(patch.snippet, "apply_patch · 1 file");
  assert.equal(rawPatch.snippet, "apply_patch · 1 file");
  assert.equal(patch.resources?.[0]?.path, "src/main.ts");
  assert.equal(rawPatch.resources?.[0]?.path, "src/new.ts");
  for (const event of [view, rg, sql, patch, rawPatch]) {
    assert.ok(event.snippet.length <= 120);
    assert.equal(JSON.stringify(event).includes("private"), false);
    assert.equal(JSON.stringify(event).includes("secret-value"), false);
  }
});

test("propagates distinct provider agent names alongside session names", () => {
  const event = normalizeEvent({
    type: "agent.started",
    agent: { name: "Luna implementer" },
  }, {
    sessionId: "agent-name-session",
    sessionName: "Activity work",
  });
  assert.equal(event.sessionName, "Activity work");
  assert.equal(event.agentName, "Luna implementer");
});

test("preserves safe workspace-relative paths in snippets and reads flattened provider fields", () => {
  const workspace = path.join(testRoot, "workspace-snippets");
  const event = normalizeEvent({
    type: "tool.execution_start",
    toolName: "read_file",
    workingDirectory: workspace,
    arguments: JSON.stringify({ path: path.join(workspace, "src", "main.ts") }),
  });
  assert.equal(event.snippet, "read_file · src/main.ts");
  assert.deepEqual(event.resources, [{ path: "src/main.ts", action: "read", confidence: "observed" }]);
  assert.equal(event.workspace.root, workspace);
  assert.equal(JSON.stringify(event).includes(workspace), true);
});

test("emits bounded intent snippets for generic structured tool arguments", () => {
  const event = normalizeEvent({
    type: "tool.execution_start",
    toolName: "custom_tool",
    toolArgs: { path: "src/main.ts", mode: "preview", content: "private code" },
  }, { workspaceRoot: testRoot });
  assert.equal(event.snippet, "custom_tool · path=src/main.ts · mode=preview");
  assert.equal(JSON.stringify(event).includes("private code"), false);
});

test("deduplicates identical hook payloads without hashing raw content", () => {
  const payload = {
    sessionId: "hook-session",
    timestamp: "2026-08-26T12:00:00Z",
    workingDirectory: testRoot,
    toolName: "edit_file",
    toolCallId: "call-1",
    toolArgs: { path: "src/a.ts", content: "private code" },
    prompt: "private prompt",
  };
  const first = normalizeHook("preToolUse", payload, { client: "copilot-cli" }, { workspaceRoot: testRoot });
  const duplicate = normalizeHook("preToolUse", { ...payload }, { client: "copilot-cli" }, { workspaceRoot: testRoot });
  assert.equal(first.id, duplicate.id);
  assert.match(first.id, /^hook-[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(first).includes("private prompt"), false);
  assert.equal(JSON.stringify(first).includes("private code"), false);
});

test("deduplicates generated hook envelopes across timestamp bucket boundaries", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "near-duplicate"), {
    nearDuplicateWindowMs: 200,
  });
  const payload = {
    sessionId: "hook-session",
    workingDirectory: testRoot,
    toolName: "read_file",
    toolArgs: { path: "src/a.ts" },
  };
  const first = normalizeHook("preToolUse", {
    ...payload, timestamp: "2026-08-26T12:00:00.950Z",
  }, {}, { workspaceRoot: testRoot });
  const duplicate = normalizeHook("preToolUse", {
    ...payload, timestamp: "2026-08-26T12:00:01.100Z",
  }, {}, { workspaceRoot: testRoot });
  assert.notEqual(first.id, duplicate.id);
  assert.equal(await spool.append(first), true);
  assert.equal(await spool.append(duplicate), false);
  assert.deepEqual((await spool.read()).map(event => event.id), [first.id]);
});

test("keeps repeated hooks outside the temporal window", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "near-duplicate-outside"), {
    nearDuplicateWindowMs: 200,
  });
  const payload = {
    sessionId: "hook-session",
    workingDirectory: testRoot,
    toolName: "read_file",
    toolArgs: { path: "src/a.ts" },
  };
  const first = normalizeHook("preToolUse", {
    ...payload, timestamp: "2026-08-26T12:00:00.000Z",
  }, {}, { workspaceRoot: testRoot });
  const later = normalizeHook("preToolUse", {
    ...payload, timestamp: "2026-08-26T12:00:00.201Z",
  }, {}, { workspaceRoot: testRoot });
  assert.equal(await spool.append(first), true);
  assert.equal(await spool.append(later), true);
  assert.deepEqual((await spool.read()).map(event => event.id), [first.id, later.id]);
});

test("keeps distinct hook lifecycle, tools, resources, and tool calls", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "near-duplicate-distinct"), {
    nearDuplicateWindowMs: 200,
  });
  const payload = {
    sessionId: "hook-session",
    workingDirectory: testRoot,
    timestamp: "2026-08-26T12:00:00.000Z",
    toolName: "read_file",
    toolArgs: { path: "src/a.ts" },
  };
  const events = [
    normalizeHook("preToolUse", payload, {}, { workspaceRoot: testRoot }),
    normalizeHook("postToolUse", payload, {}, { workspaceRoot: testRoot }),
    normalizeHook("preToolUse", { ...payload, toolName: "write_file" }, {}, { workspaceRoot: testRoot }),
    normalizeHook("preToolUse", {
      ...payload, toolArgs: { path: "src/b.ts" },
    }, {}, { workspaceRoot: testRoot }),
    normalizeHook("preToolUse", {
      ...payload, toolCallId: "call-1",
    }, {}, { workspaceRoot: testRoot }),
  ];
  for (const event of events) assert.equal(await spool.append(event), true);
  assert.equal((await spool.read()).length, events.length);
});

test("does not rewrite provider hook IDs while deduplicating explicit IDs", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "provider-id"), {
    nearDuplicateWindowMs: 200,
  });
  const payload = {
    sessionId: "hook-session",
    workingDirectory: testRoot,
    toolName: "read_file",
    toolArgs: { path: "src/a.ts" },
  };
  const first = normalizeHook("preToolUse", {
    ...payload, timestamp: "2026-08-26T12:00:00.000Z", eventId: "provider-1",
  }, {}, { workspaceRoot: testRoot });
  const second = normalizeHook("preToolUse", {
    ...payload, timestamp: "2026-08-26T12:00:00.100Z", eventId: "provider-2",
  }, {}, { workspaceRoot: testRoot });
  assert.equal(first.id, "provider-1");
  assert.equal(second.id, "provider-2");
  assert.equal(await spool.append(first), true);
  assert.equal(await spool.append(second), false);
  assert.deepEqual((await spool.read()).map(event => event.id), ["provider-1"]);
});

test("keeps provider hook IDs and separates lifecycle, timestamp, and tool calls", () => {
  const payload = {
    sessionId: "hook-session",
    timestamp: "2026-08-26T12:00:00Z",
    workingDirectory: testRoot,
    toolName: "read_file",
    toolCallId: "call-1",
    toolArgs: { path: "src/a.ts" },
  };
  const started = normalizeHook("preToolUse", payload, {}, { workspaceRoot: testRoot });
  const completed = normalizeHook("postToolUse", payload, {}, { workspaceRoot: testRoot });
  const later = normalizeHook("preToolUse", {
    ...payload,
    timestamp: "2026-08-26T12:00:01Z",
  }, {}, { workspaceRoot: testRoot });
  const anotherCall = normalizeHook("preToolUse", {
    ...payload,
    toolCallId: "call-2",
  }, {}, { workspaceRoot: testRoot });
  const provider = normalizeHook("preToolUse", { ...payload, eventId: "provider-hook-1" });
  assert.equal(provider.id, "provider-hook-1");
  assert.equal(new Set([started.id, completed.id, later.id, anotherCall.id]).size, 4);
});

test("normalizes SDK events and preserves provider IDs", () => {
  const event = normalizeEvent({
    id: "provider-event",
    type: "tool.execution_complete",
    timestamp: "2026-08-26T12:00:00Z",
    parentId: "parent",
    data: { toolCallId: "call-1", toolName: "bash", result: { content: "secret output" } },
  }, { sessionId: "s2", client: "copilot-cli", sourceKind: "sdk", workspaceRoot: testRoot });
  assert.deepEqual({
    id: event.id,
    sessionId: event.sessionId,
    parentId: event.parentId,
    toolCallId: event.toolCallId,
    type: event.type,
    status: event.status,
  }, {
    id: "provider-event",
    sessionId: "s2",
    parentId: "parent",
    toolCallId: "call-1",
    type: "tool",
    status: "completed",
  });
  assert.equal(JSON.stringify(event).includes("secret output"), false);
});

test("preserves bounded agent targets without retaining tool arguments", () => {
  for (const tool of ["read_agent", "write_agent"]) {
    const event = normalizeEvent({
      type: "tool.execution_start",
      data: {
        toolName: tool,
        arguments: {
          agent_id: "target-agent",
          targetAgentNodeId: "agent:%5Btarget%5D",
          targetSessionId: "target-session",
          targetWorkspaceId: "local-target-1234",
          prompt: "must not persist",
        },
      },
    }, { sessionId: "source-session", agentId: "source-agent" });
    assert.deepEqual(event.metadata, {
      providerEventType: "tool.execution_start",
      targetAgentId: "target-agent",
      targetAgentNodeId: "agent:%5Btarget%5D",
      targetSessionId: "target-session",
      targetWorkspaceId: "local-target-1234",
    });
    assert.equal(JSON.stringify(event).includes("must not persist"), false);
  }
});

test("retains unknown event as a redacted error envelope", () => {
  const event = normalizeEvent({
    id: "unknown",
    type: "future.new_event",
    timestamp: "2026-08-26T12:00:00Z",
    data: { prompt: "do not retain", arbitrary: "safe label" },
  }, { sessionId: "s3", client: "copilot-cli" });
  assert.equal(event.type, "error");
  assert.equal(event.status, "unknown");
  assert.equal(event.metadata.unknownEvent, true);
  assert.equal(event.metadata.providerEventType, "future.new_event");
  assert.equal(JSON.stringify(event).includes("do not retain"), false);
});

test("handles partial context and unknown IDs", () => {
  const event = normalizeEvent({ type: "session.idle" }, {});
  assert.equal(event.sessionId, "unknown");
  assert.equal(event.type, "session");
  assert.equal(validateEnvelope(event), true);
});

test("attributes top-level session lifecycle to one stable session agent", () => {
  const start = normalizeEvent({
    id: "session-start",
    type: "session.start",
    data: {},
  }, { sessionId: "top-level-session", workspaceRoot: testRoot });
  const idle = normalizeEvent({
    id: "session-idle",
    type: "session.idle",
    data: {},
  }, { sessionId: "top-level-session", workspaceRoot: testRoot });
  const prompt = normalizeEvent({
    id: "user-message",
    type: "user.message",
    data: {},
  }, { sessionId: "top-level-session", workspaceRoot: testRoot });
  const assistant = normalizeEvent({
    id: "assistant-message",
    type: "assistant.message_delta",
    data: {},
  }, { sessionId: "top-level-session", workspaceRoot: testRoot });
  const tool = normalizeEvent({
    id: "tool-start",
    type: "tool.execution_start",
    data: { toolName: "read_file" },
  }, { sessionId: "top-level-session", workspaceRoot: testRoot });
  const file = normalizeEvent({
    id: "file-read",
    type: "file.read",
    data: {},
  }, { sessionId: "top-level-session", workspaceRoot: testRoot });
  assert.equal(start.agentId, "session:top-level-session");
  assert.equal(idle.agentId, "session:top-level-session");
  assert.equal(prompt.agentId, "session:top-level-session");
  assert.equal(assistant.agentId, "session:top-level-session");
  assert.equal(tool.agentId, undefined);
  assert.equal(file.agentId, undefined);
  assert.equal(start.workspace.id, workspaceIdentity(testRoot));
});

test("normalizes invalid timestamps to a current valid ISO timestamp", () => {
  for (const timestamp of ["not-a-timestamp", Number.MAX_VALUE]) {
    const event = normalizeEvent({ type: "session.idle", timestamp }, {});
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(Number.isNaN(Date.parse(event.timestamp)), false);
  }
});

test("rejects outside-root paths and resolves symlink escapes", async () => {
  const root = path.join(testRoot, "worktree");
  const outside = path.join(testRoot, "outside");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.txt"), "x");
  const link = path.join(root, "linked");
  await fs.symlink(outside, link);
  assert.deepEqual(normalizeResourcePath(path.join(outside, "secret.txt"), root), {
    path: path.join(outside, "secret.txt"), action: "reference", confidence: "observed", outsideRoot: true,
  });
  assert.equal(normalizeResourcePath("linked/secret.txt", root).path, path.join(outside, "secret.txt"));
  assert.equal(normalizeResourcePath("linked/secret.txt", root).outsideRoot, true);
  assert.equal(normalizeResourcePath("src/a.ts", root).path, "src/a.ts");
});

test("redacts credentials, home paths, and content-shaped metadata", () => {
  assert.equal(redactString("Authorization: test-value"), "Authorization: [REDACTED]");
  assert.equal(redactString(`${os.homedir()}/private.txt`).includes(os.homedir()), false);
  const metadata = redactMetadata({
    status: "ok",
    command: "echo secret",
    apiKey: "do-not-store",
    nested: { value: "safe" },
  });
  assert.deepEqual(metadata, { status: "ok", nested: { value: "safe" } });
});

test("redacts auth-scheme values and URL userinfo without damaging safe URL structure", () => {
  const sentinels = ["SENTINEL_BEARER", "SENTINEL_BASIC", "SENTINEL_TOKEN"];
  for (const [index, scheme] of ["Bearer", "Basic", "Token"].entries()) {
    const event = normalizeHook("preToolUse", {
      sessionId: `redaction-sentinel-${scheme.toLowerCase()}`,
      toolName: "bash",
      toolArgs: {
        command: `curl -H "Authorization: ${scheme} ${sentinels[index]}" "https://SENTINEL_USER:SENTINEL_PASSWORD@api.example.com/v1/x?token=SENTINEL_QUERY#frag"`,
      },
    });
    assert.match(event.snippet, new RegExp(`Authorization: ${scheme} \\[REDACTED\\]`));
    assert.match(event.snippet, /https:\/\/api\.example\.com\/v1\/x/);
    assert.equal(JSON.stringify(event).includes(sentinels[index]), false);
    assert.equal(JSON.stringify(event).includes("SENTINEL_USER"), false);
    assert.equal(JSON.stringify(event).includes("SENTINEL_PASSWORD"), false);
    assert.equal(JSON.stringify(event).includes("SENTINEL_QUERY"), false);
  }
  assert.equal(
    redactString("https://SENTINEL_USER:SENTINEL_PASSWORD@example.com/safe/path"),
    "https://example.com/safe/path",
  );
});

test("spool is bounded by event count and byte size", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "spool"), { maxBytes: 1200, maxEvents: 3 });
  await spool.append({ id: "1", payload: "a".repeat(200) });
  await spool.append({ id: "2", payload: "b".repeat(200) });
  await spool.append({ id: "3", payload: "c".repeat(200) });
  await spool.append({ id: "4", payload: "d".repeat(200) });
  const events = await spool.read();
  assert.ok(events.length <= 3);
  assert.ok(await spool.size() <= 1200);
  assert.equal(await spool.append({ payload: "x".repeat(3000) }), false);
});

test("delivery failure retains events and retry drains them", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "delivery"));
  let attempts = 0;
  const transport = new ActivityTransport({
    ingestUrl: "http://localhost:8787/activity",
    spool,
    fetchImpl: async () => (++attempts === 1 ? { ok: false } : { ok: true }),
  });
  await transport.enqueue({ id: "delivery-1", schemaVersion: 1 });
  assert.equal((await spool.read()).length, 1);
  await transport.flush();
  await transport.flush();
  assert.equal((await spool.read()).length, 0);
  assert.equal(attempts, 2);
});

test("permanent collector rejection drops only the rejected record and continues", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "delivery-permanent-rejection"));
  const delivered = [];
  const transport = new ActivityTransport({
    ingestUrl: "http://localhost:8787/activity",
    spool,
    fetchImpl: async (_url, request) => {
      const event = JSON.parse(request.body);
      delivered.push(event.id);
      return event.id === "invalid" ? { ok: false, status: 400 } : { ok: true, status: 202 };
    },
  });
  await transport.enqueue({ id: "invalid", timestamp: "not-a-timestamp" });
  await transport.enqueue({ id: "valid", timestamp: "2026-08-27T00:00:00.000Z" });
  assert.equal(await transport.flush(), true);
  assert.deepEqual(delivered, ["invalid", "valid"]);
  assert.deepEqual(await spool.read(), []);
});

test("transient collector failures retain queued records", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "delivery-transient"));
  const transport = new ActivityTransport({
    ingestUrl: "http://localhost:8787/activity",
    spool,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await transport.enqueue({ id: "transient-invalid", timestamp: "not-a-timestamp" });
  await transport.enqueue({ id: "transient-valid", timestamp: "2026-08-27T00:00:00.000Z" });
  assert.equal(await transport.flush(), false);
  assert.deepEqual((await spool.read()).map(event => event.id), ["transient-invalid", "transient-valid"]);
});

test("acknowledges only the posted record when IDs overlap across scopes", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "delivery-overlapping-ids"));
  const first = {
    id: "shared-provider-id",
    sessionId: "session-a",
    source: { client: "copilot-cli", kind: "sdk" },
  };
  const second = {
    id: "shared-provider-id",
    sessionId: "session-b",
    source: { client: "unknown", kind: "jsonl" },
  };
  await spool.append(first);
  await spool.append(second);
  const delivered = [];
  const transport = new ActivityTransport({
    ingestUrl: "http://localhost:8787/activity",
    spool,
    fetchImpl: async (_url, request) => {
      delivered.push(JSON.parse(request.body));
      return { ok: delivered.length === 1 };
    },
  });
  await transport.flush();
  assert.deepEqual(delivered, [first, second]);
  assert.deepEqual(await spool.read(), [second]);
});

test("SDK listener uses typed subscriptions and is unsubscribable", async () => {
  const handlers = new Map();
  let unsubscribed = false;
  const result = await attachToSession({ session: {
    sessionId: "sdk-session",
    on: (eventType, callback) => {
      handlers.set(eventType, callback);
      return () => { unsubscribed = true; };
    },
  } }, { context: { client: "copilot-cli" } });
  assert.equal(result.attached, true);
  let emitted;
  await attachToSession({ session: {
    sessionId: "s",
    on: (eventType, callback) => { emitted = callback; return () => {}; },
  } }, {
    onEvent: event => { assert.equal(event.source.kind, "sdk"); },
  });
  assert.deepEqual([...handlers.keys()], OBSERVED_SESSION_EVENTS);
  handlers.get("session.idle")({ type: "session.idle", id: "e", timestamp: "2026-08-26T12:00:00Z", data: {} });
  result.unsubscribe();
  assert.equal(unsubscribed, true);
  assert.equal(typeof emitted, "function");
});

test("SDK listener does not fall back to the unsupported wildcard overload", async () => {
  const result = await attachToSession({ session: {
    sessionId: "wildcard-only",
    on: callback => {
      assert.fail(`wildcard listener registered: ${typeof callback}`);
    },
  } }, { context: { client: "copilot-cli" } });
  assert.deepEqual(result, { attached: false, reason: "typed-session-listener-unavailable" });
});

test("SDK join permission handler approves only this extension capability", () => {
  assert.deepEqual(approveExtensionPermission({
    kind: "extension-permission-access",
    extensionName: "user:codewalk-local-activity",
  }), {
    kind: "approved-for-session",
    approval: {
      kind: "extension-permission-access",
      extensionName: "user:codewalk-local-activity",
    },
  });
  assert.deepEqual(approveExtensionPermission({
    kind: "extension-env-access",
    extensionName: "user:codewalk-local-activity",
    environmentVariables: ["HOME"],
  }), { kind: "no-result" });
});

test("SDK hooks use the installed SessionHooks names and normalize Date context", async () => {
  const events = [];
  const { createHooks } = await import("../src/sdk-adapter.mjs");
  const hooks = createHooks({
    emit: event => events.push(event),
    context: { client: "copilot-cli" },
    options: { workspaceRoot: testRoot },
  });
  assert.deepEqual(Object.keys(hooks), [
    "onSessionStart", "onSessionEnd", "onUserPromptSubmitted", "onPreToolUse",
    "onPreMcpToolCall", "onPostToolUse", "onPostToolUseFailure", "onErrorOccurred", "onAgentStop",
  ]);
  await hooks.onPostToolUseFailure({
    sessionId: "s-fail", timestamp: new Date("2026-01-01T00:00:00Z"),
    workingDirectory: testRoot, toolName: "shell", toolArgs: { command: "private" }, error: "private output",
  }, { sessionId: "s-fail" });
  assert.equal(events[0].type, "tool");
  assert.equal(events[0].status, "failed");
  assert.equal(events[0].timestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(JSON.stringify(events[0]).includes("private output"), false);
});

test("missing targets are observed and missing symlink ancestors cannot escape", async () => {
  const root = path.join(testRoot, "missing-root");
  const outside = path.join(testRoot, "outside-missing");
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(root, { recursive: true });
  await fs.symlink(outside, path.join(root, "escape"));
  assert.deepEqual(normalizeResourcePath("new/file.ts", root), {
    path: "new/file.ts", action: "reference", confidence: "observed",
  });
  assert.equal(normalizeResourcePath("escape/new/file.ts", root).outsideRoot, true);
});

test("error metadata is classification-only and cannot leak adversarial text", () => {
  const event = normalizeEvent({
    type: "session.error",
    data: { error: { name: "Error", code: "E_NETWORK", message: `${os.homedir()}/x token=not-safe` } },
  }, { sessionId: "err", client: "copilot-cli" });
  assert.equal(event.metadata.errorClassification, "error");
  assert.equal(event.metadata.errorCode, "E_NETWORK");
  assert.equal(JSON.stringify(event).includes(os.homedir()), false);
  assert.equal(JSON.stringify(event).includes("not-safe"), false);
});

test("session watcher starts at EOF and forwards only attributed normalized events", async () => {
  const workspace = path.join(testRoot, "workspace");
  const sessions = path.join(testRoot, "session-state");
  const sessionFile = path.join(sessions, "session-a", "events.jsonl");
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(path.join(path.dirname(sessionFile), "vscode.metadata.json"), JSON.stringify({
    customTitle: "Naming /Users/alice agent glyphs",
  }));
  await fs.writeFile(sessionFile, `${JSON.stringify({
    id: "old", type: "session.start", timestamp: "2026-08-26T12:00:00Z",
    data: { sessionId: "session-a", context: { cwd: workspace } },
  })}\n`);
  const events = [];
  const watcher = new SessionEventWatcher({
    sessionStateDirectory: sessions,
    workspaceRoot: workspace,
    onEvent: event => events.push(event),
    readChunkBytes: 32,
  });
  await watcher.poll();
  assert.equal(events.length, 0);

  await fs.appendFile(sessionFile, `${JSON.stringify({
    id: "start", type: "session.start", timestamp: "2026-08-26T12:01:00Z",
    data: { sessionId: "session-a", context: { cwd: workspace } },
  })}\n`);
  await fs.appendFile(sessionFile, JSON.stringify({
    id: "tool", type: "external_tool.requested", timestamp: "2026-08-26T12:01:01Z",
    data: {
      sessionId: "session-a", toolName: "read_file", workingDirectory: workspace,
      arguments: { path: "src/private.txt", content: "must not leave producer" },
    },
  }));
  await watcher.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "session");
  assert.equal(events[0].source.kind, "jsonl");
  assert.equal(events[0].source.client, "unknown");
  assert.equal(events[0].agentId, "session:session-a");
  assert.equal(events[0].sessionName, "Naming /Users/alice agent glyphs");
  assert.deepEqual(events[0].workspace, {
    id: workspaceIdentity(workspace),
    root: workspace,
    repository: path.basename(workspace),
  });
  assert.equal(JSON.stringify(events).includes("must not leave producer"), false);

  await fs.appendFile(sessionFile, "\n");
  await watcher.poll();
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "tool");
  assert.deepEqual(events[1].resources, [{
    path: "src/private.txt", action: "read", confidence: "observed",
  }]);

  await fs.appendFile(sessionFile, `${JSON.stringify({
    id: "context-away", type: "session.context_changed",
    data: { sessionId: "session-a", context: { cwd: path.join(testRoot, "other") } },
  })}\n`);
  await fs.appendFile(sessionFile, `${JSON.stringify({
    id: "outside-tool", type: "external_tool.requested",
    data: {
      sessionId: "session-a", toolName: "read_file",
      arguments: { path: "src/outside.txt" },
    },
  })}\n`);
  await watcher.poll();
  assert.equal(events.length, 2);
});

test("session watcher recovers startup attribution for context-less appended events", async () => {
  const workspace = path.join(testRoot, "workspace-context");
  const sessions = path.join(testRoot, "session-state-context");
  const sessionFile = path.join(sessions, "session-context", "events.jsonl");
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, `${JSON.stringify({
    id: "historical-context", type: "session.context_changed",
    data: { context: { cwd: workspace } },
  })}\n`);
  const events = [];
  const watcher = new SessionEventWatcher({
    sessionStateDirectory: sessions,
    workspaceRoot: workspace,
    onEvent: event => events.push(event),
  });

  await watcher.poll();
  assert.deepEqual(events, []);

  await fs.appendFile(sessionFile, `${JSON.stringify({
    id: "context-less-tool", type: "tool.execution_start",
    data: { toolName: "read_file", toolArgs: { path: "src/after-startup.ts" } },
  })}\n`);
  await watcher.poll();

  assert.deepEqual(events.map(event => event.id), ["context-less-tool"]);
});

test("session watcher retains flattened session-state tool fields", async () => {
  const workspace = path.join(testRoot, "workspace-flat");
  const sessions = path.join(testRoot, "session-state-flat");
  const sessionFile = path.join(sessions, "session-flat", "events.jsonl");
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, `${JSON.stringify({
    id: "flat-tool", type: "external_tool.requested", sessionId: "session-flat",
    cwd: workspace, data: JSON.stringify({ toolName: "read_file", arguments: { path: "src/flat.ts" } }),
  })}\n`);
  const events = [];
  const watcher = new SessionEventWatcher({
    sessionStateDirectory: sessions,
    workspaceRoot: workspace,
    onEvent: event => events.push(event),
  });
  await watcher.poll();
  await fs.appendFile(sessionFile, `${JSON.stringify({
    id: "flat-tool", type: "external_tool.requested", sessionId: "session-flat",
    cwd: workspace, data: JSON.stringify({ toolName: "read_file", arguments: { path: "src/flat.ts" } }),
  })}\n`);
  await watcher.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0].snippet, "read_file · src/flat.ts");
  assert.deepEqual(events[0].resources, [{ path: "src/flat.ts", action: "read", confidence: "observed" }]);
});

test("session watcher extracts file resources from nested view tool events", async () => {
  const workspace = path.join(testRoot, "workspace-view");
  const sessions = path.join(testRoot, "session-state-view");
  const sessionFile = path.join(sessions, "session-view", "events.jsonl");
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, `${JSON.stringify({
    id: "view-context", type: "session.context_changed",
    data: { context: { cwd: workspace } },
  })}\n`);
  const events = [];
  const watcher = new SessionEventWatcher({
    sessionStateDirectory: sessions,
    workspaceRoot: workspace,
    onEvent: event => events.push(event),
  });

  await watcher.poll();
  await fs.appendFile(sessionFile, `${JSON.stringify({
    id: "view-tool", type: "tool.execution_start",
    data: { toolName: "view", arguments: { path: path.join(workspace, "src/activity.ts") } },
  })}\n`);
  await watcher.poll();

  assert.equal(events.length, 1);
  assert.equal(events[0].tool, "view");
  assert.equal(events[0].snippet, "view · src/activity.ts");
  assert.deepEqual(events[0].resources, [{ path: "src/activity.ts", action: "read", confidence: "observed" }]);
});

test("session watcher handles new files, truncation, malformed lines, and bounded dedupe", async () => {
  const workspace = path.join(testRoot, "workspace-2");
  const sessions = path.join(testRoot, "session-state-2");
  const events = [];
  const watcher = new SessionEventWatcher({
    sessionStateDirectory: sessions,
    workspaceRoot: workspace,
    onEvent: event => events.push(event),
    maxSeenIds: 2,
    maxFiles: 2,
  });
  await watcher.poll();
  const file = path.join(sessions, "session-b", "events.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "not-json\n");
  await fs.appendFile(file, `${JSON.stringify({
    id: "b-start", type: "session.start", data: { context: { cwd: workspace } },
  })}\n`);
  await watcher.poll();
  assert.equal(events.length, 1);

  await fs.truncate(file, 0);
  await fs.appendFile(file, `${JSON.stringify({
    id: "b-tool", type: "tool.execution_start",
    data: { workingDirectory: workspace, toolName: "shell" },
  })}\n`);
  await watcher.poll();
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "tool");
  assert.equal(events[1].source.client, "unknown");
});

test("session watcher retains cursors while files leave and re-enter the active window", async () => {
  const workspace = path.join(testRoot, "workspace-reentry");
  const sessions = path.join(testRoot, "session-state-reentry");
  const firstFile = path.join(sessions, "session-first", "events.jsonl");
  const secondFile = path.join(sessions, "session-second", "events.jsonl");
  const eventFor = id => JSON.stringify({
    id, type: "session.start", data: { context: { cwd: workspace } },
  }) + "\n";
  await fs.mkdir(path.dirname(firstFile), { recursive: true });
  await fs.mkdir(path.dirname(secondFile), { recursive: true });
  await fs.writeFile(firstFile, eventFor("first-history"));
  await fs.writeFile(secondFile, eventFor("second-history"));
  await fs.utimes(firstFile, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  await fs.utimes(secondFile, new Date("2021-01-01T00:00:00Z"), new Date("2021-01-01T00:00:00Z"));

  const events = [];
  const watcher = new SessionEventWatcher({
    sessionStateDirectory: sessions,
    workspaceRoot: workspace,
    onEvent: event => events.push(event),
    maxFiles: 1,
  });
  await watcher.poll();

  await fs.appendFile(secondFile, eventFor("second-before-eviction"));
  await fs.utimes(firstFile, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  await fs.utimes(secondFile, new Date("2021-01-01T00:00:00Z"), new Date("2021-01-01T00:00:00Z"));
  await watcher.poll();
  assert.deepEqual(events.map(event => event.id), ["second-before-eviction"]);

  await fs.utimes(firstFile, new Date("2022-01-01T00:00:00Z"), new Date("2022-01-01T00:00:00Z"));
  await fs.utimes(secondFile, new Date("2021-01-01T00:00:00Z"), new Date("2021-01-01T00:00:00Z"));
  await watcher.poll();
  await fs.appendFile(firstFile, eventFor("first-after-reentry"));
  await fs.utimes(firstFile, new Date("2022-01-01T00:00:00Z"), new Date("2022-01-01T00:00:00Z"));
  await watcher.poll();

  await fs.utimes(secondFile, new Date("2023-01-01T00:00:00Z"), new Date("2023-01-01T00:00:00Z"));
  await fs.utimes(firstFile, new Date("2022-01-01T00:00:00Z"), new Date("2022-01-01T00:00:00Z"));
  await watcher.poll();
  assert.deepEqual(events.map(event => event.id), [
    "second-before-eviction", "first-after-reentry",
  ]);
});

test("session watcher reads genuinely new paths from zero without birthtime", async () => {
  const workspace = path.join(testRoot, "workspace-new-path");
  const sessions = path.join(testRoot, "session-state-new-path");
  const events = [];
  const watcher = new SessionEventWatcher({
    sessionStateDirectory: sessions,
    workspaceRoot: workspace,
    onEvent: event => events.push(event),
    maxFiles: 1,
  });
  await watcher.poll();

  const file = path.join(sessions, "session-new-path", "events.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({
    id: "new-path-event", type: "session.start", data: { context: { cwd: workspace } },
  })}\n`);
  await watcher.poll();

  assert.deepEqual(events.map(event => event.id), ["new-path-event"]);
});

test("session watcher retries a failed enqueue before later lines in order", async () => {
  const workspace = path.join(testRoot, "workspace-retry");
  const sessions = path.join(testRoot, "session-state-retry");
  const sessionFile = path.join(sessions, "session-retry", "events.jsonl");
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  const line = id => JSON.stringify({
    id, type: "tool.execution_start",
    data: { context: { cwd: workspace }, toolName: "read_file", toolArgs: { path: `${id}.ts` } },
  }) + "\n";
  const attempts = [];
  const delivered = [];
  let fail = true;
  const watcher = new SessionEventWatcher({
    sessionStateDirectory: sessions,
    workspaceRoot: workspace,
    onEvent: async event => {
      attempts.push(event.id);
      if (event.id === "retry" && fail) {
        fail = false;
        throw new Error("simulated enqueue failure");
      }
      delivered.push(event.id);
    },
  });

  await watcher.poll();
  await fs.writeFile(sessionFile, line("retry") + line("later"));
  await watcher.poll();
  assert.deepEqual(attempts, ["retry"]);
  assert.deepEqual(delivered, []);

  await watcher.poll();
  assert.deepEqual(attempts, ["retry", "retry", "later"]);
  assert.deepEqual(delivered, ["retry", "later"]);
});

test("session watcher does not replay old files re-entering the bounded set", async () => {
  const workspace = path.join(testRoot, "workspace-3");
  const sessions = path.join(testRoot, "session-state-3");
  const oldFile = path.join(sessions, "session-old", "events.jsonl");
  const selectedFile = path.join(sessions, "session-selected", "events.jsonl");
  const eventFor = id => JSON.stringify({
    id, type: "session.start", data: { context: { cwd: workspace } },
  }) + "\n";
  await fs.mkdir(path.dirname(oldFile), { recursive: true });
  await fs.mkdir(path.dirname(selectedFile), { recursive: true });
  await fs.writeFile(oldFile, eventFor("old-history"));
  await fs.writeFile(selectedFile, eventFor("selected-history"));
  await fs.utimes(oldFile, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  await fs.utimes(selectedFile, new Date("2021-01-01T00:00:00Z"), new Date("2021-01-01T00:00:00Z"));

  const events = [];
  const watcher = new SessionEventWatcher({
    sessionStateDirectory: sessions,
    workspaceRoot: workspace,
    onEvent: event => events.push(event),
    maxFiles: 1,
  });
  await watcher.poll();
  assert.deepEqual(events, []);

  await fs.utimes(oldFile, new Date("2022-01-01T00:00:00Z"), new Date("2022-01-01T00:00:00Z"));
  await watcher.poll();
  assert.deepEqual(events, []);

  const newFile = path.join(sessions, "session-new", "events.jsonl");
  await fs.mkdir(path.dirname(newFile), { recursive: true });
  await fs.writeFile(newFile, eventFor("new-session"));
  await watcher.poll();
  assert.deepEqual(events.map(event => event.id), ["new-session"]);
});

test("session watcher canonicalizes symlinked roots and filters explicit contexts", async () => {
  const workspace = path.join(testRoot, "canonical-workspace");
  const workspaceAlias = path.join(testRoot, "canonical-workspace-link");
  const outside = path.join(testRoot, "canonical-outside");
  const sessions = path.join(testRoot, "canonical-session-state");
  const sessionFile = path.join(sessions, "session-c", "events.jsonl");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(workspace, workspaceAlias);
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  const events = [];
  const watcher = new SessionEventWatcher({
    sessionStateDirectory: sessions,
    workspaceRoot: workspaceAlias,
    onEvent: event => events.push(event),
  });
  await watcher.poll();
  await fs.writeFile(sessionFile, [
    {
      id: "inside-alias", type: "session.start",
      data: { context: { cwd: workspaceAlias } },
    },
    {
      id: "outside", type: "session.start",
      data: { context: { cwd: outside } },
    },
  ].map(event => JSON.stringify(event)).join("\n") + "\n");
  await watcher.poll();
  assert.equal(workspaceIdentity(workspaceAlias), workspaceIdentity(workspace));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].workspace, {
    id: workspaceIdentity(workspace),
    root: workspace,
    repository: path.basename(workspace),
  });
});

test("token is sent only in collector headers and never persisted", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "token"));
  let request;
  const transport = new ActivityTransport({
    ingestUrl: "http://localhost:4180/api/activity/events", spool, activityToken: "local-token",
    fetchImpl: async (...args) => { request = args; return { ok: true }; },
  });
  await transport.enqueue({ id: "token-event", schemaVersion: 1 });
  await transport.flush();
  assert.equal(request[1].headers["X-Codewalk-Activity-Token"], "local-token");
  assert.equal(request[1].headers["content-type"], "application/json");
  assert.equal(request[1].body.endsWith("\n"), false);
  assert.equal(JSON.stringify(await spool.read()).includes("local-token"), false);
});

test("uses the local Codewalk collector endpoint by default", () => {
  const previous = process.env.CODEWALK_INGEST_URL;
  delete process.env.CODEWALK_INGEST_URL;
  try {
    assert.equal(new ActivityTransport().ingestUrl, "http://127.0.0.1:4180/api/activity/events");
  } finally {
    if (previous === undefined) delete process.env.CODEWALK_INGEST_URL;
    else process.env.CODEWALK_INGEST_URL = previous;
  }
});

test("hook append is not delayed by a stalled collector", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "stalled"));
  const stalled = new ActivityTransport({
    ingestUrl: "http://localhost:8787/activity", spool,
    fetchImpl: () => new Promise(() => {}), timeoutMs: 60_000,
  });
  await stalled.enqueue({ id: "stalled", schemaVersion: 1 });
  const flushing = stalled.flush();
  await new Promise(resolve => setImmediate(resolve));
  const started = Date.now();
  await new ActivityTransport({ spool }).enqueue({ id: "hook", schemaVersion: 1 });
  assert.ok(Date.now() - started < 500);
  // Do not leave a never-ending promise in the test process.
  void flushing;
});

test("separate hook processes append without losing record IDs", async () => {
  const spoolDir = path.join(testRoot, "concurrent");
  const hook = path.join(process.cwd(), "bin", "hook.mjs");
  const payload = JSON.stringify({ sessionId: "parallel", workingDirectory: testRoot, toolName: "read_file", toolArgs: { path: "src/a.ts" } });
  const run = index => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, "preToolUse"], {
      cwd: process.cwd(),
      env: {
        ...process.env, CODEWALK_SPOOL_DIR: spoolDir, CODEWALK_WORKSPACE_ROOT: testRoot,
        CODEWALK_DISABLE_TAILER: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`hook exited ${code}`)));
    child.stdin.end(JSON.stringify({
      ...JSON.parse(payload), toolCallId: `call-${index}`,
    }));
  });
  await Promise.all(Array.from({ length: 12 }, (_, index) => run(index)));
  const events = await new BoundedSpool(spoolDir).read();
  assert.equal(events.length, 12);
  assert.equal(new Set(events.map(event => event.id)).size, 12);
});

test("separate hook processes share near-duplicate state", async () => {
  const spoolDir = path.join(testRoot, "cross-process-near-duplicate");
  const hook = path.join(process.cwd(), "bin", "hook.mjs");
  const run = timestamp => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, "preToolUse"], {
      cwd: process.cwd(),
      env: {
        ...process.env, CODEWALK_SPOOL_DIR: spoolDir, CODEWALK_WORKSPACE_ROOT: testRoot,
        CODEWALK_DISABLE_TAILER: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`hook exited ${code}`)));
    child.stdin.end(JSON.stringify({
      sessionId: "cross-process",
      timestamp,
      workingDirectory: testRoot,
      toolName: "read_file",
      toolArgs: { path: "README.md" },
      prompt: "must not be persisted",
    }));
  });
  await Promise.all([
    run("2026-08-26T16:17:32.520Z"),
    run("2026-08-26T16:17:32.625Z"),
  ]);
  const spool = new BoundedSpool(spoolDir);
  assert.equal((await spool.read()).length, 1);
  assert.equal((await fs.readFile(spool.nearDuplicateFile, "utf8")).includes(testRoot), false);
});

test("fresh lock acquisition is not reclaimed before its owner marker exists", async () => {
  const spoolDir = path.join(testRoot, "lock-race");
  const spool = new BoundedSpool(spoolDir);
  await spool.initialize();
  const lock = path.join(spoolDir, ".mutate.lock");
  await fs.mkdir(lock);
  await assert.rejects(new BoundedSpool(spoolDir).append({ id: "blocked" }), /lock timeout/);
  await fs.rm(lock, { recursive: true, force: true });
  assert.equal(await spool.append({ id: "after" }), true);
});

test("supports IPv6 loopback and a permission-protected token file", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "ipv6"));
  const tokenFile = path.join(testRoot, "activity-token");
  await fs.mkdir(testRoot, { recursive: true });
  await fs.writeFile(tokenFile, "file-token\n", { mode: 0o600 });
  let request;
  const transport = new ActivityTransport({
    ingestUrl: "http://[::1]:4180/api/activity/events",
    activityTokenFile: tokenFile,
    spool,
    fetchImpl: async (...args) => { request = args; return { ok: true }; },
  });
  await transport.enqueue({ id: "ipv6-event", schemaVersion: 1 });
  await transport.flush();
  assert.ok(transport.ingestUrl?.includes("[::1]"));
  assert.equal(request[1].headers["X-Codewalk-Activity-Token"], "file-token");
});

test("capability reporting does not claim standalone app support", () => {
  assert.equal(reportCapabilities({ client: "copilot-cli" }).status, "verified");
  const app = reportCapabilities({ client: "copilot-app" });
  assert.equal(app.status, "unverified");
  assert.equal(app.sessionListener.observed, false);
});

test("filesystem hook configuration includes portable commands and failures", async () => {
  const config = JSON.parse(await fs.readFile(path.join(process.cwd(), "hooks", "hooks.json"), "utf8"));
  const failure = config.hooks.postToolUseFailure[0];
  assert.equal(failure.type, "command");
  assert.match(failure.bash, /hook\.mjs.*postToolUseFailure/);
  assert.match(failure.bash, /COPILOT_HOME/);
  assert.match(failure.powershell, /COPILOT_HOME/);
  assert.equal(failure.timeoutSec, 3);
});

test("records permanent rejection fields without retaining event or response content", async () => {
  const spool = new BoundedSpool(path.join(testRoot, "delivery-rejection-diagnostic"));
  const runtimeDir = path.join(testRoot, "runtime");
  const delivered = [];
  const transport = new ActivityTransport({
    ingestUrl: "http://localhost:8787/activity",
    runtimeDir,
    spool,
    fetchImpl: async (_url, request) => {
      const event = JSON.parse(request.body);
      delivered.push(event.id);
      if (event.id === "invalid") {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            code: "UNSUPPORTED_EVENT_FIELD",
            fields: ["line"],
            message: "RESPONSE_SECRET",
          }),
        };
      }
      return { ok: true, status: 202 };
    },
  });
  await transport.enqueue({ id: "invalid", content: "EVENT_SECRET" });
  await transport.enqueue({ id: "valid", timestamp: "2026-08-27T00:00:00.000Z" });

  assert.equal(await transport.flush(), true);
  assert.equal(transport.rejectionCount, 1);
  assert.deepEqual(delivered, ["invalid", "valid"]);
  assert.deepEqual(await spool.read(), []);

  const diagnostic = await fs.readFile(path.join(runtimeDir, "activity-transport.log"), "utf8");
  assert.match(diagnostic, /"status":400/);
  assert.match(diagnostic, /"code":"UNSUPPORTED_EVENT_FIELD"/);
  assert.match(diagnostic, /"fields":\["line"\]/);
  assert.equal(diagnostic.includes("EVENT_SECRET"), false);
  assert.equal(diagnostic.includes("RESPONSE_SECRET"), false);
});
