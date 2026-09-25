# Live agent activity mode - implementation plan

> Status: MVP implemented; Copilot CLI verified end to end.
> Last updated: 2026-08-27.

## Goal

Add a live visualization of local Copilot activity while it works in any
repository. File reads and edits should activate the corresponding graph
nodes and hierarchy volumes using the existing pulse/shockwave language.
Commands, tool calls, agent/subagent state, and concise privacy-filtered details
should appear alongside the graph.

## Repository decision

This ships **inside Agentwalk with Live Activity as the primary view**.
Architecture remains supported as a secondary mode, not a replaced renderer or
removed feature.

Agentwalk already provides the expensive reusable parts:

- repository-neutral parsing and deterministic graph identities;
- stable layout positions and hierarchy volumes;
- live local HTTP services;
- demand-driven Three.js rendering;
- bounded history activity, fades, pulses, and shockwaves.

Activity remains a transient overlay that references graph nodes, files, source
spans, and hierarchy groups. It must not add agent events to `CodeGraph`,
`GraphHistory`, parser IR, node kinds, or relationship statistics. Collection
and normalization should remain separable from the renderer so a future agent
source can be added without changing visualization semantics.

The producer and local collector should be independently packaged inside this
repository while the visualization remains an Agentwalk mode.

## Locked scope

### MVP target

- Local GitHub Copilot CLI sessions.
- Local sessions in the standalone GitHub Copilot app, pending runtime
  compatibility verification.
- Arbitrary local repositories, remotes, branches, languages, worktrees, and
  folders supported by Agentwalk.
- File read/edit activity only when explicitly reported by the producer.
- Tool and shell-command lifecycle with short, privacy-preserving summaries.
- Agent, subagent, session, waiting, completion, and failure state.
- A user-scoped installation; repository modifications must not be required.

### Explicitly out of scope

- VS Code, GitHub.com, GitHub Mobile, cloud agents, and cloud sandboxes.
- Repository-committed instrumentation as an MVP requirement.
- Raw prompts, full tool arguments/results, raw terminal output, or model
  context by default.
- UI scraping, network interception, monkey-patching, or undocumented remote
  telemetry.
- Integration with other local knowledge systems.
- Implementing or researching OMP, Claude Code, Codex, OpenCode, or other
  agents now.

A narrow local event-producer boundary should be retained so another local
agent can be added if and when requested. Do not over-design the MVP contract
for hypothetical clients.

## Architecture decision

```text
Copilot CLI / Copilot app local session
                |
 user-scoped extension + hooks/events
                |
     redaction + normalization
                |
   local collector / bounded spool
                |
      Agentwalk activity stream
                |
 activity reducer + graph resolver
                |
 Three.js activity mode + event panel
```

The shared producer is a user-scoped Copilot extension. Copilot discovers it
from the user's extension directory, runs it as a child process, and lets it
`joinSession()` to observe the current foreground session. The producer may
register hooks and session-event listeners. It should emit quickly to a local
socket or append-only spool and never block or alter agent decisions.

The standalone app is built on Copilot CLI, but its use of the same extension
runtime must be tested before app support is claimed. If the app uses a separate
Copilot home or hook policy, local session-data discovery remains the fallback.

OpenTelemetry is not the primary MVP activity source. Metadata-only OTel can
supplement the feed with tool/model duration, token usage, and health signals,
but it does not reliably provide exact file paths and command details. Enabling
OTel message-content capture would export prompts, responses, tool arguments,
results, code, and paths, so it must remain off by default.

For ordinary already-running or missed-hook sessions, use a read-only tail of
Copilot's local append-only event log as a compatibility source. A public
SDK/ACP source is preferable when Agentwalk launches and owns the Copilot
session. Internal file/database readers must be isolated behind versioned
adapters and treated as compatibility surfaces, not as the canonical activity
contract.

SSE is the current transport recommendation from the local collector to the
browser because activity is primarily one-way, reconnectable, and compatible
with Agentwalk's current local server.

## Confirmed local sources

Use this precedence:

1. User-level extension session events and hooks for low-latency activity.
2. SDK event-log cursors when the producer owns or legitimately joins the
   foreground session.
