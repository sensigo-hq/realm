// separation-790.test.ts — #790 (02): the switch-path readers on captured fixtures (D2 §5): one cell
// per row of D2 §2's table and per cell 01b adds, the spy after every cell (D1: each argv a reader
// asked matches one of rail 1's shapes, element by element), the one spawn site (S2) and the runner's
// own refusal (S3). No real tool runs here: every machine's runner answers from captured fixtures.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure:
// readings, outcomes, booleans and a captured fixture's own line — never an environment, a key file's
// contents, an environment variable's value, or a real login or host name.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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
    'su',
    'su-l',
    'common-auth',
    'common-account',
    'common-session',
    'common-session-noninteractive',
    'other',
  ],
  [FED]: ['sudo', 'su', 'su-l', 'system-auth', 'postlogin', 'other'],
};

/** A Linux image's machine: its getent, its passwd entries for svc and root, its PAM files. */
function linux(img: string, over: MachineSpec = {}): MachineSpec {
  return merge(
    {
      programs: { [GETENT]: 0 },
      calls: {
        [`${GETENT} passwd svc`]: `${img}/getent.passwd.svc`,
        [`${GETENT} passwd root`]: `${img}/getent.passwd.root`,
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
    // (a) red when the refusal drops its cache (b) or its "or not allowed" (c); (b) prints readings
    //     and clauses.
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: ['sudo needs_credential this_login sudo_timestamp or not allowed'],
      clauses: ['a:this_login', 'b', 'c'],
    });
  });

  it('sudo-rs "Sorry, user agent may not run sudo on h." → not allowed', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'none', ['sudo-rs'])));
    // (a) red when the refusal is read as unknown; (b) prints the readings.
    expect(view(rs)).toEqual(['sudo not_allowed']);
  });

  it('sudo-rs "interactive authentication is required" → needs this login\'s password (a rule exists)', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'password', ['sudo-rs'])));
    // (a) red when it is read as not allowed; (b) prints readings and clauses.
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: ['sudo needs_credential this_login sudo_timestamp'],
      clauses: ['a:this_login', 'b'],
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
    expect({ readings: view(rs), how: rs[1]?.how }).toEqual({
      readings: ['sudo needs_credential this_login sudo_timestamp', 'sudo yes'],
      how: 'LC_ALL=C /usr/bin/sudo.ws -n -l and -n -ll: Defaults!/usr/bin/realm !authenticate covers a rule',
    });
  });

  it('`Defaults>svc !authenticate` (a runas line) → yes', async () => {
    const rs = await paths(linux(U25, sudos(U25, 'auth-runas', ['sudo.ws'])));
    // (a) red when a runas-specific line is not read; (b) prints the readings.
    expect(view(rs)).toEqual(['sudo yes']);
  });

  it("`rootpw` in Matching Defaults → needs root's password; the clause names root", async () => {
    const rs = await paths(linux(U25, sudos(U25, 'rootpw', ['sudo.ws'])));
    // (a) red when rootpw is ignored (this login's); (b) prints readings and clauses.
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: ['sudo needs_credential root'],
      clauses: ['a:root'],
    });
  });

  it("`targetpw` → needs svc's password", async () => {
    const rs = await paths(linux(U25, sudos(U25, 'targetpw', ['sudo.ws'])));
    // (a) red when targetpw is ignored; (b) prints the readings.
    expect(view(rs)).toEqual(['sudo needs_credential svc']);
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
      condition: switchPathsCondition(rs, () => '').basis,
      yes: rs.some((r) => r.outcome === 'yes'),
    }).toEqual({
      readings: ['sudo needs_credential this_login sudo_timestamp', 'sudo yes'],
      condition: 'measured',
      yes: true,
    });
  });

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
      alias: await shape('runas-alias'),
      defaultRunas: await shape('default-runas'),
    }).toEqual({
      groupOnly: ['sudo yes'],
      pctGroup: ['sudo yes'],
      pctGid: ['sudo yes'],
      hashUid: ['sudo yes'],
      netgroup: ['sudo yes'],
      negated: ['sudo yes'],
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
        'sudo needs_credential person',
      ],
      clauses: ['a:this_login', 'b', 'c', 'e'],
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
    // Apple's su stack, with the pam_wheel line of the Ubuntu 24.04 capture put first.
    const wheel = fixtureFile(`${U24}/variant.su-l-wheel-trust`).split('\n')[0]!;
    const rs = await paths({
      platform: 'darwin',
      programs: { '/usr/bin/su': 0 },
      files: { '/etc/pam.d/su': `${wheel}\n${fixtureFile(`${MAC}/pam.su`)}` },
    });
    // (a) red when pam_wheel's group is read on macOS; (b) prints readings and cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['su unknown'],
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
    expect({ readings: view(rs), basis: switchPathsCondition(rs, () => '').basis }).toEqual({
      readings: ['sudo needs_credential this_login sudo_timestamp', 'sudo unknown'],
      basis: 'unknown',
    });
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

  it("the real Ubuntu 24.04, Debian, Fedora and macOS su stacks → needs svc's password", async () => {
    // macOS: no dscl answer is captured (04 item 4), so the shell is not read and su goes to its stack.
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
      macos: ['su needs_credential svc'],
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

  it("BusyBox su (Alpine, no PAM stack) → needs svc's password; with svc's /sbin/nologin, not allowed", async () => {
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
      nologin: ['su not_allowed'],
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
        ? { '/etc/doas.d/realm.conf': { fixture: `${ALP}/doas.${realm}.realm.conf` } }
        : {}),
    },
    dirs: { '/etc/doas.d': realm !== undefined ? ['realm.conf'] : [] },
  });
  /** The captured `doas -C` answers of one rule set: each file × svc and root × each command. */
  const answers = (set: string, cmds: string[]): MachineSpec => {
    const calls: Record<string, string> = {};
    for (const t of ['svc', 'root']) {
      calls[`/usr/bin/doas -C /etc/doas.conf -u ${t} /bin/sh`] =
        `${ALP}/doas.stock.doas.conf.${t}.-bin-sh`;
      for (const c of cmds) {
        calls[`/usr/bin/doas -C /etc/doas.d/realm.conf -u ${t} ${c}`] =
          `${ALP}/doas.${set}.realm.conf.${t}.${c.replace(/\//g, '-').replace(/ /g, '_')}`;
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
      merge(doasFiles('nopass-cmd'), answers('nopass-cmd', ['/usr/bin/realm', '/bin/sh'])),
    );
    // (a) red when only an unrestricted command is asked (deny for any other); (b) prints readings.
    expect(view(rs)).toEqual(['doas yes']);
  });

  it('rules only in /etc/doas.d/realm.conf → read from the folder; persist → clause (b)', async () => {
    const rs = await paths(merge(doasFiles('persist'), answers('persist', ['/bin/sh'])));
    // (a) red when only /etc/doas.conf is read (not allowed); (b) prints readings, clauses and how.
    expect({ readings: view(rs), clauses: clauses(rs), how: rs[0]?.how }).toEqual({
      readings: ['doas needs_credential this_login doas_persist'],
      clauses: ['a:this_login', 'b'],
      how: '/etc/doas.conf and /etc/doas.d/realm.conf read, and /usr/bin/doas -C asked 4 times',
    });
  });

  it('`deny agent` → not allowed; a :wheel rule and a command with args are parsed as doas -C reads them', async () => {
    const deny = await paths(merge(doasFiles('deny'), answers('deny', ['/bin/sh'])));
    const mixed = await paths(
      merge(merge(doasFiles('mixed'), answers('mixed', ['/usr/bin/realm status', '/bin/sh'])), {
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
      readings: ['polkit needs_credential administrator polkit_keep'],
      clauses: ['a:administrator', 'b', 'd'],
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
    const c = switchPathsCondition(rs, () => '');
    expect({ basis: c.basis, answer: c.basis === 'measured' ? c.answer : undefined }).toEqual({
      basis: 'measured',
      answer: 'no',
    });
  });

  it("rail 2: the key is looked for in the login's own home, never $HOME; no key and no SSH_AUTH_SOCK → not listed", async () => {
    // A key under $HOME (the service user's home, as the docs tell the operator to set it), none
    // under the login's own.
    const viaHome = await paths(
      sshMachine({
        env: { PATH: '/usr/bin', HOME: '/home/svc' },
        dirs: { '/home/agent/.ssh': [], '/home/svc/.ssh': ['id_ed25519'] },
        files: { '/home/svc/.ssh/id_ed25519': '' },
      }),
    );
    // (a) red when the reader lists keys from $HOME; (b) prints the readings.
    expect(view(viaHome)).toEqual([]);
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

  it('S2: only separation/runner.ts starts a process', () => {
    const dir = new URL('./', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const spawning = files.filter((f) =>
      /node:child_process|\bspawn(?:Sync)?\(|\bexecFile(?:Sync)?\(|(?<![.\w])exec(?:Sync)?\(|\bfork\(/.test(
        stripComments(readFileSync(new URL(f, dir), 'utf8')),
      ),
    );
    // (a) red when a reader starts a process itself; (b) prints the files that do.
    expect({ files: files.length > 8, spawning }).toEqual({ files: true, spawning: ['runner.ts'] });
  });

  it('S3: the runner refuses an argv that is not on rail 1, never starting it; a refused call reads unknown', async () => {
    const refused = await systemRunner(['/bin/echo', 'started']);
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
    expect({ refused, doas: view(rs), cause: rs[0]?.cause }).toEqual({
      refused: { refused: '/bin/echo started' },
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
      become_service_user: switchPathsCondition(ways, (w) => switchPathEntry(w, 'svc')),
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
      `${HEAD}; and provided the agent cannot obtain agent's password; nobody authenticates sudo, doas or polkit as agent where the agent's processes run (each then waives the password for some minutes); and sudo turns off its password only through NOPASSWD tags (its listpw setting is the default, and no Defaults!… or Defaults>… line sets !authenticate).`,
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
      `${HEAD}; and provided the agent cannot obtain agent's password; the agent cannot obtain svc's password, and it is not empty; the agent cannot obtain an administrator's password; nobody authenticates sudo, doas or polkit as agent where the agent's processes run (each then waives the password for some minutes); sudo turns off its password only through NOPASSWD tags (its listpw setting is the default, and no Defaults!… or Defaults>… line sets !authenticate); no polkit rule grants agent pkexec, run0, systemd-run or machinectl beyond what this check's own session was shown (polkit's rules cannot be read here); no person approves a Touch ID or security-key prompt the agent raises; and svc's authorized_keys holds none of agent's keys.`,
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
      "This login can become Realm's service user (svc) without a password: no (measured now) — sudo: needs this login's password or is not allowed (sudo does not say which) (LC_ALL=C /usr/bin/sudo -n -l says: a password is required); su: not allowed (getent passwd svc and the shells files read: svc's shell /usr/sbin/nologin runs no command).",
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
      "sudo: needs this login's password or is not allowed (sudo does not say which) (h)",
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
    // :: "01b #13: sudo and sudo.ws both present", the spy (the argv shapes).
    claim(
      'Every copy named `sudo`, `sudo.ws` or `sudo-rs` in `/usr/bin`, `/usr/sbin`, `/usr/local/bin`, `/usr/local/sbin`, `/bin`, `/sbin`, `/run/wrappers/bin` or `/run/setuid-programs` is asked `sudo -V`, then `LC_ALL=C sudo -n -l` (and `-n -ll` for the original sudo).',
    );
    // :: "`(svc) NOPASSWD: /usr/bin/realm` listed", :: "`Defaults!/usr/bin/realm !authenticate`",
    // :: "`Defaults>svc !authenticate`".
    claim(
      "A rule that runs as Realm's user or root without a password reads yes, whatever command it is limited to, and so does a `Defaults` line that turns the password off for such a rule.",
    );
    // :: "a listing with no NOPASSWD entry (a cached credential)".
    claim(
      'Rules listed although none of them waives the password read yes too: a cached credential, among other causes, lets them be listed.',
    );
    // :: "`rootpw` in Matching Defaults", :: "`targetpw`", :: "`Defaults!/usr/bin/realm …`" (sudo-rs).
    claim(
      "A listed rule that needs a password reads \"needs\" that password: this login's, or root's or the user's under `rootpw` or `targetpw`.",
    );
    // :: "classic sudo refused …", :: "sudo-rs "interactive authentication is required"", :: "sudo-rs
    // "Sorry, user agent may not run sudo on h."".
    claim(
      'The original sudo\'s "a password is required" reads "needs this login\'s password or is not allowed", because sudo does not say which; sudo-rs\'s "interactive authentication is required" needs this login\'s password, and its "Sorry, user … may not run sudo" reads not allowed.',
    );
    // :: "sudo's PAM has a person module (pam_u2f …)", :: "Fedora's authselect sssd profile …
    // pam_fprintd", :: "sudo's PAM has pam_ssh_agent_auth".
    claim(
      'Whenever sudo needs a password, its PAM stack (`/etc/pam.d/sudo` and its includes) is read too: a security-key or fingerprint module adds "a person\'s touch or key", and an ssh-agent module reads unknown.',
    );
    // :: "svc's shell /usr/sbin/nologin, in neither shells file", :: "… listed in /etc/shells".
    claim(
      "When the user's shell runs no command (`/usr/sbin/nologin`, `/sbin/nologin`, `/bin/false` or `/usr/bin/false`) and no shells file lists it, su reads not allowed.",
    );
    // :: "an empty password field and a shell that runs commands".
    claim("An empty password field in the user's passwd entry reads yes.");
    // :: "the real Ubuntu 24.04, Debian, Fedora and macOS su stacks", :: "01b #11: su-l carries …".
    claim(
      'Otherwise su\'s PAM stacks, `su` and `su-l`, are read: a password module reads "needs" the user\'s password, and a `pam_wheel.so trust` line for this login reads yes.',
    );
    // :: "BusyBox su (Alpine, no PAM stack)".
    claim("BusyBox's su, which reads no PAM stack, needs the user's password.");
    // :: "`permit nopass agent as svc cmd /usr/bin/realm` readable", :: "rules only in
    // /etc/doas.d/realm.conf", :: "`deny agent` → not allowed …".
    claim(
      "Its rules in `/etc/doas.conf` and `/etc/doas.d/*.conf` are read, and doas is asked `doas -C <file> -u <user> <command>` for Realm's user and root: `permit nopass` reads yes, `permit` needs this login's password, and `deny` reads not allowed.",
    );
    // :: "pkcheck: manage-units 0, exec 2", :: "stock polkit … every action D9 names is asked", the spy
    // (no `--allow-user-interaction` is one of rail 1's shapes).
    claim(
      "`pkcheck --action-id <action> --process <pid>` is asked, without `--allow-user-interaction`, for pkexec, for run0 and `systemd-run` (`org.freedesktop.systemd1.manage-units`), for machinectl's shells and for each program pkexec runs.",
    );
    // :: "the session rule: manage-units' default allow_active yes …".
    claim(
      "polkit decides by session, and the check's session may not be the agent's, so each action's defaults count too.",
    );
    // :: "a key in ~/.ssh, an ssh.socket unit … no connection is made", :: "rail 2: …".
    claim(
      'It is listed when this login holds a key and an sshd is present. No connection is made.',
    );
    // :: "the pam_succeed_if recipe in su" (a rule), :: "Alpine as shipped" (a file), :: "a pkcheck
    // error" (a tool's error), :: "P0: a way that reads unknown keeps the stronger sentence back".
    claim(
      "A rule the check does not recognise, a file it cannot read, or a tool's error reads unknown, with the tool's own line, and then the stronger sentence is not printed.",
    );
    // :: "01b #8: a sudo found only under the login's home"; separation-check-627 :: "each condition
    // line in its states" (a sudo this login owns).
    claim(
      'The tools are asked only as the root-owned copies in the folders above: a copy found elsewhere on `PATH`, or one this login can change, reads unknown.',
    );
    // The check's boundary (04 item 10), by design: no reading from this login can see it.
    claim('A compromise that already holds root can fake any reading.');
    // :: "W-x3a", :: "W-x3b"; core separation-790 :: each "(a)"–"(f)" trigger cell.
    claim(
      'When every way needs a credential or is not allowed, the stronger sentence adds a condition for each thing no program can see from this login, and only for the ways it found:',
    );
    claim(
      "the agent cannot obtain a password a way needs (this login's, the user's, root's or an administrator's); for the user's, that it is not empty, since an empty one sits where this login cannot read it;",
    );
    claim(
      "nobody authenticates sudo, doas or polkit as this login where the agent's processes run, because each then waives the password for some minutes;",
    );
    claim(
      'sudo turns off its password only through `NOPASSWD` tags, when the original sudo refused the listing, because its refusal hides `listpw` and the `Defaults!…` and `Defaults>…` lines;',
    );
    claim(
      "no polkit rule grants this login pkexec, run0, systemd-run or machinectl beyond what the check's own session was shown, when polkit is present, because its rules folders cannot be read;",
    );
    claim(
      "no person approves a Touch ID or security-key prompt the agent raises, when a way needs a person's touch or key;",
    );
    claim(
      "the user's `authorized_keys` holds none of this login's keys, when an sshd is present and this login holds a key.",
    );
    // :: "the LXD socket accepts", :: "modular libvirt", :: "the login is in the group …" (each).
    claim(
      'Condition 3 connects to the sockets of Docker, LXD, Incus, Podman, libvirt and containerd, and reads whether this login is in the group `disk`, `docker`, `lxd`, `incus-admin` or `libvirt`: membership outlasts a stopped daemon.',
    );
    // By design (04 item 6): sudo's own source, registry F790-R1-06 and F790-MA3-06; libvirtd's
    // logging, D2 §7.6. Not executable here: this host keeps no audit trail (F790-MA3-05).
    claim(
      'A refused sudo listing may leave one audit record where Linux auditd or macOS auditing runs, and a socket connect may leave a log line on an engine that logs each connection. Nothing is locked, mailed or counted as a failed login.',
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
