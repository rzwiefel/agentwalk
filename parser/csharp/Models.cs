using System.Text.Json.Serialization;

namespace Codewalk.CSharp;

public sealed record ParserResult(
    string Schema,
    int SchemaVersion,
    EngineInfo Engine,
    InputInfo Input,
    IReadOnlyList<ProjectInfo> Projects,
    IReadOnlyList<DocumentInfo> Documents,
    IReadOnlyList<Node> Nodes,
    IReadOnlyList<Relationship> Relationships,
    IReadOnlyList<Occurrence> Occurrences,
    OwnershipInfo Ownership,
    IReadOnlyList<ParserDiagnostic> Diagnostics);

public sealed record EngineInfo(
    string Name,
    string Version,
    string RoslynVersion,
    string Runtime,
    string MsBuild);

public sealed record InputInfo(
    string Path,
    string Kind,
    string RepositoryRoot,
    string AnalysisMode,
    IReadOnlyList<string> ChangedFiles);

public sealed record ProjectInfo(
    string Id,
    string Name,
    string? Path,
    string AssemblyName,
    string Language,
    IReadOnlyList<string> ProjectReferences,
    IReadOnlyList<string> DocumentPaths);

public sealed record DocumentInfo(
    string Path,
    string ProjectId,
    string Language,
    int Length,
    string Hash);

public sealed record Node(
    string Id,
    string Kind,
    string Name,
    string? FullyQualifiedName,
    string Namespace,
    string ProjectId,
    string? File,
    Span? Span,
    IReadOnlyList<Span> DeclarationSpans,
    string? Signature,
    string? DeclarationKind,
    string Visibility,
    bool IsExported,
    bool IsExternal,
    bool IsPartial,
    bool IsOverride,
    bool IsAbstract,
    bool IsStatic,
    string? ContainerId);

public sealed record Relationship(
    string Id,
    string Kind,
    string Source,
    string Target,
    Resolution Resolution,
    IReadOnlyList<string> OccurrenceIds);

public sealed record Resolution(
    string Status,
    double Confidence,
    string Engine,
    string EngineVersion,
    IReadOnlyList<string> CandidateIds);

public sealed record Occurrence(
    string Id,
    string RelationshipId,
    string File,
    Span Span,
    string Text,
    string? Detail);

public sealed record Span(
    Position Start,
    Position End,
    int Offset,
    int Length);

public sealed record Position(int Line, int Column);

public sealed record OwnershipInfo(
    IReadOnlyDictionary<string, string> Files,
    InvalidationInfo Invalidation);

public sealed record InvalidationInfo(
    IReadOnlyList<string> ChangedFiles,
    IReadOnlyList<string> ImpactedFiles,
    IReadOnlyList<string> ImpactedProjects,
    string Strategy);

public sealed record ParserDiagnostic(
    string Severity,
    string Message,
    string? Id,
    string? ProjectId,
    string? File,
    Span? Span);