3. `<COPILOT_HOME>/session-state/<session-id>/events.jsonl` for historical,
   already-running, and missed-hook activity.
4. `<COPILOT_HOME>/session-store.db` for durable turn, usage, file, reference,
   and checkpoint backfill.
5. Optional local OTel metrics for timing, usage, and health only.

Persisted JSONL events provide `type`, `id`, `timestamp`, `parentId`, `data`,
and optional `agentId`/`ephemeral` fields. The global SQLite store includes
`sessions`, `turns`, `assistant_usage_events`, `session_files`,
`session_refs`, and `checkpoints`. It uses WAL with `busy_timeout=0`; readers
must use short transactions, honor WAL sidecars, reopen between polls, and
retry immediate lock failures.

The initial hook coverage is:

- `onUserPromptSubmitted`
- `onPreToolUse`
- `onPreMcpToolCall`
- `onPostToolUse`
- `onPostToolUseFailure`
- `onSessionStart`
- `onSessionEnd`
- `onErrorOccurred`
- `onAgentStop`

Hooks are not the sole source of truth: denied, rejected, timeout, permission,
usage, compaction, subagent, and streaming events may require session events or
local backfill.

## Event contract principles

- Versioned, append-only, transport-neutral envelopes.
- Source and session IDs are namespaced; CLI and app IDs are not assumed to be
  interchangeable.
- Repository and workspace identity are resolved per event.
- Paths are workspace-relative where possible and portable across macOS,
  Linux, Windows, worktrees, symlinks, and case-sensitivity differences.
- Events carry an explicit coverage classification such as `exact`,
  `observed`, or `unavailable`; missing telemetry is never rendered as
  inactivity.
- Producer payloads are untrusted and privacy-filtered before storage or display;
  local workspace roots and paths remain visible for accurate attribution, while
  credentials, raw content, and raw output remain excluded.
- File-to-graph resolution prefers explicit node IDs, then file plus source
  span, then file/group mapping, with unmapped events retained in the event
  panel.
- UI state, replay, client queues, command snippets, and pulse effects are
  bounded.

Only source/session/event identity, event type, ordering, and timestamp are
required. Preserve provider event types and Copilot session, turn, tool-call,
parent, cursor, and source identifiers for backfill and future display/control.
Graph node IDs remain optional resolver output.

## Future conversation and interaction surface

The event model should preserve enough identity and ordering to support a
future full session display containing user questions, assistant messages,
tool calls, and permission requests. The MVP should ingest and render metadata
only; storing or displaying raw conversation/tool content must require explicit
opt-in, bounded retention, clear redaction controls, and local-only storage.

Viewing a conversation and controlling an agent are separate capabilities.
Bidirectional interaction is most credible when Agentwalk launches and owns a
Copilot process through a supported SDK or Agent Client Protocol connection.
There is no assumed stable API for attaching controls to an arbitrary
already-running CLI or app session. Preserve a replaceable session-driver
boundary and leave room for a command channel, but do not implement chat input,
approvals, cancellation, or agent steering in the visualization MVP.

## Likely implementation surfaces

- `src/App.tsx`: mode selection and high-level lifecycle.
- `src/graph.ts`: reusable file/span/node/group indexes.
- `src/components/GraphCanvas.tsx`: extract low-level activity rendering
  primitives rather than adding more history-specific conditionals.
- `src/components/ControlPanel.tsx`: mode and activity controls.
- `src/api.ts` or a new activity API module: stream lifecycle.
- New frontend activity reducer/store and activity canvas modules.
- New Clojure activity route/stream module, keeping `server.clj` focused on
  registration and lifecycle.

Git history controls and `src/history.ts` remain architecture/history-specific.
Activity may reuse their bounded fade concepts, but live events must not be
represented as fake commits.

## Compatibility checks before claiming app support

Test user-level plugin discovery and hook delivery for app-local repository,
folder, and worktree sessions; Interactive, Plan, and Autopilot modes; parallel
and resumed sessions; event ordering and duplication; session/cwd/branch/worktree
identity; backgrounding and closing the app; and hook timeout behavior. App
support must be capability-detected and reported unavailable when required
events do not arrive.

## Implementation ownership

