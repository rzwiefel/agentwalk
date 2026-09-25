# Agentwalk backend parser bridge

The Clojure API in `src/codewalk/parser.clj` is the backend boundary for the
standalone parser stack. It starts one short-lived dispatcher subprocess per
request and does not require a parser daemon. The dispatcher then starts the
selected native adapter as another bounded subprocess.

## API registration

`codewalk.server/start!` registers:

- `GET /api/parser/capabilities?path=<encoded-local-path>`
- `POST /api/parser/analyze` with `{"path":"...","language":"auto|python|csharp|typescript-javascript","includeIr":false}`

The bridge canonicalizes local paths, resolves a containing Git root when one
exists, caps request and parser output sizes, and uses `ProcessBuilder` argv
execution with an explicit working directory, inherited
environment plus `PYTHONUNBUFFERED=1`, captured stdout/stderr, and bounded
timeouts. No request field is interpolated into a shell command. The API caps
request bodies at 1 MiB, adapter output at 256 MiB, and parser timeouts at
0.1-300 seconds.

## Dispatcher boundary

The bridge invokes this exact command shape from the Agentwalk repository root:

```text
python3 -B -m parser.orchestration.dispatcher capabilities <repo-root>
python3 -B -m parser.orchestration.dispatcher analyze <repo-root> [--adapter <name>] [--config <file>] [--project-file <file>]
```

The dispatcher owns adapter selection, native adapter subprocesses, shared IR
normalization, and graph-v2 projection. The bridge only maps the
dispatcher envelope to the HTTP contract:

```json
{
  "ok": true,
  "language": "python",
  "graph": {},
  "ir": {},
  "diagnostics": [],
  "status": "complete"
}
```

`includeIr:false` omits the duplicate IR from the client response while leaving
the graph unchanged. Recoverable diagnostics return `ok: true` and
`status: "partial"`. Missing runtimes, ambiguous auto-detection, timeouts,
malformed output, invalid IR, and fatal adapter states return `ok: false` with
`error.code`, `error.message`, and optional `error.details`.
