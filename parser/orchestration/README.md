# Standalone parser dispatcher

The dispatcher is a Python 3.10+ standard-library entry point that detects
Python, C#, or TypeScript/JavaScript repository signals, runs one native adapter
as an argv-based subprocess, normalizes its output through the
`codewalk.parser.ir/1` contract, and emits a deterministic Agentwalk graph
`formatVersion: 2`. The complete normalized IR is retained at the output's
`ir` key; `--ir-out` can also write that payload separately.

## Commands

From the Agentwalk repository root:

```sh
python3 -B -m parser.orchestration.dispatcher capabilities /path/to/repo
python3 -B -m parser.orchestration.dispatcher analyze /path/to/repo --out /path/to/graph.json --ir-out /path/to/ir.json
python3 -B -m parser.orchestration.dispatcher analyze /path/to/repo --adapter python
```

The `capabilities` result includes scores, evidence, ambiguity, runtime
requirements, default command templates, and command overrides. A mixed
repository with equally strong language signals is reported as ambiguous and
requires `--adapter`. No package manager command is run in the analyzed
repository.

## Native commands and translation boundaries

Defaults are intentionally explicit and portable:

```sh
python3 parser/python/python_parser.py --repo-root /path/to/repo
(cd parser/csharp && dotnet run -- /path/to/repo --repo-root /path/to/repo)
npm --prefix parser/typescript-javascript run build
node parser/orchestration/typescript_adapter_bridge.mjs /path/to/repo /path/to/repo/tsconfig.json
```

Python needs Python 3.10+. C# needs a compatible .NET SDK/MSBuild and restores
only the adapter's own project (`parser/csharp/Codewalk.CSharp.csproj`).
TypeScript/JavaScript needs Node.js 18+ and a
one-time build of the checked-in adapter (`typescript` 5.8.3, Apache-2.0;
`@types/node` 22.15.21, MIT). The bridge loads the native TypeScript adapter's
compiled `dist/index.js`; its formatVersion-1 output is translated by the
Python shared normalizer, not by modifying the adapter.

Commands can be overridden without editing the target repository:

```json
{
  "timeout_seconds": 120,
  "adapters": {
    "python": {
      "command": ["python3", "{dispatcher_root}/parser/orchestration/tests/fixtures/fake_adapter.py", "{repo_root}"],
      "environment": {"FAKE_MODE": "normal"}
    }
  }
}
```

Save this as `.codewalk-parser.json` in the target or pass `--config`. Supported
placeholders are `{repo_root}`, `{dispatcher_root}`, `{project_file}`, and
`{python}`. `--command python='...'` has precedence over the config. Commands
run with `shell=False`, captured stdout/stderr, a configurable timeout (default
300 seconds), and a configurable working directory.

Exit code `0` means a complete or recoverable result was emitted. A valid IR
with source/compiler diagnostics is emitted as `analysis.result_status =
"partial"`; a nonzero native exit in that case is marked
`adapter_status = "recoverable-diagnostics"`. Missing runtimes, timeouts,
nonzero exits with malformed output, malformed JSON, invalid shared IR, and
fatal IR states produce actionable structured errors or a graph with fatal
status. Unresolved/ambiguous targets without valid graph endpoints are omitted
from graph-v2 with a recoverable diagnostic; external targets are retained as
external nodes. Only native relationship kinds exactly equal to `requires`,
`calls`, or `mentions` receive graph edges. Inheritance, implementation,
exports/re-exports, overrides, containment, type references, project
references, and JSX facts remain available in `ir` and are never coerced.
