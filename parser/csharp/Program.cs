using System.Text.Json;
using System.Text.Json.Serialization;

namespace Codewalk.CSharp;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static async Task<int> Main(string[] args)
    {
        try
        {
            var options = CliOptions.Parse(args);
            if (options.Help)
            {
                Console.WriteLine(CliOptions.Usage);
                return 0;
            }

            if (options.SelfTest)
            {
                if (options.UpdateGolden)
                {
                    await SelfTest.WriteGoldenAsync();
                }
                await SelfTest.RunAsync();
                Console.WriteLine("C# parser self-test passed.");
                return 0;
            }

            if (options.Input is null)
            {
                Console.Error.WriteLine(CliOptions.Usage);
                return 2;
            }

            var repoRoot = Path.GetFullPath(options.RepoRoot ?? FindRepositoryRoot(options.Input));
            var input = Path.GetFullPath(options.Input);
            var result = await CSharpSemanticAnalyzer.AnalyzeAsync(
                input,
                repoRoot,
                options.ChangedFiles,
                CancellationToken.None);
            var json = JsonSerializer.Serialize(result, JsonOptions) + Environment.NewLine;

            if (options.UpdateGolden)
            {
                if (options.Output is null)
                {
                    throw new InvalidOperationException("--update-golden requires --out.");
                }
            }

            if (options.Output is null)
            {
                Console.Write(json);
            }
            else
            {
                var output = Path.GetFullPath(options.Output);
                Directory.CreateDirectory(Path.GetDirectoryName(output)!);
                await File.WriteAllTextAsync(output, json);
                Console.WriteLine($"Wrote {output}");
            }

            return result.Diagnostics.Any(d => d.Severity == "error") ? 1 : 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"C# parser failed: {exception.Message}");
            return 1;
        }
    }

    private static string FindRepositoryRoot(string input)
    {
        var directory = Directory.Exists(input)
            ? new DirectoryInfo(input)
            : new FileInfo(input).Directory
              ?? throw new InvalidOperationException($"Cannot find directory for {input}.");

        for (var current = directory; current is not null; current = current.Parent)
        {
            if (Directory.Exists(Path.Combine(current.FullName, ".git")))
            {
                return current.FullName;
            }
        }

        return directory.FullName;
    }
}

internal sealed record CliOptions(
    string? Input,
    string? RepoRoot,
    string? Output,
    IReadOnlyList<string> ChangedFiles,
    bool SelfTest,
    bool UpdateGolden,
    bool Help)
{
    public const string Usage = """
        Usage:
          dotnet run --project parser/csharp/Codewalk.CSharp.csproj -- <input> [options]
          dotnet run --project parser/csharp/Codewalk.CSharp.csproj -- --self-test

        Options:
          --repo-root DIR       Repository root for portable paths (default: nearest .git)
          --changed FILE        Changed repository-relative file (repeatable)
          --out FILE            Write deterministic IR JSON instead of stdout
          --update-golden       Require --out and write the requested golden output
          --self-test           Analyze fixtures and run deterministic semantic checks
          --help                Show this help
        """;

    public static CliOptions Parse(string[] args)
    {
        string? input = null;
        string? repoRoot = null;
        string? output = null;
        var changed = new List<string>();
        var selfTest = false;
        var updateGolden = false;
        var help = false;

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--repo-root":
                    repoRoot = NextValue(args, ref index);
                    break;
                case "--changed":
                    changed.Add(NextValue(args, ref index));
                    break;
                case "--out":
                    output = NextValue(args, ref index);
                    break;
                case "--self-test":
                    selfTest = true;
                    break;
                case "--update-golden":
                    updateGolden = true;
                    break;
                case "--help" or "-h":
                    help = true;
                    break;
                default:
                    if (args[index].StartsWith("-", StringComparison.Ordinal))
                    {
                        throw new ArgumentException($"Unknown option {args[index]}.");
                    }

                    input ??= args[index];
                    break;
            }
        }

        return new CliOptions(input, repoRoot, output, changed, selfTest, updateGolden, help);
    }

    private static string NextValue(string[] args, ref int index)
    {
        if (++index >= args.Length)
        {
            throw new ArgumentException($"Missing value for {args[index - 1]}.");
        }

        return args[index];
    }
}
