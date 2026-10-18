// separation-790.test.ts — #790 (02): the switch-path readers on captured fixtures (D2 §5): one cell
// per row of D2 §2's table and per cell 01b adds, the spy after every cell (D1: each argv a reader
// asked matches one of rail 1's shapes, element by element), the one spawn site (S2) and the runner's
// own refusal (S3). No real tool runs here: every machine's runner answers from captured fixtures.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure:
// readings, outcomes, booleans and a captured fixture's own line — never an environment, a key file's
// contents, an environment variable's value, or a real login or host name.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { switchClausesOf, switchPathsCondition, type SwitchPathReading } from '@sensigo/realm';
import {
  lookups,
  measureSwitchPaths,
  rootEngineReach,
  ROOT_GROUPS,
  systemRunner,
} from './index.js';
import { scanPam } from './pam.js';
import { parseListing } from './sudo.js';
import { railOne } from './runner.js';
import {
  conditionLine,
  separationClaim,
  switchPathEntry,
  switchPathsReading,
  type CheckEvidence,
} from '../separation-check.js';
import type { ConditionReading } from '@sensigo/realm';
import {
  asked,
  capture,
  fixtureFile,
  fixtureMachine,
  type MachineSpec,
} from '../../test-support/separation-fixtures.js';

const U24 = 'ubuntu-24.04';
const U25 = 'ubuntu-25.10';
const DEB = 'debian-stable';
const FED = 'fedora-latest';
const ALP = 'alpine-latest';
const MAC = 'macos-published';
const GETENT = '/usr/bin/getent';

/** 01 rail 1, written out here on its own (not the runner's list): each shape, element by element. */
function railOneShape(a: readonly string[]): boolean {
  const abs = (p: string | undefined): p is string => p !== undefined && /^\/\S+$/.test(p);
  const named = (p: string | undefined, ...names: string[]): boolean =>
    abs(p) && names.includes(p.slice(p.lastIndexOf('/') + 1));
  const word = (w: string | undefined): boolean => w !== undefined && /^[\w.@+-]+$/.test(w);
  if (a.length === 2 && named(a[0], 'sudo', 'sudo.ws', 'sudo-rs') && a[1] === '-V') return true;
  if (
    a.length === 4 &&
    a[0] === 'LC_ALL=C' &&
    named(a[1], 'sudo', 'sudo.ws', 'sudo-rs') &&
    a[2] === '-n' &&
    (a[3] === '-l' || a[3] === '-ll')
  )
    return true;
  if (
    a.length >= 6 &&
    named(a[0], 'doas') &&
    a[1] === '-C' &&
    abs(a[2]) &&
    a[3] === '-u' &&
    word(a[4]) &&
    !a[5]!.startsWith('-')
  )
    return true;
  if (
    a.length === 5 &&
    named(a[0], 'pkcheck') &&
    a[1] === '--action-id' &&
    word(a[2]) &&
    a[3] === '--process' &&
    /^\d+$/.test(a[4]!)
  )
    return true;
  if (
    a.length === 3 &&
    named(a[0], 'getent') &&
    ['passwd', 'group', 'netgroup'].includes(a[1]!) &&
    word(a[2])
  )
    return true;
  return (
    a.length === 5 &&
    named(a[0], 'dscl') &&
    a[1] === '.' &&
    a[2] === '-read' &&
    /^\/Users\/[\w.@+-]+$/.test(a[3]!) &&
    a[4] === 'UserShell'
  );
}

afterEach(() => {
  const off = asked.filter((a) => !railOneShape(a)).map((a) => a.join(' '));
  asked.length = 0;
  // The spy (02, D1; S1). (a) red when a reader asks anything that is not one of rail 1's calls — S1's
  // break: the sudo reader also asks `<sudo> -n true`; (b) prints the argv that is not.
  expect(off).toEqual([]);
});

/** Two specs, merged: the maps joined, the rest the second's. */
function merge(a: MachineSpec, b: MachineSpec): MachineSpec {
  return {
    ...a,
    ...b,
    files: { ...a.files, ...b.files },
    dirs: { ...a.dirs, ...b.dirs },
    programs: { ...a.programs, ...b.programs },
    links: { ...a.links, ...b.links },
    calls: { ...a.calls, ...b.calls },
    sockets: { ...a.sockets, ...b.sockets },
    unreadable: [...(a.unreadable ?? []), ...(b.unreadable ?? [])],
  };
}

const PAM: Record<string, string[]> = {
  [U24]: [
    'sudo',
    'sudo-i',
    'su',
    'su-l',
    'common-auth',
    'common-account',
    'common-session',
    'common-session-noninteractive',
    'other',
  ],
  [U25]: [
    'sudo',
    'sudo-i',
    'su',
    'su-l',
    'common-auth',
    'common-account',
    'common-session',
    'common-session-noninteractive',
    'other',
  ],
  [DEB]: [
    'sudo',
    'sudo-i',
    'su',
    'su-l',
    'common-auth',
    'common-account',
    'common-session',
    'common-session-noninteractive',
    'other',
  ],
  [FED]: ['sudo', 'sudo-i', 'su', 'su-l', 'system-auth', 'postlogin', 'other'],
};

/** Whether a fixture was captured (some images hold a lookup others do not). */
const captured = (name: string): boolean =>
  existsSync(new URL(`./fixtures/${name}.txt`, import.meta.url));

/** A Linux image's machine: its getent, its passwd entries for svc, root and nobody (a run-as a
 *  listing names, compared by uid), its PAM files. */
function linux(img: string, over: MachineSpec = {}): MachineSpec {
  return merge(
    {
      programs: { [GETENT]: 0 },
      calls: {
        [`${GETENT} passwd svc`]: `${img}/getent.passwd.svc`,
        [`${GETENT} passwd root`]: `${img}/getent.passwd.root`,
        ...(captured(`${img}/getent.passwd.nobody`)
          ? { [`${GETENT} passwd nobody`]: `${img}/getent.passwd.nobody` }
          : {}),
      },
      files: Object.fromEntries(
        (PAM[img] ?? []).map((n) => [`/etc/pam.d/${n}`, { fixture: `${img}/pam.${n}` }]),
      ),
    },
    over,
  );
}

/** The sudos of a rule set: Ubuntu 25.10's sudo-rs (as /usr/bin/sudo) and sudo.ws, or a classic
 *  image's /usr/bin/sudo — each answering `-V` and the listing from that set's captures. */
function sudos(img: string, set: string, which: ('sudo-rs' | 'sudo.ws' | 'sudo')[]): MachineSpec {
  const spec: MachineSpec = { programs: {}, calls: {}, links: {} };
  for (const w of which) {
    if (w === 'sudo-rs') {
      spec.programs!['/usr/bin/sudo'] = 0;
      spec.programs!['/usr/lib/cargo/bin/sudo'] = 0;
      spec.links!['/usr/bin/sudo'] = '/usr/lib/cargo/bin/sudo';
      spec.calls!['/usr/bin/sudo -V'] = `${img}/version.sudo-rs`;
      spec.calls!['LC_ALL=C /usr/bin/sudo -n -l'] = `${img}/${set}.sudo-rs.l`;
    } else {
      const path = `/usr/bin/${w}`;
      spec.programs![path] = 0;
      spec.calls![`${path} -V`] = `${img}/version.${w}`;
      spec.calls![`LC_ALL=C ${path} -n -l`] = `${img}/${set}.${w}.l`;
      spec.calls![`LC_ALL=C ${path} -n -ll`] = `${img}/${set}.${w}.ll`;
    }
  }
  return spec;
}

/** su at /usr/bin/su, with svc's passwd entry from `entry` and the shells file. */
const su = (img: string, entry = 'getent.passwd.svc', shells = 'shells'): MachineSpec => ({
  programs: { '/usr/bin/su': 0 },
  calls: { [`${GETENT} passwd svc`]: `${img}/${entry}` },
  files: { '/etc/shells': { fixture: `${img}/${shells}` } },
});

const paths = (spec: MachineSpec, svc = 'svc') =>
  measureSwitchPaths({ probes: fixtureMachine(spec), svc });

/** A reading, compact: path, outcome, whose, cache, and classic sudo's "or not allowed". */
const view = (rs: SwitchPathReading[]): string[] =>
  rs.map((r) =>
    [r.path, r.outcome, r.whose, r.cache, r.or_not_allowed === true ? 'or not allowed' : undefined]
      .filter((x) => x !== undefined)
      .join(' '),
  );
const clauses = (rs: SwitchPathReading[]): string[] =>
  switchClausesOf(rs).map((c) => (c.clause === 'a' ? `a:${c.whose}` : c.clause));

