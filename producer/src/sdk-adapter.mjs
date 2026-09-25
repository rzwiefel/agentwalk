import { normalizeEvent, normalizeHook } from "./contract.mjs";

export function approveExtensionPermission(request) {
  if (request?.kind === "extension-permission-access" && typeof request.extensionName === "string") {
    return {
      kind: "approved-for-session",
      approval: {
        kind: "extension-permission-access",
        extensionName: request.extensionName,
      },
    };
  }
  return { kind: "no-result" };
}

// Register only event types represented by the installed SDK. The SDK's
// wildcard overload attempts to decode every timeline entry, including
// runtime-internal model.* entries that are not part of SessionEvent.
export const OBSERVED_SESSION_EVENTS = [
  "session.start",
  "session.resume",
  "session.idle",
  "session.shutdown",
  "session.error",
  "session.warning",
  "session.context_changed",
  "session.task_complete",
  "user.message",
  "assistant.message",
  "assistant.message_delta",
  "tool.execution_start",
  "tool.execution_complete",
  "permission.requested",
  "permission.completed",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
];

export async function attachToSession(runtime, { context = {}, onEvent = () => {}, options = {}, hooks } = {}) {
  let session = runtime?.session ?? (typeof runtime?.on === "function" ? runtime : undefined);
  if (!session && typeof runtime?.joinSession === "function") session = await runtime.joinSession({ hooks });
  if (!session || typeof session.on !== "function") return { attached: false, reason: "session-listener-unavailable" };
  if (session.on.length < 2) return { attached: false, reason: "typed-session-listener-unavailable" };
  const unsubscribers = OBSERVED_SESSION_EVENTS.map(eventType => session.on(eventType, (event) => {
    onEvent(normalizeEvent(event, {
      ...context,
      sessionId: event?.data?.sessionId ?? event?.sessionId ?? session.sessionId ?? context.sessionId,
      sourceKind: "sdk",
    }, options));
  }));
  return {
    attached: true,
    sessionId: session.sessionId,
    unsubscribe: () => unsubscribers.forEach(unsubscribe => unsubscribe?.()),
  };
}

export function createHooks({ emit, context = {}, options = {} } = {}) {
  const send = (name, input = {}, invocation = {}) => {
    const payload = { ...input, sessionId: input.sessionId ?? invocation.sessionId ?? context.sessionId };
    const event = normalizeHook(name, payload, {
      ...context,
      workingDirectory: input.workingDirectory ?? context.workingDirectory,
      hookName: name,
      sourceKind: "sdk",
    }, options);
    return Promise.resolve(emit?.(event)).then(() => undefined).catch(() => undefined);
  };
  return {
    onSessionStart: (input, invocation) => send("sessionStart", input, invocation),
    onSessionEnd: (input, invocation) => send("sessionEnd", input, invocation),
    onUserPromptSubmitted: (input, invocation) => send("userPromptSubmitted", input, invocation),
    onPreToolUse: (input, invocation) => send("preToolUse", input, invocation),
    onPreMcpToolCall: (input, invocation) => send("preMcpToolCall", input, invocation),
    onPostToolUse: (input, invocation) => send("postToolUse", input, invocation),
    onPostToolUseFailure: (input, invocation) => send("postToolUseFailure", input, invocation),
    onErrorOccurred: (input, invocation) => send("errorOccurred", input, invocation),
    onAgentStop: (input, invocation) => send("agentStop", input, invocation),
  };
}
