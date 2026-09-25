# Activity extensibility: agent task breakdown

> Companion to [`docs/activity-extensibility-plan.md`](./activity-extensibility-plan.md).
> The plan explains **why** and cites the evidence. This document assigns **who
> does what, in what order, without colliding.**
> Historical task breakdown; `docs/roadmap.md` §5 and current code supersede
> its implementation status. Keep this as a file-ownership and contract
> reference, not as a live assignment queue.

## Current progress

Generated conformance fixtures, frontend/producer/Clojure runners, typed
resource contracts, direct file and agent activity routing, and network
targeting are present in the current snapshot. Before taking an older brief,
check the corresponding source and tests; its original wave label does not
establish that work is still pending.

Live-activity visualization includes
ad hoc filesystem hierarchies, direct file and agent rays, priority-ordered
ellipsoidal project placement, target-aware agent-ring rotation, compact nested
packing, duplicate-root handling, and canonical project roots when activity
arrives from both a repository workspace and its parent `repos`/`projects`
container. A lone populated project wrapper is now elided until a peer project
appears, and target-aware agent-ring movement uses smaller layout steps plus
frame damping. It overlaps files assigned to later waves and must be accounted
for before resuming the original sequence.

## How to use this

One agent per brief. Each brief names the files that agent **owns** — no agent
may edit a file owned by another agent in the same wave. Waves are gates: every
brief in a wave must land on `master` before the next wave starts.

If a brief turns out to be wrong, or needs a file you do not own: **stop and
report.** Do not expand scope. A partial correct change is worth more than a
broad guess, because the schema drift documented in the plan (Finding 2) is
exactly what happens when three layers are edited by feel.

## Baseline checks

Run all three before you start and again before you report. If a suite is
already red when you start, report that and stop.

```bash
npx tsc --noEmit
```

```bash
cd producer && npm test
```

```bash
clojure -Sdeps '{:paths ["src" "test"]}' -M -e "(require (quote codewalk.activity-test)) (require (quote clojure.test)) (clojure.test/run-tests (quote codewalk.activity-test))"
```

The `:test` alias puts `test/` on the classpath and runs the activity suite
directly with `clojure -M:test`. The explicit `-Sdeps` invocation remains
available when running that namespace in isolation.

## Invariants — do not break these

Full list in the plan's closing section. The four that get broken by accident:

1. **No raw output, prompts, full arguments, patch text, or credentials in an
   envelope.** Outcomes are bounded scalars derived at the producer.
2. **No activity concept enters `CodeGraph`, `GraphHistory`, parser IR, node
   kinds, or relationship stats.** Activity is `LayoutGroup`s with a TTL.
3. **Both allowlists stay closed** — `src/codewalk/activity.clj` and
   `src/activity/contract.ts`. They gain explicit named entries; they never gain
   a wildcard or a pass-through.
4. **Everything stays bounded**: 32 resources/event, 32 targets/event, 128 rays,
   64 snippet markers, 500 events, 256 replay events.

## File ownership

Collision hotspots. Nobody edits a file outside their row.

| File | Wave 0 | Wave 1 | Wave 2 | Wave 3 |
|---|---|---|---|---|
| `src/codewalk/activity.clj` | **A0-1** | — | — | — |
| `test/codewalk/activity_test.clj` | **A0-1** | — | — | — |
| `producer/src/transport.mjs` | **A0-2** | — | — | — |
| `package.json`, `deps.edn`, `src/*.test.ts` | **A0-3** | — | — | — |
| `src/activity/types.ts`, `src/types.ts` | — | **A1-1** | — | — |
| `producer/src/paths.mjs` | — | — | **A2-A** | — |
| `producer/src/contract.mjs`, `outcomes.mjs` | — | — | **A2-D** | — |
| `src/activity/contract.ts`, `graphResolver.ts` | — | **A1-1** (consts only) | **A2-B** | — |
| `src/activity/reducer.ts` | — | **A1-1** (colors only) | **A2-B** | **A3-1** |
| `src/layout.ts`, `GraphCanvas.tsx` | — | — | **A2-C** | — |
| `src/components/ActivityPanel.tsx` | — | — | — | **A3-2** |

