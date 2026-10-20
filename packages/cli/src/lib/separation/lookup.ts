// lookup.ts — #790: what every switch-path reader shares. The probes they read through; which copy of
// a tool is asked (01b #8: a root-owned system copy only); and the user and group lookups of rail 1
// (`getent passwd|group|netgroup`; `dscl . -read /Users/<svc> UserShell` on macOS), each asked once
// per measurement.
import { delimiter, dirname, join } from 'node:path';
import type { Runner, RunResult } from './runner.js';

/** What the readers read from the machine — injected, so every cell runs on captured fixtures. */
export interface SwitchProbes {
  login: () => string;
  /** This process's uid — `undefined` only where the OS gives none (W correction 2, 5.2: read from
   *  the process, which needs no passwd entry). */
  uid: () => number | undefined;
  /** The login's own passwd home: where the agent-scoped paths are read (its Docker sockets, its
   *  apps' settings, its ssh keys) — never `$HOME`, which may point at Realm's store (W correction 1
   *  D4; rail 2). `undefined` when the login has no passwd entry (correction 2, 5.2). */
  loginHome: () => string | undefined;
  env: Record<string, string | undefined>;
  /** A path's owner and mode, or the reason it cannot be stat'ed (`ENOENT`, `EACCES`, … — W
   *  correction 1 D1; correction 2, 5.6: the mode carries the sticky bit). */
  stat: (path: string) => { uid: number; mode: number } | { error: string };
  exists: (path: string) => boolean;
  canRead: (path: string) => boolean;
  canWrite: (path: string) => boolean;
  readText: (path: string) => string | undefined;
  list: (dir: string) => string[] | undefined;
  /** A path with every symbolic link resolved, or `undefined` when it cannot be. */
  realPath: (path: string) => string | undefined;
  /** This process's group ids (`process.getgroups()`), or `undefined` where the OS gives none. */
  groups: () => number[] | undefined;
  /** This process's id: the process polkit is asked about. */
  pid: () => number;
  platform: () => string;
  /** Connects to a socket: a Unix socket path, or `host:port`. True iff it accepted (D12). */
  connect: (target: { path: string } | { host: string; port: number }) => Promise<boolean>;
  /** The one way a reader starts a process (`runner.ts`): rail 1's calls only. */
  run: Runner;
}

/** D2's system folders (D2, with NixOS's two). */
export const SYSTEM_DIRS = [
  '/usr/bin',
  '/usr/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/bin',
  '/sbin',
  '/run/wrappers/bin',
  '/run/setuid-programs',
] as const;

/** #819 (08, walk friction 2): where a program is looked for, named — D2's folders, then PATH. */
export function lookedFor(name: string): string {
  return `${name} looked for in ${SYSTEM_DIRS.join(', ')} and on PATH`;
}

/** #819 (08, walk friction 2): a program found in none of the folders it is looked for in. */
export function notFound(name: string): string {
  return `${name} was not found in ${SYSTEM_DIRS.join(', ')} or on PATH`;
}

/** Where a program was found: in D2's folders, only elsewhere on PATH, or nowhere. */
export function presence(
  probes: SwitchProbes,
  name: string,
): { system: string } | { elsewhere: string } | undefined {
  const system = SYSTEM_DIRS.map((d) => join(d, name)).find((p) => probes.exists(p));
  if (system !== undefined) return { system };
  const dirs = (probes.env['PATH'] ?? '').split(delimiter).filter((d) => d !== '');
  const elsewhere = dirs
    .filter((d) => !(SYSTEM_DIRS as readonly string[]).includes(d))
    .map((d) => join(d, name))
    .find((p) => probes.exists(p));
  return elsewhere !== undefined ? { elsewhere } : undefined;
}

/** A tool to ask: its absolute path; or why it is not asked; or absent. */
export type ToolFound = { path: string } | { unknown: string } | undefined;

