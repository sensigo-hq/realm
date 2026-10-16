// separation-check-627.test.ts — #627 W, Part K (cell 26): `--check`'s separation check, measured on
// fixture machines (injected probes — no real file, process or socket is touched). The positive cell
// prints the "cannot record" form with its proviso; each "prevents" conjunct is pinned on its own;
// each condition's line in each of its states; the value line (F36: measured only from the `--check`
// line's own flag); the mode; the login; conditions 5–8.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: logins,
// paths and words — never a token or an environment.
import { describe, it, expect } from 'vitest';
import type { GateAnswers, Source } from '@sensigo/realm';
import {
  conditionLine,
  measureSeparation,
  renderSeparation,
  separationClaim,
  valueLine,
  type SeparationProbes,
} from './separation-check.js';

const HOME = '/home/svc';
const STORE = `${HOME}/.realm`;
const PROJECT = '/srv/deploy';

/** A machine: the store owned by `realm` (uid 900), unreachable by `agent` (uid 1000), nothing else. */
function machine(
  over: Partial<SeparationProbes> = {},
  files: Record<string, string> = {},
  present: string[] = [],
): SeparationProbes {
  const exists = new Set([
    STORE,
    `${STORE}/runs`,
    `${STORE}/workflows`,
    ...Object.keys(files),
    ...present,
  ]);
  return {
    login: () => 'agent',
    uid: () => 1000,
    home: () => HOME,
    env: { PATH: '/usr/bin' },
    ownerOf: (p) => (p === STORE ? 900 : 1000),
    userName: (uid) => (uid === 900 ? 'realm' : undefined),
    canWrite: () => false,
    canRead: () => false,
    exists: (p) => exists.has(p),
    readText: (p) => files[p],
    list: () => [],
    run: () => 1,
    connect: async () => false,
    ...over,
  };
}

/** The sudo readings all negative: sudo present, Touch ID absent, timestamp_timeout=0. */
const SUDO_NEGATIVE = {
  '/etc/pam.d/sudo': 'auth required pam_unix.so\n',
  '/etc/sudoers': 'Defaults timestamp_timeout=0\n',
  [`${PROJECT}/realm.yaml`]: 'version: 1\n',
};
const SUDO_BIN = ['/usr/bin/sudo'];

const FLAG: { value: GateAnswers; source: Source } = {
  value: 'withheld',
  source: { kind: 'flag', ref: '--gate-answers' },
};
const ENV: { value: GateAnswers; source: Source } = {
  value: 'withheld',
  source: { kind: 'env', ref: 'REALM_MCP_GATE_ANSWERS' },
};

const measure = (probes: SeparationProbes, value = FLAG) =>
  measureSeparation({ probes, value, roots: [PROJECT] });

