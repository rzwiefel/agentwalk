# Shared parser IR contract

`codewalk.parser.ir/1` is the executable interchange boundary for parser
adapters. The canonical JSON is emitted by `parser/shared/ir.py` and described
by `parser/shared/schema.json`. The runtime uses only Python 3.10+ standard
library modules.

## Contract policy

- IDs are SHA-256-derived from semantic keys containing normalized repository
  relative paths, never an absolute checkout path. Nodes, relationships,
  occurrences, files, packages, projects, diagnostics, and ownership are
  deterministically sorted.
- Paths are POSIX and repository-relative. Absolute paths, drive/UNC paths,
  backslashes, and `..` traversal are rejected with a contract error.
- Canonical lines are 1-based and columns are 0-based. Offsets and native
  columns remain explicitly declared per file: Python AST uses UTF-8 byte
  offsets/columns; Roslyn and the TypeScript compiler API use UTF-16 code-unit
  offsets/columns. Unicode-scalar coordinates can be declared by another
  adapter, but are never guessed or silently converted.
- Repository metadata contains source, package, and project roots. Files carry
  ownership metadata, language, status, and coordinate policy. Nodes carry
  semantic kinds, containers, spans, visibility/export flags, and occurrence
  counts.
- Relationships preserve their native `kind`, resolution status, confidence,
  provenance, occurrence IDs/counts, and structured target references.
  `category` is present only when the native kind is exactly `requires`,
  `calls`, or `mentions`. No inheritance, implementation, export/re-export,
  override, containment, type-reference, project-reference, or JSX edge is
  relabeled as a category.
- External and unresolved targets are represented by deterministic placeholder
  nodes plus `target_ref` (`status`, `name`, optional semantic kind/package,
  and candidate IDs). Ambiguous references retain all candidates.
- Diagnostics are recoverable by default. A recoverable compiler/parser error
  produces `analysis.result_status = "partial"` while
  `analysis.invocation_status` remains `"success"`. A fatal invocation or fatal
  diagnostic produces `"fatal"` for both and sets `analysis.fatal = true`.
- Full and incremental metadata include changed, deleted, and invalidated
  repository-relative files and per-file node/relationship ownership. A
  conservative adapter can report full reparse while retaining incremental
  provenance.

## Adapter translation ledger

The normalizer preserves these native facts; the optional CodeGraph-v2
projection is intentionally narrower.

| Adapter | Native facts retained | Category projection |
| --- | --- | --- |
| Python `codewalk.python.ir` v2 | `requires`, `calls`, `mentions`, `inherits`, `implements`, `overrides`, `contains`, `exports`; `state` becomes resolution status; `qualified_name` becomes `fqn`; AST spans declare UTF-8 bytes | Only native `requires`, `calls`, and `mentions` receive categories. `inherits`, `implements`, `overrides`, `contains`, and `exports` remain semantic extension edges. |
| Roslyn C# `codewalk-csharp-ir` v2 | `requires`, `calls`, `mentions`, `inherits`, `implements`, `overrides`, `contains`, `project-references`; resolution object, project/document ownership, and UTF-16 spans are preserved | Only native `requires`, `calls`, and `mentions` receive categories. `project-references`, inheritance, implementation, overrides, and containment are not calls/requires. |
| TypeScript/JavaScript adapter `formatVersion: 1` | `requires`, `calls`, `mentions`, `extends`, `implements`, `exports`, `reexports`, `overrides`, `contains`; package/project boundaries, JSX details, and UTF-16 spans are preserved | Only native `requires`, `calls`, and `mentions` receive categories. `extends`, `implements`, `exports`, `reexports`, `overrides`, `contains`, and JSX/type-reference details remain native extension kinds. |

The exact translation point is `normalize`: raw adapter IDs are mapped to
portable IDs, `state`/resolution is unified, and only the three permitted
native kinds populate `relationship.category`. No language adapter is edited.

## Commands, dependencies, and limitations

From the repository root:

```sh
python3 -B -m unittest discover -s parser/conformance/tests -p 'test_*.py'
python3 -B parser/conformance/run_conformance.py
python3 -B parser/shared/ir.py parser/conformance/fixtures/python.json \
  --adapter python --out /tmp/codewalk-parser-ir.json
```

Dependencies: Python 3.10+ standard library only; no package install is
required. The contract runtime is MIT-licensed by the repository's existing
project metadata. JSON Schema is a type/shape representation; the executable
validator additionally enforces path safety, endpoint references, category
rules, coordinate declarations, and deterministic normalization.

The runtime does not parse source code, resolve symbols, or convert native
offsets between encoding units because those operations require source text and
language-specific semantics. It records the adapter declaration instead.
Adapters remain responsible for source recovery; malformed contract input is a
fatal normalization error rather than a silently repaired graph.
