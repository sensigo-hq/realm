# BusyBox ash capture (printer captures, FAKE values only): `set -x` of `: "$V"`, as Jenkins' Almquist shell
# factory masks it. Reads lines `<case id> <base64 of the value>` on stdin (a value holding NUL is never sent:
# a shell cannot hold one); writes {p, c, hex (UTF-8 of the xtrace line)}.
printf '{"p":"meta","c":"-","busybox":"%s"}\n' "$(busybox 2>&1 | head -1 | tr -d '"')"
while read -r c b64; do
  V=$(printf '%s' "$b64" | base64 -d; printf x)
  V=${V%x}
  out=$( (set -x; : "$V") 2>&1 )
  hex=$(printf '%s' "$out" | od -An -tx1 | tr -d ' \n')
  printf '{"p":"busybox.ash_xtrace","c":"%s","hex":"%s"}\n' "$c" "$hex"
done