---

# Wave 0 — make failure visible

Three agents, fully parallel. **Nothing else starts until all three land.**
Every task below fails silently without this wave; that is the entire point of
it.

## A0-1 — Contract conformance test, and fix the drift

**Owns:** `src/codewalk/activity.clj`, `test/codewalk/activity_test.clj`,
a new fixture directory.

Read plan Finding 2 first.

The frontend parses resource fields the collector rejects whole with
`400 UNSAFE_EVENT_FIELD`. `resource-fields` (`activity.clj:199`) lacks `:file`,
`:nodeId`, `:line`, `:endLine`, `:column`, `:endColumn`, and `:span`;
`metadata-fields` (`activity.clj:203`) lacks `:file` and `:path`;
`workspace-fields` (`activity.clj:195`) lacks `:file`. `safe-field-specs`
(`activity.clj:98`) has no `:file` entry at all.

1. Add the missing keys to `safe-field-specs` and to `resource-fields` /
   `metadata-fields` / `workspace-fields`, with bounds consistent with the
   neighbours (paths 1024, line/column non-negative numbers). `:span` is a
   nested map — either add nested validation or **flatten it to
   `startLine`/`endLine`/`column`/`endColumn`, which `safe-field-specs` already
   supports.** Flattening is preferred; say which you chose.
2. Replace `producer-envelope-shape-is-supported` (`activity_test.clj:114`) —
   a hand-written approximation — with a generated conformance test: real
   producer envelopes checked by `validate-event`. Cover at minimum a file read,
   a file write, a shell search, an apply-patch, a session lifecycle event, and
   a tool event with a span.
3. Do **not** relax `sensitive-fields` (`activity.clj:94`) or
   `validate-content` (`activity.clj:230`). Those are the privacy boundary.

**Done when:** the Clojure suite passes with strictly more assertions than the
112 baseline, and a resource carrying a line number validates instead of 400ing.

## A0-2 — Make collector rejection observable

**Owns:** `producer/src/transport.mjs`, plus appended tests in
`producer/test/producer.test.mjs`.

Read plan Finding 5.

`transport.mjs:82-88` treats any 4xx as permanently rejected, drops the record,
and retains nothing. Adding a disallowed field makes events vanish with no
signal anywhere.

1. On a permanent rejection, record a diagnostic: the HTTP status, the
   `code` (e.g. `UNSUPPORTED_EVENT_FIELD`), and the `fields` array the collector
   already returns in problem details (`activity.clj:292-296`).
2. **Field names and codes only. Never the event body, never the response body
   beyond those two keys.** This is a privacy boundary, not just a style rule.
3. Write it to the existing runtime log location used by `scripts/dev-live.sh`
   (`${CODEWALK_RUNTIME_DIR:-$HOME/.codewalk/runtime}`), and keep a rejection
   counter on the transport instance.
4. Keep the existing behavior: a rejection still drops only that record and the
   loop still continues. Do not add retries.

**Done when:** a test posts an envelope with a disallowed field against a stub
collector and asserts the field name is reported while no event content is.

## A0-3 — Make the test suites runnable

**Owns:** `package.json`, `deps.edn`, all `src/**/*.test.ts`.

Read plan Finding 6.

Six frontend suites export `run*Assertions()` functions that nothing calls:
`src/activity.test.ts`, `src/activity/parsers.test.ts`, `src/layout.test.ts`,
`src/history.test.ts`, `src/graphPresentation.test.ts`,
`src/namespaceMetrics.test.ts`, `src/namespaceVisibility.test.ts`.

1. Add a frontend test runner. Prefer `vitest` (the project is already Vite +
   TS); `node --test` with a TS loader is acceptable if you justify it.
