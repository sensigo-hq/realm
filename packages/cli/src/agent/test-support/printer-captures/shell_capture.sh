#!/usr/bin/env bash
# shell_capture.sh — bash printf %q, ${v@Q}, xtrace (set -x), declare -p; jq @sh/@uri/@html/@csv/tojson/@base64;
# perl Data::Dumper (default and Useqq) and JSON::PP — over the FAKE inputs named on the command line (a JSON
# object: case id -> value). One JSON line per (printer, case). Values reach bash through env var V only.
src="$1"
jq -r 'to_entries[] | .key' "$src" | while read -r c; do
  # NUL cannot live in a bash variable; the bash printers record SKIP for such a value (problem 11)
  has_nul=$(jq -r --arg c "$c" '.[$c] | contains("\u0000")' "$src")
  if [ "$has_nul" = "true" ]; then
    for p in bash.printf_q bash.at_Q bash.xtrace bash.declare_p; do jq -cn --arg p $p --arg c "$c" '{p:$p,c:$c,out:"SKIP (NUL)"}'; done
  else
    V="$(jq -j --arg c "$c" '.[$c]' "$src"; printf x)"; V="${V%x}"
    out=$(printf '%q' "$V"); jq -cn --arg p bash.printf_q --arg c "$c" --arg o "$out" '{p:$p,c:$c,out:$o}'
    out="${V@Q}"; jq -cn --arg p bash.at_Q --arg c "$c" --arg o "$out" '{p:$p,c:$c,out:$o}'
    out=$(V="$V" bash -c 'set -x; : "$V"' 2>&1 >/dev/null); jq -cn --arg p bash.xtrace --arg c "$c" --arg o "$out" '{p:$p,c:$c,out:$o}'
    out=$(declare -p V); jq -cn --arg p bash.declare_p --arg c "$c" --arg o "$out" '{p:$p,c:$c,out:$o}'
  fi
  for f in 'tojson' '@sh' '@uri' '@html' '@csv' '@base64'; do
    if [ "$f" = "@csv" ]; then expr="[.[\$c]] | @csv"; else expr=".[\$c] | $f"; fi
    out=$(jq -r --arg c "$c" "$expr" "$src"); jq -cn --arg p "jq.$f" --arg c "$c" --arg o "$out" '{p:$p,c:$c,out:$o}'
  done
done
perl -MJSON::PP -MData::Dumper -e '
  my $j = JSON::PP->new->utf8(0)->canonical; my $raw = do { local $/; open my $fh, "<", $ARGV[0]; <$fh> };
  my $cases = JSON::PP->new->utf8->decode($raw);  # character strings
  my $out = JSON::PP->new->canonical->ascii;  # capture lines ASCII-safe
  for my $c (sort keys %$cases) { my $v = $cases->{$c};
    local $Data::Dumper::Terse = 1; local $Data::Dumper::Indent = 0;
    { local $Data::Dumper::Useqq = 0; print $out->encode({p=>"perl.Dumper", c=>$c, out=>Dumper($v)}), "\n"; }
    { local $Data::Dumper::Useqq = 1; print $out->encode({p=>"perl.Dumper_Useqq", c=>$c, out=>Dumper($v)}), "\n"; }
    print $out->encode({p=>"perl.JSON::PP", c=>$c, out=>$j->encode([$v])}), "\n";
    print $out->encode({p=>"perl.JSON::PP_ascii", c=>$c, out=>JSON::PP->new->ascii->encode([$v])}), "\n";
  }' "$src"
