global using System.Text;
using Text = System.Text;
using static System.Math;
using Missing = Missing.Namespace;

namespace Block.One
{
    public sealed class First
    {
        public StringBuilder Build() => new();
    }
}

namespace Block.Two
{
    using System.Linq;

    public sealed class Second
    {
        public Text.StringBuilder Build() => new();
    }
}
