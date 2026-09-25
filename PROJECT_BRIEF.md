# Agentwalk project brief

This is the durable handoff for Agentwalk. Read this file and `README.md` before
making changes. `README.md` is the user-facing guide; the documents below
contain adapter-specific contracts and implementation details.

## Mission

Agentwalk is a local-first viewer for coding-agent activity, with a supported
3D code architecture explorer as a secondary mode. Live Activity is the
primary view on a fresh install. Architecture mode turns source code and Git
history into deterministic graphs of namespaces/modules, declarations, and
relationships, then renders those graphs as an interactive Three.js scene.
Its original Clojure symbol graph is extended to Python, C#, and
TypeScript/JavaScript through language-neutral parser adapters.

## Current state

- Repository: current checkout
- Primary branch: `master`
- Inspect `git status` before making changes; do not assume a checkout is clean.
- No changes should be made to analyzed target repositories merely to inspect
  them. Git revisions are archived into scratch locations outside the target.
- The current implementation is integrated and usable; the parser adapters are
  not just research prototypes.

The frontend indexes history/cohesion data once per graph, requests graph-only
parser output for the browser, and maps Git path changes conservatively. The
adapter-output cap is 256 MiB.

## Architecture

```text
source repository
       |
       +-- Clojure: clj-kondo analyzer
       +-- Python/C#/TS-JS: native language adapter
                         |
                         v
              parser/shared/ir.py
                         |
                         v
              parser/projection/graph_v2.py
                         |
                         v
                Clojure HTTP API
                         |
                         v
              React/Vite/Three.js viewer
```

- `src/codewalk/analyzer.clj` produces the original symbol graph.
- `src/codewalk/history.clj` resolves refs, computes changed files/ranges,
  archives revisions outside the target checkout, and maintains the bounded
  revision cache.
- `src/codewalk/parser.clj` validates parser requests, starts the dispatcher,
  enforces limits, and maps dispatcher envelopes to HTTP responses.
- `src/codewalk/server.clj` exposes repository, graph, temporal, parser, and
  health routes.
- `parser/orchestration/dispatcher.py` detects or selects an adapter, runs it
  with argv-based subprocess execution, normalizes IR, and projects graph-v2.
- `parser/shared/ir.py` and `parser/shared/schema.json` define the normalized
  adapter contract.
- `src/App.tsx`, `src/graph.ts`, `src/history.ts`, `src/layout.ts`, and
  `src/components/GraphCanvas.tsx` own graph loading, history playback,
  visibility, layout, and rendering.
- `src/analysis/`, `src/architectureViews.ts`, `src/blastRadius.ts`, and
  `src/temporalCoupling.ts` provide the linked analysis views.

## Runtime and startup

Requirements:

- Node.js `^20.19.0 || >=22.12.0` and npm for the root Vite viewer. The
  TypeScript/JavaScript adapter itself supports Node.js `>=18`.
- Clojure CLI and JDK 17+ for the API and Clojure indexing; Bash and curl for
  the `dev:live` launcher.
- Git for Git-backed repository history and live repository features.
- Python 3.10+ and .NET 9 SDK/MSBuild are optional runtimes for the Python and
  C# Architecture adapters.

Install the core viewer dependencies from the repository root:

```sh
npm install
```

Build the TypeScript/JavaScript adapter only when using that optional
Architecture analysis path:

```sh
npm --prefix parser/typescript-javascript install
npm --prefix parser/typescript-javascript run build
```

For separate local services in observer mode:

```sh
# Terminal 1: API
npm run serve

# Terminal 2: viewer (default port is 4173)
npm run dev
```

To preselect a repository for Architecture analysis, optionally add
`--repo-root /path/to/repository` to the API command.

The API listens on `http://127.0.0.1:4180`. The Vite proxy forwards `/api` to
that port. To use a different viewer port:

```sh
npm run dev -- --port 4177
```

The observer-first one-command workflow starts both services with no repository
argument and uses the default viewer port:

```sh
npm run dev:live
```

The API health check is `GET /api/health`. `npm run dev:live` starts both
services and stops its API child when the viewer exits. The API log defaults to
`~/.codewalk/runtime/api.log`; `CODEWALK_RUNTIME_DIR` overrides the runtime
directory. Runtime data stays outside analyzed repositories. Parser adapters
are short-lived subprocesses; they are not persistent backend servers. Passing
`npm run dev:live -- /path/to/repository` is optional and preselects the
default repository for Architecture analysis; activity collection still
observes all workspaces.

## Parser modes

| Language | Engine | Uncached revision behavior |
| --- | --- | --- |
| Clojure | clj-kondo | Full analysis for the initial/non-adjacent revision; true changed-file incremental graph merge for an adjacent forward revision. |
| Python | stdlib `ast` | Full repository reparse; reports ownership, invalidation, deletions, and renames for incremental mapping. |
| C# | Roslyn/MSBuild | Full semantic project/document load; `--changed` records invalidation but does not make the load partial. |
| TypeScript/JavaScript | TypeScript compiler API | Builds a complete compiler `Program` and graph; incremental metadata maps changed files and dependents but does not make revision parsing partial. |

For non-Clojure adapters, `incremental-map` means that the requested commit is
adjacent to the supplied previous commit and that Git changes were mapped onto
a newly generated full graph. It is not partial parsing. The revision mode is
`full`, `incremental-map`, or `cached`; adapter analysis remains `full`.

The browser sends `includeIr:false`, so graph-only requests avoid serializing
and transferring the duplicate full IR. Direct dispatcher calls include IR by
default and can write it separately with `--ir-out`. Recoverable parser
diagnostics return a partial graph; fatal failures return structured errors.

## API contract

The Clojure API exposes:

- `GET /api/health`
- `GET /api/activity/recordings?workspaceId=&sessionId=&limit=&cursor=`
- `GET /api/activity/recordings/:recordingId`
- `GET /api/activity/recordings/:recordingId/events?after=&limit=`
- `GET /api/repository?path=<local-path>`: repository metadata and an
  oldest-first commit timeline.
- `GET /api/graph?path=<local-path>&commit=<git-ref>`: Clojure graph/revision
  playback.
- `GET /api/temporal?path=<local-path>&commit=<git-ref>`: server-side
  namespace co-change aggregation.
- `GET /api/parser/capabilities?path=<local-path>`: language detection,
  runtime availability, adapter commands, and ambiguity information.
- `POST /api/parser/analyze`: parser graph analysis.

Activity recording is opt-in with `CODEWALK_ACTIVITY_CAPTURE=true` or
`--activity-capture true` and writes only events accepted by the existing
metadata validator. The archive defaults to
`~/.codewalk/runtime/activity-log`, overridable with `CODEWALK_ACTIVITY_LOG_DIR`
or `--activity-log-dir`; it remains outside analyzed repositories. Its
`index.json` references per-recording `manifest.json` and `events.jsonl`
files. Recording manifests are format/schema version 1, retain bounded
session/workspace summaries, and use the `activity-metadata-v1` redaction
policy. Retention defaults to 20 recordings, 100,000 events, 100 MiB, and
14 days. Recording pages are authenticated with the same activity token and
origin checks as live activity, and their authoritative `recordingSequence`
never reuses live `streamSequence`.

The live activity token defaults to `~/.codewalk/activity/token`;
`CODEWALK_ACTIVITY_TOKEN` or `--activity-token` supplies an explicit token.

The parser request body accepts:

```json
{
  "path": "/path/to/repository",
  "language": "auto",
  "includeIr": false,
  "commit": "optional-git-ref",
  "previousCommit": "optional-parent-ref",
  "projectFile": "optional-repository-relative-project-file",
  "configPath": "optional-repository-relative-config-file",
  "timeoutSeconds": 120
}
```