Keep producer, collector, frontend, and documentation changes independently
reviewable, with explicit ownership of shared files and cross-layer tests.

## Implemented and verified

- A user-scoped extension and filesystem-hook producer normalizes privacy-filtered
  schema-v1 events into a bounded local spool.
- Hook processes return without waiting for the network. A bounded detached
  tailer provides near-live delivery when the extension process is short-lived.
- The loopback collector validates events, deduplicates them, bounds replay and
  client queues, and streams activity over authenticated SSE.
- Vite injects the activity token server-side, so browser code never receives
  the credential.
- Activity mode maps explicit file/span resources to graph nodes or hierarchy
  groups, renders bounded pulses, and keeps unknown/unmapped events in the side
  panel.
- Git history playback and activity overlays are isolated modes.
- Synthetic fixtures exercise the extension, producer, collector, and viewer
  contracts. Perform an opt-in local smoke check before claiming support for
  an untested client version; do not commit results from an actual session.
- A bounded, read-only JSONL compatibility watcher now tails
  `${COPILOT_HOME:-$HOME/.copilot}/session-state/*/events.jsonl` when
  `dev:live` runs. It starts at EOF, discovers new files, handles partial
  lines and rotation/truncation, tracks workspace attribution across
  workspaces, and emits only normalized schema-v1 metadata/resources with
  `source.kind: "jsonl"` and `source.client: "unknown"`.

## Known JSONL watcher limitations

- Existing session files start at EOF without scanning prior context. If later
  records omit workspace context, as tool records commonly do, those records
  may remain unattributed and be skipped until another context-bearing record
  appears.
- A session file created after watcher startup can replay previously processed
  records if it falls outside the bounded `maxFiles` set and is later
  rediscovered. The bounded event-ID cache can suppress only recent duplicates.
- New-file detection currently depends on filesystem birth time. Filesystems
  that report an unavailable or zero birth time can cause a genuinely new file
  to start at EOF and lose its initial records.
- The watcher advances its file offset and records an event ID before spool
  enqueue succeeds. A transient enqueue failure can therefore lose that event
  rather than retrying it on the next poll.

## High-priority expansion: collection mode

The next implementation must support one Live Activity session containing
multiple codebases and/or multiple language analyses. Examples include Python
and TypeScript graphs for one repository, or several repositories/worktrees
that a Copilot session visits. This is a collection feature, not a change to
the parser's language-neutral graph-v2 contract.

### Decisions and invariants

1. **Keep source graphs isolated at the data boundary.** Introduce a
   `GraphSource`/`LoadedCollection` model around the existing `CodeGraph`:
   `sourceId`, canonical root, repository display name, language, optional
   project/config, branch/commit, load status, and the graph. Do not overload
   `CodeGraph.repo` with an array or make parser nodes globally unique.
2. **Derive a namespaced render graph.** When a collection is rendered, node and
   edge IDs are prefixed by stable `sourceId` values and each node/edge retains
   provenance (`sourceId`, language, repository). This prevents collisions
   between repositories and between Python/TypeScript graphs for the same path.
   Cross-source edges are absent unless a future explicit relationship source
   supplies them; never infer them from matching labels or files.
3. **Use deterministic source identity.** `sourceId` is derived from the
   canonical workspace root plus language, project file, config path, and
   revision policy—not from a display label. A root's opaque activity
   `workspaceId` remains distinct from a graph source ID, because one workspace
   can contain several language analyses.
4. **Load sources independently.** Add a batch client/API surface that runs
   one parser request per source with bounded concurrency, independent
   cancellation/error state, and cache keys including root, language, project,
   config, and commit. A failed source must not discard successful sources.
   Existing single-source loading remains a compatibility path.
5. **Make activity resolution collection-aware.** Replace the single
   `ActivityGraphIndexes` assumption with an aggregate index containing
   per-source indexes and `workspaceId -> sourceIds`. A file/span event may
   resolve to multiple language graphs when the path is genuinely shared;
   explicit node/source metadata wins, and ambiguous matches remain visible as
   multi-target activity rather than being guessed away. Extend the pulse
   model to carry bounded target lists while retaining the current
   single-target compatibility field during migration.
