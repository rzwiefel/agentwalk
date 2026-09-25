/**
 * Cross-layer conformance corpus.
 *
 * `generateEnvelopes()` drives the REAL producer normaliser (`normalizeHook` /
 * `normalizeEvent`) over deterministic inputs and returns the envelopes that
 * would go on the wire. `conformance.test.mjs` writes them to
 * `test/fixtures/activity/generated/*.json`, where the Clojure collector suite
 * and the frontend suite both read them back. All three layers therefore agree
 * on one corpus produced by the code that actually ships.
 *
 * Edit THIS file, never the generated JSON: `npm run fixtures` regenerates.
 *
 * Determinism: every timestamp, id, session id, tool-call id and path is fixed
 * here, and the workspace root is a path that does not exist on any machine, so
 * `normalizeResourcePath` resolves it identically everywhere (missing paths take
 * the `confidence: "observed"` branch without touching the real filesystem).
 *
 * Inputs deliberately carry content-like values (prompts, patch bodies, tool
 * results, secrets). The conformance test asserts none of them reach an
 * envelope; that is the point of generating rather than hand-authoring.
 */
import { normalizeEvent, normalizeHook } from "../src/contract.mjs";

export const WORKSPACE_ROOT = "/Users/example/worktree";
const SESSION_ID = "fixture-session";
const SESSION_NAME = "Wave 0 conformance";
const AGENT_NAME = "Luna implementer";
const CONTEXT = { client: "copilot-cli", version: "1.0.81-fixture" };

/** Content-like markers planted in inputs; none may appear in an envelope. */
export const FORBIDDEN_INPUT_MARKERS = [
  "SECRET-PROMPT-TEXT",
  "SECRET-FILE-TEXT",
  "SECRET-PATCH-BODY",
  "SECRET-TOOL-OUTPUT",
  "SECRET-ERROR-DETAIL",
  "SECRET-ASSISTANT-TEXT",
  // T0-G: `message` and its siblings must be stripped by `UNSAFE_SNIPPET_KEY`
  // before an argument's free-text value ever reaches `snippet`.
  "SENTINEL-WRITE-AGENT-MESSAGE-TEXT",
  "SENTINEL-UNSAFE-KEY-TEXT",
  "SENTINEL-UNSAFE-KEY-BODY",
  "SENTINEL-UNSAFE-KEY-INSTRUCTIONS",
  "SENTINEL-UNSAFE-KEY-REASON",
  "SENTINEL-UNSAFE-KEY-SOURCE",
  "SENTINEL-UNSAFE-KEY-DATA",
  // T1-P: permission resolution, failure correctness, and minimal outcomes.
  "SECRET-PERMISSION-DIFF-TEXT",
  "SECRET-PERMISSION-FILE-TEXT",
  "SECRET-PERMISSION-DENIAL-REASON",
  "SECRET-TOOL-FAILURE-DETAIL",
  "SECRET-SHELL-OUTPUT-TEXT",
  "SENTINEL-HOOK-TOOL-RESULT-TEXT",
  "SENTINEL-HOOK-REJECTED-TEXT",
  "SECRET-TASK-SUMMARY-TEXT",
];

/** Fixed wall clock: entry N is the base plus N seconds. */
function at(offsetSeconds) {
  return new Date(Date.UTC(2026, 7, 28, 10, 0, offsetSeconds)).toISOString();
}

function patchText(files) {
  return [
    "*** Begin Patch",
    ...files.flatMap(file => [`*** Update File: ${file}`, "@@", "-const before = SECRET-PATCH-BODY;", "+const after = 1;"]),
    "*** End Patch",
  ].join("\n");
}

function hook(name, hookName, payload, options = {}) {
  return {
    name,
    envelope: normalizeHook(hookName, payload, CONTEXT, { workspaceRoot: WORKSPACE_ROOT, ...options }),
  };
}

function sdk(name, raw, context = {}) {
  return {
    name,
    envelope: normalizeEvent(raw, {
      ...CONTEXT,
      sessionId: SESSION_ID,
      sourceKind: "sdk",
      workspaceRoot: WORKSPACE_ROOT,
      ...context,
    }, { workspaceRoot: WORKSPACE_ROOT }),
  };
}

/**
 * A JSONL line as `session-watcher.mjs` hands it to `normalizeEvent`: the
 * provider type is already mapped and `data` is still an unparsed JSON string.
 */
function jsonl(name, raw, context = {}) {
  return {
    name,
    envelope: normalizeEvent(raw, {
      client: "unknown",
      sourceKind: "jsonl",
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE_ROOT,
      ...context,
    }, { workspaceRoot: WORKSPACE_ROOT }),
  };
}

