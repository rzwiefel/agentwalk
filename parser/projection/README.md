# Graph-v2 projection

`graph_v2.project_graph` accepts a validated `codewalk.parser.ir/1` mapping
and returns a deterministic Agentwalk graph with `formatVersion: 2`. It emits only
`namespace`, `var`, and `keyword` nodes plus `requires`, `calls`, and `mentions`
edges. Native occurrence IDs are aggregated into `occurrenceCount` and sorted
`evidence` entries with repository-relative source locations. External nodes are
kept; unresolved or ambiguous placeholders are not promoted to graph endpoints.
The original IR is retained by the dispatcher under `ir`.

The output intentionally omits wall-clock fields and absolute checkout paths so
the same IR produces byte-identical output from different checkout locations.
