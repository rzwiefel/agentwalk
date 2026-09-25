namespace Regression;

public static class DiagnosticsFixture
{
    public static void Run()
    {
        var first = MissingFactory.Create<MissingType>();
        var second = MissingFactory.Create<MissingType>();
        var third = MissingFactory.MissingMember();
        var fourth = MissingFactory.MissingMember();
    }
}
