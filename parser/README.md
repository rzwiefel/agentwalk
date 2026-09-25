# Agentwalk parser adapters

This directory contains the integrated non-Clojure parser stack. Clojure remains
powered by the clj-kondo analyzer under `src/codewalk/`; Python, C#, and
TypeScript/JavaScript adapters emit a language-neutral IR that the dispatcher
normalizes and projects into the same portable graph shape for the viewer.

## Pipeline

```text
native adapter -> shared IR normalization -> graph-v2 projection -> API/viewer
```

The dispatcher is `parser/orchestration/dispatcher.py`. It performs language
detection, starts exactly one native adapter subprocess per analysis, validates
the shared IR, and emits deterministic `formatVersion: 2` graph JSON. The
Clojure API starts the dispatcher with bounded request/output limits and maps
its result to the HTTP contract. See `parser/backend/README.md` for that
boundary.

## Shared contract

Every adapter exposes, directly or through normalization:

- supported file extensions and repository/package boundaries;
- deterministic node identity for files, namespaces/modules, and symbols;
- source locations and optional documentation/signature metadata;
- resolved and unresolved relationships with confidence/provenance;
- occurrence-level evidence with file and line/column spans;
- ownership and invalidation metadata for changed files;
- parser/runtime dependencies and graceful diagnostics.

The normalized vocabulary maps common concepts into the existing Agentwalk graph:

| Concept | Normalized representation |
| --- | --- |
| module, namespace, package | `namespace` node |
| function, method, class, type, variable | `var` node with metadata |
| import, using, require | `requires` edge |
| function/method invocation | `calls` edge |
| type/member/reference usage not modeled as a call | `mentions` edge |

Language-specific relationships such as inheritance, implementation, exports,
overrides, and containment should be recorded as extension facts first. They
must not be silently collapsed into `calls` or `requires`. Unresolved symbols
should remain representable as external nodes when the adapter can identify
the target, and unresolved references should carry diagnostics rather than
being dropped without explanation.

## Adapters

- **Python:** stdlib AST extraction with package/module ownership, definitions,
  imports, calls, mentions, containment, and conservative resolution.
- **C#:** Roslyn/MSBuild semantic loading of solutions/projects, namespaces,
  types, members, using directives, inheritance, overrides, and calls.
- **TypeScript/JavaScript:** TypeScript compiler API project loading with
  `tsconfig`/`jsconfig`, package boundaries, aliases, JSX, imports/exports,
  functions/classes/methods, and semantic calls.

The adapters currently perform correctness-first full analysis for each uncached
revision. Their incremental metadata is used for Git change mapping and future
invalidation/caching work; it must not be described as partial parsing.

## Commands

From the repository root:

```sh
python3 -B -m parser.orchestration.dispatcher capabilities /path/to/repo
python3 -B -m parser.orchestration.dispatcher analyze /path/to/repo --adapter python
python3 -B -m unittest discover -s parser/conformance/tests -p 'test_*.py'
```

Install/build requirements and adapter-specific commands are documented in the
README in each adapter directory. The current parser test surface includes the
Python, conformance, projection, orchestration, TypeScript, and C# fixture
suites.
