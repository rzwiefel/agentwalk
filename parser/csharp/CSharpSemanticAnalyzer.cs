using System.Collections.Immutable;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace Codewalk.CSharp;

public static class CSharpSemanticAnalyzer
{
    internal const string GlobalNamespace = "<global>";
    internal static readonly SymbolDisplayFormat FullyQualified =
        SymbolDisplayFormat.FullyQualifiedFormat;

    public static async Task<ParserResult> AnalyzeAsync(
        string input,
        string repositoryRoot,
        IReadOnlyList<string> changedFiles,
        CancellationToken cancellationToken)
    {
        var root = CanonicalPath(repositoryRoot);
        var inputPath = CanonicalPath(input);
        var diagnostics = new List<ParserDiagnostic>();
        var loaded = await LoadWorkspaceAsync(inputPath, root, diagnostics, cancellationToken);
        var projectContexts = loaded.Projects
            .OrderBy(p => p.ProjectId)
            .ToArray();

        var projectIds = projectContexts.ToDictionary(p => p.Project.Id, p => p.ProjectId);
        var projects = projectContexts
            .Select(context => ProjectInfoFor(context, projectIds, root))
            .OrderBy(project => project.Id, StringComparer.Ordinal)
            .ToArray();
        var documents = projectContexts
            .SelectMany(context => context.Project.Documents
                .Where(IsAnalyzableDocument)
                .Select(document => DocumentInfoFor(document, context.ProjectId, root, cancellationToken)))
            .OrderBy(document => document.Path, StringComparer.Ordinal)
            .ToArray();

        var sourceProjectIds = projectContexts
            .SelectMany(context => context.Project.Documents
                .Where(document => document.FilePath is not null)
                .Select(document => (Path: NormalizePath(document.FilePath!, root), context.ProjectId)))
            .GroupBy(item => item.Path, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First().ProjectId, StringComparer.Ordinal);
        var assemblyProjectIds = projectContexts
            .ToDictionary(
                context => context.Project.AssemblyName ?? context.Project.Name,
                context => context.ProjectId,
                StringComparer.Ordinal);
        var builder = new IrBuilder(root, sourceProjectIds, assemblyProjectIds, diagnostics);
        foreach (var context in projectContexts)
        {
            await AnalyzeProjectAsync(context, builder, root, cancellationToken);
        }

        var normalizedChanged = changedFiles
            .Select(path => NormalizePath(Path.IsPathRooted(path) ? path : Path.Combine(root, path), root))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();
        var ownership = ComputeOwnership(projects, documents, normalizedChanged);
        var kind = Path.GetExtension(inputPath).ToLowerInvariant() switch
        {
            ".sln" or ".slnx" => "solution",
            ".csproj" => "project",
            ".cs" => "source",
            _ when Directory.Exists(inputPath) => "directory",
            _ => "input"
        };

        return new ParserResult(
            "codewalk-csharp-ir",
            2,
            EngineInfoFor(),
            new InputInfo(
                NormalizePath(inputPath, root),
                kind,
                NormalizePath(root, root),
                normalizedChanged.Length == 0 ? "full" : "incremental",
                normalizedChanged),
            projects,
            documents,
            builder.Nodes,
            builder.Relationships,
            builder.Occurrences,
            ownership,
            diagnostics
                .OrderBy(diagnostic => diagnostic.File ?? string.Empty, StringComparer.Ordinal)
                .ThenBy(diagnostic => diagnostic.Span?.Offset ?? -1)
                .ThenBy(diagnostic => diagnostic.Id ?? string.Empty, StringComparer.Ordinal)
                .ThenBy(diagnostic => diagnostic.Message, StringComparer.Ordinal)
                .ToArray());
    }

    private static async Task<LoadedWorkspace> LoadWorkspaceAsync(
        string input,
        string repositoryRoot,
        List<ParserDiagnostic> diagnostics,
        CancellationToken cancellationToken)
    {
        var extension = Path.GetExtension(input).ToLowerInvariant();
        if (extension == ".cs")
        {
            return await LoadAdhocAsync(input, repositoryRoot, cancellationToken);
        }

        var selected = SelectWorkspaceInput(input);
        RegisterMsBuild(diagnostics);
        using var workspace = MSBuildWorkspace.Create();
        workspace.WorkspaceFailed += (_, args) =>
        {
            diagnostics.Add(new ParserDiagnostic(
                args.Diagnostic.Kind == WorkspaceDiagnosticKind.Failure ? "error" : "warning",
                args.Diagnostic.Message,
                "MSBUILD",
                null,
                null,
                null));
        };

        Solution solution;
        if (Path.GetExtension(selected).Equals(".csproj", StringComparison.OrdinalIgnoreCase))
        {
            var project = await workspace.OpenProjectAsync(selected, cancellationToken: cancellationToken);
            solution = project.Solution;
        }
        else
        {
            solution = await workspace.OpenSolutionAsync(selected, cancellationToken: cancellationToken);
        }

        var projects = solution.Projects
            .Where(project => project.Language == LanguageNames.CSharp)
            .OrderBy(project => project.FilePath ?? project.Name, StringComparer.OrdinalIgnoreCase)
            .Select(project => new ProjectContext(
                project,
                ProjectIdFor(project.FilePath, project.Name, repositoryRoot)))
            .ToArray();
        if (projects.Length == 0)
        {
            throw new InvalidOperationException($"No C# projects found in {selected}.");
        }

        return new LoadedWorkspace(projects);
    }

