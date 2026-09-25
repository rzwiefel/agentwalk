using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;

namespace Codewalk.CSharp;

internal static class SelfTest
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };

    public static async Task RunAsync()
    {
        var repositoryRoot = FindRepositoryRoot();
        var solution = Path.Combine(repositoryRoot, "parser", "csharp", "fixtures", "Codewalk.Sample.sln");
        var changed = new[] { "parser/csharp/fixtures/Library/Shared.cs" };
        var looseSource = Path.Combine(repositoryRoot, "parser", "csharp", "fixtures", "Loose.cs");
        var diagnosticsSource = Path.Combine(repositoryRoot, "parser", "csharp", "fixtures", "Diagnostics.cs");
        var semanticsSource = Path.Combine(repositoryRoot, "parser", "csharp", "fixtures", "Semantics.cs");
        var fileScopedSource = Path.Combine(repositoryRoot, "parser", "csharp", "fixtures", "FileScoped.cs");
        var globalCodeSource = Path.Combine(repositoryRoot, "parser", "csharp", "fixtures", "GlobalCode.cs");
        await AssertPortableAcrossRootsAsync(repositoryRoot);
        var full = await CSharpSemanticAnalyzer.AnalyzeAsync(
            solution,
            repositoryRoot,
            Array.Empty<string>(),
            CancellationToken.None);
        var incremental = await CSharpSemanticAnalyzer.AnalyzeAsync(
            solution,
            repositoryRoot,
            changed,
            CancellationToken.None);
        var loose = await CSharpSemanticAnalyzer.AnalyzeAsync(
            looseSource,
            repositoryRoot,
            Array.Empty<string>(),
            CancellationToken.None);
        var diagnostics = await CSharpSemanticAnalyzer.AnalyzeAsync(
            diagnosticsSource,
            repositoryRoot,
            Array.Empty<string>(),
            CancellationToken.None);
        var semantics = await CSharpSemanticAnalyzer.AnalyzeAsync(
            semanticsSource,
            repositoryRoot,
            Array.Empty<string>(),
            CancellationToken.None);
        var fileScoped = await CSharpSemanticAnalyzer.AnalyzeAsync(
            fileScopedSource,
            repositoryRoot,
            Array.Empty<string>(),
            CancellationToken.None);
        var globalCode = await CSharpSemanticAnalyzer.AnalyzeAsync(
            globalCodeSource,
            repositoryRoot,
            Array.Empty<string>(),
            CancellationToken.None);

        Assert(full.Projects.Count == 2, "solution/project boundary count");
        var app = full.Projects.Single(project => project.Name == "App");
        Assert(app.ProjectReferences.Count == 1, "cross-project reference");
        Assert(app.ProjectReferences[0].EndsWith("Library/Library.csproj", StringComparison.Ordinal),
            "normalized project reference");

        var overloads = full.Nodes
            .Where(node => node.Name == "Overload")
            .Select(node => node.Signature)
            .Where(signature => signature is not null)
            .ToArray();
        Assert(overloads.Length == 2 && overloads.Distinct(StringComparer.Ordinal).Count() == 2,
            "overload signatures");
        var shared = full.Nodes.Single(node => node.Name == "Shared" && node.ProjectId.EndsWith(
            "Library/Library.csproj", StringComparison.Ordinal));
        Assert(shared.IsPartial && shared.DeclarationSpans.Count >= 2, "partial declarations");
        Assert(full.Nodes.Any(node => node.Name == "IWorker" && node.DeclarationKind == "NamedType"),
            "interface node");
        Assert(full.Relationships.Any(relationship => relationship.Kind == "inherits"), "inheritance");
        Assert(full.Relationships.Any(relationship => relationship.Kind == "implements"), "interface implementation");
        Assert(full.Relationships.Any(relationship => relationship.Kind == "overrides"), "override relationship");
        Assert(full.Relationships.Any(relationship => relationship.Kind == "requires"), "using requires");
        Assert(full.Relationships.Any(relationship => relationship.Kind == "mentions"), "type/member mentions");
        Assert(full.Relationships.Any(relationship =>
                relationship.Kind == "calls" && relationship.Resolution.Status == "external"),
            "external call");
        Assert(full.Relationships.Any(relationship =>
                relationship.Kind == "calls" &&
                relationship.Resolution.Status == "resolved" &&
                relationship.Target.Contains("Library/Library.csproj", StringComparison.Ordinal)),
            "resolved cross-project call");
        Assert(full.Relationships.Any(relationship =>
                relationship.Kind == "calls" && relationship.Resolution.Status == "unresolved"),
            "unresolved call");
        var requireRelationships = full.Relationships
            .Where(relationship => relationship.Kind == "requires")
            .ToArray();
        Assert(requireRelationships.All(relationship =>
                !relationship.Source.EndsWith(":<global>", StringComparison.Ordinal)),
            "no false global requires");
        var requireOccurrenceIds = requireRelationships
            .SelectMany(relationship => relationship.OccurrenceIds)
            .ToArray();
        Assert(requireOccurrenceIds.Distinct(StringComparer.Ordinal).Count() == requireOccurrenceIds.Length,
            "deterministic require occurrence IDs");
        Assert(full.Diagnostics.Any(diagnostic => diagnostic.Id == "CS0103"), "compiler diagnostics");
        Assert(loose.Input.Kind == "source" && loose.Projects.Count == 1 &&
               loose.Documents.Count == 1 && loose.Diagnostics.Count == 0,
            "loose source boundary");
        Assert(diagnostics.Diagnostics.Any(diagnostic => diagnostic.Severity == "error"),
            "recoverable compiler diagnostics");
        Assert(diagnostics.Relationships.Any(relationship =>
                relationship.Resolution.Status == "unresolved"),
            "unresolved generic/type/member symbols");
        Assert(diagnostics.Relationships.Count(relationship =>
                relationship.Kind == "calls" &&
                relationship.Resolution.Status == "unresolved") >= 2,
            "repeated unresolved calls");
        var semanticNamespaces = semantics.Nodes
            .Where(node => node.Kind == "namespace")
            .Select(node => node.Namespace)
            .ToHashSet(StringComparer.Ordinal);
        Assert(new[] { "Block.One", "Block.Two" }.All(semanticNamespaces.Contains),
            "block namespace anchors");
        Assert(fileScoped.Nodes.Any(node => node.Kind == "namespace" && node.Namespace == "FileScoped"),
            "file-scoped namespace anchor");
        var semanticRequires = semantics.Relationships
            .Where(relationship => relationship.Kind == "requires")
            .ToArray();
        Assert(semanticRequires.Length >= 4 &&
               semanticRequires.All(relationship =>
                   relationship.Source.Contains(":Block.One", StringComparison.Ordinal) ||
                   relationship.Source.Contains(":Block.Two", StringComparison.Ordinal)),
            "using directives use declared namespace owners");
        Assert(semanticRequires.Any(relationship => relationship.Resolution.Status == "unresolved"),
            "unresolved using target");
        Assert(globalCode.Relationships.Any(relationship =>
                relationship.Kind == "requires" &&
                relationship.Source.EndsWith(":<global>", StringComparison.Ordinal)),
            "true global using owner");
        Assert(diagnostics.Nodes.All(node =>
                !string.IsNullOrWhiteSpace(node.Name) &&
                !string.IsNullOrWhiteSpace(node.FullyQualifiedName) &&
                !node.Id.EndsWith(":", StringComparison.Ordinal)),
            "stable names and qualified identities");
        var diagnosticsRepeat = await CSharpSemanticAnalyzer.AnalyzeAsync(
            diagnosticsSource,
            repositoryRoot,
            Array.Empty<string>(),
            CancellationToken.None);
        AssertSerializedEqual(FullJson(diagnostics), FullJson(diagnosticsRepeat),
            "deterministic diagnostics fixture output");

        foreach (var occurrence in full.Occurrences)
        {
            var sourcePath = Path.Combine(repositoryRoot, occurrence.File.Replace('/', Path.DirectorySeparatorChar));
            var source = await File.ReadAllTextAsync(sourcePath);
            Assert(occurrence.Span.Offset >= 0 &&
                    occurrence.Span.Offset + occurrence.Span.Length <= source.Length,
                $"span bounds for {occurrence.Id}");
            Assert(source.Substring(occurrence.Span.Offset, occurrence.Span.Length) == occurrence.Text,
                $"span slicing for {occurrence.Id}");
        }

        var invalidation = incremental.Ownership.Invalidation;
        Assert(invalidation.ChangedFiles.SequenceEqual(changed), "incremental changed files");
        Assert(invalidation.ImpactedProjects.Count == 2, "transitive project invalidation");
        Assert(invalidation.ImpactedFiles.Count == full.Documents.Count, "impacted source ownership");
        AssertSerializedEqual(SemanticJson(full), SemanticJson(incremental), "full/incremental semantic convergence");

        var goldenPath = Path.Combine(repositoryRoot, "parser", "csharp", "fixtures", "golden.json");
        if (!File.Exists(goldenPath))
        {
            throw new InvalidOperationException($"Missing golden output: {goldenPath}");
        }

        var golden = await File.ReadAllTextAsync(goldenPath);
        AssertSerializedEqual(SemanticJson(full), golden.Trim(), "deterministic golden output");
    }

    public static async Task WriteGoldenAsync()
    {
        var repositoryRoot = FindRepositoryRoot();
        var solution = Path.Combine(repositoryRoot, "parser", "csharp", "fixtures", "Codewalk.Sample.sln");
        var result = await CSharpSemanticAnalyzer.AnalyzeAsync(
            solution,
            repositoryRoot,
            Array.Empty<string>(),
            CancellationToken.None);
        var goldenPath = Path.Combine(repositoryRoot, "parser", "csharp", "fixtures", "golden.json");
        await File.WriteAllTextAsync(goldenPath, SemanticJson(result) + Environment.NewLine);
    }

    private static string SemanticJson(ParserResult result) =>
        JsonSerializer.Serialize(new
        {
            result.Schema,
            result.SchemaVersion,
            result.Projects,
            result.Documents,
            result.Nodes,
            result.Relationships,
            result.Occurrences,
            result.Diagnostics
        }, JsonOptions);

    private static string FullJson(ParserResult result) =>
        JsonSerializer.Serialize(result, JsonOptions);

    private static async Task AssertPortableAcrossRootsAsync(string repositoryRoot)
    {
        var temporaryRoot = Directory.CreateTempSubdirectory("codewalk-csharp-portable-");
        var firstRoot = new DirectoryInfo(Path.Combine(temporaryRoot.FullName, "parser-integration-qa"));
        var secondRoot = new DirectoryInfo(Path.Combine(temporaryRoot.FullName, "parser-integration"));
        firstRoot.Create();
        secondRoot.Create();
        try
        {
            CopyDirectory(
                Path.Combine(repositoryRoot, "parser", "csharp", "fixtures"),
                Path.Combine(firstRoot.FullName, "parser", "csharp", "fixtures"));
            CopyDirectory(
                Path.Combine(repositoryRoot, "parser", "csharp", "fixtures"),
                Path.Combine(secondRoot.FullName, "parser", "csharp", "fixtures"));

            var firstSolution = Path.Combine(firstRoot.FullName, "parser", "csharp", "fixtures", "Codewalk.Sample.sln");
            var secondSolution = Path.Combine(secondRoot.FullName, "parser", "csharp", "fixtures", "Codewalk.Sample.sln");
            var first = await CSharpSemanticAnalyzer.AnalyzeAsync(
                firstSolution,
                firstRoot.FullName,
                Array.Empty<string>(),
                CancellationToken.None);
            var second = await CSharpSemanticAnalyzer.AnalyzeAsync(
                secondSolution,
                secondRoot.FullName,
                Array.Empty<string>(),
                CancellationToken.None);
            AssertSerializedEqual(FullJson(first), FullJson(second), "portable serialized output across absolute roots");
            AssertSerializedEqual(SemanticJson(first), SemanticJson(second), "portable output across absolute roots");
            var goldenPath = Path.Combine(repositoryRoot, "parser", "csharp", "fixtures", "golden.json");
            var golden = await File.ReadAllTextAsync(goldenPath);
            AssertSerializedEqual(SemanticJson(first), golden.Trim(), "portable golden output");
        }
        finally
        {
            firstRoot.Delete(true);
            secondRoot.Delete(true);
            temporaryRoot.Delete(true);
        }
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.EnumerateFiles(source))
        {
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        }

        foreach (var directory in Directory.EnumerateDirectories(source)
                     .Where(directory => !Path.GetFileName(directory).Equals("bin", StringComparison.OrdinalIgnoreCase) &&
                                         !Path.GetFileName(directory).Equals("obj", StringComparison.OrdinalIgnoreCase)))
        {
            CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
        }
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(Directory.GetCurrentDirectory());
             directory is not null;
             directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "parser", "csharp", "Codewalk.CSharp.csproj")))
            {
                return directory.FullName;
            }
        }

        throw new DirectoryNotFoundException("Run the self-test from the Codewalk repository.");
    }

    private static void Assert(bool condition, string check)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Self-test failed: {check}");
        }
    }

    private static void AssertSerializedEqual(string actual, string expected, string check)
    {
        if (actual == expected)
        {
            return;
        }

        var difference = 0;
        while (difference < actual.Length &&
               difference < expected.Length &&
               actual[difference] == expected[difference])
        {
            difference++;
        }

        var contextStart = Math.Max(0, difference - 80);
        var actualContext = actual[contextStart..Math.Min(actual.Length, difference + 160)];
        var expectedContext = expected[contextStart..Math.Min(expected.Length, difference + 160)];
        throw new InvalidOperationException(
            $"Self-test failed: {check}; actual SHA-256 {Digest(actual)}, expected SHA-256 {Digest(expected)}, " +
            $"first difference at index {difference}, lengths {actual.Length}/{expected.Length}; " +
            $"actual context {actualContext}, expected context {expectedContext}.");
    }

    private static string Digest(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}
