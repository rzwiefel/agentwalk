# Codewalk C# semantic parser adapter

This adapter is a practical Roslyn/MSBuild semantic implementation. It is
deliberately isolated under `parser/csharp` and does not change Codewalk's
shared graph schema or Clojure analyzer. The executable emits a deterministic,
portable semantic IR (`codewalk-csharp-ir` version 2), which the shared
dispatcher normalizes and projects into the existing
namespace/var/requires/calls/mentions graph.

## Scope and boundaries

`dotnet run --project parser/csharp/Codewalk.CSharp.csproj -- <input>` accepts:

- a `.sln` or `.slnx`, loading every C# project in that solution;
- a `.csproj`, loading that project and its transitive project references;
- a directory, preferring a solution, then projects, then loose `.cs` files;
- a `.cs` file, analyzed as an AdhocWorkspace project.

Only C# source documents are analyzed. A loaded project is a hard semantic
boundary: its project ID is the normalized repository-relative project path
(or `adhoc:<relative source path>`), and namespace IDs include that project ID.
Source paths and all spans are repository-relative, slash-normalized, and
zero-based. Span offsets/columns use Roslyn's UTF-16 convention, so slicing the
original source with the emitted offset and length is lossless.

## Build and use

The adapter requires the .NET 9 SDK and an MSBuild installation discoverable by
`Microsoft.Build.Locator`.

```sh
dotnet run --project parser/csharp/Codewalk.CSharp.csproj -- \
  parser/csharp/fixtures/Codewalk.Sample.sln \
  --repo-root .

dotnet run --project parser/csharp/Codewalk.CSharp.csproj -- \
  parser/csharp/fixtures/Codewalk.Sample.sln \
  --changed parser/csharp/fixtures/Library/Shared.cs \
  --out /path/to/csharp-ir.json
```

`--changed` records file ownership and transitive project invalidation while
still doing a complete semantic load. This is a correctness-first incremental
boundary, not partial parsing. `--self-test` runs the fixture assertions and
compares full and incremental semantic content. `--self-test --update-golden`
intentionally rewrites the checked-in semantic golden file.

## IR contract

The root contains `schemaVersion`, engine/version provenance, solution/project
boundaries, normalized nodes, relationships, occurrence evidence, ownership
and invalidation, and diagnostics. Namespaces and projects are namespace-like
containers. Types, classes, interfaces, enums, methods, properties, fields,
events, parameters, locals, and unresolved/external symbols are `var` nodes.
Using directives are `requires`; invocations are `calls`; type/member
references are `mentions`. Additional relationships preserve `contains`,
`inherits`, `implements`, `overrides`, and `project-references`.

Every relationship carries `resolution` (`resolved`, `external`, `ambiguous`,
or `unresolved`), a confidence score, and the Roslyn engine/version. Each
occurrence has an exact source span, source slice, and relationship ID.
Compiler error symbols and synthetic unresolved/ambiguous targets always receive
stable non-empty names and qualified identities derived from relative source
location, syntax, and symbol role; recoverable compiler diagnostics remain
diagnostics rather than becoming fatal output errors.
Overloads use canonical parameter-type signatures in their IDs, and partial
declarations are represented by one symbol node with multiple declaration
spans. Public symbols expose `visibility` and `isExported`; overrides and
interface implementations are explicit relationships.

## Comparison and recommendation

| Engine | Strength | Limitation for Codewalk |
| --- | --- | --- |
| **Roslyn compiler APIs (this adapter)** | Authoritative binding, overloads, project references, metadata symbols, diagnostics, MSBuild configuration, partial/override/interface semantics | Requires a compatible .NET SDK/MSBuild and project restore; workspace loading is heavier |
| tree-sitter-c-sharp | Fast, portable syntax and excellent error recovery | No compiler binding; project references, overload resolution, aliases, and external symbols require a separate semantic layer |
| OmniSharp/Roslyn service | Mature language-service features and editor protocol | A long-running external service/protocol is operationally heavier than an in-process indexer |
| Semantic indexers (e.g. Sourcegraph SCIP) | Portable interchange and prebuilt cross-language indexing workflows | Usually need a language-specific indexer/build environment and can omit source-level evidence useful to Codewalk |

The integrated dispatcher uses Roslyn/MSBuild as the semantic C# backend when a
compatible SDK is available, retains graceful diagnostics for unloaded
projects, and projects only native `requires`, `calls`, and `mentions` into
graph-v2. A tree-sitter syntax fallback remains a possible lower-confidence
future mode; it is not currently implemented.

## Read-only repository validation

Use the checked-in `parser/csharp/fixtures/Codewalk.Sample.sln` and
`--self-test` for reproducible semantic and incremental checks. For an
authorized external solution, run the adapter from the Codewalk checkout,
pass a repository-relative solution path, and write any `--out` file outside
the target. Avoid restore/build commands in the target unless the owner has
approved them. Recoverable compilation diagnostics remain visible in emitted
IR; emitted IR alone is not evidence of a clean build. SDK/package
configuration outside a solution can also affect project loading and results.

## Dependencies and licenses

- `Microsoft.CodeAnalysis.CSharp.Workspaces` **4.12.0**, MIT, Roslyn compiler and
  workspace APIs.
- `Microsoft.CodeAnalysis.Workspaces.MSBuild` **4.12.0**, MIT, MSBuild-backed
  workspace loading.
- `Microsoft.Build.Locator` **1.7.8**, MIT, selects an installed MSBuild.
- Runtime/build requirement: .NET SDK **9** with compatible MSBuild. Output
  and diagnostics should be re-baselined when changing toolchain versions.

NuGet package licenses are MIT; transitive packages remain those selected by
NuGet's lock/restore graph and should be reviewed by the integrating build.
