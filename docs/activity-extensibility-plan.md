# Activity extensibility: typed targets and tool outcomes

> Status: design analysis. Several proposals below are already implemented;
> verify current behavior against the code and synthetic fixtures before
> treating a finding as an open task.
> Audience: implementing agent. Read `docs/agent-activity-plan.md` first for the
> privacy invariants; this document does not restate them, it extends them.

## Progress snapshot

Current code has generated cross-layer conformance fixtures, observable
producer rejection, typed file/network targets, bounded outcomes, and
workspace-aware activity layout. Repository-container paths normalize into
the same project hierarchy as paths rooted directly at that project.
This document retains the original reasoning behind these contracts; use
`npm run check` and current source files rather than historical commit IDs
to determine what remains to implement.

## Why this document exists

Two capabilities were requested:

1. **Typed non-file targets.** A `curl https://api.example.com/...` should fire a
   ray from the bash group to a **web sphere** whose children are the domains
   being hit. Generalizes to databases, ports, queues, containers, and any
   future "place that is not a file in this repo".
2. **Doing things with tool/command output.** When a tool call or command
   produces a response, that response should be able to drive visualization
   (match counts, exit codes, status codes, bytes, errors) rather than being
   discarded.

## Verdict

**The shape is right; the type unions are closed and the wire contract is
narrower than the frontend believes.**

The pipeline is genuinely well factored — producer normalization, collector
validation, frontend contract parsing, graph resolution, reducer, layout, and
render are all separate and individually testable. Nothing needs to be torn out.

But every extension point along that path is a **closed literal union or a
hardcoded allowlist**, and there are three of them per concept (producer,
collector, frontend). Neither capability can be added without editing all three
in lockstep, and today **nothing tells you when you get it wrong** — see
Finding 5. There is also a substantial amount of already-written-but-unreachable
code (Findings 1, 2, 6) that an implementer will otherwise assume is live.

The work below is ~9 tasks. Tasks 1–3 are prerequisites for both capabilities
and should land before anything else.

## The pipeline, as built

```
Copilot hook  →  producer/bin/hook.mjs
                 producer/src/contract.mjs   normalizeHook / normalizeEvent
                 producer/src/paths.mjs      resourcesFrom / inferredActivityResources
                        ↓ bounded spool, POST /api/activity/events
                 src/codewalk/activity.clj  validate-event  (STRICT ALLOWLIST)
                        ↓ SSE /api/activity/stream
                 src/activity/contract.ts    parseActivityEvent (SECOND ALLOWLIST)
                 src/activity/graphResolver  resolveActivityTarget → ActivityTarget
                 src/activity/reducer.ts     pulses / rays / snippet markers
                 src/layout.ts               activityGroupSpecs / withActivityGroups
                 src/components/GraphCanvas  ActivityPulses / ActivityRays / GroupVolume
```

---

## Findings

### Finding 1 — The parser registry is dead code

`src/activity/parsers.ts` (459 lines: `ActivityParserRegistry`,
`shellCommandParser`, `applyPatchParser`, `genericActivityParser`) is exported
from `src/activity/index.ts:7` and **imported by nothing**. Verified:

```bash
grep -rn "parseActivityIntent\|ActivityParserRegistry" src --include=*.ts --include=*.tsx
```

returns only `parsers.ts` and `parsers.test.ts`.

This matters a lot: the registry is exactly the pluggable "recognize a specific
command and say what it did" layer both requested capabilities need, and it
already has the precedence ordering, the fail-open `try/catch` around
third-party parsers, and `sanitizeIntent` output scrubbing. It is the right
abstraction sitting unplugged.

Note also that it duplicates logic that *is* live in
`producer/src/paths.mjs:112-200` (shell lexing, search-target extraction) and
`producer/src/contract.mjs:240-284` (snippet building). Two implementations of
the same idea, one running and one not.