/** Whether `path` is a copy root owns that this login cannot change: the file and its folder, and
 *  the same for the file a link resolves to — `root-owned` when root owns both but this login can
 *  change one of them (#819, 08 B Outside 3), `other` when root does not own them. */
function systemCopy(probes: SwitchProbes, path: string): 'good' | 'root-owned' | 'other' {
  const real = probes.realPath(path) ?? path;
  const owned = [path, real].every((p) => {
    const s = probes.stat(p);
    return 'uid' in s && s.uid === 0;
  });
  if (!owned) return 'other';
  const fixed = [path, real].every((p) => !probes.canWrite(p) && !probes.canWrite(dirname(p)));
  return fixed ? 'good' : 'root-owned';
}

/** 01b #8 (A §F14): every root-owned copy of `name` in D2's folders this login cannot change, each
 *  real file once; a copy there that is not one, or a copy found only elsewhere on PATH, is named
 *  in `unknown` — it makes that path unknown even beside a good copy. */
export function findTools(
  probes: SwitchProbes,
  name: string,
): { paths: string[]; unknown: string[] } {
  const where = presence(probes, name);
  if (where === undefined) return { paths: [], unknown: [] };
  if ('elsewhere' in where) {
    return {
      paths: [],
      unknown: [`${name} at ${where.elsewhere} is not a root-owned system copy`],
    };
  }
  const out: { paths: string[]; unknown: string[] } = { paths: [], unknown: [] };
  // #819 (08, walk new 4): a good copy, and a bad one, each named once per real file — a bad name
  // beside a good one for the same file still reads unknown (A §F14)
  const good = new Set<string>();
  const bad = new Set<string>();
  for (const p of SYSTEM_DIRS.map((d) => join(d, name)).filter((q) => probes.exists(q))) {
    const real = probes.realPath(p) ?? p;
    const copy = systemCopy(probes, p);
    const seen = copy === 'good' ? good : bad;
    if (seen.has(real)) continue;
    seen.add(real);
    if (copy === 'good') out.paths.push(p);
    else if (copy === 'root-owned')
      out.unknown.push(`${name} at ${p} is root-owned, but this login can change it`);
    else out.unknown.push(`${name} at ${p} is not a root-owned system copy`);
  }
  return out;
}

/** The one copy of `name` to ask (01b #8): the first good one, or unknown when any copy is not. */
export function findTool(probes: SwitchProbes, name: string): ToolFound {
  const found = findTools(probes, name);
  if (found.unknown.length > 0) return { unknown: found.unknown[0]! };
  return found.paths.length > 0 ? { path: found.paths[0]! } : undefined;
}

/** #819 follow-up 2 (member 5): the id a sudoers `#uid` or `%#gid` names, as sudo reads it — a
 *  decimal number, leading zeros and all (the lexer's `#-?[0-9]+`, parsed by `sudo_strtoid`;
 *  W-829c1-A-09); `negative` for a `#-n`, which this check treats as covering (the safe direction);
 *  `undefined` when `token` is not one. */
export function numericId(token: string): number | 'negative' | undefined {
  const m = /^#(-?)(\d+)$/.exec(token);
  if (m === null) return undefined;
  return m[1] === '-' ? 'negative' : Number(m[2]);
}

/** One passwd entry, read by `getent passwd`. */
export interface PasswdEntry {
  name: string;
  password: string;
  uid: number;
  gid: number;
  shell: string;
}

/** One group, read by `getent group` (or, on macOS, from `/etc/group`). */
export interface GroupEntry {
  name: string;
  gid: number;
  members: string[];
}

/** A lookup's answer: found; not there; or not known, with why. */
export type Found<T> = { found: T } | { absent: true } | { unknown: string };

/** The tool's first line of error output, or the reason it did not run. */
export function toolLine(r: RunResult): string {
  if ('refused' in r) return `the check refused to run ${r.refused}`;
  if ('error' in r) return r.error;
  const line = (r.stderr.trim() || r.stdout.trim()).split('\n')[0];
  return line !== undefined && line !== '' ? line : `exit ${r.exit} with no output`;
}

