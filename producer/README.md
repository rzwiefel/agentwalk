# Local Copilot activity producer

This user-scoped, privacy-first producer emits bounded metadata about local
GitHub Copilot activity to Agentwalk's loopback collector. It never changes
prompts, tool arguments, permissions, agent decisions, or repositories.

## Verified contracts

The implementation is verified against Copilot CLI `1.0.81-12`:

- `copilot-sdk/extension.d.ts`: `joinSession({ hooks, onPermissionRequest })`.
- `copilot-sdk/types.d.ts`: `SessionHooks`, `Date` timestamps, and
  `workingDirectory`.
- `copilot-sdk/session.d.ts`: typed `session.on(eventType, handler)` subscriptions.
- `copilot-sdk/docs/extensions.md`: immediate child directories containing
  `extension.mjs` are discovered.
- The installed version-1 hook schema: command hooks support `bash` and
  `powershell` and receive JSON on stdin.

The extension entrypoint calls `joinSession({ hooks, onPermissionRequest })` at
module load. The permission handler approves only this extension's
session-scoped capability request; it does not approve environment-variable
access or other extension permissions. It
subscribes only to the SDK's typed `SessionEvent` names; the wildcard overload
is intentionally not used because CLI `1.0.81-12` also emits internal
`model.*` timeline entries that the SDK cannot decode. Filesystem hook
processes append locally and start a short-lived, bounded spool tailer for
near-live delivery when the CLI extension host does not remain attached.

## User installation

Extensions and filesystem hooks are separate CLI surfaces. Install the
extension under `$COPILOT_HOME/extensions/` (default `~/.copilot/extensions/`).
The CLI `1.0.81-12` supports user-level hooks as the inline `hooks` object in
the global `config.json` (the CLI may migrate this into its effective
`settings.json`); retain the version-1 hook file as a portable source or
plugin artifact, then merge its `hooks` object into that config without
overwriting unrelated settings:

```sh
HOME_EXT="${COPILOT_HOME:-$HOME/.copilot}"
EXTENSION_DIR="$HOME_EXT/extensions/codewalk-local-activity"
mkdir -p "$EXTENSION_DIR"
cp /path/to/agentwalk/producer/extension.mjs "$EXTENSION_DIR/"
cp -R /path/to/agentwalk/producer/src "$EXTENSION_DIR/"
cp -R /path/to/agentwalk/producer/bin "$EXTENSION_DIR/"
mkdir -p "$HOME_EXT/hooks"
cp /path/to/agentwalk/producer/hooks/hooks.json \
  "$HOME_EXT/hooks/codewalk-local-activity.json"

export CODEWALK_INGEST_URL=http://127.0.0.1:4180/api/activity/events
export CODEWALK_ACTIVITY_TOKEN_FILE="$HOME/.codewalk/activity/token"
```

The extension path must remain
`$COPILOT_HOME/extensions/codewalk-local-activity/` (or
`$HOME/.copilot/extensions/codewalk-local-activity/`), as the installed hook
commands resolve the producer from that directory. The producer defaults to
the loopback endpoint; `CODEWALK_INGEST_URL` overrides it. It reads the shared
token file at delivery time; `CODEWALK_ACTIVITY_TOKEN` remains available as an
explicit token override. The token is sent only in the
`X-Codewalk-Activity-Token` header.

`COPILOT_HOME` is the supported user-state override. `plugin.json` declares
`hooks/hooks.json` for plugin packaging. The extension directory is discovered
by the extension runtime. Hook entries provide Unix `bash` and Windows
`powershell` commands. The producer requires Node.js `>=18` and supports
macOS, Linux, and Windows. A standalone file under `~/.copilot/hooks/` is not
sufficient for this CLI version unless its contents are also registered in
the effective global hook configuration.

Only loopback ingest URLs (`localhost`, `127.0.0.1`, or `::1`) are accepted.
`npm run dev:live` creates the shared token file with mode 0600. The producer
reads it at delivery time. `CODEWALK_ACTIVITY_TOKEN_FILE` overrides the
default token path, and the token is never normalized, logged, or spooled.