> **Update 2026-09-01:** `src/activity/parsers.ts` has since been deleted as
> confirmed-dead code (`docs/roadmap.md` §2 P2, §5 T0-E) — nothing imported it
> but its own test. A2-A's port source no longer exists in the working tree;
> build `producer/src/intent.mjs` fresh around the live lexer at
> `producer/src/paths.mjs:112-200`, and consult `parsers.ts` via `git log
> --follow` / `git show` only for its precedence-ordering and `sanitizeIntent`
> shape if that is useful.

### Finding 2 — The frontend reads resource fields the collector rejects

`src/codewalk/activity.clj` defines the permitted keys inside `resources[]`:

```clojure
#{:id :name :path :relativePath :ref :kind :status :summary :provider
  :action :confidence :durationMs :available :outsideRoot :redacted}
```

`src/activity/contract.ts:219-245` (`safeResource`) parses:
`kind, path, file, nodeId, action, confidence, outsideRoot, line, endLine,
column, endColumn, span`.

**`file`, `nodeId`, `line`, `endLine`, `column`, `endColumn`, and `span` are not
in the collector's allowlist.** An event carrying any of them is rejected whole
with `400 UNSAFE_EVENT_FIELD` (`validate-safe-map`,
`src/codewalk/activity.clj:143`), not
field-stripped.

The same gap exists for metadata. `graphResolver.ts:80-94` (`resourcesFor`)
synthesizes a resource from `event.metadata.file / .path / .line / .endLine /
.column / .endColumn`, but `metadata-fields`
(`src/codewalk/activity.clj:203`) contains neither `:file` nor `:path`, and
`safe-field-specs` (`src/codewalk/activity.clj:98`) has no `:file` entry at
all. `event.workspace.file` is likewise absent from
`workspace-fields` (`src/codewalk/activity.clj:195`).

**Consequence: `match: 'span'` and `match: 'node'` resolution — the top two
branches of `resolveActivityTarget` (`graphResolver.ts:270-307`) — are
unreachable over the real wire.** Only `resources[].path` with `kind`/`action`
survives the collector today. Line-precise node targeting has never actually
run end to end. It works in the frontend unit fixtures because those bypass the
collector.

This is not currently *breaking* anything, because
`producer/src/paths.mjs:66-71` only ever emits `{path, action, confidence}`
(plus `kind` for inferred resources). But it means any plan that assumes
span-level targeting works must first fix the contract.

### Finding 3 — Target and resource models are file-shaped end to end

There is no representation of a non-filesystem target anywhere:

- `ActivityResource` (`src/activity/types.ts:31-47`) — every field is a path, a
  line, or a column.
- `ActivityTarget.kind` (`types.ts:78-86`) is `'node' | 'group'`;
  `.match` is `'node' | 'span' | 'file' | 'group'`.
- `ActivityGroupKind` (`types.ts:141`) is
  `'bash' | 'tool' | 'project' | 'file' | 'directory'`.
- `LayoutGroup.activity.kind` (`src/types.ts:186-194`) repeats that union.
- `ActivityPulse.kind` (`types.ts:108`) is
  `'read' | 'write' | 'search' | 'execute' | 'session' | 'unknown'`, and
  `ACTIVITY_PULSE_COLORS` (`reducer.ts:18-25`) is a `const` object keyed by
  exactly those.
- `RESOURCE_ACTIONS` (`contract.ts:11`) is
  `read | write | search | execute | reference`.
- `PATH_KEYS` (`producer/src/paths.mjs:4`) is the only way a resource is ever
  born: `path|filePath|file|filename|uri|directory|dir|cwd|workspace`.
- `ActivityIntentTargetKind` (`parsers.ts:12`) is `'file' | 'directory' | 'path'`.

`resolveActivityTarget` iterates `resourcesFor(event)` and, for anything it
cannot map to a graph node, calls `activityTargetForResource`
(`graphResolver.ts:147`) — which unconditionally builds a
`project → directory → file` group id from a path. There is no branch for
"this resource is not a path".

