import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactError, redactString } from "./redact.mjs";
import { inferredActivityResources, normalizeResourcePath, resourcesFrom } from "./paths.mjs";

export const SCHEMA_VERSION = 1;

// The collector rejects an event carrying more than 32 resources. Observed and
// inferred resources are capped independently upstream, so the concatenation
// below must be re-capped or a busy patch plus a busy shell command emits 64.
export const MAX_EVENT_RESOURCES = 32;

const LIFECYCLE = new Map([
  ["session.start", ["session", "started"]],
  ["session.resume", ["session", "resumed"]],
  ["session.idle", ["session", "idle"]],
  ["session.shutdown", ["session", "completed"]],
  ["session.error", ["error", "failed"]],
  ["session.warning", ["error", "warning"]],
  ["session.context_changed", ["session", "updated"]],
  ["session.task_complete", ["session", "task_complete"]],
  ["user.message", ["prompt", "submitted"]],
  ["assistant.message", ["assistant", "completed"]],
  ["assistant.message_delta", ["assistant", "streaming"]],
  ["tool.execution_start", ["tool", "started"]],
  ["tool.execution_complete", ["tool", "completed"]],
  ["tool.execution_failure", ["tool", "failed"]],
  ["permission.requested", ["permission", "requested"]],
  ["permission.completed", ["permission", "completed"]],
  ["permission.granted", ["permission", "granted"]],
  ["permission.denied", ["permission", "denied"]],
  ["agent.started", ["agent", "started"]],
  ["agent.completed", ["agent", "completed"]],
  ["agent.failed", ["agent", "failed"]],
  ["subagent.started", ["agent", "started"]],
  ["subagent.completed", ["agent", "completed"]],
  ["subagent.failed", ["agent", "failed"]],
]);
const SESSION_AGENT_EVENT_TYPES = new Set([
  "user.message",
  "assistant.message",
  "assistant.message_delta",
]);

// The SDK's `PermissionRequest` is kind-discriminated by a short lowercase
// token (shell/file-edit/url/mcp variants); anything wider than that is not a
// value this file was built against, so it is dropped rather than copied.
const PERMISSION_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// The SDK's `PermissionResult` union (docs/copilot-payloads.md §2c) — exactly
// these nine `kind` values exist; anything else becomes "unknown" rather than
// passing an unrecognized token through.
const PERMISSION_RESULT_VALUES = new Set([
  "approved",
  "approved-for-session",
  "approved-for-location",
  "cancelled",
  "denied-by-rules",
  "denied-no-approval-rule-and-could-not-request-from-user",
  "denied-interactively-by-user",
  "denied-by-content-exclusion-policy",
  "denied-by-permission-request-hook",
]);
// `ToolResultObject.resultType` (postToolUse hook input).
const HOOK_RESULT_TYPE_PATTERN = /^(success|failure|rejected|denied|timeout)$/;
const MAX_METADATA_NUMBER = 2 ** 53;
const EXIT_CODE_MIN = -(2 ** 31);
const EXIT_CODE_MAX = 2 ** 31;

function stringOrUndefined(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Bounded, non-negative integer; anything else (float, NaN, out of range) is dropped. */
function boundedCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_METADATA_NUMBER
    ? value
    : undefined;
}

/** Bounded integer allowing a sign, for shell exit codes specifically. */
function boundedExitCode(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= EXIT_CODE_MIN && value <= EXIT_CODE_MAX
    ? value
    : undefined;
}

/** A count derived from text length, never the text itself. */
function boundedByteLength(value) {
  return typeof value === "string" ? boundedCount(Buffer.byteLength(value, "utf8")) : undefined;
}

/** The first `shell_exit` content block's exit code, if any. */
function shellExitCode(result) {
  const contents = Array.isArray(result?.contents) ? result.contents : [];
  const block = contents.find(item => item && typeof item === "object" && item.type === "shell_exit");
  return block ? boundedExitCode(block.exitCode) : undefined;
}

/** The postToolUse hook's `toolResult`, when this event came from that hook. */
function hookToolResult(data) {
  const toolResult = data?.toolResult;
  return toolResult && typeof toolResult === "object" && !Array.isArray(toolResult) ? toolResult : undefined;
}

function hookResultType(data) {
  const resultType = stringOrUndefined(hookToolResult(data)?.resultType);
  return resultType && HOOK_RESULT_TYPE_PATTERN.test(resultType) ? resultType : undefined;
}

