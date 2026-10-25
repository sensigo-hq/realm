// separation-check.ts — #627 W (§5.9 under the sort's row 15/16): `realm mcp|serve --check`'s
// separation check. It MEASURES, as the login that runs it, what that login can reach of Realm's
// store and of the programs Realm runs; core types the evidence and derives the mode and the claim
// (`separationModeOf`, `separationPrevents`). It prints logins and paths, never a token, a secret or
// an environment. This file starts no process (correction 2, 5.9). #790: condition 2's read-only
// calls — sudo's listing, doas's and polkit's check modes, the user and group lookups — go through
// `separation/runner.ts`, the check's one spawn site, which refuses every other argv.
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { osLogin } from './program-identity.js';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  separationGaps,
  separationModeOf,
  separationPrevents,
  valueMeasuredWithheld,
  type ConditionReading,
  type GateAnswers,
  type SeparationCondition,
  type SeparationEvidence,
  type SeparationGap,
  type SeparationMode,
  type Source,
  type SwitchClause,
  type SwitchPathReading,
  type SwitchWhose,
  switchClausesOf,
  switchPathsCondition,
} from '@sensigo/realm';
import {
  lookups,
  measureSwitchPaths,
  POLKITD,
  rootEngineReach,
  SSHD_UNITS,
  SYSTEM_DIRS,
  systemRunner,
  UNIT_DIRS,
  type SwitchProbes,
} from './separation/index.js';

/**
 * What the check reads from the machine — injectable, so every cell runs on a fixture. #790: the
 * switch-path readers' probes (`SwitchProbes`: the uid from the process, correction 2 5.2; the login's
 * own passwd home, never `$HOME`, correction 1 D4; stat, file reads, socket connects, and the one
 * runner), plus what the other conditions read.
 */
export interface SeparationProbes extends SwitchProbes {
  /** `$HOME`: where Realm's store is read (correction 1 D4: the store only). */
  home: () => string;
  /** The Node binary that runs this check, and Realm's own package folder (correction 1 D3). */
  execPath: () => string;
  realmPackageDir: () => string;
  userName: (uid: number) => string | undefined;
  /** A path's own owner and mode, a link's not its target's (#819 correction 1, SEP-00 (g)). */
  lstat: (path: string) => { uid: number; mode: number } | { error: string };
}

const tryAccess = (path: string, mode: number): boolean => {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
};

/** The real machine's probes. */
export function systemProbes(): SeparationProbes {
  // Correction 2 (5.2): the uid from the process itself — it needs no passwd entry; the login's name
  // and home only from its passwd entry, never `$HOME`. #819 (C4): `process.getuid` alone —
  // `os.userInfo().uid` is -1 on Windows, which has no getuid, so there the uid is not known.
  const uid = (): number | undefined => process.getuid?.();
  return {
    login: () => {
      const name = osLogin()?.name;
      if (name !== undefined) return name;
      const id = uid();
      return id !== undefined ? `uid ${id}` : 'an unnamed login';
    },
    uid,
    home: () => homedir(),
    loginHome: () => osLogin()?.home,
    stat: (path) => {
      try {
        const s = statSync(path);
        return { uid: s.uid, mode: s.mode };
      } catch (err) {
        return { error: (err as NodeJS.ErrnoException).code ?? 'unknown' };
      }
    },
    lstat: (path) => {
      try {
        const s = lstatSync(path);
        return { uid: s.uid, mode: s.mode };
      } catch (err) {
        return { error: (err as NodeJS.ErrnoException).code ?? 'unknown' };
      }
    },
    execPath: () => process.execPath,
    // This file is `<package>/dist/lib/separation-check.js`.
    realmPackageDir: () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    env: process.env,
    userName: (uid) => {
      const passwd = (() => {
        try {
          return readFileSync('/etc/passwd', 'utf8');
        } catch {
          return undefined;
        }
      })();
      const line = passwd?.split('\n').find((l) => l.split(':')[2] === String(uid));
      return line?.split(':')[0];
    },
    canWrite: (path) => tryAccess(path, constants.W_OK),
    canRead: (path) => tryAccess(path, constants.R_OK),
    exists: (path) => existsSync(path),
    readText: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    list: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return undefined;
      }
    },
    realPath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return undefined;
      }
    },
    groups: () => process.getgroups?.(),
    pid: () => process.pid,
    platform: () => process.platform,
    run: systemRunner,
    connect: (target) =>
      new Promise((done) => {
        const socket =
          'path' in target
            ? createConnection({ path: target.path })
            : createConnection({ host: target.host, port: target.port });
        const finish = (ok: boolean): void => {
          socket.destroy();
          done(ok);
        };
        socket.setTimeout(1500, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
      }),
  };
}

/** What a stat of the store said (correction 1 D1): there; not found; or not even stat-able. */
type StoreState = 'present' | 'missing' | 'denied' | { other: string };

