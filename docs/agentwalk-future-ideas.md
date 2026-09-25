# Agentwalk future ideas

This is an aspirational roadmap, not the current implementation contract.
Live Activity is the primary view and Architecture remains supported as a
secondary mode. For current behavior, setup, parser limitations, and known
issues, see [`../PROJECT_BRIEF.md`](../PROJECT_BRIEF.md) and
[`../README.md`](../README.md). Some ideas below may already be implemented;
check those current references before treating a proposal as unfinished.

Ideas are tagged **[HIGH]** (high-confidence, verified against code),
**[MED]** (needs validation), or **[SPEC]** (speculative/ambitious).

---

# 1. What Agentwalk could become beyond a map

A map answers *"what exists"*. The valuable product answers *"what should I do"*. Four identities, in order of practical payoff:

1. **A change-decision instrument** — "I'm about to touch `codewalk.graph`. What's the blast radius, what co-changes with it historically, which tests cover it, who reviews it?" This is the highest-ROI direction and reuses existing graph and history capabilities.
2. **A narrative/onboarding tool** — a recorded, replayable, shareable guided tour could present an ordered list of camera poses, selections, filter lenses, and narration through an architecture graph.
3. **An architecture conformance feature** — a future `.codewalk/architecture.edn` manifest could declare layers and allowed edges, with a report and rendered before/after image. Any CI integration or command surface is a future design decision; neither is part of the current setup.
4. **A static/dynamic reconciler** — overlay actual runtime behavior on the static graph. Divergence is where the interesting bugs live.

**Design principle to adopt now:** every visual claim must be *traceable to a source line*. If a namespace glows red, one click should list the exact `file:line` evidence. This constraint alone will keep the tool honest and prevent it from becoming a "pretty scores" toy.

---

# 2. Visualizations

## 3D (the main stage — reserve it for things that genuinely benefit from space)

| Concern | Encoding | Notes |
|---|---|---|
| **Topology** | *Altitude = topological rank* in the requires DAG. Layers become literal strata. | Upward edges = layering violations, glow red. Instantly legible. **[HIGH]** |
| **Communities** | Convex hulls / floor "territory" tiles under detected clusters, categorical hue | Compare against your existing hierarchy volumes → mismatch *is* the insight. **[HIGH]** |
| **Cycles** | Render the SCC as a physical ring/torus binding members, with the minimum feedback arc set highlighted as "the strand to cut" | Actionable, not just diagnostic. **[MED]** |
| **Coupling** | Hierarchical edge bundling along the existing hierarchy skeleton; thickness = call count | Biggest clutter win at scale. **[HIGH]** |
| **Change propagation** | Flood-fill pulse outward from a node, delay ∝ hop count, intensity ∝ decayed weight | Natural extension of your shockwaves. **[HIGH]** |
| **Ownership** | Hue of hierarchy volume = dominant author; translucency/"cracks" = low bus factor | Use sparingly; ownership viz gets political. **[MED]** |
| **API surface** | Public vars as protrusions on the namespace shell; private vars inside the volume; external consumers dock to the shell | Makes "this namespace has a 90-var public API" viscerally obvious. **[MED]** |
| **Tests** | Test namespaces as a translucent scaffold layer above; coverage as a **waterline** filling each ns volume | Great metaphor, needs coverage data (cloverage/kaocha). **[MED]** |
| **Runtime** | Emissive glow from real invocation counts; color temp = latency; red sparks at exception sites | **[SPEC]** but the "wow" feature. |
| **History** | Sedimentary "growth rings" mode — time as a literal axis; ghost trails of deleted namespaces | **[SPEC]** |

## 2D panels (where 3D is objectively worse — don't fight this)

