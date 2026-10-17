// separation-check-627.test.ts — #627 W, Part K (cell 26): `--check`'s separation check, measured on
// fixture machines (injected probes — no real file, process or socket is touched, except the one
// real-filesystem cell of correction 2, 5.1). The positive cell prints the "cannot record" form with
// its proviso; each "prevents" conjunct is pinned on its own; each condition's line in each of its
// states; the value line (F36: measured only from the `--check` line's own flag); the mode; the login;
// conditions 5–8.
//
// Correction 2 (5.9, the owner's word: "stop the real sudo attempt until #790"): condition 2 runs
// nothing, so every elevation program present reads "not probed". The cells whose subject is the
// "cannot record" claim, or one of its conjuncts, run on a machine with NO elevation program — the
// one place that claim can be reached.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: logins,
// paths and words — never a token or an environment.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { GateAnswers, Source } from '@sensigo/realm';
import {
  conditionLine,
  measureSeparation,
  renderSeparation,
  separationClaim,
  systemProbes,
  valueLine,
  type SeparationProbes,
} from './separation-check.js';

const HOME = '/home/svc';
const STORE = `${HOME}/.realm`;
const PROJECT = '/srv/deploy';
const ME = 1000;
const REALM_UID = 900;

/** The deployment root's manifest: condition 4 has a realm.yaml to check. */
const PROJECT_FILES = { [`${PROJECT}/realm.yaml`]: 'version: 1\n' };

/**
 * A machine: the store owned by `realm` (uid 900), unreachable by `agent` (uid 1000); no elevation
 * program unless `present` names one. `owners` sets a path's owner (else: the store 900, any other
 * path this login's); a cell may give its own `stat`.
 */
function machine(
  over: Partial<SeparationProbes> = {},
  files: Record<string, string> = PROJECT_FILES,
  present: string[] = [],
  owners: Record<string, number> = { [STORE]: REALM_UID },
): SeparationProbes {
  const exists = new Set([
    STORE,
    `${STORE}/runs`,
    `${STORE}/workflows`,
    ...Object.keys(files),
    ...present,
  ]);
  const base: SeparationProbes = {
    login: () => 'agent',
    uid: () => ME,
    home: () => HOME,
    // Correction 1 (D4): the login's own home, where the agent-scoped paths are read.
    loginHome: () => '/home/agent',
    stat: () => ({ error: 'unset' }),
    execPath: () => '/usr/bin/node',
    realmPackageDir: () => '/usr/lib/node_modules/@sensigo/realm-cli',
    env: { PATH: '/usr/bin' },
    userName: (uid) => (uid === REALM_UID ? 'realm' : uid === 0 ? 'root' : undefined),
    canWrite: () => false,
    canRead: () => false,
    exists: (p) => exists.has(p),
    readText: (p) => files[p],
    list: () => [],
    connect: async () => false,
    ...over,
  };
  return {
    ...base,
    // Correction 1 (D1), correction 2 (5.7: no `ownerOf` — the owner comes from `stat`): derived from
    // `exists` and `owners` unless a cell gives its own stat.
    stat:
      over.stat ??
      ((p) => (base.exists(p) ? { uid: owners[p] ?? ME, mode: 0o40755 } : { error: 'ENOENT' })),
  };
}

const FLAG: { value: GateAnswers; source: Source } = {
  value: 'withheld',
  source: { kind: 'flag', ref: '--gate-answers' },
};
const ENV: { value: GateAnswers; source: Source } = {
  value: 'withheld',
  source: { kind: 'env', ref: 'REALM_MCP_GATE_ANSWERS' },
};

const measure = (probes: SeparationProbes, value = FLAG, door: 'mcp' | 'serve' = 'mcp') =>
  measureSeparation({ probes, value, roots: [PROJECT], door });

const CANNOT_RECORD =
  "An agent running as agent cannot record a gate answer through this server, the terminal or Realm's files, provided no program Realm runs as realm can run code for it, Realm's server runs this Node and this Realm package, and every Realm server on this machine starts with --gate-answers withheld.";
const MAY = 'An agent running as agent may still be able to answer a gate:';
const CONDITION_4 =
  'This login can change files Realm executes (realm.yaml, extension modules, and the Node binary and Realm package this check runs from)';