describe('#790 — sudo, the listing and the refusals (D2, D3, D4, D5)', () => {
  it('classic sudo refused "a password is required" → needs this login\'s password or not allowed; clauses (a), (b), (c)', async () => {
    const rs = await paths(linux(U24, sudos(U24, 'password', ['sudo'])));
    // (a) red when the refusal drops its cache (b) or its "or not allowed" (c), or reads only this
    //     login's password where its Defaults cannot be seen (A §F4); (b) prints readings and
    //     clauses.
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: [
        'sudo needs_credential this_login sudo_timestamp or not allowed',
        'sudo needs_credential root sudo_timestamp',
        'sudo needs_credential svc sudo_timestamp',
      ],
      clauses: ['a:this_login', 'a:svc', 'a:root', 'b', 'c'],
    });
  });

  it('sudo-rs "Sorry, user agent may not run sudo on h." → not allowed', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'none', ['sudo-rs'])));
    // (a) red when the refusal is read as unknown; (b) prints the readings.
    expect(view(rs)).toEqual(['sudo not_allowed']);
  });

  it('sudo-rs "interactive authentication is required" → needs this login\'s password (a rule exists)', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'password', ['sudo-rs'])));
    // (a) red when it is read as not allowed, or reads only this login's password (A §F4); (b)
    //     prints readings and clauses.
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: [
        'sudo needs_credential this_login sudo_timestamp',
        'sudo needs_credential root sudo_timestamp',
        'sudo needs_credential svc sudo_timestamp',
      ],
      clauses: ['a:this_login', 'a:svc', 'a:root', 'b'],
    });
  });

  it('`(svc) NOPASSWD: /usr/bin/realm` listed → yes, for sudo-rs and sudo.ws (any command counts)', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'cmd-svc', ['sudo-rs', 'sudo.ws'])));
    // (a) red when a NOPASSWD rule counts only for ALL (the realm-limited rule read as "cannot");
    //     (b) prints the readings.
    expect(view(rs)).toEqual(['sudo yes', 'sudo yes']);
  });

  it('a listing with no NOPASSWD entry (a cached credential) → yes, listed without a password', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'cached', ['sudo-rs', 'sudo.ws'])));
    // (a) red when such a listing reads "needs a credential"; (b) prints readings and whether each
    //     says why.
    expect({
      readings: view(rs),
      said: rs.map((r) => r.how.endsWith('listed without a password (the cause is not known)')),
    }).toEqual({ readings: ['sudo yes', 'sudo yes'], said: [true, true] });
  });

  it('`Defaults!/usr/bin/realm !authenticate` shown in a listing → yes (sudo.ws); sudo-rs, which ignores it, needs the password', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'auth-cmd', ['sudo-rs', 'sudo.ws'])));
    // (a) red when the command-specific line is ignored; (b) prints readings and sudo.ws's how.
    expect({ readings: view(rs), how: rs.find((r) => r.tool === '/usr/bin/sudo.ws')?.how }).toEqual(
      {
        readings: [
          'sudo needs_credential this_login sudo_timestamp',
          'sudo needs_credential root sudo_timestamp',
          'sudo needs_credential svc sudo_timestamp',
          'sudo yes',
        ],
        how: 'LC_ALL=C /usr/bin/sudo.ws -n -l and -n -ll: Defaults!/usr/bin/realm !authenticate covers a rule',
      },
    );
  });

  it('`Defaults>svc !authenticate` (a runas line) → yes', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'auth-runas', ['sudo.ws'])));
    // (a) red when a runas-specific line is not read; (b) prints the readings.
    expect(view(rs)).toEqual(['sudo yes']);
  });

  it("`rootpw` in Matching Defaults → needs root's password; the clause names root", async () => {
    const rs = await paths(linux(U25, sudos(U25, 'rootpw', ['sudo.ws'])));
    // (a) red when rootpw is ignored (this login's), or its ticket drops clause (b) (A §F5); (b)
    //     prints readings and clauses.
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: ['sudo needs_credential root sudo_timestamp'],
      clauses: ['a:root', 'b'],
    });
  });

  it("`targetpw` → needs svc's password", async () => {
    const rs = await paths(linux(U25, sudos(U25, 'targetpw', ['sudo.ws'])));
    // (a) red when targetpw is ignored; (b) prints the readings.
    expect(view(rs)).toEqual(['sudo needs_credential svc sudo_timestamp']);
  });

  it('01b #13: sudo and sudo.ws both present, only sudo.ws lists NOPASSWD → yes (two rule sets combined)', async () => {
    const rs = await paths(
      linux(
        U25,
        merge(sudos(U25, 'password', ['sudo-rs']), sudos(U25, 'nopasswd-all', ['sudo.ws'])),
      ),
    );
    // (a) red when only the first sudo is asked; (b) prints the readings and the condition.
    expect({
      readings: view(rs),
      condition: switchPathsCondition(rs, () => '', 'here').basis,
      yes: rs.some((r) => r.outcome === 'yes'),
    }).toEqual({
      readings: [
        'sudo needs_credential this_login sudo_timestamp',
        'sudo needs_credential root sudo_timestamp',
        'sudo needs_credential svc sudo_timestamp',
        'sudo yes',
      ],
      condition: 'measured',
      yes: true,
    });
  });

  // A §F16: this cell covers the parser only — no shipped path reads a wrapped short listing (classic
  // sudo is read from -ll; sudo-rs writes each entry on one line).
  it("a wrapped listing is read whole (D2): the short format's continuation lines give what the long format lists", () => {
    const entries = (fixture: string) => {
      const l = parseListing((capture(fixture) as { stdout: string }).stdout);
      return 'unknown' in l
        ? l.unknown
        : l.entries.flatMap((e) =>
            e.commands.map(
              (c) => `${e.users.join(',')} ${e.nopasswd ? 'NOPASSWD' : 'PASSWD'} ${c}`,
            ),
          );
    };
    const short = entries(`${U24}/wrapped.sudo.l`);
    // (a) red when a continuation line is not joined (its commands, or the PASSWD tag that ends the
    //     line before, lost); (b) prints both formats' entries.
    expect({ count: Array.isArray(short) ? short.length : short, same: short }).toEqual({
      count: 15,
      same: entries(`${U24}/wrapped.sudo.ll`),
    });
  });

  it("runas shapes: a group-only runas onto svc's group, %group, %#gid, #uid, +netgroup, a negation and an alias each cover svc", async () => {
    const shape = (set: string) =>
      paths(
        linux(
          U25,
          merge(sudos(U25, set, ['sudo.ws']), {
            calls: {
              [`${GETENT} group svcgrp`]: `${U25}/getent.group.svcgrp`,
              [`${GETENT} netgroup svcnet`]: `${U25}/getent.netgroup.svcnet`,
              // A §F7: `%#gid` is looked up by gid
              [`${GETENT} group 1100`]: `${U25}/getent.group.1100`,
            },
          }),
        ),
      ).then(view);
    // (a) red per shape when it is read as not covering svc; (b) prints each shape's readings.
    expect({
      groupOnly: await shape('group-only'),
      pctGroup: await shape('pct-group'),
      pctGid: await shape('pct-gid'),
      hashUid: await shape('hash-uid'),
      netgroup: await shape('netgroup'),
      negated: await shape('negated'),
      negatedOnly: await shape('negated-only'),
      alias: await shape('runas-alias'),
      defaultRunas: await shape('default-runas'),
    }).toEqual({
      groupOnly: ['sudo yes'],
      pctGroup: ['sudo yes'],
      pctGid: ['sudo yes'],
      hashUid: ['sudo yes'],
      netgroup: ['sudo yes'],
      negated: ['sudo yes'],
      // `(nobody, !svc)`: the negation alone covers (the safe direction); nobody does not.
      negatedOnly: ['sudo yes'],
      alias: ['sudo yes'],
      defaultRunas: ['sudo yes'],
    });
  });

  it('sudo-rs lists a runas alias unexpanded → read as covering (the safe direction)', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'runas-alias', ['sudo-rs'])));
    // (a) red when an unexpanded alias is read as another user's name; (b) prints the readings.
    expect(view(rs)).toEqual(['sudo yes']);
  });

  it("sudo's PAM has a person module (pam_u2f, D5's class with pam_tid and pam_fprintd) → a person's touch or key; clause (e)", async () => {
    const rs = await paths(
      linux(
        U24,
        merge(sudos(U24, 'password', ['sudo']), {
          files: { '/etc/pam.d/sudo': { fixture: `${U24}/variant.sudo-u2f` } },
        }),
      ),
    );
    // (a) red when the person module is not read (this login's password alone, no (e)); (b) prints
    //     readings and clauses.
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: [
        'sudo needs_credential this_login sudo_timestamp or not allowed',
        'sudo needs_credential root sudo_timestamp',
        'sudo needs_credential svc sudo_timestamp',
        'sudo needs_credential person',
      ],
      clauses: ['a:this_login', 'a:svc', 'a:root', 'b', 'c', 'e'],
    });
  });

  it("Fedora's authselect sssd profile with faillock and fingerprint → its guards and faillock lines read, pam_fprintd a person's touch", async () => {
    const rs = await paths(
      linux(
        FED,
        merge(sudos(FED, 'password', ['sudo']), {
          files: {
            '/etc/pam.d/system-auth': {
              fixture: `${FED}/pam.system-auth.sssd-faillock-fingerprint`,
            },
          },
        }),
      ),
    );
    // (a) red when Fedora's guard brackets or faillock lines read unknown, or pam_fprintd is not a
    //     person; (b) prints the readings.
    expect(view(rs)).toEqual([
      'sudo needs_credential this_login sudo_timestamp or not allowed',
      'sudo needs_credential root sudo_timestamp',
      'sudo needs_credential svc sudo_timestamp',
      'sudo needs_credential person',
    ]);
  });

  it('01b #9: macOS — a sudo rule whose runas is a group → unknown (no getent there)', async () => {
    // Classic sudo's answers (Ubuntu 25.10's sudo.ws captures, as macOS ships classic sudo).
    const rs = await paths({
      platform: 'darwin',
      programs: { '/usr/bin/sudo': 0 },
      calls: {
        '/usr/bin/sudo -V': `${U25}/version.sudo.ws`,
        'LC_ALL=C /usr/bin/sudo -n -l': `${U25}/pct-group.sudo.ws.l`,
        'LC_ALL=C /usr/bin/sudo -n -ll': `${U25}/pct-group.sudo.ws.ll`,
      },
    });
    // (a) red when the group is read as covering or not without its members; (b) prints readings
    //     and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['sudo unknown'],
      cause: "macOS has no getent, so this user's entry is not read",
    });
  });

  it('01b #9: macOS — a pam_wheel trust line → unknown', async () => {
    // #819 (08, B F5): su on a Mac now stops at svc's unread shell (no dscl answer is captured), so
    // the pam_wheel line of the Ubuntu 24.04 capture is read where sudo reads it: put first in
    // Ubuntu 24.04's sudo stack, on darwin (Apple's own stack stops at its sudo_local include).
    const wheel = fixtureFile(`${U24}/variant.su-l-wheel-trust`).split('\n')[0]!;
    const rs = await paths(
      linux(
        U24,
        merge(sudos(U24, 'password', ['sudo']), {
          platform: 'darwin',
          files: { '/etc/pam.d/sudo': `${wheel}\n${fixtureFile(`${U24}/pam.sudo`)}` },
        }),
      ),
    );
    // (a) red when pam_wheel's group is read on macOS; (b) prints readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['sudo unknown'],
      cause:
        "auth sufficient pam_wheel.so trust use_uid: macOS has no getent, so pam_wheel's group is not read",
    });
  });

  it("macOS as shipped: Apple's sudo stack includes sudo_local, which does not exist → unknown", async () => {
    const rs = await paths(
      merge(sudos(U24, 'password', ['sudo']), {
        platform: 'darwin',
        files: { '/etc/pam.d/sudo': { fixture: `${MAC}/pam.sudo` } },
      }),
    );
    // (a) red when an include that does not resolve is skipped; (b) prints readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['sudo unknown'],
      cause: 'the PAM file for sudo_local was not found',
    });
  });

  it("sudo's PAM has pam_ssh_agent_auth → unknown", async () => {
    const rs = await paths(
      linux(
        U24,
        merge(sudos(U24, 'password', ['sudo']), {
          files: { '/etc/pam.d/sudo': { fixture: `${U24}/variant.sudo-ssh-agent` } },
        }),
      ),
    );
    // (a) red when the ssh-agent module is read as a password; (b) prints readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['sudo unknown'],
      cause: "sudo accepts an ssh agent's key",
    });
  });

  it("macOS: Apple's published sudo stack, Touch ID turned on in sudo_local → unknown (pam_smartcard is not on D7's list)", async () => {
    // The sudo answers are Ubuntu 24.04's captures (classic sudo, as macOS ships); the stack is
    // Apple's published files, sudo_local made from its template as the template says.
    const rs = await paths(
      merge(sudos(U24, 'password', ['sudo']), {
        platform: 'darwin',
        files: {
          '/etc/pam.d/sudo': { fixture: `${MAC}/pam.sudo` },
          '/etc/pam.d/sudo_local': fixtureFile(`${MAC}/pam.sudo_local.template`).replace(
            '#auth',
            'auth',
          ),
        },
      }),
    );
    // (a) red when an unrecognised line is skipped (the stack then reads a person's touch); (b)
    //     prints readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['sudo unknown'],
      cause:
        "sudo's PAM stack has a line this check does not read: auth sufficient pam_smartcard.so",
    });
  });

  it('NoNewPrivs 1 and sudo\'s message → unknown, "run the check outside the sandbox" (classic and sudo-rs)', async () => {
    // The file's line as the process read it, captured under setpriv --no-new-privs.
    const status = {
      '/proc/self/status': (capture(`${U24}/proc.status.nnp`) as { stdout: string }).stdout,
    };
    const classic = await paths(linux(U24, merge(sudos(U24, 'nnp', ['sudo']), { files: status })));
    const rs = await paths(linux(U25, merge(sudos(U25, 'nnp', ['sudo-rs']), { files: status })));
    // (a) red when the no-new-privileges flag is not read; (b) prints readings and causes.
    expect({
      readings: [...view(classic), ...view(rs)],
      causes: [classic[0]?.cause, rs[0]?.cause],
    }).toEqual({
      readings: ['sudo unknown', 'sudo unknown'],
      causes: [
        'run the check outside the sandbox: the "no new privileges" flag is set',
        'run the check outside the sandbox: the "no new privileges" flag is set',
      ],
    });
  });

  it('a refusal this check does not recognise ("you must have a tty") → unknown, with sudo\'s line', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'requiretty', ['sudo.ws'])));
    // (a) red when an unknown refusal reads not allowed; (b) prints readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['sudo unknown'],
      cause: 'LC_ALL=C /usr/bin/sudo.ws -n -l says: sudo: sorry, you must have a tty to run sudo',
    });
  });

  it("01b #8: a sudo found only under the login's home → unknown, never asked", async () => {
    const rs = await paths({
      env: { PATH: '/home/agent/.local/bin:/usr/bin' },
      programs: { [GETENT]: 0, '/home/agent/.local/bin/sudo': 1001 },
      calls: {
        [`${GETENT} passwd svc`]: `${U24}/getent.passwd.svc`,
        [`${GETENT} passwd root`]: `${U24}/getent.passwd.root`,
      },
    });
    // (a) red when that copy is asked; (b) prints readings, cause and whether any sudo was asked.
    expect({
      readings: view(rs),
      cause: rs[0]?.cause,
      asked: asked.some((a) => a.some((w) => w.endsWith('/sudo'))),
    }).toEqual({
      readings: ['sudo unknown'],
      cause: 'sudo at /home/agent/.local/bin/sudo is not a root-owned system copy',
      asked: false,
    });
  });

  it('01b #6: one sudo needs a credential and another reads unknown → condition 2 is unknown', async () => {
    const rs = await paths(
      linux(U25, merge(sudos(U25, 'password', ['sudo-rs']), sudos(U25, 'requiretty', ['sudo.ws']))),
    );
    // (a) red when the credential outranks the unknown; (b) prints readings and the condition's basis.
    expect({ readings: view(rs), basis: switchPathsCondition(rs, () => '', 'here').basis }).toEqual(
      {
        readings: [
          'sudo needs_credential this_login sudo_timestamp',
          'sudo needs_credential root sudo_timestamp',
          'sudo needs_credential svc sudo_timestamp',
          'sudo unknown',
        ],
        basis: 'unknown',
      },
    );
  });
});