/**
 * Outcome scalars for `tool.execution_complete`. Two unrelated shapes share
 * this raw type: the SDK's `ToolExecutionCompleteData` (`result`,
 * `toolTelemetry`) and the postToolUse hook's `toolResult`
 * (`ToolResultObject`). Neither defines the other's keys, so reading both
 * unconditionally is safe — only the shape actually present contributes.
 */
function toolCompleteOutcomeMetadata(data) {
  const metadata = {};
  const metrics = data?.toolTelemetry?.metrics;
  const exitCode = shellExitCode(data?.result) ?? boundedExitCode(metrics?.exit_code);
  if (exitCode !== undefined) metadata.exitCode = exitCode;

  const toolResult = hookToolResult(data);
  const bytes = boundedCount(metrics?.mcp_result_content_bytes)
    ?? boundedByteLength(data?.result?.content)
    ?? (toolResult ? boundedByteLength(toolResult.textResultForLlm) : undefined);
  if (bytes !== undefined) metadata.bytes = bytes;

  const durationMs = boundedCount(metrics?.durationMs);
  if (durationMs !== undefined) metadata.durationMs = durationMs;

  const resultType = hookResultType(data);
  if (resultType) metadata.status = resultType;

  return metadata;
}

function displaySessionName(value) {
  const name = stringOrUndefined(value)?.replace(/\s+/g, " ").trim();
  if (!name) return undefined;
  return redactString(name, { preservePaths: true }).slice(0, 160);
}

function isoTimestamp(value, fallback) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if ((typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && value.length)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return fallback;
}

function sourceFor(context = {}, kind = "hook") {
  const client = context.client === "copilot-app" || context.client === "copilot-cli" ? context.client : "unknown";
  const source = { client, kind };
  const version = stringOrUndefined(context.version);
  if (version) source.version = redactString(version).slice(0, 64);
  return source;
}

function eventData(raw) {
  if (!raw || typeof raw !== "object") return {};
  let nested = raw.data;
  if (typeof nested === "string") {
    try { nested = JSON.parse(nested); } catch { nested = undefined; }
  }
  return nested && typeof nested === "object" && !Array.isArray(nested) ? { ...raw, ...nested } : raw;
}

export function canonicalWorkspaceRoot(value) {
  if (typeof value !== "string" || !value) return undefined;
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return resolved;
    throw error;
  }
}