Supported language values include `auto`, `python`, `csharp`, and
`typescript-javascript`, plus their documented aliases. The request body is
limited to 1 MiB, adapter output to 256 MiB, and parser timeout to 0.1-300
seconds (default 120 seconds at the API boundary). The dispatcher default
timeout is 300 seconds for direct CLI use.

Target repositories may provide `.codewalk-parser.json` or the API may receive
`configPath`. Commands are argv arrays or shell-split strings with
`{repo_root}`, `{dispatcher_root}`, `{project_file}`, and `{python}`
placeholders. They always run with `shell=False`; no package-manager command is
run inside the target repository.

## Graph and relationship semantics

The viewer consumes graph `formatVersion: 2`:

- Nodes are `namespace`, `var`, or `keyword`.
- Edges are `requires`, `calls`, or `mentions`.
- Edges retain occurrence counts and source evidence.
- External targets remain explicit external nodes.
- Unresolved and ambiguous placeholders are not promoted to graph endpoints.
- Rich adapter facts such as inheritance, implementation, exports, overrides,
  containment, project references, and JSX facts remain in IR rather than being
  mislabeled as calls or requires.
- IDs are deterministic and repository-relative, so equivalent checkouts
  produce stable graph identities.

TypeScript call relationships come from `CallExpression` and `NewExpression`
walks. Added functions therefore expose outgoing calls when their target
resolves; callers expose incoming edges. Dynamic or unresolved calls may remain
unresolved.

The UI keeps several concepts separate:

- **Global** nodes have an empty or `<global>` namespace.
- **Unscoped** nodes lack namespace ownership and are treated as global-owned for
  visibility and placement.
- **Inferred prefixes** are virtual hierarchy boxes for namespace path prefixes
  that have no namespace anchor.

Global and unscoped nodes use the bottom composition by default. **Orbit global /
unscoped nodes** places them on deterministic spherical anchors around the
hierarchy. Test namespace filtering, global visibility, top-level-folder relationship filtering,
updated-only visibility, edit heat, connection analysis, dossier, blast radius,
temporal coupling, communities, and DSM are front-end views over the loaded
graph; they do not change parser identity.

## Performance and known limitations

For larger graphs, consider the following performance boundaries:

- uncached parser and network work can dominate;
- TypeScript adapter reparsing plus projection/normalization can be costly
  for uncached snapshots;
- graph-only requests avoid serializing and transferring duplicate full IR;
- frontend preparation and bounded whole-history temporal aggregation should be
  measured separately on representative target graphs;
- the in-memory revision cache is bounded to 12 entries per cache policy.

Known correctness/product limitations:

- Python, C#, and TypeScript/JavaScript do not yet perform partial parsing.
- Adapter revision analysis currently does not pass Git changed files into the
  native adapter's incremental surface.
- Deletions are absent from the current graph; rename and overload edge cases
  can be ambiguous.
- Static analysis cannot fully resolve dynamic dispatch, generated code,
  reflection, data-driven registries, or other runtime wiring.
- Large graphs produce a Vite chunk-size warning; this is non-blocking.
- **Pending follow-up:** TypeScript/JavaScript graphs can promote
  expression-like names such as `expect(...)` and `jest.spyOn(...)` into
  `... / inferred prefix` hierarchy labels. This must be fixed by validating
  namespace/module candidates and rejecting expression-shaped names while
  preserving legitimate dotted module names. No implementation has started.

The future ideas backlog is in `docs/agentwalk-future-ideas.md`; it is
aspirational and not a substitute for the current implementation documents.

## Active workline: live agent activity

The repository-neutral **Live Activity** mode is implemented and is the
primary view on a fresh install; **Architecture** remains supported as a
secondary mode. Architecture-only analysis controls are hidden in Live
Activity, not removed. Copilot CLI
`1.0.81-12` is verified end to end through the user extension/hooks producer,
authenticated local collector/SSE stream, bounded frontend reducer, graph
resolver, pulses, and activity panel. Standalone Copilot app support remains
explicitly unverified until the app is observed loading the same user runtime.
Architecture decisions, privacy constraints, the event contract, future
conversation/control considerations, and verification status are recorded in
[`docs/agent-activity-plan.md`](docs/agent-activity-plan.md).

