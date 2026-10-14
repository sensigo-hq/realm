// dotnet capture (printer captures, FAKE values only). Compiles GitHub's runner file
// src/Sdk/DTLogging/Logging/ValueEncoders.cs UNCHANGED (ValueEncoders.cs beside this file; identical to actions/runner
// main 67f01c276e, last changed 67d70803a9), plus the one body it calls that lives elsewhere
// (src/Sdk/DTExpressions2/Expressions2/Sdk/ExpressionUtility.cs:260-263, copied verbatim below).
// Packages: Newtonsoft.Json 13.0.3 (the runner's Sdk.csproj pin), Microsoft.Security.Utilities.Core (NuGet, latest),
// System.Text.Json (in-box). Reads {c, v} JSON lines on stdin; writes {p, c, hex (UTF-8), u16 (code units), err}.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using GitHub.DistributedTask.Logging;
using Microsoft.Security.Utilities;

namespace GitHub.DistributedTask.Expressions2.Sdk
{
    internal static class ExpressionUtility
    {
        internal static String StringEscape(String value)
        {
            return String.IsNullOrEmpty(value) ? String.Empty : value.Replace("'", "''");
        }
    }
}

public static class Cap
{
    static string Hex(string s) => Convert.ToHexString(new UTF8Encoding(false, false).GetBytes(s)).ToLowerInvariant();
    static string U16(string s) { var sb = new StringBuilder(); foreach (var ch in s) sb.Append(((int)ch).ToString("x4")); return sb.ToString(); }

    public static void Main(string[] args)
    {
        var tag = args.Length > 0 ? args[0] : "";
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        bool invariantMode = false;
        try { invariantMode = CultureInfo.GetCultureInfo("en-US").Name == ""; } catch { invariantMode = true; }
        var meta = new Dictionary<string, string?> {
            ["p"] = "meta" + tag, ["c"] = "-",
            ["runtime"] = Environment.Version.ToString(),
            ["framework"] = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
            ["culture"] = CultureInfo.CurrentCulture.Name,
            ["invariantEnv"] = Environment.GetEnvironmentVariable("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT"),
            ["icuProbe_IndexOf_nul"] = "a\u0000&+b".IndexOf("&+").ToString(),
            ["icuProbe_LastIndexOf_combining"] = "a&́b".LastIndexOf("&").ToString(),
            ["newtonsoft"] = typeof(Newtonsoft.Json.JsonConvert).Assembly.GetName().Version?.ToString(),
            ["newtonsoftFile"] = System.Diagnostics.FileVersionInfo.GetVersionInfo(typeof(Newtonsoft.Json.JsonConvert).Assembly.Location).ProductVersion,
            ["msu"] = System.Diagnostics.FileVersionInfo.GetVersionInfo(typeof(WellKnownLiteralEncoders).Assembly.Location).ProductVersion,
            ["stj"] = System.Diagnostics.FileVersionInfo.GetVersionInfo(typeof(JsonSerializer).Assembly.Location).ProductVersion,
        };
        stdout.WriteLine(JsonSerializer.Serialize(meta));
        string? line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            using var doc = JsonDocument.Parse(line);
            var c = doc.RootElement.GetProperty("c").GetString()!;
            var v = doc.RootElement.GetProperty("v").GetString()!;
            void E(string p, Func<string> f)
            {
                string o = ""; string? err = null;
                try { o = f(); } catch (Exception ex) { err = ex.GetType().Name + ": " + ex.Message; }
                var row = new Dictionary<string, string?> { ["p"] = p + tag, ["c"] = c, ["hex"] = Hex(o), ["u16"] = U16(o), ["err"] = err };
                stdout.WriteLine(JsonSerializer.Serialize(row));
            }
            E("gh.JsonStringEscape", () => ValueEncoders.JsonStringEscape(v));
            E("newtonsoft.JsonConvert.ToString", () => Newtonsoft.Json.JsonConvert.ToString(v));
            E("newtonsoft.SerializeObject_obj", () => Newtonsoft.Json.JsonConvert.SerializeObject(new Dictionary<string, string> { ["k"] = v }));
            E("stj.Serialize", () => JsonSerializer.Serialize(v));
            E("stj.Serialize_obj", () => JsonSerializer.Serialize(new Dictionary<string, string> { ["k"] = v }));
            E("gh.CommandLineArgumentEscape", () => ValueEncoders.CommandLineArgumentEscape(v));
            E("gh.ExpressionStringEscape", () => ValueEncoders.ExpressionStringEscape(v));
            E("gh.TrimDoubleQuotes", () => ValueEncoders.TrimDoubleQuotes(v));
            E("gh.PowerShellPreAmpersandEscape", () => ValueEncoders.PowerShellPreAmpersandEscape(v));
            E("gh.PowerShellPostAmpersandEscape", () => ValueEncoders.PowerShellPostAmpersandEscape(v));
            E("gh.XmlDataEscape", () => ValueEncoders.XmlDataEscape(v));
            E("gh.UriDataEscape", () => ValueEncoders.UriDataEscape(v));
            E("gh.Base64StringEscape", () => ValueEncoders.Base64StringEscape(v));
            E("gh.Base64StringEscapeShift1", () => ValueEncoders.Base64StringEscapeShift1(v));
            E("gh.Base64StringEscapeShift2", () => ValueEncoders.Base64StringEscapeShift2(v));
            E("msu.UnescapeBackslashes", () => WellKnownLiteralEncoders.UnescapeBackslashes(v));
        }
        stdout.Flush();
    }
}
