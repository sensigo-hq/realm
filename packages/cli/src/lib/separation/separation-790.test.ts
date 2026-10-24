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
import {
  defaultsValue,
  parseListing,
  sudoVersion,
  unescapePrinted,
  type SudoVersion,
} from './sudo.js';
import { railOne, type RunResult } from './runner.js';
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
  // #819 Unit A (A3): a user's groups, as sudo reads them
  if (a.length === 3 && named(a[0], 'id') && a[1] === '-G' && word(a[2])) return true;
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

/** #819 correction 1: Ubuntu 24.04's captured `third-nopasswd` listing (classic sudo, `-ll`) with
 *  the svc rule's run-as edited to `%svcgrp` (the cut-capture standard); svcgrp lists alice, not
 *  svc, and svc's primary group is another (the captures of 2026-10-19) — a reading that rests on a
 *  group's listed members. */
/** The Unit A correction (C2, the audit's S3): under sudo's default flags a group's member list no
 *  longer decides where `id -G` cannot be read (the case gap reads unknown), so the cells about the
 *  member list read it under `!case_insensitive_group` (`flags`), where it still decides. */
const groupBacked = (flags?: string): Promise<SwitchPathReading[]> => {
  const machine = fixtureMachine(
    linux(
      U24,
      merge(sudos(U24, 'third-nopasswd', ['sudo']), {
        calls: {
          [`${GETENT} group svcgrp`]: `${U24}/getent.group.svcgrp.others`,
          [`${GETENT} passwd svc`]: `${U24}/getent.passwd.svc.own-group`,
          // #819 follow-up 2 (member 3): svc's primary group by its gid, captured (divergence 1)
          [`${GETENT} group 1300`]: `${U24}/getent.group.1300.own-group`,
        },
      }),
    ),
  );
  const run = machine.run;
  return measureSwitchPaths({
    probes: {
      ...machine,
      run: async (argv) => {
        const r = await run(argv);
        if (argv.join(' ') !== 'LC_ALL=C /usr/bin/sudo -n -ll' || !('exit' in r)) return r;
        const out = r.stdout.replace('    RunAsUsers: svc\n', '    RunAsUsers: %svcgrp\n');
        return {
          ...r,
          stdout:
            flags === undefined ? out : out.replace('    use_pty\n', `    use_pty, ${flags}\n`),
        };
      },
    },
    svc: 'svc',
  });
};

/** A reading, compact: path, outcome, whose (and a named user's name: #819 Unit A, the capped
 *  correction, Part 7), cache, and classic sudo's "or not allowed". */
const view = (rs: SwitchPathReading[]): string[] =>
  rs.map((r) =>
    [
      r.path,
      r.outcome,
      r.whose,
      r.user,
      r.cache,
      r.or_not_allowed === true ? 'or not allowed' : undefined,
    ]
      .filter((x) => x !== undefined)
      .join(' '),
  );