/** The P0-3 case: two independently-capped resource lists in one event. */
function resourceCapPayload() {
  const patchFiles = Array.from({ length: 40 }, (_, index) => `src/patched/file-${String(index).padStart(2, "0")}.ts`);
  const argumentFiles = Array.from({ length: 40 }, (_, index) => `src/listed/file-${String(index).padStart(2, "0")}.ts`);
  const searchTargets = Array.from({ length: 40 }, (_, index) => `src/searched/dir-${String(index).padStart(2, "0")}`);
  return {
    sessionId: SESSION_ID,
    timestamp: at(14),
    cwd: WORKSPACE_ROOT,
    toolName: "bash",
    toolCallId: "call-resource-cap",
    toolArgs: {
      files: argumentFiles,
      patch: patchText(patchFiles),
      command: `rg TODO ${searchTargets.join(" ")}`,
    },
  };
}

export function generateEnvelopes() {
  return [
    // --- every hook name in producer/hooks/hooks.json -----------------------
    hook("hook-session-start", "sessionStart", {
      sessionId: SESSION_ID,
      timestamp: at(0),
      cwd: WORKSPACE_ROOT,
      sessionName: SESSION_NAME,
      agentName: AGENT_NAME,
    }),
    hook("hook-session-end", "sessionEnd", {
      sessionId: SESSION_ID,
      timestamp: at(1),
      cwd: WORKSPACE_ROOT,
      sessionName: SESSION_NAME,
    }),
    hook("hook-user-prompt-submitted", "userPromptSubmitted", {
      sessionId: SESSION_ID,
      timestamp: at(2),
      cwd: WORKSPACE_ROOT,
      turnId: "turn-1",
      prompt: "SECRET-PROMPT-TEXT rewrite the collector allowlist",
    }),
    hook("hook-pre-tool-use-read-file", "preToolUse", {
      sessionId: SESSION_ID,
      timestamp: at(3),
      cwd: WORKSPACE_ROOT,
      toolName: "read_file",
      toolCallId: "call-read-1",
      toolArgs: { path: "src/app/main.ts", content: "SECRET-FILE-TEXT" },
    }),
    hook("hook-pre-tool-use-edit-file", "preToolUse", {
      sessionId: SESSION_ID,
      timestamp: at(4),
      cwd: WORKSPACE_ROOT,
      toolName: "edit_file",
      toolCallId: "call-edit-1",
      toolArgs: { path: "src/app/router.ts", content: "SECRET-FILE-TEXT" },
    }),
    hook("hook-pre-tool-use-apply-patch", "preToolUse", {
      sessionId: SESSION_ID,
      timestamp: at(5),
      cwd: WORKSPACE_ROOT,
      toolName: "apply_patch",
      toolCallId: "call-patch-1",
      toolArgs: { patch: patchText(["src/app/main.ts", "src/app/router.ts", "src/app/store.ts"]) },
    }),
    hook("hook-pre-tool-use-shell", "preToolUse", {
      sessionId: SESSION_ID,
      timestamp: at(6),
      cwd: WORKSPACE_ROOT,
      toolName: "bash",
      toolCallId: "call-shell-1",
      toolArgs: { command: "npm run build -- --outDir dist", cwd: "src/app" },
    }),
    hook("hook-pre-tool-use-search", "preToolUse", {
      sessionId: SESSION_ID,
      timestamp: at(7),
      cwd: WORKSPACE_ROOT,
      toolName: "grep",
      toolCallId: "call-search-1",
      toolArgs: { pattern: "TODO", paths: ["src/app", "test"] },
    }),
    hook("hook-pre-mcp-tool-call", "preMcpToolCall", {
      sessionId: SESSION_ID,
      timestamp: at(8),
      cwd: WORKSPACE_ROOT,
      toolName: "docs_search",
      toolCallId: "call-mcp-1",
      toolArgs: { query: "activity roadmap" },
    }),
    // Completes `hook-pre-tool-use-read-file`: same toolCallId, later stamp.
    hook("hook-post-tool-use", "postToolUse", {
      sessionId: SESSION_ID,
      timestamp: at(9),
      cwd: WORKSPACE_ROOT,
      toolName: "read_file",
      toolCallId: "call-read-1",
      toolArgs: { path: "src/app/main.ts" },
      result: { content: "SECRET-TOOL-OUTPUT" },
    }),
    hook("hook-post-tool-use-failure", "postToolUseFailure", {
      sessionId: SESSION_ID,
      timestamp: at(10),
      cwd: WORKSPACE_ROOT,
      toolName: "edit_file",
      toolCallId: "call-edit-1",
      toolArgs: { path: "src/app/router.ts" },
      error: {
        name: "PermissionDeniedError",
        code: "EACCES",
        message: "SECRET-ERROR-DETAIL cannot write src/app/router.ts",
        errorContext: "tool_execution",
      },
    }),
    hook("hook-error-occurred", "errorOccurred", {
      sessionId: SESSION_ID,
      timestamp: at(11),
      cwd: WORKSPACE_ROOT,
      error: { name: "TimeoutError", code: "ETIMEDOUT", message: "SECRET-ERROR-DETAIL model call timed out" },
    }),
    hook("hook-agent-stop", "agentStop", {
      sessionId: SESSION_ID,
      timestamp: at(12),
      cwd: WORKSPACE_ROOT,
      agentId: "agent-primary",
      agentName: AGENT_NAME,
    }),
    hook("hook-subagent-stop", "subagentStop", {
      sessionId: SESSION_ID,
      timestamp: at(13),
      cwd: WORKSPACE_ROOT,
      agentId: "agent-child",
      parentId: "agent-primary",
      agentName: "Luna reviewer",
    }),
    // The P0-3 regression: 40 patch headers + 40 argument paths + 40 shell args.
    hook("hook-resource-cap", "preToolUse", resourceCapPayload()),

    // --- SDK session events -------------------------------------------------
    sdk("sdk-agent-started-named", {
      id: "sdk-agent-started",
      type: "agent.started",
      timestamp: at(15),
      agent: { name: AGENT_NAME },
    }, { sessionName: SESSION_NAME }),
    sdk("sdk-tool-execution-start", {
      id: "sdk-tool-start",
      type: "tool.execution_start",
      timestamp: at(16),
      data: { toolCallId: "sdk-call-1", toolName: "read_file", toolArgs: { path: "src/app/store.ts" } },
    }),
    // Completes `sdk-tool-execution-start`: same toolCallId, later stamp.
    sdk("sdk-tool-execution-complete", {
      id: "sdk-tool-complete",
      type: "tool.execution_complete",
      timestamp: at(17),
      data: { toolCallId: "sdk-call-1", toolName: "read_file", result: { content: "SECRET-TOOL-OUTPUT" } },
    }),
    sdk("sdk-tool-read-agent", {
      id: "sdk-read-agent",
      type: "tool.execution_start",
      timestamp: at(18),
      data: {
        toolCallId: "sdk-call-2",
        toolName: "read_agent",
        arguments: {
          agent_id: "target-agent",
          targetAgentNodeId: "agent:%5Btarget%5D",
          targetSessionId: "target-session",
          targetWorkspaceId: "local-target-1234",
          prompt: "SECRET-PROMPT-TEXT",
        },
      },
    }),
    // T0-G regression: a `write_agent` call's `message` argument must never
    // reach `snippet`, even though it is the tool's primary free-text payload.
    sdk("sdk-tool-write-agent", {
      id: "sdk-write-agent",
      type: "tool.execution_start",
      timestamp: at(19),
      data: {
        toolCallId: "sdk-call-3",
        toolName: "write_agent",
        arguments: {
          target: { id: "target-agent", sessionId: "target-session" },
          message: "SENTINEL-WRITE-AGENT-MESSAGE-TEXT",
        },
      },
    }),
    // T0-G: several more newly-blocked keys on the same tool, each with its
    // own sentinel, so the fix is proven beyond just `message`.
    sdk("sdk-tool-write-agent-unsafe-keys", {
      id: "sdk-write-agent-unsafe-keys",
      type: "tool.execution_start",
      timestamp: at(23),
      data: {
        toolCallId: "sdk-call-5",
        toolName: "write_agent",
        arguments: {
          target: { id: "target-agent", sessionId: "target-session" },
          text: "SENTINEL-UNSAFE-KEY-TEXT",
          body: "SENTINEL-UNSAFE-KEY-BODY",
          instructions: "SENTINEL-UNSAFE-KEY-INSTRUCTIONS",
          reason: "SENTINEL-UNSAFE-KEY-REASON",
          source: "SENTINEL-UNSAFE-KEY-SOURCE",
          data: "SENTINEL-UNSAFE-KEY-DATA",
        },
      },
    }),
    // A shell snippet intentionally carries the redacted command line, so this
    // command holds no marker: the argument text here is meant to survive.
    sdk("sdk-permission-requested", {
      id: "sdk-permission",
      type: "permission.requested",
      timestamp: at(20),
      data: { toolCallId: "sdk-call-4", toolName: "bash", command: "rm -rf dist" },
    }),
    sdk("sdk-assistant-message", {
      id: "sdk-assistant",
      type: "assistant.message",
      timestamp: at(21),
      data: { messageId: "message-1", content: "SECRET-ASSISTANT-TEXT" },
    }, { sessionName: SESSION_NAME }),

    // --- JSONL session-state line ------------------------------------------
    jsonl("jsonl-tool-execution-start", {
      id: "jsonl-tool",
      type: "tool.execution_start",
      timestamp: at(22),
      sessionId: SESSION_ID,
      cwd: WORKSPACE_ROOT,
      data: JSON.stringify({ toolName: "read_file", arguments: { path: "src/app/flat.ts" } }),
    }, { sessionName: SESSION_NAME, agentName: AGENT_NAME }),

    // --- T1-P: permission resolution, failure correctness, minimal outcomes -
    // `permission.requested` carrying only `requestId` (no `toolCallId` yet):
    // exercises the requestId fallback and `permissionKind` derivation. The
    // `diff`/`newFileContents` siblings on `permissionRequest` are real (real
    // occurrences per docs/copilot-payloads.md §6) and must never leak.
    sdk("sdk-permission-requested-shell", {
      id: "sdk-permission-shell",
      type: "permission.requested",
      timestamp: at(24),
      data: {
        requestId: "req-shell-1",
        permissionRequest: {
          kind: "shell",
          diff: "SECRET-PERMISSION-DIFF-TEXT",
          newFileContents: "SECRET-PERMISSION-FILE-TEXT",
        },
      },
    }),
    // Completes `sdk-permission-requested-shell`: same requestId, both IDs present.
    sdk("sdk-permission-completed-approved", {
      id: "sdk-permission-completed-approved",
      type: "permission.completed",
      timestamp: at(25),
      data: {
        requestId: "req-shell-1",
        toolCallId: "sdk-call-4",
        result: { kind: "approved" },
      },
    }),
    // No toolCallId on this one: exercises the same requestId fallback on the
    // completed side. `result.reason` is real (copilot-payloads.md §1b) and
    // must never leak.
    sdk("sdk-permission-completed-denied", {
      id: "sdk-permission-completed-denied",
      type: "permission.completed",
      timestamp: at(26),
      data: {
        requestId: "req-shell-2",
        result: { kind: "denied-interactively-by-user", reason: "SECRET-PERMISSION-DENIAL-REASON" },
      },
    }),
    // `data.success === false`: today reported as `completed`, must become `failed`.
    sdk("sdk-tool-execution-complete-failed", {
      id: "sdk-tool-failed",
      type: "tool.execution_complete",
      timestamp: at(27),
      data: {
        toolCallId: "sdk-call-6",
        toolName: "bash",
        success: false,
        error: { code: "E_TOOL_FAILED", message: "SECRET-TOOL-FAILURE-DETAIL" },
      },
    }),
    // A `shell_exit` content block plus `result.content` text: exitCode and a
    // byte count are derived; the content string itself must never leak.
    sdk("sdk-tool-execution-complete-shell-exit", {
      id: "sdk-tool-shell-exit",
      type: "tool.execution_complete",
      timestamp: at(28),
      data: {
        toolCallId: "sdk-call-7",
        toolName: "bash",
        success: true,
        result: {
          content: "SECRET-SHELL-OUTPUT-TEXT",
          contents: [{ type: "shell_exit", exitCode: 1, shellId: "shell-1" }],
        },
      },
    }),
    // Hook shape: `postToolUse` carries `toolResult` directly (not `result`).
    // `resultType: "success"` keeps status `completed` but still populates
    // `metadata.status`/`metadata.bytes` from the hook's own fields.
    hook("hook-post-tool-use-result", "postToolUse", {
      sessionId: SESSION_ID,
      timestamp: at(29),
      cwd: WORKSPACE_ROOT,
      toolName: "bash",
      toolCallId: "call-shell-result",
      toolArgs: { command: "npm test" },
      toolResult: { resultType: "success", textResultForLlm: "SENTINEL-HOOK-TOOL-RESULT-TEXT" },
    }),
    // Same hook shape with a non-success resultType: status must flip to
    // `failed` even though this is not the separate `postToolUseFailure` hook.
    hook("hook-post-tool-use-rejected", "postToolUse", {
      sessionId: SESSION_ID,
      timestamp: at(30),
      cwd: WORKSPACE_ROOT,
      toolName: "bash",
      toolCallId: "call-shell-rejected",
      toolArgs: { command: "rm -rf /" },
      toolResult: { resultType: "rejected", textResultForLlm: "SENTINEL-HOOK-REJECTED-TEXT" },
    }),
    // `subagent.completed`'s genuine bounded-scalar outcome fields.
    sdk("sdk-subagent-completed", {
      id: "sdk-subagent-completed",
      type: "subagent.completed",
      timestamp: at(31),
      data: {
        toolCallId: "sdk-call-8",
        agentName: "Luna reviewer",
        agentDisplayName: "Luna reviewer",
        durationMs: 4200,
        totalTokens: 15000,
        totalToolCalls: 6,
      },
    }),
    // Session-level outcome signal; `data.summary` is real and must never leak.
    sdk("sdk-session-task-complete", {
      id: "sdk-task-complete",
      type: "session.task_complete",
      timestamp: at(32),
      data: { success: true, summary: "SECRET-TASK-SUMMARY-TEXT" },
    }),
  ];
}
