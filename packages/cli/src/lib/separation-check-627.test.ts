// separation-check-627.test.ts — #627 W, Part K (cell 26): `--check`'s separation check, measured on
// fixture machines (injected probes — no real file, process or socket is touched, except the one
// real-filesystem cell of correction 2, 5.1). The positive cell prints the "cannot record" form with
// its proviso; each "prevents" conjunct is pinned on its own; each condition's line in each of its
// states; the value line (F36: measured only from the `--check` line's own flag); the mode; the login;
// conditions 5–8.
//
// Correction 2 (5.9): this file starts no process. #790: condition 2 reads each way with the
// read-only calls of `separation/runner.ts` — its cells are in `separation/separation-790.test.ts`,
// which replace correction 2's "not probed" cells. The cells here whose subject is the "cannot
// record" claim, or one of its conjuncts, run on a machine with no way to the service user.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: logins,
// paths and words — never a token or an environment.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  ConditionReading,
  GateAnswers,
  SeparationCondition,
  Source,
  SwitchPathReading,
} from '@sensigo/realm';
import {
  conditionLine,
  measureSeparation,
  renderSeparation,
  separationClaim,
  switchPathsReading,
  systemProbes,
  valueLine,
  type CheckEvidence,
  type SeparationProbes,
} from './separation-check.js';
import { notFoundRunner } from '../test-support/separation-fixtures.js';

const HOME = '/home/svc';
const STORE = `${HOME}/.realm`;
const PROJECT = '/srv/deploy';
const ME = 1000;
const REALM_UID = 900;

/** #790: the machine's getent (root's own, in a system folder): it answers every lookup as the
 *  captured "not there", so condition 3 reads no group and the switch paths find no user entry. */