describe('#790 — su, never run (D6, D7, 01b #11, #14)', () => {
  it("svc's shell /usr/sbin/nologin, in neither shells file → not allowed; no svc-password clause", async () => {
    const rs = await paths(linux(U24, su(U24)));
    // (a) red when a no-command shell goes on to the PAM scan; (b) prints readings and clauses.
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: ['su not_allowed'],
      clauses: [],
    });
  });

  it('nologin and an empty password field in /etc/passwd → not allowed ((c) before (b))', async () => {
    const rs = await paths(linux(U24, su(U24, 'getent.passwd.svc.empty-pw-nologin')));
    // (a) red when the empty field is read before the shell (yes); (b) prints the readings.
    expect(view(rs)).toEqual(['su not_allowed']);
  });

  it('an empty password field and a shell that runs commands → yes', async () => {
    const rs = await paths(linux(U24, su(U24, 'getent.passwd.svc.empty-pw-sh')));
    // (a) red when the inline empty password is not read; (b) prints the readings.
    expect(view(rs)).toEqual(['su yes']);
  });

  it("the real Ubuntu 24.04, Debian and Fedora su stacks → needs svc's password; macOS's, with svc's shell not read, → unknown (B F5)", async () => {
    // macOS: no dscl answer is captured (04 item 4), so the shell is not read — #819 (08, B F5): and su
    // reads unknown there, as B §9 reads it on Linux (never "needs svc's password").
    const mac = await paths({
      platform: 'darwin',
      programs: { '/usr/bin/su': 0 },
      files: { '/etc/pam.d/su': { fixture: `${MAC}/pam.su` } },
    });
    // (a) red when any stack reads otherwise (a password module not counted, a non-auth line read as
    //     unrecognised); (b) prints each image's readings.
    expect({
      [U24]: view(await paths(linux(U24, su(U24, 'getent.passwd.svc.bash')))),
      [DEB]: view(await paths(linux(DEB, su(DEB, 'getent.passwd.svc.bash')))),
      [FED]: view(await paths(linux(FED, su(FED, 'getent.passwd.svc.bash')))),
      macos: view(mac),
    }).toEqual({
      [U24]: ['su needs_credential svc'],
      [DEB]: ['su needs_credential svc'],
      [FED]: ['su needs_credential svc'],
      macos: ['su unknown'],
    });
  });

  it('01b #7: a real stack with account, password and session lines → those lines are skipped, never "not recognised"', async () => {
    const lk = lookups(fixtureMachine(linux(U24)), 'svc');
    const scan = await scanPam(lk, 'su');
    // (a) red when a non-auth line is read as unrecognised; (b) prints the scan.
    expect(scan).toEqual({
      password: true,
      person: false,
      sshAgent: false,
      files: [
        '/etc/pam.d/su',
        '/etc/pam.d/common-auth',
        '/etc/pam.d/common-account',
        '/etc/pam.d/common-session',
      ],
    });
  });

  it('the pam_succeed_if recipe in su → unknown, naming the line', async () => {
    const rs = await paths(
      linux(
        U24,
        merge(su(U24, 'getent.passwd.svc.bash'), {
          files: { '/etc/pam.d/su': { fixture: `${U24}/variant.su-succeed-if` } },
        }),
      ),
    );
    // (a) red when the line is skipped (needs a credential); (b) prints readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['su unknown'],
      cause:
        "su's PAM stack has a line this check does not read: auth sufficient pam_succeed_if.so use_uid user = agent",
    });
  });

  it('01b #11: su-l carries `pam_wheel.so trust use_uid`, the login is in wheel, su is plain → yes', async () => {
    const rs = await paths(
      linux(
        U24,
        merge(su(U24, 'getent.passwd.svc.bash'), {
          files: { '/etc/pam.d/su-l': { fixture: `${U24}/variant.su-l-wheel-trust` } },
          calls: { [`${GETENT} group wheel`]: `${U24}/getent.group.wheel` },
        }),
      ),
    );
    // (a) red when su-l is not scanned; (b) prints the readings.
    expect(view(rs)).toEqual(['su yes']);
  });

  it("svc's shell /usr/local/bin/bash, in neither shells file → the PAM scan; the svc-password clause", async () => {
    const rs = await paths(linux(U24, su(U24, 'getent.passwd.svc.local-bash')));
    // (a) red when any shell missing from the shells files reads "runs no command"; (b) prints
    //     readings and clauses.
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: ['su needs_credential svc'],
      clauses: ['a:svc'],
    });
  });

  it("svc's shell /usr/sbin/nologin listed in /etc/shells → the PAM scan", async () => {
    const rs = await paths(linux(U24, su(U24, 'getent.passwd.svc', 'shells.with-nologin')));
    // (a) red when the shells file is not read; (b) prints the readings.
    expect(view(rs)).toEqual(['su needs_credential svc']);
  });

  it("BusyBox su (Alpine, no PAM stack) → needs svc's password, whatever svc's shell (B §11)", async () => {
    const alpine = (entry: string) =>
      paths({
        programs: { [GETENT]: 0, '/bin/su': 0, '/bin/busybox': 0 },
        links: { '/bin/su': '/bin/busybox' },
        calls: {
          [`${GETENT} passwd svc`]: `${ALP}/${entry}`,
          [`${GETENT} passwd root`]: `${ALP}/getent.passwd.root`,
        },
        files: { '/etc/shells': { fixture: `${ALP}/shells` } },
      }).then(view);
    // (a) red when BusyBox's su is read through a PAM stack it does not have (unknown); (b) prints both.
    expect({
      sh: await alpine('getent.passwd.svc.sh'),
      nologin: await alpine('getent.passwd.svc'),
    }).toEqual({
      sh: ['su needs_credential svc'],
      // B §11: BusyBox keeps a restricted shell only under a build option this check cannot see
      nologin: ['su needs_credential svc'],
    });
  });

  it('01b #14: su found only elsewhere on PATH → unknown; found nowhere → not listed', async () => {
    const elsewhere = await paths({
      env: { PATH: '/opt/tools/bin:/usr/bin' },
      programs: { [GETENT]: 0, '/opt/tools/bin/su': 0 },
      calls: {
        [`${GETENT} passwd svc`]: `${U24}/getent.passwd.svc`,
        [`${GETENT} passwd root`]: `${U24}/getent.passwd.root`,
      },
    });
    const nowhere = await paths(linux(U24));
    // (a) red when an su elsewhere on PATH is read as absent; (b) prints both machines' readings.
    expect({ elsewhere: view(elsewhere), nowhere: view(nowhere) }).toEqual({
      elsewhere: ['su unknown'],
      nowhere: [],
    });
  });
});

describe('#790 — doas (D8)', () => {
  const doasFiles = (realm?: string): MachineSpec => ({
    programs: { [GETENT]: 0, '/usr/bin/doas': 0 },
    calls: {
      [`${GETENT} passwd svc`]: `${ALP}/getent.passwd.svc`,
      [`${GETENT} passwd root`]: `${ALP}/getent.passwd.root`,
    },
    files: {
      '/etc/doas.conf': { fixture: `${ALP}/doas.conf.stock` },
      ...(realm !== undefined
        ? { '/etc/doas.d/realm.conf': { fixture: `${ALP}/doas7.${realm}.realm.conf` } }
        : {}),
    },
    dirs: { '/etc/doas.d': realm !== undefined ? ['realm.conf'] : [] },
  });
  /** B §2: the command no rule can name, and the argument asked after a bare `cmd`. */
  const ANY = '/nonexistent/realm-check-any';
  const ARG = 'realm-check-any-argument';
  /** The captured `doas -C` answers of one rule set: each file × svc and root × each question,
   *  the command no rule can name included. */
  const answers = (set: string, cmds: string[]): MachineSpec => {
    const calls: Record<string, string> = {};
    const key = (c: string) => c.replace(/\//g, '-').replace(/ /g, '_');
    for (const t of ['svc', 'root']) {
      calls[`/usr/bin/doas -C /etc/doas.conf -u ${t} ${ANY}`] =
        `${ALP}/doas7.stock.doas.conf.${t}.${key(ANY)}`;
      for (const c of [...cmds, ANY]) {
        calls[`/usr/bin/doas -C /etc/doas.d/realm.conf -u ${t} ${c}`] =
          `${ALP}/doas7.${set}.realm.conf.${t}.${key(c)}`;
      }
    }
    return { calls };
  };

  it('Alpine as shipped: /etc/doas.conf 0640 → unknown', async () => {
    const rs = await paths({
      programs: { [GETENT]: 0, '/usr/bin/doas': 0 },
      calls: {
        [`${GETENT} passwd svc`]: `${ALP}/getent.passwd.svc`,
        [`${GETENT} passwd root`]: `${ALP}/getent.passwd.root`,
      },
      unreadable: ['/etc/doas.conf'],
      dirs: { '/etc/doas.d': undefined },
    });
    // (a) red when an unreadable file reads as no rules (not allowed); (b) prints readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['doas unknown'],
      cause: "doas's rules cannot be read here (/etc/doas.d)",
    });
  });

  it('`permit nopass agent as svc cmd /usr/bin/realm` readable → yes (the named command is asked)', async () => {
    const rs = await paths(
      merge(
        doasFiles('nopass-cmd'),
        answers('nopass-cmd', ['/usr/bin/realm', `/usr/bin/realm ${ARG}`]),
      ),
    );
    // (a) red when only an unrestricted command is asked (deny for any other); (b) prints readings.
    expect(view(rs)).toEqual(['doas yes']);
  });

  it('rules only in /etc/doas.d/realm.conf → read from the folder; persist → clause (b)', async () => {
    const rs = await paths(merge(doasFiles('persist'), answers('persist', [])));
    // (a) red when only /etc/doas.conf is read (not allowed); (b) prints readings, clauses and how.
    expect({ readings: view(rs), clauses: clauses(rs), how: rs[0]?.how }).toEqual({
      readings: ['doas needs_credential this_login doas_persist'],
      clauses: ['a:this_login', 'b'],
      how: '/etc/doas.conf and /etc/doas.d/realm.conf read, and /usr/bin/doas -C asked 4 times',
    });
  });

  it('`deny agent` → not allowed; a :wheel rule and a command with args are parsed as doas -C reads them', async () => {
    const deny = await paths(merge(doasFiles('deny'), answers('deny', [])));
    const mixed = await paths(
      merge(merge(doasFiles('mixed'), answers('mixed', ['/usr/bin/realm status'])), {
        calls: { [`${GETENT} group wheel`]: `${ALP}/getent.group.wheel` },
      }),
    );
    // (a) red when the parse and doas -C disagree (an args rule or a group identity misread); (b)
    //     prints both readings.
    expect({ deny: view(deny), mixed: view(mixed) }).toEqual({
      deny: ['doas not_allowed'],
      mixed: ['doas yes'],
    });
  });

  it('B §2: `permit nopass agent as svc` with `deny … cmd /bin/sh` after it → yes (the command no rule can name is asked)', async () => {
    const rs = await paths(
      merge(doasFiles('deny-sh'), answers('deny-sh', ['/bin/sh', `/bin/sh ${ARG}`])),
    );
    // (a) red when the any-command question is a command a rule can name (/bin/sh: deny); (b)
    //     prints the readings.
    expect(view(rs)).toEqual(['doas yes']);
  });

  it('B §2: a command whose deny rule pins no arguments → asked with one argument too → yes', async () => {
    const rs = await paths(
      merge(
        doasFiles('deny-noargs'),
        answers('deny-noargs', ['/usr/bin/realm', `/usr/bin/realm ${ARG}`]),
      ),
    );
    // (a) red when a bare `cmd` is asked without an argument only (deny); (b) prints the readings.
    expect(view(rs)).toEqual(['doas yes']);
  });
});

describe('#790 — polkit (D9, 01b #5)', () => {
  const POLKITD = '/usr/lib/polkit-1/polkitd';
  const policies = (
    systemd1 = 'policy.org.freedesktop.systemd1',
    withExec = true,
  ): MachineSpec => ({
    programs: { '/usr/bin/pkcheck': 0, [POLKITD]: 0 },
    dirs: {
      '/usr/share/polkit-1/actions': [
        ...(withExec ? ['org.freedesktop.policykit.policy'] : []),
        'org.freedesktop.systemd1.policy',
      ],
    },
    files: {
      '/usr/share/polkit-1/actions/org.freedesktop.systemd1.policy': {
        fixture: `${U24}/${systemd1}`,
      },
      ...(withExec
        ? {
            '/usr/share/polkit-1/actions/org.freedesktop.policykit.policy': {
              fixture: `${U24}/policy.org.freedesktop.policykit`,
            },
          }
        : {}),
    },
  });
  const ask = (action: string, fixture: string): Record<string, string> => ({
    [`/usr/bin/pkcheck --action-id ${action} --process 4242`]: `${U24}/${fixture}`,
  });
  const MU = 'org.freedesktop.systemd1.manage-units';
  const RP = 'org.freedesktop.systemd1.reply-password';
  const EX = 'org.freedesktop.policykit.exec';

  it('pkcheck: manage-units 0, exec 2 → yes (manage-units is asked)', async () => {
    const rs = await paths(
      merge(policies(), {
        calls: {
          ...ask(MU, 'pkcheck.rule.org.freedesktop.systemd1.manage-units'),
          ...ask(EX, 'pkcheck.stock.org.freedesktop.policykit.exec'),
          ...ask(RP, 'pkcheck.active-yes.reply-password'),
        },
      }),
    );
    // (a) red when only pkexec's action is asked; (b) prints the readings.
    expect(view(rs)).toEqual(['polkit yes']);
  });

  it("the session rule: manage-units' default allow_active yes, the check's session gets 2 → yes", async () => {
    const rs = await paths(
      merge(policies('policy.systemd1.active-yes', false), {
        calls: {
          ...ask(MU, 'pkcheck.active-yes.manage-units'),
          ...ask(RP, 'pkcheck.active-yes.reply-password'),
        },
      }),
    );
    // (a) red when only pkcheck's answer counts (needs a credential); (b) prints the readings.
    expect(view(rs)).toEqual(['polkit yes']);
  });

  it("stock polkit → needs an administrator's password, kept: clauses (a), (b), (d); every action D9 names is asked", async () => {
    const SH = 'org.freedesktop.machine1.shell';
    const HS = 'org.freedesktop.machine1.host-shell';
    const rs = await paths(
      merge(policies(), {
        dirs: {
          '/usr/share/polkit-1/actions': [
            'org.freedesktop.machine1.policy',
            'org.freedesktop.policykit.policy',
            'org.freedesktop.systemd1.policy',
          ],
        },
        files: {
          '/usr/share/polkit-1/actions/org.freedesktop.machine1.policy': {
            fixture: `${U24}/policy.org.freedesktop.machine1`,
          },
        },
        calls: {
          ...ask(MU, 'pkcheck.stock.org.freedesktop.systemd1.manage-units'),
          ...ask(EX, 'pkcheck.stock.org.freedesktop.policykit.exec'),
          ...ask(RP, 'pkcheck.active-yes.reply-password'),
          ...ask(SH, 'pkcheck.stock.org.freedesktop.machine1.shell'),
          ...ask(HS, 'pkcheck.stock.org.freedesktop.machine1.host-shell'),
        },
      }),
    );
    const actions = asked.filter((a) => a[0] === '/usr/bin/pkcheck').map((a) => a[2]);
    // (a) red when polkit's presence prints no (d), *_keep no (b), or an action D9 names is not
    //     asked (machinectl's shells, pkexec's own programs); (b) prints readings, clauses, actions.
    expect({ readings: view(rs), clauses: clauses(rs), actions }).toEqual({
      // B §4: an exit 2 reads both whose, kept — an unreadable rule may change whose it asks
      readings: [
        'polkit needs_credential administrator polkit_keep',
        'polkit needs_credential this_login polkit_keep',
      ],
      clauses: ['a:this_login', 'a:administrator', 'b', 'd'],
      actions: [SH, HS, EX, RP, MU],
    });
  });

  it('a pkcheck error (no system bus) → unknown, with its line', async () => {
    const rs = await paths(
      merge(policies('policy.org.freedesktop.systemd1', false), {
        calls: {
          ...ask(MU, 'pkcheck.nobus.manage-units'),
          ...ask(RP, 'pkcheck.nobus.manage-units'),
        },
      }),
    );
    // (a) red when an error reads not allowed; (b) prints readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['polkit unknown'],
      cause: `/usr/bin/pkcheck --action-id ${RP} --process 4242: Error getting authority: Error initializing authority: Could not connect: Connection refused; /usr/bin/pkcheck --action-id ${MU} --process 4242: Error getting authority: Error initializing authority: Could not connect: Connection refused`,
    });
  });

  it('01b #5: polkitd at /usr/lib/polkit-1/polkitd, pkcheck, no pkexec and no run0 → pkcheck is asked', async () => {
    await paths(
      merge(policies('policy.org.freedesktop.systemd1', false), {
        calls: {
          ...ask(MU, 'pkcheck.stock.org.freedesktop.systemd1.manage-units'),
          ...ask(RP, 'pkcheck.active-yes.reply-password'),
        },
      }),
    );
    // (a) red when presence is read from pkexec and run0 in the folders alone (B3); (b) prints
    //     whether pkcheck was asked.
    expect(asked.some((a) => a[0] === '/usr/bin/pkcheck')).toBe(true);
  });

  it('01b #5: pkexec present without pkcheck → polkit unknown', async () => {
    const rs = await paths({ programs: { '/usr/bin/pkexec': 0 } });
    // (a) red when polkit is read as absent; (b) prints readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['polkit unknown'],
      cause: 'polkit is here, but pkcheck is not',
    });
  });
});