/** Condition 1: can this login write Realm's store, or open its files? */
function storeReach(
  probes: SeparationProbes,
  store: string,
  state: StoreState,
  ownsStore: boolean,
): ConditionReading {
  // Correction 1 (D1): a store this login cannot even stat is measured out of its reach; one that is
  // not found reads unknown (#819 Unit B: and so does the first line) — never read as the same login.
  if (state === 'missing')
    return { basis: 'unknown', cause: `Realm's store was not found at ${store}` };
  if (state === 'denied')
    return { basis: 'measured', answer: 'no', detail: `${store}: permission denied` };
  if (typeof state === 'object')
    return { basis: 'unknown', cause: `${store} could not be read (${state.other})` };
  // #819 (C3): a store this login owns is within its reach whatever its mode: its owner can change
  // who may open it.
  if (ownsStore) {
    return {
      basis: 'measured',
      answer: 'yes',
      detail: 'this login owns the store, so it can change who may open it',
    };
  }
  const runs = join(store, 'runs');
  const workflows = join(store, 'workflows');
  const writable = [store, runs, workflows].filter((p) => probes.exists(p) && probes.canWrite(p));
  if (writable.length > 0)
    return { basis: 'measured', answer: 'yes', detail: `${writable[0]} is writable` };
  const readable = [runs, workflows].filter((p) => probes.exists(p) && probes.canRead(p));
  if (readable.length > 0)
    return { basis: 'measured', answer: 'yes', detail: `${readable[0]} can be read` };
  return { basis: 'measured', answer: 'no' };
}

/** Why no service user is named, when none is (correction 1 D1; correction 2, 5.2 and 5.3). */
type NoServiceUser = 'own_store' | 'no_store' | 'owner_unread' | 'no_uid';

/** Condition 2: can this login become Realm's service user without a password? #790 (D13): read
 *  from every way to it, each without acting (`measureSwitchPaths`); with no service user named,
 *  W's early unknown, and no ways are read (01b #1). */
async function becomeServiceUser(
  probes: SeparationProbes,
  svc: string | undefined,
  why: NoServiceUser,
  store: string,
): Promise<{ reading: ConditionReading; paths?: SwitchPathReading[] }> {
  if (svc === undefined) {
    const cause = {
      own_store: 'there is no separate service user: the store belongs to this login',
      no_store: 'there is no service user to name: no store was found',
      owner_unread: `the store's owner could not be read: ${store} cannot be opened`,
      no_uid: "there is no service user to name: this login's uid could not be read",
    }[why];
    return { reading: { basis: 'unknown', cause } };
  }
  const paths = await measureSwitchPaths({ probes, svc });
  return { reading: switchPathsReading(paths, svc), paths };
}