2. Convert the exported assertion functions into real test cases. **Preserve
   every existing assertion** — this is a mechanical conversion, not a rewrite.
   The custom `expect(condition, message)` helpers can stay or be replaced with
   the runner's assertions; do not drop coverage either way.
3. Add `"test"` to root `package.json` and wire it into `build`.
4. Add a `:test` alias to `deps.edn` putting `test/` on the classpath, so the
   ad-hoc `-Sdeps` invocation above becomes `clojure -M:test`.

**Done when:** `npm test` runs all frontend suites green, `clojure -M:test`
runs the Clojure suite green, and `npx tsc --noEmit` still exits 0.

---

# Wave 1 — land the contract in one commit

One agent, alone. This is the merge point the plan names; four downstream
briefs edit files that depend on these types. Splitting it guarantees conflicts.

## A1-1 — Type unions and constants only

**Owns:** `src/activity/types.ts`, `src/types.ts`, and constant-only edits to
`src/activity/contract.ts` and `src/activity/reducer.ts`.

Read plan sections A1, A5, B2, and Finding 3.

**Types and constants only. No behavior changes, no new logic.** The diff should
be almost entirely union members and object literals. Downstream briefs supply
the behavior.

1. `ActivityResource`: add `name?: string`, `ref?: string`, `provider?: string`.
   Add no new path-shaped fields.
2. Export a single `activityResourceDomain(resource)` function mapping
   `resource.kind` → `'workspace' | 'web' | 'unknown'`
   (`url|host|domain|endpoint|http` → `web`; `file|directory|dir|path` →
   `workspace`). One function, so future domains are a one-line add. This is the
   only logic permitted in this brief.
3. `ActivityTarget.match`: add `'external'` and `'patch-file'`.
4. `ActivityGroupKind` (`types.ts:141`) and `LayoutGroup.activity.kind`
   (`src/types.ts:187`): add `'web' | 'domain'` to both. They must stay in sync.
5. `ActivityPulse.kind` and `ACTIVITY_PULSE_COLORS` (`reducer.ts:18-25`): add
   `'network'` with colour `#ffb347` (blue/red/purple/green/blue-grey are taken).
6. `RESOURCE_ACTIONS` (`contract.ts:11`) and `ActivityResource.action`: add
   `'network'`.
7. `ActivityIntentTargetKind` (`parsers.ts:12`): add `'endpoint'`.
8. Add `ActivityEvent.targets?: ActivityTarget[]`, keeping `target?` as the
   migration field. **Populate nothing yet** — A2-B does the fan-out.
9. Fix `ActivityEvent.content` (plan B2). It is typed `string` (`types.ts:72`)
   but the collector validates a reference map (`activity.clj:230-268`). Retype:
   `{availability?: 'available'|'unavailable'|'redacted'; localRef?: string;
   mimeType?: string; size?: number; sha256?: string; redacted?: boolean}` and
   update `parseActivityEvent` (`contract.ts:422`) to parse it as such instead
   of `redactedText(...)`. Do not build a fetch endpoint.

**Done when:** `npx tsc --noEmit` exits 0, all three suites still green, and no
rendering or resolution behavior has changed.

---

# Wave 2 — implementation, four parallel agents

All four start together once A1-1 lands.

## A2-A — Producer: activate the registry, extract network resources

**Owns:** `producer/src/paths.mjs`, new `producer/src/intent.mjs`.

Read plan T4 and A2, and Findings 1 and 3.

> **Update 2026-09-01:** `src/activity/parsers.ts` is deleted
> (`docs/roadmap.md` §5 T0-E, confirmed imported by nothing but its own test
> before removal). Step 1 below cannot literally port from it anymore — build
> `producer/src/intent.mjs` fresh around the live lexer at
> `producer/src/paths.mjs:112-200`, and use current intent tests for
> precedence-ordering and sanitization behavior. Step 2's "keep
> the better [lexer], delete the other" is also moot — `paths.mjs:112-200` is
> the only lexer left.

