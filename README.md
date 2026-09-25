# Codewalk

Codewalk is a local-first 3D code architecture explorer. It turns Clojure,
Python, C#, and TypeScript/JavaScript repositories into deterministic graphs of
namespaces/modules, declarations, calls, imports, and references, then renders
those graphs as an interactive React/Vite/Three.js scene.

The repository has three layers:

- `src/codewalk/` contains the Clojure analyzer, Git history/archive logic, and
  local HTTP API.
- `parser/` contains the Python, Roslyn/MSBuild C#, and TypeScript compiler API
  adapters, the shared IR contract, and graph-v2 projection.
- `src/` contains the viewer, layout, history playback, filtering, physics, and
  linked architecture-analysis panels.

For a complete implementation handoff, read [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md).

## Requirements

The root Vite viewer requires Node.js `^20.19.0 || >=22.12.0` and npm, matching
the minimum supported by the checked-in Vite 7 release. The TypeScript/JavaScript
parser adapter itself supports Node.js `>=18`, but running Codewalk from the
repository root requires Vite's newer minimum. Live repository mode and Clojure
indexing also need [the Clojure CLI](https://clojure.org/guides/install_clojure),
JDK 17+, Git, Bash, and curl. Python analysis needs Python 3.10+. C# analysis
needs the .NET 9 SDK/MSBuild.

## Quickstart

From the Codewalk directory:

```sh
npm install
npm --prefix parser/typescript-javascript install
npm --prefix parser/typescript-javascript run build
dotnet restore parser/csharp/Codewalk.CSharp.csproj
```

The `npm --prefix parser/typescript-javascript run build` step is required
because `parser/orchestration/typescript_adapter_bridge.mjs` loads the
adapter's compiled `dist/index.js`, which is gitignored and not checked in.

For API-backed repository analysis, start both the analyzer API and Vite viewer
with the recommended one-command workflow. It waits for the API to be ready and
stops the API when the viewer exits:

```sh
npm run dev:live -- /path/to/repository
```

Open <http://127.0.0.1:4173/>. The viewer starts in Live activity mode. Enter a
repository path and click **Analyze** to request its graph from the API. **Import
graph JSON** loads an exported graph directly and does not require the API.
Running `npm run dev` alone starts only Vite, so API-backed **Analyze** is not
available unless the API is started separately; see [Manual live
setup](#manual-live-setup). Stop the viewer with `Ctrl-C`.

When running the viewer separately, choose another port with
`npm run dev -- --port 4177`.

The API listens on `127.0.0.1:4180` and the viewer on
<http://127.0.0.1:4173/>. The API startup log is written to
`~/.codewalk/runtime/api.log` by default; set `CODEWALK_RUNTIME_DIR` to change
the runtime directory.

### Live Copilot activity

Codewalk can visualize a local Copilot session as it works in the loaded
repository. Start Codewalk with the one-command workflow, install the
user-scoped producer once, then select **Live activity** in the viewer:

```sh
npm run dev:live -- /path/to/repository
```

The producer installation and hook registration steps are in
[`producer/README.md`](producer/README.md). They do not modify the repository
being visualized. Copilot CLI `1.0.81-12` is verified end to end: reported file
reads, writes, searches, and tool lifecycle events update the bounded activity
panel and pulse mapped graph nodes or hierarchy groups. Unmapped events remain
visible in the panel instead of being guessed onto the graph.

Activity stays local. The collector binds to loopback, requires a random token
stored at `~/.codewalk/activity/token`, and accepts only privacy-filtered
schema-v1 metadata. Local workspace roots and paths remain visible to this
local-only viewer so activity never appears as `[PATH]` or `[path redacted]`.
Credential-like values are still filtered. Live activity subscribes to all
workspaces so agents and sessions from other repositories remain visible in
the activity panel and constellation. Resource-to-code-node mapping still
checks workspace identity, so cross-workspace events are not guessed onto the
loaded graph. The token remains a proxy-added header and is never exposed to
page code. Replay windows remain independently bounded per workspace.
Prompts, assistant responses, tool arguments/results, code, environment
values, and credentials are excluded by default. Shell/tool events may include
only a bounded snippet of the command shape; raw command output is never
retained.

Metadata-only activity recording is separately opt-in. Set
`CODEWALK_ACTIVITY_CAPTURE=true` (or pass `--activity-capture true`) to write
validated activity events outside analyzed repositories under
`~/.codewalk/runtime/activity-log` by default. Override that location with
`CODEWALK_ACTIVITY_LOG_DIR` or `--activity-log-dir`. The archive uses
`index.json` plus one directory per recording containing `manifest.json` and
`events.jsonl`; directories are `0700` and files are `0600`. Retention is
bounded to 20 recordings, 100,000 events, 100 MiB, and 14 days. Capture never
adds archive rows to the live SSE stream.

Standalone GitHub Copilot app support remains **unverified**. The installed app
contains the Copilot SDK, but it has not been observed loading the same
user-level extension and hook configuration, so the UI and capability report
do not claim app coverage.

### Manual live setup

If you prefer separate terminals, run the API in one terminal:

```sh
npm run serve -- --repo-root /path/to/repository
```

Then run the viewer in another:

```sh
npm run dev
```

If neither `CODEWALK_ACTIVITY_TOKEN` nor `--activity-token` is supplied,
`serve` reuses or creates a random token at `~/.codewalk/activity/token`
(directory mode `0700`, file mode `0600`) and prints its path — never the
token value — as `Activity token file: <path>`. The Vite dev server reads
`CODEWALK_ACTIVITY_TOKEN` from its own environment to attach the
`X-Codewalk-Activity-Token` header for you, so export the same token value
(for example `export CODEWALK_ACTIVITY_TOKEN="$(cat ~/.codewalk/activity/token)"`)
in the terminal running `npm run dev`.

Useful environment variables and flags:

| Variable | Flag | Applies to | Purpose |
|---|---|---|---|
| `CODEWALK_VIEWER_PORT` | — | `vite.config.ts`, `npm run dev:live` | Viewer port (default `4173`). Vite now fails to start rather than silently moving to another port when it is busy. |
| `CODEWALK_ACTIVITY_TOKEN` | `--activity-token` | `serve` | Activity stream bearer token. Generated and reused at `~/.codewalk/activity/token` when neither is set. |
| `CODEWALK_ACTIVITY_ORIGINS` | `--activity-origins` | `serve` | Comma-separated browser origins allowed to reach `/api/activity/*`. |
| `CODEWALK_ACTIVITY_CAPTURE` | `--activity-capture` | `serve` | Opt-in metadata-only recording (`true`/`false`, default `false`). |
| `CODEWALK_ACTIVITY_LOG_DIR` | `--activity-log-dir` | `serve` | Recording archive directory (default `~/.codewalk/runtime/activity-log`); never place it inside an analyzed repository. |
| `CODEWALK_CACHE_DIR` | `-Dcodewalk.cache.dir` (JVM system property) | `index`, history playback | Overrides the revision-archive cache directory (default `~/.cache/codewalk/revisions`). |
| — | `--port` | `serve` | API port (default `4180`). |
| — | `--repo-root` | `index`, `serve` | Repository root to analyze or serve. |

Enter the same repository path in **Live repository**. Codewalk reads the full
oldest-first Git timeline and displays its commit count without generating a
graph for every commit. Selecting a commit (or playing the timeline) requests
that revision from the API. The API archives the commit outside the target
checkout, runs the selected analyzer, returns the graph, and removes the
archive; it never checks out or mutates the source repository.

Clojure adjacent playback reuses the previous graph and analyzes only changed
Clojure files. Python, C#, and TypeScript/JavaScript revisions currently
reparse the complete snapshot and then map Git changes onto the result;
`incremental-map` is not partial parsing. Random jumps use a full snapshot.
Loaded snapshots use a bounded revision cache and sequentially prefetch the
next two commits. The graph footer reports the revision mode. The Vite dev
server proxies `/api` to `127.0.0.1:4180`. The live API also exposes
`/api/temporal?path=...` for server-side namespace co-change aggregation.

### Parsing and Git revision modes

Codewalk has two distinct revision pipelines:

- **Clojure:** the initial snapshot and non-adjacent jumps run a full clj-kondo
  analysis. An adjacent forward revision is true partial graph parsing: only
  changed Clojure source files are analyzed, then their nodes and edge evidence
  are merged into the previous graph. The graph footer labels these snapshots
  `full` or `incremental`. The Clojure server keeps only the latest snapshot per
  repository; requesting that same commit again is a cache hit even though no
  separate `cached` label is added.
- **Python, C#, and TypeScript/JavaScript adapters:** every uncached revision
  archives the complete requested snapshot and runs the selected adapter across
  it. `incremental-map` means only that the supplied previous commit is the
  requested commit's parent, so Codewalk maps Git changed files and line ranges
  onto the newly generated full graph. It is not partial parsing. The adapter's
  own `analysis.mode` remains `full`; `revision.mode` is `full`,
  `incremental-map`, or `cached`. Cached responses reuse the previously parsed
  graph. The shared in-memory parser cache is bounded to 12 revision/language
  entries.

For all parser adapters, ownership metadata records which graph node and edge
IDs have evidence in each source file. Their standalone "incremental" surfaces
are ownership/invalidation contracts rather than partial parsers: Python walks
and reparses all source files with a `conservative-full-reparse` strategy, C#
loads every project/document semantic model, and TypeScript creates a complete
compiler program and graph before calculating invalidated dependents. The
current Codewalk revision endpoint does not pass changed files to any of these
surfaces. During history playback, changed nodes and edges come from exact Git
paths and changed line ranges. Namespace nodes may use changed-file evidence
because they represent a whole module/file; vars and relationship evidence
require overlapping changed ranges when those ranges are available. The
browser sends `includeIr:false` to omit duplicate IR serialization and transfer;
the API and direct dispatcher still retain full IR by default.

### API request and configuration

The main parser routes are:

- `GET /api/health`
- `GET /api/activity/recordings?workspaceId=&sessionId=&limit=&cursor=`
- `GET /api/activity/recordings/:recordingId`
- `GET /api/activity/recordings/:recordingId/events?after=&limit=`
- `GET /api/parser/capabilities?path=<encoded-local-path>`
- `POST /api/parser/analyze`

Activity recording routes use the same loopback token and origin checks as the
live activity endpoints. Recording event pages return bounded JSONL rows in
`recordingSequence` order; `recordingSequence` is independent of live SSE
`streamSequence`. A page for an active recording uses the sequence snapshot
captured when the request begins. Recording manifests expose only bounded
session/workspace summaries and the `activity-metadata-v1` redaction policy.

An analysis request contains `path`, `language`, optional `commit` and
`previousCommit`, and may include `projectFile`, `configPath`,
`timeoutSeconds`, and `includeIr`. The supported language names are `auto`,
`python`, `csharp`, and `typescript-javascript`, with aliases for Python, C#,
TypeScript, and JavaScript. Parser requests are capped at 1 MiB, adapter output
at 256 MiB, and API timeouts at 0.1-300 seconds (default 120 seconds).

The dispatcher reads an optional `.codewalk-parser.json` target configuration.
Commands run as argv with `shell=False`; no package-manager command is run in
the analyzed repository. See `parser/backend/README.md` and
`parser/orchestration/README.md` for the complete envelope and override
contract.

### Development checks

```sh
npm run build
npm --prefix producer test
npm --prefix parser/typescript-javascript test
python3 -B -m unittest discover -s parser/python/tests -p 'test_*.py'
python3 -B -m unittest discover -s parser/conformance/tests -p 'test_*.py'
python3 -B -m unittest discover -s parser/projection/tests -p 'test_*.py'
python3 -B -m unittest discover -s parser/orchestration/tests -p 'test_*.py'
dotnet run --project parser/csharp/Codewalk.CSharp.csproj -- --self-test
clojure -Sdeps '{:paths ["src" "test"]}' -M -e \
  '(require (quote codewalk.parser-test)) (let [result (clojure.test/run-tests (quote codewalk.parser-test))] (when (pos? (+ (:fail result) (:error result))) (System/exit 1)))'
clojure -Sdeps '{:paths ["src" "test"]}' -M -e \
  '(require (quote codewalk.activity-test)) (let [result (clojure.test/run-tests (quote codewalk.activity-test))] (when (pos? (+ (:fail result) (:error result))) (System/exit 1)))'
```

## Index a Clojure repository

Create a static graph JSON file with the npm alias:

```sh
npm run index -- /path/to/repo/src \
  --repo-root /path/to/repo \
  --out public/graph.json
```

Then run `npm run dev`. If `public/graph.json` exists, Codewalk loads it
automatically; it is ignored by git so local graph data stays local.

**Note:** Vite's `public/` convention copies every file under `public/` into
`dist/` verbatim on `npm run build`. That includes `public/graph.json` if it
exists, so a local build output can bundle your local (potentially large,
personal) graph data. Delete or move `public/graph.json` first if you do not
want it in a `dist/` you intend to ship or share.

Useful options:

```sh
# Include only project nodes and edges, omitting library namespaces/vars.
npm run index -- /path/to/repo/src --without-external

# Include Git history for playback in the exported graph.
npm run index -- /path/to/repo/src --repo-root /path/to/repo --history

# Index several source roots into one graph.
npm run index -- src test resources --repo-root . --out public/graph.json
```

For a production-style local preview:

```sh
npm run build
npm run preview
```

## Graph format

The interchange format is deliberately simple. Nodes have an `id`, `kind`
(`namespace`, `var`, or `keyword`), display metadata, and source location.
Edges have `source`, `target`, and `kind` (`requires`, `calls`, or `mentions`).
Format version 2 edges also carry `occurrenceCount` and deterministic
`evidence` entries with source file and line/column spans. Legacy v1 graphs are
accepted and receive partial synthesized evidence from their top-level
`file`/`row`/`col` fields. Qualified keyword names are retained as
`keywordQualifier`, but are not treated as code namespaces unless they match a
known project namespace.

An optional `history.commits` collection can carry commit metadata, changed node
IDs, changed require-edge IDs, and newly added namespace IDs for playback.
History matching follows Git rename paths into the current snapshot; vars and
keywords use changed diff ranges, while namespaces can fall back to changed
files. A commit that only touches files absent from the current snapshot can
legitimately have zero mapped nodes.

## Controls

- Drag to orbit, scroll to zoom, and right-drag to pan.
- Switch to **Live activity** to keep the architecture layout static while
  explicitly reported Copilot file/tool events pulse the graph and appear in
  the activity panel. Connection and coverage labels distinguish live,
  partial, and unavailable telemetry.
- Click a node to inspect it; double-click a namespace or var to focus its
  one-hop neighborhood.
- Press `/` to jump to search and `Escape` to clear it.
- Hold `W`/`S` or the arrow keys to move forward/backward relative to the camera; hold `Shift` for a boost.
- Namespace prefixes are recursively packed into weighted 3D volumes; each volume scales with its own nodes plus all descendants. Virtual prefix origins are labeled as inferred prefixes. When a revision changes the layout, volume centers and sizes interpolate over 0.9 seconds so new boxes grow in while neighboring boxes react smoothly. The View panel can limit rendering to leaf hierarchy volumes, hiding parent prefix boxes while preserving the same layout anchors.
- Click a hierarchy box edge or label to highlight that namespace branch; click a node to return to node selection.
- Graphs exported with `--history` start paused and expose a Git timeline with previous/next, play, scrub, back-10/back-100 jumps, and an interval control from fastest playback to 10 seconds between commits; the default interval is 4.75 seconds, and playback pauses automatically at the newest commit. Updated var and keyword names expand to 4x for three seconds, while namespace names expand to 5x, then ease back to normal size over seven seconds. Live repository mode exposes the complete repository timeline and analyzes selected revisions on demand; it does not pre-generate one graph per commit; changed nodes reveal in sequence with bright blue namespace, green var, and purple keyword shader-ring shockwaves; namespace boxes and newly added namespace nodes use gold. Hidden node kinds do not emit node shockwaves.
- Node radii use structural metrics: namespace subtree size, var source span/LOC, and keyword usage count. Keyword-heavy groups use a 3D lattice instead of an orbital sphere.
- The left panel controls node kinds, external references, edge families, hierarchy volumes, labels, node scale, edit heat, connection analysis, and opt-in local gravity physics. **Full opacity / static view** overrides updated-only filters and history fading so the complete loaded graph stays visible at full alpha when history playback is not being watched. When labels are off, keywords render as one GPU instanced cloud and keyword shockwaves use one instanced shader pass. Timeline pacing includes only currently visible node kinds, so hidden keyword changes do not consume stagger time. Three.js renders the scene through WebGL; physics remains CPU-side because it updates bounded spatial-hash forces and interactive positions rather than using a GPU compute pass. Physics uses bounded same-namespace repulsion, relationship attraction, damping, and sibling hierarchy-box collision pushes.
- Global and unscoped nodes stay in the bottom composition by default. Enable **Orbit global / unscoped nodes** beside **Show global / unscoped nodes** to place them on deterministic spherical shell anchors outside the non-global hierarchy; hiding them still removes their nodes and edge endpoints in either mode.
- Hierarchy outlines and relationship edges are batched into GPU line segments instead of one line object per box or edge. Hierarchy click targets use non-rendered raycast meshes, so making volumes clickable does not add their own visible draw calls.
- Connection analysis projects var, call, and keyword edges up to namespace pairs, preserves occurrence counts, and offers **Most connected** and **Overdependency risk** modes. Most connected combines percentile weighted degree, reverse PageRank, and requires-only betweenness; overdependency emphasizes instability, peer-relative fan-out, cycle severity, and fan-in. Mentions remain visible facts but do not distort structural cycles or bridge scores. Library references follow the **Show library references** setting. Test namespaces can be hidden with **Show test namespaces**; this is a front-end filter and is enabled by default. When shown, test namespace anchors use a subtle aqua tint. Select a namespace or one of its vars to inspect raw counts, percentiles, contribution breakdowns, cohesion, bridge score, and cycle membership.
- The **Analysis panel** selector exposes five linked engineering views: an evidence-backed **Namespace dossier**, bounded forward/reverse **Blast radius**, Git **Temporal coupling**, deterministic **Communities**, and a hierarchy-sorted dependency-structure matrix (**DSM**). Dossier relationships default to `requires`, with calls and mentions treated as optional/non-structural signals. Temporal coupling reports co-change count, support, confidence, lift, supporting commits/files, hidden-coupling candidates, and explicit partial-coverage reasons; co-change is correlation, not causation. Blast radius defaults to both directions over `requires`, depth 3, and bounded paths, and its scores are reachability heuristics rather than probabilities. Communities and DSM are compact side-panel views so they complement rather than replace the 3D scene.
- During Git playback, node recency decays over 30 seconds, while updated-only relationship edges start at 60% opacity and fade out over six seconds. Requires edges are shown only when the require relationship's own source line changed, rather than whenever either namespace changed. Vars and Keywords default to **Updated only**: they appear for their normal update pulse, then leave the scene entirely when their 30-second activity window expires. Relationships also support **Updated only**, showing only active changed edges. Leaf hierarchy volumes are enabled by default, so parent prefix boxes stay hidden until leaf-only mode is disabled. Disable both kinds for the fastest namespace-only view; removing stale nodes and relationships also removes their rendering and physics work. Namespace labels are blue, bold, and pulse to 5x size; vars retain their sizing with a subtle green label tint. Text opacity follows the associated node or namespace activity. The optional **Edit heat** view counts edits over the most recent 20 commits; nodes edited at least three times begin glowing red, with each additional edit strengthening the glow up to six edited commits. As older edits leave the rolling window, the heat weakens, hierarchy volumes inherit the strongest descendant heat, and every heated volume gets a red namespace/path label along its top edge at roughly twice the normal hierarchy-label size.