/** #790 (D13): condition 2's reading from the ways read, in the CLI's words (01b #2). */
export function switchPathsReading(
  paths: readonly SwitchPathReading[],
  svc: string,
): ConditionReading {
  // #819 (08, B Outside 5): every place the ways were looked for, polkitd's and sshd's included;
  // #819 correction 1 (A MINOR 3): sshd on PATH too, and its units by name
  const where = `in ${SYSTEM_DIRS.join(', ')} or on PATH (polkitd also at ${POLKITD.join(', ')}; sshd's units ${SSHD_UNITS.join(', ')} in ${UNIT_DIRS.join(', ')})`;
  // #819 (08, walk new 2): an entry printed once — with Realm's service user root, its password's
  // two readings render alike
  const seen = new Set<string>();
  const shown = paths.filter((r) => {
    const entry = switchPathEntry(r, svc);
    if (seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });
  // #819 Unit B: how a tool was read is said once — an entry read by the same tool the same way as
  // the one just before it prints "as above" in its place (after the dedupe, so a second copy's
  // entries are kept)
  const entries = shown.map((r, i) => {
    const prev = shown[i - 1];
    const asAbove = prev !== undefined && prev.tool === r.tool && prev.how === r.how;
    return switchPathEntry(asAbove ? { ...r, how: 'as above' } : r, svc);
  });
  return switchPathsCondition(shown, (r) => entries[shown.indexOf(r)]!, where);
}

/** 01b #2: whose credential a closed way needs, in words. #819 Unit A, the capped correction (Part 7):
 *  a named user's, by its raw name (rail 5). */
function whoseWords(whose: SwitchWhose | undefined, svc: string, user?: string): string {
  switch (whose) {
    case 'named_user':
      return `${user ?? 'another user'}'s password`;
    case 'svc':
      return `${svc}'s password`;
    case 'root':
      return "root's password";
    case 'administrator':
      return "an administrator's password";
    case 'person':
      return "a person's touch or key";
    default:
      return "this login's password";
  }
}

/** 01b #2: one way's entry on condition 2's line, `⟨path⟩: ⟨outcome⟩ (⟨how⟩)`. */
export function switchPathEntry(r: SwitchPathReading, svc: string): string {
  // #819 (08, A F1): a credential read only because sudo hides its Defaults carries its cause, and
  // is printed as what it is — "may need"
  const mayNeed = r.outcome === 'needs_credential' && r.cause !== undefined;
  const outcome =
    r.outcome === 'yes'
      ? 'yes'
      : r.outcome === 'not_allowed'
        ? 'not allowed'
        : r.outcome === 'unknown'
          ? `unknown: ${r.cause ?? 'not read'}`
          : mayNeed
            ? `may need ${whoseWords(r.whose, svc, r.user)} (${r.cause})`
            : r.or_not_allowed === true
              ? "needs this login's password or is not allowed (sudo does not say which)"
              : r.path === 'ssh'
                ? `needs a key ${svc} accepts`
                : `needs ${whoseWords(r.whose, svc, r.user)}`;
  // W's friction: an outcome's own parenthetical and the how's merge into one — #819 (08, B F12):
  // only the parentheticals this renderer writes, never an unknown's cause
  const own = r.outcome === 'needs_credential' && (mayNeed || r.or_not_allowed === true);
  return own ? `${r.path}: ${outcome.slice(0, -1)}; ${r.how})` : `${r.path}: ${outcome} (${r.how})`;
}

/** Correction 2 (5.2): a reading for a condition the login's own home is needed for, when it has none. */
function noLoginHome(what: string): ConditionReading {
  return {
    basis: 'unknown',
    cause: `this login's home could not be read: it has no passwd entry, so ${what}`,
  };
}

/** The files Realm executes for the deployment roots the check knows (realm.yaml and its module refs). */
function trustRootFiles(probes: SeparationProbes, roots: readonly string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    // #819 (C1): the root resolved, so the folders above a relative one are walked too
    const manifest = resolve(root, 'realm.yaml');
    if (!probes.exists(manifest)) continue;
    files.push(manifest);
    const text = probes.readText(manifest) ?? '';
    for (const m of text.matchAll(/^\s*use:\s*['"]?([^'"#\s]+\.(?:m?js|cjs|ts))/gm)) {
      const ref = m[1]!;
      files.push(isAbsolute(ref) ? ref : resolve(root, ref));
    }
  }
  return files;
}

/**
 * What the registered workflows tell the check, where the store can be read: the deployment roots
 * they name (`trust_root`), and each one's `extensions:` files resolved against its stored
 * `source_dir` (correction 1 D3, as the extension loader resolves them). `readable: false` when the
 * workflows' folder cannot be listed (the separate-user setup, where it is the store of another user).
 */
function storedDefinitions(
  probes: SeparationProbes,
  store: string,
): { roots: string[]; extensions: string[]; readable: boolean } {
  const dir = join(store, 'workflows');
  const names = probes.list(dir);
  const roots: string[] = [];
  const extensions: string[] = [];
  for (const name of names ?? []) {
    if (!name.endsWith('.json')) continue;
    const text = probes.readText(join(dir, name));
    if (text === undefined) continue;
    try {
      const def = JSON.parse(text) as {
        trust_root?: unknown;
        source_dir?: unknown;
        extensions?: unknown;
      };
      if (typeof def.trust_root === 'string' && def.trust_root !== '') roots.push(def.trust_root);
      const declared =
        typeof def.extensions === 'string'
          ? [def.extensions]
          : Array.isArray(def.extensions)
            ? def.extensions.filter((e): e is string => typeof e === 'string')
            : [];
      if (typeof def.source_dir === 'string') {
        for (const e of declared) extensions.push(resolve(def.source_dir, e));
      }
    } catch {
      // a copy that is not JSON names no root and no extension
    }
  }
  return { roots, extensions, readable: names !== undefined };
}

/** The sticky bit (`o+t`) of a folder's mode. */
const STICKY = 0o1000;

/**
 * Correction 2 (5.6): whether this login can change `path` — it, or any folder above it, is writable
 * by this login, except a sticky folder (`o+t`) whose entry on the way down is not this login's (such
 * a folder lets a login replace only its own entries). #819 (C1): `path` is absolute — every file
 * the check names is resolved where it is named (`trustRootFiles`, the executed files) — and the
 * folders above the file a link points at count too, beside the link's own folders, never instead of
 * them (the `realPath` probe). (C4): a sticky folder this login owns lets it rename any entry.
 * #819 correction 1 (SEP-00 (g)): an entry's owner is its own — a link's, through `lstat`, never
 * the file it points at.
 */
function changeable(probes: SeparationProbes, path: string): boolean {
  if (probes.exists(path) && probes.canWrite(path)) return true;
  if (chainChangeable(probes, path)) return true;
  const target = probes.realPath(path);
  return target !== undefined && target !== path && chainChangeable(probes, target);
}

/** Whether a folder on the chain above `path` lets this login replace the entry under it. */
function chainChangeable(probes: SeparationProbes, path: string): boolean {
  const me = probes.uid();
  let entry = path;
  let dir = dirname(path);
  for (;;) {
    if (probes.canWrite(dir)) {
      const folder = probes.stat(dir);
      const sticky = 'mode' in folder && (folder.mode & STICKY) !== 0;
      const own = probes.lstat(entry);
      const mine =
        me !== undefined &&
        (('uid' in own && own.uid === me) || ('uid' in folder && folder.uid === me));
      if (!sticky || mine) return true;
    }
    const up = dirname(dir);
    if (up === dir) return false;
    entry = dir;
    dir = up;
  }
}

/**
 * Condition 4: can this login change a file Realm executes? The deployment roots' `realm.yaml` and
 * its module references, the `--extensions-module` file, the registered workflows' extension files,
 * the Node binary and Realm's own package folder (correction 1 D3, the design's M2) — each, or a
 * folder above it (correction 2, 5.6). `unread`: the registered workflows could not be listed, so
 * their extension files were not checked. With no realm.yaml found, the executed files and the
 * package are still checked (correction 2, 5.7): one changeable is "yes"; none is "unknown".
 */
function trustRootWritable(
  probes: SeparationProbes,
  roots: readonly string[],
  executed: readonly string[],
  unread: boolean,
): ConditionReading {
  const notRead = unread
    ? "; the registered workflows' extension files were not read (the store cannot be read)"
    : '';
  const manifests = trustRootFiles(probes, roots);
  const files = [...manifests, ...executed];
  const dir = probes.realmPackageDir();
  const writable = [...files, dir].find((f) => changeable(probes, f));
  if (writable !== undefined) {
    return { basis: 'measured', answer: 'yes', detail: `${writable} can be changed` };
  }
  if (manifests.length === 0) {
    // #819 follow-up 2 (walk --check wording): a deployment root that is not there is named
    const missing = roots.map((r) => resolve(r)).filter((r) => !probes.exists(r));
    return {
      basis: 'unknown',
      cause:
        missing.length > 0
          ? `no such folder: ${missing.join(', ')}${notRead}`
          : `no realm.yaml was found to check: pass --project with the deployment root${notRead}`,
    };
  }
  return {
    basis: 'measured',
    answer: 'no',
    detail: `${files.length + 1} files and folders checked${notRead}`,
  };
}

/** Condition 7: the agent apps' sandbox settings (Claude Code, Codex) — configured, never enforced by Realm. */
function agentSandbox(probes: SeparationProbes): ConditionReading {
  const home = probes.loginHome();
  // Correction 2 (5.2): with no login home, the apps' settings were never read.
  if (home === undefined) return noLoginHome("the agent apps' settings were not read");
  const found: string[] = [];
  // #819 correction 1 (walk --check wording 3): each file named under the home it was read from
  const claudeFile = join(home, '.claude', 'settings.json');
  const codexFile = join(home, '.codex', 'config.toml');
  const claude = probes.readText(claudeFile);
  if (claude !== undefined) {
    try {
      const parsed = JSON.parse(claude) as { sandbox?: { enabled?: unknown } };
      if (parsed.sandbox?.enabled === true) found.push(`Claude Code (${claudeFile})`);
    } catch {
      // not JSON: not a setting this check can read
    }
  }
  const codex = probes.readText(codexFile);
  const mode =
    codex !== undefined ? /^\s*sandbox_mode\s*=\s*"([^"]+)"/m.exec(codex)?.[1] : undefined;
  if (mode !== undefined && mode !== 'danger-full-access')
    found.push(`Codex (sandbox_mode = "${mode}")`);
  return found.length > 0
    ? { basis: 'configured_not_enforced', detail: found.join('; ') }
    : // Correction 2 (8.5): the "no" says what it read.
      {
        basis: 'measured',
        answer: 'no',
        // #819 (C4): what it looked at, whether or not either file is there
        detail: `only ${claudeFile} and ${codexFile} were looked at`,
      };
}

