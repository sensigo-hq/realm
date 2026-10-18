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

/** Whether this login holds a key. With no login home, or a `.ssh` it cannot list, a key is
 *  assumed: the clause is a hedge, and printing it is the safe direction. */
function holdsKey(lk: Lookups): boolean {
  const sock = lk.probes.env['SSH_AUTH_SOCK'];
  if (sock !== undefined && sock !== '') return true;
  const home = lk.probes.loginHome(); // the login's own home, never $HOME (rail 2)
  if (home === undefined) return true;
  const dir = join(home, '.ssh');
  if (!lk.probes.exists(dir)) return false;
  const names = lk.probes.list(dir);
  if (names === undefined) return true;
  return names.some((n) => /^id_[A-Za-z0-9_-]+$/.test(n) && lk.probes.canRead(join(dir, n)));
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
  if (!sshdPresent(lk) || !holdsKey(lk)) return [];
  return [
    {
      path: 'ssh',
      outcome: 'needs_credential',
      how: 'an sshd is present and this login holds a key',
    },
  ];
}
