// su.ts — #790 (D6, 01b #14): su is never run. It is read from files and lookups only: Realm's
// service user's passwd entry and shell (`getent passwd`; on macOS `dscl`), the shells files, and su's
// PAM stacks through D7's scanner.
import type { SwitchPathReading } from '@sensigo/realm';
import { basename } from 'node:path';
import {
  findTool,
  presence,
  toolLine,
  type Found,
  type Lookups,
  type PasswdEntry,
} from './lookup.js';
import { scanPam } from './pam.js';

/** The shells that run no command (D6 c). */
const NO_COMMAND_SHELLS = new Set([
  '/usr/sbin/nologin',
  '/sbin/nologin',
  '/bin/false',
  '/usr/bin/false',
]);
/** The shells files su reads: `/etc/shells`, and the vendor copy where it exists (F790-R2-01). */
const SHELLS_FILES = ['/etc/shells', '/usr/etc/shells'] as const;

/** ⟨svc⟩'s shell: from its passwd entry, or on macOS from `dscl . -read /Users/<svc> UserShell`. */
async function shellOf(
  lk: Lookups,
  entry: Found<PasswdEntry>,
): Promise<{ shell: string; how: string } | { unknown: string }> {
  if (!lk.darwin) {
    if ('found' in entry) return { shell: entry.found.shell, how: `getent passwd ${lk.svc}` };
    return 'unknown' in entry ? entry : { unknown: `${lk.svc} has no passwd entry` };
  }
  const dscl = findTool(lk.probes, 'dscl');
  if (dscl === undefined) return { unknown: 'dscl was not found in the system folders' };
  if ('unknown' in dscl) return dscl;
  const call = `${dscl.path} . -read /Users/${lk.svc} UserShell`;
  const r = await lk.run([dscl.path, '.', '-read', `/Users/${lk.svc}`, 'UserShell']);
  // The shape Apple's own zsh completion strips (`UserShell: <path>`); any other answer is not read.
  const m = 'exit' in r && r.exit === 0 ? /^UserShell: (\/\S*)\n?$/.exec(r.stdout) : null;
  return m !== null ? { shell: m[1]!, how: call } : { unknown: `${call} says: ${toolLine(r)}` };
}

/** Whether `shell` is listed in a shells file; `undefined` when a file there cannot be read. */
function listed(lk: Lookups, shell: string): boolean | undefined {
  for (const file of SHELLS_FILES) {
    if (!lk.probes.exists(file)) continue;
    const text = lk.probes.readText(file);
    if (text === undefined) return undefined;
    if (text.split('\n').some((l) => l.trim() === shell)) return true;
  }
  return false;
}

/** D6: the su path — none when no su is on this host (01b #14). A person's touch beside the
 *  password module is its own reading, so the password's clause stays (D5's rule, for su). */
export async function readSu(lk: Lookups, entry: Found<PasswdEntry>): Promise<SwitchPathReading[]> {
  const one = await readSuOne(lk, entry);
  return one === undefined ? [] : Array.isArray(one) ? one : [one];
}

async function readSuOne(
  lk: Lookups,
  entry: Found<PasswdEntry>,
): Promise<SwitchPathReading | SwitchPathReading[] | undefined> {
  const where = presence(lk.probes, 'su');
  if (where === undefined) return undefined;
  if ('elsewhere' in where) {
    return {
      path: 'su',
      outcome: 'unknown',
      how: 'su looked for in the system folders',
      cause: `su at ${where.elsewhere} is not a root-owned system copy`,
    };
  }
  const su = where.system;
  // (c) before (b): a shell that runs no command runs nothing, even with an empty password.
  const shell = await shellOf(lk, entry);
  if ('shell' in shell && NO_COMMAND_SHELLS.has(shell.shell)) {
    const inFiles = listed(lk, shell.shell);
    if (inFiles === false) {
      return {
        path: 'su',
        tool: su,
        outcome: 'not_allowed',
        how: `${shell.how} and the shells files read: ${lk.svc}'s shell ${shell.shell} runs no command`,
      };
    }
  }
  // (b) the rare inline empty password (with shadow passwords, clause (a) carries the real case).
  if ('found' in entry && entry.found.password === '') {
    return {
      path: 'su',
      tool: su,
      outcome: 'yes',
      how: `getent passwd ${lk.svc}: its password field is empty`,
    };
  }
  // (e) BusyBox su reads no PAM stack and asks the target's password.
  const pamFile = ['/etc/pam.d/su', '/usr/lib/pam.d/su'].some((p) => lk.probes.exists(p));
  if (basename(lk.probes.realPath(su) ?? su) === 'busybox' && !pamFile) {
    return {
      path: 'su',
      tool: su,
      outcome: 'needs_credential',
      whose: 'svc',
      how: `${su} is BusyBox's su, which reads no PAM stack and asks for ${lk.svc}'s password`,
    };
  }
  // (d) the PAM stacks: su, and su-l where su runs one (macOS su runs only "su": shell_cmds su.c).
  const scans = await Promise.all(
    (lk.darwin ? ['su'] : ['su', 'su-l']).map(async (s) => ({
      service: s,
      scan: await scanPam(lk, s),
    })),
  );
  const unknown = scans.find((s) => 'unknown' in s.scan);
  if (unknown !== undefined && 'unknown' in unknown.scan) {
    return {
      path: 'su',
      tool: su,
      outcome: 'unknown',
      how: `su's PAM stacks read`,
      cause: unknown.scan.unknown,
    };
  }
  const read = scans.flatMap((s) =>
    'unknown' in s.scan ? [] : [{ service: s.service, ...s.scan }],
  );
  const files = [...new Set(read.flatMap((s) => s.files))].join(', ');
  const how = `${files} read`;
  const granted = read.find((s) => s.grant !== undefined);
  if (granted !== undefined) {
    return {
      path: 'su',
      tool: su,
      outcome: 'yes',
      how: `${how}: ${granted.service} grants it (${granted.grant})`,
    };
  }
  if (read.some((s) => s.sshAgent)) {
    return {
      path: 'su',
      tool: su,
      outcome: 'unknown',
      how,
      cause: "su accepts an ssh agent's key",
    };
  }
  const person: SwitchPathReading[] = read.some((s) => s.person)
    ? [{ path: 'su', tool: su, outcome: 'needs_credential', whose: 'person', how }]
    : [];
  if (read.some((s) => s.password)) {
    return [{ path: 'su', tool: su, outcome: 'needs_credential', whose: 'svc', how }, ...person];
  }
  if (person.length > 0) return person;
  return {
    path: 'su',
    tool: su,
    outcome: 'unknown',
    how,
    cause: "su's PAM stacks name no module this check reads",
  };
}