describe('#790 — ssh (D10, 01b #4)', () => {
  const sshMachine = (over: MachineSpec = {}): MachineSpec =>
    merge(
      {
        dirs: { '/home/agent/.ssh': ['id_ed25519', 'id_ed25519.pub', 'known_hosts'] },
        files: { '/home/agent/.ssh/id_ed25519': '', '/usr/lib/systemd/system/ssh.socket': '' },
      },
      over,
    );

  it('a key in ~/.ssh, an ssh.socket unit, nothing on :22 → clause (f); no connection is made', async () => {
    const machine = fixtureMachine(sshMachine());
    let connects = 0;
    const probes = { ...machine, connect: async () => (connects++, false) };
    const rs = await measureSwitchPaths({ probes, svc: 'svc' });
    // (a) red when the unit file is not looked for (no ssh reading, no (f)), or the reader connects;
    //     (b) prints readings, clauses and the number of connects.
    expect({ readings: view(rs), clauses: clauses(rs), connects }).toEqual({
      readings: ['ssh needs_credential'],
      clauses: ['f'],
      connects: 0,
    });
  });

  it('01b #4: key plus sshd → needs a credential, clause (f), and no block (condition 2 measured "no")', async () => {
    const rs = await paths(sshMachine());
    // (a) red when ssh reads unknown; (b) prints the condition's basis and answer.
    const c = switchPathsCondition(rs, () => '', 'here');
    expect({ basis: c.basis, answer: c.basis === 'measured' ? c.answer : undefined }).toEqual({
      basis: 'measured',
      answer: 'no',
    });
  });

  it("rail 2: the key is looked for in the login's own home, never $HOME; no key there and no SSH_AUTH_SOCK → listed, a key elsewhere not looked for (B F9)", async () => {
    // A key under $HOME (the service user's home, as the docs tell the operator to set it), none
    // under the login's own.
    const viaHome = await paths(
      sshMachine({
        env: { PATH: '/usr/bin', HOME: '/home/svc' },
        dirs: { '/home/agent/.ssh': [], '/home/svc/.ssh': ['id_ed25519'] },
        files: { '/home/svc/.ssh/id_ed25519': '' },
      }),
    );
    // (a) red when the reader takes keys from $HOME; (b) prints the readings and their how.
    // #819 (08, B F9): ssh is listed whenever an sshd is present.
    expect({ readings: view(viaHome), how: viaHome.map((r) => r.how) }).toEqual({
      readings: ['ssh needs_credential'],
      how: ['an sshd is present (a key outside ~/.ssh is not looked for)'],
    });
  });
});

describe('#790 — condition 3, root_engine (D12)', () => {
  const groups = (member?: string): MachineSpec => ({
    programs: { [GETENT]: 0 },
    calls: Object.fromEntries(
      ROOT_GROUPS.map((g) => [
        `${GETENT} group ${g}`,
        `${U24}/getent.group.${g}.${g === member ? 'with' : 'without'}`,
      ]),
    ),
  });
  const reach = (spec: MachineSpec) => rootEngineReach(lookups(fixtureMachine(spec)));

  it('the LXD socket accepts → yes', async () => {
    // (a) red when only Docker's sockets are tried; (b) prints the reading.
    expect(
      await reach(merge(groups(), { sockets: { '/var/snap/lxd/common/lxd/unix.socket': true } })),
    ).toEqual({
      basis: 'measured',
      answer: 'yes',
      detail: "LXD's socket /var/snap/lxd/common/lxd/unix.socket accepts",
    });
  });

  it('modular libvirt: /run/libvirt/virtqemud-sock accepts → yes', async () => {
    // (a) red when only libvirt-sock is tried; (b) prints the reading.
    expect(
      await reach(merge(groups(), { sockets: { '/run/libvirt/virtqemud-sock': true } })),
    ).toEqual({
      basis: 'measured',
      answer: 'yes',
      detail: "libvirt's socket /run/libvirt/virtqemud-sock accepts",
    });
  });

  for (const g of ROOT_GROUPS) {
    it(`the login is in the group ${g} → yes`, async () => {
      // (a) red when group membership is not read; (b) prints the reading.
      expect(await reach(groups(g))).toEqual({
        basis: 'measured',
        answer: 'yes',
        detail: `this login is in the group ${g}`,
      });
    });
  }

  it('no socket accepts and the login is in none of the groups → no', async () => {
    // (a) red when a stopped socket or an absent group reads yes; (b) prints the reading.
    expect(await reach(merge(groups(), { sockets: { '/var/run/docker.sock': false } }))).toEqual({
      basis: 'measured',
      answer: 'no',
    });
  });
});

