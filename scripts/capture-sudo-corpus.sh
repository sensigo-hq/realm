#!/usr/bin/env bash
# capture-sudo-corpus.sh — #819 Unit A (A2): real sudo's printouts and verdicts, the oracle of
# packages/cli/src/lib/separation/sudo-corpus.test.ts. Re-run it when a new sudo ships in a supported
# image (the pre-publication checklist, Part B), then commit what it writes.
#
# Each image runs in a throwaway container (`docker run --rm -i`, no --privileged, no host mount). In
# it, the crafted sudoers (fixtures/corpus/sudoers.corpus) and each scenario's rules are installed
# (visudo -cf first), and sudo is asked as the fictional login `agent` through a copy of the check's
# own spawn (runner.ts: env PATH, plus LC_ALL=C for the listing; stdio ignore/pipe/pipe, so sudo's
# stdout is a socket, never a FIFO) — at 80 columns with no terminal, and for the corpus also under
# `script` terminals of 30x60 and 50x200 (`su --session-command`, which keeps the terminal; `su -c`
# drops it). Every lookup the reader makes is recorded beside each listing, and each scenario's real
# `sudo -n -u svc /usr/bin/true` is run and kept with its exit status. Fixtures land in
# fixtures/corpus/<image>/, in the captured-call format (`# captured …` header, `exit N`,
# `--- stdout`, `--- stderr`); a copied file is its header line and the file's text.
#
# usage: scripts/capture-sudo-corpus.sh [image …]        (on WSL: DOCKER=docker.exe)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
corpus="$repo/packages/cli/src/lib/separation/fixtures/corpus"
docker=${DOCKER:-docker}
date=${CAPTURE_DATE:-$(date -u +%Y-%m-%d)}
if [ "$#" -gt 0 ]; then images=("$@"); else
  images=(ubuntu:20.04 ubuntu:22.04 ubuntu:24.04 debian:stable fedora:latest rockylinux:9)
fi

# The scenarios each image runs (sudo-corpus.test.ts reads the same names):
#   main          the crafted sudoers, -l and -ll at three widths (T1)
#   long-target   a Defaults! target over 75 characters, first in its section: a 3-space first line (T1)
#   b3, b4        the crown's shapes (`passprompt=Password\\`, `passprompt=Pass\ word\\`) with !authenticate (T1, T3)
#   b1a, b1b      the second prompt audit's B1 printouts: two sources print the same text (T2)
#   p2-a, p2-b    W-UA-L3-14's pair: one printout, real verdicts rc 0 and rc 1 (T2, T3)
#   grp-*, plugin*, runaspw-*, norunas    item 2's, the group plugin's, item 7's and D7b's verdicts (T3)
scenarios() {
  local base="main long-target b3 b4 b1a b1b p2-a p2-b"
  case "$1" in
    ubuntu:24.04) echo "$base grp-default grp-nocase grp-bygid plugin plugin-colon runaspw-nosuchuser runaspw-ROOT runaspw-hash0 runaspw-svc norunas" ;;
    fedora:latest) echo "$base grp-fedora grp-fedora-nogid runaspw-nosuchuser runaspw-ROOT runaspw-hash0 runaspw-svc norunas" ;;
    ubuntu:20.04) echo "$base runaspw-nosuchuser runaspw-ROOT runaspw-hash0 runaspw-svc norunas" ;;
    *) echo "$base" ;;
  esac
}