- **DSM (Dependency Structure Matrix)**, partition-sorted. This is *the* correct view for layering and cycles; blocks below the diagonal = violations. 3D will never beat it. **[HIGH]**
- **Ranked table** with sparklines, percentile columns, raw counts. Sortable. This is what people actually use to make decisions.
- **Scatter plots**: fan-in × fan-out quadrants (utility / hub / leaf / orphan); Martin's Instability × Abstractness with the main sequence drawn; churn × complexity hotspot 2×2.
- **Temporal co-change matrix** (namespace × namespace, colored by lift).
- **Chord/arc diagram** for a single selected community's internals.
- **Treemap** of the hierarchy by LOC or churn — good for "where is the mass".
- **Commit timeline with subsystem lanes** — replaces/augments the scrub bar.
- **Distribution histogram in the legend** so users see whether "hot" means outlier or median.

## Linked views [HIGH]

One shared selection/hover/filter model. Brush in the scatter → highlights in 3D → filters the table. Encode the full view state (lens, filters, selection, camera, revision) in the URL so views are shareable and bookmarkable. This is cheap and multiplies the value of every panel.

---

# 3. Algorithms next

**Community detection** — Leiden (or Louvain) on the undirected weighted projection; Infomap if you want flow-based semantics, which fits directed dependency graphs better. Cheap alternative: label propagation. **The payoff isn't the clusters, it's the *diff* against the namespace-prefix hierarchy**: "`codewalk.physics` clusters with `codewalk.layout`, not with its siblings" → concrete rename/move suggestion. **[HIGH]**

**Cross-community coupling** — modularity Q, per-community conductance, community-level DSM, edge-betweenness to find bridge edges. **[MED]**

**Boundary detection** — normalized cut / min-cut between candidate module seeds to propose extraction seams ("these 11 namespaces could become a library; 4 edges cross the boundary"). **[MED]**