const clauses = (rs: SwitchPathReading[]): string[] =>
  switchClausesOf(rs).map((c) =>
    c.clause === 'a' ? `a:${c.whose}${c.user !== undefined ? `:${c.user}` : ''}` : c.clause,
  );

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
      // #819 Unit A re-pin (A9): "is unknown", one state one word — was "the cause is not known"
      said: rs.map((r) => r.how.endsWith('listed without a password (the cause is unknown)')),
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
    // #819 Unit A, the capped correction (Part 3): su is read toward root too — root's shell runs
    // commands, so su needs root's password
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: ['su not_allowed', 'su needs_credential root'],
      clauses: ['a:root'],
    });
  });

  it('nologin and an empty password field in /etc/passwd → not allowed ((c) before (b))', async () => {
    const rs = await paths(linux(U24, su(U24, 'getent.passwd.svc.empty-pw-nologin')));
    // (a) red when the empty field is read before the shell (yes); (b) prints the readings.
    // #819 Unit A, the capped correction (Part 3): su is read toward root too — root's shell runs
    // commands, so su needs root's password
    expect(view(rs)).toEqual(['su not_allowed', 'su needs_credential root']);
  });

  it('an empty password field and a shell that runs commands → yes', async () => {
    const rs = await paths(linux(U24, su(U24, 'getent.passwd.svc.empty-pw-sh')));
    // (a) red when the inline empty password is not read; (b) prints the readings.
    // #819 Unit A, the capped correction (Part 3): su is read toward root too — root's shell runs
    // commands, so su needs root's password
    expect(view(rs)).toEqual(['su yes', 'su needs_credential root']);
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
      // the capped correction (Part 3): toward root too; on macOS root's shell is not read either
      [U24]: ['su needs_credential svc', 'su needs_credential root'],
      [DEB]: ['su needs_credential svc', 'su needs_credential root'],
      [FED]: ['su needs_credential svc', 'su needs_credential root'],
      macos: ['su unknown', 'su unknown'],
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
    // #819 Unit A, the capped correction (Part 3): su is read toward root too — root's shell runs
    // commands, so su needs root's password
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: ['su needs_credential svc', 'su needs_credential root'],
      clauses: ['a:svc', 'a:root'],
    });
  });

  it("svc's shell /usr/sbin/nologin listed in /etc/shells → the PAM scan", async () => {
    const rs = await paths(linux(U24, su(U24, 'getent.passwd.svc', 'shells.with-nologin')));
    // (a) red when the shells file is not read; (b) prints the readings.
    // #819 Unit A, the capped correction (Part 3): su is read toward root too — root's shell runs
    // commands, so su needs root's password
    expect(view(rs)).toEqual(['su needs_credential svc', 'su needs_credential root']);
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
      // the capped correction (Part 3): BusyBox's su asks root's password toward root
      sh: ['su needs_credential svc', 'su needs_credential root'],
      // B §11: BusyBox keeps a restricted shell only under a build option this check cannot see
      nologin: ['su needs_credential svc', 'su needs_credential root'],
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
  /** #819 correction 1 (walk --check wording 6): systemd running as PID 1 (sd_booted's folder), and
   *  the host's pkexec and machinectl — each action is asked only where the host has a way to it. */
  const BOOTED: MachineSpec = { dirs: { '/run/systemd/system': [] } };
  const HOST = merge(BOOTED, {
    programs: { '/usr/bin/pkexec': 0, '/usr/bin/machinectl': 0 },
  });

  it('pkcheck: manage-units 0, exec 2 → yes (manage-units is asked)', async () => {
    const rs = await paths(
      merge(merge(policies(), HOST), {
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
      merge(merge(policies('policy.systemd1.active-yes', false), HOST), {
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
      merge(merge(policies(), HOST), {
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
      merge(merge(policies('policy.org.freedesktop.systemd1', false), HOST), {
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
      merge(merge(policies('policy.org.freedesktop.systemd1', false), BOOTED), {
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
      how: ['an sshd is present; a key outside /home/agent/.ssh is not looked for'],
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
      // #819 correction 1 (A MINOR 10): a side-effect import (`import './x.js'`) is followed too
      for (const m of src.matchAll(/(?:from|import\(?)\s*['"](\.{1,2}\/[^'"]+)\.js['"]/g)) {
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
    // #819 Unit A (A3): `<id> -G <NAME>`, id from a D2 folder (/usr/sbin on Fedora 44); never `-Gn`,
    // a relative id, or a second argument — those the runner refuses, never starting them
    const id = {
      admitted: [railOne(['/usr/bin/id', '-G', 'svc']), railOne(['/usr/sbin/id', '-G', 'svc'])],
      refused: [
        await systemRunner(['/usr/bin/id', '-Gn', 'svc']),
        await systemRunner(['id', '-G', 'svc']),
        await systemRunner(['/usr/bin/id', '-G', 'svc', 'root']),
      ],
    };
    // (a) red when the runner's check is removed (echo runs; doas is started), or the id shape is
    //     widened or narrowed; (b) prints the runner's answers and the doas reading's cause.
    expect({ refused, outside, id, doas: view(rs), cause: rs[0]?.cause }).toEqual({
      refused: { refused: '/bin/echo started' },
      outside: { refused: '/tmp/x/sudo -V' },
      id: {
        admitted: [true, true],
        refused: [
          { refused: '/usr/bin/id -Gn svc' },
          { refused: 'id -G svc' },
          { refused: '/usr/bin/id -G svc root' },
        ],
      },
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
      // #819 Unit B: through the renderer (its dedupe and "as above"), as the check builds it
      become_service_user: switchPathsReading(ways, 'svc'),
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
    // (a) red when a clause prints for a way that is not there (polkit's (d), ssh's (f); #819
    //     correction 1 C-10: (g) with no reading resting on a member list), or clause (c)'s old
    //     words come back; (b) prints the sentence.
    // #819 follow-up 2 re-pin: clause (c) also names tty_tickets, timestampdir and timestampowner (A S3)
    // #819 Unit A, the capped correction re-pin (Part 3; W-860-MA3-13): root's clause gains "and it
    // is not empty", read as this login's and svc's are
    expect(separationClaim(evidence(ways))).toBe(
      `${HEAD}; and provided the agent cannot obtain agent's password, and it is not empty; the agent cannot obtain svc's password, and it is not empty; the agent cannot obtain root's password, and it is not empty; nobody authenticates sudo as agent where the agent's processes run (it then waives the password for some minutes); and sudo turns off its password only through NOPASSWD tags (its listpw setting is the default, no Defaults!… or Defaults>… line sets !authenticate, no runaspw setting names a user other than root or svc, no pam_service, pam_login_service or pam_askpass_service setting names another PAM stack, no timestamp_type or tty_tickets setting shares one ticket across sessions, and no timestampdir or timestampowner setting lets agent write the tickets).`,
    );
  });

  /** W-x3b's machine: every way each clause guards (sudo, su, polkit, ssh). */
  const x3bWays = () =>
    paths(
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
          // #819 correction 1 (walk --check wording 6): the host's entry points, and systemd as PID 1
          programs: {
            '/usr/bin/pkcheck': 0,
            '/usr/lib/polkit-1/polkitd': 0,
            '/usr/bin/pkexec': 0,
            '/usr/bin/run0': 0,
            '/usr/bin/systemd-run': 0,
          },
          dirs: {
            '/usr/share/polkit-1/actions': ['org.freedesktop.systemd1.policy'],
            '/home/agent/.ssh': ['id_ed25519'],
            '/run/systemd/system': [],
          },
          calls: {
            '/usr/bin/pkcheck --action-id org.freedesktop.systemd1.manage-units --process 4242': `${U24}/pkcheck.stock.org.freedesktop.systemd1.manage-units`,
            '/usr/bin/pkcheck --action-id org.freedesktop.systemd1.reply-password --process 4242': `${U24}/pkcheck.active-yes.reply-password`,
          },
        }),
      ),
    );

  it('W-x3b: every way the clauses guard is found → every clause, (a) once per whose', async () => {
    const found = await x3bWays();
    // #819 correction 1 (C-10): and a second sudo's reading that rests on a group's listed members —
    // the Unit A correction re-pin (C2, the audit's S3): under `!case_insensitive_group`, where the
    // member list still decides (under the default flags it reads unknown: the twin below)
    const ways = [...found, ...(await groupBacked('!case_insensitive_group'))];
    // #819 follow-up 2 re-pin: clause (c) as in W-x3a (A S3); clause (g) words what the branch read,
    // the members each group lists (A S1)
    // (a) red when a fired clause is left out of the sentence; (b) prints the sentence.
    // #819 Unit A, the capped correction re-pin (Part 3; W-860-MA3-13): root's clause gains "and it
    // is not empty"
    expect(separationClaim(evidence(ways))).toBe(
      `${HEAD}; and provided the agent cannot obtain agent's password, and it is not empty; the agent cannot obtain svc's password, and it is not empty; the agent cannot obtain root's password, and it is not empty; the agent cannot obtain an administrator's password; nobody authenticates sudo or polkit as agent where the agent's processes run (each then waives the password for some minutes); sudo turns off its password only through NOPASSWD tags (its listpw setting is the default, no Defaults!… or Defaults>… line sets !authenticate, no runaspw setting names a user other than root or svc, no pam_service, pam_login_service or pam_askpass_service setting names another PAM stack, no timestamp_type or tty_tickets setting shares one ticket across sessions, and no timestampdir or timestampowner setting lets agent write the tickets); no polkit rule grants agent pkexec, run0 or systemd-run beyond what this check's own session was shown (polkit's admin rules are not read; its vendor rules are not read); no person approves a Touch ID, fingerprint or security-key prompt the agent raises; svc's authorized_keys holds none of agent's keys; and the members the system lists for each group read are all of its members (a member the system does not list is not seen).`,
    );
  });

  it('W-x3b’s twin, the Unit A correction (C2, the audit’s S3): the same ways, the group read under sudo’s default flags with no `id` → "may still", the case gap unknown', async () => {
    const ways = [...(await x3bWays()), ...(await groupBacked())];
    // (1) red when the group's member list decides under the default flags with no `id` (the strong
    //     sentence with clause (g): the walk's wrong "no", W-UA-MA3-02); (2) prints the sentence and
    //     the group reading's cause.
    expect({
      sentence: separationClaim(evidence(ways)),
      cause: ways.find((r) => r.outcome === 'unknown')?.cause,
    }).toEqual({
      sentence:
        "An agent running as agent may still be able to answer a gate: whether it can become Realm's service user without a password is unknown.",
      // #819 Unit A, the capped correction re-pin (the walk's wording item): the case cause names the
      // user, the group, and what lets the check read the groups
      cause:
        'sudo matches group names in any case, so svc may be in svcgrp under another case, and no id was found in the system folders (a root-owned id in a system folder lets this check read the groups)',
    });
  });

  it('the Unit A correction (C2): the typical server — classic sudo refused, su closed by svc’s shell — prints the same strong sentence with `id` absent as with it', async () => {
    const typical = async (over: MachineSpec) =>
      separationClaim(
        evidence(
          await paths(linux(U24, merge(merge(sudos(U24, 'password', ['sudo']), su(U24)), over))),
        ),
      );
    const withoutId = await typical({});
    // (1) red when the case gap reaches a way that reads no group (the refusal reads unknown with
    //     `id` absent); (2) prints the sentence and whether it is the same with `id`.
    expect({
      strong: withoutId.startsWith(`${HEAD};`),
      sameWithId: withoutId === (await typical({ programs: { '/usr/bin/id': 0 } })),
      sentence: withoutId.slice(0, HEAD.length),
    }).toEqual({ strong: true, sameWithId: true, sentence: HEAD });
  });

  it("#819 correction 1 C-20: clause (g) prints once when a reading rested on a group's listed members, and never for a run-as user, a group found by its gid, or this login's own groups", async () => {
    // the Unit A correction re-pin (C2, the audit's S3): the member list read under
    // `!case_insensitive_group`, where it still decides
    const grouped = await groupBacked('!case_insensitive_group');
    // (ii) the captured listing as it is, `(svc)`; (ii-b) `%svcgrp` with svc in it by its primary
    // gid (the captured svcgrp, gid 1100, svc's gid 1100)
    const plain = await paths(linux(U24, sudos(U24, 'third-nopasswd', ['sudo'])));
    const byGid = await (async () => {
      const machine = fixtureMachine(
        linux(
          U24,
          merge(sudos(U24, 'third-nopasswd', ['sudo']), {
            calls: {
              [`${GETENT} group svcgrp`]: `${U24}/getent.group.svcgrp`,
              // #819 follow-up 2 (member 3): svc's primary group by its gid (divergence 1)
              [`${GETENT} group 1100`]: `${U24}/getent.group.1100`,
            },
          }),
        ),
      );
      const run = machine.run;
      return measureSwitchPaths({
        probes: {
          ...machine,
          run: async (argv) => {
            const r = await run(argv);
            return argv.join(' ') === 'LC_ALL=C /usr/bin/sudo -n -ll' && 'exit' in r
              ? {
                  ...r,
                  stdout: r.stdout.replace('    RunAsUsers: svc\n', '    RunAsUsers: %svcgrp\n'),
                }
              : r;
          },
        },
        svc: 'svc',
      });
    })();
    // (iii) condition 3 read this login's own groups (the captured docker group lists no member, and
    // the login is not in it): no switch path rests on a member list
    const own = await rootEngineReach(
      lookups(
        fixtureMachine({
          programs: { [GETENT]: 0 },
          calls: Object.fromEntries(
            ROOT_GROUPS.map((g) => [`${GETENT} group ${g}`, `${U24}/getent.group.${g}.without`]),
          ),
        }),
      ),
    );
    // #819 follow-up 2 re-pin: clause (g)'s words (A S1) — was "the groups the system lists for svc
    // are all of its groups"
    const G =
      'the members the system lists for each group read are all of its members (a member the system does not list is not seen)';
    const count = (text: string) => text.split(G).length - 1;
    // (a) red: `grouped` when the trigger is not recorded on the reading (no clause); `byGid` when
    //     the clause is printed whenever a group was looked up; `plain` and `own` when it is printed
    //     unconditionally (W-x3a's break); (b) prints the reading, and the clause's count per case.
    expect({
      reading: view(grouped),
      grouped: count(separationClaim(evidence(grouped))),
      plain: count(separationClaim(evidence(plain))),
      byGid: count(separationClaim(evidence(byGid))),
      own: count(separationClaim(evidence([], { root_engine: own }))),
    }).toEqual({ reading: ['sudo not_allowed'], grouped: 1, plain: 0, byGid: 0, own: 0 });
  });

  it('P0: a way that reads unknown keeps the stronger sentence back — "may still", condition 2 not measured', async () => {
    const ways = await paths(linux(U25, sudos(U25, 'requiretty', ['sudo.ws'])));
    // (a) red when an unknown way lets the sentence print; (b) prints the sentence.
    // #819 Unit B re-pin (reversal 2): sudo was read and not settled — was "was not measured"
    expect(separationClaim(evidence(ways))).toBe(
      "An agent running as agent may still be able to answer a gate: whether it can become Realm's service user without a password is unknown.",
    );
  });

  it('01b #2: condition 2\'s line — "measured now", one entry per way, `⟨path⟩: ⟨outcome⟩ (⟨how⟩)`', async () => {
    const ways = await paths(linux(U24, merge(sudos(U24, 'password', ['sudo']), su(U24))));
    // (a) red when W's words come back ("(measured)", W's detail); #819 Unit B: when sudo's next
    //     two entries print its how again, not "as above"; (b) prints the line.
    // #819 Unit B re-pin: sudo's second and third entries were read as its first was — "; as above)"
    // #819 Unit A re-pin (A7): the cause names runaspw too, and whose password each asks for
    // #819 Unit A, the capped correction re-pin (Part 3): su gains its entry toward root
    expect(conditionLine('become_service_user', evidence(ways))).toBe(
      "This login can become Realm's service user (svc) without a password: no (measured now) — sudo: needs this login's password or is not allowed (sudo does not say which; LC_ALL=C /usr/bin/sudo -n -l says: a password is required; /etc/pam.d/sudo, /etc/pam.d/common-auth, /etc/pam.d/common-account, /etc/pam.d/common-session-noninteractive, /etc/pam.d/sudo-i, /etc/pam.d/common-session read); sudo: may need root's password (sudo does not show its Defaults or whether a rule exists, so rootpw, targetpw or runaspw cannot be ruled out: rootpw asks for root's password, targetpw for the target user's, runaspw for its runas_default user's; as above); sudo: may need svc's password (sudo does not show its Defaults or whether a rule exists, so rootpw, targetpw or runaspw cannot be ruled out: rootpw asks for root's password, targetpw for the target user's, runaspw for its runas_default user's; as above); su: not allowed (getent passwd svc and the shells files read: svc's shell /usr/sbin/nologin runs no command); su: needs root's password (/etc/pam.d/su, /etc/pam.d/common-auth, /etc/pam.d/common-account, /etc/pam.d/common-session, /etc/pam.d/su-l read).",
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
      // #819 Unit A, the capped correction re-pin (Part 5): yes needs a rule that runs as svc or root
      how: 'LC_ALL=C /usr/bin/sudo.ws -n -l and -n -ll: its Defaults turn the password off (!authenticate), and a rule runs as svc',
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
      how: "an sshd is present and this login may hold a key: its home's .ssh could not be listed",
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
    // #819 Unit A, the capped correction re-pin (Part 3): root's entry is read, so su toward root
    // needs root's password
    expect({ readings: view(rs), getent: rs[0]?.cause?.startsWith('getent passwd svc: ') }).toEqual(
      {
        readings: ['su unknown', 'su needs_credential root'],
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
        // #819 correction 1 (walk --check wording 6): systemd runs as PID 1, so manage-units is asked
        '/run/systemd/system': [],
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
    // (a) red when the folders are not read, or the entry points are not those of the actions asked
    //     (#819, 08 B F11: reply-password is a program pkexec runs; #819 correction 1, walk --check
    //     wording 6: of manage-units' entry points, only systemd-run is on this host — run0 is not);
    //     (b) prints the clause.
    expect(switchClausesOf(rs).find((c) => c.clause === 'd')).toEqual({
      clause: 'd',
      tools: ['pkexec', 'systemd-run'],
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
      how: 'an sshd is present; a key outside /home/agent/.ssh is not looked for',
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
    expect(rs[0]?.how).toBe('an sshd is present; a key outside /home/agent/.ssh is not looked for');
  });

  it('A Outside 2: `(%svcgrp)` with svcgrp listing no members, svc\'s primary group another → unknown, never "not covering"', async () => {
    const rs = await paths(
      linux(
        U25,
        merge(sudos(U25, 'pct-group', ['sudo.ws']), {
          calls: {
            [`${GETENT} passwd svc`]: `${U25}/getent.passwd.svc.own-group`,
            [`${GETENT} group svcgrp`]: `${U25}/getent.group.svcgrp.no-members`,
            // #819 follow-up 2 (member 3): svc's primary group by its gid (divergence 1)
            [`${GETENT} group 1300`]: `${U25}/getent.group.1300.own-group`,
          },
        }),
      ),
    );
    // (a) red when an empty member list reads as "svc is not in it" (the rule then covers no one:
    //     not allowed — a wrong "cannot" where SSSD hides the members); (b) prints readings, cause.
    expect({ readings: view(rs), cause: rs[0]?.cause }).toEqual({
      readings: ['sudo unknown'],
      // #819 Unit A re-pin (A9): was "is not known"
      cause: 'getent group svcgrp lists no members, so whether svc is in it is unknown',
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
    // #819 Unit A, the capped correction re-pin (Part 3): toward root too
    expect(view(rs)).toEqual(['su needs_credential svc', 'su needs_credential root']);
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

describe('#819 correction 1 — the separation half, each finding its cell', () => {
  const stack = (img: string, service: string, variant: string): MachineSpec => ({
    files: { [`/etc/pam.d/${service}`]: { fixture: `${img}/variant.${variant}` } },
  });
  const group = (img: string, name: string, fixture = name): MachineSpec => ({
    calls: { [`${GETENT} group ${name}`]: `${img}/getent.group.${fixture}` },
  });
  /** The ways read on `spec`'s machine, one captured call's stdout edited — the cut-capture
   *  standard (A F11): each edit is named beside its cell. */
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
  const LL24 = 'LC_ALL=C /usr/bin/sudo -n -ll';
  /** The base (SEP-02): Ubuntu 24.04's captured `third-nopasswd` listing (`-ll`) — stock Defaults, a
   *  NOPASSWD rule for `nobody` and a password rule `(svc) /usr/bin/realm` — edited per cell. */
  const third = (edit: (out: string) => string = (o) => o, over: MachineSpec = {}) =>
    edited(linux(U24, merge(sudos(U24, 'third-nopasswd', ['sudo']), over)), LL24, edit);
  /** Edits: Defaults items appended to the captured `use_pty` line; a `Runas and Command-specific
   *  defaults` section before the rules; the svc entry's run-as, and an `Options:` line under it. */
  const defaults =
    (...items: string[]) =>
    (out: string) =>
      out.replace('    use_pty\n', `    use_pty, ${items.join(', ')}\n`);
  const specific =
    (...lines: string[]) =>
    (out: string) =>
      out.replace(
        '\nUser agent may run',
        `\nRunas and Command-specific defaults for agent:\n${lines.map((l) => `    ${l}\n`).join('')}\nUser agent may run`,
      );
  const runAs = (users: string) => (out: string) =>
    out.replace('    RunAsUsers: svc\n', `    RunAsUsers: ${users}\n`);
  const options = (value: string) => (out: string) =>
    out.replace('    RunAsUsers: svc\n', `    RunAsUsers: svc\n    Options: ${value}\n`);
  const both =
    (...edits: ((out: string) => string)[]) =>
    (out: string) =>
      edits.reduce((o, e) => e(o), out);
  /** The base's own reading: this login's password, cached (the captured Ubuntu 24.04 stack). */
  const NEEDS = ['sudo needs_credential this_login sudo_timestamp'];
  const cause = async (rs: Promise<SwitchPathReading[]>) =>
    rs.then((r) => ({ readings: view(r), cause: r[0]?.cause }));

  it('C-0: the base reads "needs this login\'s password" today, so an unknown or a changed reading can show', async () => {
    // (a) red when the base's capture or the stock Defaults stop reading as measured; (b) prints it.
    expect(view(await third())).toEqual(NEEDS);
  });

  it('C-1 (A BLOCKING 1): a listed pam_askpass_service naming a stack that grants → yes, its stack named', async () => {
    // The captured listing (sudo.ws -ll, Ubuntu 25.10) with `Defaults pam_askpass_service=sudo-realm`
    // — a capture, not an edit (the capture of 2026-10-19 shows it prints as pam_service does); the
    // captured pam_wheel trust variant at /etc/pam.d/sudo-realm, and the captured sudo group.
    const rs = await paths(
      linux(
        U25,
        merge(
          merge(sudos(U25, 'askpass', ['sudo.ws']), stack(U25, 'sudo-realm', 'sudo-wheel-trust')),
          group(U25, 'sudo'),
        ),
      ),
    );
    // (a) red when pam_askpass_service is dropped from the stacks withPam scans (the reading is then
    //     this login's password, and the strong sentence can print); (b) prints readings and how.
    expect({ readings: view(rs), how: rs[0]?.how }).toEqual({
      readings: ['sudo yes'],
      how: 'LC_ALL=C /usr/bin/sudo.ws -n -l and -n -ll; /etc/pam.d/sudo, /etc/pam.d/common-auth, /etc/pam.d/common-account, /etc/pam.d/common-session-noninteractive, /etc/pam.d/sudo-i, /etc/pam.d/common-session, /etc/pam.d/sudo-realm read: auth sufficient pam_wheel.so trust use_uid group=sudo lets this login through without a password',
    });
  });

  it('C-1b: the same stack through pam_service → yes (the control: the stack grants)', async () => {
    const rs = await paths(
      linux(
        U25,
        merge(
          merge(
            sudos(U25, 'pam-service', ['sudo.ws']),
            stack(U25, 'sudo-realm', 'sudo-wheel-trust'),
          ),
          group(U25, 'sudo'),
        ),
      ),
    );
    // (a) red when the stack's grant line is removed (the yes is the stack's); (b) prints the readings.
    expect(view(rs)).toEqual(['sudo yes']);
  });

  it("C-2: a Defaults setting in no list (frobnicate=1) → unknown, with sudo's own item", async () => {
    // (a) red when every keyword is harmless (the three-kind check removed): the base's reading
    //     comes back; (b) prints readings and cause.
    expect(await cause(third(defaults('frobnicate=1')))).toEqual({
      readings: ['sudo unknown'],
      cause: 'sudo listed a Defaults setting this check does not read: frobnicate=1',
    });
  });

  it('C-3: timestampdir (the folder sudo trusts for tickets) → unknown', async () => {
    // (a) red when timestampdir is on the harmless list; (b) prints readings and cause.
    expect(await cause(third(defaults('timestampdir=/somewhere')))).toEqual({
      readings: ['sudo unknown'],
      cause: 'sudo listed a Defaults setting this check does not read: timestampdir=/somewhere',
    });
  });

  it("C-4: a credential keyword on the svc rule's command line (`Defaults!/usr/bin/realm rootpw`) → unknown, naming the line", async () => {
    // (a) red when the command-specific lines are not checked (the global reading, this login's
    //     password, comes back); (b) prints readings and cause.
    expect(await cause(third(specific('Defaults!/usr/bin/realm rootpw')))).toEqual({
      readings: ['sudo unknown'],
      cause:
        'sudo listed a Defaults setting this check does not read: Defaults!/usr/bin/realm rootpw',
    });
  });

  it('C-5: harmless forms — `!var`, `var+=`, `var-=`, `var=value`, and the two list options B1 lacked — read as the base', async () => {
    const rs = await third(
      defaults(
        '!visiblepw',
        'env_keep+="A"',
        'env_delete-="B"',
        'secure_path=/p',
        'requiretty',
        'log_servers=host',
        'passprompt_regex=x',
      ),
    );
    // (a) red, one break each: the `!` strip removed (`!visiblepw` unread); the `+=`/`-=` strip
    //     removed (`env_keep+="A"` unread); the `=…` strip removed (`secure_path=/p` unread);
    //     (b) prints the readings.
    expect(view(rs)).toEqual(NEEDS);
  });

  it('C-6 (01b #6): an item not read never shadows a yes — !authenticate, a NOPASSWD rule, a granting stack', async () => {
    const authOff = await third(defaults('!authenticate', 'frobnicate=1'));
    // the captured `nopasswd-all` listing (sudo -ll, Ubuntu 24.04), frobnicate=1 appended
    const nopasswd = await edited(
      linux(U24, sudos(U24, 'nopasswd-all', ['sudo'])),
      LL24,
      defaults('frobnicate=1'),
    );
    // pam_service=sudo-realm, the captured pam_wheel trust variant there, the captured sudo group
    const granting = await third(
      defaults('pam_service=sudo-realm', 'frobnicate=1'),
      merge(stack(U24, 'sudo-realm', 'sudo-wheel-trust'), group(U24, 'sudo')),
    );
    // (a) red: authOff and nopasswd when the unknown is returned before judge's yes exits; granting
    //     when it is applied before withPam; (b) prints the three.
    expect({
      authOff: view(authOff),
      nopasswd: view(nopasswd),
      granting: view(granting),
    }).toEqual({ authOff: ['sudo yes'], nopasswd: ['sudo yes'], granting: ['sudo yes'] });
  });

  it("C-7: the long format's Options — a value in no list → unknown; a tag's printed name (noexec) → as the base, and the captured `setenv, noexec`", async () => {
    // (b'): the captured `(svc) NOEXEC: SETENV: /usr/bin/realm` listing (sudo.ws -ll, Ubuntu 25.10,
    // 2026-10-19), which prints `Options: setenv, noexec`
    const captured = await paths(linux(U25, sudos(U25, 'tags', ['sudo.ws'])));
    // (a) red when the Options values are not checked (frobnicate reads as the base); (b) prints
    //     each reading and the cause.
    expect({
      unread: await cause(third(options('frobnicate'))),
      noexec: view(await third(options('noexec'))),
      captured: view(captured),
    }).toEqual({
      unread: {
        readings: ['sudo unknown'],
        cause: 'sudo listed an Options value this check does not read: frobnicate',
      },
      noexec: NEEDS,
      captured: ['sudo needs_credential this_login sudo_timestamp'],
    });
  });

  it('C-12: an item not read turns the not-allowed exit unknown', async () => {
    // (a) red when the not-allowed exit skips the composition; (b) prints both readings.
    expect({
      base: view(await third(runAs('nobody'))),
      unread: view(await third(both(runAs('nobody'), defaults('frobnicate=1')))),
    }).toEqual({ base: ['sudo not_allowed'], unread: ['sudo unknown'] });
  });

  it('C-13 (a): an acted-on keyword listed twice with different forms → unknown, both items named', async () => {
    // (a) red when the repeat rule is removed (rootpw is read: root's password); (b) prints readings
    //     and cause.
    expect(await cause(third(defaults('rootpw', '!rootpw')))).toEqual({
      readings: ['sudo unknown'],
      cause:
        'sudo listed a Defaults setting more than once, and does not show which one it applies: rootpw, !rootpw',
    });
  });

  it("C-14 (b): `timestamp_timeout=0` globally, `timestamp_timeout=5` on the svc rule's command → the ticket is kept (clause b)", async () => {
    const rs = await third(
      both(
        defaults('timestamp_timeout=0'),
        specific('Defaults!/usr/bin/realm timestamp_timeout=5'),
      ),
    );
    // (a) red when only the global section's timeout is read (no cache, no clause b); (b) prints
    //     readings and clauses.
    expect({ readings: view(rs), clauses: clauses(rs) }).toEqual({
      readings: NEEDS,
      clauses: ['a:this_login', 'b'],
    });
  });

  it('C-15 (c): group_plugin → unknown (a run-as %group may be resolved where getent cannot see)', async () => {
    // (a) red when group_plugin is on the harmless list; (b) prints readings and cause.
    expect(await cause(third(defaults('group_plugin=/usr/libexec/sudo/group_file.so')))).toEqual({
      readings: ['sudo unknown'],
      cause:
        'sudo listed a Defaults setting this check does not read: group_plugin=/usr/libexec/sudo/group_file.so',
    });
  });

  it('C-16 (d): one ticket for every session — timestamp_type=global, !tty_tickets → unknown; timestamp_type=tty → as the base', async () => {
    // (a) red when timestamp_type is harmless for every value (global reads as the base); (b) prints
    //     the three.
    expect({
      global: view(await third(defaults('timestamp_type=global'))),
      ttyOff: view(await third(defaults('!tty_tickets'))),
      tty: view(await third(defaults('timestamp_type=tty'))),
    }).toEqual({ global: ['sudo unknown'], ttyOff: ['sudo unknown'], tty: NEEDS });
  });

  it('C-17 (e): sudo matches run-as names in any case — `(Svc)` covers svc; not with !case_insensitive_user; an absent `%Svcgrp` is unknown', async () => {
    // getent passwd Svc and getent group Svcgrp: the captured "not there" answers (Ubuntu 24.04,
    // 2026-10-19)
    const lookupsOf: MachineSpec = {
      calls: {
        [`${GETENT} passwd Svc`]: `${U24}/getent.passwd.Svc.absent`,
        [`${GETENT} group Svcgrp`]: `${U24}/getent.group.Svcgrp.absent`,
      },
    };
    // #819 follow-up 2 (member 3; divergence 1): the group half's svc has another primary group
    // (svcown, gid 1300, captured), so `%Svcgrp` names none of svc's groups in any case — with the
    // base svc, whose primary group is svcgrp, it would now cover svc (the member-3 cell below)
    // #819 Unit A re-pin (A3, W-UA-AUD2-08): the group half's machine gains `id -G svc` (1300) and
    // `id -G root` from its own setup — `%Svcgrp` names none of svc's groups, read exactly as sudo
    // reads them (unknown → not allowed); the user and exact halves do not change
    const ownGroup: MachineSpec = {
      programs: { '/usr/bin/id': 0 },
      calls: {
        ...lookupsOf.calls,
        [`${GETENT} passwd svc`]: `${U24}/getent.passwd.svc.own-group`,
        [`${GETENT} group 1300`]: `${U24}/getent.group.1300.own-group`,
        [`${GETENT} group 0`]: `${U24}/getent.group.0`,
        '/usr/bin/id -G svc': `${U24}/id.G.svc.own-group`,
        '/usr/bin/id -G root': `${U24}/id.G.root`,
      },
    };
    // (a) red: `user` when names are compared exactly (not allowed); `group` when an absent group
    //     reads "not a member" (not allowed); (b) prints the readings and the group's cause.
    expect({
      user: view(await third(runAs('Svc'), lookupsOf)),
      exact: view(await third(both(runAs('Svc'), defaults('!case_insensitive_user')), lookupsOf)),
      group: await cause(third(runAs('%Svcgrp'), ownGroup)),
    }).toEqual({
      user: NEEDS,
      exact: ['sudo not_allowed'],
      group: { readings: ['sudo not_allowed'], cause: undefined },
    });
  });

  describe('C-18 (f): the group source — a member list is trusted only from a local source', () => {
    /** The svc rule's run-as edited to `%svcgrp`; svcgrp lists alice, not svc, and svc's primary
     *  group is svcown (the captures of 2026-10-19, Ubuntu 24.04). */
    // the Unit A correction re-pin (C2, the audit's S3): read under `!case_insensitive_group`, where
    // the member list still decides (under the default flags, with no `id`, it reads unknown)
    const grouped = (over: MachineSpec = {}) =>
      third(
        both(runAs('%svcgrp'), defaults('!case_insensitive_group')),
        merge(
          {
            calls: {
              [`${GETENT} group svcgrp`]: `${U24}/getent.group.svcgrp.others`,
              [`${GETENT} passwd svc`]: `${U24}/getent.passwd.svc.own-group`,
              // #819 follow-up 2 (member 3): svc's primary group by its gid (divergence 1)
              [`${GETENT} group 1300`]: `${U24}/getent.group.1300.own-group`,
            },
          },
          over,
        ),
      );
    const nss = (text: string): MachineSpec => ({ files: { '/etc/nsswitch.conf': text } });
    const SSS = '/var/lib/sss/pipes/nss';

    it('local lines, an absent file and a file with no group: line → as today (not allowed); ldap, and sss while its socket is there → unknown', async () => {
      const ldap = await cause(grouped(nss('group: files ldap\n')));
      // (a) red, one break each: `ldap` when the source rule is removed (not allowed); `merge` when
      //     the bracket skip is removed (unknown); `sssAbsent` when the socket check is removed
      //     (unknown); `hostsOnly` when a file with no group: line is not the files source
      //     (unknown); (b) prints each reading, and ldap's cause.
      expect({
        filesSystemd: view(await grouped(nss('group:          files systemd\n'))),
        merge: view(await grouped(nss('group:      files [SUCCESS=merge] systemd\n'))),
        ldap,
        sssAbsent: view(await grouped(nss('group: files sss\n'))),
        sssPresent: view(
          await grouped(merge(nss('group: files sss\n'), { sockets: { [SSS]: false } })),
        ),
        noFile: view(await grouped()),
        hostsOnly: view(await grouped(nss('hosts: files dns\n'))),
      }).toEqual({
        filesSystemd: ['sudo not_allowed'],
        merge: ['sudo not_allowed'],
        ldap: {
          readings: ['sudo unknown'],
          cause:
            "/etc/nsswitch.conf lists ldap for groups, so svc's membership of svcgrp may not all be listed",
        },
        sssAbsent: ['sudo not_allowed'],
        sssPresent: ['sudo unknown'],
        noFile: ['sudo not_allowed'],
        hostsOnly: ['sudo not_allowed'],
      });
    });

    it("(vi): condition 3 — this login's own groups — is decided by its process ids, whatever the group source", async () => {
      // Ubuntu 24.04's captured docker group (no member listed), the login in it by its process
      // gid 1101, and every other root group captured without it
      const spec = merge(
        {
          programs: { [GETENT]: 0 },
          calls: Object.fromEntries(
            ROOT_GROUPS.map((g) => [`${GETENT} group ${g}`, `${U24}/getent.group.${g}.without`]),
          ),
          groups: [1001, 1101],
        },
        nss('group: files ldap\n'),
      );
      // (a) red when the source rule reaches this login's own groups (condition 3 unknown); (b)
      //     prints the reading.
      expect(await rootEngineReach(lookups(fixtureMachine(spec)))).toEqual({
        basis: 'measured',
        answer: 'yes',
        detail: 'this login is in the group docker',
      });
    });

    it('(vii): the five stock files, as captured — their group: lines, and none reads unknown', async () => {
      const images = [U24, U25, DEB, FED, ALP];
      const lines = Object.fromEntries(
        images.map((img) => [
          img,
          /^\s*group\s*:\s*(.*?)\s*$/m.exec(fixtureFile(`${img}/nsswitch.conf`))?.[1] ?? 'none',
        ]),
      );
      const readings: Record<string, string[]> = {};
      for (const img of images) {
        readings[img] = view(
          await grouped({ files: { '/etc/nsswitch.conf': { fixture: `${img}/nsswitch.conf` } } }),
        );
      }
      // (a) red when a stock line reads unknown (the STOP point, SEP-00 (f)) or a captured line
      //     differs from MA 3's reading (W-829-MA3-04); (b) prints each image's line and reading.
      expect({ lines, readings }).toEqual({
        lines: {
          [U24]: 'files',
          [U25]: 'files',
          [DEB]: 'files',
          [FED]: 'files [SUCCESS=merge] systemd',
          [ALP]: 'none',
        },
        readings: Object.fromEntries(images.map((img) => [img, ['sudo not_allowed']])),
      });
    });
  });

  it("A MINOR 1: a cover read for root never drops svc's unknown — `(%root)` under targetpw, svc a hidden member", async () => {
    // The svc rule's run-as edited to `%root`, targetpw appended; root's group and svc's own-group
    // entry are the captures of 2026-10-19 (Ubuntu 24.04): `root:x:0:` lists no member
    const rs = await third(both(runAs('%root'), defaults('targetpw')), {
      calls: {
        [`${GETENT} group root`]: `${U24}/getent.group.root`,
        [`${GETENT} passwd svc`]: `${U24}/getent.passwd.svc.own-group`,
        // #819 follow-up 2 (member 3): svc's primary group by its gid (divergence 1)
        [`${GETENT} group 1300`]: `${U24}/getent.group.1300.own-group`,
      },
    });
    // (a) red when root's cover drops svc's unknown (root's password only); (b) prints readings and
    //     cause.
    expect(await cause(Promise.resolve(rs))).toEqual({
      readings: ['sudo unknown'],
      // #819 Unit A re-pin (A9): was "is not known"
      cause: 'getent group root lists no members, so whether svc is in it is unknown',
    });
  });
});

describe("#819 correction 1 — SEP-01's items, each its cell", () => {
  it('A MINOR 3: an sshd found only on PATH, or only by its sshd.socket unit → ssh listed, clause (f)', async () => {
    const onPath = await paths({
      env: { PATH: '/opt/openssh/sbin:/usr/bin' },
      programs: { '/opt/openssh/sbin/sshd': 0 },
    });
    const socketOnly = await paths({ files: { '/usr/lib/systemd/system/sshd.socket': '' } });
    // (a) red: `onPath` when sshd is looked for in D2's folders alone; `socketOnly` when sshd.socket
    //     is not one of the units; (b) prints both readings and their clauses.
    expect({
      onPath: { readings: view(onPath), clauses: clauses(onPath) },
      socketOnly: { readings: view(socketOnly), clauses: clauses(socketOnly) },
    }).toEqual({
      onPath: { readings: ['ssh needs_credential'], clauses: ['f'] },
      socketOnly: { readings: ['ssh needs_credential'], clauses: ['f'] },
    });
  });

  it("A MINOR 3: the no-way line names sshd's units by name, beside the folders", () => {
    const line = switchPathsReading([], 'svc');
    // (a) red when the units are not named; (b) prints the line's detail.
    expect(line.basis === 'measured' ? line.detail : line).toBe(
      "no sudo, su, doas, polkit or ssh way was found in /usr/bin, /usr/sbin, /usr/local/bin, /usr/local/sbin, /bin, /sbin, /run/wrappers/bin, /run/setuid-programs or on PATH (polkitd also at /usr/lib/polkit-1/polkitd, /usr/libexec/polkitd, /usr/lib/policykit-1/polkitd; sshd's units ssh.socket, sshd.socket, ssh.service, sshd.service in /etc/systemd/system, /run/systemd/system, /usr/lib/systemd/system, /lib/systemd/system)",
    );
  });

  it('A MINOR 4: with Realm\'s service user root and only rootpw, (a) is said for it with "and it is not empty", and the rule runs as root once', async () => {
    const ways = await paths(linux(U25, sudos(U25, 'rootpw', ['sudo.ws'])), 'root');
    const claim = separationClaim({
      login: 'agent',
      service_user: 'root',
      store_owned_by_other: true,
      owns_store: false,
      conditions: {
        store_reach: { basis: 'measured', answer: 'no' },
        become_service_user: switchPathsReading(ways, 'root'),
        root_engine: { basis: 'measured', answer: 'no' },
        trust_root_writable: { basis: 'measured', answer: 'no' },
        other_answer_host: { basis: 'unknown', cause: 'one look' },
        time_basis: { basis: 'measured', answer: 'fact', detail: 'clock' },
        agent_sandbox: { basis: 'measured', answer: 'no' },
        economics_writable: { basis: 'measured', answer: 'fact', detail: 'none' },
      },
      switch_paths: ways,
      value: { value: 'withheld', source: { kind: 'flag', ref: '--gate-answers' } },
    });
    // (a) red: `notEmpty` when root's password is not mapped to the service user's before the
    //     clauses are de-duplicated; `how` when runsAs names root twice; (b) prints both.
    expect({
      notEmpty: claim.includes("the agent cannot obtain root's password, and it is not empty"),
      how: ways[0]?.how,
    }).toEqual({
      notEmpty: true,
      how: 'LC_ALL=C /usr/bin/sudo.ws -n -l and -n -ll: a rule runs as root with a password (Defaults rootpw); /etc/pam.d/sudo, /etc/pam.d/common-auth, /etc/pam.d/common-account, /etc/pam.d/common-session-noninteractive, /etc/pam.d/sudo-i, /etc/pam.d/common-session read',
    });
  });

  describe('polkit: guessed readings say "may need"; each action is asked only where the host has a way to it', () => {
    const POLICY = '/usr/share/polkit-1/actions';
    /** Ubuntu 24.04's captured polkit pieces: pkcheck, polkitd, the systemd1 and policykit
     *  policies, and pkcheck's captured stock answers. */
    const polkit = (over: MachineSpec): MachineSpec =>
      merge(
        {
          programs: { '/usr/bin/pkcheck': 0, '/usr/lib/polkit-1/polkitd': 0 },
          dirs: {
            [POLICY]: ['org.freedesktop.policykit.policy', 'org.freedesktop.systemd1.policy'],
          },
          files: {
            [`${POLICY}/org.freedesktop.systemd1.policy`]: {
              fixture: `${U24}/policy.org.freedesktop.systemd1`,
            },
            [`${POLICY}/org.freedesktop.policykit.policy`]: {
              fixture: `${U24}/policy.org.freedesktop.policykit`,
            },
          },
          calls: {
            '/usr/bin/pkcheck --action-id org.freedesktop.systemd1.manage-units --process 4242': `${U24}/pkcheck.stock.org.freedesktop.systemd1.manage-units`,
            '/usr/bin/pkcheck --action-id org.freedesktop.policykit.exec --process 4242': `${U24}/pkcheck.stock.org.freedesktop.policykit.exec`,
            '/usr/bin/pkcheck --action-id org.freedesktop.systemd1.reply-password --process 4242': `${U24}/pkcheck.active-yes.reply-password`,
          },
        },
        over,
      );
    const askedNow = () =>
      asked
        .filter((a) => a[0] === '/usr/bin/pkcheck')
        .map((a) => a[2]!.replace(/^org\.freedesktop\./, ''));

    it('walk --check wording 6: no pkexec, no machinectl, systemd not PID 1 → nothing asked; systemd PID 1 alone → manage-units only, named by its id', async () => {
      const none = await paths(polkit({}));
      const noneAsked = askedNow();
      asked.length = 0;
      const booted = await paths(polkit({ dirs: { '/run/systemd/system': [] } }));
      const bootedAsked = askedNow();
      // (a) red when every action D9 names is asked whatever the host has (`noneAsked` then lists
      //     them), or manage-units is named by entry points the host lacks; (b) prints the actions
      //     asked and clause (d)'s tools.
      expect({
        noneAsked,
        none: view(none),
        bootedAsked,
        tools: switchClausesOf(booted).find((c) => c.clause === 'd'),
      }).toEqual({
        noneAsked: [],
        none: ['polkit not_allowed'],
        bootedAsked: ['systemd1.manage-units'],
        tools: {
          clause: 'd',
          tools: ['org.freedesktop.systemd1.manage-units'],
          admin: 'unread',
          vendor: 'unread',
        },
      });
    });

    it('A MINOR 5: both credentials pkcheck\'s challenge suggests read "may need" — an unreadable rule may change whose it asks, whatever the defaults name', async () => {
      // pkexec present: its action's stock answer is exit 2 (a challenge), and its defaults
      // auth_admin* — the administrator's password is named by the defaults too, yet a rule this
      // check cannot read may change whose the challenge asks (reader A's MINOR 5: both readings)
      const rs = await paths(polkit({ programs: { '/usr/bin/pkexec': 0 } }));
      // (a) red when the challenge's guess carries no cause (both print "needs"), or only the whose
      //     no default names carries it (the administrator's then prints "needs"); (b) prints each
      //     reading's entry word.
      expect(rs.map((r) => switchPathEntry(r, 'svc').split(' (')[0])).toEqual([
        "polkit: may need an administrator's password",
        "polkit: may need this login's password",
      ]);
    });
  });
});

describe('#819 follow-up 2 — the class: what the check reads, read as the system reads it, or unknown', () => {
  /** Ubuntu 24.04's captured `third-nopasswd` listing (classic sudo, `-ll`), one captured call's
   *  stdout edited per cell — the cut-capture standard: each edit is named beside its cell. */
  const LL24 = 'LC_ALL=C /usr/bin/sudo -n -ll';
  const third = (edit: (out: string) => string = (o) => o, over: MachineSpec = {}) => {
    const machine = fixtureMachine(linux(U24, merge(sudos(U24, 'third-nopasswd', ['sudo']), over)));
    const run = machine.run;
    return measureSwitchPaths({
      probes: {
        ...machine,
        run: async (argv) => {
          const r = await run(argv);
          return argv.join(' ') === LL24 && 'exit' in r ? { ...r, stdout: edit(r.stdout) } : r;
        },
      },
      svc: 'svc',
    });
  };
  const defaults =
    (...items: string[]) =>
    (out: string) =>
      out.replace('    use_pty\n', `    use_pty, ${items.join(', ')}\n`);
  const runAs = (users: string, options?: string) => (out: string) =>
    out.replace(
      '    RunAsUsers: svc\n',
      `    RunAsUsers: ${users}\n${options !== undefined ? `    Options: ${options}\n` : ''}`,
    );
  const specific = (line: string) => (out: string) =>
    out.replace(
      '\nUser agent may run',
      `\nRunas and Command-specific defaults for agent:\n    ${line}\n\nUser agent may run`,
    );
  const both =
    (...edits: ((out: string) => string)[]) =>
    (out: string) =>
      edits.reduce((o, e) => e(o), out);
  const calls = (m: Record<string, string>): MachineSpec => ({
    calls: Object.fromEntries(Object.entries(m).map(([k, v]) => [`${GETENT} ${k}`, `${U24}/${v}`])),
  });
  const NEEDS = ['sudo needs_credential this_login sudo_timestamp'];
  const read = async (rs: Promise<SwitchPathReading[]>) =>
    rs.then((r) => ({ readings: view(r), cause: r[0]?.cause }));

  describe('member 1 (A B1): machine1’s shells, asked wherever systemd runs as PID 1', () => {
    const POLICY = '/usr/share/polkit-1/actions';
    /** Ubuntu 24.04's captured machine1 policy and pkcheck's captured stock answers for its two
     *  shells (exit 2, a challenge); no machinectl on PATH. */
    const machined = (over: MachineSpec = {}): MachineSpec =>
      merge(
        {
          programs: { '/usr/bin/pkcheck': 0, '/usr/lib/polkit-1/polkitd': 0 },
          dirs: { [POLICY]: ['org.freedesktop.machine1.policy'] },
          files: {
            [`${POLICY}/org.freedesktop.machine1.policy`]: {
              fixture: `${U24}/policy.org.freedesktop.machine1`,
            },
          },
          calls: {
            '/usr/bin/pkcheck --action-id org.freedesktop.machine1.shell --process 4242': `${U24}/pkcheck.stock.org.freedesktop.machine1.shell`,
            '/usr/bin/pkcheck --action-id org.freedesktop.machine1.host-shell --process 4242': `${U24}/pkcheck.stock.org.freedesktop.machine1.host-shell`,
          },
        },
        over,
      );
    const askedNow = () =>
      asked
        .filter((a) => a[0] === '/usr/bin/pkcheck')
        .map((a) => a[2]!.replace(/^org\.freedesktop\./, ''));

    it('systemd as PID 1, no machinectl → both shells asked, each named by its id; not PID 1 → nothing asked', async () => {
      const booted = await paths(machined({ dirs: { '/run/systemd/system': [] } }));
      const bootedAsked = askedNow();
      asked.length = 0;
      const notBooted = await paths(machined());
      // (a) red when machine1's shells are asked only where machinectl is (nothing asked, "not
      //     allowed" — a wrong "cannot": busctl or gdbus reach OpenMachineShell), or are named by an
      //     entry point the host lacks; (b) prints the readings, the actions asked and clause (d).
      expect({
        booted: view(booted),
        bootedAsked,
        tools: switchClausesOf(booted).find((c) => c.clause === 'd'),
        notBooted: view(notBooted),
        notBootedAsked: askedNow(),
      }).toEqual({
        booted: [
          'polkit needs_credential administrator polkit_keep',
          'polkit needs_credential this_login polkit_keep',
        ],
        bootedAsked: ['machine1.shell', 'machine1.host-shell'],
        tools: {
          clause: 'd',
          tools: ['org.freedesktop.machine1.shell', 'org.freedesktop.machine1.host-shell'],
          admin: 'unread',
          vendor: 'unread',
        },
        notBooted: ['polkit not_allowed'],
        notBootedAsked: [],
      });
    });
  });

  describe('member 2 (A B2, the audit’s S1): /etc/nsswitch.conf read as glibc reads it, or unknown', () => {
    /** C-18's base: the svc rule's run-as edited to `%svcgrp`; svcgrp lists alice, not svc; svc's
     *  primary group is svcown (the captures of 2026-10-19 and 2026-10-20). */
    // the Unit A correction re-pin (C2, the audit's S3): read under `!case_insensitive_group`
    const grouped = (nss: string, over: MachineSpec = {}) =>
      read(
        third(
          both(runAs('%svcgrp'), defaults('!case_insensitive_group')),
          merge(
            merge(
              calls({
                'group svcgrp': 'getent.group.svcgrp.others',
                'passwd svc': 'getent.passwd.svc.own-group',
                'group 1300': 'getent.group.1300.own-group',
              }),
              { files: { '/etc/nsswitch.conf': nss } },
            ),
            over,
          ),
        ),
      );
    const cannot = (why: string, line: string) => ({
      readings: ['sudo unknown'],
      // #819 Unit A re-pin (A9): was "is not known"
      cause: `/etc/nsswitch.conf has ${why}, so where groups are listed from is unknown: ${line}`,
    });

    it('P4: a second group line (glibc keeps the last) → unknown', async () => {
      // (a) red when the second line goes unread (the first, `files`, decides: not allowed); (b)
      //     prints the reading and its cause.
      expect(await grouped('group: files\ngroup: files ldap\n')).toEqual(
        cannot('a second group line', 'group: files ldap'),
      );
    });
    it('P5: a group line with no `:` (glibc reads it) → unknown', async () => {
      // (a) red when a line with no `:` is not judged (no group line: not allowed); (b) prints it.
      expect(await grouped('group files ldap\n')).toEqual(
        cannot('no : after the group name', 'group files ldap'),
      );
    });
    it('P6: an initgroups line (getgrouplist reads it) → classed like the group line: ldap there → unknown', async () => {
      // (a) red when the initgroups line is not read (group: files decides: not allowed); (b)
      //     prints the reading and its cause.
      expect(await grouped('group: files\ninitgroups: files ldap\n')).toEqual({
        readings: ['sudo unknown'],
        cause:
          "/etc/nsswitch.conf lists ldap for initgroups, so svc's membership of svcgrp may not all be listed",
      });
    });
    it('P7: a `#` after the group name (glibc strips no trailing comment) → unknown', async () => {
      // (a) red when a trailing `#…` is stripped (`files` alone: not allowed); (b) prints it.
      expect(await grouped('group: files # ldap\n')).toEqual(
        cannot('a # after the group name', 'group: files # ldap'),
      );
    });
    it('controls: one group and one initgroups line, both local; a comment line; bracketed actions → as today (not allowed); an unclosed bracket, or GROUP in capitals naming ldap → unknown', async () => {
      // (a) red per row: `oneOfEach` when one of each counts as a second; `comment` when a line
      //     starting with `#` is read; `brackets` when bracketed actions are read as sources;
      //     `unclosed` when an unsplittable line is read; `capitals` when the name is matched in one
      //     case only; (b) prints each reading.
      expect({
        oneOfEach: (await grouped('group: files\ninitgroups: files\n')).readings,
        comment: (await grouped('# group: ldap\ngroup: files\n')).readings,
        brackets: (await grouped('group: files [NOTFOUND=return] systemd\n')).readings,
        unclosed: (await grouped('group: files [NOTFOUND=return systemd\n')).readings,
        capitals: (await grouped('group: files\nGROUP: ldap\n')).readings,
      }).toEqual({
        oneOfEach: ['sudo not_allowed'],
        comment: ['sudo not_allowed'],
        brackets: ['sudo not_allowed'],
        unclosed: ['sudo unknown'],
        capitals: ['sudo unknown'],
      });
    });
  });

  describe('member 8 (the audit’s S9): no group line, and nscd’s socket there (musl asks nscd)', () => {
    // the Unit A correction re-pin (C2, the audit's S3): read under `!case_insensitive_group`
    const grouped = (spec: MachineSpec) =>
      read(
        third(
          both(runAs('%svcgrp'), defaults('!case_insensitive_group')),
          merge(
            calls({
              'group svcgrp': 'getent.group.svcgrp.others',
              'passwd svc': 'getent.passwd.svc.own-group',
              'group 1300': 'getent.group.1300.own-group',
            }),
            spec,
          ),
        ),
      );
    it('no group line, or no file, with /var/run/nscd/socket there → unknown; without the socket → as today (not allowed)', async () => {
      const nscd = { sockets: { '/var/run/nscd/socket': false } };
      // (a) red when a file with no group line, or no file, is the files source while nscd's socket
      //     is there (not allowed — musl's lookups go to nscd); (b) prints each reading and the cause.
      expect({
        hostsOnly: await grouped(
          merge({ files: { '/etc/nsswitch.conf': 'hosts: files dns\n' } }, nscd),
        ),
        noFile: (await grouped(nscd)).readings,
        noSocket: (await grouped({ files: { '/etc/nsswitch.conf': 'hosts: files dns\n' } }))
          .readings,
      }).toEqual({
        hostsOnly: {
          readings: ['sudo unknown'],
          cause:
            '/var/run/nscd/socket is there and /etc/nsswitch.conf lists no group line, so groups may be listed from nscd',
        },
        noFile: ['sudo unknown'],
        noSocket: ['sudo not_allowed'],
      });
    });
  });

  describe('member 3 (A B3, A S2, the audit’s S2 and S3): run-as group names matched as sudo matches them', () => {
    it('the audit’s S2 (Q1a): `%svcgrp` while svc’s primary group is SVCGRP (captured) → covers svc, as sudo’s any-case match does', async () => {
      const rs = await third(
        runAs('%svcgrp'),
        calls({
          'passwd svc': 'getent.passwd.svc.primary-SVCGRP',
          'group svcgrp': 'getent.group.svcgrp.primary-SVCGRP',
          'group 1300': 'getent.group.1300.primary-SVCGRP',
        }),
      );
      // (a) red when svc's primary group name is not compared in any case (not allowed, clause g);
      //     (b) prints the readings.
      expect(view(rs)).toEqual(NEEDS);
    });
    it('the audit’s S2: `%Svcgrp`, absent, while svc’s primary group is svcgrp (captured) → covers svc', async () => {
      const rs = await third(
        runAs('%Svcgrp'),
        calls({ 'group Svcgrp': 'getent.group.Svcgrp.absent', 'group 1100': 'getent.group.1100' }),
      );
      // (a) red when the primary group's name is not compared (unknown: an absent group); (b)
      //     prints the readings.
      expect(view(rs)).toEqual(NEEDS);
    });
    it('A B3: `%SVCGRP` names a distinct group (alice only) while svc is in svcgrp by a secondary membership (captured) → unknown', async () => {
      const rs = read(
        third(
          runAs('%SVCGRP'),
          calls({
            'passwd svc': 'getent.passwd.svc.b3',
            'group SVCGRP': 'getent.group.SVCGRP.b3',
            'group 1300': 'getent.group.1300.b3',
          }),
        ),
      );
      // (a) red when a name with capitals is taken as exactly getent's group (not allowed — sudo
      //     matches it with svcgrp in any case); (b) prints the reading and its cause.
      expect(await rs).toEqual({
        readings: ['sudo unknown'],
        cause:
          'getent group SVCGRP reads only the group of that exact case, and sudo matches group names in any case (case_insensitive_group, on by default)',
      });
    });
    // #819 Unit A re-pin (A3, W-UA-AUD2-07): the machine gains `id -G svc` from its own setup
    // (1300 1500, captured 2026-10-22) — svc's SVCGRP matches `%svcgrp` in any case, as sudo matches
    // it: item 2 fixed, sudo still asking for a password (not allowed, clause g → needs a password)
    it('the audit’s S2, recorded (Q1b), Unit A (A3): svc listed in SVCGRP, `%svcgrp` naming only alice’s → covered, as sudo reads it; the rule needs a password', async () => {
      const rs = await third(
        runAs('%svcgrp'),
        merge(
          calls({
            'passwd svc': 'getent.passwd.svc.secondary-SVCGRP',
            'group svcgrp': 'getent.group.svcgrp.secondary-SVCGRP',
            'group 1300': 'getent.group.1300.secondary-SVCGRP',
            'group 1500': 'getent.group.1500.secondary-SVCGRP',
            'group 0': 'getent.group.0',
          }),
          {
            programs: { '/usr/bin/id': 0 },
            calls: {
              '/usr/bin/id -G svc': `${U24}/id.G.svc.secondary-SVCGRP`,
              '/usr/bin/id -G root': `${U24}/id.G.root`,
            },
          },
        ),
      );
      // (a) red when the group is read from its listed members again (not allowed, clause g); (b)
      //     prints the readings and the clauses.
      expect({ readings: view(rs), clauses: switchClausesOf(rs).map((c) => c.clause) }).toEqual({
        readings: ['sudo needs_credential this_login sudo_timestamp'],
        clauses: ['a', 'b'],
      });
    });
    it('A S2: under match_group_by_gid an absent `%Svcgrp` is not a member (sudo matches exactly); listed with !match_group_by_gid too → unknown (the audit’s S3)', async () => {
      const lookupsOf = calls({
        'group Svcgrp': 'getent.group.Svcgrp.absent',
        'group 1100': 'getent.group.1100',
      });
      // (a) red: `byGid` when match_group_by_gid leaves the any-case rule on (unknown), or the
      //     primary group is compared in any case (covered); `twice` when match_group_by_gid is
      //     harmless, so its repeat goes unread (not allowed); (b) prints both.
      expect({
        byGid: await read(third(both(runAs('%Svcgrp'), defaults('match_group_by_gid')), lookupsOf)),
        twice: await read(
          third(
            both(runAs('%Svcgrp'), defaults('match_group_by_gid', '!match_group_by_gid')),
            lookupsOf,
          ),
        ),
      }).toEqual({
        byGid: { readings: ['sudo not_allowed'], cause: undefined },
        twice: {
          readings: ['sudo unknown'],
          // #819 Unit A, the capped correction re-pin (the walk's wording item): no stock line off
          // Fedora and Rocky Linux
          cause:
            'sudo listed a Defaults setting more than once, and does not show which one it applies: match_group_by_gid, !match_group_by_gid (keep one of them; on Fedora and Rocky Linux, change the stock line instead of adding a second)',
        },
      });
    });
  });

  describe('member 4 (#838 row 1, the audit’s S4): exempt_group compared with this login’s group names as sudo compares them', () => {
    /** The exempt setup (captured 2026-10-20): agent in sudo (gid 27) and in SUDO (gid 1400). */
    it('P2: `exempt_group=Sudo`, this login in sudo by its gid → yes; `exempt_group=sudo`, its group named SUDO → yes', async () => {
      const p2 = await third(defaults('exempt_group=Sudo'), {
        groups: [1001, 27],
        ...calls({
          'group Sudo': 'getent.group.Sudo.absent',
          'group 27': 'getent.group.27.with-agent',
          'group 1001': 'getent.group.1001',
        }),
      });
      const upper = await third(defaults('exempt_group=sudo'), {
        groups: [1001, 1400],
        ...calls({
          'group sudo': 'getent.group.sudo.without',
          'group 1001': 'getent.group.1001',
          'group 1400': 'getent.group.1400.SUDO',
        }),
      });
      // (a) red when exempt_group is looked up by its exact name only (each reads "needs this
      //     login's password" — a wrong "cannot": sudo exempts the login); (b) prints both.
      expect({ p2: view(p2), upper: view(upper) }).toEqual({
        p2: ['sudo yes'],
        upper: ['sudo yes'],
      });
    });
    it('controls: under match_group_by_gid `exempt_group=Sudo` is matched exactly → as the base; a gid getent names no group for → yes ("may be in it")', async () => {
      const byGid = await third(defaults('exempt_group=Sudo', 'match_group_by_gid'), {
        groups: [1001, 27],
        ...calls({
          'group Sudo': 'getent.group.Sudo.absent',
          'group 27': 'getent.group.27.with-agent',
          'group 1001': 'getent.group.1001',
        }),
      });
      const unnamed = await third(defaults('exempt_group=sudo'), {
        groups: [1001, 4242],
        ...calls({
          'group sudo': 'getent.group.sudo.without',
          'group 1001': 'getent.group.1001',
          'group 4242': 'getent.group.4242.absent',
        }),
      });
      // (a) red: `byGid` when names are matched in any case under match_group_by_gid (yes); `unnamed`
      //     when a gid getent cannot name reads "not in it" (needs a password); (b) prints both.
      expect({ byGid: view(byGid), unnamed: view(unnamed) }).toEqual({
        byGid: NEEDS,
        unnamed: ['sudo yes'],
      });
    });
  });

  describe('member 5 (A Q3’s P1, the audit’s S8): `#uid` and `%#gid` read as numbers; a `#` runas_default is a name sudo cannot find (follow-up 3)', () => {
    it('P1: `(#0999)` with !authenticate → yes; `Defaults>#0999 !authenticate` → yes', async () => {
      // (a) red when `#0999` is compared as text with `#999` (not allowed — sudo reads 999); (b)
      //     prints both.
      expect({
        runAs: view(await third(runAs('#0999', '!authenticate'))),
        specific: view(await third(specific('Defaults>#0999 !authenticate'))),
      }).toEqual({ runAs: ['sudo yes'], specific: ['sudo yes'] });
    });
    it('Q2: `(%#01400)` with !authenticate, svc’s gid 1400 with no group entry (captured) → yes', async () => {
      const rs = await third(
        runAs('%#01400', '!authenticate'),
        calls({
          'passwd svc': 'getent.passwd.svc.gid-1400-no-group',
          'group 01400': 'getent.group.01400.absent',
          'group 1400': 'getent.group.1400.absent',
        }),
      );
      // (a) red when a `%#gid` with no group entry is compared as text (not allowed); (b) prints it.
      expect(view(rs)).toEqual(['sudo yes']);
    });
    it('#819 follow-up 3 (A S1, the audit’s S3): runaspw with a `#0` runas_default → unknown — sudo looks #0 up as a user name and refuses every command', async () => {
      // #819 Unit A, the capped correction re-pin (the walk's wording item): in plain words
      const CAUSE =
        'sudo looks #0 up as a user name, finds none and refuses every command (Defaults runaspw); this check reads that as unknown, not as proof that no way works';
      // (a) the raw `#0` (a shape sudo never prints): red when `#0` is read as root's uid again
      //     (root's password, a false "cannot"-side reading); (b) the printed `\#0` (sudo's own
      //     listing, W-819F3-AUD-07): its outcome is unknown before and after this fix — a control,
      //     labelled so — and its red is the old cause text ("sudo asks for \#0's password"). Prints
      //     each reading and cause.
      expect({
        raw: await read(third(defaults('runaspw', 'runas_default=#0'))),
        printed: await read(third(defaults('runaspw', 'runas_default=\\#0'))),
      }).toEqual({
        raw: { readings: ['sudo unknown'], cause: CAUSE },
        printed: { readings: ['sudo unknown'], cause: CAUSE },
      });
    });
  });

  describe('member 6 (A S4) with follow-up 3 (A B3): `\\,` escapes only where sudo could print an escaped comma; a split the check cannot tell reads unknown', () => {
    it('P11: `mailto=root\\,ops@example.com` reads as the base; P11b: `passprompt=pw\\,rootpw` never names root’s password', async () => {
      // (a) red when `\,` splits the list (P11: unknown, the fragment unread; P11b: root's password,
      //     the fragment acted on); (b) prints both.
      expect({
        p11: view(await third(defaults('mailto=root\\,ops@example.com'))),
        p11b: view(await third(defaults('passprompt=pw\\,rootpw'))),
      }).toEqual({ p11: NEEDS, p11b: NEEDS });
    });

    // #819 Unit A re-pin (A1): ", " always ends an item outside quotes, even after a backslash, so b3's
    // shape has its one reading — what sudo does (real rc 0): unknown → yes
    it('#819 follow-up 3 (A B3), Unit A (A1): a value ending in a literal backslash — `passprompt=Password\\, !authenticate`, and before `exempt_group=sudo` — reads yes, as sudo does', async () => {
      const n6c = await read(third(defaults('passprompt=Password\\', '!authenticate')));
      // the agent in sudo's group (its process gid 27, the captured sudo group)
      const n6d = await read(
        third(defaults('passprompt=Password\\', 'exempt_group=sudo'), {
          ...calls({ 'group sudo': 'getent.group.sudo' }),
          groups: [1001, 27],
        }),
      );
      // (a) red where `\,` escapes (the next item is swallowed into the passprompt: "needs this
      //     login's password"), or the split is left unread (unknown); (b) prints each reading and
      //     cause.
      expect({ n6c, n6d }).toEqual({
        n6c: { readings: ['sudo yes'], cause: undefined },
        n6d: { readings: ['sudo yes'], cause: undefined },
      });
    });

    // #819 Unit A re-pin (A1): a reading is valid only if its quotes close, so b4's shape has one —
    // what sudo does (real rc 0): unknown → yes
    it('#819 follow-up 3 (the audit’s S1), Unit A (A1): inside quotes a `\\"` before `, ` has one valid reading — `passprompt="Pass word\\", !authenticate` reads yes; `passprompt="x y", !authenticate` (control) reads yes', async () => {
      // (a) `n6a` red when a reading whose quote never closes is counted (two readings: unknown),
      //     or the quote stays open ("needs this login's password"); `n6b` red if a quoted value
      //     with a space were ever unsplittable; (b) prints both.
      expect({
        n6a: await read(third(defaults('passprompt="Pass word\\"', '!authenticate'))),
        n6b: view(await third(defaults('passprompt="x y"', '!authenticate'))),
      }).toEqual({
        n6a: { readings: ['sudo yes'], cause: undefined },
        n6b: ['sudo yes'],
      });
    });

    // #819 Unit A re-pin (A1): the wrapped line joins the line before, and ", " ends `passprompt`'s
    // value — sudo's own reading: the `!authenticate` covers the rule (unknown → yes). The Unit A
    // correction re-pin (C5, the reader's F5): sudo wraps a Defaults section with 4 spaces — the
    // 8-space shape this cell held is the privileges section's, which sudo never prints here
    it('#819 follow-up 3 (the audit’s S1, X13), Unit A (A1): a wrapped `Defaults!` line ending in `passprompt=Password\\,` is joined to its next 4-space line, which holds `!authenticate`: yes', async () => {
      const rs = await read(
        third(specific('Defaults!/usr/bin/realm passprompt=Password\\,\n    !authenticate')),
      );
      // (a) red when the wrapped line is not joined, or `\,` swallows the next item; (b) prints the
      //     reading and cause.
      expect(rs).toEqual({ readings: ['sudo yes'], cause: undefined });
    });

    // #819 Unit A re-pin (A1, A4): both lines now split — the Options line's `!authenticate` gives
    // yes (unknown → yes); the run-as `alice\` is a name rail 1 refuses to look up (unknown, its cause)
    it('#819 follow-up 3 (the audit’s S2), Unit A (A1, A4): an `Options:` line ending a value in a backslash splits (yes); a run-as name rail 1 cannot look up reads unknown', async () => {
      // (a) red when such a line is left unread again (unknown, "does not read"), or the run-as
      //     name is asked off rail 1; (b) prints each reading and cause.
      expect({
        options: await read(third(runAs('svc', 'passprompt=Password\\, !authenticate'))),
        runAs: await read(third(runAs('alice\\, svc'))),
        // #819 Unit A, the capped correction: the name alone, so "rail 1 refuses the name" stays pinned
        alone: await read(third(runAs('alice\\'))),
      }).toEqual({
        options: { readings: ['sudo yes'], cause: undefined },
        // the capped correction re-pin (Part 2; W-UAC2R4-AUD-12): the entry covers svc and needs a
        // password, so under the default policy the token's unknown cannot change the reading
        runAs: {
          readings: ['sudo needs_credential this_login sudo_timestamp'],
          cause: undefined,
        },
        alone: {
          readings: ['sudo unknown'],
          cause: 'getent passwd alice\\: the check refused to run /usr/bin/getent passwd alice\\',
        },
      });
    });

    it('#819 follow-up 3 (the audit’s S2, X8): an item the check cannot split never outranks a yes — N6c’s Defaults beside a NOPASSWD rule for svc reads yes', async () => {
      // (a) red when a split the check cannot tell makes the whole listing unknown (it would hide
      //     the NOPASSWD rule's yes); (b) prints the reading.
      expect(
        view(
          await third(
            both(defaults('passprompt=Password\\', '!authenticate'), runAs('svc', '!authenticate')),
          ),
        ),
      ).toEqual(['sudo yes']);
    });
  });

  describe('member 7 (the audit’s S9): /etc/shells read as getusershell reads it', () => {
    /** su at /usr/bin/su, svc's captured nologin entry, Ubuntu 24.04's su stacks; the shells file
     *  given per row. */
    const suWith = (shells: string) =>
      paths(linux(U24, merge(su(U24), { files: { '/etc/shells': shells } }))).then((rs) =>
        view(rs.filter((r) => r.path === 'su')),
      );
    it('a trailing comment after the shell, or text before its `/`, still lists it → su is read (needs svc’s password); unlisted → not allowed', async () => {
      // (a) red when a line is compared whole (`comment`, `before`: not allowed — a wrong "cannot":
      //     util-linux's su asks getusershell, which lists it); (b) prints each.
      expect({
        comment: await suWith('/bin/sh\n/usr/sbin/nologin # for ftp\n'),
        before: await suWith('/bin/sh\nshell=/usr/sbin/nologin\n'),
        bare: await suWith('/bin/sh\n/usr/sbin/nologin\n'),
        commentFirst: await suWith('/bin/sh\n# /usr/sbin/nologin\n'),
        unlisted: await suWith('/bin/sh\n'),
      }).toEqual({
        // #819 Unit A, the capped correction re-pin (Part 3): toward root too (root's shell runs
        // commands)
        comment: ['su needs_credential svc', 'su needs_credential root'],
        before: ['su needs_credential svc', 'su needs_credential root'],
        bare: ['su needs_credential svc', 'su needs_credential root'],
        commentFirst: ['su not_allowed', 'su needs_credential root'],
        unlisted: ['su not_allowed', 'su needs_credential root'],
      });
    });
  });

  describe('the words that claimed more than was measured (A MINOR 1, 3)', () => {
    it('A MINOR 1: a ticket setting the check reads by its value and refuses "does not accept"; any other unread item "does not read"', async () => {
      // (a) red when the ticket settings say "does not read", or another item says "does not
      //     accept"; (b) prints the three causes.
      expect({
        global: (await read(third(defaults('timestamp_type=global')))).cause,
        ttyOff: (await read(third(defaults('!tty_tickets')))).cause,
        other: (await read(third(defaults('group_plugin=/x.so')))).cause,
      }).toEqual({
        global: 'sudo listed a Defaults setting this check does not accept: timestamp_type=global',
        ttyOff: 'sudo listed a Defaults setting this check does not accept: !tty_tickets',
        other: 'sudo listed a Defaults setting this check does not read: group_plugin=/x.so',
      });
    });
    it('A MINOR 3: with noninteractive_auth listed, sudo’s entry says the check’s own listing ran sudo’s PAM stack; without it, it does not', async () => {
      const on = await third(defaults('noninteractive_auth'));
      const off = await third();
      const SAID = "which ran sudo's PAM stack (its noninteractive_auth setting is on)";
      // (a) red when the disclosure is dropped, or printed while the setting is off; (b) prints
      //     the readings and whether each how says it.
      expect({
        on: { readings: view(on), said: on[0]?.how.includes(SAID) },
        off: off[0]?.how.includes(SAID),
      }).toEqual({ on: { readings: NEEDS, said: true }, off: false });
    });
  });
});

describe('#819 Unit A — the sudo reader built from real sudo’s printouts, and item 2’s exact group read', () => {
  /** Ubuntu 24.04's captured `third-nopasswd` listing (classic sudo 1.9.15p5, `-ll`): stock Defaults,
   *  a NOPASSWD rule for `nobody`, a password rule `(svc) /usr/bin/realm` — edited per cell (the
   *  cut-capture standard: each edit named beside its cell). A rule that covers svc reads NEEDS; one
   *  that does not reads "not allowed". */
  const LL24 = 'LC_ALL=C /usr/bin/sudo -n -ll';
  const ID = '/usr/bin/id';
  const third = (
    edit: (out: string) => string = (o) => o,
    over: MachineSpec = {},
    wrap?: (argv: readonly string[], r: RunResult) => RunResult,
    svc = 'svc',
  ) => {
    const machine = fixtureMachine(linux(U24, merge(sudos(U24, 'third-nopasswd', ['sudo']), over)));
    const run = machine.run;
    return measureSwitchPaths({
      probes: {
        ...machine,
        run: async (argv) => {
          const r = await run(argv);
          const edited =
            argv.join(' ') === LL24 && 'exit' in r ? { ...r, stdout: edit(r.stdout) } : r;
          return wrap !== undefined ? wrap(argv, edited) : edited;
        },
      },
      svc,
    });
  };
  const defaults =
    (...items: string[]) =>
    (out: string) =>
      out.replace('    use_pty\n', `    use_pty, ${items.join(', ')}\n`);
  const runAs = (users: string, options?: string) => (out: string) =>
    out.replace(
      '    RunAsUsers: svc\n',
      `    RunAsUsers: ${users}\n${options !== undefined ? `    Options: ${options}\n` : ''}`,
    );
  const specific =
    (...lines: string[]) =>
    (out: string) =>
      out.replace(
        '\nUser agent may run',
        `\nRunas and Command-specific defaults for agent:\n${lines.join('\n')}\n\nUser agent may run`,
      );
  const both =
    (...edits: ((out: string) => string)[]) =>
    (out: string) =>
      edits.reduce((o, e) => e(o), out);
  const calls = (m: Record<string, string>): MachineSpec => ({
    calls: Object.fromEntries(Object.entries(m).map(([k, v]) => [`${GETENT} ${k}`, `${U24}/${v}`])),
  });
  /** The corpus's Ubuntu 24.04 item-2 machine (svc 1501:1500 in SVCGRP 2001; svcgrp 2002 holds alice;
   *  captured 2026-10-22 by scripts/capture-sudo-corpus.sh): `id` at /usr/bin/id, and every lookup the
   *  exact read makes, from scenario `set`. */
  const item2 = (set = 'grp-default', drop: string[] = []): MachineSpec => {
    const dir = `corpus/${U24}/${set}`;
    const names = ['svc', 'root', 'nobody'];
    const groups = ['0', '1500', '2001', '2002', 'svcgrp', 'Svcgrp', 'SVCGRP'];
    const all: Record<string, string> = {
      ...Object.fromEntries(
        names.map((n) => [`${GETENT} passwd ${n}`, `${dir}/getent.passwd.${n}`]),
      ),
      ...Object.fromEntries(
        groups
          .filter((g) => captured(`${dir}/getent.group.${g}`))
          .map((g) => [`${GETENT} group ${g}`, `${dir}/getent.group.${g}`]),
      ),
      [`${ID} -G svc`]: `${dir}/id.G.svc`,
      [`${ID} -G root`]: `${dir}/id.G.root`,
    };
    for (const d of drop) delete all[d];
    return { programs: { [ID]: 0 }, calls: all };
  };
  const NEEDS = ['sudo needs_credential this_login sudo_timestamp'];
  const NOT = ['sudo not_allowed'];
  const read = async (rs: Promise<SwitchPathReading[]>) =>
    rs.then((r) => ({ readings: view(r), cause: r[0]?.cause }));
  const v = (s: string) => sudoVersion(`Sudo version ${s}`);
  const listing = (stdout: string, version = v('1.9.15p5')) => parseListing(stdout, version);
  /** A listing printout: its global Defaults text, its specific section's lines, its long-format
   *  entries (each `RunAsUsers` with an optional `Options`). */
  const printout = (
    global: string,
    specificLines: string[] = [],
    runas: [string, string?][] = [['svc']],
  ) =>
    [
      'Matching Defaults entries for agent on h:',
      `    ${global}`,
      '',
      ...(specificLines.length > 0
        ? ['Runas and Command-specific defaults for agent:', ...specificLines, '']
        : []),
      'User agent may run the following commands on h:',
      '',
      ...runas.flatMap(([users, options]) => [
        'Sudoers entry: /etc/sudoers.d/realm',
        `    RunAsUsers: ${users}`,
        ...(options !== undefined ? [`    Options: ${options}`] : []),
        '    Commands:',
        '\t/usr/bin/realm',
        '',
      ]),
    ].join('\n');
  const decoded = (l: ReturnType<typeof listing>, version = v('1.9.15p5')) =>
    'unknown' in l
      ? l.unknown
      : {
          global: l.items.map((i) => defaultsValue(i, version)),
          specific: l.specific.map((s) => ({
            at: `Defaults${s.kind}${s.targets.join(', ')}`,
            items: s.items.map((i) => defaultsValue(i, version)),
          })),
          users: l.entries.map((e) => e.users),
          unsplit: l.unsplit,
        };

  describe('A1: the grammar', () => {
    it('each escape on each side of the version boundary (1.9.10), and a version this check cannot read', () => {
      const raw = ['a\\:b', 'a\\,b', 'a\\=b', 'a\\#b', 'a\\"b', 'a\\\\b', 'a\\qb'];
      // (1) red when the boundary moves (1.9.9 read as 1.9.10: `\\` and `\q` kept) or the escape set
      //     changes; (2) prints each value as each version reads it.
      expect({
        v199: raw.map((r) => unescapePrinted(r, v('1.9.9'))),
        v1910: raw.map((r) => unescapePrinted(r, v('1.9.10'))),
        unknown: raw.map((r) => unescapePrinted(r, undefined)),
        plain: unescapePrinted('abc', undefined),
      }).toEqual({
        v199: ['a:b', 'a,b', 'a=b', 'a#b', 'a"b', 'a\\b', 'aqb'],
        v1910: ['a:b', 'a,b', 'a=b', 'a#b', 'a"b', 'a\\\\b', 'a\\qb'],
        unknown: [undefined, undefined, undefined, undefined, undefined, undefined, undefined],
        plain: 'abc',
      });
    });

    it('a quoted value keeps a raw backslash on every version; ", " ends an item even right after a backslash', () => {
      const out = printout('mailfrom="\\q24 s", passprompt=u5\\, mailsub=x');
      // (1) red when a backslash inside quotes is unescaped by the version, or `\,` before a space
      //     joins the next item; (2) prints the items as each version reads them.
      expect({
        v199: decoded(listing(out, v('1.9.9')), v('1.9.9')),
        v1915: decoded(listing(out)),
      }).toEqual({
        v199: {
          global: [
            { key: 'mailfrom', value: '\\q24 s' },
            { key: 'passprompt', value: 'u5\\' },
            { key: 'mailsub', value: 'x' },
          ],
          specific: [],
          users: [['svc']],
          unsplit: [],
        },
        v1915: {
          global: [
            { key: 'mailfrom', value: '\\q24 s' },
            { key: 'passprompt', value: 'u5\\' },
            { key: 'mailsub', value: 'x' },
          ],
          specific: [],
          users: [['svc']],
          unsplit: [],
        },
      });
    });

    it('b3 (`passprompt=Password\\, !authenticate`) and b4 (`passprompt="Pass word\\", !authenticate`) read yes; a quoted value ending in a backslash as a list’s last item has its one reading', async () => {
      // (1) red: b3 when `\,` is consumed as an escape (zero readings); b4 when a reading whose quote
      //     never closes is counted (two readings); `last` when the last item is split anywhere else;
      //     (2) prints the readings and the last item's value.
      expect({
        b3: view(await third(defaults('passprompt=Password\\', '!authenticate'))),
        b4: view(await third(defaults('passprompt="Pass word\\"', '!authenticate'))),
        last: decoded(listing(printout('env_reset, passprompt="Pass word\\"'))),
      }).toEqual({
        b3: ['sudo yes'],
        b4: ['sudo yes'],
        last: {
          global: [{ key: 'env_reset' }, { key: 'passprompt', value: 'Pass word\\' }],
          specific: [],
          users: [['svc']],
          unsplit: [],
        },
      });
    });

    it('P2 (two sources print `passprompt="x \\", !authenticate, mailsub=w\\"`) reads unknown; zero valid readings reads unknown', async () => {
      // (1) red: `p2` when one of its two readings is taken (A: yes; B: needs a password); `zero`
      //     when an unclosed quote is read anyway; `noQuote` when a text with no quotation mark is
      //     said to have unpaired ones; (2) prints the readings and causes.
      expect({
        p2: await read(third(defaults('passprompt="x \\"', '!authenticate', 'mailsub=w\\"'))),
        zero: await read(third(defaults('passprompt="x y', '!authenticate'))),
        noQuote: await read(third(specific('    Defaults!/usr/bin/realm'))),
      }).toEqual({
        p2: {
          readings: ['sudo unknown'],
          cause:
            'sudo listed a Defaults setting this check cannot split: passprompt="x \\", !authenticate, mailsub=w\\" (a value with a space that ends in a backslash, or holds a backslash before a quotation mark, prints the same as another setting; write it without one)',
        },
        zero: {
          readings: ['sudo unknown'],
          cause:
            'sudo listed a Defaults setting this check cannot split: passprompt="x y (its quotation marks do not pair as sudo prints them)',
        },
        noQuote: {
          readings: ['sudo unknown'],
          cause: 'sudo listed a line this check does not read: Defaults!/usr/bin/realm',
        },
      });
    });

    it('the second audit’s B1(a) and B1(b) printouts read unknown; the real corpus’s joined Defaults>/Defaults! line has its one reading, the cut', async () => {
      const b1a = [
        '    Defaults!/usr/bin/realm mailsub="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \\"',
        '    Defaults!/usr/bin/false mailfrom=\\"q\\", !authenticate',
      ];
      const b1b = [
        '    Defaults>svc passprompt="x \\"    Defaults!/usr/bin/realm !authenticate, mailsub=w\\"',
      ];
      const joined = listing(
        (capture(`corpus/${U24}/main/sudo.ll.notty80`) as { stdout: string }).stdout,
      );
      // (1) red: `b1a`/`b1b` when one reading is taken (b1a's two entries: "needs a password"; b1b's
      //     one value: the !authenticate swallowed); `cut` when the 4-space join is not cut;
      //     (2) prints the readings, and the two entries the joined line holds.
      expect({
        b1a: (await read(third(specific(...b1a)))).readings,
        b1b: (await read(third(specific(...b1b)))).readings,
        cut:
          'unknown' in joined
            ? joined.unknown
            : joined.specific
                .filter(
                  (s) =>
                    s.targets.join(', ') === '%svcgrp' || s.targets.join(', ') === '/usr/bin/true',
                )
                .map((s) => `Defaults${s.kind}${s.targets.join(', ')} ${s.items.length} items`),
      }).toEqual({
        b1a: ['sudo unknown'],
        b1b: ['sudo unknown'],
        cut: ['Defaults>%svcgrp 1 items', 'Defaults!/usr/bin/true 13 items'],
      });
    });

    it('a candidate boundary outside quotes starts an entry; inside quotes it is text; where a `\\"` decides it there are two readings', () => {
      const out = (line: string) => decoded(listing(printout('env_reset', [line])));
      // (1) red: `outside` when the 4-space join is read as text; `inside` when it is cut inside a
      //     quoted value; `decides` when one reading is taken; (2) prints the entries and causes.
      expect({
        outside: out('    Defaults>svc mailsub=x    Defaults!/usr/bin/realm !authenticate'),
        inside: out('    Defaults>svc mailsub="x    Defaults!/usr/bin/realm !authenticate"'),
        decides: out(
          '    Defaults>svc mailsub="x \\"    Defaults!/usr/bin/realm !authenticate, mailfrom=y\\"',
        ),
      }).toEqual({
        outside: {
          global: [{ key: 'env_reset' }],
          specific: [
            { at: 'Defaults>svc', items: [{ key: 'mailsub', value: 'x' }] },
            { at: 'Defaults!/usr/bin/realm', items: [{ key: '!authenticate' }] },
          ],
          users: [['svc']],
          unsplit: [],
        },
        inside: {
          global: [{ key: 'env_reset' }],
          specific: [
            {
              at: 'Defaults>svc',
              items: [{ key: 'mailsub', value: 'x    Defaults!/usr/bin/realm !authenticate' }],
            },
          ],
          users: [['svc']],
          unsplit: [],
        },
        decides: {
          global: [{ key: 'env_reset' }],
          specific: [],
          users: [['svc']],
          unsplit: [
            'sudo listed a Defaults setting this check cannot split: mailsub="x \\"    Defaults!/usr/bin/realm !authenticate, mailfrom=y\\" (a value with a space that ends in a backslash, or holds a backslash before a quotation mark, prints the same as another setting; write it without one)',
          ],
        },
      });
    });

    it('an entry against a continuation in the specific section; the 3-space first line', () => {
      const continued = listing(
        printout('env_reset', [
          '    Defaults>svc mailsub=a,',
          '    mailfrom=b',
          '    Defaults!/usr/bin/realm mailto=c',
        ]),
      );
      const long = listing(
        (capture(`corpus/${U24}/long-target/sudo.ll.notty80`) as { stdout: string }).stdout,
      );
      // (1) red: `continued` when a 4-space line that is not an entry starts one (or is not read);
      //     `long` when the 3-space line is read as a line of its own; (2) prints the entries.
      const specificOf = (l: ReturnType<typeof listing>) => {
        const d = decoded(l);
        return typeof d === 'string' ? d : d.specific;
      };
      expect({
        continued: specificOf(continued),
        long: specificOf(long),
      }).toEqual({
        continued: [
          {
            at: 'Defaults>svc',
            items: [
              { key: 'mailsub', value: 'a' },
              { key: 'mailfrom', value: 'b' },
            ],
          },
          { at: 'Defaults!/usr/bin/realm', items: [{ key: 'mailto', value: 'c' }] },
        ],
        long: [
          { at: `Defaults!/usr/bin/${'l'.repeat(70)}`, items: [{ key: 'mailsub', value: 'lt1' }] },
        ],
      });
    });

    it('a target list in each separator (", " from 1.9.8, " ," before); a version this check cannot read; a digest or a regex target', () => {
      const targets = (line: string, version: SudoVersion | undefined) => {
        const l = parseListing(printout('env_reset', [line]), version);
        return 'unknown' in l ? l.unknown : (l.unsplit[0] ?? l.specific.map((s) => s.targets));
      };
      // (1) red when a separator is read on the wrong side of 1.9.8, a version this check cannot read
      //     picks one, or a target holding a space or a regex is split; (2) prints targets or causes.
      expect({
        comma: targets('    Defaults!/usr/bin/true, /usr/bin/false mailsub=x', v('1.9.15p5')),
        spaceComma: targets('    Defaults!/usr/bin/true ,/usr/bin/false mailsub=x', v('1.8.31')),
        unknownVersion: targets('    Defaults>svc ,nobody mailsub=x', undefined),
        sameEither: targets('    Defaults>svc mailsub=x', undefined),
        digest: targets(
          '    Defaults!sha224:0GomF8mNN3wlDt1HD9XldjJ3SNgpFdbjO1+NsQ== /usr/bin/realm !authenticate',
          v('1.9.15p5'),
        ),
        regex: targets('    Defaults!^/usr/bin/realm .*$ !authenticate', v('1.9.15p5')),
      }).toEqual({
        comma: [['/usr/bin/true', '/usr/bin/false']],
        spaceComma: [['/usr/bin/true', '/usr/bin/false']],
        unknownVersion:
          "sudo listed a Defaults line's target this check cannot split: Defaults>svc ,nobody mailsub=x (sudo's version could not be read, and sudo separates targets differently before and after 1.9.8)",
        sameEither: [['svc']],
        // #819 Unit A, the capped correction re-pin (the walk's wording item): "without a digest"
        digest:
          "sudo listed a Defaults line's target this check cannot split: Defaults!sha224:0GomF8mNN3wlDt1HD9XldjJ3SNgpFdbjO1+NsQ== /usr/bin/realm !authenticate (sudo prints a digest with a space; name the command without a digest)",
        regex:
          "sudo listed a Defaults line's target this check cannot split: Defaults!^/usr/bin/realm .*$ !authenticate (name the command by its path)",
      });
    });

    it('each run-as member form, unquoted and unescaped by the version (A5: the short format too)', () => {
      const members =
        '#1001, svc, !alice, %svcgrp, %:plugingrp, %#2001, +svcnet, ALL, "a b", !"n m", "%g h", e\\:f, m\\\\n';
      const long = listing(printout('env_reset', [], [[members]]), v('1.9.9'));
      const short = parseListing(
        [
          'User agent may run the following commands on h:',
          `    (${members} : svcgrp, "g h") NOPASSWD: /usr/bin/realm`,
        ].join('\n'),
        v('1.9.9'),
      );
      const want = [
        '#1001',
        'svc',
        '!alice',
        '%svcgrp',
        '%:plugingrp',
        '%#2001',
        '+svcnet',
        'ALL',
        'a b',
        '!n m',
        '%g h',
        'e:f',
        'm\\n',
      ];
      // (1) red when a member form is split, unquoted or unescaped other than as sudo stores it;
      //     (2) prints both formats' members.
      expect({
        long: 'unknown' in long ? long.unknown : long.entries.map((e) => e.users),
        short: 'unknown' in short ? short.unknown : short.entries.map((e) => [e.users, e.groups]),
      }).toEqual({ long: [want], short: [[want, ['svcgrp', 'g h']]] });
    });
  });

  describe('A3: item 2, the exact group read (`id -G`)', () => {
    it('by name (no match_group_by_gid): a case-insensitive hit covers; an exact miss under !case_insensitive_group does not; a gid with no name is skipped; a getent error reads unknown', async () => {
      // svc's gids 1500 (svcown) and 2001 (SVCGRP); `%svcgrp` names SVCGRP in another case. For the
      // gid with no name: Ubuntu 24.04's captured svc whose primary gid 1400 has no group (id -G: 1400).
      const noName: MachineSpec = {
        programs: { [ID]: 0 },
        calls: {
          [`${GETENT} passwd svc`]: `${U24}/getent.passwd.svc.gid-1400-no-group`,
          [`${GETENT} group 1400`]: `${U24}/getent.group.1400.absent`,
          [`${ID} -G svc`]: `${U24}/id.G.svc.gid-1400-no-group`,
          [`${ID} -G root`]: `${U24}/id.G.root`,
          [`${GETENT} group 0`]: `${U24}/getent.group.0`,
        },
      };
      // (1) red: `hit` when names are compared exactly (or the fallback is read: not allowed,
      //     clause g); `exact` when !case_insensitive_group is ignored; `skipped` when a gid with no
      //     name reads unknown; `error` when a lookup that errs is read as no match; (2) prints them.
      expect({
        hit: view(await third(runAs('%svcgrp'), item2())),
        exact: view(
          await third(both(runAs('%svcgrp'), defaults('!case_insensitive_group')), item2()),
        ),
        skipped: view(await third(runAs('%svcgrp'), noName)),
        error: (await read(third(runAs('%svcgrp'), item2('grp-default', [`${GETENT} group 2001`]))))
          .readings,
      }).toEqual({ hit: NEEDS, exact: NOT, skipped: NOT, error: ['sudo unknown'] });
    });

    it('by gid (match_group_by_gid): covering, not covering, an absent group, a getent error and an all-digit token', async () => {
      const byGid = (token: string, drop: string[] = []) =>
        read(third(both(runAs(token), defaults('match_group_by_gid')), item2('grp-default', drop)));
      // (1) red: `covering` when SVCGRP's gid is not compared with the set; `notCovering` and
      //     `absent` when an exact name is matched in any case or an absent group reads unknown;
      //     `error` when an error reads absent; `digits` when getent's gid lookup is trusted for a
      //     name; (2) prints readings and causes.
      expect({
        covering: (await byGid('%SVCGRP')).readings,
        notCovering: (await byGid('%svcgrp')).readings,
        absent: (await byGid('%Svcgrp')).readings,
        error: (await byGid('%SVCGRP', [`${GETENT} group SVCGRP`])).readings,
        digits: await byGid('%2001'),
      }).toEqual({
        covering: NEEDS,
        notCovering: NOT,
        absent: NOT,
        error: ['sudo unknown'],
        digits: {
          readings: ['sudo unknown'],
          cause:
            'getent group 2001 reads 2001 as a gid, and sudo looks it up as a group name (match_group_by_gid)',
        },
      });
    });

    it('`%#gid` compared with the set as a number; root’s `%group` in RunAsUsers read through `id -G root`; `%:name` reads unknown', async () => {
      // (1) red when a `%#gid` is looked up as a name, root's groups are not read (root's %root then
      //     falls back), or `%:name` is read as a Unix group; (2) prints the readings.
      expect({
        inSet: view(await third(runAs('%#2001'), item2())),
        notInSet: view(await third(runAs('%#2002'), item2())),
        root: view(await third(runAs('%root'), item2())),
        colon: await read(third(runAs('%:svcgrp'), item2())),
      }).toEqual({
        inSet: NEEDS,
        notInSet: NOT,
        root: NEEDS,
        colon: {
          readings: ['sudo unknown'],
          cause:
            'sudo matches %:svcgrp only through its group plugin, which this check does not read',
        },
      });
    });

    // the Unit A correction re-pin (C2, W-UA-MA3-02): under sudo's default flags each fallback reads
    // unknown with its own cause (a secondary group named only in another case is not seen) — was
    // "not allowed", clause (g); `uid n` never reaches the group branch and stays as pinned
    it('each fallback — no id, refused, not a root-owned copy, exit 1, empty stdout, no primary gid, svc known only as `uid n` — reads unknown with its cause; `uid n` as today', async () => {
      const edit =
        (stdout: string) =>
        (argv: readonly string[], r: RunResult): RunResult =>
          argv[0] === ID && 'exit' in r ? { ...r, stdout } : r;
      const noId = (): MachineSpec => {
        const m = item2();
        return { calls: m.calls! };
      };
      const fallback = async (rs: Promise<SwitchPathReading[]>) =>
        rs.then((r) => ({
          readings: view(r),
          clauses: switchClausesOf(r).map((c) => c.clause),
          ...(r[0]?.cause !== undefined ? { cause: r[0].cause } : {}),
        }));
      // #819 Unit A, the capped correction re-pin (the walk's wording item): the cause names the user
      // and the group, and the remedy only where no root-owned `id` is there
      const REMEDY = ' (a root-owned id in a system folder lets this check read the groups)';
      const gap = (why: string, remedy = '') => ({
        readings: ['sudo unknown'],
        clauses: [],
        cause: `sudo matches group names in any case, so svc may be in svcgrp under another case, and ${why}${remedy}`,
      });
      // (1) red when a fallback condition is read as an answer (each would then cover svc: NEEDS),
      //     or as "not allowed" again (the walk's wrong "no"); (2) prints each reading, its clauses
      //     and cause.
      expect({
        absent: await fallback(third(runAs('%svcgrp'), noId())),
        refused: await fallback(
          third(runAs('%svcgrp'), item2(), (argv, r) =>
            argv[0] === ID ? { refused: argv.join(' ') } : r,
          ),
        ),
        notRoot: await fallback(
          third(runAs('%svcgrp'), merge(item2(), { programs: { [ID]: 1001 } })),
        ),
        exit1: await fallback(
          third(
            runAs('%svcgrp'),
            merge(item2(), { calls: { [`${ID} -G svc`]: `${U24}/id.G.nosuchuser` } }),
          ),
        ),
        empty: await fallback(third(runAs('%svcgrp'), item2(), edit('\n'))),
        noPrimary: await fallback(third(runAs('%svcgrp'), item2(), edit('2001\n'))),
        uidOnly: await fallback(
          third(
            runAs('%svcgrp'),
            merge(item2(), { calls: { [`${GETENT} passwd 1501`]: `${U25}/getent.passwd.none` } }),
            undefined,
            'uid 1501',
          ),
        ),
      }).toEqual({
        absent: gap('no id was found in the system folders', REMEDY),
        refused: gap('the check refused to run id'),
        notRoot: gap('id is not a root-owned system copy', REMEDY),
        exit1: gap('id -G svc exited 1'),
        empty: gap('id -G svc printed no list of groups'),
        noPrimary: gap("id -G svc did not list svc's primary group"),
        uidOnly: { readings: NOT, clauses: [] },
      });
    });

    it('`group_plugin` listed with a Unix miss reads unknown; on macOS the group reads unknown and `id` is not asked; `/usr/sbin/id` is admitted', async () => {
      const fed = `corpus/${FED}/grp-fedora`;
      const sbin: MachineSpec = {
        programs: { '/usr/sbin/id': 0, '/usr/sbin/getent': 0 },
        files: Object.fromEntries(
          (PAM[U24] ?? []).map((n) => [`/etc/pam.d/${n}`, { fixture: `${U24}/pam.${n}` }]),
        ),
        calls: {
          '/usr/sbin/getent group 0': `${fed}/getent.group.0`,
          '/usr/sbin/getent passwd svc': `${fed}/getent.passwd.svc`,
          '/usr/sbin/getent passwd root': `${fed}/getent.passwd.root`,
          '/usr/sbin/getent passwd nobody': `${fed}/getent.passwd.nobody`,
          '/usr/sbin/getent group 1500': `${fed}/getent.group.1500`,
          '/usr/sbin/getent group 2001': `${fed}/getent.group.2001`,
          '/usr/sbin/id -G svc': `${fed}/id.G.svc`,
          '/usr/sbin/id -G root': `${fed}/id.G.root`,
        },
      };
      const fedMachine = fixtureMachine(merge(sudos(U24, 'third-nopasswd', ['sudo']), sbin));
      const fedRun = fedMachine.run;
      const fedora = await measureSwitchPaths({
        probes: {
          ...fedMachine,
          run: async (argv) => {
            const r = await fedRun(argv);
            return argv.join(' ') === LL24 && 'exit' in r
              ? { ...r, stdout: runAs('%svcgrp')(r.stdout) }
              : r;
          },
        },
        svc: 'svc',
      });
      const askedId = () => asked.some((a) => a[0]?.endsWith('/id') === true);
      const plugin = await read(
        third(
          both(
            runAs('%svcgrp'),
            defaults('group_plugin="group_file.so /etc/sudo-group"', '!case_insensitive_group'),
          ),
          item2(),
        ),
      );
      asked.length = 0;
      const mac = await read(third(runAs('%svcgrp'), merge(item2(), { platform: 'darwin' })));
      const macAskedId = askedId();
      // (1) red: `plugin` when group_plugin is made harmless (the miss then reads "not allowed");
      //     `mac` when darwin asks id; `sbin` when /usr/sbin/id is refused (the fallback then reads
      //     not allowed); (2) prints the readings and whether id was asked.
      expect({
        plugin,
        mac,
        macAskedId,
        sbin: view(fedora.filter((r) => r.path === 'sudo')),
      }).toEqual({
        plugin: {
          readings: ['sudo unknown'],
          cause:
            'sudo listed a Defaults setting this check does not read: group_plugin="group_file.so /etc/sudo-group"',
        },
        mac: {
          readings: ['sudo unknown'],
          cause: "macOS has no getent, so this user's entry is not read",
        },
        macAskedId: false,
        sbin: NEEDS,
      });
    });
  });

  describe('A4, A6, A7, A9', () => {
    it('A4: an `Options:` list that cannot be split lets a yes win; alone it reads unknown with its split; a run-as list that cannot be split reads unknown', async () => {
      // (1) red when an unsplit Options list makes the whole listing unknown again (`withYes`), or a
      //     run-as list that cannot be split is read anyway; (2) prints the readings and causes.
      expect({
        withYes: view(
          await third(
            both(
              runAs('svc', 'passprompt="x \\", !authenticate, mailsub=w\\"'),
              defaults('!authenticate'),
            ),
          ),
        ),
        alone: await read(third(runAs('svc', 'passprompt="x \\", !authenticate, mailsub=w\\"'))),
        runAs: await read(third(runAs('"a b\\", svc, "c'))),
      }).toEqual({
        withYes: ['sudo yes'],
        alone: {
          readings: ['sudo unknown'],
          cause:
            'sudo listed a Defaults setting this check cannot split: passprompt="x \\", !authenticate, mailsub=w\\" (a value with a space that ends in a backslash, or holds a backslash before a quotation mark, prints the same as another setting; write it without one)',
        },
        runAs: {
          readings: ['sudo unknown'],
          cause:
            'sudo listed a run-as list this check cannot split: "a b\\", svc, "c (write the name without a space or a backslash)',
        },
      });
    });

    it('A6: runaspw — unset or root, the service user, another user, absent, `#…`, all digits, a name the rail refuses', async () => {
      const runaspw = (...items: string[]) =>
        read(
          third(
            defaults('runaspw', ...items),
            calls({
              'passwd nobody': 'getent.passwd.nobody',
              'passwd Svc': 'getent.passwd.Svc.absent',
            }),
          ),
        );
      // (1) red when a branch moves: the value not unescaped (`\#0`), the lookup skipped or made by
      //     uid, the service user compared in any case, a name the rail refuses asked anyway; (2)
      //     prints each reading and cause.
      expect({
        unset: await runaspw(),
        root: await runaspw('runas_default=root'),
        svc: await runaspw('runas_default=svc'),
        other: await runaspw('runas_default=nobody'),
        absent: await runaspw('runas_default=Svc'),
        hash: await runaspw('runas_default=\\#0'),
        digits: await runaspw('runas_default=1001'),
        refused: await runaspw('runas_default="a b"'),
      }).toEqual({
        unset: { readings: ['sudo needs_credential root sudo_timestamp'], cause: undefined },
        root: { readings: ['sudo needs_credential root sudo_timestamp'], cause: undefined },
        svc: { readings: ['sudo needs_credential svc sudo_timestamp'], cause: undefined },
        // #819 Unit A, the capped correction re-pin (Part 7): sudo asks the runas_default user's
        // password, and the check now names it (W-UAC2R4-AUD-09)
        other: {
          readings: ['sudo needs_credential named_user nobody sudo_timestamp'],
          cause: undefined,
        },
        // the capped correction re-pin (the walk's wording item): "not as proof that no way works"
        absent: {
          readings: ['sudo unknown'],
          cause:
            'sudo finds no user Svc and refuses every command (Defaults runaspw); this check reads that as unknown, not as proof that no way works',
        },
        hash: {
          readings: ['sudo unknown'],
          cause:
            'sudo looks #0 up as a user name, finds none and refuses every command (Defaults runaspw); this check reads that as unknown, not as proof that no way works',
        },
        digits: {
          readings: ['sudo unknown'],
          cause:
            'sudo looks 1001 up as a user name, which this check cannot look up exactly (Defaults runaspw)',
        },
        refused: {
          readings: ['sudo unknown'],
          cause:
            'sudo looks a b up as a user name, which this check cannot look up exactly (Defaults runaspw)',
        },
      });
    });

    it('A7: the unseen-Defaults causes name rootpw, targetpw and runaspw, and whose password each asks for; the person reading carries its base reading’s how ("as above")', async () => {
      const refusal = await paths(
        linux(
          U24,
          merge(sudos(U24, 'password', ['sudo']), {
            files: { '/etc/pam.d/sudo': { fixture: `${U24}/variant.sudo-u2f` } },
          }),
        ),
      );
      const rs = await paths(linux(U25, sudos(U25, 'password', ['sudo-rs'])));
      const WHOSE =
        "rootpw, targetpw or runaspw cannot be ruled out: rootpw asks for root's password, targetpw for the target user's, runaspw for its runas_default user's";
      // (1) red when a cause names only rootpw or targetpw, or the person reading's how differs from
      //     its base reading's (the renderer then prints it again); (2) prints the causes, the hows'
      //     equality and the rendered person entry.
      expect({
        refused: refusal.filter((r) => r.cause !== undefined).map((r) => r.cause),
        listed: rs.filter((r) => r.cause !== undefined).map((r) => r.cause),
        sameHow: refusal.map((r) => r.how === refusal[0]!.how),
        person: ((r) => (r.basis === 'unknown' ? r.cause : r.detail) ?? '')(
          switchPathsReading(refusal, 'svc'),
        ).endsWith("sudo: needs a person's touch or key (as above)"),
      }).toEqual({
        refused: [
          `sudo does not show its Defaults or whether a rule exists, so ${WHOSE}`,
          `sudo does not show its Defaults or whether a rule exists, so ${WHOSE}`,
        ],
        listed: [
          `sudo does not list its Defaults, so ${WHOSE}`,
          `sudo does not list its Defaults, so ${WHOSE}`,
        ],
        sameHow: [true, true, true, true],
        person: true,
      });
    });

    it('A9: "is unknown", never "is not known" — the four causes', async () => {
      const unreadable = await read(
        third(runAs('%svcgrp'), {
          ...calls({
            'group svcgrp': 'getent.group.svcgrp.others',
            'passwd svc': 'getent.passwd.svc.own-group',
            'group 1300': 'getent.group.1300.own-group',
          }),
          unreadable: ['/etc/nsswitch.conf'],
        }),
      );
      // (1) red when a cause says "is not known" again; (2) prints the causes.
      expect({
        nsswitch: unreadable.cause,
        cached: (await paths(linux(U25, sudos(U25, 'cached', ['sudo.ws'])))).map((r) =>
          r.how.split(': ').pop(),
        ),
      }).toEqual({
        nsswitch: '/etc/nsswitch.conf cannot be read, so where groups are listed from is unknown',
        cached: ['the rules were listed without a password (the cause is unknown)'],
      });
    });
  });

  describe('the Unit A correction (#860’s first review): each finding its cell', () => {
    /** The captured `sudo -V` answer's first line edited to `Sudo version ⟨s⟩` (the cut-capture
     *  standard): another side of 1.9.10, or (`1.9.x`) a version this check cannot read. */
    const asVersion =
      (s: string) =>
      (argv: readonly string[], r: RunResult): RunResult =>
        argv[1] === '-V' && 'exit' in r
          ? { ...r, stdout: r.stdout.replace(/^Sudo version \S+/, `Sudo version ${s}`) }
          : r;
    /** The walk's shape 3: `(%svcgrp) NOPASSWD` — svc (1501:1500) in SVCGRP (2001); svcgrp lists alice. */
    const shape3 = runAs('%svcgrp', '!authenticate');
    /** The item-2 machine with no `id` anywhere. */
    const noId = (): MachineSpec => ({ calls: item2().calls! });
    const idSays =
      (stdout: string) =>
      (argv: readonly string[], r: RunResult): RunResult =>
        argv[0] === ID && 'exit' in r ? { ...r, stdout } : r;
    // #819 Unit A, the capped correction re-pin (the walk's wording item): the case cause names the
    // user and the group, and the remedy only where no root-owned `id` is there
    const GAP =
      'sudo matches group names in any case, so svc may be in svcgrp under another case, and';
    const REMEDY = ' (a root-owned id in a system folder lets this check read the groups)';
    const fallback = async (rs: Promise<SwitchPathReading[]>) =>
      rs.then((r) => ({ readings: view(r), clauses: switchClausesOf(r).map((c) => c.clause) }));
    /** The tail of a reading's how: what decided it. */
    const decided = async (rs: Promise<SwitchPathReading[]>) =>
      rs.then((r) => ({ readings: view(r), how: r[0]?.how.split(': ').pop() }));

    it('C1: a backslash outside quotes pairs only where that version printed a pair — S1 and G1 as real sudo printed them, each side of 1.9.10', async () => {
      // The probes of 2026-10-23 (plans/issue-627/w/unit-a/ia3/correction/probes/): S1 stores
      // `Password\` for nobody beside `Defaults>svc !authenticate` — 1.9.15p5 prints `Password\`,
      // 1.9.9 `Password\\`; G1 stores `a\"b` — 1.9.15p5 prints `a\\"b`. Real sudo exits 0 on each.
      const s1 = (value: string) =>
        specific(`    Defaults>nobody passprompt=${value}`, '    Defaults>svc !authenticate');
      // (1) red when a backslash pairs with any next character on every version (9752398a: S1 on
      //     1.9.15p5 reads unknown, G1 has no reading); (2) prints each reading and G1's value.
      expect({
        s1v1915: (await read(third(s1('Password\\')))).readings,
        s1v199: (await read(third(s1('Password\\\\'), {}, asVersion('1.9.9')))).readings,
        g1v1915: (await read(third(defaults('passprompt=a\\\\"b', '!authenticate')))).readings,
        g1Value: decoded(listing(printout('env_reset, passprompt=a\\\\"b, !authenticate'))),
      }).toEqual({
        s1v1915: ['sudo yes'],
        s1v199: ['sudo yes'],
        g1v1915: ['sudo yes'],
        g1Value: {
          global: [
            { key: 'env_reset' },
            { key: 'passprompt', value: 'a\\"b' },
            { key: '!authenticate' },
          ],
          specific: [],
          users: [['svc']],
          unsplit: [],
        },
      });
    });

    it('C1: with sudo’s version not known, a text is read as each side of 1.9.10 and split only where both split it alike', async () => {
      const unknown = asVersion('1.9.x');
      // two entries joined on one line by 4 spaces, the first value ending in a backslash: ≤ 1.9.9
      // pairs `\ ` (the value `a\ `), ≥ 1.9.10 does not (`a\`)
      const twoWays = specific('    Defaults>nobody mailsub=a\\    Defaults>svc !authenticate');
      // (1) red when two paths that rejoin are counted as two readings (the audit's S2: b3 then reads
      //     unknown), when one side is read alone (G1 has no ≤ 1.9.9 reading), or when the sides'
      //     splits are not compared (`twoWays` reads yes); (2) prints each reading and cause.
      expect({
        b3: (await read(third(defaults('passprompt=Password\\\\', '!authenticate'), {}, unknown)))
          .readings,
        g1: (await read(third(defaults('passprompt=a\\\\"b', '!authenticate'), {}, unknown)))
          .readings,
        twoWays: await read(third(twoWays, {}, unknown)),
        twoWaysKnown: [
          (await read(third(twoWays))).readings,
          (await read(third(twoWays, {}, asVersion('1.9.9')))).readings,
        ],
      }).toEqual({
        b3: ['sudo yes'],
        g1: ['sudo yes'],
        twoWays: {
          readings: ['sudo unknown'],
          cause:
            "sudo's version could not be read, and this line splits differently before and after 1.9.10: mailsub=a\\ ",
        },
        twoWaysKnown: [['sudo yes'], ['sudo yes']],
      });
    });

    it('C1: a run-as list is read by the version too — a name ending in a backslash, as each side prints it, and with no version', () => {
      const users = (text: string, version: SudoVersion | undefined) => {
        const l = parseListing(
          [
            'User agent may run the following commands on h:',
            `    (${text}) NOPASSWD: /usr/bin/realm`,
          ].join('\n'),
          version,
        );
        return 'unknown' in l ? l.unknown : l.entries.map((e) => e.users);
      };
      // (1) red when `\)` pairs on every version (1.9.15p5's `alice\` then has no reading); (2)
      //     prints the members or the cause.
      expect({
        v1915: users('svc, alice\\', v('1.9.15p5')),
        v199: users('svc, alice\\\\', v('1.9.9')),
        none: users('svc, alice\\', undefined),
      }).toEqual({
        v1915: [['svc', 'alice\\']],
        v199: [['svc', 'alice\\']],
        none: "sudo's version could not be read, and sudo prints a backslash differently before and after 1.9.10: alice\\",
      });
    });

    it('C2: where `id -G` cannot be read, the walk’s shape 3 reads unknown — each way it cannot, with its own cause', async () => {
      const kinds: Record<string, Promise<SwitchPathReading[]>> = {
        absent: third(shape3, noId()),
        refused: third(shape3, item2(), (argv, r) =>
          argv[0] === ID ? { refused: argv.join(' ') } : r,
        ),
        notRoot: third(shape3, merge(item2(), { programs: { [ID]: 1001 } })),
        writable: third(shape3, merge(item2(), { writable: [ID] })),
        exit1: third(
          shape3,
          merge(item2(), { calls: { [`${ID} -G svc`]: `${U24}/id.G.nosuchuser` } }),
        ),
        empty: third(shape3, item2(), idSays('\n')),
        noPrimary: third(shape3, item2(), idSays('2001\n')),
        // the runner's own words for a call that gives no answer in time
        error: third(shape3, item2(), (argv, r) =>
          argv[0] === ID ? { error: 'id gave no answer within 5 s' } : r,
        ),
      };
      const got: Record<string, unknown> = {};
      for (const [k, rs] of Object.entries(kinds)) got[k] = await read(rs);
      const gap = (why: string, remedy = '') => ({
        readings: ['sudo unknown'],
        cause: `${GAP} ${why}${remedy}`,
      });
      // (1) red when a way `id -G` cannot be read falls back to "not allowed" again (9752398a: each
      //     reads not allowed, clause (g) — the walk's wrong "no", real rc 0), or names another
      //     reason; (2) prints each reading and cause.
      expect(got).toEqual({
        absent: gap('no id was found in the system folders', REMEDY),
        refused: gap('the check refused to run id'),
        notRoot: gap('id is not a root-owned system copy', REMEDY),
        writable: gap('id is root-owned, but this login can change it'),
        exit1: gap('id -G svc exited 1'),
        empty: gap('id -G svc printed no list of groups'),
        noPrimary: gap("id -G svc did not list svc's primary group"),
        error: gap('id gave no answer within 5 s'),
      });
    });

    it('C2’s scope: a group in the groups half and a `Defaults>%group` target read unknown too; a `%#gid` is matched by its number and keeps today’s reading', async () => {
      const groupsHalf = (out: string) =>
        out.replace(
          '    RunAsUsers: svc\n',
          '    RunAsUsers: agent\n    RunAsGroups: svcgrp\n    Options: !authenticate\n',
        );
      // (1) red: `groupsHalf` / `target` when the gap is read only for a run-as user list (not
      //     allowed); `gid` when a `%#gid` is matched by name in any case (unknown); (2) prints each.
      expect({
        groupsHalf: await read(third(groupsHalf, noId())),
        target: await read(third(specific('    Defaults>%svcgrp !authenticate'), noId())),
        gid: await fallback(third(runAs('%#2002', '!authenticate'), noId())),
      }).toEqual({
        groupsHalf: {
          readings: ['sudo unknown'],
          cause: `${GAP} no id was found in the system folders${REMEDY}`,
        },
        target: {
          readings: ['sudo unknown'],
          cause: `${GAP} no id was found in the system folders${REMEDY}`,
        },
        gid: { readings: NOT, clauses: ['g'] },
      });
    });

    it('C2: no case gap — under `!case_insensitive_group` or `match_group_by_gid` the fallback keeps today’s reading, clause (g) and all', async () => {
      const flagged = (flag: string) => fallback(third(both(shape3, defaults(flag)), noId()));
      // (1) red when the gap is read whatever the flags (each then reads unknown); (2) prints each.
      expect({
        nocase: await flagged('!case_insensitive_group'),
        byGid: await flagged('match_group_by_gid'),
      }).toEqual({
        nocase: { readings: NOT, clauses: ['g'] },
        byGid: { readings: NOT, clauses: ['g'] },
      });
    });

    it('C2: yes still beats unknown with no `id` — the audit’s B, B2, C and H, and one run-as list holding the group and svc', async () => {
      /** The captured nobody entry (NOPASSWD) with its run-as edited to `users`. */
      const nobodyTo = (users: string) => (out: string) =>
        out.replace('    RunAsUsers: nobody\n', `    RunAsUsers: ${users}\n`);
      const wheel = merge(noId(), {
        calls: { [`${GETENT} group wheel`]: `${U24}/getent.group.wheel.lists-root` },
      });
      const passwordNobody = (out: string) =>
        out.replace(
          '    RunAsUsers: nobody\n    Options: !authenticate\n',
          '    RunAsUsers: nobody\n',
        );
      // (1) red: `B`/`B2` when an entry that reads unknown ends the reading; `C` when svc's unknown
      //     drops root's cover; `H` when only the two NOPASSWD and `!authenticate` paths outrank the
      //     kept unknown (divergence 2); `one` when a token that reads unknown ends its entry
      //     (divergence 1); (2) prints each reading and what decided it.
      expect({
        B: await decided(third(both(nobodyTo('%svcgrp'), runAs('svc', '!authenticate')), noId())),
        B2: await decided(third(both(shape3, nobodyTo('svc')), noId())),
        C: await decided(third(nobodyTo('%wheel'), wheel)),
        H: await decided(
          third(both(specific('    Defaults>%svcgrp !authenticate'), passwordNobody), noId()),
        ),
        one: await decided(third(runAs('%svcgrp, svc', '!authenticate'), noId())),
      }).toEqual({
        B: { readings: ['sudo yes'], how: 'a NOPASSWD rule runs as svc' },
        B2: { readings: ['sudo yes'], how: 'a NOPASSWD rule runs as svc' },
        C: { readings: ['sudo yes'], how: 'a NOPASSWD rule runs as root' },
        H: {
          readings: ['sudo yes'],
          how: 'the rules were listed without a password (the cause is unknown)',
        },
        one: { readings: ['sudo yes'], how: 'a NOPASSWD rule runs as svc' },
      });
    });

    it('C3: a wrapped section header — a long host name at 80 columns, a 40-column terminal — reads as the header unwrapped, with or without a trailing space', () => {
      const HOST = 'realm-corpus-host-name-forty-five-characters1';
      const body = (matching: string[], runas: string[], user: string[]) =>
        [
          ...matching,
          '    env_reset, !authenticate',
          '',
          ...runas,
          '    Defaults>svc mailsub=x',
          '',
          ...user,
          '',
          'Sudoers entry: /etc/sudoers.d/realm',
          '    RunAsUsers: svc',
          '    Commands:',
          '\t/usr/bin/realm',
        ].join('\n');
      const flat = body(
        [`Matching Defaults entries for agent on ${HOST}:`],
        ['Runas and Command-specific defaults for agent:'],
        [`User agent may run the following commands on ${HOST}:`],
      );
      // as sudo 1.9.9 printed them in a 40-column terminal (the probes of 2026-10-23); the trailing
      // space is no printout's, and is read the same
      const wrapped = body(
        ['Matching Defaults entries for agent on', `    ${HOST}:`],
        ['Runas and Command-specific defaults for', '    agent:'],
        ['User agent may run the following', '        commands on', `        ${HOST}:`],
      );
      const spaced = body(
        ['Matching Defaults entries for agent on ', `    ${HOST}:`],
        ['Runas and Command-specific defaults for ', '    agent:'],
        [`User agent may run the following commands on ${HOST}:`],
      );
      // (1) red when a wrapped header is read as a line this check does not read (9752398a: unknown)
      //     or its 4-space line is read as the section's text; (2) prints each listing.
      expect({ wrapped: decoded(listing(wrapped)), spaced: decoded(listing(spaced)) }).toEqual({
        wrapped: decoded(listing(flat)),
        spaced: decoded(listing(flat)),
      });
    });

    it('C5: an 8-space line continues the line before only in the privileges section — in a Defaults section it is a line this check does not read', () => {
      const out = (line: string) =>
        listing(
          [
            'Matching Defaults entries for agent on h:',
            '    env_reset,',
            line,
            '',
            'User agent may run the following commands on h:',
            '    (svc) /usr/bin/realm',
          ].join('\n'),
        );
      // (1) red when an 8-space line joins in a Defaults section (sudo prints none there: it wraps a
      //     Defaults section with 4 spaces); (2) prints each listing's items or cause.
      expect({
        eight: out('        !authenticate'),
        four: decoded(out('    !authenticate')),
      }).toEqual({
        eight: { unknown: 'sudo listed a line this check does not read: !authenticate' },
        four: {
          global: [{ key: 'env_reset' }, { key: '!authenticate' }],
          specific: [],
          users: [['svc']],
          unsplit: [],
        },
      });
    });

    it('C6: a quoted `Defaults>` target says to write it without a space or a backslash; the exact read is named in the reading’s how', async () => {
      const target = parseListing(
        printout('env_reset', ['    Defaults>"a b" mailsub=x']),
        v('1.9.15p5'),
      );
      // (1) red: `quoted` when a target cause gives no remedy, or another branch's; `named` when the
      //     reading does not say `id -G` was read; (2) prints the cause and the how.
      expect({
        quoted: 'unknown' in target ? target.unknown : target.unsplit,
        named: (await read(third(shape3, item2()))).readings,
        how: (await third(shape3, item2()))[0]?.how,
      }).toEqual({
        quoted: [
          'sudo listed a Defaults line\'s target this check cannot split: Defaults>"a b" mailsub=x (write the target without a space or a backslash)',
        ],
        named: ['sudo yes'],
        how: 'LC_ALL=C /usr/bin/sudo -n -l and -n -ll and id -G svc and id -G root read: a NOPASSWD rule runs as svc',
      });
    });
  });

  // ─── #819 Unit A, the capped correction (PR #860, correction 2): no password real sudo accepts is
  // left out of the sentence. Real sudo first (plans/issue-627/w/unit-a/c2-ia2/probe/, two runs alike):
  // each cell's expected state is what sudo gave, or an honest unknown where this check cannot see what
  // sudo sees (the table pass, plans/issue-627/w/review-860/table-3a/TABLE-raw.md).

  /** The secondary-SVCGRP world, each lookup captured (fixtures/ubuntu-24.04/, 2026-10-20…24): svc
   *  999:1300 (svcown) and in SVCGRP (1500); svcgrp (1100) lists alice; wheel (1101) lists root;
   *  alice and agent found, ghost absent. No `id`, unless `id` names svc's and root's captures. */
  const world = (
    id?: { svc: string; root: string },
    over: Record<string, string> = {},
  ): MachineSpec =>
    merge(
      calls({
        'passwd svc': 'getent.passwd.svc.secondary-SVCGRP',
        'passwd alice': 'getent.passwd.alice.secondary-SVCGRP',
        'passwd agent': 'getent.passwd.agent.secondary-SVCGRP',
        'passwd ghost': 'getent.passwd.ghost.absent',
        'group 0': 'getent.group.0',
        'group 1300': 'getent.group.1300.secondary-SVCGRP',
        'group 1500': 'getent.group.1500.secondary-SVCGRP',
        'group 1101': 'getent.group.1101.lists-root',
        'group svcgrp': 'getent.group.svcgrp.secondary-SVCGRP',
        'group svcown': 'getent.group.svcown.secondary-SVCGRP',
        'group wheel': 'getent.group.wheel.lists-root.secondary-SVCGRP',
        'group WHEEL': 'getent.group.WHEEL.absent',
        ...over,
      }),
      id === undefined
        ? {}
        : {
            programs: { [ID]: 0 },
            calls: { [`${ID} -G svc`]: `${U24}/${id.svc}`, [`${ID} -G root`]: `${U24}/${id.root}` },
          },
    );
  /** `id -G` read: svc in svcown and SVCGRP (1300 1500); root in wheel (0 1101). */
  const IDS = { svc: 'id.G.svc.secondary-SVCGRP', root: 'id.G.root.in-wheel' };
  /** The captured NOPASSWD rule for nobody (so the rules are never "listed without a password"). */
  type Rule = [runas: string, options?: string | undefined, command?: string | undefined];
  const NB: Rule = ['nobody', '!authenticate', '/bin/true'];
  /** The captured listing's rules replaced by `entries` — each `[run-as, options?, command?]`, the
   *  run-as `users` or `users : groups` — with the global Defaults items `items` added (the
   *  cut-capture standard: the edit is named beside each cell). */
  const rules =
    (entries: Rule[], ...items: string[]) =>
    (out: string): string => {
      const head = out.slice(0, out.indexOf('User agent may run'));
      const listed =
        items.length > 0
          ? head.replace('    use_pty\n', `    use_pty, ${items.join(', ')}\n`)
          : head;
      return `${listed}User agent may run the following commands on h:\n\n${entries
        .map(([runas, options, command]) => {
          const [users, groups] = runas.split(' : ');
          return [
            'Sudoers entry: /etc/sudoers.d/realm',
            `    RunAsUsers: ${users}`,
            ...(groups !== undefined ? [`    RunAsGroups: ${groups}`] : []),
            ...(options !== undefined ? [`    Options: ${options}`] : []),
            '    Commands:',
            `\t${command ?? '/usr/bin/true'}`,
            '',
          ].join('\n');
        })
        .join('\n')}`;
    };
  /** The five policies (the prompt's grid rows), as the global Defaults items that set them. */
  const POLICY: Record<string, string[]> = {
    default: [],
    rootpw: ['rootpw'],
    targetpw: ['targetpw'],
    'runaspw svc': ['runaspw', 'runas_default=svc'],
    'runaspw nobody': ['runaspw', 'runas_default=nobody'],
  };
  /** A sudo reading and its password clauses — the strong sentence's (a) clauses, and (b) where a
   *  ticket fires it. */
  const judged = async (rs: Promise<SwitchPathReading[]>) =>
    rs.then((r) => {
      const sudo = r.filter((x) => x.path === 'sudo');
      return { readings: view(sudo), clauses: clauses(sudo) };
    });
  /** A reading's code, as the expected tables write it: yes, unknown, no, or whose password(s). */
  const N = (whose: string) => `sudo needs_credential ${whose} sudo_timestamp`;
  const CODE: Record<string, { readings: string[]; clauses: string[] }> = {
    yes: { readings: ['sudo yes'], clauses: [] },
    unknown: { readings: ['sudo unknown'], clauses: [] },
    no: { readings: ['sudo not_allowed'], clauses: [] },
    this_login: { readings: [N('this_login')], clauses: ['a:this_login', 'b'] },
    root: { readings: [N('root')], clauses: ['a:root', 'b'] },
    svc: { readings: [N('svc')], clauses: ['a:svc', 'b'] },
    'svc+root': { readings: [N('svc'), N('root')], clauses: ['a:svc', 'a:root', 'b'] },
    nobody: {
      readings: [N('named_user nobody')],
      clauses: ['a:named_user:nobody', 'b'],
    },
  };
  /** The tail of a reading's how: what decided it. */
  const tail = async (rs: Promise<SwitchPathReading[]>) =>
    rs.then((r) => {
      const sudo = r.filter((x) => x.path === 'sudo');
      return { readings: view(sudo), how: sudo[0]?.how.split(': ').slice(1).join(': ') };
    });
  /** The strong sentence for these ways (every other condition measured "no", --gate-answers
   *  withheld on the line), as the sentence describe builds it. */
  const NOC: ConditionReading = { basis: 'measured', answer: 'no' };
  const claimOf = (ways: SwitchPathReading[]): string => {
    const e: CheckEvidence = {
      login: 'agent',
      service_user: 'svc',
      store_owned_by_other: true,
      conditions: {
        store_reach: NOC,
        become_service_user: switchPathsReading(ways, 'svc'),
        root_engine: NOC,
        trust_root_writable: NOC,
        other_answer_host: { basis: 'unknown', cause: 'one look' },
        time_basis: { basis: 'measured', answer: 'fact', detail: 'clock' },
        agent_sandbox: NOC,
        economics_writable: { basis: 'measured', answer: 'fact', detail: 'none' },
      },
      switch_paths: ways,
      value: { value: 'withheld', source: { kind: 'flag', ref: '--gate-answers' } },
      store: '/home/svc/.realm',
      store_found: true,
      owns_store: false,
      door: 'mcp',
      extensions_unread: false,
    };
    return separationClaim(e);
  };
  /** Whose passwords a strong sentence names, in order — none when the sentence is not the strong one. */
  const named = (s: string): string[] =>
    s.includes('cannot record a gate answer')
      ? [...s.matchAll(/the agent cannot obtain ([^;]+?)'s password/g)].map((m) => m[1]!)
      : [];
  const CASE =
    'sudo matches group names in any case, so %s may be in %g under another case, and no id was found in the system folders (a root-owned id in a system folder lets this check read the groups)';
  const caseCause = (user: string, group: string) => CASE.replace('%s', user).replace('%g', group);

  describe("#819 Unit A, the capped correction: one target's cover never drops the other's unknown", () => {
    /** The grid's columns: svc's state (NOPASSWD, a password, the case gap with a password or
     *  NOPASSWD — svc is in SVCGRP, which `%svcgrp` names in another case — not covered) × root's,
     *  through `(%wheel)` (NOPASSWD, a password, not covered). */
    const SVC: Record<string, Rule[]> = {
      sNP: [['svc', '!authenticate']],
      sPW: [['svc']],
      gapPW: [['%svcgrp']],
      gapNP: [['%svcgrp', '!authenticate']],
      sNone: [],
    };
    const ROOT: Record<string, Rule[]> = {
      rNP: [['%wheel', '!authenticate']],
      rPW: [['%wheel']],
      rNone: [],
    };
    /** Real sudo's answer per cell, or an honest unknown (TABLE-raw.md, W-860-3A-07): under the
     *  default policy, rootpw and runaspw sudo asks one password whatever `-u` names. */
    const sameAsk = (w: string) => ({
      sNP: ['yes', 'yes', 'yes'],
      sPW: ['yes', w, w],
      gapPW: ['yes', w, 'unknown'],
      gapNP: ['yes', 'unknown', 'unknown'],
      sNone: ['yes', w, 'no'],
    });
    const EXPECTED: Record<string, Record<string, string[]>> = {
      default: sameAsk('this_login'),
      rootpw: sameAsk('root'),
      'runaspw svc': sameAsk('svc'),
      'runaspw nobody': sameAsk('nobody'),
      // targetpw: sudo asks the target's password, so an unknown cover of either target stays
      targetpw: {
        sNP: ['yes', 'yes', 'yes'],
        sPW: ['yes', 'svc+root', 'svc'],
        gapPW: ['yes', 'unknown', 'unknown'],
        gapNP: ['yes', 'unknown', 'unknown'],
        sNone: ['yes', 'unknown', 'no'],
      },
    };
    for (const policy of Object.keys(POLICY)) {
      it(`the grid, ${policy}: svc's state × root's through (%wheel), no id — each cell sudo's answer or an honest unknown, the sentence naming every password sudo asks`, async () => {
        const got: Record<string, unknown> = {};
        const want: Record<string, unknown> = {};
        for (const [s, se] of Object.entries(SVC)) {
          for (const [i, [r, re]] of Object.entries(ROOT).entries()) {
            const cell = `${s} × ${r}`;
            got[cell] = await judged(third(rules([NB, ...se, ...re], ...POLICY[policy]!), world()));
            want[cell] = CODE[EXPECTED[policy]![s]![i]!];
          }
        }
        // (a) red when one target's cover drops the other's unknown (`:1387`: targetpw sNone × rPW
        //     reads root's password only — W-860CR-01's printout; `:1388`'s mirror), or a password
        //     unknown is returned under a policy that asks one password whatever the target (default
        //     gapPW × rPW reads unknown — W-860-3A-08's cost); (b) prints each cell's readings and
        //     clauses.
        expect(got).toEqual(want);
      });
    }

    it('with id present, a spot row per policy: the gap and the mirror read as sudo gives them', async () => {
      const spot = async (policy: string, entries: Rule[]) =>
        judged(third(rules([NB, ...entries], ...POLICY[policy]!), world(IDS)));
      // (a) red when `id -G` stops deciding (the gap read anyway: unknown) or a cover is lost;
      //     (b) prints each.
      expect({
        default: await spot('default', [['%svcgrp'], ['%wheel']]),
        rootpw: await spot('rootpw', [['%svcgrp'], ['%wheel']]),
        targetpw: await spot('targetpw', [['%svcgrp'], ['%wheel']]),
        targetpwRootOnly: await spot('targetpw', [['%wheel']]),
        runaspwSvc: await spot('runaspw svc', [['%svcgrp'], ['%wheel']]),
        runaspwNobody: await spot('runaspw nobody', [['%svcgrp'], ['%wheel']]),
      }).toEqual({
        default: CODE['this_login'],
        rootpw: CODE['root'],
        targetpw: CODE['svc+root'],
        // svc is in neither wheel nor WHEEL by `id -G`: root's password only
        targetpwRootOnly: CODE['root'],
        runaspwSvc: CODE['svc'],
        runaspwNobody: CODE['nobody'],
      });
    });

    it('the audit’s `Defaults!` case (W-UAC2-AUD-03): a password rule whose command a `Defaults!` `!authenticate` line names keeps its unknown open', async () => {
      const progs = { programs: { '/usr/bin/true': 0, '/usr/bin/false': 0 } };
      const bang = (policy: string, extra: Rule[] = []) =>
        read(
          third(
            both(
              rules(
                [
                  NB,
                  ['%svcgrp', undefined, '/usr/bin/true'],
                  ['root', undefined, '/usr/bin/false'],
                  ...extra,
                ],
                ...POLICY[policy]!,
              ),
              specific('    Defaults!/usr/bin/true !authenticate'),
            ),
            merge(world(), progs),
          ),
        );
      const open = { readings: ['sudo unknown'], cause: caseCause('svc', 'svcgrp') };
      // (a) red when the `Defaults!` open kind is dropped (each reads needs: default this_login,
      //     rootpw root, runaspw svc, targetpw svc+root); (b) prints each reading and cause.
      expect({
        default: await bang('default'),
        rootpw: await bang('rootpw'),
        runaspwSvc: await bang('runaspw svc'),
        targetpw: await bang('targetpw', [['svc, root', undefined, '/usr/bin/false']]),
      }).toEqual({ default: open, rootpw: open, runaspwSvc: open, targetpw: open });
    });

    it('the guard and its mirror (W-UAC2R4-AUD-15): a `Defaults>` `!authenticate` target opens the kept unknown about the user it covers', async () => {
      // `%WHEEL`: getent finds no group of that name, and sudo matches names in any case — root (or
      // svc) may be in a wheel group of another case
      const WHEEL =
        'getent group WHEEL finds no group of that name, and sudo matches group names in any case (case_insensitive_group, on by default)';
      // (a) red when a `Defaults>` target opens no kept unknown (each reads needs this_login, with
      //     the strong sentence, while real sudo is passwordless if root — or svc — is in WHEEL),
      //     or one svc tag stands for both targets (the guard reads needs this_login); (b) prints both.
      expect({
        guard: await read(
          third(
            both(rules([NB, ['svc'], ['%WHEEL']]), specific('    Defaults>root !authenticate')),
            world(),
          ),
        ),
        mirror: await read(
          third(
            both(rules([NB, ['root'], ['%WHEEL']]), specific('    Defaults>svc !authenticate')),
            world(),
          ),
        ),
      }).toEqual({
        guard: { readings: ['sudo unknown'], cause: WHEEL },
        mirror: { readings: ['sudo unknown'], cause: WHEEL },
      });
    });

    it('rev 5.1 (IA 2’s finding, W-860-MA3-19): under targetpw a run-as group’s unknown beside a covering `(ALL)` is returned — the way it hides asks this login’s password, or a listed user’s', async () => {
      const all = (group: string, policy: string, id?: typeof IDS) =>
        read(third(rules([NB, ['ALL'], [`${group} : svcgrp`]], ...POLICY[policy]!), world(id)));
      // Real sudo (probe-c2 set H, ubuntu:24.04 and ubuntu:20.04, two runs each): with `(ALL)` beside
      // `(agent : svcgrp)` under targetpw, `sudo -S -g SVCGRP` takes this login's password; beside
      // `(alice : svcgrp)`, `-u alice -g SVCGRP` takes alice's. Before this fix both read "needs
      // svc's, root's" with the strong sentence.
      // (a) red when the group token's unknown is dropped because the covers name svc and root (the
      //     two `targetpw` cells read needs svc + root); (b) prints each reading and cause.
      expect({
        agent: await all('agent', 'targetpw'),
        alice: await all('alice', 'targetpw'),
        agentDefault: await all('agent', 'default'),
        agentId: await all('agent', 'targetpw', IDS),
        aliceId: await all('alice', 'targetpw', IDS),
      }).toEqual({
        agent: { readings: ['sudo unknown'], cause: caseCause('svc', 'svcgrp') },
        alice: { readings: ['sudo unknown'], cause: caseCause('svc', 'svcgrp') },
        // the default policy asks this login's password whatever the way: the unknown is dropped
        agentDefault: { readings: NEEDS, cause: undefined },
        agentId: { readings: [N('svc'), N('root'), N('this_login')], cause: undefined },
        aliceId: {
          readings: [N('svc'), N('root'), N('this_login'), N('named_user alice')],
          cause: undefined,
        },
      });
    });

    it('W-860CR-05: a lookup that errs keeps the cover its token already read — `(svc)` NOPASSWD with `getent passwd svc` erring reads as `(svc, ALL)` does', async () => {
      const errs = (argv: readonly string[], r: RunResult): RunResult =>
        argv.join(' ') === `${GETENT} passwd svc`
          ? { error: 'getent gave no answer within 5 s' }
          : r;
      // (a) red when the lookup's error zeroes the token's covers (unknown, W-860CR-05); (b) prints
      //     both readings.
      expect({
        svc: (await tail(third(rules([['svc', '!authenticate']]), world(), errs))).readings,
        svcAll: (await tail(third(rules([['svc, ALL', '!authenticate']]), world(), errs))).readings,
      }).toEqual({ svc: ['sudo yes'], svcAll: ['sudo yes'] });
    });

    it('W-860CR-01, MIR1, MIR2, MIR4 read unknown under targetpw; W-860CR-01 under the default policy needs this login’s password; B, B2, C yes and H unknown, as before', async () => {
      const errs0 = (argv: readonly string[], r: RunResult): RunResult =>
        argv.join(' ') === `${GETENT} group 0` ? { error: 'getent gave no answer within 5 s' } : r;
      const tpw = (entries: Rule[], over?: MachineSpec, wrap?: typeof errs0) =>
        read(third(rules([NB, ...entries], 'targetpw'), over ?? world(), wrap));
      // (a) red: CR-01 when root's cover drops svc's case gap (`:1387`: needs root, the strong
      //     sentence without svc's clause — real sudo -u svc takes svc's password, W-860-MA3-05);
      //     MIR1/MIR2/MIR4 when svc's cover drops root's unknown (`:1388`: needs svc only); CR-01d
      //     when a password unknown is returned under the default policy; B, B2, C when an unknown
      //     outranks a NOPASSWD rule; H when a `Defaults>` target's case gap or the rule's is dropped;
      //     (b) prints each reading, its cause, and what decided it.
      expect({
        cr01: await tpw([['%wheel']]),
        mir1: await tpw([['%svcown']]),
        mir2: await tpw([['%svcgrp']], world(IDS), errs0),
        mir4: await tpw(
          [['%svcgrp']],
          world(undefined, { 'group svcgrp': 'getent.group.svcgrp.lists-svc' }),
        ),
        cr01d: await read(third(rules([NB, ['%wheel']]), world())),
        B: await tail(
          third(
            rules([
              ['%svcgrp', '!authenticate', '/x'],
              ['svc', '!authenticate', '/y'],
            ]),
            world(),
          ),
        ),
        B2: await tail(
          third(
            rules([
              ['svc', '!authenticate', '/y'],
              ['%svcgrp', '!authenticate', '/x'],
            ]),
            world(),
          ),
        ),
        C: await tail(third(rules([['%wheel', '!authenticate']]), world())),
        H: await read(
          third(
            both(rules([NB, ['%svcgrp']]), specific('    Defaults>%svcgrp !authenticate')),
            world(),
          ),
        ),
      }).toEqual({
        // the case cause names the user it was recorded for (the walk's wording item): svc here
        cr01: { readings: ['sudo unknown'], cause: caseCause('svc', 'wheel') },
        mir1: {
          readings: ['sudo unknown'],
          cause: 'getent group svcown lists no members, so whether root is in it is unknown',
        },
        mir2: {
          readings: ['sudo unknown'],
          cause: 'getent group 0: getent gave no answer within 5 s',
        },
        // and root here
        mir4: { readings: ['sudo unknown'], cause: caseCause('root', 'svcgrp') },
        cr01d: { readings: NEEDS, cause: undefined },
        B: { readings: ['sudo yes'], how: 'a NOPASSWD rule runs as svc' },
        B2: { readings: ['sudo yes'], how: 'a NOPASSWD rule runs as svc' },
        C: { readings: ['sudo yes'], how: 'a NOPASSWD rule runs as root' },
        // the table pass's H (W-860-3A-05): unknown at da485ce5 and after
        H: { readings: ['sudo unknown'], cause: caseCause('svc', 'svcgrp') },
      });
    });

    it('the walk’s wording item: a fallback that reads not allowed says why `id -G` could not be read', async () => {
      // (a) red when the not-allowed how drops the reason (`Covers.idFails` not carried); (b) prints
      //     each how's tail.
      expect({
        nocase: await tail(third(rules([NB, ['%svcgrp']], '!case_insensitive_group'), world())),
        byGid: await tail(third(rules([NB, ['%svcgrp']], 'match_group_by_gid'), world())),
      }).toEqual({
        nocase: {
          readings: NOT,
          how: 'no rule runs as svc or root; id -G svc could not be read: no id was found in the system folders',
        },
        byGid: {
          readings: NOT,
          how: 'no rule runs as svc or root; id -G svc could not be read: no id was found in the system folders',
        },
      });
    });
  });

  describe('#819 Unit A, the capped correction: su toward root', () => {
    /** su at /usr/bin/su on Ubuntu 24.04, svc's shell runs commands (`getent.passwd.svc.bash`), root's
     *  entry from `rootEntry`, and the over spec. */
    const suRoot = (
      rootEntry = 'getent.passwd.root',
      over: MachineSpec = {},
      svcEntry = 'getent.passwd.svc.bash',
    ) =>
      paths(
        linux(
          U24,
          merge(
            merge(su(U24, svcEntry), {
              calls: { [`${GETENT} passwd root`]: `${U24}/${rootEntry}` },
            }),
            over,
          ),
        ),
      ).then((rs) => rs.filter((r) => r.path === 'su'));
    const hows = (rs: SwitchPathReading[]) =>
      rs.map(
        (r) => `${view([r])[0]} :: ${r.outcome === 'unknown' ? `${r.how} :: ${r.cause}` : r.how}`,
      );

    it('each su branch toward root, with svc’s reading beside it unchanged', async () => {
      const noRoot = linux(U24, su(U24, 'getent.passwd.svc.bash'));
      delete noRoot.calls![`${GETENT} passwd root`];
      const mac = await paths({
        platform: 'darwin',
        programs: { '/usr/bin/su': 0 },
        files: { '/etc/pam.d/su': { fixture: `${MAC}/pam.su` } },
      });
      const alpine = await paths({
        programs: { [GETENT]: 0, '/bin/su': 0, '/bin/busybox': 0 },
        links: { '/bin/su': '/bin/busybox' },
        calls: {
          [`${GETENT} passwd svc`]: `${ALP}/getent.passwd.svc.sh`,
          [`${GETENT} passwd root`]: `${ALP}/getent.passwd.root`,
        },
        files: { '/etc/shells': { fixture: `${ALP}/shells` } },
      });
      const PAMREAD =
        '/etc/pam.d/su, /etc/pam.d/common-auth, /etc/pam.d/common-account, /etc/pam.d/common-session, /etc/pam.d/su-l read';
      // (a) red when su is read toward svc only again (each loses its second line), or a branch's
      //     how names svc where it is about root; (b) prints each reading with its how (and cause).
      expect({
        entryUnread: hows((await paths(noRoot)).filter((r) => r.path === 'su')).map((h) =>
          h.replace(/:: getent passwd root: .*$/, ':: getent passwd root: …'),
        ),
        nologin: hows(await suRoot('getent.passwd.root.nologin')),
        emptyPassword: hows(await suRoot('getent.passwd.root.empty-pw')),
        busybox: hows(alpine.filter((r) => r.path === 'su')),
        mac: hows(mac.filter((r) => r.path === 'su')),
      }).toEqual({
        entryUnread: [
          `su needs_credential svc :: ${PAMREAD}`,
          'su unknown :: getent passwd root :: getent passwd root: …',
        ],
        nologin: [
          `su needs_credential svc :: ${PAMREAD}`,
          "su not_allowed :: getent passwd root and the shells files read: root's shell /usr/sbin/nologin runs no command",
        ],
        emptyPassword: [
          `su needs_credential svc :: ${PAMREAD}`,
          'su yes :: getent passwd root: its password field is empty',
        ],
        busybox: [
          "su needs_credential svc :: /bin/su is BusyBox's su, which reads no PAM stack and asks for svc's password",
          "su needs_credential root :: /bin/su is BusyBox's su, which reads no PAM stack and asks for root's password",
        ],
        mac: [
          "su unknown :: svc's shell :: dscl was not found in /usr/bin, /usr/sbin, /usr/local/bin, /usr/local/sbin, /bin, /sbin, /run/wrappers/bin, /run/setuid-programs or on PATH",
          "su unknown :: root's shell :: dscl was not found in /usr/bin, /usr/sbin, /usr/local/bin, /usr/local/sbin, /bin, /sbin, /run/wrappers/bin, /run/setuid-programs or on PATH",
        ],
      });
    });

    it('su’s PAM stacks are scanned once: a grant, an unknown or an ssh agent’s key is one reading, a person’s touch one reading, the password one per target', async () => {
      const withSu = (fixture: string) =>
        suRoot('getent.passwd.root', {
          files: { '/etc/pam.d/su': { fixture: `${U24}/${fixture}` } },
        }).then(view);
      // (a) red when a shared reading is given per target (two "su yes" or two "su unknown"), or the
      //     person reading is given per target; (b) prints each.
      expect({
        grant: await suRoot('getent.passwd.root', {
          files: { '/etc/pam.d/su-l': { fixture: `${U24}/variant.su-l-wheel-trust` } },
          calls: { [`${GETENT} group wheel`]: `${U24}/getent.group.wheel` },
        }).then(view),
        unknown: await withSu('variant.su-succeed-if'),
        // sudo's captured stacks with a person's key and with an ssh agent's key, given as su's
        person: await withSu('variant.sudo-u2f'),
        sshAgent: await withSu('variant.sudo-ssh-agent'),
        password: await suRoot().then(view),
      }).toEqual({
        grant: ['su yes'],
        unknown: ['su unknown'],
        person: [
          'su needs_credential svc',
          'su needs_credential root',
          'su needs_credential person',
        ],
        sshAgent: ['su unknown'],
        password: ['su needs_credential svc', 'su needs_credential root'],
      });
    });

    it('the differential’s shape: `(svc)` with a password under targetpw and su present — the sentence names root’s password too, and condition 2 lists su toward root', async () => {
      const ways = await third(
        defaults('targetpw'),
        merge(su(U24, 'getent.passwd.svc.bash'), { programs: { '/usr/bin/su': 0 } }),
      );
      // (a) red when su is read toward svc only (the sentence then names svc's password only, while
      //     `su root` with root's password exits 0 on all six images, W-860-MA3-07); (b) prints the
      //     passwords the sentence names and condition 2's su entries.
      expect({
        named: named(claimOf(ways)),
        su:
          switchPathsReading(ways, 'svc').basis === 'measured'
            ? ways
                .filter((r) => r.path === 'su')
                .map((r) => switchPathEntry(r, 'svc').split(' (')[0])
            : 'not measured',
      }).toEqual({
        named: ['svc', 'root'],
        su: ["su: needs svc's password", "su: needs root's password"],
      });
    });

    it('the typical server with su present: the sentence is the same but for root’s clause, which gains "and it is not empty"; condition 2 gains su’s entry toward root', async () => {
      const ways = await paths(linux(U24, merge(sudos(U24, 'password', ['sudo']), su(U24))));
      const s = claimOf(ways);
      // (a) red when root's clause keeps its old words, or su is read toward svc only; (b) prints
      //     the clause test and the su entries.
      expect({
        rootClause: s.includes("the agent cannot obtain root's password, and it is not empty;"),
        oldClause: s.includes("the agent cannot obtain root's password;"),
        su: ways.filter((r) => r.path === 'su').map((r) => view([r])),
      }).toEqual({
        rootClause: true,
        oldClause: false,
        su: [['su not_allowed'], ['su needs_credential root']],
      });
    });

    it('with Realm’s service user root, su is read once', async () => {
      const rs = await paths(
        linux(
          U24,
          merge(su(U24, 'getent.passwd.root'), {
            calls: { [`${GETENT} passwd root`]: `${U24}/getent.passwd.root` },
          }),
        ),
        'root',
      );
      // (a) red when root is read twice, as the user and as root; (b) prints the su readings.
      expect(view(rs.filter((r) => r.path === 'su'))).toEqual(['su needs_credential svc']);
    });
  });

  describe('#819 Unit A, the capped correction: Rocky’s PAM line, a global !authenticate, Defaults>', () => {
    it('Part 4: a pam_unix line with use_first_pass still reads unknown (it never asks, and fails where no earlier module took a password)', async () => {
      const lk = lookups(
        fixtureMachine(
          merge(linux(U24), {
            // an authored stack (no capture holds one): Rocky's system-auth line, try_first_pass
            // replaced by use_first_pass
            files: {
              '/etc/pam.d/su':
                'auth required pam_env.so\nauth sufficient pam_unix.so use_first_pass nullok\nauth required pam_deny.so\n',
            },
          }),
        ),
        'svc',
      );
      const scan = await scanPam(lk, 'su');
      // (a) red when use_first_pass is admitted with try_first_pass; (b) prints the scan.
      expect(scan).toEqual({
        unknown:
          "su's PAM stack has a line this check does not read: auth sufficient pam_unix.so use_first_pass nullok",
      });
    });

    it('Part 5: a global !authenticate reads yes only with a rule that runs as svc or root — with only (nobody) not allowed, with only a svc case gap unknown', async () => {
      // (a) red when the global line reads yes before any rule is read (`(nobody)`: yes, while real
      //     `sudo -n -u svc|root` exits 1 — probe-c2 P5); (b) prints each.
      expect({
        svc: await tail(third(rules([NB, ['svc']], '!authenticate'), world())),
        nobody: await tail(
          third(rules([['nobody', undefined, '/usr/bin/true']], '!authenticate'), world()),
        ),
        gap: await read(third(rules([['%svcgrp']], '!authenticate'), world())),
      }).toEqual({
        svc: {
          readings: ['sudo yes'],
          how: 'its Defaults turn the password off (!authenticate), and a rule runs as svc',
        },
        nobody: { readings: NOT, how: 'no rule runs as svc or root' },
        gap: { readings: ['sudo unknown'], cause: caseCause('svc', 'svcgrp') },
      });
    });

    it('Part 6: `Defaults>T !authenticate` counts only for a user a rule runs as', async () => {
      const dgt = (entries: Rule[], over: MachineSpec, ...items: string[]) =>
        third(both(rules(entries, ...items), specific('    Defaults>svc !authenticate')), over);
      const gapEvery: Record<string, unknown> = {};
      for (const policy of Object.keys(POLICY))
        gapEvery[policy] = await read(dgt([NB, ['%svcgrp']], world(), ...POLICY[policy]!));
      // (a) red: `cr09` and `wheelRoot` when a target that covers svc counts beside a rule that runs
      //     as no svc (yes, W-860CR-09; real sudo -n -u svc and -u root exit 1); `group` when a rule
      //     that reaches svc only through its run-as groups counts (yes, W-860-GPROBE-09); `gap`
      //     when the guard is dropped (needs, while sudo may ask none); (b) prints each.
      expect({
        cr09: await judged(dgt([NB, ['root']], world())),
        wheelRoot: await judged(dgt([NB, ['%wheel']], world(), '!case_insensitive_group')),
        gap: gapEvery,
        svc: (await read(dgt([NB, ['svc']], world()))).readings,
        group: await judged(dgt([NB, ['agent : svcgrp']], world(IDS))),
        bang: (
          await read(
            third(
              both(
                rules([NB, ['agent : svcgrp', undefined, '/usr/bin/true']]),
                specific('    Defaults!/usr/bin/true !authenticate'),
              ),
              merge(world(IDS), { programs: { '/usr/bin/true': 0 } }),
            ),
          )
        ).readings,
      }).toEqual({
        cr09: CODE['this_login'],
        // under !case_insensitive_group svc's place in wheel rests on wheel's listed members: (g)
        wheelRoot: { readings: CODE['this_login']!.readings, clauses: ['a:this_login', 'b', 'g'] },
        gap: Object.fromEntries(
          Object.keys(POLICY).map((p) => [
            p,
            { readings: ['sudo unknown'], cause: caseCause('svc', 'svcgrp') },
          ]),
        ),
        svc: ['sudo yes'],
        group: CODE['this_login'],
        bang: ['sudo yes'],
      });
    });
  });

  describe('#819 Unit A, the capped correction: the runas_default user’s password', () => {
    it('(svc) with a password under runaspw: the runas_default user’s password — nobody’s, alice’s, this login’s; svc’s and root’s as before; the sentence names it', async () => {
      const as = (user: string) => third(defaults('runaspw', `runas_default=${user}`), world());
      const nobody = await as('nobody');
      // (a) red when another user reads unknown again (`runaspwCause`: "sudo asks for nobody's
      //     password"; real sudo -S -u svc takes nobody's, probe-c2 P7), or this login is named as
      //     another user; (b) prints each reading and the passwords the sentence names.
      expect({
        nobody: view(nobody.filter((r) => r.path === 'sudo')),
        nobodySentence: claimOf(nobody).includes(
          "the agent cannot obtain nobody's password, and it is not empty",
        ),
        alice: (await judged(as('alice'))).readings,
        agent: (await judged(as('agent'))).readings,
        svc: (await judged(as('svc'))).readings,
        root: (await judged(as('root'))).readings,
      }).toEqual({
        nobody: [N('named_user nobody')],
        nobodySentence: true,
        alice: [N('named_user alice')],
        agent: [N('this_login')],
        svc: [N('svc')],
        root: [N('root')],
      });
    });

    it('one clause per named user, in order of first appearance, after an administrator’s', () => {
      const r = (whose: SwitchPathReading['whose'], user?: string): SwitchPathReading => ({
        path: 'sudo',
        outcome: 'needs_credential',
        how: 'h',
        ...(whose !== undefined ? { whose } : {}),
        ...(user !== undefined ? { user } : {}),
      });
      const s = claimOf([
        r('named_user', 'bob'),
        r('administrator'),
        r('named_user', 'alice'),
        r('named_user', 'bob'),
      ]);
      // (a) red when a named user is given no clause, a clause per reading, or the order moves;
      //     (b) prints the passwords the sentence names, and whether each is "not empty".
      expect({
        named: named(s),
        bob: s.includes("the agent cannot obtain bob's password, and it is not empty"),
      }).toEqual({ named: ['an administrator', 'bob', 'alice'], bob: true });
    });
  });

  describe('#819 Unit A, the capped correction: a run-as group is read as sudo reads it', () => {
    it('(a) match_group_by_gid does not apply to a run-as group list: `(agent : svcgrp)` with `id -G` read, svc only in SVCGRP', async () => {
      const g = (
        policy: string,
        extra: string[] = [],
        options?: string,
        runas = 'agent : svcgrp',
        id: typeof IDS | undefined = IDS,
      ) => judged(third(rules([NB, [runas, options]], ...POLICY[policy]!, ...extra), world(id)));
      const BYGID = ['match_group_by_gid'];
      // (a) red when the flag is applied to the group list again (each reads not allowed: real
      //     `sudo -g SVCGRP` gives gid 2001, W-860-GPROBE-01); `exact` when !case_insensitive_group
      //     stops deciding; `noId*` when the fallback stops reading the case gap; (b) prints each.
      expect({
        nopasswd: await g('default', BYGID, '!authenticate'),
        password: await g('default', BYGID),
        rootpw: await g('rootpw', BYGID),
        runaspw: await g('runaspw svc', BYGID),
        targetpw: await g('targetpw', BYGID),
        exact: await g('default', [...BYGID, '!case_insensitive_group'], '!authenticate'),
        gid: await g(
          'default',
          [...BYGID, '!case_insensitive_group'],
          '!authenticate',
          'agent : #1500',
        ),
        gidNoFlags: await g('default', [], '!authenticate', 'agent : #1500'),
        noIdNopasswd: await read(
          third(rules([NB, ['agent : svcgrp', '!authenticate']], ...BYGID), world()),
        ),
        noIdPassword: await read(third(rules([NB, ['agent : svcgrp']], ...BYGID), world())),
      }).toEqual({
        nopasswd: CODE['yes'],
        password: CODE['this_login'],
        rootpw: CODE['root'],
        runaspw: CODE['svc'],
        targetpw: CODE['this_login'],
        exact: CODE['no'],
        gid: CODE['yes'],
        gidNoFlags: CODE['yes'],
        noIdNopasswd: { readings: ['sudo unknown'], cause: caseCause('svc', 'svcgrp') },
        noIdPassword: { readings: ['sudo unknown'], cause: caseCause('svc', 'svcgrp') },
      });
    });

    it('(b) and Part 9: under targetpw a way through a run-as group asks the password of the user it runs as — this login’s, and each plain user name’s', async () => {
      const t = (
        runas: string,
        extra: string[] = [],
        over: Record<string, string> = {},
        id = IDS,
      ) => read(third(rules([NB, [runas]], 'targetpw', ...extra), world(id, over)));
      const NOT_ROOT = { svc: IDS.svc, root: 'id.G.root' };
      const alice = [N('this_login'), N('named_user alice')];
      // (a) red: `agent` when a group-reached entry names svc's password (W-860-GPROBE-04: svc's
      //     never works for it); `alice*` when a plain user name is not named (alice's password works
      //     for `-u alice -g SVCGRP`, probe-c2) or reads unknown (Part 9's break); `wheel` when a
      //     `%group` of other users is read as covering nobody (it reads no password, the safe side
      //     lost); `ghost` when a name getent cannot find is skipped while names match in any case;
      //     (b) prints each reading and cause.
      expect({
        agent: await t('agent : svcgrp'),
        alice: await t('alice : svcgrp'),
        agentAlice: await t('agent, alice : svcgrp'),
        svcAlice: await t('svc, alice : svcgrp'),
        wheel: await t('%wheel : svcgrp', [], { 'group wheel': 'getent.group.wheel' }, NOT_ROOT),
        wheelHoldsRoot: await t('%wheel : svcgrp'),
        root: await t('root : svcgrp'),
        svc: await t('svc : svcgrp'),
        all: await t('ALL : svcgrp'),
        ghost: await t('ghost : svcgrp'),
        ghostExact: await t('ghost : svcgrp', ['!case_insensitive_user']),
      }).toEqual({
        agent: { readings: [N('this_login')], cause: undefined },
        alice: { readings: alice, cause: undefined },
        agentAlice: { readings: alice, cause: undefined },
        svcAlice: {
          readings: [N('svc'), N('this_login'), N('named_user alice')],
          cause: undefined,
        },
        wheel: {
          readings: ['sudo unknown'],
          cause:
            "under targetpw sudo asks the password of the user a way runs as, and this rule's user list holds %wheel, whose password this check does not name",
        },
        // wheel lists root: `%wheel` covers root, and real sudo -u root -g SVCGRP takes root's
        // password (probe-c2, 1.8.31 and 1.9.15p5)
        wheelHoldsRoot: { readings: [N('root'), N('this_login')], cause: undefined },
        root: { readings: [N('root'), N('this_login')], cause: undefined },
        svc: { readings: [N('svc'), N('this_login')], cause: undefined },
        // the limit: a user list of ALL — the other users' passwords are not named
        all: { readings: [N('svc'), N('root'), N('this_login')], cause: undefined },
        ghost: {
          readings: ['sudo unknown'],
          cause:
            'getent passwd ghost finds no user of that exact case, and sudo matches user names in any case',
        },
        ghostExact: { readings: [N('this_login')], cause: undefined },
      });
    });

    it('(b) the sentence names this login’s password for a group way, and alice’s for `(alice : svcgrp)`; the other policies are unchanged', async () => {
      const ways = (runas: string, policy: string) =>
        third(rules([NB, [runas]], ...POLICY[policy]!), world(IDS));
      // (a) red when the group way's passwords leave the sentence, or a policy that asks one password
      //     whatever the user starts naming the user list's; (b) prints each.
      expect({
        agentSentence: named(claimOf(await ways('agent : svcgrp', 'targetpw'))),
        aliceSentence: named(claimOf(await ways('alice : svcgrp', 'targetpw'))),
        aliceDefault: (await judged(ways('alice : svcgrp', 'default'))).readings,
        aliceRootpw: (await judged(ways('alice : svcgrp', 'rootpw'))).readings,
        aliceRunaspw: (await judged(ways('alice : svcgrp', 'runaspw svc'))).readings,
      }).toEqual({
        agentSentence: ['agent'],
        aliceSentence: ['agent', 'alice'],
        aliceDefault: [N('this_login')],
        aliceRootpw: [N('root')],
        aliceRunaspw: [N('svc')],
      });
    });

    it('(c) the words: a rule that reaches svc only through its run-as groups runs "with a group that svc is in", never "as svc"', async () => {
      const np = (runas: string, ...items: string[]) =>
        tail(third(rules([NB, [runas, '!authenticate']], ...items), world(IDS)));
      // (a) red when a group-reached entry says "runs as svc" again (real sudo refuses -u svc for
      //     it), or a user cover's words are lost beside the group's; (b) prints each how's tail.
      expect({
        agent: await np('agent : svcgrp'),
        root: await np('root : svcgrp'),
        svcGroup: await np('svc : svcgrp'),
        svc: await np('svc'),
        noauth: await tail(third(rules([NB, ['agent : svcgrp']], '!authenticate'), world(IDS))),
        why: (await third(rules([NB, ['agent : svcgrp']]), world(IDS)))[0]?.how.split('; ')[0],
      }).toEqual({
        agent: { readings: ['sudo yes'], how: 'a NOPASSWD rule runs with a group that svc is in' },
        root: {
          readings: ['sudo yes'],
          how: 'a NOPASSWD rule runs as root or with a group that svc is in',
        },
        svcGroup: { readings: ['sudo yes'], how: 'a NOPASSWD rule runs as svc' },
        svc: { readings: ['sudo yes'], how: 'a NOPASSWD rule runs as svc' },
        noauth: {
          readings: ['sudo yes'],
          how: 'its Defaults turn the password off (!authenticate), and a rule runs with a group that svc is in',
        },
        // a run-as group is read for svc only, so only svc's `id -G` is named
        why: 'LC_ALL=C /usr/bin/sudo -n -l and -n -ll and id -G svc read: a rule runs with a group that svc is in with a password',
      });
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
    // :: "01b #2: condition 2's line"; #819 Unit B: "as above" — separation-check-627 :: "#819 Unit B:
    // the words" (3a–3h) and the re-pinned "01b #2: condition 2's line".
    claim(
      'It reads each way from this login to the user Realm runs as, and prints one entry per way, `way: reading (how it was read)`, measured now, with `as above` in place of how it was read when an entry was read the same way as the one before it:',
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
    // #819 follow-up 2 (member 5): `#uid` and `%#gid` as numbers — :: "P1: `(#0999)` …", :: "Q2: `(%#01400)` …".
    // #819 Unit A, the capped correction (Part 8 (c), Part 5): "or with a group that user is in" — :: "(c) the words …" (the NOPASSWD and global !authenticate yes), :: "Part 5: a global !authenticate reads yes only with a rule …".
    claim(
      "A rule that runs as Realm's user or root, or with a group that user is in, without a password reads yes, whatever command it is limited to, and so does a `Defaults` line that may turn the password off for such a rule. A run-as name counts by its uid, so another name for root or for the user counts too; `#uid` and `%#gid` are read as the numbers sudo reads (`#0999` is uid 999).",
    );
    // :: "a listing with no NOPASSWD entry …", :: "A §F8: `exempt_group` … `listpw=all` …".
    // #819 follow-up 2 (member 4): :: "P2: `exempt_group=Sudo` …", :: "controls: under match_group_by_gid …".
    claim(
      "Rules listed although none of them waives the password read yes too: a cached credential, among other causes, lets them be listed. So do `exempt_group` naming a group this login may be in (its name compared with the names of this login's groups as sudo compares them), and a listing shown under `listpw=all`.",
    );
    // :: "`rootpw` …", :: "`targetpw` …", :: "A §F6: `runaspw` …", :: "A §F4: sudo-rs's listings …",
    // :: "classic sudo refused …", :: "sudo-rs "interactive authentication is required" …".
    // #819 Unit A re-pin (A8): the two sentences now hold A6's runaspw sentence between them (its own
    // claim, below); each is claimed apart.
    // #819 Unit A, the capped correction (Part 7): "or a named user's under runaspw" — :: "(svc) with a password under runaspw: the runas_default user’s password …".
    claim(
      "In the original sudo's listing, a rule that needs a password reads \"needs\" that password: this login's, or root's or the user's under `rootpw`, `targetpw` or `runaspw`, or a named user's under `runaspw`.",
    );
    claim(
      "Where sudo shows no Defaults — sudo-rs's listings and either sudo's refusal — the password may be this login's, root's or the user's, and all three are read.",
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
    // #819 correction 1 (C-11): "and the service `pam_askpass_service` names" — :: "C-1 (A BLOCKING 1):
    // a listed pam_askpass_service …".
    claim(
      'Whenever sudo needs a password, its PAM stacks are read too: `/etc/pam.d/sudo`, and `sudo-i` where it exists (or, in the original sudo\'s listing, the services `pam_service` and `pam_login_service` name), and the service `pam_askpass_service` names, with their includes. A security-key or fingerprint module adds "a person\'s touch or key"; an ssh-agent module, or a stack with no password or person module, reads unknown; a `pam_wheel.so trust` line for this login reads yes where a rule is listed or the sudo-rs refusal names one, and unknown where the original sudo refused.',
    );
    // #819 correction 1 (C-11): :: "C-16 (d): one ticket for every session …".
    claim(
      "A `timestamp_type` other than `tty` or `ppid`, or `!tty_tickets`, shares one ticket across the login's sessions, and reads unknown.",
    );
    // :: "C-17 (e): sudo matches run-as names in any case …".
    // #819 follow-up 2 (member 3): :: "the audit’s S2 (Q1a) …", :: "the audit’s S2: `%Svcgrp`, absent …", :: "A B3: `%SVCGRP` …", :: "A S2: under match_group_by_gid …"; C-17 (the any-case user names).
    // #819 follow-up 3 (A B4): "a secondary group named only in another case is not seen" — :: "the
    // audit’s S2, recorded (Q1b): svc listed in SVCGRP, `%svcgrp` naming only alice’s → not allowed …".
    // #819 Unit A (A1, A4; A8 rewrites this paragraph's group sentences): the listing read as sudo
    // prints it — sudo-corpus :: T1 (every item, six versions), T2; "#819 Unit A" :: "P2 …" and "the
    // second audit’s B1(a) …" (cannot split), "a target list in each separator …" (a target holding a
    // space, a regex), "A4: …" (a run-as list it cannot split).
    // The Unit A correction re-pin (C1): "on each version" now holds for a backslash outside quotes —
    // "the Unit A correction" :: "C1: a backslash outside quotes pairs only where …" (S1, G1), "C1:
    // with sudo’s version not known …", "C1: a run-as list is read by the version too …"; sudo-corpus
    // :: T1's rows I81, I82 (a value ending in a backslash before another line, a stored `\"`).
    claim(
      "The check reads sudo's listing as sudo prints it on each version: a Defaults setting it cannot split reads unknown, unless sudo already reads yes, since a value with a space that ends in a backslash, or holds a backslash before a quotation mark, prints the same as another setting — write such a value without one; so does a `Defaults!` target holding a space or a regular expression, and a run-as list it cannot split reads unknown.",
    );
    // :: "C-17 (e): sudo matches run-as names in any case …" (its user halves).
    claim(
      'Run-as user names match in any case, as sudo matches them, unless `!case_insensitive_user` is listed.',
    );
    // #819 Unit A (A3): "#819 Unit A" :: "by gid (match_group_by_gid) …" (an exact name's gid; absent
    // does not hold; all digits unknown), :: "by name …" (each gid named, any case, exactly under
    // !case_insensitive_group, a gid with no name skipped); sudo-corpus :: T3 grp-* (sudo's verdicts).
    // #819 Unit A, the capped correction (Part 8 (a)): which list — a `%group` of a user list as before (:: "by gid (match_group_by_gid) …", :: "by name …"); a group after the `:` by name alone — :: "(a) match_group_by_gid does not apply to a run-as group list …" (nopasswd … exact, gid).
    claim(
      "A run-as group is compared with the user's groups as sudo reads them, which `id -G` lists.",
    );
    claim(
      "A `%group` in a rule's user list is compared as sudo's `user_in_group` compares it: under `match_group_by_gid`, by the gid of the group `getent` finds by that exact name (a name it finds no group for does not hold the user, and an all-digit name reads unknown); otherwise by the name `getent` gives each of those groups, in any case unless `!case_insensitive_group` is listed (a group with no name is skipped, as sudo skips it).",
    );
    claim(
      "A group after the `:` of a rule's run-as list is compared by name alone, as sudo compares it: by the name `getent` gives each of those groups, in any case unless `!case_insensitive_group` is listed, whether or not `match_group_by_gid` is, and `#gid` as a number.",
    );
    // #819 Unit A (A3): :: "`%#gid` compared with the set as a number …" (and `%:name`).
    claim(
      "`%#gid` is compared as a number, and `%:group`, which only sudo's group plugin matches, reads unknown.",
    );
    // #819 Unit A (A3): :: "each fallback …" (no id, refused, not root-owned, exit 1, empty, no
    // primary gid); the fallback's own cells: "the audit’s S2 (Q1a) …", "the audit’s S2: `%Svcgrp`,
    // absent …", "A B3: `%SVCGRP` …", "A S2: under match_group_by_gid …" (member 3), C-17's history.
    // The Unit A correction re-pin (C2): the sentence ends at the group `getent` finds; what a group
    // that does not hold the user reads is the next sentence.
    // #819 Unit A, the capped correction (Part 8 (a)): match_group_by_gid only for a `%group` — :: "(a) …" (noIdNopasswd, noIdPassword: the any-case fallback for a run-as group under match_group_by_gid).
    claim(
      "Where `id -G` gives no answer that holds the user's primary group, a run-as group is read from the groups' lists instead: unless `!case_insensitive_group` is listed, or `match_group_by_gid` for a `%group` in a user list, either of which makes sudo match a group exactly, run-as group names are compared in any case with the user's primary group and with the group `getent` finds.",
    );
    // The Unit A correction (C2, W-UA-MA3-02): "the Unit A correction" :: "C2: where `id -G` cannot be
    // read, the walk’s shape 3 reads unknown …" (each way), "C2’s scope …", "C2: no case gap …"
    // (either flag: as today), "C2: yes still beats unknown …"; "#819 Unit A" :: "each fallback …";
    // sudo-corpus :: T3 (grp-fedora-edited: the exact read decides).
    // #819 Unit A, the capped correction (Parts 1, 2, 8 (b), 9; rev 5.1): the exception — :: "the grid, …" (each policy), :: "rev 5.1 (IA 2’s finding …)" (never for a group after the `:` under targetpw); targetpw's group way — :: "(b) and Part 9: under targetpw a way through a run-as group asks …" (agent, alice, agentAlice, svcAlice, wheel, ghost, ghostExact; all and wheelHoldsRoot: the limit), :: "(b) the sentence names this login’s password …"; real sudo: plans/issue-627/w/unit-a/c2-ia2/probe (1.8.31 and 1.9.15p5).
    claim(
      "When `id -G` cannot be read, unless `!case_insensitive_group` is listed, or `match_group_by_gid` for a `%group` in a user list, a run-as group that does not hold the user by its list or primary group reads unknown, since a secondary group named only in another case is not seen — unless sudo already reads yes, or the rule needs a password, another rule runs as Realm's user or root, or with a group that user is in, and sudo would ask the same password either way (under the default, `rootpw` and `runaspw`; under `targetpw` only when rules already run as both, and never for a group after the `:`, whose way asks this login's password or a listed user's).",
    );
    claim(
      'Under `targetpw` a way through a run-as group asks the password of the user it runs as.',
    );
    claim(
      "`sudo -g` alone runs as this login (sudo 1.8.31 and 1.9.9 allow it for any rule with that group, newer sudo when the login is in the rule's user list), so this check names this login's password for every such rule, and also the password of every plain user name the rule's user list holds.",
    );
    claim(
      'It reads unknown where that list holds a name `getent` cannot find, since names match in any case (unless `!case_insensitive_user` is listed), and where a rule that reaches the user only through its run-as groups lists a `%group` or a `+netgroup` that holds neither the user nor root, or a `#uid` of another user.',
    );
    claim(
      "A user list of `ALL`, an alias or a negation, or a `%group` or `+netgroup` that holds the user or root, runs as other users too: for such a rule only this login's, the user's and root's passwords are named.",
    );
    // #819 Unit A (A6): :: "A6: runaspw — unset or root, the service user, another user, absent, `#…`,
    // all digits, a name the rail refuses"; sudo-corpus :: T3 runaspw-* (sudo refuses each).
    // #819 Unit A, the capped correction (Part 7): another user needs that user's password — :: "A6: runaspw …" (other: nobody, re-pinned), :: "(svc) with a password under runaspw …"; the rest as before (A6's absent, hash, digits).
    claim(
      "Under `runaspw`, `runas_default` is looked up by name, as sudo looks it up: another user needs that user's password, and a name no user has, and `#0` or an all-digit name, which sudo reads as a name, read unknown.",
    );
    // :: "C-18 (f): the group source …" (its first cell: each source; (vi): this login's own groups).
    // #819 follow-up 2 (members 2, 8; A MINOR 5): :: "P4 …", "P5 …", "P6 …", "P7 …", "controls: one group and one initgroups line …", "no group line, or no file, with /var/run/nscd/socket there …"; C-18 (a member found from any source counts: its ldap row's unknown, never a "not in it").
    claim(
      "A run-as group that does not list the user is read as not holding it only when the `group` and `initgroups` lines of `/etc/nsswitch.conf`, read as glibc reads them, list local sources (`files`, `compat`, `db` or `systemd`, or `sss` while SSSD's socket is absent); another source reads unknown, and so do a second line of either name, a `#` after the name, a line with no `:`, sources the check cannot split, and a file with no `group` line while nscd's socket is there (musl asks nscd). A member found from any source counts.",
    );
    // 02 W5: :: "#819 correction 1 C-20: clause (g) prints once …" (clause (g)'s words match it).
    // #819 follow-up 2 (A S1; reader B's M3): :: "#819 correction 1 C-20 …" (clause (g), re-pinned), :: "W-x3b".
    claim(
      "Group membership is read as the system lists it: a member the system does not list is not seen, so when a reading rested on a group's listed members, the stronger sentence holds only if the members the system lists for each group read are all of its members.",
    );
    // :: "B §9: svc's passwd entry not read …"; :: "svc's shell /usr/sbin/nologin …", :: "… listed in
    // /etc/shells".
    // #819 (08, B F5): macOS's dscl too — :: "the real Ubuntu 24.04, Debian and Fedora su stacks …;
    // macOS's, with svc's shell not read, → unknown (B F5)".
    // #819 follow-up 2 (member 7): :: "a trailing comment after the shell, or text before its `/` …".
    // #819 Unit A, the capped correction (Part 3): toward root too — :: "each su branch toward root, with svc’s reading beside it unchanged", :: "the differential’s shape …"; real su: `su root` with root's password exits 0 on all six images (unit-a/diff/out/su-probe-*.txt).
    claim(
      "su is read toward the user and toward root alike, since root can become the user: each needs that user's password, and each is read from its own passwd entry and shell.",
    );
    claim(
      "When `getent` cannot read a target's passwd entry, or on macOS `dscl` its shell, su reads unknown toward it. When a target's shell runs no command (`/usr/sbin/nologin`, `/sbin/nologin`, `/bin/false` or `/usr/bin/false`) and no shells file lists it, each line read as `getusershell` reads it (from its first `/` to a space or a `#`), su reads not allowed toward it.",
    );
    // :: "an empty password field and a shell that runs commands".
    // #819 Unit A, the capped correction (Part 3): :: "each su branch toward root …" (emptyPassword).
    claim("An empty password field in a target's passwd entry reads yes.");
    // :: "the real Ubuntu 24.04, Debian, Fedora and macOS su stacks", :: "01b #11: su-l carries …".
    // #819 Unit A, the capped correction (Part 3): once for both — :: "su’s PAM stacks are scanned once …".
    claim(
      'Otherwise su\'s PAM stacks, `su` and `su-l`, are read once for both: a password module reads "needs" each target\'s password, and a `pam_wheel.so trust` line for this login reads yes.',
    );
    // :: "BusyBox su (Alpine, no PAM stack) → needs svc's password, whatever svc's shell (B §11)".
    // #819 Unit A, the capped correction (Part 3): :: "each su branch toward root …" (busybox), :: "BusyBox su (Alpine …)" (re-pinned).
    claim(
      "BusyBox's su, which reads no PAM stack, needs each target's password, whatever its shell: whether it keeps a shell that runs no command depends on how it was built.",
    );
    // :: "`permit nopass agent as svc cmd /usr/bin/realm` readable", :: "rules only in
    // /etc/doas.d/realm.conf", :: "`deny agent` …", :: "B §2: …" (two cells).
    claim(
      "Its rules in `/etc/doas.conf` and `/etc/doas.d/*.conf` are read, and doas is asked `doas -C <file> -u <user> <command>` for Realm's user and root — for each command a rule names (with one more argument too, unless the rule fixes its arguments) and for a command no rule names: `permit nopass` reads yes, `permit` needs this login's password, and `deny` reads not allowed.",
    );
    // :: "pkcheck: manage-units 0, exec 2", :: "stock polkit … every action D9 names is asked", the spy.
    // #819 follow-up 2 (member 1): :: "systemd as PID 1, no machinectl → both shells asked …".
    claim(
      "`pkcheck --action-id <action> --process <pid>` is asked, without `--allow-user-interaction`, for pkexec's own action and each program pkexec runs where pkexec is present, and for `org.freedesktop.systemd1.manage-units` (run0 and `systemd-run`) and machine1's shells (machinectl) where systemd runs as PID 1, since any D-Bus client reaches them.",
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
    // #819 Unit A, the capped correction (Part 2; rev 5.1): the exception — :: "the grid, …" (the default, rootpw and runaspw rows drop a password unknown; targetpw keeps it unless rules run as both), :: "rev 5.1 …", :: "the audit’s `Defaults!` case …", :: "the guard and its mirror …".
    claim(
      "A rule the check does not recognise, a file it cannot read, or a tool's error reads unknown, with the tool's own line, and then the stronger sentence is not printed, unless sudo already reads yes, or the unknown is only whether a rule that needs a password runs as Realm's user or root, or with a group that user is in, another rule does, and sudo would ask the same password either way (under the default, `rootpw` and `runaspw`; under `targetpw` only when rules already run as both, and never for a group after the `:`).",
    );
    // #819 correction 1 (C-11): :: "C-2: a Defaults setting in no list …", :: "C-4", :: "C-7", :: "C-12"
    // (unknown), :: "C-6 (01b #6): an item not read never shadows a yes …" (unless yes), :: "C-13
    // (a): an acted-on keyword listed twice …" (twice).
    // #819 follow-up 2 (A B4): "a setting it acts on" — :: "C-13 (a) …" (an acted-on keyword twice), :: "A S2: under match_group_by_gid …" (match_group_by_gid twice); a harmless one twice is read (W-829c1-A-07).
    claim(
      "A sudo Defaults setting or long-format option the check does not read makes sudo's reading unknown, unless sudo already reads yes, with sudo's own line; so does a setting it acts on, listed twice with different values, since sudo does not show which one applies.",
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
    // #819 Unit A, the capped correction (Parts 3, 7; W-860-MA3-13): a named user's, and "not empty" for all but an administrator's — :: "W-x3a", :: "W-x3b" (root's clause, re-pinned), :: "one clause per named user …"; core separation-790 :: "(a), #819 Unit A, the capped correction (Part 7) …".
    claim(
      "the agent cannot obtain a password a way needs (this login's, the user's, root's, a named user's or an administrator's); for all but an administrator's, that it is not empty, since an empty one sits where this login cannot read it;",
    );
    claim(
      "nobody authenticates, as this login where the agent's processes run, those of sudo, doas and polkit whose password cache a way showed, because each then waives the password for some minutes;",
    );
    // #819 (08, A F4): :: "W-x3a", :: "W-x3b" (clause (c)'s words); sudo 1.9.15p5's auth/pam.c:220-226
    // (the services; W-819-790 rows) and check.c:61-80 (runaspw). #819 correction 1 (C-10, C-11):
    // `timestamp_type` and `pam_askpass_service` — :: "W-x3a", :: "W-x3b" (the new words).
    // #819 follow-up 2 (A S3): :: "W-x3a", :: "W-x3b" (clause (c) names tty_tickets, timestampdir and timestampowner).
    claim(
      'sudo turns off its password only through `NOPASSWD` tags, when the original sudo refused the listing, because its refusal hides `listpw`, the `Defaults!…` and `Defaults>…` lines, `runaspw`, `timestamp_type`, `tty_tickets`, `timestampdir` and `timestampowner`, and the PAM services `pam_service`, `pam_login_service` and `pam_askpass_service` name;',
    );
    // :: "W §5, W §8: clause (d) names the entry points of the actions asked (#819, 08 B F11) …",
    // :: "W-x3b".
    // #819 follow-up 2 (A MINOR 4, member 1): :: "systemd as PID 1, no machinectl …" (machine1's shells by their ids), :: "walk --check wording 6 …" (manage-units by its id).
    claim(
      "no polkit rule grants this login the entry points of the actions asked (pkexec for its own action and each program it runs, run0 and `systemd-run` for `manage-units`, machinectl for machine1's shells, an action named by its id when none of its entry points is present; polkit's actions when none is asked) beyond what the check's own session was shown, when polkit is present: the condition says which rules folder cannot be read here and which is not read;",
    );
    claim(
      "no person approves a Touch ID, fingerprint or security-key prompt the agent raises, when a way needs a person's touch or key;",
    );
    // #819 (08, B F9): :: "B F9: an sshd and no ~/.ssh → ssh listed, …, and clause (f)".
    claim("the user's `authorized_keys` holds none of this login's keys, when an sshd is present;");
    // #819 correction 1 (C-11): :: "#819 correction 1 C-20 …", :: "W-x3b" (clause (g), once).
    // #819 follow-up 2 (A S1): :: "#819 correction 1 C-20 …", :: "W-x3b" (clause (g)'s words).
    claim(
      "the members the system lists for each group read are all of its members, when a reading rested on a group's listed members.",
    );
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
    // noninteractive_auth, sudo-rs pipeline.rs:205-207 (F790-R3-B-07). #819 correction 1 (A MINOR 6):
    // the mail clause — sudo 1.9.15p5's log_denial mails root for a login not in sudoers, by
    // default (mail_no_user; logging.c:957-969, sudoers.c:468-478; W-819-790-02). Not executable here.
    // #819 follow-up 2 (A MINOR 3): :: "A MINOR 3: with noninteractive_auth listed …".
    claim(
      "A refused sudo listing may write one syslog auth line naming the working folder (the original sudo 1.9.15p5 does for a login it lists: `sudo: <login> : a password is required ; PWD=… ; USER=root ; COMMAND=list`), and may leave an audit record where Linux auditd or macOS auditing runs. For a login sudo does not list, it may also mail root (`mail_no_user`, on by default, when a mailer is installed). A listing that a still-valid ticket of the original sudo allowed renews that ticket. A socket connect may leave a log line on an engine that logs each connection. Nothing is locked or counted as a failed login while sudo's `noninteractive_auth` setting is off, as it is by default. When a listing shows it on, sudo's entry says so: the check's own `sudo -n -l` then ran sudo's PAM stack, and may count as a login attempt.",
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
