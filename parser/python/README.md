# Agentwalk Python parser adapter

This adapter emits `codewalk.python.ir` format version 2 under `parser/python/`
and is integrated through the shared dispatcher without changing Agentwalk's
flat graph schema. It is a deterministic,
repository-relative intermediate representation:

- Modules and packages are `namespace` nodes; functions, async functions,
  methods, classes/types, and variables are `var` nodes.
- Imports become `requires`; invocations become `calls`; type, member, and
  other reference use becomes `mentions`. `inherits`, `implements`, `contains`,
  `overrides`, and `exports` retain semantic detail that the flat visualizer graph cannot
  represent directly.
- Every relationship carries `resolved`, `external`, `ambiguous`, or
  `unresolved` state, a confidence score, engine/version provenance, and
  occurrence IDs. Occurrences contain normalized repository-relative POSIX
  paths, 1-based lines, 0-based columns, and the exact source slice.
- Declaration IDs use module plus semantic containment and name (with a
  deterministic ordinal for duplicate names), never source line or absolute
  path. Each declaration also carries a content fingerprint and container
  chain; moving a declaration keeps its ID while changing its body changes the
  fingerprint.
- Variable extraction is intentionally bounded: module assignments, class
  assignments, and annotated declarations are retained. Unannotated transient
  locals inside functions are omitted unless they are themselves declarations
  such as nested functions or classes.
- Namespace ownership is always the containing Python module for declarations,
  including nested members. External and unresolved references retain a
  non-empty namespace identity where one can be inferred. This matches the
  graph-v2 layout contract, which groups every non-namespace node by its
  `namespace` field; namespace anchors expose the same field as their module or
  package name.
- IDs are based on normalized module and qualified-symbol names, never absolute
  paths. Source roots are explicit with `--source-root`; otherwise existing
  `src`, `lib`, or `python` roots are preferred, falling back to the repository
  root. Package names follow `__init__.py` boundaries.
- Incremental input accepts `changed`, `added`, `deleted`, and `renamed` records.
  The current adapter conservatively reparses all selected files and reports
  changed-file ownership, dependent invalidation, deletes, and renames. This
  guarantees full/incremental convergence before a cache is introduced.

## Engine comparison and runtime

| Option | Strengths | Limitations for this adapter |
| --- | --- | --- |
| `ast` (selected) | Python stdlib, stable syntax tree, exact spans, no install | Name resolution is conservative and does not execute imports |
| LibCST | Lossless concrete syntax and safer codemods | Third-party dependency; semantic resolution still needs another engine |
| tree-sitter | Fast incremental parsing and broad language coverage | Python bindings/grammar packaging and semantic layer add operational cost |
| Jedi 0.19.2 (MIT, optional) | Practical Python inference and goto/definition results | Heuristic inference; environment-dependent imports |
| Pyright 1.1.390 (MIT, optional) | Strong static typing and import resolution | Node/Python service runtime and project configuration required |

Validation uses Python 3.14.5 and the stdlib engine only; Jedi, LibCST,
tree-sitter, and Pyright were not installed. The adapter gracefully degrades
to syntax extraction and marks uncertain relationships rather than failing.
The committed package metadata is MIT and requires Python >=3.10. No generated
files, caches, virtual environments, vendored code, or build directories are
selected.

## Commands and checks

From the repository root:

```sh
python3 -B -m unittest discover -s parser/python/tests -p 'test_*.py'
python3 -B parser/python/python_parser.py --repo-root parser/python/fixtures --source-root .
```

The fixture suite checks deterministic repeated runs, occurrence span slicing,
package/source-root boundaries, resolution states, and full-vs-incremental
convergence. `parser/python/fixtures/golden.json` is the normalized fixture
output.
