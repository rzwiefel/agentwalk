# TypeScript/JavaScript parser adapter

This directory is a self-contained semantic parser adapter for Agentwalk. It
uses the TypeScript compiler API to load a `tsconfig.json` or `jsconfig.json`,
honor `extends`, `allowJs`, JSX, `baseUrl`, `paths`, package manifests, and
TypeScript module resolution. With no project file it discovers supported
source files and runs in a portable degraded mode.

## Usage

```sh
npm install
npm test
npm run golden
```

After `npm run build`, the public package entry point is `dist/index.js` and
exports `analyzeProject({ rootDir, projectFile?, mode?, previous?,
changedFiles? })`. The TypeScript source entry point is `src/index.ts`.
Supported source extensions are `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`,
`.mjs`, and `.cjs`.

The IR in `src/ir.ts` deliberately does not import Agentwalk's shared graph
schema. It represents modules/packages as `namespace` nodes and declarations
as `var` nodes, with `requires`, `calls`, `mentions`, `extends`, `implements`,
`exports`, `reexports`, `overrides`, and `contains` relationships. Every
relationship has resolution (`resolved`, `external`, `ambiguous`, or
`unresolved`), confidence, provenance, and a repository-relative evidence
span. Nodes retain definition/reference occurrences. JSX mentions distinguish
intrinsic tags from components. Diagnostics are kept instead of being
silently discarded.

IDs are based on normalized repository-relative module paths, package names,
declaration names, and declaration offsets. Nodes, edges, diagnostics, and
ownership are sorted before returning, so the graph is repeatable across
runs. Incremental mode reports changed files, reverse-require invalidation,
and per-file ownership; the current adapter still rebuilds one compiler
`Program`, which provides correctness/convergence evidence without claiming
incremental performance.

## Parser comparison

| Option | Strength | Limitation | Decision |
| --- | --- | --- | --- |
| TypeScript compiler API | Authoritative checker, module resolution, JSX, declarations, diagnostics, and direct project-config support | Low-level traversal and explicit caching required | **Chosen** |
| ts-morph | Ergonomic wrapper around the compiler API | Extra abstraction/dependency; still requires project lifecycle decisions | Good future convenience layer |
| Tree-sitter | Fast concrete syntax and excellent error recovery | No TypeScript type checker or reliable package/module semantics by itself | Possible syntax fallback |
| `tsserver`/project service | Editor-grade project discovery and incremental graph updates | Protocol/process lifecycle and editor-oriented abstractions | Consider for a long-lived daemon |
| Babel parser | Broad syntax and ESTree-style tooling | Type information and resolution are intentionally absent | Not sufficient as primary parser |
| SWC | Very fast parsing/transforms | Type/reference resolution is not its core contract | Possible fast pre-scan |
| typescript-eslint parser | Mature ESTree conversion and optional checker services | Lint-oriented AST shape; graph-specific relationships still need extraction | Useful interoperability option |

The compiler API therefore gives the best semantic accuracy for this
integration. The current adapter builds a complete compiler `Program` for each
uncached analysis. A future daemon can use `createIncrementalProgram` or a
project service while preserving this adapter's IR.

## Fixtures and checks

`fixtures/workspace` covers package boundaries, workspace metadata, path
aliases, ESM/CommonJS, named/default imports, exports/re-exports, classes,
functions, methods, interfaces/types, inheritance, implementation, override,
resolved/external/unresolved calls and references, JavaScript, `.mjs`/`.cts`,
and JSX intrinsic/component tags. `fixtures/golden.json` stores the SHA-256
golden for the normalized graph. Tests check repeatability, golden stability,
source-span slicing, semantic relationship kinds/statuses, diagnostics,
ownership, and full-vs-incremental convergence.

## Read-only validation

Use `npm test` and the checked-in `fixtures/workspace` as the reproducible
coverage baseline for package boundaries, JSX, path aliases, JavaScript, and
CommonJS. For an authorized external project, call `analyzeProject` with its
root and project file from the Agentwalk checkout; do not install packages or
write generated output into the target without permission. Compare output
against the fixture contract instead of publishing target-specific paths,
revision identifiers, diagnostics, or project inventory. Unresolved asset
imports and package types are represented explicitly rather than causing
analysis to fail.

## Integration boundary

The Agentwalk dispatcher invokes the compiled adapter through
`parser/orchestration/typescript_adapter_bridge.mjs`, then translates the IR
through `parser/shared/ir.py` and `parser/projection/graph_v2.py`. Resolution,
confidence/provenance, occurrence spans, diagnostics, and extension
relationships remain in the adapter-owned IR. Only native `requires`, `calls`,
and `mentions` become graph-v2 edge categories.

Use compiler project boundaries as analysis units and do not infer cross-package
edges solely from import text. The current revision endpoint fully reparses
uncached snapshots; ownership and invalidation metadata provide the boundary
for future incremental program caching.

## Dependency and runtime

The adapter pins TypeScript `5.8.3` (Apache-2.0) and
`@types/node` `22.15.21` (MIT, development-only). Runtime requirement is
Node.js `>=18`; the observed validation runtime was Node `v25.5.0`. If a
config cannot be read or a module cannot be resolved, the adapter reports
diagnostics or explicit unresolved/external placeholders and continues with
the rest of the project.