describe('#627 W — the separation check (cell 26)', () => {
  it('the positive cell: separate user, conditions 1–4 measured no, --gate-answers withheld on the line → "cannot record", with its proviso', async () => {
    const e = await measure(machine());
    // (a) red when the proviso is dropped, the form prints without the flag, or (5.5) an elevation
    //     program is listed as present; (b) prints the claim and condition 2's line.
    expect({
      claim: separationClaim(e),
      become: conditionLine('become_service_user', e),
    }).toEqual({
      claim: CANNOT_RECORD,
      become:
        "This login can become Realm's service user (realm) without a password: no (measured) — no sudo, doas, run0, pkexec or su on this host.",
    });
  });

  it('each prevents conjunct alone takes the claim away — the mode, conditions 1–4, the value and its source', async () => {
    const claim = async (probes: SeparationProbes, value = FLAG) =>
      separationClaim(await measure(probes, value));
    // (a) red per cell when its conjunct is skipped; (b) prints each claim.
    expect({
      sameLogin: await claim(machine({}, PROJECT_FILES, [], {})),
      store: await claim(machine({ canWrite: (p) => p === `${STORE}/runs` })),
      become: await claim(machine({}, PROJECT_FILES, ['/usr/bin/su'])),
      docker: await claim(
        machine({ connect: async () => true }, PROJECT_FILES, ['/var/run/docker.sock']),
      ),
      trustRoot: await claim(machine({ canWrite: (p) => p === PROJECT })),
      asked: await claim(machine(), { value: 'asked', source: FLAG.source }),
      fromEnv: await claim(machine(), ENV),
    }).toEqual({
      // Correction 1 (D1): an owned store measured "no" is not measured as the same login.
      sameLogin: `${MAY} whether it can become Realm's service user without a password was not measured.`,
      // Correction 2 (5.4): another user's store this login can write — a separate user who can write
      // Realm's store, never "the same login".
      store: `${MAY} it can write Realm's store.`,
      become: `${MAY} whether it can become Realm's service user without a password was not measured.`,
      docker: `${MAY} it can reach the Docker engine.`,
      trustRoot: `${MAY} it can change the files Realm executes.`,
      asked: `${MAY} the gate-answers value: give it on this command line, and read the running server's start line.`,
      fromEnv: `${MAY} the gate-answers value: give it on this command line, and read the running server's start line.`,
    });
  });

  it('the value line (F36): withheld measured only from this command line; from the env, configured not enforced; asked and offered keep an answer way', async () => {
    const line = async (
      value: { value: GateAnswers; source: Source },
      door: 'mcp' | 'serve' = 'mcp',
    ) => valueLine(await measure(machine(), value, door));
    // (a) red when an env value is called measured, or asked is read as withheld; (b) prints each.
    expect({
      flag: await line(FLAG),
      env: await line(ENV),
      asked: await line({ value: 'asked', source: { kind: 'default', ref: 'the default' } }),
      // Correction 1 (D5): on realm serve no client gets forms.
      askedServe: await line(
        { value: 'asked', source: { kind: 'default', ref: 'the default' } },
        'serve',
      ),
      offered: await line({ value: 'offered', source: { kind: 'flag', ref: '--gate-answers' } }),
    }).toEqual({
      flag: 'The gate-answers value: withheld (measured — given on this command line).',
      env: "The gate-answers value: withheld, configured, not enforced by Realm — from REALM_MCP_GATE_ANSWERS; the running server's value is not read.",
      asked:
        'The gate-answers value: asked (from the default) — the agent keeps an answer way in apps without forms.',
      askedServe:
        'The gate-answers value: asked (from the default) — every client keeps an answer way (this server sends no forms).',
      offered:
        'The gate-answers value: offered (from --gate-answers) — the agent keeps an answer way.',
    });
  });

  it('each condition line in its states: measured yes / no, configured not enforced, unknown with its cause ("observed now")', async () => {
    const yes = await measure(
      machine(
        {
          canWrite: (p) => p === `${STORE}/runs` || p === PROJECT,
          connect: async () => true,
        },
        // Correction 1 (D4): the agent's app settings are read from the login's own home, never $HOME.
        {
          ...PROJECT_FILES,
          ['/home/agent/.claude/settings.json']: '{"sandbox":{"enabled":true}}',
          [`${HOME}/.claude/settings.json`]: '{"sandbox":{"enabled":false}}',
        },
        ['/usr/bin/sudo', '/var/run/docker.sock'],
      ),
    );
    const no = await measure(machine());
    const unknown = await measure(machine({ exists: () => false }));
    // (a) red per line when a state word is wrong; (b) prints the lines.
    expect({
      store: [
        conditionLine('store_reach', yes),
        conditionLine('store_reach', no),
        conditionLine('store_reach', unknown),
      ],
      become: [conditionLine('become_service_user', yes), conditionLine('become_service_user', no)],
      docker: [conditionLine('docker', yes), conditionLine('docker', no)],
      trustRoot: [
        conditionLine('trust_root_writable', yes),
        conditionLine('trust_root_writable', no),
        conditionLine('trust_root_writable', unknown),
      ],
      sandbox: [conditionLine('agent_sandbox', yes), conditionLine('agent_sandbox', no)],
    }).toEqual({
      store: [
        `This login can write Realm's store or open its files: yes (measured) — ${STORE}/runs is writable.`,
        "This login can write Realm's store or open its files: no (measured).",
        `This login can write Realm's store or open its files: unknown (Realm's store was not found at ${STORE}; observed now).`,
      ],
      // Correction 2 (5.9): condition 2 runs nothing — a present program is "not probed".
      become: [
        "This login can become Realm's service user (realm) without a password: unknown (not probed: sudo is on this host; observed now).",
        "This login can become Realm's service user (realm) without a password: no (measured) — no sudo, doas, run0, pkexec or su on this host.",
      ],
      docker: [
        'This login can reach the Docker engine: yes (measured) — the Docker engine accepted a connection at /var/run/docker.sock.',
        'This login can reach the Docker engine: no (measured).',
      ],
      trustRoot: [
        `${CONDITION_4}: yes (measured) — ${PROJECT}/realm.yaml can be changed.`,
        `${CONDITION_4}: no (measured) — 3 files and folders checked.`,
        `${CONDITION_4}: unknown (no realm.yaml was found to check: pass --project with the deployment root; observed now).`,
      ],
      // Correction 2 (8.5): the "no" names what it read.
      sandbox: [
        "The agent's app runs it in a sandbox: configured, not enforced by Realm — Claude Code (~/.claude/settings.json).",
        "The agent's app runs it in a sandbox: no (measured) — only Claude Code's and Codex's settings were read.",
      ],
    });
  });

  it('the whole output: the header names the mode and the claim, the login measured, condition 5 "observed now", conditions 6–8 (the information lines marked "(fact)"), and the value line', async () => {
    const lines = renderSeparation(await measure(machine()));
    // (a) red when the login is omitted, condition 5 says "none", a condition line is dropped, or an
    //     information line loses its label (8.5); (b) prints the lines.
    expect(lines).toEqual([
      `Separation: separate user — ${CANNOT_RECORD}`,
      `Measured for the login 'agent', against the store at ${STORE}.`,
      "  This login can write Realm's store or open its files: no (measured).",
      "  This login can become Realm's service user (realm) without a password: no (measured) — no sudo, doas, run0, pkexec or su on this host.",
      '  This login can reach the Docker engine: no (measured).',
      `  ${CONDITION_4}: no (measured) — 3 files and folders checked.`,
      '  Another Realm server or CLI that takes answers uses this store: unknown (another Realm server or CLI could use this store, and one look cannot rule it out; observed now).',
      "  The store's time basis: this machine's clock (the JSON store keeps no clock of its own) (fact).",
      "  The agent's app runs it in a sandbox: no (measured) — only Claude Code's and Codex's settings were read.",
      '  This login can change runner.cache.economics (informational): no runner.cache.economics is set (fact).',
      '  The gate-answers value: withheld (measured — given on this command line).',
    ]);
  });

  it('run as the store’s owner, the check says so: it measured the wrong login if that is Realm’s service user; the same-login header', async () => {
    // The store's owner can write its own store (condition 1 measured "yes"): the same login.
    const lines = renderSeparation(
      await measure(machine({ canWrite: (p) => p === STORE }, PROJECT_FILES, [], {})),
    );
    // (a) red when the owner's run is not flagged, or the same-login mode's header (W-x1 with
    //     W-x3's same-account form) changes; (b) prints the header and the login line.
    expect({ header: lines[0], login: lines[1] }).toEqual({
      header:
        "Separation: same login — An agent running as this login could answer a gate through the terminal or by editing Realm's files; Realm records how each answer arrived but cannot stop it.",
      login: `Measured for the login 'agent', against the store at ${STORE}. This login owns the store: if it is Realm's service user, run the check from the agent's own shell instead.`,
    });
  });

  it('correction 1 (D1): the mode is never guessed — a missing store, a store this login cannot stat, an owned store it cannot reach', async () => {
    const out = async (probes: SeparationProbes) => {
      const lines = renderSeparation(await measure(probes, FLAG));
      return { header: lines[0], store: lines[2], become: lines[3] };
    };
    // A store this login cannot even stat: its owner is the nearest folder it can stat (`/home/svc`).
    const denied = machine({
      stat: (p) =>
        p === STORE
          ? { error: 'EACCES' }
          : p === HOME
            ? { uid: REALM_UID, mode: 0o40755 }
            : { error: 'ENOENT' },
      list: () => undefined,
    });
    // (a) red when a missing store or an owned unreachable one is read as the same login, or an
    //     EACCES store as absent; (b) prints each header and the two store lines.
    expect({
      missing: await out(machine({ stat: () => ({ error: 'ENOENT' }) })),
      denied: await out(denied),
      ownedNo: await out(machine({}, PROJECT_FILES, [], {})),
    }).toEqual({
      missing: {
        header: `Separation: not measured — ${MAY} whether it can reach Realm's store was not measured; whether it can become Realm's service user without a password was not measured.`,
        store: `  This login can write Realm's store or open its files: unknown (Realm's store was not found at ${STORE}; observed now).`,
        become:
          "  This login can become Realm's service user without a password: unknown (there is no service user to name: no store was found; observed now).",
      },
      // Correction 2 (5.3): the owner read from the folder above the store is labelled so.
      denied: {
        header: `Separation: separate user — An agent running as agent cannot record a gate answer through this server, the terminal or Realm's files, provided no program Realm runs as realm, read from the owner of ${HOME}, can run code for it, Realm's server runs this Node and this Realm package, every Realm server on this machine starts with --gate-answers withheld, and no registered workflow's extension file (not read: the store cannot be read) can be changed by this login.`,
        store: `  This login can write Realm's store or open its files: no (measured) — ${STORE}: permission denied.`,
        become: `  This login can become Realm's service user (realm, read from the owner of ${HOME}) without a password: no (measured) — no sudo, doas, run0, pkexec or su on this host.`,
      },
      ownedNo: {
        header: `Separation: not measured — ${MAY} whether it can become Realm's service user without a password was not measured.`,
        store: "  This login can write Realm's store or open its files: no (measured).",
        become:
          "  This login can become Realm's service user without a password: unknown (there is no separate service user: the store belongs to this login; observed now).",
      },
    });
  });

  it('correction 1 (D3): a writable --extensions-module file makes condition 4 "yes"', async () => {
    const ext = '/home/agent/ext.mjs';
    const evidence = await measureSeparation({
      probes: machine({ canWrite: (p) => p === ext }, PROJECT_FILES, [ext]),
      value: FLAG,
      roots: [PROJECT],
      extensionsModule: ext,
      door: 'mcp',
    });
    // (a) red when the check drops the --extensions-module argument; (b) prints the line.
    expect(renderSeparation(evidence)[5]).toBe(
      `  ${CONDITION_4}: yes (measured) — ${ext} can be changed.`,
    );
  });

  it('correction 1 (D3): a registered workflow’s extension file, resolved against its source_dir, makes condition 4 "yes" when this login can change it', async () => {
    const ext = '/srv/wf-src/ext/tools.mjs';
    const evidence = await measure(
      machine(
        {
          canWrite: (p) => p === ext,
          list: (p) => (p === `${STORE}/workflows` ? ['wf.json'] : []),
        },
        {
          ...PROJECT_FILES,
          [`${STORE}/workflows/wf.json`]: JSON.stringify({
            id: 'wf',
            source_dir: '/srv/wf-src',
            extensions: './ext/tools.mjs',
          }),
        },
        [ext],
      ),
    );
    // (a) red when the registered workflows' extension files are not checked; (b) prints the line.
    expect(conditionLine('trust_root_writable', evidence)).toBe(
      `${CONDITION_4}: yes (measured) — ${ext} can be changed.`,
    );
  });

  it('correction 1 (D3): the extension files are "not read" only where some may exist — per conjunct: a missing store, a store with no workflows folder, an unlistable folder, a store this login cannot open', async () => {
    const line = async (over: Partial<SeparationProbes>) =>
      conditionLine('trust_root_writable', await measure(machine(over)));
    const CHECKED = '3 files and folders checked.';
    const NOT_READ =
      "the registered workflows' extension files were not read (the store cannot be read)";
    const tail = (l: string) =>
      l.endsWith(CHECKED) ? 'checked' : l.includes(NOT_READ) ? 'not read' : l;
    // (a) red per cell when its conjunct is dropped — a missing store, or a store with no workflows
    //     folder, said to hold unread files; an unlistable folder, or a store this login cannot open,
    //     not said so; (b) prints each line's tail.
    expect({
      missing: tail(await line({ stat: () => ({ error: 'ENOENT' }), list: () => undefined })),
      // Correction 2 (5.1): the folder's own stat says ENOENT.
      noFolder: tail(
        await line({
          stat: (p) =>
            p === `${STORE}/workflows`
              ? { error: 'ENOENT' }
              : p === STORE
                ? { uid: REALM_UID, mode: 0o40755 }
                : { uid: ME, mode: 0o40755 },
          list: () => undefined,
        }),
      ),
      unlistable: tail(await line({ list: (p) => (p === `${STORE}/workflows` ? undefined : []) })),
      denied: tail(
        await line({
          stat: (p) =>
            p === STORE
              ? { error: 'EACCES' }
              : p === HOME
                ? { uid: REALM_UID, mode: 0o40755 }
                : { error: 'ENOENT' },
          list: () => undefined,
        }),
      ),
    }).toEqual({
      missing: 'checked',
      noFolder: 'checked',
      unlistable: 'not read',
      denied: 'not read',
    });
  });

  it('correction 1 (D4): the per-user Docker socket is looked for in the login’s own home, never in HOME', async () => {
    const own = '/home/agent/.docker/run/docker.sock';
    const viaHome = `${HOME}/.docker/run/docker.sock`;
    const evidence = await measure(
      machine({ connect: async (t) => 'path' in t && t.path === own }, PROJECT_FILES, [
        own,
        viaHome,
      ]),
    );
    // (a) red when the socket's path is built from HOME (the agent's own engine is missed); (b) prints
    //     the line.
    expect(conditionLine('docker', evidence)).toBe(
      `This login can reach the Docker engine: yes (measured) — the Docker engine accepted a connection at ${own}.`,
    );
  });

  it('correction 1 (F6): gate-answers.md :58 — a store this login can only read is a separate user who can read Realm’s store (correction 2, 5.4)', async () => {
    const e = await measure(machine({ canRead: (p) => p === `${STORE}/runs` }));
    // (a) red when a readable store keeps the claim (`:58`'s "or read"), or (5.4) reads as the same
    //     login; (b) prints the header.
    expect(renderSeparation(e)[0]).toBe(
      `Separation: separate user — ${MAY} it can read Realm's store.`,
    );
  });

  it('correction 1 (D2): with su on the host the claim is "may still", never "cannot record"', async () => {
    const claim = separationClaim(await measure(machine({}, PROJECT_FILES, ['/usr/bin/su'])));
    // (a) red when an unprobed su lets the "cannot record" form print; (b) prints the claim.
    expect(claim).toBe(
      `${MAY} whether it can become Realm's service user without a password was not measured.`,
    );
  });
});