6. **Preserve telemetry filtering.** The SSE stream must accept a bounded set
   of opaque workspace IDs (maximum 64, validated individually), not a raw
   path or unrestricted wildcard. Events without trustworthy workspace
   attribution remain unmapped. Producer snippets, 30-second prominence,
   blue reads, red writes, graph-node pulses, and bash/per-tool groups remain
   unchanged.
7. **Use source-aware layout packing.** Compute each source's existing
   hierarchy independently, then place source roots in a deterministic grid or
   radial packing with a visible source label/group. Namespace group IDs are
   source-prefixed. Shared top-level activity groups (`group:activity:bash`
   and `group:activity:tool:<safe-name>`) remain global and pulse for every
   matching source; activity events should display their source/repository.
   Activity-group layout must remain separate from parser/layout recomputation
   so incoming events do not relayout the whole collection.
8. **Keep history explicit.** A combined collection has no single Git timeline.
   History controls should require a selected source (or expose independent
   per-source timelines); do not merge unrelated commits into synthetic
   history. Activity mode continues to disable history playback.

### Required frontend surfaces

- Replace the single repository picker with a bounded source list: path,
  language mode, optional project/config, add/remove, per-source load status,
  and a load-all action. Keep the current single-source flow as the first row
  and preserve repository path validation.
- Add a collection/source selector for the canvas and activity panel:
  `All sources` plus individual sources, with source labels on telemetry rows
  and an explicit unmapped/ambiguous state.
- Show aggregate node/edge/source counts while retaining per-source diagnostics.
- Disable or scope history controls when more than one source is selected.

### Performance and limits

- Bound collection size (initial proposal: 8 sources and a configurable
  aggregate node cap) and reject/soft-disable excess sources with a visible
  diagnostic.
- Run at most 2–3 parser analyses concurrently; cache completed snapshots and
  deduplicate identical source requests.
- Memoize per-source indexes, layouts, metrics, and visibility. Avoid rebuilding
  unchanged sources when another source finishes loading.
- Keep physics off by default for collections; if enabled, simulate each source
  independently or only the selected source. Preserve bounded 500-event
  activity history and bounded paginated DOM.
- Prefer source-level visibility culling before Three.js object creation for
  large collections. Measure aggregate layout/render time against a
  representative large-graph baseline before enabling automatic all-source
  physics.

### Workstreams and integration order

The parent coordinator should dispatch non-overlapping GPT-5.6 Luna worktrees
from the current base SHA. This sub-agent does not dispatch nested workers.

1. **Collection contract/model + parser loading** — own new collection types,
   source identity, batch loading/caching, parser/API request orchestration,
   and model tests. Do not edit GraphCanvas or activity reducer.
2. **Collection layout/render integration** — own source-prefixed graph merge,
   deterministic source packing, hierarchy/source groups, aggregate stats, and
   GraphCanvas adaptation. Consume workstream 1's model; do not edit producer
   or SSE filtering.
3. **Collection activity attribution/transport** — own multi-workspace SSE
   selection, aggregate resolver/indexes, multi-target pulses, source labels,
   and preservation of bash/tool groups/snippets. Consume the model's
   `sourceId` mapping; avoid parser loading/UI picker files.
4. **Controls and QA** — own source-list controls, source selector, diagnostics,
   history scoping, targeted UI/manual assertions, and performance/regression
   validation. Integrate only after the first three contracts stabilize.

Integration must be ordered **1 → 2 → 3 → 4**. Shared files (`App.tsx`,
`src/types.ts`, activity types/contract, `layout.ts`, `GraphCanvas.tsx`, and
server activity route registration) are coordinator-owned merge points. Each
worker should report changed paths, a reviewable revision, tests, and any
contract deviations before integration, without committing local worktree
paths.

### Acceptance criteria

- Load Python + TypeScript analyses for one root and render both without ID or
  file-resolution collisions.
- Load at least two repositories/worktrees, select all or one source, and keep
  successful sources visible when another fails.
- A single attributed Copilot event can pulse every valid matching language
  graph, while an explicit source/node target pulses only that graph.
- Multiple workspace IDs stream safely; unrelated workspace events never enter
  the collection.