describe('#627 W — the separation check (cell 26)', () => {
  it('the positive cell: separate user, conditions 1–4 measured no, --gate-answers withheld on the line → "cannot record", with its proviso', async () => {
    const e = await measure(machine({}, SUDO_NEGATIVE, SUDO_BIN));
    // (a) red when the proviso is dropped, or the form prints without the flag; (b) prints the claim.
    expect(separationClaim(e)).toBe(
      "An agent running as agent cannot record a gate answer through this server, the terminal or Realm's files, provided no program Realm runs as realm can run code for it and every Realm server on this machine starts with `--gate-answers withheld`.",
    );
  });

  it('each prevents conjunct alone takes the claim away — the mode, conditions 1–4, the value and its source', async () => {
    const claim = async (probes: SeparationProbes, value = FLAG) =>
      separationClaim(await measure(probes, value));
    const MAY = 'An agent running as agent may still be able to answer a gate:';
    // (a) red per cell when its conjunct is skipped; (b) prints each claim.
    expect({
      sameLogin: await claim(machine({ ownerOf: () => 1000 }, SUDO_NEGATIVE, SUDO_BIN)),
      store: await claim(
        machine({ canWrite: (p) => p === `${STORE}/runs` }, SUDO_NEGATIVE, SUDO_BIN),
      ),
      become: await claim(
        machine({}, { ...SUDO_NEGATIVE, '/etc/sudoers': undefined as never }, SUDO_BIN),
      ),
      docker: await claim(
        machine({ connect: async () => true }, SUDO_NEGATIVE, [
          ...SUDO_BIN,
          '/var/run/docker.sock',
        ]),
      ),
      trustRoot: await claim(machine({ canWrite: (p) => p === PROJECT }, SUDO_NEGATIVE, SUDO_BIN)),
      asked: await claim(machine({}, SUDO_NEGATIVE, SUDO_BIN), {
        value: 'asked',
        source: FLAG.source,
      }),
      fromEnv: await claim(machine({}, SUDO_NEGATIVE, SUDO_BIN), ENV),
    }).toEqual({
      sameLogin:
        "An agent running as this login could answer a gate through the terminal or by editing Realm's files; Realm records how each answer arrived but cannot stop it.",
      store:
        "An agent running as this login could answer a gate through the terminal or by editing Realm's files; Realm records how each answer arrived but cannot stop it.",
      become: `${MAY} becoming Realm's service user is not measured "no".`,
      docker: `${MAY} the Docker engine is not measured out of reach.`,
      trustRoot: `${MAY} the files Realm executes are not measured out of reach.`,
      asked: `${MAY} the gate-answers value: give it on this command line, and read the running server's start line.`,
      fromEnv: `${MAY} the gate-answers value: give it on this command line, and read the running server's start line.`,
    });
  });

  it('the value line (F36): withheld measured only from this command line; from the env, configured not enforced; asked and offered keep an answer way', async () => {
    const line = async (value: { value: GateAnswers; source: Source }) =>
      valueLine(await measure(machine(), value));
    // (a) red when an env value is called measured, or asked is read as withheld; (b) prints each.
    expect({
      flag: await line(FLAG),
      env: await line(ENV),
      asked: await line({ value: 'asked', source: { kind: 'default', ref: 'the default' } }),
      offered: await line({ value: 'offered', source: { kind: 'flag', ref: '--gate-answers' } }),
    }).toEqual({
      flag: 'The gate-answers value: withheld (measured — given on this command line).',
      env: "The gate-answers value: withheld, configured, not enforced by Realm — from REALM_MCP_GATE_ANSWERS; the running server's value is not read.",
      asked: 'The gate-answers value: asked (from the default) — the agent keeps an answer way.',
      offered:
        'The gate-answers value: offered (from --gate-answers) — the agent keeps an answer way.',
    });
  });

  it('each condition line in its states: measured yes / no, configured not enforced, unknown with its cause ("observed now")', async () => {
    const yes = await measure(
      machine(
        {
          canWrite: (p) => p === `${STORE}/runs` || p === PROJECT,
          run: () => 0,
          connect: async () => true,
        },
        { ...SUDO_NEGATIVE, [`${HOME}/.claude/settings.json`]: '{"sandbox":{"enabled":true}}' },
        [...SUDO_BIN, '/var/run/docker.sock'],
      ),
    );
    const no = await measure(machine({}, SUDO_NEGATIVE, SUDO_BIN));
    const configured = await measure(
      machine(
        {},
        { ...SUDO_NEGATIVE, '/etc/pam.d/sudo': 'auth sufficient pam_tid.so\n' },
        SUDO_BIN,
      ),
    );
    const unknown = await measure(machine({ exists: () => false }));
    // (a) red per line when a state word is wrong; (b) prints the lines.
    expect({
      store: [
        conditionLine('store_reach', yes),
        conditionLine('store_reach', no),
        conditionLine('store_reach', unknown),
      ],
      become: [
        conditionLine('become_service_user', yes),
        conditionLine('become_service_user', no),
        conditionLine('become_service_user', configured),
      ],
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
        `This login can write Realm's store or open its files: unknown (there is no store at ${STORE}; observed now).`,
      ],
      become: [
        "This login can become Realm's service user (realm) without a password: yes (measured) — sudo -n -u realm true succeeded.",
        "This login can become Realm's service user (realm) without a password: no (measured) — sudo -n -u realm true failed; no Touch ID; timestamp_timeout=0.",
        "This login can become Realm's service user (realm) without a password: configured, not enforced by Realm — Touch ID can approve sudo (/etc/pam.d/sudo).",
      ],
      docker: [
        'This login can reach the Docker engine: yes (measured) — the Docker engine accepted a connection at /var/run/docker.sock.',
        'This login can reach the Docker engine: no (measured).',
      ],
      trustRoot: [
        `This login can change files Realm executes (realm.yaml, extension modules, tool-server commands): yes (measured) — ${PROJECT}/realm.yaml can be changed.`,
        'This login can change files Realm executes (realm.yaml, extension modules, tool-server commands): no (measured) — 1 file checked.',
        'This login can change files Realm executes (realm.yaml, extension modules, tool-server commands): unknown (no realm.yaml was found to check: pass --project with the deployment root; observed now).',
      ],
      sandbox: [
        "The agent's app runs it in a sandbox: configured, not enforced by Realm — Claude Code (~/.claude/settings.json).",
        "The agent's app runs it in a sandbox: no (measured).",
      ],
    });
  });

  it('condition 2: unknown with the sudoers file unreadable; unknown naming doas when present; sudo -n alone never decides', async () => {
    const unreadable = await measure(
      machine(
        {},
        {
          '/etc/pam.d/sudo': 'auth required pam_unix.so\n',
          [`${PROJECT}/realm.yaml`]: 'version: 1\n',
        },
        SUDO_BIN,
      ),
    );
    const doas = await measure(machine({}, SUDO_NEGATIVE, [...SUDO_BIN, '/usr/bin/doas']));
    // (a) red when a failed `sudo -n` alone reads "no"; (b) prints both lines.
    expect([
      conditionLine('become_service_user', unreadable),
      conditionLine('become_service_user', doas),
    ]).toEqual([
      "This login can become Realm's service user (realm) without a password: unknown (the sudoers file is not readable by this login; observed now).",
      "This login can become Realm's service user (realm) without a password: unknown (not probed: doas is on this host; observed now).",
    ]);
  });

  it('the whole output: the header names the mode and the claim, the login measured, condition 5 "observed now", conditions 6–8, and the value line', async () => {
    const lines = renderSeparation(await measure(machine({}, SUDO_NEGATIVE, SUDO_BIN)));
    // (a) red when the login is omitted, condition 5 says "none", or a condition line is dropped;
    //     (b) prints the lines.
    expect(lines).toEqual([
      "Separation: separate user — An agent running as agent cannot record a gate answer through this server, the terminal or Realm's files, provided no program Realm runs as realm can run code for it and every Realm server on this machine starts with `--gate-answers withheld`.",
      `Measured for the login 'agent', against the store at ${STORE}.`,
      "  This login can write Realm's store or open its files: no (measured).",
      "  This login can become Realm's service user (realm) without a password: no (measured) — sudo -n -u realm true failed; no Touch ID; timestamp_timeout=0.",
      '  This login can reach the Docker engine: no (measured).',
      '  This login can change files Realm executes (realm.yaml, extension modules, tool-server commands): no (measured) — 1 file checked.',
      '  Another Realm server or CLI that takes answers uses this store: unknown (another Realm server or CLI could use this store, and one look cannot rule it out; observed now).',
      "  The store's time basis: this machine's clock (the JSON store keeps no clock of its own).",
      "  The agent's app runs it in a sandbox: no (measured).",
      '  This login can change runner.cache.economics (informational): no runner.cache.economics is set.',
      '  The gate-answers value: withheld (measured — given on this command line).',
    ]);
  });

  it('run as the store’s owner, the check says so: it measured the wrong login if that is Realm’s service user', async () => {
    const lines = renderSeparation(await measure(machine({ ownerOf: () => 1000 })));
    // (a) red when the owner's run is not flagged; (b) prints the login line.
    expect(lines[1]).toBe(
      `Measured for the login 'agent', against the store at ${STORE}. This login owns the store: if it is Realm's service user, run the check from the agent's own shell instead.`,
    );
  });
});
