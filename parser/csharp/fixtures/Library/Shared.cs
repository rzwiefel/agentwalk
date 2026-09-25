namespace Sample.Library;

public interface IWorker
{
    string Run(string input);
}

public class BaseWorker
{
    public virtual string Run(string input) => input;
}

public partial class Shared : BaseWorker, IWorker
{
    public override string Run(string input) => input;

    public int Overload(int value) => value;
}