/** The lookups of one measurement, each asked once: `getent`'s answers, and the login's groups. */
export interface Lookups {
  probes: SwitchProbes;
  login: string;
  /** Realm's service user's raw name ('' where none is named: condition 3 needs none). */
  svc: string;
  darwin: boolean;
  /** Runs `argv` once per measurement; a repeated argv reuses the first answer. */
  run: (argv: readonly string[]) => Promise<RunResult>;
  passwd: (name: string) => Promise<Found<PasswdEntry>>;
  group: (name: string) => Promise<Found<GroupEntry>>;
  netgroupUsers: (name: string) => Promise<Found<string[]>>;
  /** Whether this login is in the group `name`: by its process groups or the group's members. */
  loginIn: (name: string) => Promise<Found<boolean>>;
  /** Whether `user` (svc or root) is in the group `name` (`#gid` or a name). macOS: unknown (01b #9).
   *  `listed`: not in it, read from the members the group lists (#819 correction 1, clause (g)). */
  userIn: (
    user: PasswdEntry,
    name: string,
  ) => Promise<Found<boolean> | { found: false; listed: true }>;
}

/** #819 correction 1 (SEP-00 (f)): the group sources glibc reads locally, each complete for what it
 *  knows — `files`; `compat` (files with NIS `+` entries); `db` (a local database of /etc/group);
 *  `systemd` (systemd's own services and JSON drop-ins, root and nobody; nss-systemd(8)). */
const LOCAL_GROUP_SOURCES = new Set(['files', 'compat', 'db', 'systemd']);
/** SSSD's NSS responder socket, as libnss_sss names it (sssd-client 2.13.1, Fedora 44; captured
 *  2026-10-19): while it is there, `sss` serves names from a directory. */
export const SSS_NSS_SOCKET = '/var/lib/sss/pipes/nss';

/** #819 follow-up 2 (member 8): nscd's socket (glibc's and musl's `/var/run/nscd/socket`, and the
 *  `/run` it usually links to). musl reads no `/etc/nsswitch.conf`: its group lookups and
 *  `getgrouplist` ask nscd when this socket is there (musl `src/passwd`; W-819F2-AUD-09). */
export const NSCD_SOCKETS = ['/var/run/nscd/socket', '/run/nscd/socket'] as const;

/** Where `getent group` reads groups from: only local sources, a source that may serve a directory,
 *  or not known. */
type GroupSource =
  { local: true } | { directory: string; database: 'group' | 'initgroups' } | { unknown: string };

/** #819 follow-up 2 (member 2): the databases whose sources decide a member list — `group`, and
 *  `initgroups`, which `getgrouplist` (and so sudo's group match) reads when it is there (glibc
 *  `nss/initgroups.c`; W-829c1-A-04). */
const GROUP_DATABASES = ['group', 'initgroups'] as const;

/**
 * SEP-00 (f), #819 follow-up 2 (member 2, the audit's S1 text): `/etc/nsswitch.conf`, read once, as
 * glibc reads it, or not known. Only a line whose first word — up to whitespace or `:`, after leading
 * whitespace, as glibc reads it; matched in any case, so a name glibc might read is never skipped —
 * is `group` or `initgroups` is judged. Each of these reads unknown: a second line of the same name
 * (glibc keeps the last; one of each is not a second); a `#` after the name (glibc strips no trailing
 * comment); no `:`; sources the parser cannot split (an unclosed bracket, a name of other characters,
 * or none). Both lines are classed alike, the `sss` socket rule included; bracketed actions are syntax,
 * not sources. A line that starts with `#` is a comment, and no other line is read. No file, or no
 * `group` line, is the `files` source — unless nscd's socket is there (member 8): musl then asks nscd.
 */