# The script one container runs: it stages its body in a file and runs it with stdin from /dev/null,
# so `script` and `su` cannot read the rest of it (L3's Fedora and Rocky lesson).
container_script() {
  local image=$1 digest=$2
  cat <<EOF
cat > /tmp/runjs <<'EOJ'
// The separation check's spawn (runner.ts): env PATH, plus LC_ALL=C when argv opens with it; stdio
// ignore/pipe/pipe; no shell. Writes one fixture: its header line, then the call's exit and output.
var spawn = require('child_process').spawn, fs = require('fs');
var out = process.argv[2], where = process.argv[3], argv = process.argv.slice(4);
var notes = { notty80: 'no terminal, 80 columns', pty60: 'a 30x60 terminal', pty200: 'a 50x200 terminal' };
var lc = argv[0] === 'LC_ALL=C';
if (lc) argv = argv.slice(1);
var env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
if (lc) env.LC_ALL = 'C';
var head = fs.readFileSync('/tmp/capture-head', 'utf8').replace(/\n$/, '');
var c = spawn(argv[0], argv.slice(1), { env: env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
var o = [], e = [];
c.stdout.on('data', function (d) { o.push(d); });
c.stderr.on('data', function (d) { e.push(d); });
c.on('close', function (code, signal) {
  fs.writeFileSync(out, head + ' · as the login agent through the check\'s spawn (' + notes[where] + '): ' +
    (lc ? 'LC_ALL=C ' : '') + argv.join(' ') + '\nexit ' + (code === null ? 'signal ' + signal : code) +
    '\n--- stdout\n' + Buffer.concat(o).toString('utf8') + '--- stderr\n' + Buffer.concat(e).toString('utf8'));
});
EOJ
cat > /tmp/sudoers.corpus <<'EOS'
$(cat "$corpus/sudoers.corpus")
EOS
printf '# captured %s · image %s\n' '$date' '$digest' > /tmp/capture-head
cat > /tmp/main.sh <<'MAINEOF'
SCENARIOS='$(scenarios "$image")'
$(main_body)
MAINEOF
sh /tmp/main.sh </dev/null
EOF
}

main_body() {
  cat <<'BODY'
set -u
say() { echo "[capture] $*" >&2; }
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq sudo nodejs >/dev/null 2>&1
elif command -v dnf >/dev/null; then
  dnf -y -q install sudo nodejs util-linux /usr/bin/script tar >/dev/null 2>&1   # Fedora keeps script apart
fi
command -v node >/dev/null || command -v nodejs >/dev/null || { say "no node"; exit 1; }
NODE=$(command -v node || command -v nodejs)
cp /tmp/runjs /tmp/run.js; chmod 644 /tmp/run.js /tmp/capture-head
mkdir -p /cap; chmod 777 /cap
HEAD=$(cat /tmp/capture-head)
TAB=$(printf '\t')
GETENT=$(command -v getent); ID=$(command -v id); SUDO=/usr/bin/sudo
# The fictional users: the login agent, the service user svc (its own primary group), alice.
id agent >/dev/null 2>&1 || useradd -m -u 1001 -s /bin/sh agent
groupadd -g 1500 svcown; useradd -m -u 1501 -g 1500 -s /bin/sh svc
id alice >/dev/null 2>&1 || useradd -m -u 1502 -s /bin/sh alice

# grab NAME PATH — a file, as the image has it: the header line, then its text.
grab() { { printf '%s · cat %s\n' "$HEAD" "$2"; cat "$2"; } > "/cap/$1.txt"; }
# spawn DIR NAME WHERE ARGV… — one call as agent through the check's spawn, to DIR/NAME.txt.
spawn() {
  d=$1 n=$2 w=$3; shift 3
  case "$w" in
    notty80) su agent -s /bin/sh -c "$NODE /tmp/run.js /cap/$d/$n.txt $w $*" </dev/null ;;
    pty60) script -qc "stty rows 30 cols 60; su agent -s /bin/sh --session-command '$NODE /tmp/run.js /cap/$d/$n.txt $w $*'" /dev/null </dev/null >/dev/null ;;
    pty200) script -qc "stty rows 50 cols 200; su agent -s /bin/sh --session-command '$NODE /tmp/run.js /cap/$d/$n.txt $w $*'" /dev/null </dev/null >/dev/null ;;
  esac
}
# verdict DIR NAME ARGV… — the real verdict, as agent: sudo -n … /usr/bin/true, with its exit status.
verdict() {
  d=$1 n=$2; shift 2
  su agent -s /bin/sh -c "sudo $*" </dev/null >/tmp/vo 2>/tmp/ve; rc=$?
  { printf '%s · as the login agent: sudo %s\nexit %s\n--- stdout\n' "$HEAD" "$*" "$rc"; cat /tmp/vo; printf -- '--- stderr\n'; cat /tmp/ve; } > "/cap/$d/$n.txt"
}
# rules NAME — installs the rules on stdin as /etc/sudoers.d/t (visudo -cf first) and clears every ticket.
rules() {
  cat > /tmp/t
  if ! v=$(visudo -cf /tmp/t 2>&1); then say "visudo refused $1: $v"; return 1; fi
  cp /tmp/t /etc/sudoers.d/t; chmod 440 /etc/sudoers.d/t
  rm -rf /run/sudo/ts /var/run/sudo/ts /var/lib/sudo/ts 2>/dev/null
  mkdir -p "/cap/$1"; chmod 777 "/cap/$1"
  { printf '%s · cat /etc/sudoers.d/t\n' "$HEAD"; cat /tmp/t; } > "/cap/$1/sudoers.d.t.txt"
}
# lookups NAME USER… GROUP-NAME… — every lookup the reader makes: getent passwd for each user, id -G
# for svc and root, getent group for each of their gids and each group name.
lookups() {
  d=$1; shift
  users='svc root nobody agent alice'; names=''
  for x in "$@"; do case "$x" in user:*) users="$users ${x#user:}" ;; group:*) names="$names ${x#group:}" ;; esac; done
  for u in $users; do spawn "$d" "getent.passwd.$u" notty80 "$GETENT" passwd "$u"; done
  for u in svc root; do spawn "$d" "id.G.$u" notty80 "$ID" -G "$u"; done
  gids=$( { "$ID" -G svc; "$ID" -G root; } 2>/dev/null | tr ' ' '\n' | sort -un)
  for g in $gids $names; do spawn "$d" "getent.group.$g" notty80 "$GETENT" group "$g"; done
}
listing() { # listing NAME WIDTH… — and a capture that did not come back stops the run
  d=$1; shift
  for w in "$@"; do
    spawn "$d" "sudo.l.$w" "$w" LC_ALL=C "$SUDO" -n -l
    spawn "$d" "sudo.ll.$w" "$w" LC_ALL=C "$SUDO" -n -ll
    for m in l ll; do [ -s "/cap/$d/sudo.$m.$w.txt" ] || { say "no capture: $d sudo.$m.$w"; exit 1; }; done
  done
}