export function workspaceIdentity(workspaceRoot) {
  const canonical = canonicalWorkspaceRoot(workspaceRoot);
  if (!canonical) return undefined;
  const normalized = canonical.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `local-${normalized.length.toString(16)}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function inferType(rawType) {
  if (LIFECYCLE.has(rawType)) return LIFECYCLE.get(rawType);
  if (/permission/i.test(rawType)) return ["permission", "requested"];
  if (/prompt|user/i.test(rawType)) return ["prompt", "submitted"];
  if (/assistant|response|message/i.test(rawType)) return ["assistant", "completed"];
  if (/tool|execute/i.test(rawType)) return ["tool", /fail|error|denied/i.test(rawType) ? "failed" : "started"];
  if (/agent|subagent/i.test(rawType)) return ["agent", /fail|error/i.test(rawType) ? "failed" : "started"];
  if (/error|fail/i.test(rawType)) return ["error", "failed"];
  return ["error", "unknown"];
}

function resourceAction(tool = "") {
  if (/search|grep|glob|find|query/i.test(tool)) return "search";
  if (/write|edit|create|patch|delete|remove|move|rename/i.test(tool)) return "write";
  if (/read|view|file|list|glob|grep|search|find/i.test(tool)) return "read";
  if (/shell|bash|powershell|terminal|exec|run/i.test(tool)) return "execute";
  return "reference";
}

function metadataFor(raw, rawType, unknown = false) {
  const data = eventData(raw);
  const metadata = {
    providerEventType: redactString(rawType).slice(0, 120),
  };
  if (unknown) metadata.unknownEvent = true;
  if (data.content !== undefined || data.prompt !== undefined || data.deltaContent !== undefined) metadata.contentAvailable = true;
  if (data.toolCallId) metadata.providerToolCallId = redactString(data.toolCallId).slice(0, 120);
  if (data.messageId) metadata.providerMessageId = redactString(data.messageId).slice(0, 120);
  if (data.error) {
    const error = redactError(data.error);
    if (error?.classification) metadata.errorClassification = error.classification;
    if (error?.code) metadata.errorCode = error.code;
  }
  const tool = stringOrUndefined(data.tool) ?? stringOrUndefined(data.toolName);
  const target = agentTargetFor(data, tool);
  if (target) {
    metadata.targetAgentId = redactString(target.id).slice(0, 160);
    if (target.nodeId) metadata.targetAgentNodeId = redactString(target.nodeId).slice(0, 160);
    if (target.sessionId) metadata.targetSessionId = redactString(target.sessionId).slice(0, 160);
    if (target.workspaceId) metadata.targetWorkspaceId = redactString(target.workspaceId).slice(0, 160);
  }

  if (rawType === "permission.requested") {
    // `permissionRequest` itself (diffs, file contents, prompts) is never
    // copied — only its `kind` discriminator, and only if it is the short
    // lowercase token the SDK's PermissionRequest union declares.
    const kind = data.permissionRequest?.kind;
    if (typeof kind === "string" && PERMISSION_KIND_PATTERN.test(kind)) metadata.permissionKind = kind;
  } else if (rawType === "permission.completed") {
    const kind = data.result?.kind;
    metadata.permissionResult = PERMISSION_RESULT_VALUES.has(kind) ? kind : "unknown";
  } else if (rawType === "tool.execution_complete") {
    Object.assign(metadata, toolCompleteOutcomeMetadata(data));
  } else if (rawType === "subagent.completed") {
    const durationMs = boundedCount(data.durationMs);
    if (durationMs !== undefined) metadata.durationMs = durationMs;
    const count = boundedCount(data.totalToolCalls);
    if (count !== undefined) metadata.count = count;
  } else if (rawType === "session.task_complete") {
    metadata.status = data.success ? "ok" : "failed";
  }

  return metadata;
}

// Free-text / content-bearing argument keys never reach `snippet`. Search-style
// keys (query, pattern, regex, glob) and path-style keys are deliberately not
// listed here: they are the useful part of a snippet, and already pass through
// `safeSnippetText`'s redaction and length bound.
const UNSAFE_SNIPPET_KEY = /(argument|body|code|command|content|contents|credential|data|description|diff|env|environment|html|input|instructions|markdown|message|notes|output|patch|payload|prompt|reason|response|result|secret|source|stack|stdout|stderr|summary|text|token)/i;
const PATCH_TEXT_KEY = /(?:diff|patch)/i;

function snippetPath(value, workspaceRoot) {
  const resource = normalizeResourcePath(value, workspaceRoot);
  if (resource?.outsideRoot) return resource.path;
  if (resource?.path !== undefined) return resource.path || "[workspace root]";
  return "[PATH]";
}

function redactSnippetPaths(value, workspaceRoot) {
  return String(value)
    .replace(/(^|[\s("'=])\.\.(?:[\\/][^ \t"'`<>|;&,)]+)+/g, (match, prefix) => `${prefix}${snippetPath(match.slice(prefix.length), workspaceRoot)}`)
    .replace(/(?<![\w./:-])(?:\/|[a-zA-Z]:[\\/])[^ \t"'`<>|;&,)]+/g, (candidate) => {
      return snippetPath(candidate, workspaceRoot);
    })
    .replace(/(^|[\s("'=])~[\\/][^ \t"'`<>|;&,)]+/g, (match, prefix) => `${prefix}${snippetPath(match.slice(prefix.length), workspaceRoot)}`);
}

function safeSnippetText(value, maxLength = 120, workspaceRoot) {
  if (value === undefined || value === null) return undefined;
  const snippet = redactString(redactSnippetPaths(value, workspaceRoot), { preservePaths: true })
    .replace(/[^\w .:/@+={}[\]-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return snippet || undefined;
}

function toolArgumentsFor(data) {
  const candidate = data?.toolArgs ?? data?.toolArguments ?? data?.arguments ?? data?.args ?? data?.parameters
    ?? data?.resources;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  if (typeof candidate === "string") {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function argumentValue(args, keys) {
  if (!args) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(args, key) && !UNSAFE_SNIPPET_KEY.test(key)) return args[key];
  }
  return undefined;
}

function agentTargetFor(data, tool) {
  if (!/^(?:read|write)_agent$/i.test(tool ?? "")) return undefined;
  const args = toolArgumentsFor(data);
  if (!args) return undefined;
  const identityKeys = [
    "targetAgentId", "target_agent_id",
    "recipientAgentId", "recipient_agent_id", "toAgentId", "to_agent_id",
    "agentId", "agent_id", "targetId", "target_id",
  ];
  const nodeIdKeys = ["targetAgentNodeId", "target_agent_node_id"];
  const objectKeys = ["target", "targetAgent", "target_agent", "recipient", "agent"];
  const directId = identityKeys.map(key => args[key]).find(value => typeof value === "string" && value.length > 0);
  const objectTarget = objectKeys.map(key => args[key]).find(value => value && typeof value === "object" && !Array.isArray(value));
  const target = objectTarget && typeof objectTarget === "object" ? objectTarget : undefined;
  const id = directId ?? (target && identityKeys.map(key => target[key]).find(value => typeof value === "string" && value.length > 0))
    ?? (target && typeof target.id === "string" && target.id.length > 0 ? target.id : undefined);
  if (!id) return undefined;
  const sessionId = (target && (target.targetSessionId ?? target.target_session_id ?? target.sessionId ?? target.session_id))
    ?? args.targetSessionId ?? args.target_session_id ?? args.sessionId ?? args.session_id;
  const workspaceId = (target && (target.targetWorkspaceId ?? target.target_workspace_id ?? target.workspaceId ?? target.workspace_id))
    ?? args.targetWorkspaceId ?? args.target_workspace_id ?? args.workspaceId ?? args.workspace_id;
  const nodeId = nodeIdKeys.map(key => args[key]).find(value => typeof value === "string" && value.length > 0)
    ?? (target && nodeIdKeys.map(key => target[key]).find(value => typeof value === "string" && value.length > 0));
  return {
    id,
    ...(typeof nodeId === "string" && nodeId.length > 0 ? { nodeId } : {}),
    ...(typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}),
    ...(typeof workspaceId === "string" && workspaceId.length > 0 ? { workspaceId } : {}),
  };
}

function displayArgument(value, workspaceRoot, key = "") {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "string" && /(?:paths?|file(?:name|path)?|directory|dir|cwd|workspace|uri)$/i.test(key)) {
      if (workspaceRoot) {
        const resource = normalizeResourcePath(value, workspaceRoot);
        if (resource?.outsideRoot) return resource.path;
        if (resource?.path !== undefined) return resource.path || "[workspace root]";
      }
    }
    return safeSnippetText(value, 72, workspaceRoot);
  }
  if (Array.isArray(value)) {
    const items = value
      .filter(item => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
      .slice(0, 4)
      .map(item => displayArgument(item, workspaceRoot, key))
      .filter(Boolean);
    return items.length ? items.join(",") : undefined;
  }
  return undefined;
}

function joinSnippetParts(parts) {
  return parts.filter(Boolean).join(" · ").slice(0, 120);
}

function patchFileCount(data, args) {
  const patchTexts = args
    ? Object.entries(args)
    .filter(([key, value]) => PATCH_TEXT_KEY.test(key) && typeof value === "string")
    .map(([, value]) => value)
    : [];
  for (const key of ["patch", "diff", "patchText", "patch_text", "unifiedDiff", "unified_diff", "input", "arguments", "toolArgs", "toolArguments"]) {
    if (typeof data?.[key] === "string") patchTexts.push(data[key]);
  }
  const patchText = patchTexts.join("\n");
  if (!patchText) return 0;
  const files = new Set();
  const headers = [
    /\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*([^\r\n]+)/gi,
    /^(?:---|\+\+\+)\s+([^\t\r\n ]+)/gm,
  ];
  for (const header of headers) {
    for (const match of patchText.matchAll(header)) {
      const file = match[1].trim().replace(/^(?:a|b)\//, "");
      if (file && file !== "/dev/null") files.add(file);
      if (files.size >= 32) return files.size;
    }
  }
  return files.size;
}

function argumentSnippet(data, tool, toolArgs, workspaceRoot) {
  const name = safeSnippetText(tool, 80, workspaceRoot);
  if (!name) return undefined;
  const normalizedTool = tool.toLowerCase();
  if (/apply[-_]?patch|patch/.test(normalizedTool)) {
    const fileCount = patchFileCount(data, toolArgs);
    return joinSnippetParts([name, `${fileCount} file${fileCount === 1 ? "" : "s"}`]);
  }

  if (/^view(?:[-_]|$)|read[-_]?file|cat/.test(normalizedTool)) {
    const path = displayArgument(argumentValue(toolArgs, ["path", "filePath", "file", "filename", "directory"]), workspaceRoot, "path");
    return joinSnippetParts([name, path]);
  }

  if (/^(?:rg|ripgrep)(?:[-_]|$)|search|grep/.test(normalizedTool)) {
    const pattern = displayArgument(argumentValue(toolArgs, ["pattern", "searchTerm", "term", "query"]), workspaceRoot);
    const path = displayArgument(argumentValue(toolArgs, ["path", "paths", "directory", "glob"]), workspaceRoot, "path");
    return joinSnippetParts([name, pattern, path]);
  }

  if (/sql|query/.test(normalizedTool)) {
    const query = argumentValue(toolArgs, ["query", "sql", "statement"])
      ?? argumentValue(toolArgs, ["operation", "action"]);
    const operation = typeof query === "string" ? query.match(/^\s*(select|insert|update|delete|with|create|alter|drop|pragma)\b/i)?.[1] : undefined;
    return joinSnippetParts([name, operation?.toUpperCase()]);
  }

  const parts = Object.entries(toolArgs ?? {})
    .filter(([key]) => /^[a-zA-Z0-9_.-]{1,48}$/.test(key) && !UNSAFE_SNIPPET_KEY.test(key))
    .slice(0, 4)
    .map(([key, value]) => {
      const rendered = displayArgument(value, workspaceRoot, key);
      return rendered ? `${key}=${rendered}` : undefined;
    })
    .filter(Boolean);
  return joinSnippetParts([name, ...parts]) || name;
}

function snippetFor(data, tool, workspaceRoot) {
  const toolArgs = toolArgumentsFor(data);
  const candidate = data?.command ?? data?.cmd ?? data?.shellCommand ?? data?.commandLine
    ?? (toolArgs ? toolArgs.command ?? toolArgs.cmd : undefined);
  if (typeof candidate === "string" && candidate.trim()) return safeSnippetText(candidate, 120, workspaceRoot);
  return argumentSnippet(data, tool, toolArgs, workspaceRoot);
}

function deterministicHookId(event) {
  const identity = { ...event };
  delete identity.id;
  return `hook-${crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/**
 * Normalize an SDK SessionEvent or a Copilot hook payload. No content-like
 * value is copied into the envelope; callers can opt into content references.
 */
export function normalizeEvent(raw, context = {}, options = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const rawType = stringOrUndefined(input.type) ?? stringOrUndefined(context.hookName) ?? "unknown";
  const [type, inferredStatus] = inferType(rawType);
  const data = eventData(input);
  const sessionId = stringOrUndefined(input.sessionId) ?? stringOrUndefined(data.sessionId) ??
    stringOrUndefined(context.sessionId) ?? "unknown";
  const timestamp = isoTimestamp(input.timestamp, isoTimestamp(context.timestamp, new Date().toISOString()));
  const tool = stringOrUndefined(input.tool) ?? stringOrUndefined(data.tool) ?? stringOrUndefined(data.toolName) ?? stringOrUndefined(context.toolName);
  const topLevelSession = sessionId !== "unknown"
    && (rawType.startsWith("session.") || SESSION_AGENT_EVENT_TYPES.has(rawType));
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    id: stringOrUndefined(input.id) ?? crypto.randomUUID(),
    sessionId: redactString(sessionId).slice(0, 160),
    timestamp,
    type,
    source: sourceFor(context, context.sourceKind ?? (context.hookName ? "hook" : "sdk")),
  };
  const sessionName = displaySessionName(input.sessionName ?? data.sessionName ?? context.sessionName);
  if (sessionName) envelope.sessionName = sessionName;
  const agentName = displaySessionName(input.agentName ?? input.agentLabel ?? data.agentName ?? data.agentLabel
    ?? input.agent?.name ?? input.agent?.label ?? data.agent?.name ?? data.agent?.label
    ?? context.agentName ?? context.agentLabel);
  if (agentName) envelope.agentName = agentName;
  const parentId = stringOrUndefined(input.parentId) ?? stringOrUndefined(data.parentToolCallId) ?? stringOrUndefined(context.parentId);
  if (parentId) envelope.parentId = redactString(parentId).slice(0, 160);
  const ids = [
    ["agentId", input.agentId ?? data.agentId ?? context.agentId ?? (topLevelSession ? `session:${sessionId}` : undefined)],
    ["turnId", input.turnId ?? data.turnId ?? context.turnId],
    // `permission.requested` often carries only `requestId` (no `toolCallId`
    // yet); `permission.completed` usually carries both. Falling back on both
    // sides lets the frontend pair the two events on one `toolCallId`.
    ["toolCallId", input.toolCallId ?? data.toolCallId ?? context.toolCallId
      ?? (type === "permission" ? data.requestId : undefined)],
  ];
  for (const [key, value] of ids) if (stringOrUndefined(value)) envelope[key] = redactString(value).slice(0, 160);
  let status = inferredStatus;
  if (rawType === "tool.execution_complete") {
    // Two independent failure signals share this raw type: the SDK's
    // `data.success === false` and the postToolUse hook's non-success
    // `toolResult.resultType`. Either one means the tool failed.
    const resultType = hookResultType(data);
    if (data.success === false || (resultType && resultType !== "success")) status = "failed";
  }
  if (status) envelope.status = status;
  if (tool) envelope.tool = redactString(tool).slice(0, 120);
  const workspaceRoot = options.workspaceRoot ?? context.workspaceRoot ?? context.workingDirectory ?? context.cwd
    ?? data.workspaceRoot ?? data.workingDirectory ?? data.cwd ?? data.context?.workspaceRoot ?? data.context?.cwd;
  const snippet = snippetFor(data, tool, workspaceRoot);
  if (snippet) envelope.snippet = snippet;
  const toolArgs = toolArgumentsFor(data) ?? toolArgumentsFor(context);
  const resourcesValue = data.resources;
  const hasResources = (typeof resourcesValue === "string" && resourcesValue.trim().length > 0)
    || (resourcesValue && typeof resourcesValue === "object"
      && (Array.isArray(resourcesValue) ? resourcesValue.length > 0 : Object.keys(resourcesValue).length > 0));
  const resourcesInput = hasResources ? resourcesValue : toolArgs;
  const resources = resourcesFrom(resourcesInput, workspaceRoot, tool);
  const inferredResources = inferredActivityResources(data, workspaceRoot, tool);
  if (resources.length) {
    const action = resourceAction(tool ?? "");
    envelope.resources = [...resources, ...inferredResources]
      .slice(0, MAX_EVENT_RESOURCES)
      .map((resource) => ({ ...resource, action: resource.action === "reference" ? action : resource.action }));
  } else if (inferredResources.length) {
    envelope.resources = inferredResources.slice(0, MAX_EVENT_RESOURCES);
  }
  const workspaceId = stringOrUndefined(context.workspaceId) ?? workspaceIdentity(workspaceRoot);
  const canonicalRoot = canonicalWorkspaceRoot(workspaceRoot);
  if (workspaceId) {
    envelope.workspace = {
      id: redactString(workspaceId).slice(0, 160),
      ...(canonicalRoot
        ? {
            root: canonicalRoot,
            repository: redactString(path.basename(canonicalRoot)).slice(0, 160),
          }
        : {}),
    };
  }
  envelope.metadata = metadataFor(input, rawType, !LIFECYCLE.has(rawType));
  if (options.contentRef && typeof options.contentRef === "string") {
    envelope.metadata.contentAvailable = true;
  }
  return envelope;
}

export function normalizeHook(hookName, payload, context = {}, options = {}) {
  const hookContext = {
    ...context,
    ...payload,
    hookName,
    sourceKind: "hook",
    toolArgs: payload?.toolArgs,
  };
  const raw = {
    id: payload?.eventId,
    timestamp: payload?.timestamp,
    type: hookName === "userPromptSubmitted" ? "user.message"
      : hookName === "preToolUse" ? "tool.execution_start"
      : hookName === "postToolUse" ? "tool.execution_complete"
      : hookName === "postToolUseFailure" ? "tool.execution_failure"
      : hookName === "preMcpToolCall" ? "tool.execution_start"
      : hookName === "sessionStart" ? "session.start"
      : hookName === "sessionEnd" ? "session.shutdown"
      : hookName === "agentStop" ? "agent.completed"
      : hookName === "subagentStop" ? "agent.completed"
      : hookName === "errorOccurred" ? "session.error"
      : hookName,
    data: payload,
  };
  if (hookName === "sessionEnd") raw.data = { ...payload, sessionId: payload?.sessionId };
  const event = normalizeEvent(raw, hookContext, options);
  return stringOrUndefined(payload?.eventId) ? event : { ...event, id: deterministicHookId(event) };
}

export function validateEnvelope(event) {
  const required = ["schemaVersion", "id", "sessionId", "timestamp", "type"];
  return Boolean(event && required.every((key) => typeof event[key] === "string" || (key === "schemaVersion" && event[key] === SCHEMA_VERSION)));
}