**Temporal change coupling** — from git: for each namespace pair, support/confidence/**lift** over co-occurrence in commits, Jaccard over commit sets, plus lagged coupling (A changes, B changes within N commits). Then: **hidden coupling = high co-change with *no* static edge**. That's the single most valuable derived signal in this whole list — it finds coupling static analysis structurally cannot see (keyword-driven registries, re-frame, config, protocol implementations). **[HIGH]**

**Centrality** — add **PageRank on the reversed edge direction** ("how much does the codebase depend on this?") and **harmonic closeness** (works on disconnected graphs, unlike closeness). HITS gives you hubs (aggregators) vs. authorities (utilities) for free. These are cheaper, more stable, and more intuitive than betweenness. **[HIGH]**

**Blast radius** — forward (what I break) and reverse (what breaks me) transitive closure with hop decay; probabilistic variant where edge weight → propagation probability; compute at var level for precision, aggregate to namespace for display. **[HIGH]**

**Cycles** — SCC (you have it) + **approximate minimum feedback arc set** (Eades–Lin–Smyth is ~20 lines and near-linear) to answer *"cut these 3 edges and the 18-namespace tangle becomes a DAG."* Optionally Johnson's simple-cycle enumeration, hard-capped. **[HIGH]**

**Instability / abstractness** — Martin's `I = Ce/(Ca+Ce)`, `A =` (protocols + multimethods + specs) / total vars, `D = |A + I − 1|`. Clojure-appropriate and far more defensible than an ad-hoc "risk" blend. **[HIGH]**

**Cohesion** — build the intra-namespace var call graph and count connected components. `n > 1` is a direct, evidence-backed "this namespace should be split into n" signal, with the exact var partition to show. Much better than LCOM ports. **[HIGH]**

### Caveats to state explicitly in the UI

- Static analysis misses **multimethods, protocol dispatch, `resolve`/`requiring-resolve`, macro-generated calls, dynamic vars, `.cljc` reader conditionals**, and data-driven wiring (Integrant/Component/re-frame/routes). Clojure is *unusually* prone to this — a Clojure-focused tool must say so.
- Betweenness is approximated by source sampling; sampled values are not comparable across graphs.
- Co-change is correlation. High lift may mean "these two files are both touched during releases," not coupling.
- **Utility namespaces get betweenness ≈ 0** because they're sinks, despite being the most critical code in the repo. Never present betweenness alone as "importance."

---

# 4. Interactive engineering workflows

- **Revision compare** — pick two refs, diff nodes/edges/metrics, produce an "architecture drift report": new cycles, changed instability, moved namespaces, new cross-layer edges. Pairs perfectly with your existing per-commit graph machinery. **[HIGH]**
- **Namespace dossier** — one page: docstring, public API, deps in/out *with reasons*, metrics with percentile + distribution, churn, top authors, covering tests, cycle membership, co-changed peers, recent commits. This becomes the artifact people paste into PRs. **[HIGH]**
- **Explain connection** — "why does A depend on B?" → enumerate every concrete edge with `file:line` and the minimal edge set whose removal severs it. Requires evidence lists from the analyzer (see §8). **[HIGH]**
- **Path finding** — shortest and all-paths-≤-k between two namespaces, with an animated camera flight along the path. Great for demos *and* debugging.
- **What-if cuts** — mark edges/namespaces as removed, recompute live: "SCC drops from 18 → 4; `codewalk.app` instability 0.9 → 0.6." Sandbox refactors before writing code. **[MED]**
- **Refactoring candidate queue** — a ranked, dismissible list (split candidates from cohesion, cycle breaks from MFAS, hidden coupling, god-namespaces, dead code), each with evidence and a "why this was flagged" trace. Dismissals persist. **[MED]**
- **Search/query** — a small filter DSL (`ns:codewalk.* fanout:>10 cycle:true churn:p90`) with saved queries; a Datalog-flavored variant would delight the Clojure audience. **[MED]**
- **Annotations / bookmarks / saved views** — markdown notes pinned to nodes *and* to points in 3D space; a future repository-managed `.codewalk/` location could make them reviewable and team-shared.
- **Guided tours** (see §1) with export to GIF/MP4 and a shareable link. **[HIGH]**
- **Exports** — PNG/SVG/MP4, Graphviz/Mermaid, DSM CSV, metrics JSON, Markdown report, ADR stub, PR-comment bot.
- **Editor round-trip** — click node → `vscode://file/...` or `emacsclient`; and a tiny local endpoint so the editor can say "focus the namespace I'm currently in." Very small effort, disproportionate daily value. **[HIGH]**

---

# 5. Communicating heat / bridge / risk without overclaiming

**Language.** "Signals," "candidates," "worth reviewing." Never "violations," "debt score," "health grade," or a single overall number. One aggregate score invites gaming and destroys trust the first time it's wrong.

**Every score ships with four things** — raw counts, percentile rank *within this repo*, a contribution breakdown ("degree 61%, weighted 13%, bridge 26%"), and clickable `file:line` evidence. If you can't produce evidence, don't show the score.

**Confidence tiers by evidence type** (this maps directly onto your edge kinds):

- `requires` → high confidence, solid lines
- `calls` → high confidence, solid
- `mentions` (qualified keywords) → **low** confidence, dashed/translucent
- co-change inference → medium, distinct dotted style + explicit "statistical" label

**Encoding budget.** Max **two** simultaneous quantitative encodings per element. Color = the active lens; size = a *stable* structural property (var count) that never changes with the lens, so spatial memory survives lens switching.

**Motion discipline.** Animate *events* (a change landed, selection, propagation), never steady-state magnitude. A permanently pulsing "risky" node is exhausting and gets ignored within a day. Your existing 6s relationship fade and staggered reveals are the right pattern — keep motion transient.

**Color.** Single-hue sequential (viridis/magma) for magnitudes; diverging only for signed deltas (revision compare); categorical capped at 8–12 with Okabe–Ito for communities. No rainbow for continuous values. Ship a colorblind-simulation toggle.

**Legend.** Always visible, reflects the *current* lens, shows the actual value range, a mini-histogram of the distribution, and a "?" popover with the formula and its caveats (including "betweenness sampled from 200 sources").

**Overload avoidance.** One lens at a time (Off / Connected / Risk / Churn / Ownership / Coverage). Default the graph to `requires` only; `calls` and `mentions` are opt-in. Dim-others on focus. Distinct gray for "no data" — never render unknown as zero.

---

# 6. Large-repository scaling

**Split the work correctly.** Metrics belong in Clojure, computed once per revision, cached by tree SHA, shipped inside the graph JSON as precomputed scores. The browser should only re-*filter* and re-*rank*, never re-run Brandes. Add `/api/metrics?ref=`. **[HIGH]**

**Transport is your near-term wall.** Node IDs like `"calls:codewalk.graph/build-node->codewalk.types/x"` dominate payload size. Intern to integer indices + a string table; gzip. Expect 5–10× reduction. **[HIGH]**

**Caching.** Per-file content-hash analysis cache (clj-kondo already has `.cache`), revision cache keyed by tree SHA, persisted under `.codewalk/cache/`. Second run of history playback should be instant. Your `incremental-graph-at` is already the right shape — persist its output. **[HIGH]**

**Progressive loading.** Ship the *namespace-level* graph first (small, fast, sufficient for 90% of questions); load var/keyword nodes lazily per expanded namespace. This is the single biggest scaling lever and it also improves the default UX. **[HIGH]**

**Workers.** Metrics, layout, and history-frame precomputation in a worker; transfer positions as `Float32Array`. Rewrite Brandes over integer-indexed typed arrays (`Int32Array` distances/paths, `Float64Array` deltas, flat CSR adjacency) instead of `Map<string, …>` — currently you allocate 4 maps × N entries × 200 sources per recompute. Expect 10–50×. **[HIGH]**

**Rendering.** `InstancedMesh` for nodes; a single merged `LineSegments2` with per-vertex color for edges (never per-edge objects); GPU color-picking render target instead of raycasting thousands of meshes; distance-based LOD (far = hierarchy volume with aggregate color only → mid = namespaces → near = vars/keywords/labels); label declutter with priority = current metric; aggregate cross-package edges into one thick bundle with a count badge. **[HIGH]**

**Stable layout.** Compute layout **once at HEAD** and reuse it for every revision in playback — animate only appear/disappear, never re-solve. Seed positions from a hash of the namespace path so results are deterministic across runs and machines; optionally persist `.codewalk/layout.json` so team screenshots match. **[HIGH]**

**Sampling.** Prefer PageRank/harmonic closeness (cheap, stable, incremental-friendly) over betweenness as the default centrality; keep sampled betweenness as an opt-in with a visible caveat, and rescale by `n/|S|` if you ever compare across graphs.

**Small landmine:** `Math.max(...array)` (used three times in `namespaceMetrics.ts`) throws on ~100k+ arguments. Use `reduce`. **[HIGH]**

---

# 7. Prioritized roadmap

### Next 3 small (days each, high confidence, high value)

1. **Metric correctness + explainability pass.** Fix the normalization mismatch, exclude phantom keyword namespaces, split SCC/betweenness onto `requires`-only, add percentile ranks + raw counts + contribution breakdown + distribution histogram in the inspector/legend. (Details in §8.) Low effort, directly protects trust in the feature you just shipped.
2. **Edge evidence + multiplicity.** Have the analyzer emit occurrence `count` and an evidence list (`file:line`) per deduped edge. This single change unlocks real weighting, the "explain connection" panel, and honest confidence tiers — it's the highest-leverage data-model change available.
3. **Memoize + worker-ize metrics, typed-array Brandes, freeze metrics during playback.** Removes the stutter risk that will otherwise appear the moment someone points this at a real repo.

*Bonus smalls:* `requires`-only lens toggle; reverse-PageRank as a third connection mode (cheaper and more intuitive than betweenness); editor `file:line` jump links.

### Next 3 medium (1–3 weeks each)

1. **Temporal change coupling + hotspots.** Co-change lift, hidden-coupling detection (co-change with no static edge), churn × complexity 2×2. You already fetch the git data; this is mostly analysis + one 2D panel. Highest insight-per-line-of-code in the list.
2. **Community detection + hierarchy drift report + DSM panel.** Leiden clustering, compare to namespace prefixes, surface "misplaced namespace" candidates. Ship the partition-sorted DSM alongside — it's the view engineers will screenshot.
3. **Blast radius + what-if cuts + minimum feedback arc set + revision compare.** The "decision instrument" bundle. Turns Agentwalk from observation into planning.

*Bonus mediums:* guided tours + saved views + shareable URL state; namespace dossier page.

### Ambitious / longer term

- **Architecture conformance** — `.codewalk/architecture.edn` declaring layers and allowed edges, a proposed `codewalk check` command, and a pull-request report with a rendered drift image. CI integration is a future design decision; no workflow is selected or configured. **[SPEC but highest strategic value]** — this is what could make the tool load-bearing.
- **Runtime overlay** via OTel / `tap>` / nREPL instrumentation: real call counts, latency, exception sites. Static-vs-dynamic divergence finds dead code and surprise hot paths. **[SPEC]**
- **Multi-repo system view** — multiple repositories in one space, with
  cross-repo namespace relationships and shared-library blast radius.
  Repository identities should remain opt-in and local. **[SPEC, high value]**
- **4D history**: true time-axis scrubbing, growth rings, auto-narrated evolution video. **[SPEC]**
- **Evidence-constrained LLM narration** — dossiers and PR risk summaries generated *only* from graph facts, every claim citing `file:line`. Useful; dangerous without the citation constraint. **[SPEC]**
- **Collaborative sessions** (shared camera/cursor) for architecture reviews, and eventually VR walkthroughs. Genuinely on-theme for the "walk" metaphor, but do it last — lowest practical ROI. **[SPEC]**

---

# 8. Review: likely issues & false positives in `namespaceMetrics.ts`

### Correctness bugs

**A. Degree normalization mismatch — no namespace can ever score 1.0. [HIGH]**

`maxDegree` is computed as `max(outgoing.size + incoming.size)` (a *sum*), but `degree` is the *union* set size. Any reciprocal dependency in the max-degree namespace makes the ceiling unreachable, and namespaces with many bidirectional partners are systematically deflated relative to the scale. **Fix:** compute `maxDegree` as the max union size, over the same quantity you're normalizing.

**B. Phantom namespaces from qualified keywords. [HIGH]**

`analyzer.clj` sets keyword nodes' `:namespace` to the keyword's *qualifier* (`:db/id` → `"db"`, `:http/status` → `"http"`). These become first-class vertices in the metrics graph. Consequences: `maxFanOut` and `maxDegree` are inflated by non-code entities; every namespace using spec/malli/Datomic keywords gets fan-out credit for vocabulary, not dependency; and `overdependency` partially measures "uses lots of qualified keywords." Worse, keyword nodes are `:external false`, so **"Show library references = off" does not remove them.** **Fix:** only treat the keyword's qualifier as a namespace vertex when it matches a known code namespace; otherwise model it as a separate "concept" entity in a separate lens.

**C. Unqualified keyword mentions are silently dropped.**

Their `namespaceForNode` returns `undefined`, so the pair is skipped. Net effect: the `mentions: 1` weight only ever fires for qualified keywords. Not wrong, but the weight table implies broader coverage than reality.

**D. `Math.max(...)` spread** — three sites, will throw on very large graphs. Use `reduce`.

### Metric design issues

**E. Multiplicity is completely lost. [HIGH]**

`analyzer.clj` dedupes `calls` edges by `[source target]`, and `namespaceMetrics` further dedupes to a directed pair with a `Set<EdgeKind>`. So a pair with 400 calls and a pair with 1 call are **identical** (weight 2). Weighted degree therefore ranges only over {1..6} × degree — it is ~95% collinear with `degree`, meaning `connectedness ≈ 0.75·degree + 0.25·betweenness` and the 0.20 weighted term is nearly decorative. **Fix:** emit occurrence counts from the analyzer and use `log1p(count)` weighting.

**F. Weighted degree double-counts and conflates direction.** The same pair weight is added to *both* endpoints, so it's neither in- nor out-flavored, and it's counted twice globally.

**G. Mixing `mentions` into the SCC/betweenness graph badly inflates cycles. [HIGH]**

Keyword-mention edges are weak, near-ubiquitous, and (via shared vocabularies) tend to merge large regions into one giant SCC — at which point `cycleSize > 1` becomes almost universal and the 0.15 cycle term degenerates into a constant offset. It also warps betweenness by creating shortcut paths that don't represent real dependency. **Fix:** compute SCC and betweenness on `requires` only (optionally `requires + calls`), and report cycles per edge-kind layer.

**H. Binary cycle penalty.** A benign 2-cycle scores the same as a 40-namespace tangle. **Fix:** `min(1, log2(sccSize) / log2(maxSccSize))`, and label 2-cycles distinctly (they're often legitimate protocol/impl or `.cljc` pairs).

**I. Fan-out is the wrong proxy for "overdependency." [HIGH]**

Aggregator namespaces (`app`, `system`, `core`, `routes`, `main`) are *supposed* to have high fan-out — that's their job. Your demo result (`codewalk.app` = highest risk) is technically correct and architecturally uninteresting; users will notice. **Fix:** use Martin's instability `I = Ce/(Ca+Ce)` plus distance from the main sequence; compare fan-out against a *peer group* (same hierarchy depth / same community); and add the genuinely dangerous pattern — **high fan-in × high churn = fragile hub** — which the current formula doesn't capture at all.

**J. Sinks are invisible to betweenness. [HIGH]**

Leaf utility namespaces (the most depended-upon code in most repos) have betweenness ≈ 0 and are actively de-emphasized by both formulas. Add reverse-PageRank or fan-in percentile so "critical because everything depends on this" is representable.

**K. `includeExternal = true` changes the question being asked.** External namespaces are pure sinks (no analyzed definitions), so including them makes `fanOut` mostly "how many libraries do I use," which is a different — and much less actionable — metric than internal coupling. Separate "internal coupling" from "external dependency surface" rather than folding them into one score.

**L. Max-normalization is outlier-fragile.** One extreme namespace compresses everyone else toward zero, and colors go flat. **Fix:** rank-percentile or robust scaling to p95, with raw values always displayed.

**M. Betweenness sampling is alphabetically biased.** `index % ceil(n/200)` over a `.sort()`ed list samples in package-name blocks — whole subsystems are systematically included or excluded. **Fix:** deterministic seeded shuffle (or degree-stratified pivots à la Brandes–Pich), and rescale by `n/|S|`.

**N. Magic weights, no provenance.** 0.55/0.20/0.25 and 0.55/0.30/0.15 combine incommensurable units with no stated rationale. **Fix:** show per-component contributions in the inspector, make the weights adjustable, and demote the composite — lead with per-metric ranks, offer the blend as an optional "overall" lens.

**O. No memoization.** `buildNamespaceMetrics` is O(|S|·(V+E)) with heavy `Map` allocation. If it re-runs per history frame during playback, expect stutter on real repos. Memoize by `(graph identity, includeExternal)`; freeze metrics at HEAD during playback or debounce recomputation.

**P. Self-links dropped loses cohesion signal.** Correct for coupling, but intra-namespace structure is where the split-candidate signal lives — compute it as a separate cohesion metric rather than discarding it.

### Suggested revised scoring shape

- **Connectedness** → `0.4 · pct(log1p(weightedDegree)) + 0.35 · pct(reversePageRank) + 0.25 · pct(betweenness_requires)` — decorrelated, and finally represents utility sinks.
- **Risk** → `0.35 · pct(instability × churn) + 0.25 · pct(fanOut within peer group) + 0.25 · cycleSeverity(log-scaled, requires-only) + 0.15 · pct(fanIn × churn)` — captures both "depends on too much" and "too many depend on this volatile thing."
- Present both as **percentile ranks with visible components and clickable evidence**, never as a bare 0–1 number.