- Bash/per-tool groups, bounded path-preserving snippets, 30-second activity
  prominence, blue read pulses, red write pulses, and ten-at-a-time telemetry
  pagination remain intact. The separate active/current tool-and-agent list
  renders only the ten newest entries; its counts remain complete and are not
  paginated.
- Any tool event with a validated specific target produces a bounded
  same-colored transient ray from its tool group to that target; rays expire
  after 30 seconds and never appear in persistent edge data.
- Existing single-repository architecture/history behavior and current
  producer/frontend tests remain green.

## Tool-label and patch-link visualization requirement

Every normalized tool event, regardless of provider naming (`tool`,
`tool.start`, MCP, `apply_patch`, or a future tool lifecycle alias), must
animate the corresponding activity tool group's text:

- `0–6s`: jump to and hold at `2.5×` normal text size;
- `6–12s`: ease smoothly back to `1.0×`;
- after 12s: remove the transient animation state.

This is separate from the existing 30-second activity prominence TTL. The
tool/group remains prominent for the activity TTL, while its label gets the
short six-second attention animation on each new event. Repeated events restart
the label animation from `4.0×` without queueing or creating duplicate scene
objects. Activity must not scale or pulse the persistent hierarchy box;
`GroupMotion` is reserved for non-activity/history behavior.

### Safe contract additions

Add these fields without changing parser graph-v2:

- `ActivityTarget.sourceId?: string` and `workspaceId?: string`;
- `ActivityTarget.match: 'patch-file'` for file paths extracted from patch
  payloads;
- `ActivityEvent.targets?: ActivityTarget[]` as the forward-compatible
  multi-target field, while retaining `target?: ActivityTarget` during
  migration;
- `ActivityEvent.toolGroupId?: string` and bounded `snippet?: string` for the
  already-normalized tool-group and privacy-safe display text;
- `ActivityPulse.effect: 'node' | 'group' | 'tool-label' | 'ray'`, with
  optional `sourceId`, `workspaceId`, and ray endpoints. `link` may remain a
  temporary wire-format alias during migration, but the renderer must treat it
  as a transient ray.

The collector/frontend contract must continue to accept only bounded,
validated IDs, paths, source IDs, and privacy-filtered snippets. Never copy raw
patch text, full tool arguments, command output, or model content into an event.

### Patch-file extraction and resolution

The producer should recognize patch-like tools by safe tool name
(`apply_patch`, `patch`, or an explicitly allowlisted provider alias). It may
extract only unified patch headers such as `*** Update File:`, `*** Add File:`,
`*** Delete File:`, and standard `---/+++` paths. Normalize at most 32 paths,
workspace-relativize them with the existing symlink/containment checks, mark
them `action: 'write'`, and discard outside-root or ambiguous path values.
The snippet is only a bounded summary such as `apply_patch · 3 files`; local
paths remain available for attribution, while credential-like values are
filtered.

Collection resolution must:

1. require the event workspace ID to match the selected workspace;
2. prefer an explicit target `sourceId`/node ID;
3. otherwise resolve each patch path only inside source indexes belonging to
   that workspace;
4. return all genuinely matching language sources for the same workspace when
   no source selector exists, marking the result ambiguous for the panel;
5. never suffix-match a path across different workspace IDs or repositories.

Thus `src/app.ts` in repository A cannot pulse `src/app.ts` in repository B,
even when both are loaded and share a display name. A patch in a
Python+TypeScript view may intentionally pulse both source graphs unless the
producer or user supplies a source selector.

### Transient tool-to-target rays

This generalizes and supersedes the apply-patch-only temporary-link behavior.
Whenever any normalized tool event identifies a specific file, graph node,
source span, or hierarchy group, render a transient ray from the relevant
tool-group node/center to that resolved target. The ray:

- appears immediately with the event's read/write/search/tool color;
- fades from full strength over the normal 30-second activity hold/fade
  interval, then is removed;
- is an `ActivityRay`/`ActivityPulse(effect: 'ray')` overlay only and never
  mutates `CodeGraph.edges`, graph statistics, or persistent layout;
- uses the same source/repository identity checks as target pulses, so equal
  relative paths in different workspaces cannot cross-link;
- deduplicates by `eventId + sourceId + targetId` and evicts oldest records at
  a bounded cap (initial proposal: 128 active rays, with at most 32 targets
  extracted from one event);
