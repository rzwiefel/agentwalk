# Generated activity envelopes

**Do not edit these files.** They are produced by the producer's normaliser
(`normalizeHook` / `normalizeEvent` in `producer/src/contract.mjs`) driven over a
deterministic corpus. Edit the generator, never the JSON:

- Generator: `producer/test/fixtures.mjs` (`generateEnvelopes()`)
- Regenerate: `npm run fixtures` (equivalently `UPDATE_FIXTURES=1 npm --prefix producer test`)

Each file is one envelope, pretty-printed with 2-space indent and keys sorted
alphabetically so a diff shows a real contract change rather than a reordering.

## Three suites consume this directory

| Suite | Test | Asserts |
|---|---|---|
| Producer | `producer/test/conformance.test.mjs` | Each envelope byte-equals its committed file; no content-bearing key (`prompt`, `message`, `command`, `arguments`, `result`, `output`, `code`, `headers`, `env`, and `content` only as a local reference) appears anywhere in the tree; no raw input text leaks |
| Collector | `test/codewalk/activity_test.clj` → `generated-envelopes-conform-to-collector` | Every file is accepted by `validate-event` |
| Frontend | `src/activity/conformance.test.ts` | Every file parses via `parseActivityEvent`, and `sessionName`, `agentName`, `type`, `status`, `tool`, `toolCallId`, `resources.length` survive |

A producer change that drifts from the collector's allowlist or from the
frontend parser turns one of the three red. That is the whole point: the
hand-authored fixtures in the parent directory were a one-way snapshot and
missed a live regression (roadmap P0-1).

Run all four suites with `npm run check`.

## Corpus coverage

All nine hook names in `producer/hooks/hooks.json`; SDK and JSONL source kinds;
tool kinds `read_file` / `edit_file` / `apply_patch` / shell / grep-style search
/ `read_agent` / `write_agent`; sessions carrying `sessionName` + `agentName`;
a tool failure with an error object; `errorOccurred`; `tool.execution_start` and
`tool.execution_complete` pairs sharing a `toolCallId` (`call-read-1`,
`sdk-call-1`); and the 40-patch-header + 40-argument-path + 40-shell-target case
that must re-cap to 32 resources.

T1-P (producer signal correctness + minimal outcomes) added: `permission.requested`
with only a `requestId` (no `toolCallId` yet) and a `permissionRequest.kind`,
paired with `permission.completed` carrying both IDs and `result.kind: "approved"`,
plus a second `permission.completed` with only a `requestId` and
`result.kind: "denied-interactively-by-user"` — each exercises the
`toolCallId ?? requestId` fallback and the `permissionKind`/`permissionResult`
derivation; `tool.execution_complete` with `data.success: false` and
`error.code` (status must become `failed`, not `completed`); a
`tool.execution_complete` with a `shell_exit` content block (`exitCode: 1`) and
a `result.content` string, deriving both `exitCode` and a `bytes` count from
text that never itself appears in the envelope; two `postToolUse` hook
envelopes carrying `toolResult` — one `resultType: "success"` (status stays
`completed`, `metadata.status`/`metadata.bytes` still populate) and one
`resultType: "rejected"` (status becomes `failed` even though this is not the
separate `postToolUseFailure` hook); `subagent.completed` with
`durationMs`/`totalToolCalls`; and `session.task_complete`.

The workspace root is `/Users/example/worktree` — a path that exists nowhere, so
`normalizeResourcePath` resolves it identically on every machine without
touching the real filesystem.