const GETENT = '/usr/bin/getent';

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
    GETENT,
  ]);
  const base: SeparationProbes = {
    login: () => 'agent',
    uid: () => ME,
    home: () => HOME,
    // Correction 1 (D4): the login's own home, where the agent-scoped paths are read.
    loginHome: () => '/home/agent',
    stat: () => ({ error: 'unset' }),
    lstat: () => ({ error: 'unset' }),
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
    // #790: the switch-path readers' probes.
    realPath: () => undefined,
    groups: () => [],
    pid: () => 4242,
    platform: () => 'linux',
    run: notFoundRunner,
    ...over,
  };
  // Correction 1 (D1), correction 2 (5.7: no `ownerOf` — the owner comes from `stat`): derived from
  // `exists` and `owners` unless a cell gives its own stat.
  // #790: getent is root's own whatever a cell's stat says of other paths.
  const stat: SeparationProbes['stat'] = (p) =>
    p === GETENT
      ? { uid: 0, mode: 0o100755 }
      : (
          over.stat ??
          ((q: string) =>
            base.exists(q) ? { uid: owners[q] ?? ME, mode: 0o40755 } : { error: 'ENOENT' })
        )(p);
  // #819 correction 1 (SEP-00 (g)): a path's own owner — the same as `stat` unless a cell gives a link
  return { ...base, stat, lstat: over.lstat ?? stat };
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
        "This login can become Realm's service user (realm) without a password being asked: no (measured now) — no sudo, su, doas, polkit or ssh way was found in /usr/bin, /usr/sbin, /usr/local/bin, /usr/local/sbin, /bin, /sbin, /run/wrappers/bin, /run/setuid-programs or on PATH (polkitd also at /usr/lib/polkit-1/polkitd, /usr/libexec/polkitd, /usr/lib/policykit-1/polkitd; sshd's units ssh.socket, sshd.socket, ssh.service, sshd.service in /etc/systemd/system, /run/systemd/system, /usr/lib/systemd/system, /lib/systemd/system).",
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
      // Correction 1 (D1); #819 (C3): a store this login owns is within its reach — the same login.
      sameLogin:
        "An agent running as this login could answer a gate through the terminal or by editing Realm's files; Realm records how each answer arrived but cannot stop it.",
      // Correction 2 (5.4): another user's store this login can write — a separate user who can write
      // Realm's store, never "the same login".
      store: `${MAY} it can write Realm's store.`,
      // #819 Unit B re-pin (reversal 2): su was read and not settled — was "was not measured"
      become: `${MAY} whether it can become Realm's service user without a password is unknown.`,
      docker: `${MAY} it can reach an engine that runs as root.`,
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
      flag: 'The gate-answers value: withheld (given on this command line).',
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
      rootEngine: [conditionLine('root_engine', yes), conditionLine('root_engine', no)],
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
      // #790 (01b #8): a sudo this login owns is not a root-owned system copy — unknown.
      become: [
        "This login can become Realm's service user (realm) without a password being asked: unknown (sudo: unknown: sudo at /usr/bin/sudo is not a root-owned system copy (sudo looked for in /usr/bin, /usr/sbin, /usr/local/bin, /usr/local/sbin, /bin, /sbin, /run/wrappers/bin, /run/setuid-programs and on PATH); observed now).",
        "This login can become Realm's service user (realm) without a password being asked: no (measured now) — no sudo, su, doas, polkit or ssh way was found in /usr/bin, /usr/sbin, /usr/local/bin, /usr/local/sbin, /bin, /sbin, /run/wrappers/bin, /run/setuid-programs or on PATH (polkitd also at /usr/lib/polkit-1/polkitd, /usr/libexec/polkitd, /usr/lib/policykit-1/polkitd; sshd's units ssh.socket, sshd.socket, ssh.service, sshd.service in /etc/systemd/system, /run/systemd/system, /usr/lib/systemd/system, /lib/systemd/system).",
      ],
      // #790 (01b #3): condition 3 is every engine that runs as root.
      rootEngine: [
        "This login can reach an engine that runs as root: yes (measured) — Docker's socket /var/run/docker.sock accepts.",
        'This login can reach an engine that runs as root: no (measured).',
      ],
      trustRoot: [
        `${CONDITION_4}: yes (measured) — ${PROJECT}/realm.yaml can be changed.`,
        `${CONDITION_4}: no (measured) — 3 files and folders checked.`,
        // #819 follow-up 2 re-pin (walk --check wording): this machine has no folder at all, so the
        // root is named — was "no realm.yaml was found to check: pass --project with the deployment root"
        `${CONDITION_4}: unknown (no such folder: ${PROJECT}; observed now).`,
      ],
      // Correction 2 (8.5): the "no" names what it read.
      sandbox: [
        "The agent's app runs it in a sandbox: configured, not enforced by Realm — Claude Code (/home/agent/.claude/settings.json).",
        "The agent's app runs it in a sandbox: no (read from two files) — only /home/agent/.claude/settings.json and /home/agent/.codex/config.toml were looked at.",
      ],
    });
  });

  it('the whole output: the header names the mode and the claim, the login measured, condition 5 "not measured", conditions 6–8 (the time basis marked "(fact)", the economics line measured), and the value line', async () => {
    const lines = renderSeparation(await measure(machine()));
    // (a) red when the login is omitted, condition 5 says "none", a condition line is dropped, or an
    //     information line loses its label (8.5); (b) prints the lines.
    expect(lines).toEqual([
      `Separation: separate user — ${CANNOT_RECORD}`,
      `Measured for the login 'agent', against the store at ${STORE}.`,
      "  This login can write Realm's store or open its files: no (measured).",
      "  This login can become Realm's service user (realm) without a password being asked: no (measured now) — no sudo, su, doas, polkit or ssh way was found in /usr/bin, /usr/sbin, /usr/local/bin, /usr/local/sbin, /bin, /sbin, /run/wrappers/bin, /run/setuid-programs or on PATH (polkitd also at /usr/lib/polkit-1/polkitd, /usr/libexec/polkitd, /usr/lib/policykit-1/polkitd; sshd's units ssh.socket, sshd.socket, ssh.service, sshd.service in /etc/systemd/system, /run/systemd/system, /usr/lib/systemd/system, /lib/systemd/system).",
      '  This login can reach an engine that runs as root: no (measured).',
      `  ${CONDITION_4}: no (measured) — 3 files and folders checked.`,
      // #819 follow-up 2 re-pin (walk --check wording): nothing is read for it — was "unknown (…; observed now)"
      '  Another Realm server or CLI that takes answers uses this store: not measured (another Realm server or CLI could use this store, and one look cannot rule it out).',
      "  The store's time basis: this machine's clock (the JSON store keeps no clock of its own) (fact).",
      "  The agent's app runs it in a sandbox: no (read from two files) — only /home/agent/.claude/settings.json and /home/agent/.codex/config.toml were looked at.",
      // #819 follow-up 2 re-pin (walk --check wording): it answers its own question — was "no
      // runner.cache.economics is set (fact)"
      `  This login can change runner.cache.economics (informational): no (measured) — ${PROJECT}/realm.yaml cannot be changed, and it sets no runner.cache.economics.`,
      '  The gate-answers value: withheld (given on this command line).',
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
        // #819 Unit B re-pin (reversals 1 and 2): was "Separation: not measured" and the store's "was
        // not measured"; the service user, never named (`not_observed`), keeps "was not measured"
        header: `Separation: unknown — ${MAY} whether it can reach Realm's store is unknown; whether it can become Realm's service user without a password was not measured.`,
        store: `  This login can write Realm's store or open its files: unknown (Realm's store was not found at ${STORE}; observed now).`,
        become:
          // #819 follow-up 2 re-pin (walk --check wording): no way is read — was "unknown (…; observed now)"
          "  This login can become Realm's service user without a password being asked: not measured (there is no service user to name: no store was found).",
      },
      // Correction 2 (5.3): the owner read from the folder above the store is labelled so.
      denied: {
        header: `Separation: separate user — An agent running as agent cannot record a gate answer through this server, the terminal or Realm's files, provided no program Realm runs as realm, read from the owner of ${HOME}, can run code for it, Realm's server runs this Node and this Realm package, every Realm server on this machine starts with --gate-answers withheld, and no registered workflow's extension file (not read: the store cannot be read) can be changed by this login.`,
        store: `  This login can write Realm's store or open its files: no (measured) — ${STORE}: permission denied.`,
        become: `  This login can become Realm's service user (realm, read from the owner of ${HOME}) without a password being asked: no (measured now) — no sudo, su, doas, polkit or ssh way was found in /usr/bin, /usr/sbin, /usr/local/bin, /usr/local/sbin, /bin, /sbin, /run/wrappers/bin, /run/setuid-programs or on PATH (polkitd also at /usr/lib/polkit-1/polkitd, /usr/libexec/polkitd, /usr/lib/policykit-1/polkitd; sshd's units ssh.socket, sshd.socket, ssh.service, sshd.service in /etc/systemd/system, /run/systemd/system, /usr/lib/systemd/system, /lib/systemd/system).`,
      },
      // #819 (C3): a store this login owns is within its reach, whatever its mode — the same login.
      ownedNo: {
        header:
          "Separation: same login — An agent running as this login could answer a gate through the terminal or by editing Realm's files; Realm records how each answer arrived but cannot stop it.",
        store:
          "  This login can write Realm's store or open its files: yes (measured) — this login owns the store, so it can change who may open it.",
        become:
          // #819 follow-up 2 re-pin (walk --check wording): no way is read — was "unknown (…; observed now)"
          "  This login can become Realm's service user without a password being asked: not measured (there is no separate service user: the store belongs to this login).",
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
    expect(conditionLine('root_engine', evidence)).toBe(
      `This login can reach an engine that runs as root: yes (measured) — Docker's socket ${own} accepts.`,
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
    // #819 Unit B re-pin (reversal 2): su was read and not settled — was "was not measured"
    expect(claim).toBe(
      `${MAY} whether it can become Realm's service user without a password is unknown.`,
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
    expect([conditionLine('root_engine', e), conditionLine('agent_sandbox', e)]).toEqual([
      "This login can reach an engine that runs as root: unknown (this login's home could not be read: it has no passwd entry, so its own Docker sockets were not checked; observed now).",
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
      // #790: "runs as root" is condition 3's own words; root named as Realm's service user is not.
      rootNamed: /service user \(root|runs as root,? can run code/.test(root.join('\n')),
      rootBecome: root[3],
      mineOwns: mine.join('\n').includes('This login owns the store'),
      mineBecome: mine[3],
      strangerBecome: conditionLine('become_service_user', stranger),
    }).toEqual({
      rootNamed: false,
      // #819 follow-up 2 re-pin (walk --check wording): no way is read — was "unknown (…; observed now)"
      rootBecome: `  This login can become Realm's service user without a password being asked: not measured (the store's owner could not be read: ${STORE} cannot be opened).`,
      mineOwns: false,
      mineBecome: `  This login can become Realm's service user without a password being asked: not measured (the store's owner could not be read: ${STORE} cannot be opened).`,
      strangerBecome: `This login can become Realm's service user (realm, read from the owner of ${HOME}) without a password being asked: no (measured now) — no sudo, su, doas, polkit or ssh way was found in /usr/bin, /usr/sbin, /usr/local/bin, /usr/local/sbin, /bin, /sbin, /run/wrappers/bin, /run/setuid-programs or on PATH (polkitd also at /usr/lib/polkit-1/polkitd, /usr/libexec/polkitd, /usr/lib/policykit-1/polkitd; sshd's units ssh.socket, sshd.socket, ssh.service, sshd.service in /etc/systemd/system, /run/systemd/system, /usr/lib/systemd/system, /lib/systemd/system).`,
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

  it('5.9: the check names no process API (#790: its one spawn site is separation/runner.ts)', () => {
    const src = readFileSync(new URL('./separation-check.ts', import.meta.url), 'utf8');
    // (a) red when the check imports a process API again; (b) prints whether each name appears.
    // #790: the "not probed" half of this cell is replaced by separation-790.test.ts's cells.
    expect({
      // #790 correction (A §F12): the module by any spelling, with or without its `node:` prefix
      childProcess: /\bchild_process\b/.test(src),
      spawnSync: src.includes('spawnSync'),
      execFile: src.includes('execFile'),
      // A bare `exec(` — never a RegExp's `.exec(`, which the check uses to read files' text.
      exec: /(?<![.\w])exec\(/.test(src),
      spawn: /\bspawn\(/.test(src),
      fork: /\bfork\(/.test(src),
    }).toEqual({
      childProcess: false,
      spawnSync: false,
      execFile: false,
      exec: false,
      spawn: false,
      fork: false,
    });
  });

  it('8.5: with no store, the header says no store was found — never "against the store at"', async () => {
    const lines = renderSeparation(await measure(machine({ stat: () => ({ error: 'ENOENT' }) })));
    // (a) red when the header names a store the check never found; (b) prints the line.
    expect(lines[1]).toBe(`Measured for the login 'agent'; no store was found at ${STORE}.`);
  });
});

describe('#819 — the reach lines say only what was measured (01: C1, C3, C4)', () => {
  const ECONOMICS = 'This login can change runner.cache.economics (informational)';

  /** A machine whose probes read paths as the real ones do — relative to this process's folder. */
  const resolving = (
    files: Record<string, string>,
    writable: string[],
    owners: Record<string, number>,
  ): SeparationProbes => {
    const there = new Set([STORE, `${STORE}/runs`, `${STORE}/workflows`, ...Object.keys(files)]);
    return machine({
      exists: (p) => there.has(resolve(p)),
      readText: (p) => files[resolve(p)],
      canWrite: (p) => writable.includes(resolve(p)),
      stat: (p) =>
        there.has(resolve(p)) || writable.includes(resolve(p))
          ? { uid: owners[resolve(p)] ?? 0, mode: 0o40755 }
          : { error: 'ENOENT' },
    });
  };

  it('C1: a root passed relative is resolved — the folders above the deployment are walked (`--project .`); the same root absolute reads the same', async () => {
    // The deployment is this process's folder (the check resolves against the real working folder;
    // a fixture cannot move it): another user's, and the folder above it writable by this login.
    const here = process.cwd();
    const probes = () =>
      resolving({ [join(here, 'realm.yaml')]: 'version: 1\n' }, [dirname(here)], {
        [STORE]: REALM_UID,
        [here]: REALM_UID,
        [join(here, 'realm.yaml')]: REALM_UID,
      });
    const line = async (root: string) =>
      conditionLine(
        'trust_root_writable',
        await measureSeparation({ probes: probes(), value: FLAG, roots: [root], door: 'mcp' }),
      );
    // (a) red when the root is joined as given (`join(root, 'realm.yaml')`, the raw path walked:
    //     `dirname('.')` is `.`, so the folder above is never looked at — "no (measured)"), or the
    //     relative and absolute roots read apart; (b) prints both lines.
    expect({ relative: await line('.'), absolute: await line(here) }).toEqual({
      relative: `${CONDITION_4}: yes (measured) — ${join(here, 'realm.yaml')} can be changed.`,
      absolute: `${CONDITION_4}: yes (measured) — ${join(here, 'realm.yaml')} can be changed.`,
    });
  });

  it("C1: a linked realm.yaml is changeable through the link's own folders and through its target's", async () => {
    const LINK = `${PROJECT}/realm.yaml`;
    const TARGET = '/etc/realm/realm.yaml';
    const linked = (writable: string) =>
      measure(
        machine({
          canWrite: (p) => p === writable,
          realPath: (p) => (p === LINK ? TARGET : undefined),
          stat: (p) =>
            p === STORE
              ? { uid: REALM_UID, mode: 0o40755 }
              : p === LINK || p === TARGET || p === PROJECT
                ? { uid: REALM_UID, mode: 0o40755 }
                : { uid: 0, mode: 0o40755 },
        }),
      ).then((e) => conditionLine('trust_root_writable', e));
    // (a) red per row: `viaLink` when the path is replaced by its target (the link's own folders —
    //     `/srv` — dropped); `viaTarget` when the target's folders are not walked; (b) prints both.
    expect({ viaLink: await linked('/srv'), viaTarget: await linked('/etc/realm') }).toEqual({
      viaLink: `${CONDITION_4}: yes (measured) — ${LINK} can be changed.`,
      viaTarget: `${CONDITION_4}: yes (measured) — ${LINK} can be changed.`,
    });
  });

  it('C3: a store this login owns, locked (mode 000), is within its reach — "yes (measured)", and the header is the same login', async () => {
    const lines = renderSeparation(
      await measure(
        machine(
          {
            stat: (p) => (p === STORE ? { uid: ME, mode: 0o40000 } : { uid: ME, mode: 0o40755 }),
          },
          PROJECT_FILES,
          [],
          {},
        ),
      ),
    );
    // (a) red when an owned store is read by its mode ("no (measured)", W's walk 3); (b) prints the
    //     header and the store line.
    expect({ header: lines[0], store: lines[2] }).toEqual({
      header:
        "Separation: same login — An agent running as this login could answer a gate through the terminal or by editing Realm's files; Realm records how each answer arrived but cannot stop it.",
      store:
        "  This login can write Realm's store or open its files: yes (measured) — this login owns the store, so it can change who may open it.",
    });
  });

  it('C4: a sticky folder this login owns lets it replace any entry — condition 4 "yes"', async () => {
    const line = conditionLine(
      'trust_root_writable',
      await measure(
        machine({
          canWrite: (p) => p === PROJECT,
          stat: (p) =>
            p === PROJECT
              ? { uid: ME, mode: 0o41777 }
              : p === `${PROJECT}/realm.yaml`
                ? { uid: REALM_UID, mode: 0o100644 }
                : p === STORE
                  ? { uid: REALM_UID, mode: 0o40755 }
                  : { uid: 0, mode: 0o40755 },
        }),
      ),
    );
    // (a) red when only the entry's owner decides (the folder's own owner ignored); (b) prints it.
    expect(line).toBe(`${CONDITION_4}: yes (measured) — ${PROJECT}/realm.yaml can be changed.`);
  });

  it('#819 correction 1 C-19 (SEP-00 (g)): a link this login owns in a sticky world-writable folder, pointing at another user\'s file — condition 4 "yes"', async () => {
    const line = conditionLine(
      'trust_root_writable',
      await measure(
        machine({
          canWrite: (p) => p === PROJECT,
          // the folder root's, sticky and world-writable; realm.yaml a link whose target is Realm's
          // user's file (stat follows it) while the link itself is this login's (lstat)
          stat: (p) =>
            p === PROJECT
              ? { uid: 0, mode: 0o41777 }
              : p === `${PROJECT}/realm.yaml`
                ? { uid: REALM_UID, mode: 0o100644 }
                : p === STORE
                  ? { uid: REALM_UID, mode: 0o40755 }
                  : { uid: 0, mode: 0o40755 },
          lstat: (p) =>
            p === `${PROJECT}/realm.yaml`
              ? { uid: ME, mode: 0o120777 }
              : p === PROJECT
                ? { uid: 0, mode: 0o41777 }
                : p === STORE
                  ? { uid: REALM_UID, mode: 0o40755 }
                  : { uid: 0, mode: 0o40755 },
        }),
      ),
    );
    // (a) red when the entry's owner is read through stat (the link's target's: "no"); (b) prints it.
    expect(line).toBe(`${CONDITION_4}: yes (measured) — ${PROJECT}/realm.yaml can be changed.`);
  });

  it('C4: the economics line — named (measured), not named in a realm.yaml read (measured by whether it can be changed), none given (not measured), no folder (unknown)', async () => {
    const economics = async (files: Record<string, string>, roots = [PROJECT]) =>
      conditionLine(
        'economics_writable',
        await measureSeparation({ probes: machine({}, files), value: FLAG, roots, door: 'mcp' }),
      );
    // (a) red per row: `named` when a named file is not measured; `notNamed` when a realm.yaml that
    //     names none is not judged by whether it can be changed (#819 follow-up 2); `none` when no
    //     realm.yaml read is called measured, or — #819 correction 1 (walk --check wording 4) — when
    //     it does not name --project; `unread` (A MINOR 9) when a root whose realm.yaml cannot be read
    //     is told to pass one; (b) prints the four lines.
    expect({
      named: await economics({
        [`${PROJECT}/realm.yaml`]: 'runner:\n  cache:\n    economics: prices.json\n',
      }),
      notNamed: await economics(PROJECT_FILES),
      none: await economics({}, []),
      unread: await economics({}, [PROJECT]),
    }).toEqual({
      named: `${ECONOMICS}: no (measured) — ${PROJECT}/prices.json.`,
      // #819 follow-up 2 re-pins (walk --check wording) — notNamed: was "no runner.cache.economics
      // is set (fact)"; none: was "unknown (…; observed now)"; unread: this machine has no folder,
      // was "unknown (no realm.yaml could be read; observed now)"
      notNamed: `${ECONOMICS}: no (measured) — ${PROJECT}/realm.yaml cannot be changed, and it sets no runner.cache.economics.`,
      none: `${ECONOMICS}: not measured (no realm.yaml was given to read: pass --project with the deployment root).`,
      unread: `${ECONOMICS}: unknown (no such folder: ${PROJECT}; observed now).`,
    });
  });

  it('C4: a store this login cannot open — the header says so, never only "against the store at"', async () => {
    const header = async (stat: SeparationProbes['stat']) =>
      renderSeparation(await measure(machine({ stat, list: () => undefined })))[1];
    // (a) red when a store that could not be stat'ed is named as one the check measured against;
    //     (b) prints both headers.
    expect({
      denied: await header((p) =>
        p === STORE
          ? { error: 'EACCES' }
          : p === HOME
            ? { uid: REALM_UID, mode: 0o40755 }
            : { error: 'ENOENT' },
      ),
      other: await header((p) =>
        p === STORE
          ? { error: 'EIO' }
          : p === HOME
            ? { uid: REALM_UID, mode: 0o40755 }
            : { error: 'ENOENT' },
      ),
    }).toEqual({
      // #819 Unit B correction re-pin (item 4): was "is not known" — one state, one word
      denied: `Measured for the login 'agent', against ${STORE}, which this login cannot open, so whether a store is there is unknown.`,
      other: `Measured for the login 'agent', against ${STORE}, which this login cannot open, so whether a store is there is unknown.`,
    });
  });

  it("C4: the uid is the process's own (`process.getuid`), never `os.userInfo()`'s — which is -1 on Windows, where there is no getuid", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
    try {
      Object.defineProperty(process, 'getuid', { value: () => 4321, configurable: true });
      const read = systemProbes().uid();
      Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
      const none = systemProbes().uid();
      // (a) red when `os.userInfo().uid` is read first (this login's real uid, not 4321), or read
      //     when the process gives none; (b) prints both.
      expect({ read, none }).toEqual({ read: 4321, none: undefined });
    } finally {
      if (descriptor !== undefined) Object.defineProperty(process, 'getuid', descriptor);
    }
  });

  it('C4: with no uid, a store this login can read is not the same login — unknown', async () => {
    const lines = renderSeparation(
      await measure(
        machine(
          { uid: () => undefined, canRead: (p) => p === `${STORE}/runs` },
          PROJECT_FILES,
          [],
          {},
        ),
      ),
    );
    // (a) red when core's same_account arm does not need this login to own the store (an unknown
    //     uid owns nothing); (b) prints the header.
    // #819 Unit B re-pin (reversal 1): the header word only — was "Separation: not measured"; the
    // service user, never named (`not_observed`), keeps "was not measured"
    expect(lines[0]).toBe(
      `Separation: unknown — An agent running as agent may still be able to answer a gate: it can read Realm's store; whether it can become Realm's service user without a password was not measured.`,
    );
  });

  it('C4: with no login home, the system\'s engine sockets are still tried — one that accepts is "yes"', async () => {
    const e = await measure(
      machine(
        {
          loginHome: () => undefined,
          connect: async (t) => 'path' in t && t.path === '/var/run/docker.sock',
        },
        PROJECT_FILES,
        ['/var/run/docker.sock'],
      ),
    );
    // (a) red when a login with no home returns its unknown before the system sockets are tried;
    //     (b) prints the line.
    expect(conditionLine('root_engine', e)).toBe(
      "This login can reach an engine that runs as root: yes (measured) — Docker's socket /var/run/docker.sock accepts.",
    );
  });
});

describe('#819 follow-up 2 — the walk’s --check wording: each line says only what was observed', () => {
  const ECONOMICS = 'This login can change runner.cache.economics (informational)';
  const line = async (
    c: Parameters<typeof conditionLine>[0],
    probes: SeparationProbes,
    roots = [PROJECT],
  ) => conditionLine(c, await measureSeparation({ probes, value: FLAG, roots, door: 'mcp' }));

  it('"not measured" where nothing was read now, "observed now" where a read gave the unknown', async () => {
    const noStore = machine({ exists: (p) => p === PROJECT || p === `${PROJECT}/realm.yaml` });
    // (a) red when a line whose unknown rests on nothing read says "observed now" (another answer
    //     host; the service user with no store; economics with no realm.yaml given), or a line a
    //     read gave says "not measured" (the store not found); (b) prints the four lines.
    expect({
      otherHost: await line('other_answer_host', machine()),
      become: await line('become_service_user', noStore),
      economics: await line('economics_writable', machine(), []),
      store: await line('store_reach', noStore),
    }).toEqual({
      otherHost:
        'Another Realm server or CLI that takes answers uses this store: not measured (another Realm server or CLI could use this store, and one look cannot rule it out).',
      become:
        "This login can become Realm's service user without a password being asked: not measured (there is no service user to name: no store was found).",
      economics: `${ECONOMICS}: not measured (no realm.yaml was given to read: pass --project with the deployment root).`,
      store: `This login can write Realm's store or open its files: unknown (Realm's store was not found at ${STORE}; observed now).`,
    });
  });

  it('the economics line answers its own question: a realm.yaml naming none reads yes when this login can change it', async () => {
    // (a) red when a changeable realm.yaml that names none is a fact, or reads "no"; (b) prints it.
    expect(
      await line('economics_writable', machine({ canWrite: (p) => p === `${PROJECT}/realm.yaml` })),
    ).toBe(
      `${ECONOMICS}: yes (measured) — ${PROJECT}/realm.yaml can be changed, and it sets no runner.cache.economics.`,
    );
  });

  it('a --project folder that is not there, a folder with no realm.yaml, and a realm.yaml that cannot be read are each named', async () => {
    const folder = machine({}, {}, [PROJECT]);
    const unreadable = machine({}, {}, [PROJECT, `${PROJECT}/realm.yaml`]);
    // (a) red per row: `noFolder` when a missing folder is accepted without a word (no realm.yaml
    //     found); `noFile` when a folder with none says "could be read"; `unreadable` when a file
    //     there is called absent; `trustNoFile` when the folder is there but no realm.yaml is
    //     called "no such folder"; (b) prints each line.
    expect({
      noFolder: await line('economics_writable', machine({}, {})),
      trustNoFolder: await line('trust_root_writable', machine({}, {})),
      noFile: await line('economics_writable', folder),
      trustNoFile: await line('trust_root_writable', folder),
      unreadable: await line('economics_writable', unreadable),
    }).toEqual({
      noFolder: `${ECONOMICS}: unknown (no such folder: ${PROJECT}; observed now).`,
      trustNoFolder: `${CONDITION_4}: unknown (no such folder: ${PROJECT}; observed now).`,
      noFile: `${ECONOMICS}: unknown (no realm.yaml in ${PROJECT}; observed now).`,
      trustNoFile: `${CONDITION_4}: unknown (no realm.yaml was found to check: pass --project with the deployment root; observed now).`,
      unreadable: `${ECONOMICS}: unknown (${PROJECT}/realm.yaml cannot be read; observed now).`,
    });
  });
});

describe('#819 Unit B: the words', () => {
  const NO: ConditionReading = { basis: 'measured', answer: 'no' };
  const YES: ConditionReading = { basis: 'measured', answer: 'yes' };
  // a reading of condition 2 sudo was asked for now and did not settle — the Unit A correction (C6,
  // divergence 7 of #860): P2's printout, in the words the reader prints today (crown b3's old
  // "cannot split" reading reads yes since Unit A)
  const SUDO_UNSPLIT: ConditionReading = {
    basis: 'unknown',
    cause:
      'sudo: unknown: sudo listed a Defaults setting this check cannot split: passprompt="x \\", !authenticate, mailsub=w\\" (a value with a space that ends in a backslash, or holds a backslash before a quotation mark, prints the same as another setting; write it without one) (LC_ALL=C /usr/bin/sudo -n -l and -n -ll)',
  };
  /** Hand-made evidence: another user's store, every prevents condition measured "no" and the value
   *  withheld on the line, unless `conds` says otherwise; `not_observed` as the check sets it with a
   *  service user named (another answer host only), plus `more`. */
  const evidence = (
    conds: Partial<CheckEvidence['conditions']> = {},
    more: SeparationCondition[] = [],
  ): CheckEvidence => ({
    login: 'agent',
    service_user: 'realm',
    store_owned_by_other: true,
    owns_store: false,
    conditions: {
      store_reach: NO,
      become_service_user: NO,
      root_engine: NO,
      trust_root_writable: NO,
      other_answer_host: { basis: 'unknown', cause: 'one look' },
      time_basis: { basis: 'measured', answer: 'fact', detail: 'clock' },
      agent_sandbox: NO,
      economics_writable: { basis: 'measured', answer: 'fact', detail: 'none' },
      ...conds,
    },
    value: FLAG,
    store: STORE,
    store_found: true,
    door: 'mcp',
    extensions_unread: false,
    not_observed: ['other_answer_host', ...more],
  });
  /** No store at HOME: the project and getent are there, and `more` (a socket that accepts). */
  const noStore = (more: string[] = []) =>
    machine({
      exists: (p) =>
        p === PROJECT || p === `${PROJECT}/realm.yaml` || p === GETENT || more.includes(p),
      connect: async (t) => 'path' in t && more.includes(t.path),
    });
  /** The header's words up to the claim. */
  const head = (lines: string[]) => lines[0]!.slice(0, lines[0]!.indexOf(' — ') + 3);
  /** The line of a condition, by its words' start. */
  const lineOf = (lines: string[], start: string) => lines.find((l) => l.startsWith(`  ${start}`));

  it('1. the header, each mode: "Separation: unknown" when the check cannot tell (no store first); the other three unchanged', async () => {
    const SANDBOX = {
      ...PROJECT_FILES,
      '/home/agent/.claude/settings.json': '{"sandbox":{"enabled":true}}',
    };
    // (a) red: `unknown` when the header word for a separation the check cannot tell is not
    //     "unknown" (reversal 1 undone: "not measured"); the other three when the header word is
    //     not the mode's own; (b) prints the four header starts.
    expect({
      unknown: head(renderSeparation(await measure(noStore()))),
      sameAccount: head(renderSeparation(await measure(machine({}, PROJECT_FILES, [], {})))),
      separateUser: head(renderSeparation(await measure(machine()))),
      sandbox: head(renderSeparation(await measure(machine({}, SANDBOX, [], {})))),
    }).toEqual({
      unknown: 'Separation: unknown — ',
      sameAccount: 'Separation: same login — ',
      separateUser: 'Separation: separate user — ',
      sandbox: 'Separation: sandbox configured — ',
    });
  });

  it('2. the summary, each gap × basis: "is unknown" when read and not settled, "was not measured" when nothing was read, "it can" and "configured" unchanged', () => {
    const UNK: ConditionReading = { basis: 'unknown', cause: 'c' };
    const claim = (conds: Partial<CheckEvidence['conditions']>, more: SeparationCondition[] = []) =>
      separationClaim(evidence(conds, more)).slice(MAY.length + 1);
    // (a) red: `becomeObserved`, `store`, `engine`, `files` when an unknown read now says "was not
    //     measured" (reversal 2 undone); `becomeNotObserved` when the summary is not given the
    //     conditions nothing was read for; `yes` when a measured yes is not "it can"; `configured`
    //     when a configured reading is not named so; (b) prints each gap's words.
    expect({
      becomeObserved: claim({ become_service_user: SUDO_UNSPLIT }),
      becomeNotObserved: claim({ become_service_user: UNK }, ['become_service_user']),
      store: claim({ store_reach: UNK }),
      engine: claim({ root_engine: UNK }),
      files: claim({ trust_root_writable: UNK }),
      yes: claim({ root_engine: YES }),
      configured: claim({
        become_service_user: { basis: 'configured_not_enforced', detail: 'a sudoers rule' },
      }),
    }).toEqual({
      becomeObserved: "whether it can become Realm's service user without a password is unknown.",
      becomeNotObserved:
        "whether it can become Realm's service user without a password was not measured.",
      store: "whether it can reach Realm's store is unknown.",
      engine: 'whether it can reach an engine that runs as root is unknown.',
      files: 'whether it can change the files Realm executes is unknown.',
      yes: 'it can reach an engine that runs as root.',
      configured:
        "whether it can become Realm's service user without a password is configured, not enforced by Realm.",
    });
  });

  describe('3. condition 2\'s line: how a tool was read, said once — "as above" for each next entry read the same way', () => {
    const line = (paths: SwitchPathReading[]) => {
      const r = switchPathsReading(paths, 'svc');
      return (r.basis === 'unknown' ? r.cause : r.detail) ?? '';
    };
    // the Unit A correction (C6, divergence 7 of #860): the refusal's cause as sudo.ts prints it today
    const C =
      "sudo does not show its Defaults or whether a rule exists, so rootpw, targetpw or runaspw cannot be ruled out: rootpw asks for root's password, targetpw for the target user's, runaspw for its runas_default user's";
    const howOf = (tool: string) =>
      `LC_ALL=C ${tool} -n -l says: a password is required; /etc/pam.d/sudo, /etc/pam.d/common-auth read`;
    /** sudo's refusal (sudo.ts's unseenDefaults): three entries, one tool, one how. */
    const refusal = (tool: string): SwitchPathReading[] => [
      {
        path: 'sudo',
        tool,
        outcome: 'needs_credential',
        whose: 'this_login',
        how: howOf(tool),
        or_not_allowed: true,
      },
      {
        path: 'sudo',
        tool,
        outcome: 'needs_credential',
        whose: 'root',
        how: howOf(tool),
        cause: C,
      },
      { path: 'sudo', tool, outcome: 'needs_credential', whose: 'svc', how: howOf(tool), cause: C },
    ];
    const H = howOf('/usr/bin/sudo');
    const SU = '/etc/pam.d/su, /etc/pam.d/common-auth read';
    const su = (whose: 'svc' | 'person'): SwitchPathReading => ({
      path: 'su',
      tool: '/usr/bin/su',
      outcome: 'needs_credential',
      whose,
      how: SU,
    });

    it('(a) sudo\'s refusal: one full how, then "(⟨cause⟩; as above)" twice', () => {
      // (a) red when the next entries read the same way print the how again, or the merged form
      //     drops the cause; (b) prints the line.
      expect(line(refusal('/usr/bin/sudo'))).toBe(
        `sudo: needs this login's password or is not allowed (sudo does not say which; ${H}); sudo: may need root's password (${C}; as above); sudo: may need svc's password (${C}; as above)`,
      );
    });

    it('(b) two tools whose hows differ: each keeps its own; (b′) one tool read two ways: each keeps its own', () => {
      const P = '/etc/pam.d/sudo read';
      // (a) red: `twoTools` when an entry of another tool, read another way, prints "as above"
      //     (#819 Unit B correction, item 5: nothing compared, `asAbove = prev !== undefined`);
      //     `oneToolTwoWays` when the tool alone decides (the how is not compared); (b) prints each line.
      expect({
        twoTools: line([refusal('/usr/bin/sudo')[1]!, su('svc')]),
        oneToolTwoWays: line([
          {
            path: 'sudo',
            tool: '/usr/bin/sudo',
            outcome: 'needs_credential',
            whose: 'root',
            how: H,
          },
          {
            path: 'sudo',
            tool: '/usr/bin/sudo',
            outcome: 'needs_credential',
            whose: 'person',
            how: P,
          },
        ]),
      }).toEqual({
        twoTools: `sudo: may need root's password (${C}; ${H}); su: needs svc's password (${SU})`,
        oneToolTwoWays: `sudo: needs root's password (${H}); sudo: needs a person's touch or key (${P})`,
      });
    });

    it('(c) two sudo copies, root then svc, read the same way: each keeps its own how', () => {
      // (a) red when the tool is not compared (only the how); (b) prints the line.
      expect(
        line([
          {
            path: 'sudo',
            tool: '/usr/bin/sudo',
            outcome: 'needs_credential',
            whose: 'root',
            how: 'H',
          },
          {
            path: 'sudo',
            tool: '/usr/local/bin/sudo',
            outcome: 'needs_credential',
            whose: 'svc',
            how: 'H',
          },
        ]),
      ).toBe("sudo: needs root's password (H); sudo: needs svc's password (H)");
    });

    it('(d) one entry: unchanged', () => {
      // (a) red when the first entry prints "as above" (there is nothing above it); (b) prints it.
      expect(line([su('svc')])).toBe(`su: needs svc's password (${SU})`);
    });

    it('(e) the plain form: su\'s service user and a person module (su.ts), "(as above)"', () => {
      // (a) red when the second entry prints the how again; (b) prints the line.
      expect(line([su('svc'), su('person')])).toBe(
        `su: needs svc's password (${SU}); su: needs a person's touch or key (as above)`,
      );
    });

    it('(f) polkit\'s two whose, the merged form: "(⟨cause⟩; as above)"', () => {
      const how =
        "/usr/bin/pkcheck --action-id <A> --process <this check's pid> asked for org.freedesktop.systemd1.manage-units";
      const cause = "polkit's rules may change whose it asks";
      const pk = (whose: 'administrator' | 'this_login'): SwitchPathReading => ({
        path: 'polkit',
        tool: '/usr/bin/pkcheck',
        outcome: 'needs_credential',
        whose,
        how,
        cause,
      });
      // (a) red when the second whose prints the how again, or loses its cause; (b) prints the line.
      expect(line([pk('administrator'), pk('this_login')])).toBe(
        `polkit: may need an administrator's password (${cause}; ${how}); polkit: may need this login's password (${cause}; as above)`,
      );
    });

    it('(g) "as above" is the entry just before: [sudo A (H), su, sudo A again (H)] — the third keeps its own how', () => {
      // (a) red when an entry is compared with any earlier entry of its tool, not the one just
      //     before it; (b) prints the line.
      expect(
        line([
          {
            path: 'sudo',
            tool: '/usr/bin/sudo',
            outcome: 'needs_credential',
            whose: 'root',
            how: H,
          },
          su('svc'),
          {
            path: 'sudo',
            tool: '/usr/bin/sudo',
            outcome: 'needs_credential',
            whose: 'svc',
            how: H,
          },
        ]),
      ).toBe(
        `sudo: needs root's password (${H}); su: needs svc's password (${SU}); sudo: needs svc's password (${H})`,
      );
    });

    it('(h) the dedupe comes first: two root-owned copies that both refuse print all six entries', () => {
      const out = line([...refusal('/usr/bin/sudo'), ...refusal('/usr/local/bin/sudo')]);
      // (a) red when "as above" is written before the dedupe (the second copy's two "as above"
      //     entries then match the first's, and drop: 4); (b) prints the count and the line.
      expect({ entries: out.split('; sudo: ').length, out }).toEqual({
        entries: 6,
        out: [
          `sudo: needs this login's password or is not allowed (sudo does not say which; ${H})`,
          `sudo: may need root's password (${C}; as above)`,
          `sudo: may need svc's password (${C}; as above)`,
          `sudo: needs this login's password or is not allowed (sudo does not say which; ${howOf('/usr/local/bin/sudo')})`,
          `sudo: may need root's password (${C}; as above)`,
          `sudo: may need svc's password (${C}; as above)`,
        ].join('; '),
      });
    });
  });

  it('4. the cross cell: for the same evidence, the condition line and the summary use one word — unknown, and not measured', async () => {
    const lines = renderSeparation(await measure(noStore()));
    const b3 = renderSeparation(evidence({ become_service_user: SUDO_UNSPLIT }));
    const STORE_LINE = "This login can write Realm's store or open its files:";
    const BECOME_LINE = "This login can become Realm's service user";
    /** The line's word for a reading not settled. */
    const lineWord = (l: string | undefined) =>
      l?.includes(': unknown (') === true
        ? 'unknown'
        : l?.includes(': not measured (') === true
          ? 'not measured'
          : `neither: ${l ?? 'no line'}`;
    /** The summary's word for that condition's gap. */
    const summaryWord = (header: string, subject: string) =>
      header.includes(`${subject} is unknown`)
        ? 'unknown'
        : header.includes(`${subject} was not measured`)
          ? 'not measured'
          : `neither: ${header}`;
    // (a) red when the summary and the line disagree: the summary not given the conditions nothing
    //     was read for, or the line not keyed on them; (b) prints each pair of words.
    expect({
      noStoreReach: [
        lineWord(lineOf(lines, STORE_LINE)),
        summaryWord(lines[0]!, "reach Realm's store"),
      ],
      noStoreBecome: [
        lineWord(lineOf(lines, BECOME_LINE)),
        summaryWord(lines[0]!, "become Realm's service user without a password"),
      ],
      crownB3Become: [
        lineWord(lineOf(b3, BECOME_LINE)),
        summaryWord(b3[0]!, "become Realm's service user without a password"),
      ],
    }).toEqual({
      noStoreReach: ['unknown', 'unknown'],
      noStoreBecome: ['not measured', 'not measured'],
      crownB3Become: ['unknown', 'unknown'],
    });
  });

  it('6. the header\'s mode is not a condition\'s basis: "Separation: unknown" beside a measured yes; "Separation: separate user" beside condition 2\'s unknown', async () => {
    const DOCKER = '/var/run/docker.sock';
    const engineYes = renderSeparation(await measure(noStore([DOCKER])));
    const sepUnknown = renderSeparation(evidence({ become_service_user: SUDO_UNSPLIT }));
    // (a) red: `engineYes` when a condition's line takes the mode's word (or the header a
    //     condition's); `sepUnknown` when the header word comes from a condition's basis, not the
    //     mode; (b) prints the header starts and the two lines.
    expect({
      engineYes: [
        head(engineYes),
        lineOf(engineYes, 'This login can reach an engine that runs as root:'),
      ],
      sepUnknown: [
        head(sepUnknown),
        lineOf(
          sepUnknown,
          "This login can become Realm's service user (realm) without a password being asked:",
        ),
      ],
    }).toEqual({
      engineYes: [
        'Separation: unknown — ',
        `  This login can reach an engine that runs as root: yes (measured) — Docker's socket ${DOCKER} accepts.`,
      ],
      sepUnknown: [
        'Separation: separate user — ',
        `  This login can become Realm's service user (realm) without a password being asked: unknown (${SUDO_UNSPLIT.cause}; observed now).`,
      ],
    });
  });
});
