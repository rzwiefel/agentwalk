using System;
using Lib = Sample.Library;
using static Sample.Library.Shared;

namespace Sample.App;

public static class Program
{
    public static string Execute(string text)
    {
        var shared = new Lib.Shared();
        var result = shared.Overload(text);
        var inherited = shared.Run(text);
        Console.WriteLine(inherited);
        UnknownFactory.Create();
        return inherited;
    }

    public static void Main() => Execute("fixture");
}