# Per image: sudo's version through the spawn; the files the reader reads; where the tools live.
mkdir -p /cap/image; chmod 777 /cap/image
spawn image version.sudo notty80 "$SUDO" -V
grab image/sudoers /etc/sudoers
grab image/nsswitch.conf /etc/nsswitch.conf
todo='sudo sudo-i su su-l other'; seen=''
while [ -n "$todo" ]; do
  set -- $todo; f=$1; shift; todo="$*"
  case " $seen " in *" $f "*) continue ;; esac
  seen="$seen $f"
  [ -f "/etc/pam.d/$f" ] || continue
  grab "image/pam.$f" "/etc/pam.d/$f"
  todo="$todo $(awk '{ for (i = 1; i <= NF; i++) if ($i == "include" || $i == "substack" || $i == "@include") print $(i + 1) }' "/etc/pam.d/$f" | tr '\n' ' ')"
done
{
  printf '%s · each tool in the folders the check looks in: path, real path, owner uid\n' "$HEAD"
  for t in sudo getent id; do
    for d in /usr/bin /usr/sbin /usr/local/bin /usr/local/sbin /bin /sbin; do
      [ -e "$d/$t" ] && printf '%s %s %s\n' "$d/$t" "$(readlink -f "$d/$t")" "$(stat -L -c %u "$d/$t")"
    done
  done
} > /cap/image/tools.txt

