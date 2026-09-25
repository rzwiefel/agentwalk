# Agentwalk roadmap — activity first

This is a repository-neutral design backlog, not a record of a particular
checkout, user session, or private target repository. Check `PROJECT_BRIEF.md`
and the current code before treating a proposal as unfinished. Live Activity
is the fresh-install default and primary view; Architecture remains a
supported secondary mode. The implementation briefs in
`docs/activity-extensibility-plan.md` and
`docs/activity-extensibility-tasks.md` supply additional design context.

## 1. Current capabilities

- Architecture supports Clojure, Python, C#, and TypeScript/JavaScript graphs,
  history playback, and linked analysis views. Architecture-only analysis
  controls are hidden in Live Activity and remain available in Architecture.
- The activity pipeline has producer normalization, strict collector and
  frontend allowlists, synthetic cross-layer fixtures, and separate
  workspace-aware graph targeting.
- Live Activity includes sessions from all workspaces and can show agent
  status, file/tool activity, and transient network/domain groups. The
  persisted **Show inactive agents** toggle defaults on and only controls
  inactive agent glyph visibility.
- Explicit `read_agent` and `write_agent` events create dashed, colored
  agent-to-agent rays. Reads flow from the recipient being read to the reader;
  writes flow from the writer to its recipient. Cross-workspace rays require
  explicit, uniquely resolved recipients. Reduced-motion preferences suppress
  dash-flow animation.
- Recording accepted metadata is opt-in and retention-bounded; it does not
  authorize capture of raw prompts or tool output.

## 2. Trust and maintenance

### P0 — privacy and contract checks

1. Keep every producer/collector/frontend event shape explicit. A producer
   change is incomplete until the collector and viewer accept the intended
   bounded fields and reject unsafe ones.
2. Verify shell-snippet redaction for authentication headers, URL userinfo,
   credential assignments, and local path values. Do not extend content
   persistence until its policy and tests are separately reviewed.
3. Maintain generated synthetic fixtures as cross-layer conformance tests;
   never regenerate them from actual user sessions.

### P1 — usability and performance

1. Preserve the implemented mode-aware controls: architecture-only analysis
   controls are hidden in Live Activity and remain available in Architecture
   mode.
2. Preserve bounded event, pulse, ray, marker, and completed-tool collections.
   Avoid recomputing layout or allocating render objects every frame when the
   underlying graph has not changed.
3. Keep API/viewer startup and port/origin guidance aligned with the scripts
   and README. Graph exports placed under Vite's `public/` directory can be
   copied into build output; do not publish private generated data.

### P2 — cleanup

Keep dead parsing paths removed, validate error/reporting behavior in the
producer, and update docs when contracts or file locations change. Generated
worktrees, spools, caches, and local browser artifacts must remain ignored by
repository policy rather than a developer's global ignore file.

## 3. Activity-first roadmap

### Tier 0 — trust

Test the producer, collector, and frontend together for naming, outcomes,
permission events, rejection, redaction, and bounded resources. For event
source shapes see `docs/copilot-payloads.md`.

### Tier 1 — activity shell and signals

Mode-aware controls, waiting/failed/stalled status, completed-tool durations,
session chips, dim/solo, and click-to-follow should remain independently
testable. Agent and session identity must not be collapsed into a code node.

### Tier 2 — typed targets and outcomes

Interpret shell/network intent at the producer, normalize hosts without URL
credentials or queries, and use explicit target fan-out for file, tests, Git,
build, and web/domain groups. Derive bounded result status, duration, error
code, exit code, counts, and bytes; never forward raw result content.

**Content by reference** is a separate proposal, not a consequence of an
event having output text. Any future disk content store or viewer endpoint
requires an explicit privacy/security review, opt-in, strict bounds,
authentication, retention, and redaction regression tests.

### Tier 3 — memory

A per-session footprint and replayable timeline can be built from accepted
metadata events. The existing opt-in activity archive is a bounded starting
point; do not conflate it with a proposed raw output log or imply raw content
is safe to persist.

### Tier 4 — structure

Possible extensions include subagent relationships, blast-radius hints after
verified writes, lazily loaded graphs per workspace, and a user-scoped
producer installer. Installer design must respect the host application's
actual configuration format and avoid destructive edits to user settings.

## 4. Corrections to older briefs

- Intent parsing belongs at the producer, using the active shell lexer and
  explicit resource schema rather than inferred frontend command parsing.
- Outcome fields are already derived in `producer/src/contract.mjs`; do not
  assume a separate outcomes module exists.
- Opt-in metadata recording already exists. Older briefs describing a
  memory-only collector or a not-yet-implemented archive are historical.
- Standalone app extension discovery is unverified; JSONL fallback does not
  establish application attribution.

## 5. Implementation sequencing

| Stage | Scope | Verification |
| --- | --- | --- |
| T0-A | Producer/collector/frontend conformance | Synthetic generated fixtures accepted by every layer |
| T0-E | Redaction and dead-path cleanup | Frontend/producer redaction rules stay aligned; unsafe fields rejected |
| T1 | Mode-aware controls and agent signals | Status, waiting, failure, and completed-tool tests |
| T2 | Typed targets and bounded outcomes | Network/domain and family target tests; no raw output |
| T3 | Opt-in footprint and replay | Retention, access control, and deterministic replay |
| T4 | Multi-workspace structure and installer | Workspace isolation and non-destructive user config |

Work in independently testable slices. Check the target checkout before
integration and preserve unrelated changes. Run `npm run check` for the
integrated suite; use `npm run build` when changing viewer behavior.

## 6. Invariants

No raw prompts, output, command arguments, patch text, or credentials in an
event envelope. Strip URL userinfo, query, and fragment before emitting an
external resource reference. Keep producer, collector, and frontend allowlists
closed and bounded; do not add pass-through fields. Activity is a transient
overlay, not a new `CodeGraph`/parser IR node kind. Resolve code targets only
with matching workspace evidence.

## Local branch hygiene

Branch/worktree inventories are machine-specific and deliberately not tracked
here. Before publishing anything beyond the primary branch, audit every ref
and its reachable history separately; an ignored working directory does not
sanitize an older committed branch.