Current activity layout keeps agent glyphs and bash/per-tool boxes together on
an operator plane above the project/file hierarchy. Agent rings sit above the
tool boxes; project and directory groups retain a persistent label for roughly
ten minutes before a one-minute fade. File, directory, and patch targets receive
blue read, red write, purple search, or green execution rays for 30 seconds.
Transient command markers remain fully visible for 20 seconds and fade over the
next 10 seconds, while their labels enlarge to 2.5x for six seconds and ease
back to normal over six seconds. Displayed snippets preserve local paths but
continue filtering credential-like values and raw content.

### Current agent overlay and future controls

The activity overlay now renders one distinct non-box agent glyph per
workspace/session/agent identity. Agent glyphs use a separate namespace from
repository, language, hierarchy, bash, and tool groups, and sit on the operator
plane above the bash/per-tool boxes. Stable opaque `sessionId`, `agentId`, parent
IDs, turn IDs, tool-call IDs, provider/source identity, and ordering metadata
remain distinct so concurrent sessions are not collapsed.

`workspaceId` (repository/worktree) and `sourceId` (language/project graph)
remain separate from session and agent identity. Explicit `read_agent` and
`write_agent` events draw bounded, dashed, event-colored rays between agent
glyphs: reads flow from the recipient being read to the reader, and writes
flow from the writer to its recipient. Dashed flow animation respects reduced
motion preferences. Cross-workspace rays require an explicit recipient that
resolves uniquely to a visible agent; unknown, ambiguous, or unmatched
cross-workspace targets are not guessed. File/tool activity rays continue to
target project, directory, and file groups on the separated hierarchy plane.
The persisted **Show inactive agents** toggle defaults on and only controls
inactive agent glyph visibility. Session names are shown as the primary agent
glyph label when a local session metadata sidecar provides one, with the stable
agent ID retained as secondary identity. Session filters exist
(`src/components/ActivityPanel.tsx:143-160`); legends and bidirectional
controls remain future work.

Live Activity subscribes to all workspaces so sessions across repositories
remain visible together. Graph-node resolution stays workspace-aware, while
recording replay remains scoped to the loaded graph's workspace.

## Validation

Run checks from the repository root:

```sh
npm run check
npm run build
npm --prefix parser/typescript-javascript test
python3 -B -m unittest discover -s parser/python/tests -p 'test_*.py'
python3 -B -m unittest discover -s parser/conformance/tests -p 'test_*.py'
python3 -B -m unittest discover -s parser/projection/tests -p 'test_*.py'
python3 -B -m unittest discover -s parser/orchestration/tests -p 'test_*.py'
dotnet run --project parser/csharp/Codewalk.CSharp.csproj -- --self-test
```

The integrated check includes the Clojure suites `codewalk.parser-test` and
`codewalk.activity-test` under `test/codewalk/`. Adapter-specific contracts
and commands are documented in `parser/{python,csharp,typescript-javascript}/README.md`,
`parser/shared/README.md`, `parser/projection/README.md`, and
`parser/orchestration/README.md`.

## Safe continuation checklist

1. Read this brief, `README.md`, and the relevant adapter README.
2. Confirm `git status` before editing and do not discard unrelated user work.
3. Keep generated output (`dist`, nested adapter `dist`, caches, and
   `__pycache__`) out of commits.
4. For target-repository profiling, use read-only commands and write output
   to a reviewed location outside the target.
5. Preserve deterministic IDs, evidence, diagnostics, graph endpoint
   validation, the 256 MiB output cap, and Clojure adjacent incremental
   playback.
6. Add focused tests for behavior changes, run the smallest relevant checks,
   then run `npm run build` before concluding.
