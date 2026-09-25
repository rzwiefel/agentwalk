# Python adapter validation

The checked-in `parser/python/fixtures` and tests provide a reproducible
validation target without disclosing or depending on another repository.
Run commands from the Codewalk checkout with `python3 -B` and
`PYTHONDONTWRITEBYTECODE=1` to avoid bytecode writes to the input tree.

## Reproducible checks

```sh
python3 -B -m unittest discover -s parser/python/tests -p 'test_*.py'
python3 -B -m unittest discover -s parser/conformance/tests -p 'test_*.py'
```

For an authorized, read-only check of a different repository, choose source
roots and an output location appropriate to that repository:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B parser/python/python_parser.py \
  --repo-root /path/to/repository \
  --source-root src --source-root tests \
  --output /path/to/python-ir.json
```

Keep output outside the target and avoid installing dependencies or writing
generated files into it. Verify graph-v2 endpoint integrity, namespace
containment, and stable declaration IDs with the checked-in fixtures before
using results from a different codebase. The current adapter uses stdlib
`ast`; optional Pyright/Jedi enrichment remains a possible future integration
behind an engine boundary.

Limitations by design: import resolution is static and conservative,
dynamic attribute access remains ambiguous/unresolved, and incremental mode
currently performs a correctness-first full reparse while reporting ownership,
dependency invalidation, deletions, and renames. Declaration IDs are stable
across relocation and body edits; the declaration fingerprint changes with
content. Unannotated transient function locals are intentionally not emitted;
module/class assignments, annotated declarations, and nested declarations
remain available. Generated code and namespace packages without `__init__.py`
require explicit source-root configuration for the intended package identity.