- omits unresolved, outside-root, or ambiguous cross-workspace targets rather
  than guessing a ray endpoint.

`apply_patch` remains a producer extraction case: its bounded patch-header
targets become write-colored rays, while all other tools use their structured
resource/span targets. A tool event may produce multiple bounded rays, one per
validated target. The tool-group endpoint itself must be stable and source
aware; if the group has no renderable center, retain the event in the panel
without inventing an endpoint.

Node/group read/write pulses continue to use the existing 30-second TTL and
blue/red colors. A resolved patch file should receive a write pulse and its
namespace/group should receive the corresponding activity highlight; the
transient tool-to-target ray is an additional 30-second overlay.

### Rendering ownership and integration

- **Activity contract/resolver workstream:** owns patch-header extraction,
  multi-target/source-aware resolution, pulse/link schemas, caps, and tests.
- **Collection layout/render workstream:** owns tool-label scale animation,
  transient ray rendering, endpoint lookup across packed source layouts, and
  cleanup/expiry behavior.
- **Controls/QA workstream:** verifies apply-patch fixtures, repeated tool
  events, ambiguous same-path multi-language sources, cross-repository
  isolation, six-second timing, 30-second prominence, and bounded link/DOM
  counts.

The coordinator-owned merge points remain `src/activity/types.ts`,
`src/activity/contract.ts`, `src/activity/graphResolver.ts`,
`src/activity/reducer.ts`, `src/components/GraphCanvas.tsx`, and `App.tsx`.
Integrate contract/resolver changes before renderer changes, then controls and
QA. Existing bash/per-tool hierarchy groups and ten-at-a-time telemetry
pagination must remain unchanged. Activity-driven hierarchy boxes remain
opacity-only; no activity scale or box-pulse overlay is permitted. Tool
labels, including `bash commands`, remain 2.5× for 6s then smoothstep to normal
over 6s, restarting from 2.5× on every new ping.

## Pulse styling refinement

Activity highlighting must keep persistent hierarchy geometry neutral. A
hierarchy box must never turn gold merely because activity starts: its normal
blue/namespace/virtual color remains unchanged, while its opacity begins at
full strength and fades toward the normal activity baseline over the existing
30-second pulse hold/fade interval. Selection and history playback may retain
their independent gold treatment.

The colored ripple is a separate transient effect centered on the resolved
activity target's node or group center. Its color comes from the activity kind:
blue for reads, red for writes, and the existing tool/search colors for those
events. The optional 1.25-second shockwave must not mutate the persistent
hierarchy box color, scale, or opacity. Only opacity changes on activity;
activity-driven `GroupMotion` and box overlays are disabled. Resolver/reducer
tests must assert the exact read/write pulse colors and 30-second expiry
semantics, while renderer checks cover the 2.5×/6s/6s label timing.

For incremental integration, this styling change is split deliberately:

1. contract/reducer color and TTL assertions;
2. renderer opacity animation and neutral hierarchy colors;
3. targeted UI/visual smoke validation.

The renderer work overlaps coordinator-owned `GraphCanvas.tsx`; it must be
manually integrated against the dirty master file unless its worker diff is
proven disjoint. After each validated step, follow the master safety gate above
and report the exact integrated SHA/path before proceeding.

## Current startup behavior

Until collection mode generalizes the startup flow, the viewer opens with:

- `viewMode: 'activity'`, so Live Activity is the fresh-install default and
  the telemetry stream is enabled immediately;
- the repository path selected for the current run; do not commit a
  machine-specific absolute path;
- canonical TypeScript analysis mode (`typescript-javascript`, displayed as
  TypeScript / JavaScript and accepted as the current `typescript` default).

Architecture remains supported as a secondary mode; architecture-only analysis
controls are hidden in Live Activity rather than removed. The persisted
**Show inactive agents** toggle defaults on and only controls inactive glyphs.
These are initial React state values only. User changes must remain
authoritative and must not be overwritten by effects, repository loads, stream
reconnects, or later collection-mode initialization. The existing demo graph
remains the fixture for tests only; the startup constellation is intentionally
empty with zero graph stats until the user clicks Analyze. Live Activity
subscribes across workspaces, so telemetry remains live while graph targets are
unavailable.