**Good news:** the collector already permits `:kind`, `:name`, `:ref` (512
chars), `:provider`, and `:summary` inside `resources[]`. A web resource
expressed as
`{kind: "url", name: "api.example.com", ref: "https://api.example.com/v1/x",
provider: "curl", action: "execute"}`
**passes the existing collector unchanged.** The Clojure side needs no edit for
Capability 1 — only the frontend allowlist and the type unions do. (`:action` is
validated as a bounded 32-char string with no enum, so a new action value also
passes the collector; it is the frontend `RESOURCE_ACTIONS` set that would drop
it.)

### Finding 4 — Only `project` groups get recursive child layout

`withActivityGroups` (`src/layout.ts:324-460`) has three placement regimes:

- **projects** — grid-packed, and the recursive `place()` walk at
  `layout.ts:383-399` runs **only** inside `projects.forEach`;
- **toolbox** (`bash`/`tool`) — a flat row at `activityToolY`, `layout.ts:438-457`;
- **children with a `parentId`** — read `centerById`, which is *only* populated
  by that project walk (`layout.ts:422-436`).

So a `web` root with `domain` children would place the children at
`layout.hierarchyBounds.center` — every domain stacked at the origin. A
naive implementer will hit this and think the data is wrong.

Rendering is also box-only: `GroupVolume` emits `<boxGeometry args={[1,1,1]}/>`
(`GraphCanvas.tsx:392`) for every group regardless of kind. A literal "sphere"
needs a geometry branch keyed on `group.activity.kind`.

> **Update 2026-09-01: this finding is obsolete.** `place()` was extracted and
> now runs over every non-toolbox root, not just `projects`
> (`src/layout.ts:643,756-786`; `withActivityGroups` itself moved to
> `src/layout.ts:638`). A `web` root with `domain` children would be placed by
> that same walk today, not stacked at the origin. The `GroupVolume` geometry
> branch is still open work.

### Finding 5 — Historical: schema drift was silent and unobservable

At the time of the original review, any 4xx from the collector was treated as
permanently rejected, the record was acknowledged (dropped), and the loop
continued without a diagnostic. Event bodies were never retained, by design.

At that time, adding a field the collector did not allow silently dropped the
event. Finding 2 records the allowlist drift that made this a high-priority
fix.

**Update:** permanent collector rejections now produce bounded diagnostics;
the producer records status, code, and field names without retaining event or
response content.
See `docs/roadmap.md` for current maintenance priorities.

### Finding 6 — Historical: frontend test suites were not executed

At the time of the original review, `src/activity.test.ts` exported
`runActivityAssertions()` and `src/activity/parsers.test.ts` exported
`runActivityParserAssertions()`, but no test runner called them. The root
package had no `test` script, so `npm run build` typechecked but did not run
these suites.
`src/layout.test.ts`, `src/history.test.ts`, `src/graphPresentation.test.ts`,
`src/namespaceMetrics.test.ts`, and `src/namespaceVisibility.test.ts` are in the
same state.

**Update:** frontend tests now run through the root test script. `npm run check`
runs the type check, frontend, producer, and Clojure suites; `npm run build`
also validates the Vite production bundle.

### Finding 7 — Multi-target was specified and never built

`docs/agent-activity-plan.md:414-434` ("Safe contract additions") already
commits to `ActivityEvent.targets?: ActivityTarget[]` alongside the migration
field `target?`, plus `ActivityTarget.match: 'patch-file'`. Neither exists:
`types.ts:75` has only `target?: ActivityTarget`, and `resolveActivityTarget`
returns on the **first** matching resource (`graphResolver.ts:276-314`), so a
command touching five files produces exactly one ray.

Both requested capabilities are inherently multi-target — one `curl` chain hits
several hosts; one command writes several files. This is a prerequisite, and it
was already agreed to.

### Finding 8 — There is no outcome/result model at all