When the endpoint is absent or unavailable, events stay in a bounded spool at
`$CODEWALK_SPOOL_DIR` or `~/.codewalk/activity/events.jsonl` (directory mode
`0700`, file mode `0600`). A collector lock prevents duplicate posting;
acknowledgements match the complete queued event identity so overlapping
provider IDs remain independent.
Hook completion does not wait for network delivery or fetch
timeouts. The detached tailer uses the same collector lock and exits after an
idle period or bounded maximum runtime; transient delivery failures remain in
the spool for a later tailer/extension retry, while permanent collector
rejections are acknowledged and dropped one record at a time.

`npm run dev:live` starts a long-lived, read-only compatibility watcher for
`${COPILOT_HOME:-$HOME/.copilot}/session-state/*/events.jsonl`. It starts at
EOF for files that already exist, scanning only their skipped prefix to recover
the latest workspace context. Paths first seen after that startup snapshot
start at byte zero; per-file cursors and attribution state remain separate from
the active bounded selection, so files can leave and re-enter without replaying
history. It discovers new session files, tolerates partial JSONL lines and
rotation/truncation, and advances a line only after `onEvent` accepts it;
failed enqueues are retried in order. The watcher is bounded by active file
count, retained file metadata, line size, concurrency, and dedupe memory, and
exits with Agentwalk. These records use `source.kind: "jsonl"` and
`source.client: "unknown"` because local session files do not prove whether a
record came from the CLI or standalone app. The source is therefore observed
compatibility coverage, not verified standalone-app extension or hook support.
No repository path is needed; the watcher observes all workspaces. Passing
`npm run dev:live -- /path/to/repository` is optional and only preselects the
default repository for Architecture analysis.

For reproducible checks, run the producer's synthetic fixture suite from the
repository root with `npm --prefix producer test`; do not test by capturing a
real session.

## Contract (schema version 1)

Every envelope contains `schemaVersion`, `id`, `sessionId`, `timestamp`, and
`type`. Optional fields include IDs, `sessionName`, structured `source`, `status`, `tool`,
`workspace`, `resources`, and allowlisted privacy-filtered metadata. Source clients are
`copilot-cli`, `copilot-app`, or `unknown`; source kinds are `hook`, `sdk`,
`jsonl`, `sqlite`, or `otel`.

Prompts, assistant text, arguments, results, code, credentials, and environment
values are excluded by default. Shell/tool events may carry a bounded
`snippet` of the command shape; raw output is never retained. Local workspace
roots and paths are intentionally preserved so the local viewer can attribute
activity across repositories without displaying `[PATH]` placeholders.
For JSONL sessions, `sessionName` is read from the local
`vscode.metadata.json` `customTitle` sidecar when available; credential-like
values are still filtered.
Credential-like values remain filtered. Error metadata is limited to an
allowlisted classification and code.
Provider IDs are retained without raw content.

Resource paths are workspace-relative when contained. Outside-root paths retain
their normalized local path so the local viewer can identify the active
worktree. Existing contained targets are `exact`; missing or unresolved targets
are `observed`.
Actions are `read`, `write`, `search`, `execute`, or `reference`.
Nested provider arguments are inspected for shell commands and patch text:
search commands contribute directory targets, while `apply_patch` and unified
diff headers contribute write targets without retaining the command or patch
contents.

Unknown provider events become sanitized `error` envelopes with
`metadata.unknownEvent: true`.

## Standalone Copilot app

Standalone Copilot app support is **unverified**. The capability report does
not claim app support until this same extension runtime is observed receiving
app session events for local repository/folder/worktree sessions. There is no
UI scraping, network interception, or assumption that app and CLI IDs match.
The local JSONL watcher is the compatibility fallback described above; it does
not attribute a session to the standalone app.

## Checks

Run from the repository root:

```sh
npm --prefix producer test
```