for s in $SCENARIOS; do
  case "$s" in
    main)
      rules main < /tmp/sudoers.corpus || continue
      listing main notty80 pty60 pty200 ;;
    long-target)
      printf '%s\n' "Defaults!/usr/bin/$(printf 'l%.0s' $(seq 1 70)) mailsub=lt1" 'agent ALL=(nobody) NOPASSWD: /usr/bin/true' | rules "$s" || continue
      listing "$s" notty80 ;;
    b3|b4)
      if [ "$s" = b3 ]; then v='Password\\'; else v='Pass\ word\\'; fi
      printf '%s\n' "Defaults passprompt=$v" 'Defaults !authenticate' 'agent ALL=(nobody) NOPASSWD: /usr/bin/true' 'agent ALL=(svc) /usr/bin/true' | rules "$s" || continue
      listing "$s" notty80; lookups "$s"; verdict "$s" verdict.u-svc -n -u svc /usr/bin/true ;;
    b1a)
      # one value, aaa…a " Defaults!/usr/bin/false mailfrom="q\ (a value ending in a backslash is written
      # unquoted: inside quotes visudo refuses it); its printout wraps right before the second Defaults!
      printf '%s\n' "Defaults!/usr/bin/true mailsub=$(printf 'a%.0s' $(seq 1 30))"'\ \"\ Defaults!/usr/bin/false\ mailfrom\=\"q\\, !authenticate' 'agent ALL=(nobody) NOPASSWD: /bin/true' 'agent ALL=(svc) /usr/bin/true' | rules "$s" || continue
      listing "$s" notty80; lookups "$s"; verdict "$s" verdict.u-svc -n -u svc /usr/bin/true ;;
    b1b)
      # two entries whose join prints as one value — passprompt="x… \"    Defaults!/usr/bin/true
      # !authenticate, mailsub=w\" — padded so the wrap falls right before Defaults!
      printf '%s\n' "Defaults>svc passprompt=$(printf 'x%.0s' $(seq 1 35))"'\ \\' 'Defaults!/usr/bin/true !authenticate, mailsub=w\"' 'agent ALL=(nobody) NOPASSWD: /bin/true' 'agent ALL=(svc) /usr/bin/true' | rules "$s" || continue
      listing "$s" notty80; lookups "$s"; verdict "$s" verdict.u-svc -n -u svc /usr/bin/true ;;
    p2-a|p2-b)
      if [ "$s" = p2-a ]; then line='Defaults passprompt=x\ \\, !authenticate, mailsub=w\"'
      else line='Defaults passprompt=x\ \"\,\ !authenticate\,\ mailsub\=w\\'; fi
      printf '%s\n' "$line" 'agent ALL=(svc) /usr/bin/true' 'agent ALL=(nobody) NOPASSWD: /usr/bin/true' | rules "$s" || continue
      listing "$s" notty80; lookups "$s"; verdict "$s" verdict.u-svc -n -u svc /usr/bin/true ;;
    grp-*)
      printf 'SVCGRP:x:2001:svc\nsvcgrp:x:2002:alice\n' >> /etc/group
      case "$s" in grp-nocase) def='Defaults !case_insensitive_group' ;; grp-bygid) def='Defaults match_group_by_gid' ;;
        grp-fedora-nogid) def='Defaults !match_group_by_gid' ;; *) def='' ;; esac
      { [ -n "$def" ] && echo "$def"; echo 'agent ALL=(%svcgrp) NOPASSWD: /usr/bin/true'; } | rules "$s" || continue
      listing "$s" notty80; lookups "$s" group:svcgrp group:Svcgrp group:SVCGRP; verdict "$s" verdict.u-svc -n -u svc /usr/bin/true
      sed -i '/^SVCGRP:/d; /^svcgrp:/d' /etc/group ;;
    plugin|plugin-colon)
      printf 'plugingrp:*:3001:svc\n' > /etc/sudo-group; chmod 644 /etc/sudo-group
      if [ "$s" = plugin ]; then tok='%plugingrp'; else tok='%:plugingrp'; fi
      printf '%s\n' 'Defaults group_plugin="group_file.so /etc/sudo-group"' 'Defaults always_query_group_plugin' "agent ALL=($tok) NOPASSWD: /usr/bin/true" | rules "$s" || continue
      listing "$s" notty80; lookups "$s" group:plugingrp; verdict "$s" verdict.u-svc -n -u svc /usr/bin/true ;;
    runaspw-*)
      case "$s" in runaspw-nosuchuser) x=nosuchuser ;; runaspw-ROOT) x=ROOT ;; runaspw-hash0) x='\#0' ;; runaspw-svc) x=svc ;; esac
      printf '%s\n' 'Defaults runaspw' "Defaults runas_default=$x" 'agent ALL=(nobody) NOPASSWD: /bin/true' 'agent ALL=(ALL) /usr/bin/true' | rules "$s" || continue
      listing "$s" notty80; lookups "$s" user:nosuchuser user:ROOT; verdict "$s" verdict.u-svc -n -u svc /usr/bin/true ;;
    norunas)
      printf '%s\n' 'Defaults runas_default=nosuchuser' 'agent ALL = NOPASSWD: /usr/bin/true' | rules "$s" || continue
      listing "$s" notty80; lookups "$s" user:nosuchuser
      verdict "$s" verdict.plain -n /usr/bin/true; verdict "$s" verdict.u-root -n -u root /usr/bin/true; verdict "$s" verdict.u-svc -n -u svc /usr/bin/true ;;
  esac
  say "$s done"
done
rm -f /etc/sudoers.d/t
echo '@@CORPUS-BEGIN@@'; (cd /cap && tar cf - .) | base64; echo '@@CORPUS-END@@'
BODY
}

for image in "${images[@]}"; do
  name=$(printf '%s' "$image" | tr ':' '-')
  if ! "$docker" image inspect "$image" >/dev/null 2>&1; then "$docker" pull -q "$image" >/dev/null; fi
  digest=$("$docker" image inspect --format '{{index .RepoDigests 0}}' "$image" | tr -d '\r')
  out=$(mktemp); err=$(mktemp)
  echo "capture-sudo-corpus: $image ($digest)" >&2
  container_script "$image" "$digest" | "$docker" run --rm -i "$image" sh >"$out" 2>"$err" || true
  grep '^\[capture\]' "$err" >&2 || true
  if ! grep -q '^@@CORPUS-END@@' "$out"; then echo "capture-sudo-corpus: $image gave no corpus" >&2; tail -20 "$err" >&2; exit 1; fi
  rm -rf "${corpus:?}/$name"; mkdir -p "$corpus/$name"
  sed -n '/^@@CORPUS-BEGIN@@/,/^@@CORPUS-END@@/p' "$out" | sed '1d;$d' | tr -d '\r' | base64 -d | tar -xf - -C "$corpus/$name"
  rm -f "$out" "$err"
done