- `producer/src/contract.mjs:118-134` (`metadataFor`) reads a `postToolUse`
  payload and extracts only `providerEventType`, `providerToolCallId`,
  `providerMessageId`, `errorClassification`, `errorCode`, and the boolean
  `contentAvailable`. Nothing looks at `payload.result`, `.output`,
  `.toolResult`, `.exitCode`, or `.stdout`.
- `src/codewalk/activity.clj:94` `sensitive-fields` hard-rejects
  `:output :result :command :content :prompt :message :arguments :code :headers
  :env` anywhere in a
  metadata/workspace/resource map, with `UNSAFE_EVENT_CONTENT`.
- `validate-content` (`src/codewalk/activity.clj:230-268`) allows the
  envelope's `content` **only** as a reference map:
  `{availability, localRef, localReference, mimeType, size, sha256, redacted}`.
  This is the intended content-by-reference extension point. **Nothing produces
  it and nothing consumes it.**
- Worse, `contract.ts:422` parses `content` as a *string*
  (`redactedText(input.content)`). A reference map yields `undefined` — no
  crash, but the frontend's notion of `content` and the collector's are
  different types. `ActivityEvent.content?: string` (`types.ts:72`) is wrong.
- The reducer **deletes** tool state on completion:
  `reducer.ts:119` `if (lifecycle === 'completed' || 'failed') activeTools.delete(...)`.
  There is no retained record joining a tool call's start intent to its outcome,
  so "when it has a response, do things with that" has nothing to hang off.
- `ActivityToolState` (`types.ts:190-199`) has `status` but no `durationMs`,
  exit code, result size, or match count.

**Good news again:** `metadata-fields` (`src/codewalk/activity.clj:203`)
already permits `:durationMs`, `:count`, `:status`, `:summary`, `:available`, `:coverage`,
`:errorClassification`, and `:errorCode`. A large class of derived-from-output
facts — "rg found 12 matches", "took 340ms", "exited non-zero", "HTTP 500" —
flows through the existing collector **with no Clojure change**. The correct
design is a producer-side *result parser* that converts raw output into these
bounded scalars and never forwards the output itself, exactly mirroring how
`snippetFor` converts arguments into a bounded snippet.

---

## Workstream A — typed targets (the web sphere)

Design principle: **do not add a `web` special case. Add a `resource kind` axis,
and make `web` the first user of it.** Otherwise the next request (databases,
ports, containers) repeats all of this.

### A1. Extend the resource/target model

`src/activity/types.ts`:

- `ActivityResource`: add `name?: string`, `ref?: string`, `provider?: string`
  (all already collector-legal). Do **not** add new path-shaped fields.
- Introduce `ActivityResourceDomain = 'workspace' | 'web' | 'unknown' | (string & {})`.
  Derive it from `resource.kind` rather than storing a second field on the wire:
  `url|host|domain|endpoint|http → 'web'`; `file|directory|dir|path → 'workspace'`.
  Keep the mapping in one exported function so future domains are one-line adds.
- `ActivityTarget.match`: add `'external'` (and `'patch-file'` per Finding 7).
- `ActivityGroupKind` and `LayoutGroup.activity.kind` (`src/types.ts:187`): add
  `'web' | 'domain'`.
- `ActivityPulse.kind` and `ACTIVITY_PULSE_COLORS` (`reducer.ts:18-25`): add
  `'network'` with a distinct colour (suggest `#ffb347`; blue/red/purple/green
  are taken).
- `RESOURCE_ACTIONS` (`contract.ts:11`) and `ActivityResource.action`: add
  `'network'`.
- `ActivityIntentTargetKind` (`parsers.ts:12`): add `'endpoint'`.

### A2. Producer: recognize network commands

In `producer/src/paths.mjs`, add `inferredNetworkResources(value, workspaceRoot,
toolName)` beside the existing `inferredShellResources` / `inferredPatchResources`,
and include it in `inferredActivityResources` (`paths.mjs:230`).