function groupSourceOf(probes: SwitchProbes): GroupSource {
  const path = '/etc/nsswitch.conf';
  const nscd = (): GroupSource | undefined => {
    const socket = NSCD_SOCKETS.find((s) => probes.exists(s));
    return socket !== undefined
      ? {
          unknown: `${socket} is there and ${path} lists no group line, so groups may be listed from nscd`,
        }
      : undefined;
  };
  const stat = probes.stat(path);
  if ('error' in stat && stat.error === 'ENOENT') return nscd() ?? { local: true };
  const text = probes.readText(path);
  if (text === undefined)
    return { unknown: `${path} cannot be read, so where groups are listed from is not known` };
  const lines: Partial<Record<(typeof GROUP_DATABASES)[number], string>> = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s+/, '');
    if (line.startsWith('#')) continue;
    const name = /^[^\s:]*/.exec(line)![0];
    const db = GROUP_DATABASES.find((d) => d === name.toLowerCase());
    if (db === undefined) continue;
    const cannot = (why: string): GroupSource => ({
      unknown: `${path} has ${why}, so where groups are listed from is not known: ${line.trimEnd()}`,
    });
    if (lines[db] !== undefined) return cannot(`a second ${db} line`);
    const rest = line.slice(name.length);
    if (rest.includes('#')) return cannot(`a # after the ${db} name`);
    if (!/^\s*:/.test(rest)) return cannot(`no : after the ${db} name`);
    const sources = rest
      .replace(/^\s*:/, '')
      .replace(/\[[^\]]*\]/g, ' ')
      .split(/\s+/)
      .filter((t) => t !== '');
    if (sources.length === 0 || sources.some((s) => !/^[A-Za-z0-9_-]+$/.test(s)))
      return cannot(`a ${db} line whose sources it cannot split`);
    lines[db] = sources.join(' ');
  }
  if (lines.group === undefined) {
    const viaNscd = nscd();
    if (viaNscd !== undefined) return viaNscd;
  }
  for (const db of GROUP_DATABASES) {
    for (const source of lines[db]?.split(' ') ?? []) {
      if (LOCAL_GROUP_SOURCES.has(source)) continue;
      if (source === 'sss' && !probes.exists(SSS_NSS_SOCKET)) continue;
      return { directory: source, database: db };
    }
  }
  return { local: true };
}

const parsePasswd = (line: string): PasswdEntry | undefined => {
  const f = line.split(':');
  if (f.length !== 7 || !/^\d+$/.test(f[2]!) || !/^\d+$/.test(f[3]!)) return undefined;
  return { name: f[0]!, password: f[1]!, uid: Number(f[2]), gid: Number(f[3]), shell: f[6]! };
};

const parseGroup = (line: string): GroupEntry | undefined => {
  const f = line.split(':');
  if (f.length !== 4 || !/^\d+$/.test(f[2]!)) return undefined;
  return { name: f[0]!, gid: Number(f[2]), members: f[3]!.split(',').filter((m) => m !== '') };
};