`src/activity/parsers.ts` (459 lines) was imported by nothing and duplicated
live logic in `paths.mjs`. Port its shape producer-side, where the raw payload
is still visible — the frontend can only ever parse what survived the
collector, which for URLs is nothing.

1. Port `ActivityParserRegistry`, `shellCommandParser`, `applyPatchParser`, and
   `genericActivityParser` into `producer/src/intent.mjs`. Preserve the
   precedence ordering, the fail-open `try/catch` around each parser, and
   `sanitizeIntent`.
2. Have `inferredActivityResources` (`paths.mjs:230`) delegate to the registry.
   **One shell lexer must survive, not two** — `paths.mjs:112-200` was, and
   remains, the live one.
3. Add a network parser recognizing `curl`, `wget`, `http`, `httpie`, `xh` in
   the existing segment walk. Emit:
   `{kind:"url", name:<hostname>, ref:<scheme://host/path>, action:"network",
   confidence:"exact", provider:<command>}`.
4. **Strip query strings, fragments, and `user:pass@` userinfo before emitting
   `ref`.** Query strings carry tokens and `redactString` will not reliably
   catch them. Cap `ref` at 512 and `name` at 256 (collector limits). Skip
   anything that is not an absolute `http:`/`https:` URL. Emit `name` even when
   the path is dropped — the host is the visualization key.
5. `PATH_KEYS` (`paths.mjs:4`) matches `uri` and routes it through
   `normalizeResourcePath`, which mangles a URL into a filesystem path. Exclude
   URL-shaped values from that branch before adding the new one.

**Done when:** producer tests cover a `curl` with a token in its query string
and assert the token never appears in the envelope; `curl a.com && curl b.com`
yields two distinct resources. **The collector needs no change for this** — if
you think it does, stop and report.

## A2-B — Frontend: accept external resources, fan out targets

**Owns:** `src/activity/contract.ts`, `src/activity/graphResolver.ts`,
`src/activity/reducer.ts`.

Read plan A3 and A5, and Finding 7.

1. `safeResource` (`contract.ts:219`): accept `name`, `ref`, `provider`, and
   `action: 'network'`. **Re-apply the same URL sanitation A2-A does** — the
   producer is untrusted from here. Do not assume it cleaned anything.
2. `activityType` (`contract.ts:430`): map `action === 'network'` → `'network'`.
3. `resolveActivityTarget` (`graphResolver.ts:270`): branch on
   `activityResourceDomain` **before** the path loop. A `web` resource returns
   `{kind:'group', id:webDomainGroupId(host), match:'external', ...}` and must
   never reach `activityTargetForResource` (`graphResolver.ts:147`), which
   unconditionally builds a project/directory/file path id.
4. Multi-target: the function currently returns on the first matching resource,
   so a command touching five files produces one ray. Return **all** validated
   targets, capped at 32/event. Populate `targets[]` and keep `target =
   targets[0]`.
5. Reducer: emit one pulse and one ray per target, respecting
   `MAX_ACTIVITY_RAYS` (128, `reducer.ts:6`).

**Done when:** a `curl` event resolves to a domain group target, and a
multi-file event produces multiple rays. **You should not need to touch the ray
construction logic at `reducer.ts:230-259`** — it already builds a
`groupId → target` ray whenever the bash group and a target both resolve. If you
find yourself rewriting it, stop and report.

## A2-C — Layout and render: the web sphere

**Owns:** `src/layout.ts`, `src/components/GraphCanvas.tsx`.

Read plan A3's layout bullet, A4, and Finding 4. **Finding 4 is marked obsolete
as of 2026-09-01 — read the note below before starting.**

You can build against hand-constructed `ActivityGroupSpec[]` fixtures before
A2-B lands. Do not wait.

1. `activityGroupSpecs` (`layout.ts:210`): emit a singleton root
   `group:activity:web` (`kind:'web'`, label `web`) plus one child per host
   (`kind:'domain'`, `parentId:'group:activity:web'`, label = hostname). Reuse
   `ACTIVITY_GROUP_TTL_MS` so domains fade like every other activity group.