Recognize `curl`, `wget`, `http`, `httpie`, `xh` in the existing shell-token walk
(`paths.mjs:166-200` already lexes segments and splits on `| || && ; &` — reuse
it, do not write a second lexer). Extract URL-shaped arguments, then emit:

```js
{ kind: "url", name: <hostname>, ref: <scheme://host/path, query stripped>,
  action: "network", confidence: "exact", provider: <command name> }
```

**Hard requirements:**

- Strip query strings, fragments, and userinfo (`user:pass@`) before emitting
  `ref`. Query strings carry tokens; `redactString` will not reliably catch them.
- Cap `ref` at 512 chars (collector limit) and `name` at 256.
- Skip anything that does not parse as an absolute `http:`/`https:` URL.
- Emit `name` (the host) even when the path is dropped — the host is the useful
  visualization key.
- Do **not** emit response data. This function sees the command only.

Also handle the structured case: MCP/tool calls whose arguments contain a `url`
key. Note `PATH_KEYS` (`paths.mjs:4`) currently matches `uri` and routes it
through `normalizeResourcePath`, which will mangle a URL into a filesystem path.
Exclude URL-shaped values from `PATH_KEYS` handling before adding the new branch.

### A3. Frontend: accept and resolve external resources

- `safeResource` (`contract.ts:219`): accept `name`, `ref`, `provider`, and
  `action: 'network'`. Apply the same host/URL sanitation as the producer —
  the producer is untrusted from the frontend's point of view.
- `activityType` (`contract.ts:430`): map `action === 'network'` to `'network'`.
- `resolveActivityTarget` (`graphResolver.ts:270`): before the path loop, branch
  on the resource domain. For a `web` resource, return
  `{kind: 'group', id: webDomainGroupId(host), match: 'external', ...}`.
  Do not run it through `activityTargetForResource`.
- `activityGroupSpecs` (`layout.ts:210`): emit a singleton root
  `group:activity:web` (`kind: 'web'`, label `web`) plus one child per host
  (`kind: 'domain'`, `parentId: 'group:activity:web'`, label = hostname). Reuse
  the existing `ACTIVITY_GROUP_TTL_MS` expiry so domains fade like everything
  else.

The ray then comes for free: `reducer.ts:230-259` already builds a
`groupId → target` ray whenever `activityGroupId(event)` (the bash group) and
`event.target` both resolve. **No reducer change is needed for the ray itself.**

### A4. Layout and render

- `withActivityGroups` (`layout.ts:638`): add a fourth regime for the web root.
  Place it in the operator layer near the toolbox (`activityToolY`), offset on X
  so it does not overlap the bash/tool row. **Update 2026-09-01:** the recursive
  `place()` walk already runs over every non-toolbox root
  (`layout.ts:643,756-786`), so no extraction is needed — a `web` root is placed
  by the existing walk automatically once it is added to `hierarchies`.
- `GroupVolume` (`GraphCanvas.tsx:362-408`): branch geometry on
  `group.activity.kind`. `'web'` → `<sphereGeometry>` sized from `group.size`;
  `'domain'` → small sphere. Everything else keeps `<boxGeometry>`. Keep the
  wireframe material and the existing opacity/TTL logic untouched.

### A5. Multi-target (Finding 7)

`resolveActivityTarget` must return **all** validated targets, capped at 32 per
event as `docs/agent-activity-plan.md:472` specifies. Add
`ActivityEvent.targets?: ActivityTarget[]`, keep `target?` populated with
`targets[0]` for compatibility, and have the reducer emit one pulse and one ray
per entry while respecting `MAX_ACTIVITY_RAYS` (128, `reducer.ts:6`).

Without this, `curl a.com && curl b.com` shows one domain.

---

## Workstream B — tool outcomes

Design principle: **outcomes are bounded scalars derived at the producer.
Raw output never enters an envelope.** This preserves every invariant in
`docs/agent-activity-plan.md:148-171` while making results usable.

### B1. Producer: a result-parser layer

