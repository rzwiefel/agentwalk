# Live Activity implementation notes

This technical handoff is repository-neutral. For startup and current parser
capabilities, see `README.md` and `PROJECT_BRIEF.md`; for activity event
shapes, see `docs/copilot-payloads.md`. Do not add real session logs,
worktree paths, screenshots, or private target-repository observations to
tracked documentation.

## Event pipeline

1. `producer/src/sdk-adapter.mjs` and the hook/JSONL adapters collect local
   signals; `producer/src/contract.mjs` derives bounded envelopes and
   `producer/src/redact.mjs` redacts sensitive strings.
2. `src/codewalk/activity.clj` validates a strict allowlist and serves an
   authenticated local stream; `src/codewalk/activity_archive.clj` provides
   **opt-in** recording with bounded retention.
3. `src/activity/contract.ts` validates again in the viewer;
   `src/activity/reducer.ts` computes bounded transient signals.
4. `src/activity/graphResolver.ts` maps file activity only when workspace
   evidence matches the loaded graph. `src/layout.ts` and
   `src/components/GraphCanvas.tsx` render separate activity glyphs,
   project/file groups, rays, pulses, and web/tool groups.

Live Activity shows sessions from all workspaces together. Graph resolution and
recording replay remain workspace-aware; an event for a different repository
must stay visible as unmapped activity instead of being attached to the
wrong code node. Agent-to-agent rays are produced only by explicitly
identified `read_agent` and `write_agent` events: reads flow from the recipient
being read to the reader, and writes flow from the writer to its recipient.
Cross-workspace rays require an explicit recipient that resolves uniquely to a
visible agent; no recipient is guessed. Dashed-ray flow animation respects
reduced-motion preferences. The persisted **Show inactive agents** toggle
defaults on and affects only inactive agent glyph visibility.

## Privacy and safety invariants

- Envelopes must not contain raw prompts, command arguments, results,
  source diffs, credentials, or unbounded third-party payloads. Derive
  allowlisted, capped metadata at the producer and validate it again at the
  collector and frontend.
- Shell snippets and URLs require regression coverage for authorization
  headers, URL userinfo, credential assignments, and local paths. Keep
  `producer/src/redact.mjs` and frontend redaction expectations in sync;
  `src/activity/redaction.test.ts` checks their rule coverage.
- Do not enable new content persistence or export merely because an
  upstream SDK field contains output. Review the redaction boundary and
  retention policy first. Existing activity recording is opt-in and stores
  only accepted metadata events.
- Keep fixture paths and example hosts synthetic. Generated fixture updates
  should be reviewed like source changes; avoid committing local captures.

## Interaction and rendering

Permission requests can mark an agent waiting; matching completions clear
that state. Failed tools remain visible briefly instead of being reported
as successful. Session summaries, completed-tool durations, and outcome
labels are bounded. Follow-agent and dim/solo controls operate on
session/agent identity without changing the code graph.

File activity targets the loaded repository hierarchy. Network activity
can create a web group and a per-domain target using normalized host names;
tool families can create tests, Git, and build groups. Resource fan-out and
transient rays/pulses have explicit caps and expiry rules. A resolver change
must be checked against `src/activity/targets.test.ts`, reducer tests, and
layout tests to keep group IDs aligned.

## Validation and known boundaries

Run `npm run check` for frontend, producer, and Clojure checks; `npm run build`
also validates the Vite bundle. Use the checked-in synthetic fixtures for
cross-layer contract changes. Rendering behavior should additionally be
checked in a browser with WebGL support; unit tests do not prove a visible
canvas result.

Standalone Copilot app discovery of user extensions/global hooks remains
unverified. The JSONL watcher is a fallback source, not proof of app
attribution. Other agent integrations, conversation controls, and raw
content-by-reference features require separate design and privacy review.