2. **Obsolete as of 2026-09-01:** this step originally read "`withActivityGroups`
   (`layout.ts:324`) has three placement regimes, and the recursive `place()`
   walk (`layout.ts:383-399`) runs only inside `projects.forEach` ... extract
   that closure and share it." That premise no longer holds:
   `withActivityGroups` is now at `layout.ts:638`, and `place()` already
   recurses over every non-toolbox root (`layout.ts:643,756-786`), so a `web`
   root needs no extraction — it is placed automatically once it is added to
   `hierarchies`. Remaining work: place the web root in the operator layer near
   `activityToolY`, offset on X so it does not overlap the bash/tool row.
3. `GroupVolume` (`GraphCanvas.tsx:362-408`) emits `<boxGeometry args={[1,1,1]}/>`
   (`GraphCanvas.tsx:392`) for every group. Branch on `group.activity.kind`:
   `'web'` → `<sphereGeometry>` sized from `group.size`, `'domain'` → a small
   sphere, everything else unchanged. Keep the wireframe material and the
   existing opacity/TTL logic exactly as they are.

**Done when:** with fixture specs, a web sphere renders in the operator layer
with its domain children distributed inside it rather than piled at the origin.

## A2-D — Producer: tool outcomes (historical brief)

**Owns:** `producer/src/contract.mjs` and producer contract tests. Outcome
derivation is already implemented there; no separate outcomes module is
required.

Use `docs/copilot-payloads.md` and synthetic fixtures to verify available
typed event/hook fields. Do not capture, commit, or publish a live session
payload merely to check an event shape.

1. Derive only explicitly allowlisted and capped values such as `status`,
   `durationMs`, `count`, `bytes`, `exitCode`, and validated error codes.
2. Keep raw output, response bodies, free-text error messages, prompts,
   and credential-like strings out of all envelopes and summaries.
3. Exercise success, failure, missing-result, and secret-containing
   synthetic inputs in producer, collector, and frontend tests.

**Done when:** a synthetic secret placed in a tool result cannot appear
anywhere in the normalized envelope, and status/error metadata survives
the closed collector/frontend contracts.

---

# Wave 3 — join and surface

Starts after Wave 2 lands. A3-1 before A3-2.

## A3-1 — Retain completed tool calls

**Owns:** `src/activity/reducer.ts`, plus the `ActivityToolOutcome` type.

Read plan B3.

`reducer.ts:117-121` deletes tool state on completion, so nothing joins a call's
start intent to its outcome — "do things with the response" has nothing to hang
off.

1. Keep `activeTools` for in-flight calls.
2. Add `state.completedTools: Map<string, ActivityToolOutcome>`, bounded at 128
   with the same eviction style as `MAX_ACTIVITY_RAYS`.
3. `ActivityToolOutcome`: tool call id, tool, session, agent, `startedAt`,
   `endedAt`, `durationMs`, `status`, `count?`, `summary?`, and the resolved
   `targets` from the start event.
4. Join on `toolCallId`, which the producer already propagates
   (`contract.mjs:326`).

## A3-2 — Surface outcomes in the panel

**Owns:** `src/components/ActivityPanel.tsx`.

Show duration, count, and status on completed rows (`ActivityPanel.tsx:163`)
instead of dropping them when the tool leaves `activeTools`.

Do **not** drive ray or marker intensity from `count` in this pass. Verify
the typed data path with synthetic outcome fixtures first.

---

## Reporting format

Every agent reports:

1. **Files changed** — confirm they match your owned set. Flag any deviation.
2. **Verification** — the three commands above, with before/after counts.
   Paste real output; do not summarize as "tests pass".
3. **Contract changes** — any field added to either allowlist, named explicitly.
4. **Assumptions** — anything you inferred rather than verified.
5. **Blocked or skipped** — what you did not do and why. Scaling scope down is
   the human's call, not yours.

If your change makes an event shape newly valid or newly invalid, say so
loudly. That is the failure mode this whole plan exists to prevent.
