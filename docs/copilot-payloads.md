# Copilot activity event sources

This is a protocol guide for Codewalk's local activity pipeline. It describes
fields the producer can derive from SDK events, hooks, and session JSONL; it
contains no observations, paths, identifiers, or counts from actual sessions.
Event availability can vary by Copilot version. Verify behavior against the
current adapter and synthetic fixtures rather than assuming a particular local
installation has every event.

## Sources and boundaries

| Source | Code | Role |
| --- | --- | --- |
| Typed session listener | `producer/src/sdk-adapter.mjs` | Subscribes to known `SessionEvent` names for an attached session. |
| Extension hooks | `producer/src/sdk-adapter.mjs` and `producer/src/contract.mjs` | Normalizes hook inputs at the producer boundary. |
| Local session JSONL | `producer/src/session-watcher.mjs` | Bounded fallback/backfill; its schema is not a public contract. |

The listener registers session lifecycle events, user/assistant messages,
`tool.execution_start`, `tool.execution_complete`,
`permission.requested`, `permission.completed`, and subagent events. The
watcher's `ACTIVITY_TYPES` map additionally translates supported
`external_tool.*` entries into tool activity. Do not add event names based
solely on guesses about another SDK version; update the producer, collector,
frontend contract, and fixtures together.

The extension hooks include `preToolUse`, `postToolUse`,
`postToolUseFailure`, `preMcpToolCall`, session lifecycle, and agent-stop
hooks. `postToolUse` may provide `toolResult.resultType` and
`toolResult.textResultForLlm`; the latter is raw output, **not** safe metadata.
A failure hook can provide a free-text error, which must be classified or
redacted rather than forwarded verbatim.

## Deriving bounded outcomes

The following fields are candidates, not guaranteed fields on every event:

| Input | Safe derivation after validation |
| --- | --- |
| `tool.execution_complete.data.success` | A bounded success/failure status. |
| `postToolUse.toolResult.resultType` | A bounded status such as success, failure, rejected, denied, or timeout. |
| Shell result `exitCode` | A bounded integer when supplied by the event. |
| `data.toolTelemetry` numeric metrics | Explicitly allowlisted counts, durations, or byte totals with caps. |
| `data.error.code` | A short validated error code; never forward `error.message`. |
| Start and completion timestamps sharing a tool-call ID | A bounded derived duration. |
| `subagent.completed` numeric totals | Bounded duration/count fields when present. |

`permission.completed` is distinct from `permission.requested`; a completed
permission should release the matching waiting agent using its tool-call
identity. Source events and hooks can overlap, so the collector/reducer must
deduplicate rather than treating every source as a separate operation.

Raw results can contain file contents, shell output, diffs, prompts, model
context, URLs with credentials, and third-party tool payloads. In particular,
`data.result.content`, `data.result.detailedContent`, nested
`structuredContent`, hook `textResultForLlm`, and permission-request
diff/new-file fields are **not** envelope metadata. `toolArgs`, error
messages, and arbitrary telemetry subobjects are likewise not safe to pass
through. Keep the event schema closed and derive only named bounded scalars.

## Cross-layer privacy contract

1. Normalize and redact in `producer/src/contract.mjs` and
   `producer/src/redact.mjs`; strip URL userinfo, query, and fragment before
   emitting an external resource reference.
2. Reject unknown or unsafe fields at the collector
   (`src/codewalk/activity.clj`), even when the producer is expected to be
   trusted. Accepted activity recording remains opt-in.
3. Apply the frontend allowlist (`src/activity/contract.ts`) before rendering
   event metadata. Do not reconstruct raw prompts or tool results from
   fallback files.
4. Keep synthetic cross-layer fixtures aligned across the producer, collector,
   and frontend. Fixtures may use example workspaces and deliberately
   credential-shaped test values; they must not be copied from user sessions.

Run `npm --prefix producer test`, `npm test`, and `clojure -M:test` from the
Codewalk checkout after changing event shapes. `npm run check` runs the
integrated suite. When intentionally changing generated fixtures, run
`npm run fixtures` and inspect the staged JSON for private data before
committing it.
