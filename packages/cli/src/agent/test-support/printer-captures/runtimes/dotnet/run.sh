# runs inside mcr.microsoft.com/dotnet/sdk:<ver>; files arrive by stdin (mkbundle.mjs)
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
cd /w && mkdir app && cd app
dotnet new console --force -o . >/dev/null </dev/null
rm -f Program.cs
cp /w/Program.cs /w/ValueEncoders.cs .
dotnet add package Newtonsoft.Json --version 13.0.3 >/dev/null </dev/null
dotnet add package Microsoft.Security.Utilities.Core --version 1.21.0 >/dev/null </dev/null
dotnet build -c Release -o out 2>&1 </dev/null | grep -E "error|Warn|Build succeeded" | grep -v "warning CS86" >&2 || true
dotnet list package >&2 </dev/null
dotnet --version >&2
DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 dotnet out/app.dll @inv < /w/inputs.jsonl
# Invariant globalization only: realm follows GitHub's PowerShell sections under ordinal search; the
# runner's own ICU mode differs on an `&` or `+` followed by a combining mark (problem 9).