/** The lookups for one measurement of the ways from this login to `svc`. */
export function lookups(probes: SwitchProbes, svc = ''): Lookups {
  const darwin = probes.platform() === 'darwin';
  const login = probes.login();
  const answers = new Map<string, Promise<RunResult>>();
  const run = (argv: readonly string[]): Promise<RunResult> => {
    const key = argv.join('\0');
    let answer = answers.get(key);
    if (answer === undefined) {
      answer = probes.run(argv);
      answers.set(key, answer);
    }
    return answer;
  };
  const getent = darwin ? undefined : findTool(probes, 'getent');
  /** `getent <db> <name>`: its first line, absent (exit 2), or unknown. */
  const ask = async (db: string, name: string): Promise<Found<string>> => {
    if (getent === undefined) return { unknown: notFound('getent') };
    if ('unknown' in getent) return { unknown: getent.unknown };
    const r = await run([getent.path, db, name]);
    if ('exit' in r && r.exit === 2 && r.stdout === '') return { absent: true };
    if ('exit' in r && r.exit === 0 && r.stderr === '') return { found: r.stdout.split('\n')[0]! };
    return { unknown: `getent ${db} ${name}: ${toolLine(r)}` };
  };
  const passwd = async (name: string): Promise<Found<PasswdEntry>> => {
    if (darwin) return { unknown: "macOS has no getent, so this user's entry is not read" };
    const a = await ask('passwd', name);
    if (!('found' in a)) return a;
    const e = parsePasswd(a.found);
    return e !== undefined ? { found: e } : { unknown: `getent passwd ${name} says: ${a.found}` };
  };
  const group = async (name: string): Promise<Found<GroupEntry>> => {
    if (darwin) {
      // 01b #9: this login's own groups work on macOS — read from /etc/group, a plain file.
      const text = probes.readText('/etc/group');
      if (text === undefined) return { unknown: '/etc/group cannot be read' };
      const lines = text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
      const e = lines.map(parseGroup).find((g) => g !== undefined && g.name === name);
      return e !== undefined ? { found: e } : { absent: true };
    }
    const a = await ask('group', name);
    if (!('found' in a)) return a;
    const e = parseGroup(a.found);
    return e !== undefined ? { found: e } : { unknown: `getent group ${name} says: ${a.found}` };
  };
  const netgroupUsers = async (name: string): Promise<Found<string[]>> => {
    if (darwin) return { unknown: 'macOS has no getent, so netgroups are not read' };
    const a = await ask('netgroup', name);
    if (!('found' in a)) return a;
    // `name ( host,user,domain) (…)`: the user field of each triple; an empty one is any user.
    const triples = [...a.found.matchAll(/\(\s*([^,)]*),\s*([^,)]*),\s*([^)]*)\)/g)];
    if (triples.length === 0) return { unknown: `getent netgroup ${name} says: ${a.found}` };
    return { found: triples.map((t) => t[2]!.trim()) };
  };
  const loginIn = async (name: string): Promise<Found<boolean>> => {
    const g = await group(name);
    if (!('found' in g)) return 'absent' in g ? { found: false } : g;
    const gids = probes.groups();
    if (g.found.members.includes(login) || gids?.includes(g.found.gid) === true) {
      return { found: true };
    }
    if (gids === undefined) return { unknown: "this process's groups could not be read" };
    return { found: false };
  };
  let groupSource: GroupSource | undefined;
  const userIn = async (
    user: PasswdEntry,
    name: string,
  ): Promise<Found<boolean> | { found: false; listed: true }> => {
    if (darwin) return { unknown: `macOS has no getent, so ${user.name}'s groups are not read` };
    // A §F7: `#gid` is looked up too, so a secondary group counts, not only the primary one
    const g = await group(name.startsWith('#') ? name.slice(1) : name);
    if ('unknown' in g) return g;
    // #819 follow-up 2 (member 5): a `#gid` with no group entry is compared as the number sudo reads
    if ('absent' in g) {
      const id = numericId(name);
      return { found: id === 'negative' || (id !== undefined && id === user.gid) };
    }
    if (g.found.gid === user.gid || g.found.members.includes(user.name)) return { found: true };
    // #819 (08, A Outside 2): a group that lists no members may hide them (SSSD's
    // ignore_group_members), and `getent initgroups` is not one of rail 1's calls — not known
    if (g.found.members.length === 0) {
      return {
        unknown: `getent group ${g.found.name} lists no members, so whether ${user.name} is in it is not known`,
      };
    }
    // #819 correction 1 (SEP-00 (f)): a member list is complete only from a local source
    groupSource ??= groupSourceOf(probes);
    if ('unknown' in groupSource) return { unknown: groupSource.unknown };
    if ('directory' in groupSource) {
      return {
        unknown: `/etc/nsswitch.conf lists ${groupSource.directory} for ${groupSource.database === 'group' ? 'groups' : 'initgroups'}, so ${user.name}'s membership of ${g.found.name} may not all be listed`,
      };
    }
    return { found: false, listed: true };
  };
  return { probes, login, svc, darwin, run, passwd, group, netgroupUsers, loginIn, userIn };
}
