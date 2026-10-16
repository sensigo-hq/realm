// separation-check.ts — #627 W (§5.9 under the sort's row 15/16): `realm mcp|serve --check`'s
// separation check. It MEASURES, as the login that runs it, what that login can reach of Realm's
// store and of the programs Realm runs; core types the evidence and derives the mode and the claim
// (`separationModeOf`, `separationPrevents`). It prints logins and paths, never a token, a secret or
// an environment. Command output is parsed with `LC_ALL=C`.
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { osLogin } from './program-identity.js';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  separationGaps,
  separationModeOf,
  separationPrevents,
  valueMeasuredWithheld,
  type ConditionReading,
  type GateAnswers,
  type SeparationCondition,
  type SeparationEvidence,
  type SeparationMode,
  type Source,
} from '@sensigo/realm';

/** What the check reads from the machine — injectable, so every cell runs on a fixture. */
export interface SeparationProbes {
  login: () => string;
  uid: () => number;
  home: () => string;
  env: Record<string, string | undefined>;
  ownerOf: (path: string) => number | undefined;
  userName: (uid: number) => string | undefined;
  canWrite: (path: string) => boolean;
  canRead: (path: string) => boolean;
  exists: (path: string) => boolean;
  readText: (path: string) => string | undefined;
  list: (dir: string) => string[] | undefined;
  /** Runs a command with `LC_ALL=C`; its exit status (`null` when it did not finish). */
  run: (command: string, args: string[]) => number | null;
  /** Connects to a socket: a Unix socket path, or `host:port`. True iff it accepted. */
  connect: (target: { path: string } | { host: string; port: number }) => Promise<boolean>;
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
  return {
    login: () => osLogin()?.name ?? 'an unnamed login',
    uid: () => osLogin()?.uid ?? -1,
    home: () => homedir(),
    env: process.env,
    ownerOf: (path) => {
      try {
        return statSync(path).uid;
      } catch {
        return undefined;
      }
    },
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
    run: (command, args) => {
      const r = spawnSync(command, args, {
        env: { ...process.env, LC_ALL: 'C' },
        stdio: 'ignore',
        timeout: 5000,
      });
      return r.error !== undefined ? null : r.status;
    },
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

/** The elevation programs the check does NOT probe (§5.9): named `unknown (not probed)` when present. */
const UNPROBED_ELEVATION = ['doas', 'run0', 'pkexec', 'su'] as const;

/** Whether a program is on this host: found on `PATH`, or at `/usr/bin`, `/usr/sbin`, `/usr/local/bin`. */
function present(probes: SeparationProbes, name: string): boolean {
  const dirs = [
    ...(probes.env['PATH'] ?? '').split(delimiter).filter((d) => d !== ''),
    '/usr/bin',
    '/usr/sbin',
    '/usr/local/bin',
  ];
  return dirs.some((d) => probes.exists(join(d, name)));
}

/** Condition 1: can this login write Realm's store, or open its files? */
function storeReach(probes: SeparationProbes, store: string): ConditionReading {
  if (!probes.exists(store)) return { basis: 'unknown', cause: `there is no store at ${store}` };
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

/** Condition 2: can this login become Realm's service user without a password? */
function becomeServiceUser(probes: SeparationProbes, svc: string | undefined): ConditionReading {
  if (svc === undefined) {
    return {
      basis: 'unknown',
      cause: 'there is no separate service user: the store belongs to this login',
    };
  }
  const sudo = present(probes, 'sudo');
  if (sudo && probes.run('sudo', ['-n', '-u', svc, 'true']) === 0) {
    return { basis: 'measured', answer: 'yes', detail: `sudo -n -u ${svc} true succeeded` };
  }
  const unprobed = UNPROBED_ELEVATION.filter((p) => present(probes, p));
  if (unprobed.length > 0) {
    return {
      basis: 'unknown',
      cause: `not probed: ${unprobed.join(', ')} ${unprobed.length === 1 ? 'is' : 'are'} on this host`,
    };
  }
  if (!sudo)
    return {
      basis: 'measured',
      answer: 'no',
      detail: 'no sudo, doas, run0, pkexec or su on this host',
    };
  const pam = probes.readText('/etc/pam.d/sudo');
  if (pam === undefined)
    return { basis: 'unknown', cause: '/etc/pam.d/sudo is not readable by this login' };
  if (/^\s*auth\s+\S+\s+pam_tid\.so/m.test(pam)) {
    return {
      basis: 'configured_not_enforced',
      detail: 'Touch ID can approve sudo (/etc/pam.d/sudo)',
    };
  }
  const sudoers = probes.readText('/etc/sudoers');
  if (sudoers === undefined)
    return { basis: 'unknown', cause: 'the sudoers file is not readable by this login' };
  const timeout = /timestamp_timeout\s*=\s*(-?\d+)/.exec(sudoers)?.[1];
  if (timeout === undefined || timeout !== '0') {
    return {
      basis: 'configured_not_enforced',
      detail: `sudo keeps a password for ${timeout === undefined ? 'its default time' : `${timeout} minutes`} (timestamp_timeout)`,
    };
  }
  return {
    basis: 'measured',
    answer: 'no',
    detail: `sudo -n -u ${svc} true failed; no Touch ID; timestamp_timeout=0`,
  };
}

/** Condition 3: can this login reach the Docker engine (root-equivalent)? The socket, never the group or CLI. */
async function dockerReach(probes: SeparationProbes): Promise<ConditionReading> {
  const targets: ({ path: string } | { host: string; port: number })[] = [];
  const dockerHost = probes.env['DOCKER_HOST'];
  if (dockerHost !== undefined && dockerHost !== '') {
    if (dockerHost.startsWith('unix://'))
      targets.push({ path: dockerHost.slice('unix://'.length) });
    const tcp = /^tcp:\/\/([^:/]+):(\d+)/.exec(dockerHost);
    if (tcp !== null) targets.push({ host: tcp[1]!, port: Number(tcp[2]) });
  }
  const home = probes.home();
  for (const path of [
    '/var/run/docker.sock',
    join(home, '.docker', 'run', 'docker.sock'),
    join(home, '.docker', 'desktop', 'docker.sock'),
  ]) {
    if (probes.exists(path)) targets.push({ path });
  }
  for (const t of targets) {
    if (await probes.connect(t)) {
      return {
        basis: 'measured',
        answer: 'yes',
        detail: `the Docker engine accepted a connection at ${'path' in t ? t.path : `${t.host}:${t.port}`}`,
      };
    }
  }
  return { basis: 'measured', answer: 'no' };
}

/** The files Realm executes for the deployment roots the check knows (realm.yaml and its module refs). */
function trustRootFiles(probes: SeparationProbes, roots: readonly string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const manifest = join(root, 'realm.yaml');
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

/** The deployment roots the registered workflows name (`trust_root`), where the store can be read. */
function storedRoots(probes: SeparationProbes, store: string): string[] {
  const dir = join(store, 'workflows');
  const roots: string[] = [];
  for (const name of probes.list(dir) ?? []) {
    if (!name.endsWith('.json')) continue;
    const text = probes.readText(join(dir, name));
    if (text === undefined) continue;
    try {
      const root = (JSON.parse(text) as { trust_root?: unknown }).trust_root;
      if (typeof root === 'string' && root !== '') roots.push(root);
    } catch {
      // a copy that is not JSON names no root
    }
  }
  return roots;
}

/** Condition 4: can this login write the trust-root files Realm executes? */
function trustRootWritable(probes: SeparationProbes, roots: readonly string[]): ConditionReading {
  const files = trustRootFiles(probes, roots);
  if (files.length === 0) {
    return {
      basis: 'unknown',
      cause: 'no realm.yaml was found to check: pass --project with the deployment root',
    };
  }
  const writable = files.filter(
    (f) => (probes.exists(f) && probes.canWrite(f)) || probes.canWrite(dirname(f)),
  );
  return writable.length > 0
    ? { basis: 'measured', answer: 'yes', detail: `${writable[0]} can be changed` }
    : {
        basis: 'measured',
        answer: 'no',
        detail: `${files.length} ${files.length === 1 ? 'file' : 'files'} checked`,
      };
}

/** Condition 7: the agent apps' sandbox settings (Claude Code, Codex) — configured, never enforced by Realm. */
function agentSandbox(probes: SeparationProbes): ConditionReading {
  const home = probes.home();
  const found: string[] = [];
  const claude = probes.readText(join(home, '.claude', 'settings.json'));
  if (claude !== undefined) {
    try {
      const parsed = JSON.parse(claude) as { sandbox?: { enabled?: unknown } };
      if (parsed.sandbox?.enabled === true) found.push('Claude Code (~/.claude/settings.json)');
    } catch {
      // not JSON: not a setting this check can read
    }
  }
  const codex = probes.readText(join(home, '.codex', 'config.toml'));
  const mode =
    codex !== undefined ? /^\s*sandbox_mode\s*=\s*"([^"]+)"/m.exec(codex)?.[1] : undefined;
  if (mode !== undefined && mode !== 'danger-full-access')
    found.push(`Codex (sandbox_mode = "${mode}")`);
  return found.length > 0
    ? { basis: 'configured_not_enforced', detail: found.join('; ') }
    : { basis: 'measured', answer: 'no' };
}

/** Condition 8 (informational): can this login write the runner's price file? */
function economicsWritable(probes: SeparationProbes, roots: readonly string[]): ConditionReading {
  for (const root of roots) {
    const text = probes.readText(join(root, 'realm.yaml'));
    const named =
      text !== undefined ? /^\s*economics:\s*['"]?([^'"\s#]+)/m.exec(text)?.[1] : undefined;
    if (named === undefined) continue;
    const path = isAbsolute(named) ? named : resolve(root, named);
    const writable =
      (probes.exists(path) && probes.canWrite(path)) || probes.canWrite(dirname(path));
    return { basis: 'measured', answer: writable ? 'yes' : 'no', detail: path };
  }
  return { basis: 'measured', answer: 'fact', detail: 'no runner.cache.economics is set' };
}

/**
 * Measures the separation check's evidence as the login that runs it. `store` is Realm's store
 * folder as this command sees it (`$HOME/.realm`); `roots` the deployment roots it knows.
 */
export async function measureSeparation(args: {
  probes: SeparationProbes;
  value: { value: GateAnswers; source: Source };
  roots: readonly string[];
}): Promise<SeparationEvidence & { store: string; owns_store: boolean }> {
  const { probes } = args;
  const store = join(probes.home(), '.realm');
  const owner = probes.exists(store) ? probes.ownerOf(store) : undefined;
  const ownedByOther = owner !== undefined && owner !== probes.uid();
  const svc = ownedByOther ? (probes.userName(owner) ?? `uid ${owner}`) : undefined;
  const conditions: Record<SeparationCondition, ConditionReading> = {
    store_reach: storeReach(probes, store),
    become_service_user: becomeServiceUser(probes, svc),
    docker: await dockerReach(probes),
    trust_root_writable: trustRootWritable(probes, [
      ...new Set([...args.roots, ...storedRoots(probes, store)]),
    ]),
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
    store_owned_by_other: ownedByOther,
    conditions,
    value: args.value,
    store,
    owns_store: owner !== undefined && owner === probes.uid(),
  };
}

/** The condition's words on its W-x2 line. */
const CONDITION_WORDS: Record<SeparationCondition, (e: SeparationEvidence) => string> = {
  store_reach: () => "This login can write Realm's store or open its files",
  become_service_user: (e) =>
    `This login can become Realm's service user${e.service_user !== undefined ? ` (${e.service_user})` : ''} without a password`,
  docker: () => 'This login can reach the Docker engine',
  trust_root_writable: () =>
    'This login can change files Realm executes (realm.yaml, extension modules, tool-server commands)',
  other_answer_host: () => 'Another Realm server or CLI that takes answers uses this store',
  time_basis: () => "The store's time basis",
  agent_sandbox: () => "The agent's app runs it in a sandbox",
  economics_writable: () => 'This login can change runner.cache.economics (informational)',
};

/** W-x2: one condition's line. */
export function conditionLine(c: SeparationCondition, e: SeparationEvidence): string {
  const r = e.conditions[c];
  const words = CONDITION_WORDS[c](e);
  switch (r.basis) {
    case 'measured':
      return r.answer === 'fact'
        ? `${words}: ${r.detail}.`
        : `${words}: ${r.answer} (measured)${r.detail !== undefined ? ` — ${r.detail}` : ''}.`;
    case 'configured_not_enforced':
      return `${words}: configured, not enforced by Realm — ${r.detail}.`;
    case 'unknown':
      return `${words}: unknown (${r.cause}; observed now).`;
  }
}

/** The value condition's line (F36): measured only when given on this command line. */
export function valueLine(e: SeparationEvidence): string {
  const v = e.value;
  if (v.value === 'withheld') {
    return valueMeasuredWithheld(e)
      ? 'The gate-answers value: withheld (measured — given on this command line).'
      : `The gate-answers value: withheld, configured, not enforced by Realm — from ${v.source.ref}; the running server's value is not read.`;
  }
  return `The gate-answers value: ${v.value} (from ${v.source.ref}) — the agent keeps an answer way.`;
}

const MODE_WORDS: Record<SeparationMode, string> = {
  same_account: 'same login',
  sandbox_configured: 'sandbox configured',
  separate_user: 'separate user',
};

const GAP_WORDS: Record<SeparationCondition | 'value', string> = {
  store_reach: "it can reach Realm's store",
  become_service_user: 'becoming Realm\'s service user is not measured "no"',
  docker: 'the Docker engine is not measured out of reach',
  trust_root_writable: 'the files Realm executes are not measured out of reach',
  other_answer_host: '',
  time_basis: '',
  agent_sandbox: '',
  economics_writable: '',
  value:
    "the gate-answers value: give it on this command line, and read the running server's start line",
};

/** W-x3: the claim, chosen by the measured mode and the predicate. */
export function separationClaim(e: SeparationEvidence): string {
  if (separationPrevents(e)) {
    return `An agent running as ${e.login} cannot record a gate answer through this server, the terminal or Realm's files, provided no program Realm runs as ${e.service_user ?? "Realm's service user"} can run code for it and every Realm server on this machine starts with \`--gate-answers withheld\`.`;
  }
  if (separationModeOf(e) === 'same_account') {
    return "An agent running as this login could answer a gate through the terminal or by editing Realm's files; Realm records how each answer arrived but cannot stop it.";
  }
  return `An agent running as ${e.login} may still be able to answer a gate: ${separationGaps(e)
    .map((g) => GAP_WORDS[g])
    .join('; ')}.`;
}

/** The whole check's lines: W-x1, the login measured, each W-x2 line, the value line. */
export function renderSeparation(
  e: SeparationEvidence & { store: string; owns_store: boolean },
): string[] {
  const lines = [
    `Separation: ${MODE_WORDS[separationModeOf(e)]} — ${separationClaim(e)}`,
    `Measured for the login '${e.login}', against the store at ${e.store}.${
      e.owns_store
        ? " This login owns the store: if it is Realm's service user, run the check from the agent's own shell instead."
        : ''
    }`,
    ...(
      [
        'store_reach',
        'become_service_user',
        'docker',
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