describe("#790 — the probes: the spy, the one spawn site, the runner's refusal (D1)", () => {
  /** Source with comments blanked (the #586 manner, holder-audit.test.ts's helper). */
  function stripComments(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
      const c = src[i]!;
      const n = src[i + 1];
      if (c === '/' && n === '/') {
        while (i < src.length && src[i] !== '\n') i++;
      } else if (c === '/' && n === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
      } else if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        out += c;
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') {
            out += src[i]!;
            i++;
          }
          out += src[i] ?? '';
          i++;
        }
        out += quote;
        i++;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }

  it('S2: only separation/runner.ts starts a process — in separation-check.ts and every local file it imports (#819 C2)', () => {
    // #819 (C2): the closure of the check's local imports, followed from separation-check.ts — the
    // folder alone missed program-identity.ts
    const lib = new URL('../', import.meta.url);
    const sources = new Map<string, string>();
    const visit = (url: URL): void => {
      const name = url.href.slice(lib.href.length);
      if (sources.has(name)) return;
      const src = readFileSync(url, 'utf8');
      sources.set(name, src);
      for (const m of src.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)\.js['"]/g)) {
        visit(new URL(`${m[1]}.ts`, url));
      }
    };
    visit(new URL('separation-check.ts', lib));
    const spawning = [...sources.keys()].filter((f) =>
      /\bchild_process\b|\bspawn(?:Sync)?\(|\bexecFile(?:Sync)?\(|(?<![.\w])exec(?:Sync)?\(|\bfork\(/.test(
        stripComments(sources.get(f)!),
      ),
    );
    // (a) red when a reader, the check or a file it imports starts a process itself, by any spelling
    //     of the module (A §F12) — named break: a direct call in program-identity.ts — or when a local
    //     import joins or leaves the closure unseen (the known members); (b) prints the files.
    expect({ files: [...sources.keys()].sort(), spawning }).toEqual({
      files: [
        'program-identity.ts',
        'separation-check.ts',
        'separation/doas.ts',
        'separation/engines.ts',
        'separation/index.ts',
        'separation/lookup.ts',
        'separation/pam.ts',
        'separation/polkit.ts',
        'separation/runner.ts',
        'separation/ssh.ts',
        'separation/su.ts',
        'separation/sudo.ts',
      ],
      spawning: ['separation/runner.ts'],
    });
  });

  it('S3: the runner refuses an argv that is not on rail 1, never starting it; a refused call reads unknown', async () => {
    const refused = await systemRunner(['/bin/echo', 'started']);
    // A §F13: a tool's name in a folder outside D2's is refused too
    const outside = await systemRunner(['/tmp/x/sudo', '-V']);
    // A doas rule whose command starts with "-": its check argv is not one of rail 1's. Rail-1
    // calls answer from captures; any other goes to the real runner, which must refuse it.
    const machine = fixtureMachine(
      linux(U24, {
        programs: { '/usr/bin/doas': 0 },
        files: { '/etc/doas.conf': 'permit nopass agent cmd -x\n' },
      }),
    );
    const probes = {
      ...machine,
      run: (argv: readonly string[]) => (railOne(argv) ? machine.run(argv) : systemRunner(argv)),
    };
    const rs = await measureSwitchPaths({ probes, svc: 'svc' });
    // (a) red when the runner's check is removed (echo runs; doas is started); (b) prints the
    //     runner's answer and the doas reading's cause.
    expect({ refused, outside, doas: view(rs), cause: rs[0]?.cause }).toEqual({
      refused: { refused: '/bin/echo started' },
      outside: { refused: '/tmp/x/sudo -V' },
      doas: ['doas unknown'],
      cause:
        '/usr/bin/doas -C /etc/doas.conf -u svc -x: the check refused to run /usr/bin/doas -C /etc/doas.conf -u svc -x',
    });
  });
});

describe('#790 — the sentence and the condition lines (D11, 01b #2, #3, #12)', () => {
  const NO: ConditionReading = { basis: 'measured', answer: 'no' };
  /** Every condition measured "no" and --gate-answers withheld on the line, with these ways. */
  const evidence = (
    ways: SwitchPathReading[],
    conds: Partial<CheckEvidence['conditions']> = {},
  ): CheckEvidence => ({
    login: 'agent',
    service_user: 'svc',
    store_owned_by_other: true,
    conditions: {
      store_reach: NO,
      become_service_user: switchPathsCondition(ways, (w) => switchPathEntry(w, 'svc'), 'here'),
      root_engine: NO,
      trust_root_writable: NO,
      other_answer_host: { basis: 'unknown', cause: 'one look' },
      time_basis: { basis: 'measured', answer: 'fact', detail: 'clock' },
      agent_sandbox: NO,
      economics_writable: { basis: 'measured', answer: 'fact', detail: 'none' },
      ...conds,
    },
    switch_paths: ways,
    value: { value: 'withheld', source: { kind: 'flag', ref: '--gate-answers' } },
    store: '/home/svc/.realm',
    store_found: true,
    owns_store: false,
    door: 'mcp',
    extensions_unread: false,
  });
  const HEAD =
    "An agent running as agent cannot record a gate answer through this server, the terminal or Realm's files, provided no program Realm runs as svc can run code for it, Realm's server runs this Node and this Realm package, and every Realm server on this machine starts with --gate-answers withheld";

  it("W-x3a: classic sudo refused and su closed by svc's shell → the head, W's always-clauses, and only (a), (b), (c) — no clause for a way that is absent", async () => {
    const ways = await paths(linux(U24, merge(sudos(U24, 'password', ['sudo']), su(U24))));
    // (a) red when a clause prints for a way that is not there (polkit's (d), ssh's (f)); (b) prints
    //     the sentence.
    expect(separationClaim(evidence(ways))).toBe(
      `${HEAD}; and provided the agent cannot obtain agent's password, and it is not empty; the agent cannot obtain svc's password, and it is not empty; the agent cannot obtain root's password; nobody authenticates sudo as agent where the agent's processes run (it then waives the password for some minutes); and sudo turns off its password only through NOPASSWD tags (its listpw setting is the default, no Defaults!… or Defaults>… line sets !authenticate, no runaspw setting names a user other than root or svc, and no pam_service or pam_login_service setting names another PAM stack).`,
    );
  });

  it('W-x3b: every way the clauses guard is found → every clause, (a) once per whose', async () => {
    const ways = await paths(
      linux(
        U24,
        merge(merge(sudos(U24, 'password', ['sudo']), su(U24, 'getent.passwd.svc.bash')), {
          files: {
            '/etc/pam.d/sudo': { fixture: `${U24}/variant.sudo-u2f` },
            '/usr/share/polkit-1/actions/org.freedesktop.systemd1.policy': {
              fixture: `${U24}/policy.org.freedesktop.systemd1`,
            },
            '/home/agent/.ssh/id_ed25519': '',
            '/usr/lib/systemd/system/ssh.socket': '',
          },
          programs: { '/usr/bin/pkcheck': 0, '/usr/lib/polkit-1/polkitd': 0 },
          dirs: {
            '/usr/share/polkit-1/actions': ['org.freedesktop.systemd1.policy'],
            '/home/agent/.ssh': ['id_ed25519'],
          },
          calls: {
            '/usr/bin/pkcheck --action-id org.freedesktop.systemd1.manage-units --process 4242': `${U24}/pkcheck.stock.org.freedesktop.systemd1.manage-units`,
            '/usr/bin/pkcheck --action-id org.freedesktop.systemd1.reply-password --process 4242': `${U24}/pkcheck.active-yes.reply-password`,
          },
        }),
      ),
    );
    // (a) red when a fired clause is left out of the sentence; (b) prints the sentence.
    expect(separationClaim(evidence(ways))).toBe(
      `${HEAD}; and provided the agent cannot obtain agent's password, and it is not empty; the agent cannot obtain svc's password, and it is not empty; the agent cannot obtain root's password; the agent cannot obtain an administrator's password; nobody authenticates sudo or polkit as agent where the agent's processes run (each then waives the password for some minutes); sudo turns off its password only through NOPASSWD tags (its listpw setting is the default, no Defaults!… or Defaults>… line sets !authenticate, no runaspw setting names a user other than root or svc, and no pam_service or pam_login_service setting names another PAM stack); no polkit rule grants agent pkexec, run0 or systemd-run beyond what this check's own session was shown (polkit's admin rules are not read; its vendor rules are not read); no person approves a Touch ID, fingerprint or security-key prompt the agent raises; and svc's authorized_keys holds none of agent's keys.`,
    );
  });

  it('P0: a way that reads unknown keeps the stronger sentence back — "may still", condition 2 not measured', async () => {
    const ways = await paths(linux(U25, sudos(U25, 'requiretty', ['sudo.ws'])));
    // (a) red when an unknown way lets the sentence print; (b) prints the sentence.
    expect(separationClaim(evidence(ways))).toBe(
      "An agent running as agent may still be able to answer a gate: whether it can become Realm's service user without a password was not measured.",
    );
  });

  it('01b #2: condition 2\'s line — "measured now", one entry per way, `⟨path⟩: ⟨outcome⟩ (⟨how⟩)`', async () => {
    const ways = await paths(linux(U24, merge(sudos(U24, 'password', ['sudo']), su(U24))));
    // (a) red when W's words come back ("(measured)", W's detail); (b) prints the line.
    expect(conditionLine('become_service_user', evidence(ways))).toBe(
      "This login can become Realm's service user (svc) without a password: no (measured now) — sudo: needs this login's password or is not allowed (sudo does not say which; LC_ALL=C /usr/bin/sudo -n -l says: a password is required; /etc/pam.d/sudo, /etc/pam.d/common-auth, /etc/pam.d/common-account, /etc/pam.d/common-session-noninteractive, /etc/pam.d/sudo-i, /etc/pam.d/common-session read); sudo: may need root's password (sudo does not show its Defaults or whether a rule exists, so rootpw or targetpw cannot be ruled out; LC_ALL=C /usr/bin/sudo -n -l says: a password is required; /etc/pam.d/sudo, /etc/pam.d/common-auth, /etc/pam.d/common-account, /etc/pam.d/common-session-noninteractive, /etc/pam.d/sudo-i, /etc/pam.d/common-session read); sudo: may need svc's password (sudo does not show its Defaults or whether a rule exists, so rootpw or targetpw cannot be ruled out; LC_ALL=C /usr/bin/sudo -n -l says: a password is required; /etc/pam.d/sudo, /etc/pam.d/common-auth, /etc/pam.d/common-account, /etc/pam.d/common-session-noninteractive, /etc/pam.d/sudo-i, /etc/pam.d/common-session read); su: not allowed (getent passwd svc and the shells files read: svc's shell /usr/sbin/nologin runs no command).",
    );
  });

  it('01b #2: the outcome words — yes, not allowed, unknown with its cause, and each credential', () => {
    const w = (r: Partial<SwitchPathReading>) =>
      switchPathEntry({ path: 'sudo', outcome: 'needs_credential', how: 'h', ...r }, 'svc');
    // (a) red when an outcome's words change; (b) prints each entry.
    expect([
      w({ outcome: 'yes' }),
      w({ outcome: 'not_allowed' }),
      w({ outcome: 'unknown', cause: 'c' }),
      w({ whose: 'this_login' }),
      w({ whose: 'svc' }),
      w({ whose: 'root' }),
      w({ whose: 'administrator' }),
      w({ whose: 'person' }),
      w({ path: 'ssh' }),
      w({ whose: 'this_login', or_not_allowed: true }),
      // #819 (08, A F1): a credential read only because sudo hides its Defaults
      w({ whose: 'root', cause: 'c' }),
      // #819 (08, B F12): an unknown's own parenthetical is the cause's, never merged
      w({ outcome: 'unknown', cause: 'c (d)' }),
    ]).toEqual([
      'sudo: yes (h)',
      'sudo: not allowed (h)',
      'sudo: unknown: c (h)',
      "sudo: needs this login's password (h)",
      "sudo: needs svc's password (h)",
      "sudo: needs root's password (h)",
      "sudo: needs an administrator's password (h)",
      "sudo: needs a person's touch or key (h)",
      'ssh: needs a key svc accepts (h)',
      // W's friction: the outcome's own parenthetical and the how's merge into one
      "sudo: needs this login's password or is not allowed (sudo does not say which; h)",
      "sudo: may need root's password (c; h)",
      'sudo: unknown: c (d) (h)',
    ]);
  });

  it('01b #3: condition 3\'s words — its line, and its gap in the "may still" sentence', () => {
    const yes: ConditionReading = {
      basis: 'measured',
      answer: 'yes',
      detail: 'this login is in the group docker',
    };
    const e = evidence([], { root_engine: yes });
    // (a) red when W's Docker-only words come back; (b) prints the line and the sentence.
    expect({ line: conditionLine('root_engine', e), claim: separationClaim(e) }).toEqual({
      line: 'This login can reach an engine that runs as root: yes (measured) — this login is in the group docker.',
      claim:
        'An agent running as agent may still be able to answer a gate: it can reach an engine that runs as root.',
    });
  });
});

describe('#790 correction 1 — the review of PR #827, each finding its cell', () => {
  /** A stack file from a captured variant, placed at `service`. */
  const stack = (img: string, service: string, variant: string): MachineSpec => ({
    files: { [`/etc/pam.d/${service}`]: { fixture: `${img}/variant.${variant}` } },
  });
  const group = (img: string, name: string): MachineSpec => ({
    calls: { [`${GETENT} group ${name}`]: `${img}/getent.group.${name}` },
  });
  const R3rs = [
    'sudo needs_credential this_login sudo_timestamp',
    'sudo needs_credential root sudo_timestamp',
    'sudo needs_credential svc sudo_timestamp',
  ];

  // A §F1 / B §1: the PAM grant and the no-password stack at each of the three sites
  it('A §F1 / B §1, the original sudo refusal × a pam_wheel trust grant → unknown (sudo hides whether a rule exists)', async () => {
    const rs = await paths(
      linux(
        U24,
        merge(
          merge(sudos(U24, 'password', ['sudo']), stack(U24, 'sudo', 'sudo-wheel-trust')),
          group(U24, 'sudo'),
        ),
      ),
    );
    // (a) red when the grant is dropped at this site (needs this login's password); (b) prints
    //     readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['sudo unknown'],
      cause:
        "sudo's PAM stack grants it (auth sufficient pam_wheel.so trust use_uid group=sudo), and sudo does not say whether a rule exists",
    });
  });

  it('A §F1 / B §1, the sudo-rs refusal × a pam_wheel trust grant → yes (a rule exists)', async () => {
    const rs = await paths(
      linux(
        U25,
        merge(
          merge(sudos(U25, 'password', ['sudo-rs']), stack(U25, 'sudo', 'sudo-wheel-trust')),
          group(U25, 'sudo'),
        ),
      ),
    );
    // (a) red when the grant is dropped at this site; (b) prints the readings.
    expect(view(rs)).toEqual(['sudo yes']);
  });

  it('A §F1 / B §1, a listing with a covering password rule beside a NOPASSWD rule for a third user × the grant → yes', async () => {
    const rs = await paths(
      linux(
        U25,
        merge(
          merge(sudos(U25, 'third-nopasswd', ['sudo.ws']), stack(U25, 'sudo', 'sudo-wheel-trust')),
          group(U25, 'sudo'),
        ),
      ),
    );
    // (a) red when the grant is dropped at the listing site; (b) prints the readings.
    expect(view(rs)).toEqual(['sudo yes']);
  });

  it('A §F1 / B §1, each site × a sudo stack with no password and no person module → unknown at all three', async () => {
    const noPassword = (img: string, set: string, which: ('sudo' | 'sudo-rs' | 'sudo.ws')[]) =>
      paths(linux(img, merge(sudos(img, set, which), stack(img, 'sudo', 'sudo-no-password')))).then(
        (rs) => ({
          readings: view(rs),
          cause: rs[0]?.cause,
        }),
      );
    const cause = "sudo's PAM stack names no password or person module this check reads";
    // (a) red when such a stack keeps the credential reading at a site; (b) prints each site's
    //     readings and cause.
    expect({
      classic: await noPassword(U24, 'password', ['sudo']),
      rs: await noPassword(U25, 'password', ['sudo-rs']),
      listing: await noPassword(U25, 'third-nopasswd', ['sudo.ws']),
    }).toEqual({
      classic: { readings: ['sudo unknown'], cause },
      rs: { readings: ['sudo unknown'], cause },
      listing: { readings: ['sudo unknown'], cause },
    });
  });

  it('A §F2: `Defaults!/usr/bin/realm !authenticate` with a rule for `/usr/bin/realm mcp *` → yes (any arguments)', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'defaults-cmd-args', ['sudo.ws'])));
    // (a) red when the command is matched by exact string; (b) prints the readings.
    expect(view(rs)).toEqual(['sudo yes']);
  });

  it("A §F3: sudo-rs's `CWD=*` before NOPASSWD → yes, beside a third user's rule and alone", async () => {
    const shape = (set: string) => paths(linux(U25, sudos(U25, set, ['sudo-rs']))).then(view);
    // (a) red when the option prefix is not stripped (the line then reads unknown); (b) prints both.
    expect({ beside: await shape('cwd-tag'), alone: await shape('cwd-tag-only') }).toEqual({
      beside: ['sudo yes'],
      alone: ['sudo yes'],
    });
  });

  it("A §F4: sudo-rs's listings under `rootpw` and `targetpw` (it shows no Defaults) → this login's, root's and svc's", async () => {
    const shape = (set: string) => paths(linux(U25, sudos(U25, set, ['sudo-rs']))).then(view);
    // (a) red when only this login's password is read where the Defaults cannot be seen; (b) prints
    //     both.
    expect({ rootpw: await shape('rootpw'), targetpw: await shape('targetpw') }).toEqual({
      rootpw: R3rs,
      targetpw: R3rs,
    });
  });

  it("A §F6: `timestamp_timeout=0` listed → this login's password with no cache, so no clause (b)", async () => {
    const rs = await paths(linux(U25, sudos(U25, 'ts0-third', ['sudo.ws'])));
    // (a) red when the timeout is not read (clause b printed); (b) prints readings and clauses.
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: ['sudo needs_credential this_login'],
      clauses: ['a:this_login'],
    });
  });

  it('A §F6: a global `!authenticate` in Matching Defaults, beside a NOPASSWD rule for a third user → yes', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'global-noauth-third', ['sudo.ws'])));
    // (a) red when the global setting is not read (a password rule reads "needs"); (b) prints the
    //     readings and how.
    expect({ readings: view(rs), how: rs[0]?.how }).toEqual({
      readings: ['sudo yes'],
      how: 'LC_ALL=C /usr/bin/sudo.ws -n -l and -n -ll: its Defaults turn the password off (!authenticate)',
    });
  });

  it("A §F6: `runaspw` → the run-as default's password (root's)", async () => {
    const rs = await paths(linux(U25, sudos(U25, 'runaspw', ['sudo.ws'])));
    // (a) red when runaspw is not read (this login's); (b) prints the readings.
    expect(view(rs)).toEqual(['sudo needs_credential root sudo_timestamp']);
  });

  it('A §F6: the original sudo\'s unprefixed "Sorry, user agent may not run sudo on h." → not allowed', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'noentries-noauth', ['sudo.ws'])));
    // (a) red when the refusal is not read (unknown); (b) prints the readings.
    expect(view(rs)).toEqual(['sudo not_allowed']);
  });

  it("A §F7: `%#1200`, a secondary group of svc's → yes", async () => {
    const rs = await paths(
      linux(U25, merge(sudos(U25, 'pct-gid-secondary', ['sudo.ws']), group(U25, '1200'))),
    );
    // (a) red when only svc's primary gid is compared; (b) prints the readings.
    expect(view(rs)).toEqual(['sudo yes']);
  });

  it('A §F8: `exempt_group` with this login in it, and a listing under `listpw=all` → yes; `pam_service` → that stack', async () => {
    const exempt = await paths(
      linux(U25, merge(sudos(U25, 'exempt-group', ['sudo.ws']), group(U25, 'sudo'))),
    );
    const listpw = await paths(linux(U25, sudos(U25, 'listpw-all-cached', ['sudo.ws'])));
    const service = await paths(linux(U25, sudos(U25, 'pam-service', ['sudo.ws'])));
    // (a) red per setting when it is not read; (b) prints each reading and the pam_service cause.
    expect({
      exempt: view(exempt),
      listpw: view(listpw),
      service: view(service),
      cause: service[0]?.cause,
    }).toEqual({
      exempt: ['sudo yes'],
      listpw: ['sudo yes'],
      service: ['sudo unknown'],
      cause: 'the PAM file for sudo-realm was not found',
    });
  });

  it("A §F9 / B §8: a grant only in sudo-i's stack → yes (sudo -i reads it)", async () => {
    // sudo-i here is the captured pam_wheel trust variant of Ubuntu 25.10's sudo stack, placed at sudo-i.
    const rs = await paths(
      linux(
        U25,
        merge(
          merge(
            sudos(U25, 'third-nopasswd', ['sudo.ws']),
            stack(U25, 'sudo-i', 'sudo-wheel-trust'),
          ),
          group(U25, 'sudo'),
        ),
      ),
    );
    // (a) red when sudo-i is not scanned; (b) prints the readings.
    expect(view(rs)).toEqual(['sudo yes']);
  });

  it("A §F10: run-as names compared by uid — `toor` (uid 0) covers root, `svc2` (svc's uid) covers svc", async () => {
    const shape = (set: string, user: string) =>
      paths(
        linux(
          U25,
          merge(sudos(U25, set, ['sudo.ws']), {
            calls: { [`${GETENT} passwd ${user}`]: `${U25}/getent.passwd.${user}` },
          }),
        ),
      ).then(view);
    // (a) red when run-as users are compared by name only; (b) prints both.
    expect({
      toor: await shape('uid0-alias', 'toor'),
      svc2: await shape('svc-uid-alias', 'svc2'),
    }).toEqual({
      toor: ['sudo yes'],
      svc2: ['sudo yes'],
    });
  });

  it('A §F11: a listing with no rules section → unknown', () => {
    // Classic sudo's captured listing, cut before its "User … may run" line (no real sudo prints that).
    const full = capture(`${U25}/cmd-svc.sudo.ws.ll`) as { stdout: string };
    const cut = full.stdout.slice(0, full.stdout.indexOf('User '));
    // (a) red when a headerless listing reads as one with no rules (not allowed); (b) prints the parse.
    expect(parseListing(cut)).toEqual({ unknown: 'sudo listed no rules section' });
  });

  it('A §F14: every root-owned system copy is asked; a copy there that is not root-owned reads unknown beside a good one', async () => {
    const two = (owner: number) =>
      paths(
        linux(U24, {
          programs: { '/usr/bin/sudo': 0, '/usr/local/bin/sudo': owner },
          calls: {
            ...sudos(U24, 'password', ['sudo']).calls,
            '/usr/local/bin/sudo -V': `${U24}/version.sudo`,
            'LC_ALL=C /usr/local/bin/sudo -n -l': `${U24}/password.sudo.l`,
          },
        }),
      ).then((rs) => rs.map((r) => `${r.tool} ${r.outcome}`));
    // (a) red when only the first copy is asked, or a bad copy beside a good one is skipped; (b)
    //     prints each machine's tools and outcomes.
    expect({ rooted: await two(0), theirs: await two(1001) }).toEqual({
      rooted: [
        '/usr/bin/sudo needs_credential',
        '/usr/bin/sudo needs_credential',
        '/usr/bin/sudo needs_credential',
        '/usr/local/bin/sudo needs_credential',
        '/usr/local/bin/sudo needs_credential',
        '/usr/local/bin/sudo needs_credential',
      ],
      theirs: [
        'sudo unknown',
        '/usr/bin/sudo needs_credential',
        '/usr/bin/sudo needs_credential',
        '/usr/bin/sudo needs_credential',
      ],
    });
  });

  it('W §3: a writable sudo first on PATH beside the system copy → the system copy is read, the PATH copy never run', async () => {
    await paths(
      linux(
        U24,
        merge(sudos(U24, 'password', ['sudo']), {
          env: { PATH: '/tmp/shim:/usr/bin' },
          programs: { '/tmp/shim/sudo': 1001 },
          writable: ['/tmp/shim/sudo', '/tmp/shim'],
        }),
      ),
    );
    // (a) red when the PATH copy is asked; (b) prints the sudo paths asked.
    expect([...new Set(asked.flatMap((a) => a.filter((w) => w.endsWith('/sudo'))))]).toEqual([
      '/usr/bin/sudo',
    ]);
  });

  it("B §3: a module argument off the list → unknown (pam_u2f's nouserok; pam_wheel's trust deny)", async () => {
    const u2f = await paths(
      linux(U24, merge(sudos(U24, 'password', ['sudo']), stack(U24, 'sudo', 'sudo-u2f-nouserok'))),
    );
    const deny = await paths(
      linux(U24, merge(su(U24, 'getent.passwd.svc.bash'), stack(U24, 'su-l', 'su-l-wheel-deny'))),
    );
    // (a) red when module arguments are not read; (b) prints both causes.
    expect({ u2f: u2f[0]?.cause, deny: deny[0]?.cause }).toEqual({
      u2f: "sudo's PAM stack has a line this check does not read: auth sufficient pam_u2f.so nouserok",
      deny: "su-l's PAM stack has a line this check does not read: auth sufficient pam_wheel.so trust deny use_uid group=sudo",
    });
  });

  it('B §3: a neutral module under `sufficient` (pam_faillock preauth) → unknown', async () => {
    const rs = await paths(
      linux(
        U24,
        merge(su(U24, 'getent.passwd.svc.bash'), stack(U24, 'su', 'su-faillock-sufficient')),
      ),
    );
    // (a) red when neutral modules are read under any control; (b) prints the cause.
    expect(rs[0]?.cause).toBe(
      "su's PAM stack has a line this check does not read: auth sufficient pam_faillock.so preauth",
    );
  });

  it('B §5: the honesty branches — a cyclic include, an unreadable include, pam_permit with no deny before it, four controls, /etc/pam.conf alone', async () => {
    const suStack = (over: MachineSpec) =>
      paths(linux(U24, merge(su(U24, 'getent.passwd.svc.bash'), over))).then((rs) => rs[0]?.cause);
    const commonAuth = (variant: string) => suStack(stack(U24, 'common-auth', variant));
    const unreadable = linux(U24, su(U24, 'getent.passwd.svc.bash'));
    delete unreadable.files!['/etc/pam.d/common-auth'];
    unreadable.unreadable = ['/etc/pam.d/common-auth'];
    const confOnly = await paths({
      programs: { [GETENT]: 0, '/usr/bin/su': 0 },
      calls: {
        [`${GETENT} passwd svc`]: `${U24}/getent.passwd.svc.bash`,
        [`${GETENT} passwd root`]: `${U24}/getent.passwd.root`,
      },
      files: {
        '/etc/pam.conf': { fixture: `${DEB}/pam.conf` },
        '/etc/shells': { fixture: `${U24}/shells` },
      },
    });
    // (a) red per branch when it is removed (each then reads "needs svc's password" or another
    //     cause); (b) prints each cause.
    expect({
      cyclic: await suStack(stack(U24, 'su', 'su-cyclic')),
      unreadable: await paths(unreadable).then((rs) => rs[0]?.cause),
      permit: await commonAuth('common-auth-no-deny'),
      optionalUnix: await commonAuth('common-auth-optional-unix'),
      successDone: await commonAuth('common-auth-success-done-unix'),
      sufficientDeny: await commonAuth('common-auth-sufficient-deny'),
      requiredCap: await commonAuth('common-auth-required-cap'),
      confOnly: confOnly[0]?.cause,
    }).toEqual({
      cyclic: 'the PAM stack nests deeper than 4 includes',
      unreadable: '/etc/pam.d/common-auth cannot be read',
      permit: "su's PAM stack has a line this check does not read: auth required pam_permit.so",
      optionalUnix:
        "su's PAM stack has a line this check does not read: auth optional pam_unix.so nullok",
      successDone:
        "su's PAM stack has a line this check does not read: auth [success=done default=ignore] pam_unix.so nullok",
      sufficientDeny:
        "su's PAM stack has a line this check does not read: auth sufficient pam_deny.so",
      requiredCap: "su's PAM stack has a line this check does not read: auth required pam_cap.so",
      confOnly: 'PAM is configured in /etc/pam.conf, which this check does not read',
    });
  });

  it('B §6: a guard whose jump lands past the deny line → unknown', async () => {
    const rs = await paths(
      linux(
        U24,
        merge(
          su(U24, 'getent.passwd.svc.bash'),
          stack(U24, 'common-auth', 'common-auth-guard-jump'),
        ),
      ),
    );
    // (a) red when the jump is not followed (needs svc's password); (b) prints the cause.
    expect(rs[0]?.cause).toBe(
      "su's PAM stack can jump past its deny line: auth [default=2 ignore=ignore success=ok] pam_localuser.so",
    );
  });

  it('CAUD-12: a `sufficient` password module with no deny line after it → unknown (Linux-PAM lets a later success through)', async () => {
    const rs = await paths(
      linux(
        U24,
        merge(
          su(U24, 'getent.passwd.svc.bash'),
          stack(U24, 'common-auth', 'common-auth-sufficient-no-deny'),
        ),
      ),
    );
    // (a) red when such a stack reads "needs svc's password"; (b) prints the cause.
    expect(rs[0]?.cause).toBe(
      "su's PAM stack lets a failed password through: no deny line follows auth sufficient pam_unix.so nullok",
    );
  });

  it('B §12: a module named by a path outside the module folders → unknown', async () => {
    const rs = await paths(
      linux(
        U24,
        merge(
          su(U24, 'getent.passwd.svc.bash'),
          stack(U24, 'common-auth', 'common-auth-abs-module'),
        ),
      ),
    );
    // (a) red when a module is recognised by its basename anywhere; (b) prints the cause.
    expect(rs[0]?.cause).toBe(
      '/etc/pam.d/common-auth has a line this check does not read: auth [success=1 default=ignore] /opt/x/pam_unix.so nullok',
    );
  });

  it('B §7: any readable key file counts (`~/.ssh/deploy`); an unlistable .ssh says the key is assumed', async () => {
    const sshd = { '/usr/lib/systemd/system/ssh.socket': '' };
    const deploy = await paths({
      dirs: { '/home/agent/.ssh': ['deploy', 'deploy.pub', 'known_hosts'] },
      files: { ...sshd, '/home/agent/.ssh/deploy': '' },
    });
    const unlisted = await paths({ dirs: { '/home/agent/.ssh': undefined }, files: sshd });
    // (a) red when only `id_*` counts, or an assumed key is said to be held; (b) prints both.
    expect({ deploy: view(deploy), how: unlisted[0]?.how }).toEqual({
      deploy: ['ssh needs_credential'],
      how: "an sshd is present and this login may hold a key (its home's .ssh could not be listed)",
    });
  });

  it('B §9: svc\'s passwd entry not read (getent fails) → su unknown, never "needs svc\'s password"', async () => {
    // Ubuntu 24.04's su and its stacks, with getent's answer for svc missing (the runner reports it
    // could not answer: a lookup that fails)
    const machine = linux(U24, su(U24));
    delete machine.calls![`${GETENT} passwd svc`];
    const rs = await paths(machine);
    // (a) red when su goes on to its PAM stack (needs svc's password); (b) prints readings and
    //     whether the cause is getent's.
    expect({ readings: view(rs), getent: rs[0]?.cause?.startsWith('getent passwd svc: ') }).toEqual(
      {
        readings: ['su unknown'],
        getent: true,
      },
    );
  });

  it("B §11: su's stack unknown but su-l's grant → yes (a grant outranks an unknown within one path)", async () => {
    const rs = await paths(
      linux(
        U24,
        merge(
          merge(
            merge(su(U24, 'getent.passwd.svc.bash'), stack(U24, 'su', 'su-succeed-if')),
            stack(U24, 'su-l', 'su-l-wheel-trust'),
          ),
          group(U24, 'wheel'),
        ),
      ),
    );
    // (a) red when the unknown is returned before the grant is looked for; (b) prints the readings.
    expect(view(rs)).toEqual(['su yes']);
  });

  it('B §13: a socket this login can write, its engine stopped → yes', async () => {
    const reach = await rootEngineReach(
      lookups(
        fixtureMachine({
          programs: { [GETENT]: 0 },
          sockets: { '/var/run/docker.sock': false },
          writable: ['/var/run/docker.sock'],
          calls: Object.fromEntries(
            ROOT_GROUPS.map((g) => [`${GETENT} group ${g}`, `${U24}/getent.group.${g}.without`]),
          ),
        }),
      ),
    );
    // (a) red when a writable socket of a stopped engine reads no; (b) prints the reading.
    expect(reach).toEqual({
      basis: 'measured',
      answer: 'yes',
      detail: "Docker's socket /var/run/docker.sock can be written by this login",
    });
  });

  it('W §5, W §8: clause (d) names the entry points of the actions asked (#819, 08 B F11) and each rules folder as `exists` and `canRead` read it', async () => {
    const rs = await paths({
      programs: {
        '/usr/bin/pkcheck': 0,
        '/usr/lib/polkit-1/polkitd': 0,
        '/usr/bin/pkexec': 0,
        '/usr/bin/systemd-run': 0,
      },
      dirs: {
        '/usr/share/polkit-1/actions': ['org.freedesktop.systemd1.policy'],
        '/etc/polkit-1/rules.d': undefined,
        '/usr/share/polkit-1/rules.d': ['50-default.rules'],
      },
      files: {
        '/usr/share/polkit-1/actions/org.freedesktop.systemd1.policy': {
          fixture: `${U24}/policy.org.freedesktop.systemd1`,
        },
      },
      readable: ['/usr/share/polkit-1/rules.d'],
      calls: {
        '/usr/bin/pkcheck --action-id org.freedesktop.systemd1.manage-units --process 4242': `${U24}/pkcheck.stock.org.freedesktop.systemd1.manage-units`,
        '/usr/bin/pkcheck --action-id org.freedesktop.systemd1.reply-password --process 4242': `${U24}/pkcheck.active-yes.reply-password`,
      },
    });
    // (a) red when the folders are not read, or the entry points come from the binaries found
    //     (#819, 08 B F11: run0 is not installed here, and manage-units — run0's action — is asked;
    //     reply-password is a program pkexec runs); (b) prints the clause.
    expect(switchClausesOf(rs).find((c) => c.clause === 'd')).toEqual({
      clause: 'd',
      tools: ['pkexec', 'run0', 'systemd-run'],
      admin: 'unreadable',
      vendor: 'unread',
    });
  });
});