Add `producer/src/outcomes.mjs` — a registry mirroring `parsers.ts` in shape
(id, precedence, `canParse`, `parse`) but running on `postToolUse` /
`postToolUseFailure` payloads. Wire it into `normalizeHook`
(`contract.mjs:369`) so `metadataFor` receives its output.

Each parser returns **only** collector-legal scalars:

| field | source | collector status |
|---|---|---|
| `durationMs` | end − start timestamp | allowed (`metadata-fields`) |
| `count` | rg match count, files changed, rows returned | allowed |
| `status` | `ok` / `failed` / `empty` | allowed |
| `summary` | bounded ≤256, control-char-free | allowed (`:summary` spec) |
| `errorClassification`, `errorCode` | existing `redactError` | allowed |
| `available` | whether output existed | allowed |

Starter parsers: shell exit code → `status`; `rg`/`grep` stdout line count →
`count`; `curl -w`/HTTP tool → status class as `status` (`2xx`/`4xx`/`5xx`,
**not** a response body); patch application → files-changed `count`.

**Non-negotiable:** these parsers read raw output and must emit only the numbers
and classifications above. Never place output text in `summary`. Reuse
`safeSnippetText` (`contract.mjs:155`) for anything string-shaped. Add a
producer test asserting a known-secret string in a tool result never appears in
the envelope — mirror the existing pattern at
`producer/test/producer.test.mjs:380` ("redacts credentials, home paths, and
content-shaped metadata").

### B2. Fix the `content` type mismatch

`ActivityEvent.content` (`types.ts:72`) must become the reference map the
collector actually validates:

```ts
content?: {
  availability?: 'available' | 'unavailable' | 'redacted';
  localRef?: string; mimeType?: string; size?: number;
  sha256?: string; redacted?: boolean;
};
```

Update `parseActivityEvent` (`contract.ts:422`) to parse it as such instead of
`redactedText(...)`. This is the sanctioned path for "the full output exists
locally at this ref, fetch it on demand" if that is ever wanted — but do not
build the fetch endpoint in this pass.

### B3. Retain completed tool calls in the reducer

`reducer.ts:117-121` currently deletes on completion. Replace with:

- keep `activeTools` semantics for in-flight calls;
- add `state.completedTools: Map<string, ActivityToolOutcome>`, bounded
  (suggest 128, same eviction style as `MAX_ACTIVITY_RAYS`);
- `ActivityToolOutcome` = tool call id, tool, session, agent, `startedAt`,
  `endedAt`, `durationMs`, `status`, `count?`, `summary?`, and the resolved
  `targets` from the start event.

This is what "do things with the response" hangs off. Join on `toolCallId`,
which the producer already propagates (`contract.mjs:326`).

### B4. Surface outcomes

- `ActivityPanel` (`src/components/ActivityPanel.tsx:163`): show
  duration/count/status on completed rows instead of dropping them.
- Optionally drive ray or marker intensity from `count` — but check the
  current typed event contract and synthetic outcome fixtures before
  investing in visuals.

**Historical assumption:** the original fixture did not model tool results.
`docs/copilot-payloads.md` now describes available SDK/hook shapes, and
`producer/src/contract.mjs` derives bounded outcomes. Revalidate changes with
synthetic fixtures; do not capture or commit a real session payload to
demonstrate an event shape.

---

## Cross-cutting tasks (do these first)

### T1. Contract conformance test — highest priority

Add a test that runs producer-generated envelopes through the Clojure validator
and the frontend parser, asserting all three agree. Options, cheapest first:

- Export the three allowlists as data and assert set relationships in a single
  test file; **or**
- Have `producer/test/producer.test.mjs` write representative envelopes to a
  fixture directory, and have the Clojure activity test suite load and
  `validate-event` every one.

The existing `producer-envelope-shape-is-supported` test
(`activity_test.clj:114`) is a hand-written approximation of this and is what
allowed Finding 2's drift to appear. Replace it with something generated.

Then fix Finding 2: either add `:file`, `:line`, `:endLine`, `:column`,
`:endColumn`, `:span`, and `:nodeId` to `resource-fields`, or delete the
unreachable branches from `graphResolver.ts` and `contract.ts`. **Recommendation:
add them to the collector** — span-precise node targeting is the whole point of
`match: 'span'` and is worth having work.

### T2. Make schema rejection observable

`producer/src/transport.mjs:82-88` should, on a 4xx, increment a counter and
write a **field-name-only** diagnostic (the collector already returns
`{"fields": [...]}` in the `UNSUPPORTED_EVENT_FIELD` problem details — see
`src/codewalk/activity.clj:292-296`) to the existing runtime log, never the
event body. Without this, every task below fails silently when it gets a field
name wrong.

### T3. Run the frontend tests

Add `"test": "node --test ..."` or a vitest config, convert the exported
`run*Assertions()` functions into real test cases, and wire them into `npm run
build` or CI. Six suites currently never execute. Do this before touching
`contract.ts` / `graphResolver.ts` / `reducer.ts`, which is where all the risk is.

### T4. Activate the parser registry

> **Update 2026-09-01:** `src/activity/parsers.ts` is deleted
> (`docs/roadmap.md` §5 T0-E). The "Frontend-side" option below and the
> "`parsers.ts` becomes the frontend's validation mirror" framing no longer
> apply — there is no frontend copy to keep. Build `producer/src/intent.mjs`
> fresh around `producer/src/paths.mjs:112-200`; consult `parsers.ts` via git
> history only for its precedence-ordering and `sanitizeIntent` shape.

Wire `parseActivityIntent` into the pipeline and delete the duplicated logic.
Two viable placements:

- **Producer-side (recommended).** Port `ActivityParserRegistry` to
  `producer/src/` and have `inferredActivityResources` (`paths.mjs:230`)
  delegate to it. Intent is then computed once, before redaction, where the raw
  payload is still available — which is the only place a `curl` URL or an exit
  code can actually be seen. `parsers.ts` becomes the frontend's *validation*
  mirror.
- **Frontend-side.** Keep `parsers.ts` where it is and call it from
  `resolveActivityTarget`. Simpler, but it can only parse what survived the
  collector, which for network URLs and results is nothing.

Choose producer-side unless there is a reason not to. Either way, one
implementation of shell lexing should survive, not two.

---

## Suggested order

| # | Task | Blocks | Notes |
|---|---|---|---|
| 1 | T1 conformance test + fix Finding 2 | everything | do not skip |
| 2 | T2 observable rejection | everything | ~30 lines |
| 3 | T3 frontend test runner | A3, B2, B3 | ~1 hour |
| 4 | T4 activate parser registry | A2, B1 | pick producer-side |
| 5 | A5 multi-target | A3, A4 | already specified in the plan doc |
| 6 | A1 type unions | A2–A4 | mechanical, touches ~8 files |
| 7 | A2 + A3 network resources | A4 | collector needs **no** change |
| 8 | A4 web sphere layout + render | — | extract the `place()` walk |
| 9 | B1–B4 outcomes | — | **verify the payload first** |

## Invariants that must not be broken

Carried from `docs/agent-activity-plan.md`; every task above was designed
to respect them.

- No activity concept enters `CodeGraph`, `GraphHistory`, parser IR, node kinds,
  or relationship statistics. Web spheres and domains are `LayoutGroup`s with an
  `activity` block and a TTL, exactly like the existing bash/tool groups.
- Raw output, prompts, full arguments, patch text, and credentials never enter an
  envelope. Outcomes are bounded scalars derived at the producer.
- Query strings and userinfo are stripped from every URL before it leaves the
  producer.
- Everything stays bounded: 32 resources/event, 32 targets/event, 128 rays,
  64 snippet markers, 500 events, 256 replay events.
- Producer payloads remain untrusted at the collector *and* at the frontend;
  both allowlists stay closed, they just gain explicit entries.
- Missing telemetry is never rendered as inactivity.
