// ssh.ts — #790 (D10, 01b #4, rail 2): ssh to Realm's service user, with no connection. #819 (08,
// B F9): the path is listed whenever an sshd is present on this host — a key the login keeps outside
// its own `.ssh` (or names through `IdentityFile`) is not looked for, so with none found there its
// how says so. It reads presence only: it never opens a key file, never prints the variable's
// value, never reads sshd's port and never connects to it.
import type { SwitchPathReading } from '@sensigo/realm';
import { join } from 'node:path';
import { presence, type Lookups } from './lookup.js';

export const UNIT_DIRS = [
  '/etc/systemd/system',
  '/run/systemd/system',
  '/usr/lib/systemd/system',
  '/lib/systemd/system',
];
/** sshd's unit files, looked for in `UNIT_DIRS` (#819 correction 1, A MINOR 3: `sshd.socket`). */
export const SSHD_UNITS = ['ssh.socket', 'sshd.socket', 'ssh.service', 'sshd.service'];

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

/** An sshd on this host: its binary in D2's folders or on PATH (#819 correction 1, A MINOR 3: the
 *  safe direction, it lists more), or one of its unit files. */
function sshdPresent(lk: Lookups): boolean {
  return (
    presence(lk.probes, 'sshd') !== undefined ||
    UNIT_DIRS.some((d) => SSHD_UNITS.some((u) => lk.probes.exists(join(d, u))))
  );
}

/** D10: the ssh path — listed whenever an sshd is present (#819, 08 B F9); never `unknown`
 *  (01b #4). */
export function readSsh(lk: Lookups): SwitchPathReading[] {
  if (!sshdPresent(lk)) return [];
  const key = holdsKey(lk);
  // #819 correction 1 (A MINOR 12): one parenthetical; (walk --check wording 3) the folder named
  // under the home it was read from, the login's own
  const dir = join(lk.probes.loginHome() ?? '~', '.ssh');
  const how =
    key === 'yes'
      ? 'an sshd is present and this login holds a key'
      : key === 'assumed'
        ? "an sshd is present and this login may hold a key: its home's .ssh could not be listed"
        : `an sshd is present; a key outside ${dir} is not looked for`;
  return [{ path: 'ssh', outcome: 'needs_credential', how }];
}