    private static async Task<LoadedWorkspace> LoadAdhocAsync(
        string sourcePath,
        string repositoryRoot,
        CancellationToken cancellationToken)
    {
        var workspace = new AdhocWorkspace();
        var projectId = ProjectId.CreateNewId("adhoc");
        var projectInfo = Microsoft.CodeAnalysis.ProjectInfo.Create(
            projectId,
            VersionStamp.Create(),
            "Adhoc",
            "Adhoc",
            LanguageNames.CSharp,
            filePath: Path.Combine(Path.GetDirectoryName(sourcePath)!, "adhoc.csproj"),
            compilationOptions: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary),
            parseOptions: new CSharpParseOptions(LanguageVersion.Latest));
        var project = workspace.AddProject(projectInfo);
        foreach (var reference in ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? string.Empty)
                     .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                     .OrderBy(path => path, StringComparer.Ordinal))
        {
            project = project.AddMetadataReference(MetadataReference.CreateFromFile(reference));
        }

        var source = await File.ReadAllTextAsync(sourcePath, cancellationToken);
        project = project.AddDocument(
            Path.GetFileName(sourcePath),
            SourceText.From(source, Encoding.UTF8),
            filePath: sourcePath).Project;
        return new LoadedWorkspace(
            new[]
            {
                new ProjectContext(
                    project,
                    ProjectIdFor(sourcePath, "Adhoc", repositoryRoot))
            });
    }

    private static string SelectWorkspaceInput(string input)
    {
        if (File.Exists(input))
        {
            return input;
        }

        if (!Directory.Exists(input))
        {
            throw new FileNotFoundException($"Input does not exist: {input}", input);
        }

        var directory = new DirectoryInfo(input);
        var solution = directory.GetFiles("*.sln")
            .Concat(directory.GetFiles("*.slnx"))
            .OrderBy(file => file.Name, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
        if (solution is not null)
        {
            return solution.FullName;
        }

        var project = directory.GetFiles("*.csproj")
            .OrderBy(file => file.Name, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
        if (project is not null)
        {
            return project.FullName;
        }

        var source = directory.GetFiles("*.cs")
            .OrderBy(file => file.Name, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
        return source?.FullName
               ?? throw new InvalidOperationException($"No .sln, .csproj, or .cs files found in {input}.");
    }

    private static void RegisterMsBuild(List<ParserDiagnostic> diagnostics)
    {
        if (MSBuildLocator.IsRegistered)
        {
            return;
        }

        try
        {
            MSBuildLocator.RegisterDefaults();
        }
        catch (Exception exception)
        {
            diagnostics.Add(new ParserDiagnostic(
                "error",
                $"Unable to register MSBuild: {exception.Message}",
                "MSBUILD_LOCATOR",
                null,
                null,
                null));
            throw;
        }
    }

    private static async Task AnalyzeProjectAsync(
        ProjectContext context,
        IrBuilder builder,
        string repositoryRoot,
        CancellationToken cancellationToken)
    {
        var compilation = await context.Project.GetCompilationAsync(cancellationToken);
        if (compilation is null)
        {
            builder.Diagnostics.Add(new ParserDiagnostic(
                "error",
                $"Compilation unavailable for project {context.Project.Name}.",
                "COMPILATION_UNAVAILABLE",
                context.ProjectId,
                null,
                null));
            return;
        }

        foreach (var diagnostic in compilation.GetDiagnostics(cancellationToken))
        {
            builder.AddDiagnostic(diagnostic, context.ProjectId, repositoryRoot);
        }

        var documents = new List<(Document Document, SyntaxNode Root, SemanticModel Model, SourceText Source, string FilePath)>();
        var projectNamespaces = new HashSet<string>(StringComparer.Ordinal);
        foreach (var document in context.Project.Documents
                     .Where(IsAnalyzableDocument)
                     .OrderBy(document => document.FilePath ?? document.Name, StringComparer.Ordinal))
        {
            var root = await document.GetSyntaxRootAsync(cancellationToken);
            var model = await document.GetSemanticModelAsync(cancellationToken);
            var source = await document.GetTextAsync(cancellationToken);
            if (root is null || model is null || document.FilePath is null)
            {
                continue;
            }

            documents.Add((document, root, model, source, document.FilePath));
            foreach (var declaration in root.DescendantNodesAndSelf().OfType<BaseNamespaceDeclarationSyntax>())
            {
                if (model.GetDeclaredSymbol(declaration) is INamespaceSymbol namespaceSymbol)
                {
                    projectNamespaces.Add(NamespaceName(namespaceSymbol));
                }
            }

            if (root.DescendantNodesAndSelf().OfType<GlobalStatementSyntax>().Any() ||
                root.DescendantNodesAndSelf().OfType<MemberDeclarationSyntax>()
                    .Any(declaration => declaration is not BaseNamespaceDeclarationSyntax &&
                                        !declaration.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().Any()))
            {
                projectNamespaces.Add(GlobalNamespace);
            }
        }

        if (projectNamespaces.Count == 0)
        {
            projectNamespaces.Add(GlobalNamespace);
        }

        foreach (var (_, root, model, source, filePath) in documents)
        {
            AnalyzeDocument(
                context,
                filePath,
                root,
                model,
                source,
                builder,
                repositoryRoot,
                projectNamespaces);
        }
    }

    private static void AnalyzeDocument(
        ProjectContext context,
        string filePath,
        SyntaxNode root,
        SemanticModel model,
        SourceText source,
        IrBuilder builder,
        string repositoryRoot,
        IReadOnlySet<string> projectNamespaces)
    {
        var documentNamespaces = root.DescendantNodesAndSelf()
            .OfType<BaseNamespaceDeclarationSyntax>()
            .Select(declaration => model.GetDeclaredSymbol(declaration) as INamespaceSymbol)
            .Where(symbol => symbol is not null)
            .Select(symbol => NamespaceName(symbol!))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        if (documentNamespaces.Length == 0)
        {
            documentNamespaces = new[] { GlobalNamespace };
        }

        foreach (var declaration in root.DescendantNodesAndSelf().OfType<BaseTypeDeclarationSyntax>())
        {
            var symbol = model.GetDeclaredSymbol(declaration);
            if (symbol is not null)
            {
                var nodeId = builder.AddSymbolNode(symbol, context.ProjectId, filePath, declaration, repositoryRoot);
                if (declaration.BaseList is not null)
                {
                    foreach (var baseType in declaration.BaseList.Types)
                    {
                        var baseSymbol = model.GetTypeInfo(baseType.Type).Type as INamedTypeSymbol
                                         ?? model.GetSymbolInfo(baseType.Type).Symbol as INamedTypeSymbol;
                        if (baseSymbol is null)
                        {
                            builder.AddUnresolvedRelationship(
                                "inherits",
                                nodeId,
                                baseType.ToString(),
                                context.ProjectId,
                                filePath,
                                baseType,
                                source,
                                repositoryRoot);
                            continue;
                        }

                        var relationshipKind = IsInterface(baseSymbol) ? "implements" : "inherits";
                        builder.AddSymbolRelationship(
                            relationshipKind,
                            nodeId,
                            baseSymbol,
                            context.ProjectId,
                            filePath,
                            baseType,
                            source,
                            repositoryRoot,
                            baseType.ToString());
                    }
                }
            }
        }

        foreach (var declaration in root.DescendantNodesAndSelf().OfType<BaseNamespaceDeclarationSyntax>())
        {
            var namespaceSymbol = model.GetDeclaredSymbol(declaration) as INamespaceSymbol;
            builder.DeclareNamespaceNode(
                namespaceSymbol is null ? declaration.Name.ToString() : NamespaceName(namespaceSymbol),
                context.ProjectId,
                filePath,
                declaration,
                repositoryRoot);
        }

        foreach (var declaration in root.DescendantNodesAndSelf().OfType<MemberDeclarationSyntax>())
        {
            var symbol = model.GetDeclaredSymbol(declaration);
            if (symbol is null)
            {
                continue;
            }

            var nodeId = builder.AddSymbolNode(symbol, context.ProjectId, filePath, declaration, repositoryRoot);
            if (symbol is IMethodSymbol method)
            {
                if (method.OverriddenMethod is not null)
                {
                    builder.AddSymbolRelationship(
                        "overrides",
                        nodeId,
                        method.OverriddenMethod,
                        context.ProjectId,
                        filePath,
                        declaration,
                        source,
                        repositoryRoot,
                        method.OverriddenMethod.Name);
                }

                foreach (var interfaceType in method.ContainingType.AllInterfaces)
                {
                    foreach (var member in interfaceType.GetMembers())
                    {
                        if (SymbolEqualityComparer.Default.Equals(
                                method.ContainingType.FindImplementationForInterfaceMember(member),
                                method))
                        {
                            builder.AddSymbolRelationship(
                                "implements",
                                nodeId,
                                member,
                                context.ProjectId,
                                filePath,
                                declaration,
                                source,
                                repositoryRoot,
                                member.Name);
                        }
                    }
                }
            }
        }

        foreach (var declaration in root.DescendantNodesAndSelf().OfType<VariableDeclaratorSyntax>())
        {
            if (model.GetDeclaredSymbol(declaration) is { } symbol)
            {
                builder.AddSymbolNode(symbol, context.ProjectId, filePath, declaration, repositoryRoot);
            }
        }

        foreach (var usingDirective in root.DescendantNodesAndSelf().OfType<UsingDirectiveSyntax>())
        {
            if (usingDirective.Name is not { } usingName)
            {
                continue;
            }

            var targetNamespace = UsingTargetNamespace(model, usingDirective, usingName);
            var enclosingNamespace = EnclosingNamespace(model, usingDirective.SpanStart);
            IEnumerable<string> sourceNamespaces = usingDirective.GlobalKeyword.IsKind(SyntaxKind.GlobalKeyword)
                ? projectNamespaces.OrderBy(value => value, StringComparer.Ordinal)
                : enclosingNamespace == GlobalNamespace
                    ? documentNamespaces
                    : new[] { enclosingNamespace };
            foreach (var sourceNamespace in sourceNamespaces)
            {
                if (targetNamespace is not null)
                {
                    builder.AddSymbolRelationship(
                        "requires",
                        builder.NamespaceNode(sourceNamespace, context.ProjectId, filePath, usingDirective, repositoryRoot),
                        targetNamespace,
                        context.ProjectId,
                        filePath,
                        usingDirective,
                        source,
                        repositoryRoot,
                        usingDirective.Alias?.Name.Identifier.ValueText);
                }
                else
                {
                    builder.AddUnresolvedRelationship(
                        "requires",
                        builder.NamespaceNode(sourceNamespace, context.ProjectId, filePath, usingDirective, repositoryRoot),
                        usingDirective.Name.ToString(),
                        context.ProjectId,
                        filePath,
                        usingDirective,
                        source,
                        repositoryRoot);
                }
            }
        }

        foreach (var invocation in root.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>())
        {
            AddCall(invocation, model, context, builder, filePath, source, repositoryRoot);
        }

        foreach (var creation in root.DescendantNodesAndSelf().OfType<ObjectCreationExpressionSyntax>())
        {
            AddCall(creation, model, context, builder, filePath, source, repositoryRoot);
        }

        foreach (var reference in root.DescendantNodesAndSelf().OfType<SimpleNameSyntax>())
        {
            if (IsDeclarationName(reference) ||
                reference.Ancestors().Any(node => node is UsingDirectiveSyntax) ||
                reference.Ancestors().Any(node => node is InvocationExpressionSyntax))
            {
                continue;
            }

            var symbol = model.GetSymbolInfo(reference).Symbol;
            if (symbol is null)
            {
                symbol = model.GetTypeInfo(reference).Type;
            }

            if (symbol is null ||
                symbol.Kind is SymbolKind.Namespace or SymbolKind.Alias or SymbolKind.Label)
            {
                continue;
            }

            var sourceId = builder.SourceNode(model, reference.SpanStart, context.ProjectId, filePath,
                reference, repositoryRoot);
            builder.AddSymbolRelationship(
                "mentions",
                sourceId,
                symbol,
                context.ProjectId,
                filePath,
                reference,
                source,
                repositoryRoot,
                symbol.Kind.ToString());
        }

        foreach (var typeSyntax in root.DescendantNodesAndSelf().OfType<PredefinedTypeSyntax>())
        {
            var type = model.GetTypeInfo(typeSyntax).Type;
            if (type is null)
            {
                continue;
            }

            var sourceId = builder.SourceNode(model, typeSyntax.SpanStart, context.ProjectId, filePath,
                typeSyntax, repositoryRoot);
            builder.AddSymbolRelationship(
                "mentions",
                sourceId,
                type,
                context.ProjectId,
                filePath,
                typeSyntax,
                source,
                repositoryRoot,
                "predefined-type");
        }
    }

    private static void AddCall(
        ExpressionSyntax expression,
        SemanticModel model,
        ProjectContext context,
        IrBuilder builder,
        string filePath,
        SourceText source,
        string repositoryRoot)
    {
        var symbolInfo = model.GetSymbolInfo(expression);
        var sourceId = builder.SourceNode(model, expression.SpanStart, context.ProjectId, filePath,
            expression, repositoryRoot);
        if (symbolInfo.Symbol is not null)
        {
            builder.AddSymbolRelationship(
                "calls",
                sourceId,
                symbolInfo.Symbol,
                context.ProjectId,
                filePath,
                expression,
                source,
                repositoryRoot,
                expression is ObjectCreationExpressionSyntax ? "constructor" : "invocation");
            return;
        }

        if (symbolInfo.CandidateSymbols.Length > 0)
        {
            builder.AddAmbiguousRelationship(
                "calls",
                sourceId,
                expression.ToString(),
                symbolInfo.CandidateSymbols,
                context.ProjectId,
                filePath,
                expression,
                source,
                repositoryRoot);
        }
        else
        {
            builder.AddUnresolvedRelationship(
                "calls",
                sourceId,
                expression.ToString(),
                context.ProjectId,
                filePath,
                expression,
                source,
                repositoryRoot);
        }
    }

    private static bool IsDeclarationName(SimpleNameSyntax syntax)
    {
        return syntax.Parent switch
        {
            BaseTypeDeclarationSyntax or
                MethodDeclarationSyntax or
                PropertyDeclarationSyntax or
                EventDeclarationSyntax or
                EventFieldDeclarationSyntax or
                VariableDeclaratorSyntax or
                ParameterSyntax or
                TypeParameterSyntax or
                EnumMemberDeclarationSyntax or
                NamespaceDeclarationSyntax or
                FileScopedNamespaceDeclarationSyntax => true,
            _ => false
        };
    }

    private static bool IsInterface(INamedTypeSymbol symbol) =>
        symbol.TypeKind == TypeKind.Interface;

    private static INamespaceSymbol? UsingTargetNamespace(
        SemanticModel model,
        UsingDirectiveSyntax usingDirective,
        NameSyntax usingName)
    {
        var alias = model.GetDeclaredSymbol(usingDirective) as IAliasSymbol;
        var symbol = alias?.Target
                     ?? model.GetSymbolInfo(usingName).Symbol
                     ?? model.GetTypeInfo(usingName).Type;
        return symbol switch
        {
            INamespaceSymbol namespaceSymbol => namespaceSymbol,
            INamedTypeSymbol namedType => namedType.ContainingNamespace,
            _ => symbol?.ContainingNamespace
        };
    }

    private static string EnclosingNamespace(SemanticModel model, int position)
    {
        for (var symbol = model.GetEnclosingSymbol(position);
             symbol is not null;
             symbol = symbol.ContainingSymbol)
        {
            if (symbol is INamespaceSymbol namespaceSymbol)
            {
                return NamespaceName(namespaceSymbol);
            }
        }

        return GlobalNamespace;
    }

    private static ProjectInfo ProjectInfoFor(
        ProjectContext context,
        IReadOnlyDictionary<ProjectId, string> projectIds,
        string repositoryRoot)
    {
        var references = context.Project.ProjectReferences
            .Where(reference => projectIds.ContainsKey(reference.ProjectId))
            .Select(reference => projectIds[reference.ProjectId])
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        var documents = context.Project.Documents
            .Where(IsAnalyzableDocument)
            .Select(document => NormalizePath(document.FilePath!, repositoryRoot))
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();
        return new ProjectInfo(
            context.ProjectId,
            context.Project.Name,
            context.Project.FilePath is null ? null : NormalizePath(context.Project.FilePath, repositoryRoot),
            context.Project.AssemblyName ?? context.Project.Name,
            context.Project.Language,
            references,
            documents);
    }

    private static DocumentInfo DocumentInfoFor(
        Document document,
        string projectId,
        string repositoryRoot,
        CancellationToken cancellationToken)
    {
        if (document.FilePath is null)
        {
            throw new InvalidOperationException($"Document {document.Name} has no file path.");
        }

        var text = document.GetTextAsync(cancellationToken).GetAwaiter().GetResult();
        var bytes = Encoding.UTF8.GetBytes(text.ToString());
        return new DocumentInfo(
            NormalizePath(document.FilePath, repositoryRoot),
            projectId,
            "C#",
            text.Length,
            Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
    }

    private static EngineInfo EngineInfoFor()
    {
        var roslynVersion = typeof(CSharpCompilation).Assembly.GetName().Version?.ToString() ?? "unknown";
        var msbuildVersion = MSBuildLocator.QueryVisualStudioInstances()
            .OrderByDescending(instance => instance.Version)
            .FirstOrDefault()?.Version.ToString() ?? "unregistered";
        return new EngineInfo(
            "roslyn-msbuild",
            roslynVersion,
            roslynVersion,
            $".NET {Environment.Version}",
            msbuildVersion);
    }

    private static OwnershipInfo ComputeOwnership(
        IReadOnlyList<ProjectInfo> projects,
        IReadOnlyList<DocumentInfo> documents,
        IReadOnlyList<string> changedFiles)
    {
        var files = documents
            .GroupBy(document => document.Path, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First().ProjectId, StringComparer.Ordinal);
        var changedProjects = changedFiles
            .Where(files.ContainsKey)
            .Select(path => files[path])
            .ToHashSet(StringComparer.Ordinal);
        var projectById = projects.ToDictionary(project => project.Id, StringComparer.Ordinal);
        var impacted = changedProjects.ToHashSet(StringComparer.Ordinal);
        var changed = true;
        while (changed)
        {
            changed = false;
            foreach (var project in projects)
            {
                if (project.ProjectReferences.Any(impacted.Contains) && impacted.Add(project.Id))
                {
                    changed = true;
                }
            }
        }

        var impactedFiles = files
            .Where(pair => impacted.Contains(pair.Value))
            .Select(pair => pair.Key)
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();
        return new OwnershipInfo(
            new SortedDictionary<string, string>(files, StringComparer.Ordinal),
            new InvalidationInfo(
                changedFiles,
                impactedFiles,
                impacted.OrderBy(id => id, StringComparer.Ordinal).ToArray(),
                "changed file -> owning project -> transitive project dependents"));
    }

    private static string ProjectIdFor(string? projectPath, string name, string repositoryRoot)
    {
        if (projectPath is null)
        {
            return $"adhoc:{name}";
        }

        return NormalizePath(projectPath, repositoryRoot);
    }

    internal static string NormalizePath(string path, string repositoryRoot)
    {
        var absolute = CanonicalPath(path);
        var relative = Path.GetRelativePath(CanonicalPath(repositoryRoot), absolute);
        return relative == "." ? "." : relative.Replace(Path.DirectorySeparatorChar, '/');
    }

    private static string CanonicalPath(string path)
    {
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full)
                   ?? throw new InvalidOperationException($"Cannot determine path root for {path}.");
        var current = root;
        foreach (var segment in full[root.Length..].Split(
                     new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
                     StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, segment);
            if (!File.Exists(current) && !Directory.Exists(current))
            {
                continue;
            }

            FileSystemInfo info = Directory.Exists(current)
                ? new DirectoryInfo(current)
                : new FileInfo(current);
            current = info.ResolveLinkTarget(true)?.FullName ?? current;
        }

        return Path.GetFullPath(current);
    }

    internal static string NamespaceName(INamespaceSymbol symbol)
    {
        if (symbol.IsGlobalNamespace)
        {
            return GlobalNamespace;
        }

        var display = symbol.ToDisplayString();
        return string.IsNullOrEmpty(display) ? GlobalNamespace : display;
    }

    internal static string SymbolDisplay(ISymbol symbol)
    {
        var display = symbol switch
        {
            IMethodSymbol method =>
                $"{method.ContainingType?.ToDisplayString(FullyQualified)}.{method.Name}" +
                (method.Arity == 0 ? string.Empty : $"`{method.Arity}"),
            IPropertySymbol property =>
                $"{property.ContainingType?.ToDisplayString(FullyQualified)}.{property.Name}",
            IFieldSymbol field =>
                $"{field.ContainingType?.ToDisplayString(FullyQualified)}.{field.Name}",
            IEventSymbol @event =>
                $"{@event.ContainingType?.ToDisplayString(FullyQualified)}.{@event.Name}",
            IParameterSymbol parameter =>
                $"{SymbolDisplay(parameter.ContainingSymbol)}.{parameter.Name}",
            ILocalSymbol local =>
                $"{SymbolDisplay(local.ContainingSymbol)}.{local.Name}",
            _ => symbol.ToDisplayString(FullyQualified)
        };
        return display.Replace("global::", string.Empty, StringComparison.Ordinal);
    }

    internal sealed record ProjectContext(Project Project, string ProjectId);
    private sealed record LoadedWorkspace(IReadOnlyList<ProjectContext> Projects);

    private static bool IsAnalyzableDocument(Document document)
    {
        if (document.SourceCodeKind != SourceCodeKind.Regular ||
            document.FilePath is null ||
            !document.FilePath.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return IsAnalyzablePath(document.FilePath);
    }

    internal static bool IsAnalyzablePath(string path)
    {
        var normalized = path.Replace('\\', '/');
        var name = Path.GetFileName(normalized);
        return !normalized.Contains("/obj/", StringComparison.OrdinalIgnoreCase) &&
               !normalized.Contains("/bin/", StringComparison.OrdinalIgnoreCase) &&
               !normalized.Contains("/.nuget/", StringComparison.OrdinalIgnoreCase) &&
               !normalized.Contains("/generated/", StringComparison.OrdinalIgnoreCase) &&
               !name.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase) &&
               !name.EndsWith(".generated.cs", StringComparison.OrdinalIgnoreCase) &&
               !name.EndsWith(".designer.cs", StringComparison.OrdinalIgnoreCase) &&
               !name.Equals("AssemblyInfo.cs", StringComparison.OrdinalIgnoreCase);
    }
}

internal sealed class IrBuilder
{
    private readonly string repositoryRoot;
    private readonly IReadOnlyDictionary<string, string> sourceProjectIds;
    private readonly IReadOnlyDictionary<string, string> assemblyProjectIds;
    private readonly Dictionary<string, NodeBuilder> nodes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, RelationshipBuilder> relationships = new(StringComparer.Ordinal);
    private readonly List<Occurrence> occurrences = new();

    public IrBuilder(
        string repositoryRoot,
        IReadOnlyDictionary<string, string> sourceProjectIds,
        IReadOnlyDictionary<string, string> assemblyProjectIds,
        List<ParserDiagnostic> diagnostics)
    {
        this.repositoryRoot = repositoryRoot;
        this.sourceProjectIds = sourceProjectIds;
        this.assemblyProjectIds = assemblyProjectIds;
        Diagnostics = diagnostics;
    }

    public List<ParserDiagnostic> Diagnostics { get; }

    public IReadOnlyList<Node> Nodes => nodes.Values
        .Select(builder => builder.ToNode())
        .OrderBy(node => node.Id, StringComparer.Ordinal)
        .ToArray();

    public IReadOnlyList<Relationship> Relationships => relationships.Values
        .Select(builder => builder.ToRelationship())
        .OrderBy(relationship => relationship.Id, StringComparer.Ordinal)
        .ToArray();

    public IReadOnlyList<Occurrence> Occurrences => occurrences
        .OrderBy(occurrence => occurrence.File, StringComparer.Ordinal)
        .ThenBy(occurrence => occurrence.Span.Offset)
        .ThenBy(occurrence => occurrence.RelationshipId, StringComparer.Ordinal)
        .ToArray();

    public string NamespaceNode(
        string namespaceName,
        string projectId,
        string filePath,
        SyntaxNode syntax,
        string root)
    {
        var id = $"namespace:{projectId}:{namespaceName}";
        EnsureNode(
            id,
            "namespace",
            namespaceName,
            namespaceName,
            namespaceName,
            projectId,
            null,
            null,
            null,
            "namespace",
            false,
            false,
            false,
            false,
            false,
            false,
            null,
            root);
        return id;
    }

    public string DeclareNamespaceNode(
        string namespaceName,
        string projectId,
        string filePath,
        SyntaxNode syntax,
        string root)
    {
        return EnsureNode(
            $"namespace:{projectId}:{namespaceName}",
            "namespace",
            namespaceName,
            namespaceName,
            namespaceName,
            projectId,
            filePath,
            syntax,
            null,
            "namespace",
            false,
            false,
            false,
            false,
            false,
            false,
            null,
            root).Id;
    }

    public string AddSymbolNode(
        ISymbol symbol,
        string projectId,
        string filePath,
        SyntaxNode syntax,
        string root)
    {
        if (symbol is INamespaceSymbol namespaceSymbol)
        {
            var namespaceNodeName = CSharpSemanticAnalyzer.NamespaceName(namespaceSymbol);
            var namespaceProject = ProjectFor(symbol, projectId);
            var namespaceDeclarationFile = symbol.DeclaringSyntaxReferences
                .Where(reference => reference.Span == syntax.Span)
                .Select(_ => filePath)
                .FirstOrDefault();
            var namespaceDeclarationSyntax = namespaceDeclarationFile is null ? null : syntax;
            return EnsureNode(
                $"namespace:{namespaceProject}:{namespaceNodeName}",
                "namespace",
                namespaceNodeName,
                namespaceNodeName,
                namespaceNodeName,
                namespaceProject,
                IsExternal(symbol, projectId) ? null : namespaceDeclarationFile,
                namespaceDeclarationSyntax,
                null,
                "namespace",
                false,
                IsExternal(symbol, projectId),
                false,
                false,
                false,
                false,
                null,
                root).Id;
        }

        var display = CSharpSemanticAnalyzer.SymbolDisplay(symbol);
        var fallbackName = FallbackSymbolName(symbol, syntax, filePath, root);
        var qualifiedName = QualifiedSymbolName(symbol, display, fallbackName);
        var name = SymbolName(symbol, display, fallbackName);
        var signature = SymbolSignature(symbol, qualifiedName);
        var id = SymbolId(symbol, projectId, syntax, qualifiedName, signature);
        var external = IsExternal(symbol, projectId);
        var namespaceName = NamespaceFor(symbol);
        var declarationKind = symbol.Kind.ToString();
        var declarationFile = symbol.DeclaringSyntaxReferences
            .Where(reference => reference.Span == syntax.Span &&
                                string.Equals(reference.SyntaxTree?.FilePath, filePath,
                                    StringComparison.OrdinalIgnoreCase))
            .Select(_ => filePath)
            .FirstOrDefault();
        var declarationSyntax = declarationFile is null ? null : syntax;
        var node = EnsureNode(
            id,
            "var",
            name,
            qualifiedName,
            namespaceName,
            ProjectFor(symbol, projectId),
            external ? null : declarationFile,
            external ? null : declarationSyntax,
            signature,
            declarationKind,
            symbol.DeclaredAccessibility == Accessibility.Public,
            external,
            IsPartial(symbol, syntax),
            symbol is IMethodSymbol method && method.IsOverride,
            symbol.IsAbstract,
            symbol.IsStatic,
            null,
            root);

        var containing = symbol.ContainingSymbol;
        if (containing is not null && symbol.Kind != SymbolKind.Namespace)
        {
            var parentId = AddContainingNode(containing, projectId, filePath, syntax, root);
            if (parentId is not null && !string.Equals(parentId, id, StringComparison.Ordinal))
            {
                AddRelationship(
                    "contains",
                    parentId,
                    id,
                    new Resolution("resolved", 1, "roslyn-msbuild", RoslynVersion, Array.Empty<string>()),
                    filePath,
                    syntax,
                    syntax.SyntaxTree.GetText(),
                    "declaration");
            }
        }

        return node.Id;
    }

    public string SourceNode(
        SemanticModel model,
        int position,
        string projectId,
        string filePath,
        SyntaxNode syntax,
        string root)
    {
        for (var symbol = model.GetEnclosingSymbol(position);
             symbol is not null;
             symbol = symbol.ContainingSymbol)
        {
            if (symbol.Kind is SymbolKind.Method or SymbolKind.NamedType or SymbolKind.Property or
                SymbolKind.Field or SymbolKind.Event or SymbolKind.Local or SymbolKind.Parameter)
            {
                return AddSymbolNode(symbol, projectId, filePath, syntax, root);
            }
        }

        return NamespaceNode(
            NamespaceAt(model, position),
            projectId,
            filePath,
            syntax,
            root);
    }

    public void AddSymbolRelationship(
        string kind,
        string source,
        ISymbol target,
        string projectId,
        string filePath,
        SyntaxNode syntax,
        SourceText sourceText,
        string root,
        string? detail)
    {
        var targetId = AddSymbolNode(
            target,
            projectId,
            filePath,
            syntax,
            root);
        var status = IsExternal(target, projectId)
            ? "external"
            : target is IErrorTypeSymbol || string.IsNullOrWhiteSpace(target.Name)
                ? "unresolved"
                : "resolved";
        var confidence = status switch
        {
            "external" => 0.95,
            "unresolved" => 0,
            _ => 1.0
        };
        AddRelationship(
            kind,
            source,
            targetId,
            new Resolution(status, confidence, "roslyn-msbuild", RoslynVersion, Array.Empty<string>()),
            filePath,
            syntax,
            sourceText,
            detail);
    }

    public void AddAmbiguousRelationship(
        string kind,
        string source,
        string expression,
        ImmutableArray<ISymbol> candidates,
        string projectId,
        string filePath,
        SyntaxNode syntax,
        SourceText sourceText,
        string root)
    {
        var candidateIds = candidates
            .Select(candidate => AddSymbolNode(candidate, projectId, filePath, syntax, root))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToArray();
        var relativeFile = CSharpSemanticAnalyzer.NormalizePath(filePath, repositoryRoot);
        var target = $"ambiguous:{StableHash($"{kind}|{source}|{relativeFile}|{syntax.SpanStart}|{expression}")}";
        EnsureSyntheticNode(target, expression, "ambiguous", projectId);
        AddRelationship(
            kind,
            source,
            target,
            new Resolution("ambiguous", 0.5, "roslyn-msbuild", RoslynVersion, candidateIds),
            filePath,
            syntax,
            sourceText,
            "candidate overloads");
    }

    public void AddUnresolvedRelationship(
        string kind,
        string source,
        string expression,
        string projectId,
        string filePath,
        SyntaxNode syntax,
        SourceText sourceText,
        string root)
    {
        var relativeFile = CSharpSemanticAnalyzer.NormalizePath(filePath, root);
        var target = $"unresolved:{StableHash($"{kind}|{source}|{relativeFile}|{syntax.SpanStart}|{expression}")}";
        EnsureSyntheticNode(target, expression, "unresolved", projectId);
        AddRelationship(
            kind,
            source,
            target,
            new Resolution("unresolved", 0, "roslyn-msbuild", RoslynVersion, Array.Empty<string>()),
            filePath,
            syntax,
            sourceText,
            "semantic model returned no symbol");
    }

    public void AddDiagnostic(Diagnostic diagnostic, string projectId, string root)
    {
        if (diagnostic.Location.IsInSource &&
            diagnostic.Location.SourceTree?.FilePath is { } diagnosticPath &&
            !CSharpSemanticAnalyzer.IsAnalyzablePath(diagnosticPath))
        {
            return;
        }

        var span = diagnostic.Location.IsInSource
            ? SpanFor(diagnostic.Location.SourceTree?.FilePath ?? string.Empty,
                diagnostic.Location.SourceSpan,
                diagnostic.Location.SourceTree?.GetText() ?? SourceText.From(string.Empty),
                root)
            : null;
        Diagnostics.Add(new ParserDiagnostic(
            diagnostic.Severity.ToString().ToLowerInvariant(),
            diagnostic.GetMessage(),
            diagnostic.Id,
            projectId,
            diagnostic.Location.IsInSource && diagnostic.Location.SourceTree?.FilePath is { } path
                ? CSharpSemanticAnalyzer.NormalizePath(path, root)
                : null,
            span));
    }

    private NodeBuilder EnsureNode(
        string id,
        string kind,
        string name,
        string? fqn,
        string namespaceName,
        string projectId,
        string? filePath,
        SyntaxNode? syntax,
        string? signature,
        string? declarationKind,
        bool exported,
        bool external,
        bool partial,
        bool overrideSymbol,
        bool abstractSymbol,
        bool staticSymbol,
        string? containerId,
        string root)
    {
        if (!nodes.TryGetValue(id, out var node))
        {
            node = new NodeBuilder(
                id,
                kind,
                name,
                fqn,
                namespaceName,
                projectId,
                signature,
                declarationKind,
                exported,
                external,
                partial,
                overrideSymbol,
                abstractSymbol,
                staticSymbol,
                containerId);
            nodes.Add(id, node);
        }

        if (filePath is not null && syntax is not null)
        {
            node.AddDeclaration(
                CSharpSemanticAnalyzer.NormalizePath(filePath, root),
                SpanFor(filePath, syntax.Span, syntax.SyntaxTree.GetText(), root));
        }

        return node;
    }

    private string? AddContainingNode(
        ISymbol containing,
        string projectId,
        string filePath,
        SyntaxNode syntax,
        string root)
    {
        if (containing is INamespaceSymbol namespaceSymbol)
        {
            return AddSymbolNode(namespaceSymbol, projectId, filePath, syntax, root);
        }

        if (containing is IMethodSymbol or INamedTypeSymbol or IPropertySymbol or IFieldSymbol or
            IEventSymbol or ILocalSymbol or IParameterSymbol)
        {
            return AddSymbolNode(containing, projectId, filePath, syntax, root);
        }

        return null;
    }

    private string SymbolId(
        ISymbol symbol,
        string projectId,
        SyntaxNode syntax,
        string display,
        string signature)
    {
        if (symbol is ILocalSymbol or IParameterSymbol)
        {
            var declarationOffset = symbol.DeclaringSyntaxReferences
                .Select(reference => reference.Span.Start)
                .FirstOrDefault(syntax.SpanStart);
            return $"var:{projectId}:V:{display}@{declarationOffset}";
        }

        return $"var:{ProjectFor(symbol, projectId)}:{signature}";
    }

    private static string SymbolSignature(ISymbol symbol, string display)
    {
        return symbol switch
        {
            INamespaceSymbol => $"N:{display}",
            INamedTypeSymbol => $"T:{display}",
            IMethodSymbol method =>
                $"M:{display}({string.Join(",", method.Parameters.Select(parameter => ParameterType(parameter)))})",
            IPropertySymbol property => $"P:{display}:{TypeDisplay(property.Type)}",
            IFieldSymbol field => $"F:{display}:{TypeDisplay(field.Type)}",
            IEventSymbol @event => $"E:{display}:{TypeDisplay(@event.Type)}",
            IParameterSymbol parameter => $"V:{display}:{TypeDisplay(parameter.Type)}",
            ILocalSymbol local => $"V:{display}:{TypeDisplay(local.Type)}",
            _ => $"{symbol.Kind}:{display}"
        };
    }

    private static string ParameterType(IParameterSymbol parameter) =>
        $"{parameter.RefKind}:{TypeDisplay(parameter.Type)}";

    private static string TypeDisplay(ITypeSymbol type) =>
        NonEmptySegment(
            type.ToDisplayString(CSharpSemanticAnalyzer.FullyQualified)
                .Replace("global::", string.Empty, StringComparison.Ordinal),
            type.Kind.ToString());

    private string FallbackSymbolName(ISymbol symbol, SyntaxNode syntax, string filePath, string root)
    {
        var relativeFile = CSharpSemanticAnalyzer.NormalizePath(filePath, root);
        var role = symbol.Kind.ToString().ToLowerInvariant();
        var hash = StableHash(
            $"{role}|{relativeFile}|{syntax.SpanStart}|{syntax.Span.Length}|{syntax}");
        return $"<{role}:{hash}>";
    }

    private static string SymbolName(ISymbol symbol, string display, string fallbackName)
    {
        if (!string.IsNullOrWhiteSpace(symbol.Name))
        {
            return symbol.Name;
        }

        var terminal = display
            .Split('.', StringSplitOptions.RemoveEmptyEntries)
            .LastOrDefault();
        return NonEmptySegment(terminal, fallbackName);
    }

    private static string QualifiedSymbolName(ISymbol symbol, string display, string fallbackName)
    {
        if (!string.IsNullOrWhiteSpace(display) && !display.EndsWith(".", StringComparison.Ordinal))
        {
            return display;
        }

        var containing = symbol.ContainingSymbol is null
            ? string.Empty
            : CSharpSemanticAnalyzer.SymbolDisplay(symbol.ContainingSymbol);
        if (!string.IsNullOrWhiteSpace(containing) && !containing.EndsWith(".", StringComparison.Ordinal))
        {
            return $"{containing}.{fallbackName}";
        }

        return fallbackName;
    }

    private static string NonEmptySegment(string? value, string fallback) =>
        string.IsNullOrWhiteSpace(value) ? fallback : value;

    private static string NamespaceFor(ISymbol symbol)
    {
        var containing = symbol.ContainingNamespace;
        return containing is null ? CSharpSemanticAnalyzer.GlobalNamespace : CSharpSemanticAnalyzer.NamespaceName(containing);
    }

    private static string NamespaceAt(SemanticModel model, int position)
    {
        for (var symbol = model.GetEnclosingSymbol(position); symbol is not null; symbol = symbol.ContainingSymbol)
        {
            if (symbol is INamespaceSymbol namespaceSymbol)
            {
                return CSharpSemanticAnalyzer.NamespaceName(namespaceSymbol);
            }
        }

        return CSharpSemanticAnalyzer.GlobalNamespace;
    }

    private bool IsExternal(ISymbol symbol, string projectId)
    {
        var assemblyName = symbol.ContainingAssembly?.Name;
        return assemblyName is null ||
               (!assemblyProjectIds.ContainsKey(assemblyName) &&
                symbol.Locations.All(location => !location.IsInSource));
    }

    private static bool IsPartial(ISymbol symbol, SyntaxNode syntax) =>
        syntax switch
        {
            BaseTypeDeclarationSyntax declaration =>
                declaration.Modifiers.Any(SyntaxKind.PartialKeyword) ||
                symbol.DeclaringSyntaxReferences.Length > 1,
            MethodDeclarationSyntax declaration =>
                declaration.Modifiers.Any(SyntaxKind.PartialKeyword) ||
                symbol.DeclaringSyntaxReferences.Length > 1,
            _ => symbol.DeclaringSyntaxReferences.Length > 1
        };

    private string ProjectFor(ISymbol symbol, string projectId)
    {
        if (!IsExternal(symbol, projectId))
        {
            if (symbol.ContainingAssembly?.Name is { } assemblyName &&
                assemblyProjectIds.TryGetValue(assemblyName, out var assemblyProject))
            {
                return assemblyProject;
            }

            var sourcePath = symbol.Locations
                .Where(location => location.IsInSource && location.SourceTree?.FilePath is not null)
                .Select(location => CSharpSemanticAnalyzer.NormalizePath(location.SourceTree!.FilePath!, repositoryRoot))
                .Select(path => sourceProjectIds.TryGetValue(path, out var owner) ? owner : null)
                .FirstOrDefault(owner => owner is not null);
            return sourcePath ?? projectId;
        }

        var assembly = symbol.ContainingAssembly?.Name ?? "external";
        return $"external:{assembly}";
    }

    private void EnsureSyntheticNode(string id, string name, string declarationKind, string projectId)
    {
        if (!nodes.ContainsKey(id))
        {
            var stableName = NonEmptySegment(name, $"<{declarationKind}:{StableHash(id)}>");
            nodes[id] = new NodeBuilder(
                id,
                "var",
                stableName,
                id,
                CSharpSemanticAnalyzer.GlobalNamespace,
                projectId,
                null,
                declarationKind,
                false,
                false,
                false,
                false,
                false,
                false,
                null);
        }
    }

    private void AddRelationship(
        string kind,
        string source,
        string target,
        Resolution resolution,
        string filePath,
        SyntaxNode syntax,
        SourceText sourceText,
        string? detail)
    {
        var file = CSharpSemanticAnalyzer.NormalizePath(filePath, repositoryRoot);
        var span = SpanFor(filePath, syntax.Span, sourceText, repositoryRoot);
        var id = $"{kind}:{source}->{target}";
        if (!relationships.TryGetValue(id, out var relationship))
        {
            relationship = new RelationshipBuilder(id, kind, source, target, resolution);
            relationships.Add(id, relationship);
        }

        var occurrenceId = $"{id}:{file}:{span.Offset}";
        relationship.OccurrenceIds.Add(occurrenceId);
        occurrences.Add(new Occurrence(
            occurrenceId,
            id,
            file,
            span,
            sourceText.ToString(syntax.Span),
            detail));
    }

    private static Span SpanFor(string filePath, TextSpan textSpan, SourceText source, string root)
    {
        var start = source.Lines.GetLinePosition(textSpan.Start);
        var end = source.Lines.GetLinePosition(textSpan.End);
        return new Span(
            new Position(start.Line, start.Character),
            new Position(end.Line, end.Character),
            textSpan.Start,
            textSpan.Length);
    }

    private static string StableHash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()[..16];

    private static string RoslynVersion =>
        typeof(Microsoft.CodeAnalysis.CSharp.CSharpCompilation).Assembly.GetName().Version?.ToString()
        ?? "unknown";

    private sealed class NodeBuilder
    {
        private readonly List<Span> declarationSpans = new();

        public NodeBuilder(
            string id,
            string kind,
            string name,
            string? fqn,
            string namespaceName,
            string projectId,
            string? signature,
            string? declarationKind,
            bool exported,
            bool external,
            bool partial,
            bool overrideSymbol,
            bool abstractSymbol,
            bool staticSymbol,
            string? containerId)
        {
            Id = id;
            Kind = kind;
            Name = name;
            FullyQualifiedName = fqn;
            Namespace = namespaceName;
            ProjectId = projectId;
            Signature = signature;
            DeclarationKind = declarationKind;
            IsExported = exported;
            IsExternal = external;
            IsPartial = partial;
            IsOverride = overrideSymbol;
            IsAbstract = abstractSymbol;
            IsStatic = staticSymbol;
            ContainerId = containerId;
        }

        public string Id { get; }
        public string Kind { get; }
        public string Name { get; }
        public string? FullyQualifiedName { get; }
        public string Namespace { get; }
        public string ProjectId { get; }
        public string? Signature { get; }
        public string? DeclarationKind { get; }
        public bool IsExported { get; }
        public bool IsExternal { get; }
        public bool IsPartial { get; }
        public bool IsOverride { get; }
        public bool IsAbstract { get; }
        public bool IsStatic { get; }
        public string? ContainerId { get; }
        public string? File { get; private set; }
        public string Visibility => IsExternal ? "external" : IsExported ? "public" : "non-public";

        public void AddDeclaration(string file, Span span)
        {
            File ??= file;
            if (!declarationSpans.Contains(span))
            {
                declarationSpans.Add(span);
            }
        }

        public Node ToNode()
        {
            var declarations = declarationSpans
                .OrderBy(span => span.Offset)
                .ThenBy(span => span.Start.Line)
                .ToArray();
            return new Node(
                Id,
                Kind,
                Name,
                FullyQualifiedName,
                Namespace,
                ProjectId,
                File,
                declarations.FirstOrDefault(),
                declarations,
                Signature,
                DeclarationKind,
                Visibility,
                IsExported,
                IsExternal,
                IsPartial,
                IsOverride,
                IsAbstract,
                IsStatic,
                ContainerId);
        }
    }

    private sealed class RelationshipBuilder
    {
        public RelationshipBuilder(
            string id,
            string kind,
            string source,
            string target,
            Resolution resolution)
        {
            Id = id;
            Kind = kind;
            Source = source;
            Target = target;
            Resolution = resolution;
        }

        public string Id { get; }
        public string Kind { get; }
        public string Source { get; }
        public string Target { get; }
        public Resolution Resolution { get; }
        public List<string> OccurrenceIds { get; } = new();

        public Relationship ToRelationship() =>
            new(
                Id,
                Kind,
                Source,
                Target,
                Resolution,
                OccurrenceIds.Distinct(StringComparer.Ordinal).OrderBy(id => id, StringComparer.Ordinal).ToArray());
    }
}
