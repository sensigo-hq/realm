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
 *  the same for the file a link resolves to. */
function systemCopy(probes: SwitchProbes, path: string): boolean {
  const real = probes.realPath(path) ?? path;
  return [path, real].every((p) => {
    const s = probes.stat(p);
    return 'uid' in s && s.uid === 0 && !probes.canWrite(p) && !probes.canWrite(dirname(p));
  });
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
  const seen = new Set<string>();
  for (const p of SYSTEM_DIRS.map((d) => join(d, name)).filter((q) => probes.exists(q))) {
    if (!systemCopy(probes, p)) out.unknown.push(`${name} at ${p} is not a root-owned system copy`);
    else if (!seen.has(probes.realPath(p) ?? p)) {
      seen.add(probes.realPath(p) ?? p);
      out.paths.push(p);
    }
  }
  return out;
}

/** The one copy of `name` to ask (01b #8): the first good one, or unknown when any copy is not. */
export function findTool(probes: SwitchProbes, name: string): ToolFound {
  const found = findTools(probes, name);
  if (found.unknown.length > 0) return { unknown: found.unknown[0]! };
  return found.paths.length > 0 ? { path: found.paths[0]! } : undefined;
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
  /** Whether `user` (svc or root) is in the group `name` (`#gid` or a name). macOS: unknown (01b #9). */
  userIn: (user: PasswdEntry, name: string) => Promise<Found<boolean>>;
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
    if (getent === undefined) return { unknown: 'getent was not found in the system folders' };
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
  const userIn = async (user: PasswdEntry, name: string): Promise<Found<boolean>> => {
    if (darwin) return { unknown: `macOS has no getent, so ${user.name}'s groups are not read` };
    // A §F7: `#gid` is looked up too, so a secondary group counts, not only the primary one
    const g = await group(name.startsWith('#') ? name.slice(1) : name);
    if ('unknown' in g) return g;
    if ('absent' in g) return { found: name === `#${user.gid}` };
    return { found: g.found.gid === user.gid || g.found.members.includes(user.name) };
  };
  return { probes, login, svc, darwin, run, passwd, group, netgroupUsers, loginIn, userIn };
}