/** Condition 8 (informational): can this login change the runner's price file? #819 follow-up 2
 *  (walk --check wording): a realm.yaml that names none answers by whether that realm.yaml can be
 *  changed — the file the setting would be added to — and a realm.yaml not read says why, per root:
 *  no such folder, no realm.yaml there, or one that cannot be read. */
function economicsWritable(probes: SeparationProbes, roots: readonly string[]): ConditionReading {
  const readOnes: string[] = [];
  const why: string[] = [];
  for (const root of roots) {
    const manifest = resolve(root, 'realm.yaml');
    const text = probes.readText(manifest);
    if (text === undefined) {
      why.push(
        !probes.exists(resolve(root))
          ? `no such folder: ${resolve(root)}`
          : !probes.exists(manifest)
            ? `no realm.yaml in ${resolve(root)}`
            : `${manifest} cannot be read`,
      );
      continue;
    }
    readOnes.push(manifest);
    const named = /^\s*economics:\s*['"]?([^'"\s#]+)/m.exec(text)?.[1];
    if (named === undefined) continue;
    const path = isAbsolute(named) ? named : resolve(root, named);
    const writable =
      (probes.exists(path) && probes.canWrite(path)) || probes.canWrite(dirname(path));
    return { basis: 'measured', answer: writable ? 'yes' : 'no', detail: path };
  }
  // #819 correction 1 (A MINOR 9, walk --check wording 4): none given names the option that does
  if (readOnes.length === 0) {
    return {
      basis: 'unknown',
      cause:
        roots.length === 0
          ? 'no realm.yaml was given to read: pass --project with the deployment root'
          : why.join('; '),
    };
  }
  const changeableOne = readOnes.find((m) => changeable(probes, m));
  return changeableOne !== undefined
    ? {
        basis: 'measured',
        answer: 'yes',
        detail: `${changeableOne} can be changed, and it sets no runner.cache.economics`,
      }
    : {
        basis: 'measured',
        answer: 'no',
        detail: `${readOnes.join(', ')} cannot be changed, and ${readOnes.length === 1 ? 'it sets' : 'they set'} no runner.cache.economics`,
      };
}

/**
 * Measures the separation check's evidence as the login that runs it. `store` is Realm's store
 * folder as this command sees it (`$HOME/.realm`); `roots` the deployment roots it knows.
 */
export async function measureSeparation(args: {
  probes: SeparationProbes;
  value: { value: GateAnswers; source: Source };
  roots: readonly string[];
  /** The `--extensions-module` file the check's own command line names (correction 1 D3). */
  extensionsModule?: string | undefined;
  /** The door the check runs for: `realm mcp` sends forms, `realm serve` none (correction 1 D5). */
  door: 'mcp' | 'serve';
}): Promise<CheckEvidence> {
  const { probes } = args;
  const store = join(probes.home(), '.realm');
  // Correction 1 (D1): stat the store and tell the reasons apart — an EACCES store is there and out
  // of this login's reach; its owner is the owner of the nearest folder above it that can be stat'ed.
  const stat = probes.stat(store);
  const state: StoreState =
    'uid' in stat
      ? 'present'
      : stat.error === 'ENOENT'
        ? 'missing'
        : stat.error === 'EACCES'
          ? 'denied'
          : { other: stat.error };
  // Correction 2 (5.2, 5.3): the owner from the store's own stat; for a store this login cannot open,
  // from the nearest folder above it — labelled so, and never root or this login (a home under a
  // root-only folder; a folder of this login's): then the owner is unknown. With no uid, ownership
  // is unknown: the store is not another user's, and this login does not own it.
  const me = probes.uid();
  const near = state === 'denied' ? nearestOwner(probes, store) : undefined;
  const owner =
    'uid' in stat
      ? stat.uid
      : near !== undefined && near.uid !== 0 && near.uid !== me
        ? near.uid
        : undefined;
  const ownerFrom = 'uid' in stat || owner === undefined ? undefined : near?.dir;
  const ownedByOther = me !== undefined && owner !== undefined && owner !== me;
  const ownsStore = me !== undefined && 'uid' in stat && stat.uid === me;
  const svc = ownedByOther ? (probes.userName(owner) ?? `uid ${owner}`) : undefined;
  const noServiceUser: NoServiceUser =
    me === undefined
      ? 'no_uid'
      : state === 'missing'
        ? 'no_store'
        : ownsStore
          ? 'own_store'
          : 'owner_unread';
  const stored = storedDefinitions(probes, store);
  // Correction 1 (D3): the registered workflows' extension files are "not read" only where some may
  // exist — a store this login cannot open, or a workflows folder it cannot list. A store that is
  // not there, or one with no workflows folder, has none to read. Correction 2 (5.1): "no workflows
  // folder" only when its stat says ENOENT — `existsSync` answers false on EACCES too.
  const folder = probes.stat(join(store, 'workflows'));
  const noFolder = 'error' in folder && folder.error === 'ENOENT';
  const unread = !stored.readable && state !== 'missing' && !(state === 'present' && noFolder);
  const executed = [
    ...(args.extensionsModule !== undefined ? [resolve(args.extensionsModule)] : []),
    ...stored.extensions,
    probes.execPath(),
  ];
  const become = await becomeServiceUser(probes, svc, noServiceUser, store);
  const conditions: Record<SeparationCondition, ConditionReading> = {
    store_reach: storeReach(probes, store, state, ownsStore),
    become_service_user: become.reading,
    // #790 (D12): every engine that runs as root, and the groups that reach one or the disks.
    root_engine: await rootEngineReach(lookups(probes)),
    trust_root_writable: trustRootWritable(
      probes,
      [...new Set([...args.roots, ...stored.roots])],
      executed,
      unread,
    ),
    other_answer_host: {
      basis: 'unknown',
      cause: 'another Realm server or CLI could use this store, and one look cannot rule it out',
    },
    time_basis: {
      basis: 'measured',
      answer: 'fact',
      detail: "this machine's clock (the JSON store keeps no clock of its own)",
    },
    agent_sandbox: agentSandbox(probes),
    economics_writable: economicsWritable(probes, args.roots),
  };
  return {
    login: probes.login(),
    ...(svc !== undefined ? { service_user: svc } : {}),
    ...(svc !== undefined && ownerFrom !== undefined ? { service_user_from: ownerFrom } : {}),
    store_owned_by_other: ownedByOther,
    conditions,
    ...(become.paths !== undefined ? { switch_paths: become.paths } : {}),
    value: args.value,
    store,
    store_found: state !== 'missing',
    ...(state === 'denied' || typeof state === 'object' ? { store_unopened: true as const } : {}),
    owns_store: ownsStore,
    door: args.door,
    extensions_unread: unread,
    not_observed: [
      'other_answer_host' as const,
      ...(svc === undefined ? (['become_service_user'] as const) : []),
      ...(args.roots.length === 0 ? (['economics_writable'] as const) : []),
    ],
  };
}

/** The evidence the CLI renders: core's, with where it was read and for which door. */
export type CheckEvidence = SeparationEvidence & {
  store: string;
  /** Whether a store was there: its stat did not answer ENOENT (correction 2, 8.5). */
  store_found: boolean;
  /** #819 (C4): its stat failed for another reason (EACCES, …) — it may be there, and this login
   *  cannot open it. */
  store_unopened?: true;
  /** The folder whose owner the service user was read from, when the store could not be opened
   *  (correction 2, 5.3). */
  service_user_from?: string;
  door: 'mcp' | 'serve';
  /** The registered workflows could not be listed, so their extension files were not checked. */
  extensions_unread: boolean;
  /** #819 follow-up 2 (walk --check wording): the conditions whose unknown rests on nothing read
   *  now — another answer host (never looked at), the service user when none is named (no way is
   *  read), economics when no realm.yaml was given — printed "not measured", never "observed now". */
  not_observed?: readonly SeparationCondition[];
};

/** The owner of the nearest folder above `path` that can be stat'ed, and that folder (correction 1
 *  D1; correction 2, 5.3). */
function nearestOwner(
  probes: SeparationProbes,
  path: string,
): { uid: number; dir: string } | undefined {
  let dir = dirname(path);
  for (;;) {
    const s = probes.stat(dir);
    if ('uid' in s) return { uid: s.uid, dir };
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** The condition's words on its W-x2 line. */
/** The service user, labelled when read from a folder above the store (correction 2, 5.3). */
function serviceUserWords(e: SeparationEvidence & { service_user_from?: string }): string {
  const svc = e.service_user ?? "Realm's service user";
  return e.service_user_from !== undefined
    ? `${svc}, read from the owner of ${e.service_user_from}`
    : svc;
}

const CONDITION_WORDS: Record<
  SeparationCondition,
  (e: SeparationEvidence & { service_user_from?: string }) => string
> = {
  store_reach: () => "This login can write Realm's store or open its files",
  become_service_user: (e) =>
    `This login can become Realm's service user${e.service_user !== undefined ? ` (${serviceUserWords(e)})` : ''} without a password`,
  root_engine: () => 'This login can reach an engine that runs as root',
  // Correction 2 (5.6): what it measured — the Node binary and Realm package this check runs from.
  trust_root_writable: () =>
    'This login can change files Realm executes (realm.yaml, extension modules, and the Node binary and Realm package this check runs from)',
  other_answer_host: () => 'Another Realm server or CLI that takes answers uses this store',
  time_basis: () => "The store's time basis",
  agent_sandbox: () => "The agent's app runs it in a sandbox",
  economics_writable: () => 'This login can change runner.cache.economics (informational)',
};

/** W-x2: one condition's line. */
export function conditionLine(
  c: SeparationCondition,
  e: SeparationEvidence & {
    service_user_from?: string;
    not_observed?: readonly SeparationCondition[];
  },
): string {
  const r = e.conditions[c];
  const words = CONDITION_WORDS[c](e);
  switch (r.basis) {
    case 'measured':
      // Correction 2 (8.5): an information line carries its label too, "(fact)".
      // #790 (D11): condition 2 is read "now" — a credential cached later is not seen (clause b).
      // #819 correction 1 (walk --check wording 2): condition 7 is read from two files, and says so
      return r.answer === 'fact'
        ? `${words}: ${r.detail} (fact).`
        : `${words}: ${r.answer} (${c === 'become_service_user' ? 'measured now' : c === 'agent_sandbox' ? 'read from two files' : 'measured'})${r.detail !== undefined ? ` — ${r.detail}` : ''}.`;
    case 'configured_not_enforced':
      return `${words}: configured, not enforced by Realm — ${r.detail}.`;
    case 'unknown':
      // #819 follow-up 2 (walk --check wording): "observed now" only where a read made now gave it
      return e.not_observed?.includes(c) === true
        ? `${words}: not measured (${r.cause}).`
        : `${words}: unknown (${r.cause}; observed now).`;
  }
}

/** The value condition's line (F36): measured only when given on this command line. */
export function valueLine(e: CheckEvidence): string {
  const v = e.value;
  if (v.value === 'withheld') {
    return valueMeasuredWithheld(e)
      ? 'The gate-answers value: withheld (given on this command line).'
      : `The gate-answers value: withheld, configured, not enforced by Realm — from ${v.source.ref}; the running server's value is not read.`;
  }
  // Correction 1 (D5): under `asked` the answer way depends on the door — `realm mcp` sends forms to
  // apps that show them; `realm serve` sends none.
  const keeps =
    v.value === 'offered'
      ? 'the agent keeps an answer way'
      : e.door === 'serve'
        ? 'every client keeps an answer way (this server sends no forms)'
        : 'the agent keeps an answer way in apps without forms';
  return `The gate-answers value: ${v.value} (from ${v.source.ref}) — ${keeps}.`;
}

const MODE_WORDS: Record<SeparationMode, string> = {
  same_account: 'same login',
  sandbox_configured: 'sandbox configured',
  separate_user: 'separate user',
  // #819 Unit B: the condition lines' word for a state the check could not tell
  unknown: 'unknown',
};

/** What each prevents condition is about, for its gap's words. */
const GAP_SUBJECT: Record<Exclude<SeparationGap['gap'], 'value'>, string> = {
  store_reach: "reach Realm's store",
  become_service_user: "become Realm's service user without a password",
  root_engine: 'reach an engine that runs as root',
  trust_root_writable: 'change the files Realm executes',
};

/** One gap's words, by its reading (correction 1 D1: an unknown never reads "it can"; #819 Unit B:
 *  it reads as its condition line does — "is unknown", or "was not measured" when nothing was read
 *  for it, its condition in `not_observed`). */
function gapWords(g: SeparationGap, notObserved: readonly SeparationCondition[]): string {
  if (g.gap === 'value') {
    return "the gate-answers value: give it on this command line, and read the running server's start line";
  }
  const r = g.reading;
  const subject = GAP_SUBJECT[g.gap];
  // Correction 2 (5.4): condition 1's "yes" by what was measured — written, or read only.
  if (g.gap === 'store_reach' && r.basis === 'measured' && r.answer === 'yes') {
    return r.detail?.endsWith(' can be read') === true
      ? "it can read Realm's store"
      : "it can write Realm's store";
  }
  if (r.basis === 'measured' && r.answer === 'yes') return `it can ${subject}`;
  if (r.basis === 'configured_not_enforced')
    return `whether it can ${subject} is configured, not enforced by Realm`;
  if (r.basis === 'unknown' && !notObserved.includes(g.gap))
    return `whether it can ${subject} is unknown`;
  return `whether it can ${subject} was not measured`;
}

/** #790 (D11): one clause of the strong sentence, word for word (no backticks on a terminal line,
 *  W correction 2 §4.7). ⟨svc⟩ is the raw user name (rail 5). */
function clauseWords(c: SwitchClause, login: string, svc: string): string {
  switch (c.clause) {
    case 'a':
      // #819 Unit A, the capped correction (Parts 3, 7; W-860-MA3-13): every password but an
      // administrator's may be empty, which pam_unix's nullok lets through
      return c.whose === 'this_login'
        ? `the agent cannot obtain ${login}'s password, and it is not empty`
        : c.whose === 'svc'
          ? `the agent cannot obtain ${svc}'s password, and it is not empty`
          : c.whose === 'root'
            ? "the agent cannot obtain root's password, and it is not empty"
            : c.whose === 'named_user'
              ? `the agent cannot obtain ${c.user ?? 'another user'}'s password, and it is not empty`
              : "the agent cannot obtain an administrator's password";
    case 'b':
      // B §10: only the tools whose cache fired
      return `nobody authenticates ${orList(c.tools)} as ${login} where the agent's processes run (${c.tools.length === 1 ? 'it then waives' : 'each then waives'} the password for some minutes)`;
    case 'c':
      // #819 (08, A F4): the refusal hides runaspw and the PAM services too
      // #819 correction 1 (A BLOCKING 1, SEP-00 (d)): the askpass stack, and the ticket's scope;
      // #819 follow-up 2 (A S3): !tty_tickets too, and the ticket folder and owner a login could forge
      return `sudo turns off its password only through NOPASSWD tags (its listpw setting is the default, no Defaults!… or Defaults>… line sets !authenticate, no runaspw setting names a user other than root or ${svc}, no pam_service, pam_login_service or pam_askpass_service setting names another PAM stack, no timestamp_type or tty_tickets setting shares one ticket across sessions, and no timestampdir or timestampowner setting lets ${login} write the tickets)`;
    case 'd': {
      // W §8: the entry points (#819, 08 B F11: of the actions asked; "polkit's actions" when there
      // is none); W §5: each rules folder as `exists` and `canRead` (access R_OK) read it
      const words = { unreadable: 'cannot be read here', unread: 'are not read' } as const;
      const tools = c.tools.length > 0 ? orList(c.tools) : "polkit's actions";
      return `no polkit rule grants ${login} ${tools} beyond what this check's own session was shown (polkit's admin rules ${words[c.admin]}; its vendor rules ${words[c.vendor]})`;
    }
    case 'e':
      return 'no person approves a Touch ID, fingerprint or security-key prompt the agent raises';
    case 'f':
      return `${svc}'s authorized_keys holds none of ${login}'s keys`;
    case 'g':
      // #819 correction 1 (realm-2c for the owner; SEP-03 item 1b): membership as the system lists it;
      // #819 follow-up 2 (A S1): what the branch read — the members each group lists
      return `the members the system lists for each group read are all of its members (a member the system does not list is not seen)`;
  }
}

/** `a`, `a or b`, `a, b or c`. */
const orList = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)!}`;

/** W-x3: the claim, chosen by the measured mode and the predicate. */
export function separationClaim(
  e: SeparationEvidence & {
    extensions_unread?: boolean;
    service_user_from?: string;
    not_observed?: readonly SeparationCondition[];
  },
): string {
  if (separationPrevents(e)) {
    // Correction 1 (D3): what the check could not read is named in the proviso, as the running
    // server's value is. Correction 2 (5.6): and that Realm's server runs the Node and the Realm
    // package this check measured; no backticks on a terminal line (4.7's rule).
    // #790 (D11): then the clauses the ways read fired — each names what no program can see from
    // this login, and none is printed for a way that is absent (one composer, R13).
    const svc = e.service_user_from !== undefined ? `${serviceUserWords(e)},` : serviceUserWords(e);
    const always = [
      `no program Realm runs as ${svc} can run code for it`,
      "Realm's server runs this Node and this Realm package",
      'every Realm server on this machine starts with --gate-answers withheld',
      ...(e.extensions_unread === true
        ? [
            "no registered workflow's extension file (not read: the store cannot be read) can be changed by this login",
          ]
        : []),
    ];
    // #819 (08, walk new 2): each clause once — with Realm's service user root, (a) is said for it
    // once, with "and it is not empty"; #819 correction 1 (A MINOR 4): root's password is then the
    // service user's, whether or not (a) also fired for it
    const svcIsRoot = e.service_user === 'root';
    const fired = switchClausesOf(e.switch_paths ?? []).map((c) =>
      svcIsRoot && c.clause === 'a' && c.whose === 'root' ? { ...c, whose: 'svc' as const } : c,
    );
    const clauses = [
      ...new Set(
        fired.map((c) => clauseWords(c, e.login, e.service_user ?? "Realm's service user")),
      ),
    ];
    // W's always-clauses exactly as the base joins them; #790's clauses follow, joined by "; ",
    // since each may carry commas of its own.
    const list = (items: string[], sep: string): string =>
      items.length === 1 ? items[0]! : `${items.slice(0, -1).join(sep)}${sep}and ${items.at(-1)!}`;
    const proviso =
      clauses.length === 0
        ? list(always, ', ')
        : `${list(always, ', ')}; and provided ${list(clauses, '; ')}`;
    return `An agent running as ${e.login} cannot record a gate answer through this server, the terminal or Realm's files, provided ${proviso}.`;
  }
  if (separationModeOf(e) === 'same_account') {
    return "An agent running as this login could answer a gate through the terminal or by editing Realm's files; Realm records how each answer arrived but cannot stop it.";
  }
  return `An agent running as ${e.login} may still be able to answer a gate: ${separationGaps(e)
    .map((g) => gapWords(g, e.not_observed ?? []))
    .join('; ')}.`;
}

/** The whole check's lines: W-x1, the login measured, each W-x2 line, the value line. */
export function renderSeparation(e: CheckEvidence): string[] {
  const lines = [
    `Separation: ${MODE_WORDS[separationModeOf(e)]} — ${separationClaim(e)}`,
    // Correction 2 (8.5): a store that was not found is not one the check measured against.
    `${
      e.store_found
        ? e.store_unopened === true
          ? // #819 correction 1 (walk --check wording 5): its stat failed, so it may not be there
            `Measured for the login '${e.login}', against ${e.store}, which this login cannot open, so whether a store is there is unknown.`
          : `Measured for the login '${e.login}', against the store at ${e.store}.`
        : `Measured for the login '${e.login}'; no store was found at ${e.store}.`
    }${
      e.owns_store
        ? " This login owns the store: if it is Realm's service user, run the check from the agent's own shell instead."
        : ''
    }`,
    ...(
      [
        'store_reach',
        'become_service_user',
        'root_engine',
        'trust_root_writable',
        'other_answer_host',
        'time_basis',
        'agent_sandbox',
        'economics_writable',
      ] as const
    ).map((c) => `  ${conditionLine(c, e)}`),
    `  ${valueLine(e)}`,
  ];
  return lines;
}
