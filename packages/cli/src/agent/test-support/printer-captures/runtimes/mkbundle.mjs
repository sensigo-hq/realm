// mkbundle.mjs — prints a POSIX shell script that recreates the named files (base64, so no quoting or charset
// issue on the docker.exe pipe) and then runs a command. Used as:
//   node mkbundle.mjs '<command>' dest=src ... | docker.exe run -i --rm <image> sh -c 'cat > /tmp/b.sh; sh /tmp/b.sh'
// No volume mounts: everything crosses on stdin (the Windows Docker client, reached from WSL, takes no mounts).
/* global process */
import fs from 'node:fs';
const [cmd, ...files] = process.argv.slice(2);
let s = 'set -e\nmkdir -p /w\ncd /w\n';
for (const f of files) {
  const [dest, src] = f.split('=');
  const b64 = fs
    .readFileSync(src)
    .toString('base64')
    .replace(/.{1,76}/g, '$&\n');
  s += `mkdir -p "$(dirname '${dest}')"\nbase64 -d > '${dest}' <<'__B64__'\n${b64}__B64__\n`;
}
s += cmd + '\n';
process.stdout.write(s);