describe('#627 W correction 2 — the separation check says what it measured (part 5, 8.5)', () => {
  it('5.1: a store folder this login cannot enter (EACCES, so `exists` is false) is "not read", never "no workflows folder"', async () => {
    const line = conditionLine(
      'trust_root_writable',
      await measure(
        machine({
          exists: (p) =>
            p !== `${STORE}/workflows` && (p === STORE || p === `${PROJECT}/realm.yaml`),
          stat: (p) =>
            p === `${STORE}/workflows`
              ? { error: 'EACCES' }
              : p === STORE
                ? { uid: REALM_UID, mode: 0o40755 }
                : { uid: ME, mode: 0o40755 },
          list: () => undefined,
        }),
      ),
    );
    // (a) red when the folder reads as absent from `exists` (the "not read" clause dropped); (b)
    //     prints the line.
    expect(line).toContain(
      "the registered workflows' extension files were not read (the store cannot be read)",
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    '5.1, on the real filesystem: a HOME whose .realm is mode 000 — the extension files are not read',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'realm-sep-627-'));
      await mkdir(join(home, '.realm', 'workflows'), { recursive: true });
      await chmod(join(home, '.realm'), 0o000);
      const saved = process.env['HOME'];
      process.env['HOME'] = home;
      try {
        const e = await measureSeparation({
          probes: systemProbes(),
          value: FLAG,
          roots: [],
          door: 'mcp',
        });
        // (a) red when a locked store reads as one with no workflows folder; (b) prints the field
        //     (condition 4 itself may read "yes" from a writable Node binary on this host).
        expect(e.extensions_unread).toBe(true);
      } finally {
        if (saved === undefined) delete process.env['HOME'];
        else process.env['HOME'] = saved;
        await chmod(join(home, '.realm'), 0o755);
      }
    },
  );

  it('5.2: a login with no passwd entry — its own Docker sockets and its apps’ settings are not read, never read from HOME', async () => {
    const e = await measure(machine({ loginHome: () => undefined }));
    // (a) red when the agent-scoped paths fall back to HOME; (b) prints both lines.
    expect([conditionLine('docker', e), conditionLine('agent_sandbox', e)]).toEqual([
      "This login can reach the Docker engine: unknown (this login's home could not be read: it has no passwd entry, so its own Docker sockets were not checked; observed now).",
      "The agent's app runs it in a sandbox: unknown (this login's home could not be read: it has no passwd entry, so the agent apps' settings were not read; observed now).",
    ]);
  });

  it('5.2: the real probes — the login home is the passwd home whatever HOME says; the package folder is the CLI’s', () => {
    const saved = process.env['HOME'];
    process.env['HOME'] = '/nowhere-627';
    try {
      const probes = systemProbes();
      const pkg = JSON.parse(
        readFileSync(join(probes.realmPackageDir(), 'package.json'), 'utf8'),
      ) as { name?: string };
      // (a) red when the login home reads HOME, or the package folder is one folder off; (b) prints
      //     both.
      expect({ loginHome: probes.loginHome(), pkg: pkg.name }).toEqual({
        loginHome: userInfo().homedir,
        pkg: '@sensigo/realm-cli',
      });
    } finally {
      if (saved === undefined) delete process.env['HOME'];
      else process.env['HOME'] = saved;
    }
  });

  it('5.3: an owner read from a folder above an unopenable store — never root, never this login; a stranger’s is labelled', async () => {
    const deniedUnder = (owner: number) =>
      measure(
        machine({
          stat: (p) =>
            p === STORE
              ? { error: 'EACCES' }
              : p === HOME
                ? { uid: owner, mode: 0o40755 }
                : { error: 'ENOENT' },
          list: () => undefined,
        }),
      );
    const root = renderSeparation(await deniedUnder(0));
    const mine = renderSeparation(await deniedUnder(ME));
    const stranger = await deniedUnder(REALM_UID);
    // (a) red when root is named as Realm's service user, a folder of this login's makes the check
    //     say it owns the store, or a stranger's folder is named without its label; (b) prints the
    //     lines that say so.
    expect({
      rootNamed: root.join('\n').includes('root'),
      rootBecome: root[3],
      mineOwns: mine.join('\n').includes('This login owns the store'),
      mineBecome: mine[3],
      strangerBecome: conditionLine('become_service_user', stranger),
    }).toEqual({
      rootNamed: false,
      rootBecome: `  This login can become Realm's service user without a password: unknown (the store's owner could not be read: ${STORE} cannot be opened; observed now).`,
      mineOwns: false,
      mineBecome: `  This login can become Realm's service user without a password: unknown (the store's owner could not be read: ${STORE} cannot be opened; observed now).`,
      strangerBecome: `This login can become Realm's service user (realm, read from the owner of ${HOME}) without a password: no (measured) — no sudo, doas, run0, pkexec or su on this host.`,
    });
  });

  it('5.6: condition 4 counts a file changeable through a writable folder above it — except a sticky folder whose entry is another user’s', async () => {
    const line = async (over: Partial<SeparationProbes>) =>
      conditionLine('trust_root_writable', await measure(machine(over)));
    const grandparent = await line({ canWrite: (p) => p === '/srv' });
    const sticky = await line({
      canWrite: (p) => p === '/srv/deploy',
      stat: (p) =>
        p === '/srv/deploy'
          ? { uid: 0, mode: 0o41777 }
          : p === `${PROJECT}/realm.yaml`
            ? { uid: REALM_UID, mode: 0o100644 }
            : p === STORE
              ? { uid: REALM_UID, mode: 0o40755 }
              : { uid: 0, mode: 0o40755 },
    });
    // (a) red when only the file's own folder is walked (the grandparent missed), or a sticky folder
    //     lets this login replace another user's entry; (b) prints both lines.
    expect({ grandparent, sticky }).toEqual({
      grandparent: `${CONDITION_4}: yes (measured) — ${PROJECT}/realm.yaml can be changed.`,
      sticky: `${CONDITION_4}: no (measured) — 3 files and folders checked.`,
    });
  });

  it('5.7: with no realm.yaml, the executed files are still checked — a writable --extensions-module is "yes"', async () => {
    const ext = '/home/agent/ext.mjs';
    const e = await measureSeparation({
      probes: machine({ canWrite: (p) => p === ext }, {}, [ext]),
      value: FLAG,
      roots: [],
      extensionsModule: ext,
      door: 'mcp',
    });
    // (a) red when condition 4 stops at "no realm.yaml" (unknown); (b) prints the line.
    expect(conditionLine('trust_root_writable', e)).toBe(
      `${CONDITION_4}: yes (measured) — ${ext} can be changed.`,
    );
  });

  it('5.9: condition 2 runs nothing — the check names no process API; sudo present is "not probed", and the header says so', async () => {
    const src = readFileSync(new URL('./separation-check.ts', import.meta.url), 'utf8');
    const e = await measure(machine({}, PROJECT_FILES, ['/usr/bin/sudo']));
    // (a) red when the check imports a process API again, or reads sudo as measured; (b) prints
    //     whether each name appears, condition 2's line and the header.
    expect({
      childProcess: src.includes('node:child_process'),
      spawnSync: src.includes('spawnSync'),
      execFile: src.includes('execFile'),
      // A bare `exec(` — never a RegExp's `.exec(`, which the check uses to read files' text.
      exec: /(?<![.\w])exec\(/.test(src),
      become: conditionLine('become_service_user', e),
      header: renderSeparation(e)[0],
    }).toEqual({
      childProcess: false,
      spawnSync: false,
      execFile: false,
      exec: false,
      become:
        "This login can become Realm's service user (realm) without a password: unknown (not probed: sudo is on this host; observed now).",
      header: `Separation: separate user — ${MAY} whether it can become Realm's service user without a password was not measured.`,
    });
  });

  it('5.9: every elevation program present is named "not probed"', async () => {
    const e = await measure(
      machine({}, PROJECT_FILES, [
        '/usr/bin/sudo',
        '/usr/bin/doas',
        '/usr/bin/run0',
        '/usr/bin/pkexec',
        '/usr/bin/su',
      ]),
    );
    // (a) red when a present program is not named; (b) prints the line.
    expect(conditionLine('become_service_user', e)).toBe(
      "This login can become Realm's service user (realm) without a password: unknown (not probed: sudo, doas, run0, pkexec, su are on this host; observed now).",
    );
  });

  it('8.5: with no store, the header says no store was found — never "against the store at"', async () => {
    const lines = renderSeparation(await measure(machine({ stat: () => ({ error: 'ENOENT' }) })));
    // (a) red when the header names a store the check never found; (b) prints the line.
    expect(lines[1]).toBe(`Measured for the login 'agent'; no store was found at ${STORE}.`);
  });
});