describe("#819 (08) — #790's leftovers, each its cell", () => {
  /** A stack file from a captured variant, placed at `service`. */
  const stack = (img: string, service: string, variant: string): MachineSpec => ({
    files: { [`/etc/pam.d/${service}`]: { fixture: `${img}/variant.${variant}` } },
  });
  const group = (img: string, name: string, fixture = name): MachineSpec => ({
    calls: { [`${GETENT} group ${name}`]: `${img}/getent.group.${fixture}` },
  });
  /** The ways read on `spec`'s machine, one captured call's stdout edited — the correction's
   *  cut-capture standard (A F11): the edit is named beside each cell. */
  const edited = (
    spec: MachineSpec,
    call: string,
    edit: (stdout: string) => string,
    svc = 'svc',
  ) => {
    const machine = fixtureMachine(spec);
    const run = machine.run;
    return measureSwitchPaths({
      probes: {
        ...machine,
        run: async (argv) => {
          const r = await run(argv);
          return argv.join(' ') === call && 'exit' in r ? { ...r, stdout: edit(r.stdout) } : r;
        },
      },
      svc,
    });
  };
  const LL = 'LC_ALL=C /usr/bin/sudo.ws -n -ll';
  const RS_L = 'LC_ALL=C /usr/bin/sudo -n -l';

  it("B Outside 1: a person module under a control that can jump past the deny line → unknown; under `sufficient` → a person's touch", async () => {
    // The captured pam_u2f line of Ubuntu 24.04's sudo variant, its control edited to `[default=2]`:
    // on a failed touch it skips common-auth's password line and its deny line.
    const jumping = fixtureFile(`${U24}/variant.sudo-u2f`).replace(
      'auth       sufficient pam_u2f.so cue',
      'auth       [default=2] pam_u2f.so cue',
    );
    const jump = await paths(
      linux(
        U24,
        merge(sudos(U24, 'password', ['sudo']), { files: { '/etc/pam.d/sudo': jumping } }),
      ),
    );
    const sufficient = await paths(
      linux(U24, merge(sudos(U24, 'password', ['sudo']), stack(U24, 'sudo', 'sudo-u2f'))),
    );
    // (a) red when person modules are read under any control (the jump reads "a person's touch or
    //     key", a wrong "cannot"); (b) prints both readings and the jump's cause.
    expect({
      jump: view(jump),
      cause: jump[0]?.cause,
      sufficient: view(sufficient).includes('sudo needs_credential person'),
    }).toEqual({
      jump: ['sudo unknown'],
      cause:
        "sudo's PAM stack has a line this check does not read: auth [default=2] pam_u2f.so cue",
      sufficient: true,
    });
  });

  it('B F9: an sshd and no ~/.ssh → ssh listed, a key outside ~/.ssh not looked for, and clause (f)', async () => {
    const rs = await paths({ files: { '/usr/lib/systemd/system/ssh.socket': '' } });
    // (a) red when ssh is left out for no key found in ~/.ssh (clause (f) then never prints — the
    //     agent may use a key it keeps elsewhere); (b) prints the readings, how and clauses.
    expect({ readings: view(rs), how: rs[0]?.how, clauses: clauses(rs) }).toEqual({
      readings: ['ssh needs_credential'],
      how: 'an sshd is present (a key outside ~/.ssh is not looked for)',
      clauses: ['f'],
    });
  });

  it("B F7: ssh's not-keys — known_hosts, a .pub, config, authorized_keys — are no key", async () => {
    const names = ['known_hosts', 'id_ed25519.pub', 'config', 'authorized_keys'];
    const rs = await paths({
      dirs: { '/home/agent/.ssh': names },
      files: {
        '/usr/lib/systemd/system/ssh.socket': '',
        ...Object.fromEntries(names.map((n) => [`/home/agent/.ssh/${n}`, ''])),
      },
    });
    // (a) red when those four count as keys ("holds a key"); (b) prints the how.
    expect(rs[0]?.how).toBe('an sshd is present (a key outside ~/.ssh is not looked for)');
  });

  it('A Outside 2: `(%svcgrp)` with svcgrp listing no members, svc\'s primary group another → unknown, never "not covering"', async () => {
    const rs = await paths(
      linux(
        U25,
        merge(sudos(U25, 'pct-group', ['sudo.ws']), {
          calls: {
            [`${GETENT} passwd svc`]: `${U25}/getent.passwd.svc.own-group`,
            [`${GETENT} group svcgrp`]: `${U25}/getent.group.svcgrp.no-members`,
          },
        }),
      ),
    );
    // (a) red when an empty member list reads as "svc is not in it" (the rule then covers no one:
    //     not allowed — a wrong "cannot" where SSSD hides the members); (b) prints readings, cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['sudo unknown'],
      cause: 'getent group svcgrp lists no members, so whether svc is in it is not known',
    });
  });

  it("A F2: `differs` — a command whose real file is the target's (merged /usr), a folder or glob target, and an unknown real path each count as covered", async () => {
    // The captured `Defaults!/usr/bin/realm !authenticate` listing (sudo.ws -ll), its target and
    // command edited per row; `/bin` links to `/usr/bin` where a row says so.
    const shape = (target: string, command: string, over: MachineSpec = {}) =>
      edited(linux(U25, merge(sudos(U25, 'defaults-cmd-args', ['sudo.ws']), over)), LL, (out) =>
        out
          .replace('Defaults!/usr/bin/realm !authenticate', `Defaults!${target} !authenticate`)
          .replace('\t/usr/bin/realm mcp *', `\t${command}`),
      ).then(view);
    const merged = { programs: { '/usr/bin/realm': 0 }, links: { '/bin/realm': '/usr/bin/realm' } };
    // (a) red per row when its conjunct is dropped: `realPath` (the merged-/usr target reads apart
    //     from its command — "needs", a wrong "cannot"); `plainTarget` (a glob whose name is a real
    //     file); `cmdUnknown` and `targetUnknown` (an unknown real path read as different); (b)
    //     prints each row's readings.
    expect({
      realPath: await shape('/bin/realm', '/usr/bin/realm', merged),
      plainTarget: await shape('/usr/bin/*', '/usr/bin/realm', {
        programs: { '/usr/bin/realm': 0, '/usr/bin/*': 0 },
      }),
      cmdUnknown: await shape('/usr/bin/realm', '/opt/realm/bin/realm', {
        programs: { '/usr/bin/realm': 0 },
      }),
      targetUnknown: await shape('/opt/realm/bin/realm', '/usr/bin/realm', {
        programs: { '/usr/bin/realm': 0 },
      }),
    }).toEqual({
      realPath: ['sudo yes'],
      plainTarget: ['sudo yes'],
      cmdUnknown: ['sudo yes'],
      targetUnknown: ['sudo yes'],
    });
  });

  it('A F2: a rule listed with no run-as user → unknown, never "not allowed" (B16)', async () => {
    // The captured default-runas listing (sudo.ws -ll), its `RunAsUsers: root` line cut — no real
    // sudo prints such an entry (F790-C1R-A-07): the line is the only guard.
    const rs = await edited(linux(U25, sudos(U25, 'default-runas', ['sudo.ws'])), LL, (out) =>
      out.replace('    RunAsUsers: root\n', ''),
    );
    // (a) red when the no-run-as check is removed (the entry covers no one: not allowed); (b)
    //     prints readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['sudo unknown'],
      cause: 'sudo listed a rule with no run-as user',
    });
  });

  it("A F2, A F5: an option sudo-rs writes before the tags that this check does not know → unknown; `FOO=1` among a command's arguments is the command's → yes", async () => {
    // The captured `(svc) CWD=* NOPASSWD: /usr/bin/realm` listing (sudo-rs), edited per row.
    const shape = (line: string) =>
      edited(linux(U25, sudos(U25, 'cwd-tag', ['sudo-rs'])), RS_L, (out) =>
        out.replace('(svc) CWD=* NOPASSWD: /usr/bin/realm', line),
      ).then(view);
    // (a) red: `newOption` when the leftover check is removed (the rule then reads "needs" three
    //     passwords, A §F3's "cannot"); `argument` when the whole item is checked, not its head
    //     (A F5's false unknown); (b) prints both.
    expect({
      newOption: await shape('(svc) NEWOPT=* NOPASSWD: /usr/bin/realm'),
      argument: await shape('(svc) NOPASSWD: /usr/bin/env FOO=1 /usr/bin/realm'),
    }).toEqual({ newOption: ['sudo unknown'], argument: ['sudo yes'] });
  });

  it('A F2: the PAM stack `pam_login_service` names, and `sudo-i` under /usr/lib/pam.d, are read', async () => {
    // pam_login_service: the captured pam_service listing (sudo.ws -ll), its Defaults edited to
    // `pam_login_service=sudo-realm-i`; the captured pam_wheel trust variant placed there.
    const login = await edited(
      linux(
        U25,
        merge(
          merge(sudos(U25, 'pam-service', ['sudo.ws']), {
            files: {
              '/etc/pam.d/sudo-realm-i': { fixture: `${U25}/variant.sudo-wheel-trust` },
            },
          }),
          group(U25, 'sudo'),
        ),
      ),
      LL,
      (out) => out.replace('pam_service=sudo-realm', 'pam_login_service=sudo-realm-i'),
    );
    // sudo-i only under /usr/lib/pam.d: the captured variant placed there, none in /etc/pam.d.
    const vendor = linux(
      U25,
      merge(merge(sudos(U25, 'third-nopasswd', ['sudo.ws']), group(U25, 'sudo')), {
        files: { '/usr/lib/pam.d/sudo-i': { fixture: `${U25}/variant.sudo-wheel-trust` } },
      }),
    );
    delete vendor.files!['/etc/pam.d/sudo-i'];
    // (a) red per row: `login` when pam_login_service is not passed on; `vendor` when
    //     /usr/lib/pam.d is not looked in; (b) prints both.
    expect({ login: view(login), vendor: view(await paths(vendor)) }).toEqual({
      login: ['sudo yes'],
      vendor: ['sudo yes'],
    });
  });

  it('A F2: `#1000` against a service user named `uid 999` (no passwd entry) → not covering, so not allowed', async () => {
    // The captured `(#999)` listing (sudo.ws -ll), edited to `#1000`; svc is looked up by uid and
    // has no entry (the captured "not there" answer).
    const rs = await edited(
      linux(
        U25,
        merge(sudos(U25, 'hash-uid', ['sudo.ws']), {
          calls: { [`${GETENT} passwd 999`]: `${U25}/getent.passwd.none` },
        }),
      ),
      LL,
      (out) => out.replace('RunAsUsers: #999', 'RunAsUsers: #1000'),
      'uid 999',
    );
    // (a) red when a `uid N` service user's uid is not read (the token then covers it: yes); (b)
    //     prints the readings.
    expect(view(rs)).toEqual(['sudo not_allowed']);
  });

  it("A Outside 1: `runaspw` and `targetpw` together → the run-as default's password (root's), sudo's own order", async () => {
    // The captured runaspw listing (sudo.ws -ll), targetpw added to its Defaults.
    const rs = await edited(linux(U25, sudos(U25, 'runaspw', ['sudo.ws'])), LL, (out) =>
      out.replace('use_pty, runaspw', 'use_pty, runaspw, targetpw'),
    );
    // (a) red when targetpw is read before runaspw (svc's password; sudo asks root's, check.c:61-80);
    //     (b) prints the readings.
    expect(view(rs)).toEqual(['sudo needs_credential root sudo_timestamp']);
  });

  it('B F4: /etc/pam.conf beside /etc/pam.d (Ubuntu and Debian ship both) → /etc/pam.d is read', async () => {
    const rs = await paths(
      linux(
        U24,
        merge(su(U24, 'getent.passwd.svc.bash'), {
          files: { '/etc/pam.conf': { fixture: `${U24}/pam.conf` } },
          dirs: { '/etc/pam.d': PAM[U24] },
        }),
      ),
    );
    // (a) red when pam.conf counts while /etc/pam.d exists (Linux-PAM reads pam.conf only without
    //     it): every stack would read unknown; (b) prints the readings.
    expect(view(rs)).toEqual(['su needs_credential svc']);
  });

  it('B F6: `pam_wheel trust deny` for a login NOT in the group → unknown, never "needs svc\'s password"', async () => {
    const rs = await paths(
      linux(
        U24,
        merge(
          merge(su(U24, 'getent.passwd.svc.bash'), stack(U24, 'su-l', 'su-l-wheel-deny')),
          group(U24, 'sudo', 'sudo.without'),
        ),
      ),
    );
    // (a) red when `deny` is read as an argument pam_wheel takes (the line is then a non-member's
    //     restriction, and su reads "needs svc's password" — the wrong "cannot": trust deny lets
    //     NON-members through); (b) prints the readings.
    expect(view(rs)).toEqual(['su unknown']);
  });

  it('B F8: a grant inside a substack, then a parent line this check does not read → unknown', async () => {
    // su's stack composed from captured lines: the pam_wheel trust line (Ubuntu 24.04's su-l
    // variant) in a substack, then the pam_succeed_if line (its su variant) in su itself.
    const wheel = fixtureFile(`${U24}/variant.su-l-wheel-trust`).split('\n')[0]!;
    const succeed = fixtureFile(`${U24}/variant.su-succeed-if`)
      .split('\n')
      .find((l) => l.includes('pam_succeed_if'))!;
    const rs = await paths(
      linux(
        U24,
        merge(merge(su(U24, 'getent.passwd.svc.bash'), group(U24, 'wheel')), {
          files: {
            '/etc/pam.d/su': `auth substack su-realm\n${succeed}\n`,
            '/etc/pam.d/su-realm': `${wheel}\n`,
          },
        }),
      ),
    );
    // (a) red when a grant inside a substack outranks the parent's later lines (Linux-PAM's `done`
    //     ends only the substack, pam_dispatch.c:301-305: "yes" is then a wrong yes); (b) prints the
    //     readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['su unknown'],
      cause: `su's PAM stack has a line this check does not read: ${succeed.replace(/\s+/g, ' ')}`,
    });
  });

  it("B F12: only the parentheticals the renderer writes are merged — Alpine's doas entry keeps its own", async () => {
    const alpine = await paths({
      programs: { [GETENT]: 0, '/usr/bin/doas': 0 },
      calls: {
        [`${GETENT} passwd svc`]: `${ALP}/getent.passwd.svc`,
        [`${GETENT} passwd root`]: `${ALP}/getent.passwd.root`,
      },
      unreadable: ['/etc/doas.conf'],
      dirs: { '/etc/doas.d': undefined },
    });
    // (a) red when an unknown's cause takes the how inside its own parenthetical; (b) prints it.
    expect(switchPathEntry(alpine[0]!, 'svc')).toBe(
      `doas: unknown: doas's rules cannot be read here (/etc/doas.d) (${alpine[0]!.how})`,
    );
  });

  it('B Outside 3: a root-owned system copy this login can change says so', async () => {
    const rs = await paths(
      linux(U24, { programs: { '/usr/bin/sudo': 0 }, writable: ['/usr/bin/sudo'] }),
    );
    // (a) red when it reads "not a root-owned system copy" (it is root's); (b) prints the cause.
    expect(rs[0]?.cause).toBe('sudo at /usr/bin/sudo is root-owned, but this login can change it');
  });

  it('walk new 4: a bad system copy reached by two names reads once', async () => {
    const rs = await paths(
      linux(U24, {
        programs: { '/usr/bin/sudo': 0, '/bin/sudo': 0 },
        links: { '/bin/sudo': '/usr/bin/sudo' },
        writable: ['/usr/bin/sudo'],
      }),
    );
    // (a) red when a bad copy is named once per name (`/bin` links to `usr/bin`: one file); (b)
    //     prints the causes.
    expect(rs.map((r) => r.cause)).toEqual([
      'sudo at /usr/bin/sudo is root-owned, but this login can change it',
    ]);
  });

  it('walk new 2: with Realm\'s service user root, each entry and each clause prints once — (a) for it with "and it is not empty"', async () => {
    const ways = await paths(linux(U24, sudos(U24, 'password', ['sudo'])), 'root');
    const line = switchPathsReading(ways, 'root');
    const NO: ConditionReading = { basis: 'measured', answer: 'no' };
    const claim = separationClaim({
      login: 'agent',
      service_user: 'root',
      store_owned_by_other: true,
      owns_store: false,
      conditions: {
        store_reach: NO,
        become_service_user: line,
        root_engine: NO,
        trust_root_writable: NO,
        other_answer_host: { basis: 'unknown', cause: 'one look' },
        time_basis: { basis: 'measured', answer: 'fact', detail: 'clock' },
        agent_sandbox: NO,
        economics_writable: { basis: 'measured', answer: 'fact', detail: 'none' },
      },
      switch_paths: ways,
      value: { value: 'withheld', source: { kind: 'flag', ref: '--gate-answers' } },
    });
    const count = (text: string, part: string) => text.split(part).length - 1;
    const detail = line.basis === 'measured' ? (line.detail ?? '') : '';
    // (a) red per count when the entries or the clauses are not de-duplicated (root's password then
    //     twice: "may need root's password" in the line, and a bare "cannot obtain root's password"
    //     beside the one with "and it is not empty"); (b) prints the counts.
    expect({
      entries: count(detail, "sudo: may need root's password ("),
      clauses: count(claim, "the agent cannot obtain root's password"),
      notEmpty: claim.includes("the agent cannot obtain root's password, and it is not empty"),
    }).toEqual({ entries: 1, clauses: 1, notEmpty: true });
  });
});

