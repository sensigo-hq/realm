// ssh.ts — #790 (D10, 01b #4, rail 2): ssh to Realm's service user, with no connection. The path is
// listed when this login holds a key (a private key file under its own `.ssh` it can read, or a set
// SSH_AUTH_SOCK) and an sshd is present on this host. It reads presence only: it never opens a key
// file, never prints the variable's value, never reads sshd's port and never connects to it.
import type { SwitchPathReading } from '@sensigo/realm';
import { join } from 'node:path';
import { SYSTEM_DIRS, type Lookups } from './lookup.js';

const UNIT_DIRS = [
  '/etc/systemd/system',
  '/run/systemd/system',
  '/usr/lib/systemd/system',
  '/lib/systemd/system',
];
const UNITS = ['ssh.socket', 'ssh.service', 'sshd.service'];

/** Whether this login holds a key: 'yes', 'no', or 'assumed' — with no login home or a `.ssh` it
 *  cannot list, a key is assumed (the clause is a hedge; printing it is the safe direction). B §7:
 *  any readable file there but a `.pub`, known_hosts, config or authorized_keys counts. */
function holdsKey(lk: Lookups): 'yes' | 'no' | 'assumed' {
  const sock = lk.probes.env['SSH_AUTH_SOCK'];
  if (sock !== undefined && sock !== '') return 'yes';
  const home = lk.probes.loginHome(); // the login's own home, never $HOME (rail 2)
  if (home === undefined) return 'assumed';
  const dir = join(home, '.ssh');
  if (!lk.probes.exists(dir)) return 'no';
  const names = lk.probes.list(dir);
  if (names === undefined) return 'assumed';
  const notKeys = new Set(['known_hosts', 'config', 'authorized_keys']);
  const key = (n: string) =>
    !n.endsWith('.pub') && !notKeys.has(n) && lk.probes.canRead(join(dir, n));
  return names.some(key) ? 'yes' : 'no';
}

/** An sshd on this host: its binary in D2's folders, or one of its unit files. */
function sshdPresent(lk: Lookups): boolean {
  return (
    SYSTEM_DIRS.some((d) => lk.probes.exists(join(d, 'sshd'))) ||
    UNIT_DIRS.some((d) => UNITS.some((u) => lk.probes.exists(join(d, u))))
  );
}

/** D10: the ssh path — listed only with a key and an sshd; never `unknown` (01b #4). */
export function readSsh(lk: Lookups): SwitchPathReading[] {
  const key = holdsKey(lk);
  if (!sshdPresent(lk) || key === 'no') return [];
  const holds =
    key === 'yes' ? 'holds a key' : "may hold a key (its home's .ssh could not be listed)";
  return [
    {
      path: 'ssh',
      outcome: 'needs_credential',
      how: `an sshd is present and this login ${holds}`,
    },
  ];
}