## Tool-group snippet markers

Each activity tool group may show a stack of small non-circular child markers
(octahedron/diamond), one per recent command/tool event. Each marker contains
its own bounded, privacy-filtered command snippet or safe event summary.
Markers are not code nodes and must never contain raw arguments, output,
prompts, or secrets; local paths are retained for attribution. Each starts at
full opacity for 20 seconds, then fades smoothly to hidden over the next 10
seconds (30 seconds total) before removal. New events add a distinct marker
while older markers continue fading; effects are not queued or replaced.

Markers are keyed by source-aware event/tool-group identity, placed
deterministically with maximum separation inside their group, capped per group
and globally (12 per group and 64 total), and retained only in the activity
overlay. They must not mutate persistent graph nodes/edges or create unbounded
Three.js objects. The existing tool-group label animation remains separate:
2.5× for 6 seconds, then smoothstep to normal over 6 seconds on every ping.

This is a coordinator-owned `App.tsx` integration step. Validate that the
activity EventSource is created on first render, then run the smallest frontend
build/type check and existing viewer/API health checks. Integrate this step
promptly under the incremental master safety gate before broader collection
controls land.

## Agent overlay and session identity

The current activity overlay renders distinct non-box agent glyphs from stable
workspace/session/agent identities. The ring of active agents sits above the
bash/per-tool boxes on the operator plane; inactive agents move to a separate
upper ring after ten minutes. Agents and tool groups remain separate from the
project/directory/file hierarchy plane. Live Activity subscribes to sessions
from all workspaces.

- **Activity identity:** preserve stable opaque `sessionId`, `agentId`, parent
  agent/session IDs, turn IDs, and tool-call IDs through normalization and
  bounded replay. Never collapse concurrent sessions merely because they share
  a workspace, tool, timestamp, or display name.
- **Session display identity:** carry a bounded, privacy-filtered `sessionName`
  from local `vscode.metadata.json` `customTitle` values when available. Use it
  as the readable agent glyph label while retaining the stable agent ID for
  correlation and debugging.
- **Source/repository identity:** keep `workspaceId` (repository/worktree
  attribution) separate from `sourceId` (language/project graph) and
  session/agent identity. A session may visit multiple repositories and a
  repository may have multiple language sources.
- **Correlation:** use provider/source/session/sequence identities for
  deduplication and lifecycle correlation. If provider IDs are missing, derive
  only deterministic opaque local keys from normalized metadata; never retain
  raw prompts, commands, results, or secrets.
- **Graph targets:** target IDs carry source provenance and resolve only when
  workspace and path/span evidence support it. Session/agent identity is
  attached to pulses and event rows, not silently encoded into persistent
  `CodeGraph` node IDs.
- **Agent rays:** only explicitly identified `read_agent` and `write_agent`
  events create bounded, dashed, event-colored rays. A read ray runs from the
  recipient being read to the reader; a write ray runs from the writer to its
  recipient. Cross-workspace rays require an explicit recipient that resolves
  uniquely to a visible agent; ambiguous or unmatched recipients are not
  guessed. Dashed-flow animation respects reduced-motion preferences. Rays
  retain the transient overlay contract: 30-second expiry, event/target
  deduplication, and active-ray caps.
- **UI filtering/legend:** session/subagent filters and a dedicated legend remain
  future work. The eventual legend must distinguish repository/source groups
  from session/agent overlays and show unknown or unattributed state rather than
  implying inactivity.

Future QA should retain fixtures for concurrency, duplicate IDs,
cross-repository visits, resumed sessions, and subagent parent/child events.

## Integration safety

For changes spanning producer, collector, and frontend, record the changed
paths and relevant validation results without committing absolute worktree
paths, private repository names, or local session identifiers. Check the
target checkout's status and diff before integration. Preserve unrelated
changes, resolve overlapping edits deliberately, and rerun the focused tests
for affected layers. Do not assume another checkout is clean or reset it as
an integration shortcut.

## Remaining compatibility work

Standalone Copilot app extension discovery remains unverified; the JSONL
watcher does not prove app attribution. OTel, conversation display/control,
and other optional local integrations remain deferred.