describe('#790 — the docs (guardrail 7(f)): every sentence of the rewritten separation section names its cell', () => {
  const PAGE = new URL('../../../../../docs/reference/mcp/gate-answers.md', import.meta.url);
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
  const claim = (sentence: string): void => {
    expect(
      flat(readFileSync(PAGE, 'utf8')),
      `gate-answers.md no longer says: ${sentence}`,
    ).toContain(flat(sentence));
  };

  it('the page says what each way reads, each clause and why, the notes — each sentence executed by the cell named beside it', () => {
    // The spy after every cell (only rail 1's calls), :: "S2", :: "S3", and the ssh no-connect cell.
    claim(
      'The check never switches user, never asks for or tries a password, and never opens a login connection.',
    );
    // :: "01b #2: condition 2's line".
    claim(
      'It reads each way from this login to the user Realm runs as, and prints one entry per way, `way: reading (how it was read)`, measured now:',
    );
    // :: "01b #13", :: "A §F14: every root-owned system copy is asked …"; W §4: classic sudo's -ll
    // only after -l lists (:: "classic sudo refused …" asks no -ll; the spy).
    // #819 (08, B F10): "this login cannot change, … once per real file" — :: "W §3 …", :: "A §F14 …",
    // :: "walk new 4: a bad system copy reached by two names reads once".
    claim(
      'Every root-owned copy this login cannot change, named `sudo`, `sudo.ws` or `sudo-rs`, once per real file, in `/usr/bin`, `/usr/sbin`, `/usr/local/bin`, `/usr/local/sbin`, `/bin`, `/sbin`, `/run/wrappers/bin` or `/run/setuid-programs` is asked `sudo -V`, then `LC_ALL=C sudo -n -l`, and, when the original sudo lists its rules, `-n -ll`.',
    );
    // :: "`(svc) NOPASSWD: /usr/bin/realm` listed", :: "`Defaults!…`", :: "`Defaults>svc …`",
    // :: "A §F2: … `/usr/bin/realm mcp *`", :: "A §F10: run-as names compared by uid …".
    claim(
      "A rule that runs as Realm's user or root without a password reads yes, whatever command it is limited to, and so does a `Defaults` line that may turn the password off for such a rule. A run-as name counts by its uid, so another name for root or for the user counts too.",
    );
    // :: "a listing with no NOPASSWD entry …", :: "A §F8: `exempt_group` … `listpw=all` …".
    claim(
      'Rules listed although none of them waives the password read yes too: a cached credential, among other causes, lets them be listed. So do `exempt_group` naming a group this login may be in, and a listing shown under `listpw=all`.',
    );
    // :: "`rootpw` …", :: "`targetpw` …", :: "A §F6: `runaspw` …", :: "A §F4: sudo-rs's listings …",
    // :: "classic sudo refused …", :: "sudo-rs "interactive authentication is required" …".
    claim(
      "In the original sudo's listing, a rule that needs a password reads \"needs\" that password: this login's, or root's or the user's under `rootpw`, `targetpw` or `runaspw`. Where sudo shows no Defaults — sudo-rs's listings and either sudo's refusal — the password may be this login's, root's or the user's, and all three are read.",
    );
    // :: "classic sudo refused …", :: "sudo-rs "interactive authentication is required" …",
    // :: "sudo-rs "Sorry, user agent may not run sudo on h."".
    claim(
      'The original sudo\'s "a password is required" reads "needs this login\'s password or is not allowed", because sudo does not say which; sudo-rs\'s "interactive authentication is required" needs this login\'s password, and its "Sorry, user … may not run sudo" reads not allowed.',
    );
    // :: "sudo's PAM has a person module (pam_u2f …)", :: "Fedora's … pam_fprintd …", :: "sudo's
    // PAM has pam_ssh_agent_auth", :: "A §F1 / B §1" (four cells), :: "A §F9 / B §8", :: "A §F8"
    // (pam_service).
    // #819 (08, A F4): "in the original sudo's listing" — the services are read only where sudo lists
    // them; :: "A F2: the PAM stack `pam_login_service` names, and `sudo-i` under /usr/lib/pam.d …".
    claim(
      'Whenever sudo needs a password, its PAM stacks are read too: `/etc/pam.d/sudo`, and `sudo-i` where it exists (or, in the original sudo\'s listing, the services `pam_service` and `pam_login_service` name), with their includes. A security-key or fingerprint module adds "a person\'s touch or key"; an ssh-agent module, or a stack with no password or person module, reads unknown; a `pam_wheel.so trust` line for this login reads yes where a rule is listed or the sudo-rs refusal names one, and unknown where the original sudo refused.',
    );
    // :: "B §9: svc's passwd entry not read …"; :: "svc's shell /usr/sbin/nologin …", :: "… listed in
    // /etc/shells".
    // #819 (08, B F5): macOS's dscl too — :: "the real Ubuntu 24.04, Debian and Fedora su stacks …;
    // macOS's, with svc's shell not read, → unknown (B F5)".
    claim(
      "When `getent` cannot read the user's passwd entry, or on macOS `dscl` the user's shell, su reads unknown. When the user's shell runs no command (`/usr/sbin/nologin`, `/sbin/nologin`, `/bin/false` or `/usr/bin/false`) and no shells file lists it, su reads not allowed.",
    );
    // :: "an empty password field and a shell that runs commands".
    claim("An empty password field in the user's passwd entry reads yes.");
    // :: "the real Ubuntu 24.04, Debian, Fedora and macOS su stacks", :: "01b #11: su-l carries …".
    claim(
      'Otherwise su\'s PAM stacks, `su` and `su-l`, are read: a password module reads "needs" the user\'s password, and a `pam_wheel.so trust` line for this login reads yes.',
    );
    // :: "BusyBox su (Alpine, no PAM stack) → needs svc's password, whatever svc's shell (B §11)".
    claim(
      "BusyBox's su, which reads no PAM stack, needs the user's password, whatever the user's shell: whether it keeps a shell that runs no command depends on how it was built.",
    );
    // :: "`permit nopass agent as svc cmd /usr/bin/realm` readable", :: "rules only in
    // /etc/doas.d/realm.conf", :: "`deny agent` …", :: "B §2: …" (two cells).
    claim(
      "Its rules in `/etc/doas.conf` and `/etc/doas.d/*.conf` are read, and doas is asked `doas -C <file> -u <user> <command>` for Realm's user and root — for each command a rule names (with one more argument too, unless the rule fixes its arguments) and for a command no rule names: `permit nopass` reads yes, `permit` needs this login's password, and `deny` reads not allowed.",
    );
    // :: "pkcheck: manage-units 0, exec 2", :: "stock polkit … every action D9 names is asked", the spy.
    claim(
      "`pkcheck --action-id <action> --process <pid>` is asked, without `--allow-user-interaction`, for pkexec, for run0 and `systemd-run` (`org.freedesktop.systemd1.manage-units`), for machinectl's shells and for each program pkexec runs.",
    );
    // :: "the session rule …"; :: "stock polkit …" (B §4: both whose, kept).
    claim(
      "polkit decides by session, and the check's session may not be the agent's, so each action's defaults count too. An answer that asks for a credential reads both this login's password and an administrator's, each kept for some minutes: polkit's rules may change whose it asks.",
    );
    // :: "a key in ~/.ssh … no connection is made", :: "rail 2: …", :: "B §7: any readable key file …".
    // #819 (08, B F9, B F7): :: "B F9: an sshd and no ~/.ssh → ssh listed …", :: "B F7: ssh's
    // not-keys …", :: "rail 2: …".
    claim(
      'It is listed whenever an sshd is present. Its entry says whether this login holds a key — any readable file in its own `.ssh` but a `.pub`, `known_hosts`, `config` or `authorized_keys`, or a set `SSH_AUTH_SOCK` — and, when it holds none there, that a key kept outside `.ssh` is not looked for. No connection is made.',
    );
    // :: "the pam_succeed_if recipe in su" (a rule), :: "Alpine as shipped" (a file), :: "a pkcheck
    // error" and :: "B §9" (a tool's error), :: "P0: a way that reads unknown keeps the stronger
    // sentence back".
    claim(
      "A rule the check does not recognise, a file it cannot read, or a tool's error reads unknown, with the tool's own line, and then the stronger sentence is not printed.",
    );
    // :: "01b #8: a sudo found only under the login's home", :: "A §F14 … a copy there that is not
    // root-owned …", :: "W §3: a writable sudo first on PATH …".
    claim(
      'The tools are asked only as the root-owned copies in the folders above: a copy found only on PATH, or a system copy that is not root-owned or that this login can change, reads unknown; a copy elsewhere on PATH beside a good system copy is never run.',
    );
    // The check's boundary (04 item 10), by design: no reading from this login can see it.
    claim('A compromise that already holds root can fake any reading.');
    // :: "W-x3a", :: "W-x3b"; core separation-790 :: each "(a)"–"(f)" trigger cell.
    claim(
      'When every way needs a credential or is not allowed, the stronger sentence adds a condition for each thing no program can see from this login, and only for the ways it found:',
    );
    claim(
      "the agent cannot obtain a password a way needs (this login's, the user's, root's or an administrator's); for this login's and the user's, that it is not empty, since an empty one sits where this login cannot read it;",
    );
    claim(
      "nobody authenticates, as this login where the agent's processes run, those of sudo, doas and polkit whose password cache a way showed, because each then waives the password for some minutes;",
    );
    // #819 (08, A F4): :: "W-x3a", :: "W-x3b" (clause (c)'s words); sudo 1.9.15p5's auth/pam.c:220-226
    // (the services; W-819-790 rows) and check.c:61-80 (runaspw).
    claim(
      'sudo turns off its password only through `NOPASSWD` tags, when the original sudo refused the listing, because its refusal hides `listpw`, the `Defaults!…` and `Defaults>…` lines, `runaspw`, and the PAM services `pam_service` and `pam_login_service` name;',
    );
    // :: "W §5, W §8: clause (d) names the entry points of the actions asked (#819, 08 B F11) …",
    // :: "W-x3b".
    claim(
      "no polkit rule grants this login the entry points of the actions asked (pkexec for its own action and each program it runs, run0 and `systemd-run` for `manage-units`, machinectl for machine1's shells; polkit's actions when none is asked) beyond what the check's own session was shown, when polkit is present: the condition says which rules folder cannot be read here and which is not read;",
    );
    claim(
      "no person approves a Touch ID, fingerprint or security-key prompt the agent raises, when a way needs a person's touch or key;",
    );
    // #819 (08, B F9): :: "B F9: an sshd and no ~/.ssh → ssh listed, …, and clause (f)".
    claim("the user's `authorized_keys` holds none of this login's keys, when an sshd is present.");
    // :: "the LXD socket accepts", :: "modular libvirt", :: "B §13: a socket this login can write …",
    // :: "the login is in the group …" (each).
    claim(
      'Condition 3 connects to the sockets of Docker, LXD, Incus, Podman, libvirt and containerd — a socket this login can write counts even while its engine is stopped — and reads whether this login is in the group `disk`, `docker`, `lxd`, `incus-admin` or `libvirt`: membership outlasts a stopped daemon.',
    );
    // W §2 = F790-MA3-15: the syslog line, measured by the walk on the original sudo 1.9.15p5 for a
    // login it lists (journalctl, auth.log — the line as measured, `USER=root` included), and
    // "may" because a login sudo does not list, sudo-rs and newer sudo were not measured (#819, 08
    // B F1); the ticket, read in sudo 1.9.15p5's check.c:180-187, 216-223 and policy.c:86, 100
    // (F790-IA-C1 rows); the audit record and the engine log line, by design (F790-R1-06, D2 §7.6);
    // noninteractive_auth, sudo-rs pipeline.rs:205-207 (F790-R3-B-07). No mail clause: sudo 1.9.15p5's
    // log_denial mails a login not in sudoers by default (mail_no_user, logging.c:281-300, 957-969;
    // W-819-790 rows). Not executable here.
    claim(
      "A refused sudo listing may write one syslog auth line naming the working folder (the original sudo 1.9.15p5 does for a login it lists: `sudo: <login> : a password is required ; PWD=… ; USER=root ; COMMAND=list`), and may leave an audit record where Linux auditd or macOS auditing runs. A listing that a still-valid ticket of the original sudo allowed renews that ticket. A socket connect may leave a log line on an engine that logs each connection. Nothing is locked or counted as a failed login while sudo's `noninteractive_auth` setting is off, as it is by default.",
    );
    // :: "Alpine as shipped: /etc/doas.conf 0640"; the remedy: the readable doas cells.
    claim(
      'On Alpine, `/etc/doas.conf` (mode 0640) and `/etc/doas.d` (0750) cannot be read by other users, so doas reads unknown there.',
    );
    claim(
      'They hold rules, not secrets: `chmod 0644 /etc/doas.conf /etc/doas.d/*.conf` and `chmod 0755 /etc/doas.d` let the check read them.',
    );
    // :: "01b #9: macOS — a sudo rule whose runas is a group", :: "01b #9: macOS — a pam_wheel trust
    // line", :: "macOS as shipped …" and :: "macOS: Apple's published sudo stack, Touch ID turned on …".
    claim('On macOS, a sudo rule whose runas is a group, and a `pam_wheel` line, read unknown.');
    claim(
      "Apple's sudo stack includes `sudo_local` and a smart-card module, which this check does not read, so sudo reads unknown on a Mac whenever it needs a password.",
    );
  });
});
