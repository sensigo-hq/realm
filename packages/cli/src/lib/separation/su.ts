// su.ts — #790 (D6, 01b #14): su is never run. It is read from files and lookups only: Realm's
// service user's passwd entry and shell, and root's (`getent passwd`; on macOS `dscl`; #819 Unit A, the
// capped correction, Part 3), the shells files, and su's PAM stacks through D7's scanner.
import type { SwitchPathReading } from '@sensigo/realm';
import { basename } from 'node:path';
import {
  findTool,
  lookedFor,
  notFound,
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

/** A user's shell (⟨svc⟩'s, or root's: the capped correction, Part 3): from its passwd entry, or on
 *  macOS from `dscl . -read /Users/<name> UserShell`. */
async function shellOf(
  lk: Lookups,
  name: string,
  entry: Found<PasswdEntry>,
): Promise<{ shell: string; how: string } | { unknown: string }> {
  if (!lk.darwin) {
    if ('found' in entry) return { shell: entry.found.shell, how: `getent passwd ${name}` };
    return 'unknown' in entry ? entry : { unknown: `${name} has no passwd entry` };
  }
  const dscl = findTool(lk.probes, 'dscl');
  if (dscl === undefined) return { unknown: notFound('dscl') };
  if ('unknown' in dscl) return dscl;
  const call = `${dscl.path} . -read /Users/${name} UserShell`;
  const r = await lk.run([dscl.path, '.', '-read', `/Users/${name}`, 'UserShell']);
  // The shape Apple's own zsh completion strips (`UserShell: <path>`); any other answer is not read.
  const m = 'exit' in r && r.exit === 0 ? /^UserShell: (\/\S*)\n?$/.exec(r.stdout) : null;
  return m !== null ? { shell: m[1]!, how: call } : { unknown: `${call} says: ${toolLine(r)}` };
}

/**
 * #819 follow-up 2 (member 7, the audit's S9): a shells file's shells, each line read as glibc's
 * `getusershell` reads it (`misc/getusershell.c:131-136`; util-linux's `is_known_shell` asks it):
 * the shell starts at the line's first `/` — whatever comes before it — and runs to whitespace, a
 * `#` or the end; a line whose first `#` comes before any `/`, or that has no `/`, lists none, and so
 * does a `/` that ends the file with no line end after it.
 */
export function shellsOf(text: string): string[] {
  const shells: string[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const at = line.search(/[#/]/);
    if (at < 0 || line[at] === '#') return;
    if (at === line.length - 1 && i === lines.length - 1) return;
    shells.push(/^[^\s#]*/.exec(line.slice(at))![0]);
  });
  return shells;
}

/** Whether `shell` is listed in a shells file; `undefined` when a file there cannot be read. */
function listed(lk: Lookups, shell: string): boolean | undefined {
  for (const file of SHELLS_FILES) {
    if (!lk.probes.exists(file)) continue;
    const text = lk.probes.readText(file);
    if (text === undefined) return undefined;
    if (shellsOf(text).includes(shell)) return true;
  }
  return false;
}

/** D6: the su path — none when no su is on this host (01b #14). A person's touch beside the
 *  password module is its own reading, so the password's clause stays (D5's rule, for su). #819 Unit
 *  A, the capped correction (Part 3; W-860-MA3-07): su is read toward root too — `su root` with root's
 *  password exits 0 on all six images, and root then becomes ⟨svc⟩ — each target with its own entry
 *  and shell, su's PAM stacks scanned once for both. With Realm's service user root, one target. */
export async function readSu(
  lk: Lookups,
  entry: Found<PasswdEntry>,
  root?: Found<PasswdEntry>,
): Promise<SwitchPathReading[]> {
  const where = presence(lk.probes, 'su');
  if (where === undefined) return [];
  if ('elsewhere' in where) {
    return [
      {
        path: 'su',
        outcome: 'unknown',
        how: lookedFor('su'),
        cause: `su at ${where.elsewhere} is not a root-owned system copy`,
      },
    ];
  }
  const su = where.system;
  const targets: Target[] = [{ whose: 'svc', name: lk.svc, entry }];
  if (root !== undefined && lk.svc !== 'root')
    targets.push({ whose: 'root', name: 'root', entry: root });
  // B §11: BusyBox's su keeps a restricted shell only under a build option this check cannot see,
  // so (c) is not read for it: it asks for the target's password (e).
  const pamFile = ['/etc/pam.d/su', '/usr/lib/pam.d/su'].some((p) => lk.probes.exists(p));
  const busybox = basename(lk.probes.realPath(su) ?? su) === 'busybox' && !pamFile;
  const own: (SwitchPathReading | undefined)[] = [];
  for (const t of targets) own.push(await targetReading(lk, su, busybox, t));
  const pamTargets = targets.filter((_, i) => own[i] === undefined);
  const pam = pamTargets.length > 0 ? await readSuPam(lk, su) : undefined;
  const out: SwitchPathReading[] = [];
  let shared = false;
  targets.forEach((t, i) => {
    const r = own[i];
    if (r !== undefined) out.push(r);
    else if (pam !== undefined && 'once' in pam) {
      // a grant, an unknown or an ssh agent's key: one reading, whoever the target
      if (!shared) out.push(pam.once);
      shared = true;
    } else if (pam !== undefined && pam.password)
      out.push({ path: 'su', tool: su, outcome: 'needs_credential', whose: t.whose, how: pam.how });
  });
  if (pam !== undefined && !('once' in pam)) {
    if (pam.person)
      out.push({
        path: 'su',
        tool: su,
        outcome: 'needs_credential',
        whose: 'person',
        how: pam.how,
      });
    else if (!pam.password)
      out.push({
        path: 'su',
        tool: su,
        outcome: 'unknown',
        how: pam.how,
        cause: "su's PAM stacks name no password module this check reads",
      });
  }
  return out;
}

/** One target of su: Realm's service user or root, with its passwd entry. */
interface Target {
  whose: 'svc' | 'root';
  name: string;
  entry: Found<PasswdEntry>;
}

/** What su reads toward one target before its PAM stacks — or `undefined`, where the stacks decide. */
async function targetReading(
  lk: Lookups,
  su: string,
  busybox: boolean,
  t: Target,
): Promise<SwitchPathReading | undefined> {
  // B §9: on Linux, the target's entry not read is unknown, never "needs the target's password".
  if (!lk.darwin && !('found' in t.entry)) {
    const cause = 'unknown' in t.entry ? t.entry.unknown : `${t.name} has no passwd entry`;
    return { path: 'su', tool: su, outcome: 'unknown', how: `getent passwd ${t.name}`, cause };
  }
  // (c) before (b): a shell that runs no command runs nothing, even with an empty password.
  const shell = await shellOf(lk, t.name, t.entry);
  // #819 (08, B F5): B §9 on macOS too — the target's shell not read (dscl absent or failing) is
  // unknown, never "needs its password" (BusyBox's su, which asks it whatever the shell, aside)
  if (lk.darwin && !busybox && 'unknown' in shell) {
    return {
      path: 'su',
      tool: su,
      outcome: 'unknown',
      how: `${t.name}'s shell`,
      cause: shell.unknown,
    };
  }
  if (!busybox && 'shell' in shell && NO_COMMAND_SHELLS.has(shell.shell)) {
    const inFiles = listed(lk, shell.shell);
    if (inFiles === false) {
      return {
        path: 'su',
        tool: su,
        outcome: 'not_allowed',
        how: `${shell.how} and the shells files read: ${t.name}'s shell ${shell.shell} runs no command`,
      };
    }
  }
  // (b) the rare inline empty password (with shadow passwords, clause (a) carries the real case).
  if ('found' in t.entry && t.entry.found.password === '') {
    return {
      path: 'su',
      tool: su,
      outcome: 'yes',
      how: `getent passwd ${t.name}: its password field is empty`,
    };
  }
  // (e) BusyBox su reads no PAM stack and asks the target's password.
  if (busybox) {
    return {
      path: 'su',
      tool: su,
      outcome: 'needs_credential',
      whose: t.whose,
      how: `${su} is BusyBox's su, which reads no PAM stack and asks for ${t.name}'s password`,
    };
  }
  return undefined;
}

/** (d) su's PAM stacks: su, and su-l where su runs one (macOS su runs only "su": shell_cmds su.c) —
 *  read once, whatever the target (the capped correction, Part 3; W-UAC2R4-AUD-10): a grant, an
 *  unknown or an ssh agent's key is one reading (`once`); else whether a password and a person's
 *  touch are asked. */
async function readSuPam(
  lk: Lookups,
  su: string,
): Promise<{ once: SwitchPathReading } | { password: boolean; person: boolean; how: string }> {
  const scans = await Promise.all(
    (lk.darwin ? ['su'] : ['su', 'su-l']).map(async (s) => ({
      service: s,
      scan: await scanPam(lk, s),
    })),
  );
  const read = scans.flatMap((s) =>
    'unknown' in s.scan ? [] : [{ service: s.service, ...s.scan }],
  );
  const files = [...new Set(read.flatMap((s) => s.files))].join(', ');
  const how = `${files} read`;
  // B §11, 01b #6 within one path: a grant (yes) outranks an unknown
  const granted = read.find((s) => s.grant !== undefined);
  if (granted !== undefined) {
    return {
      once: {
        path: 'su',
        tool: su,
        outcome: 'yes',
        how: `${how}: ${granted.service} grants it (${granted.grant})`,
      },
    };
  }
  const unknown = scans.find((s) => 'unknown' in s.scan);
  if (unknown !== undefined && 'unknown' in unknown.scan) {
    return {
      once: {
        path: 'su',
        tool: su,
        outcome: 'unknown',
        how: `su's PAM stacks read`,
        cause: unknown.scan.unknown,
      },
    };
  }
  if (read.some((s) => s.sshAgent)) {
    return {
      once: {
        path: 'su',
        tool: su,
        outcome: 'unknown',
        how,
        cause: "su accepts an ssh agent's key",
      },
    };
  }
  return { password: read.some((s) => s.password), person: read.some((s) => s.person), how };
}
