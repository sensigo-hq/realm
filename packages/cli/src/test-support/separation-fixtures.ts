// separation-fixtures.ts — #790 (D2 §5, rail 7): the separation check's captured fixtures, and the
// fixture machines the cells run the readers on. Every tool answer a machine gives is a captured
// fixture: a file under `lib/separation/fixtures/<image>/`, which opens with its header line (where
// it was captured, the command, the date). Test support only: not in the published package.
import { readFileSync } from 'node:fs';
import type { Runner, RunResult } from '../lib/separation/runner.js';
import type { SwitchProbes } from '../lib/separation/lookup.js';

const ROOT = new URL('../lib/separation/fixtures/', import.meta.url);

/** A fixture file's body, without its header line. */
export function fixtureFile(name: string): string {
  const text = readFileSync(new URL(`${name}.txt`, ROOT), 'utf8');
  if (!text.startsWith('# ')) throw new Error(`${name}: a fixture opens with its header line`);
  return text.slice(text.indexOf('\n') + 1);
}

/** A captured call: its exit status, stdout and stderr. */
export function capture(name: string): RunResult {
  const body = fixtureFile(name);
  const m = /^exit (\d+)\n--- stdout\n([\s\S]*?)--- stderr\n([\s\S]*)$/.exec(body);
  if (m === null) throw new Error(`${name}: not a captured call`);
  return { exit: Number(m[1]), stdout: m[2]!, stderr: m[3]! };
}

/** What a fixture machine holds. Paths not named do not exist. */
export interface MachineSpec {
  login?: string;
  uid?: number;
  platform?: string;
  groups?: number[];
  /** The login's own home; `null` for a login with no passwd entry. */
  home?: string | null;
  env?: Record<string, string>;
  /** Readable files: path → text, or a fixture's body by `{ fixture }`. */
  files?: Record<string, string | { fixture: string }>;
  /** Files that exist but this login cannot read. */
  unreadable?: string[];
  /** Folders: path → names (`undefined` names: a folder this login cannot list). */
  dirs?: Record<string, string[] | undefined>;
  /** Programs: path → owner uid (root unless said). */
  programs?: Record<string, number>;
  /** Symbolic links: path → the path they resolve to. */
  links?: Record<string, string>;
  /** Paths this login can write. */
  writable?: string[];
  /** Calls: the argv joined by spaces → a captured fixture's name. */
  calls?: Record<string, string>;
  /** Unix sockets that exist, and whether each accepts. */
  sockets?: Record<string, boolean>;
}

/** Every argv a fixture machine's runner was asked, in order: the spy (02, D1). */
export const asked: string[][] = [];

/** A fixture machine: its probes answer from `spec`, its runner from captured calls only. */
export function fixtureMachine(spec: MachineSpec): SwitchProbes {
  const files = spec.files ?? {};
  const text = (p: string): string | undefined => {
    const f = files[p];
    return f === undefined ? undefined : typeof f === 'string' ? f : fixtureFile(f.fixture);
  };
  const exists = (p: string): boolean =>
    p in files ||
    (spec.unreadable ?? []).includes(p) ||
    (spec.dirs !== undefined && p in spec.dirs) ||
    (spec.programs !== undefined && p in spec.programs) ||
    (spec.sockets !== undefined && p in spec.sockets);
  const run: Runner = async (argv) => {
    asked.push([...argv]);
    const name = spec.calls?.[argv.join(' ')];
    return name !== undefined ? capture(name) : { error: `no capture for ${argv.join(' ')}` };
  };
  return {
    login: () => spec.login ?? 'agent',
    uid: () => spec.uid ?? 1001,
    loginHome: () => (spec.home === null ? undefined : (spec.home ?? '/home/agent')),
    env: spec.env ?? { PATH: '/usr/local/bin:/usr/bin:/bin' },
    stat: (p) =>
      spec.programs !== undefined && p in spec.programs
        ? { uid: spec.programs[p]!, mode: 0o100755 }
        : exists(p)
          ? { uid: 0, mode: 0o100644 }
          : { error: 'ENOENT' },
    exists,
    canRead: (p) => p in files,
    canWrite: (p) => (spec.writable ?? []).includes(p),
    readText: text,
    list: (d) => spec.dirs?.[d],
    realPath: (p) => spec.links?.[p] ?? (exists(p) ? p : undefined),
    groups: () => spec.groups ?? [1001],
    pid: () => 4242,
    platform: () => spec.platform ?? 'linux',
    connect: async (t) => 'path' in t && spec.sockets?.[t.path] === true,
    run,
  };
}

/** The captured answers of `getent` when the user or group is not there (exit 2, no output) —
 *  for machines whose cells are about something else (W's cells). */
export const notFoundRunner: Runner = async (argv) => {
  asked.push([...argv]);
  if (argv[0]?.endsWith('/getent') === true) {
    return capture(
      argv[1] === 'passwd' ? 'ubuntu-25.10/getent.passwd.none' : 'ubuntu-25.10/getent.group.none',
    );
  }
  return { error: `no capture for ${argv.join(' ')}` };
};
