// sudo-corpus.test.ts — #819 Unit A (A2): the sudo reader against real sudo's printouts, the oracle.
// The corpus (fixtures/corpus/, written by scripts/capture-sudo-corpus.sh) holds each image's
// listings — six sudo versions, through the check's own spawn, at 80 columns with no terminal and at
// 30x60 and 50x200 — and each scenario's real `sudo -n -u svc /usr/bin/true` verdict.
//
//   T1  every capture that holds no ambiguity: `parseListing` never reads unknown, and the items it
//       cuts, decoded by sudo's version, equal the items items.tsv says each scope holds (key and
//       stored value, in order; blank runs collapsed, since a wrap drops them, W-UA-L3-12).
//   T2  every capture whose printout two sources print alike (P2, the second audit's B1): the reading
//       is unknown or yes, never "no".
//   T3  every verdict scenario: the check's sudo reading on that scenario's machine is the one pinned,
//       never "no" where real sudo exited 0, and no cause says "no capture for".
//
// On failure each prints the image, the scope, the item id and the two values — corpus text and
// fictional logins at most.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { switchClausesOf, type SwitchPathReading } from '@sensigo/realm';
import { lookups, measureSwitchPaths } from './index.js';
import { scanPam } from './pam.js';
import { defaultsValue, parseListing, sudoVersion } from './sudo.js';
import { railOne } from './runner.js';
import { SYSTEM_DIRS } from './lookup.js';
import {
  asked,
  capture,
  fixtureFile,
  fixtureMachine,
  type MachineSpec,
} from '../../test-support/separation-fixtures.js';

const CORPUS = new URL('./fixtures/corpus/', import.meta.url);
const IMAGES = [
  'ubuntu-20.04',
  'ubuntu-22.04',
  'ubuntu-24.04',
  'debian-stable',
  'fedora-latest',
  'rockylinux-9',
];
/** The printouts two sources print alike: T2's, never T1's. */
const AMBIGUOUS = new Set(['b1a', 'b1b', 'p2-a', 'p2-b']);

afterEach(() => {
  const off = asked.filter((a) => !railOne(a)).map((a) => a.join(' '));
  asked.length = 0;
  // (a) red when the reader asks anything rail 1 does not admit; (b) prints that argv.
  expect(off).toEqual([]);
});

interface Row {
  id: string;
  set: string;
  image: string;
  scope: string;
  key: string;
  value?: string;
}
const ROWS: Row[] = readFileSync(new URL('items.tsv', CORPUS), 'utf8')
  .split('\n')
  .filter((l) => l !== '' && !l.startsWith('#'))
  .map((l) => {
    const [id, set, image, scope, key, value] = l.split('\t') as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return { id, set, image, scope, key, ...(value === '-' ? {} : { value: JSON.parse(value) }) };
  });

const dirs = (path: string): string[] =>
  readdirSync(new URL(path, CORPUS), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'image')
    .map((d) => d.name);
const files = (path: string): string[] => readdirSync(new URL(path, CORPUS));
const stdoutOf = (name: string): string => (capture(`corpus/${name}`) as { stdout: string }).stdout;
const versionOf = (img: string) =>
  sudoVersion(stdoutOf(`${img}/image/version.sudo`).split('\n')[0]);
const blanks = (s: string): string => s.replace(/[ \t]+/g, ' ');
const shown = (key: string, value: string | undefined): string =>
  value === undefined ? key : `${key}=${JSON.stringify(blanks(value))}`;

/** What items.tsv says one set holds on one image: the global list (stock rows, then `Defaults`,
 *  then `Defaults:agent`), each `Defaults!`/`Defaults>` scope, and each rule's run-as lists. */
function expected(img: string, set: string) {
  const mine = ROWS.filter(
    (r) => (r.set === set || r.set === '*') && (r.image === img || r.image === '*'),
  );
  // the Unit A correction (C4): a set's row with a stock row's id replaces it (a stock line edited)
  const own = mine.filter((r) => r.set === set);
  const replaces = (r: Row) => (x: Row) => x.id === r.id && x.scope === r.scope;
  const global = [
    ...mine.filter((r) => r.set === '*').map((r) => own.find(replaces(r)) ?? r),
    ...own.filter(
      (r) => r.scope === 'Defaults' && !mine.some((x) => x.set === '*' && replaces(x)(r)),
    ),
    ...own.filter((r) => r.scope === 'Defaults:agent'),
  ];
  const specific = new Map<string, Row[]>();
  for (const r of mine.filter((x) => /^Defaults[!>]/.test(x.scope)))
    specific.set(r.scope, [...(specific.get(r.scope) ?? []), r]);
  const rules: { users: string[]; groups: string[] }[] = [];
  for (const r of mine.filter((x) => x.scope.startsWith('RUNAS-'))) {
    const [, which, n] = /^RUNAS-(USER|GROUP)#(\d+)$/.exec(r.scope)!;
    const rule = (rules[Number(n) - 1] ??= { users: [], groups: [] });
    (which === 'USER' ? rule.users : rule.groups).push(r.value!);
  }
  return { global, specific, rules };
}

/** Each row the reader's items do not match: its scope, id and both values. */
function differences(scope: string, want: Row[], got: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    const w = want[i];
    const exp = w === undefined ? '(none)' : shown(w.key, w.value);
    if (exp !== got[i])
      out.push(`${scope} ${w?.id ?? `#${i + 1}`}: want ${exp}, read ${got[i] ?? '(none)'}`);
  }
  return out;
}

describe('#819 Unit A (A2) — T1: the reader cuts every item where sudo printed it, on six versions', () => {
  for (const img of IMAGES) {
    const version = versionOf(img);
    for (const set of dirs(`${img}/`).filter((s) => !AMBIGUOUS.has(s))) {
      for (const file of files(`${img}/${set}/`).filter((f) => /^sudo\.l{1,2}\./.test(f))) {
        it(`${img} ${set} ${file}`, () => {
          const listing = parseListing(
            stdoutOf(`${img}/${set}/${file.replace(/\.txt$/, '')}`),
            version,
          );
          // (a) red when the reader cannot read a printout it should (an item boundary not where sudo
          //     put it, a wrap not joined, a value not decoded as sudo stores it — #851's splitList
          //     back in turns these red); (b) prints the image (the cell's name), the scope, the
          //     item id and the two values.
          const want = expected(img, set);
          const out: string[] = [];
          if ('unknown' in listing) out.push(`unknown: ${listing.unknown}`);
          else {
            out.push(...listing.unsplit.map((u) => `unsplit: ${u}`));
            const decode = (i: (typeof listing.items)[number]): string => {
              const d = defaultsValue(i, version);
              return 'unknown' in d ? `unknown: ${d.unknown}` : shown(d.key, d.value);
            };
            out.push(...differences('global', want.global, listing.items.map(decode)));
            const scopes = new Set([
              ...want.specific.keys(),
              ...listing.specific.map((s) => `Defaults${s.kind}${s.targets.join(', ')}`),
            ]);
            for (const scope of scopes) {
              const got = listing.specific.find(
                (s) => `Defaults${s.kind}${s.targets.join(', ')}` === scope,
              );
              out.push(
                ...differences(
                  scope,
                  want.specific.get(scope) ?? [],
                  (got?.items ?? []).map(decode),
                ),
              );
            }
            // the short format lists one entry per command: consecutive entries of one rule share it
            const rules = listing.entries
              .map((e) => ({ users: e.users, groups: e.groups }))
              .filter((r, i, all) => i === 0 || JSON.stringify(r) !== JSON.stringify(all[i - 1]));
            for (let n = 0; n < Math.max(rules.length, want.rules.length); n++)
              for (const which of ['users', 'groups'] as const)
                if (
                  JSON.stringify(rules[n]?.[which] ?? []) !==
                  JSON.stringify(want.rules[n]?.[which] ?? [])
                )
                  out.push(
                    `RUNAS-${which === 'users' ? 'USER' : 'GROUP'}#${n + 1}: want ${JSON.stringify(want.rules[n]?.[which] ?? [])}, read ${JSON.stringify(rules[n]?.[which] ?? [])}`,
                  );
          }
          expect(out).toEqual([]);
        });
      }
    }
  }

  it('the corpus is all there: six images, every T1 set with rows, every listing at its widths', () => {
    // (a) red when an image, a set's rows or a width is missing (T1 would then pass on nothing);
    // (b) prints the counts.
    const sets = IMAGES.map((img) => dirs(`${img}/`).filter((s) => !AMBIGUOUS.has(s)));
    const rowless = sets.flat().filter((s) => !ROWS.some((r) => r.set === s));
    const main = IMAGES.map((img) => files(`${img}/main/`).filter((f) => /^sudo\./.test(f)).length);
    // the Unit A correction (C3): the long host name at 80 columns everywhere, and in a 40-column
    // terminal on sudo 1.9.14 and later (Ubuntu 24.04, Debian, Fedora, Rocky: 1.9.15p5–1.9.17p2)
    const longhost = IMAGES.map(
      (img) => files(`${img}/longhost/`).filter((f) => /^sudo\./.test(f)).length,
    );
    expect({ images: IMAGES.length, rowless, main, longhost }).toEqual({
      images: 6,
      rowless: [],
      main: [6, 6, 6, 6, 6, 6],
      longhost: [2, 2, 4, 4, 4, 4],
    });
  });
});

/** A scenario's machine: the image's sudo, getent and id where the image keeps them (tools.txt), its
 *  PAM files and nsswitch.conf, and every lookup captured beside the scenario's listing. */
function corpusMachine(img: string, set: string): MachineSpec {
  const tools = fixtureFile(`corpus/${img}/image/tools`)
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split(' ') as [string, string, string]);
  const spec: MachineSpec = { programs: {}, links: {}, calls: {}, files: {} };
  const first: Record<string, string> = {};
  for (const [path, real, uid] of tools) {
    spec.programs![path] = Number(uid);
    if (real !== path) spec.links![path] = real;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const at = (p: string) =>
      (SYSTEM_DIRS as readonly string[]).indexOf(p.slice(0, p.lastIndexOf('/')));
    if (first[name] === undefined || at(path) < at(first[name]!)) first[name] = path;
  }
  const dir = `corpus/${img}/${set}`;
  spec.calls![`${first['sudo']} -V`] = `corpus/${img}/image/version.sudo`;
  spec.calls![`LC_ALL=C ${first['sudo']} -n -l`] = `${dir}/sudo.l.notty80`;
  spec.calls![`LC_ALL=C ${first['sudo']} -n -ll`] = `${dir}/sudo.ll.notty80`;
  for (const f of files(`${img}/${set}/`)) {
    const m = /^(getent)\.(passwd|group)\.(.+)\.txt$/.exec(f) ?? /^(id)\.(G)\.(.+)\.txt$/.exec(f);
    if (m === null) continue;
    const argv = m[1] === 'id' ? `${first['id']} -G ${m[3]}` : `${first['getent']} ${m[2]} ${m[3]}`;
    spec.calls![argv] = `${dir}/${f.replace(/\.txt$/, '')}`;
  }
  for (const f of files(`${img}/image/`)) {
    const m = /^pam\.(.+)\.txt$/.exec(f);
    if (m !== null)
      spec.files![`/etc/pam.d/${m[1]}`] = { fixture: `corpus/${img}/image/pam.${m[1]}` };
  }
  spec.files!['/etc/nsswitch.conf'] = { fixture: `corpus/${img}/image/nsswitch.conf` };
  return spec;
}

/** A scenario's sudo readings, and (the Unit A correction, C4) every argv its machine was asked that
 *  the scenario has no capture for — counted from the machine itself, not from a printed cause. */
const sudoRead = async (
  img: string,
  set: string,
): Promise<{ rs: SwitchPathReading[]; uncaptured: string[] }> => {
  const spec = corpusMachine(img, set);
  const from = asked.length;
  const all = await measureSwitchPaths({ probes: fixtureMachine(spec), svc: 'svc' });
  const uncaptured = asked
    .slice(from)
    .map((a) => a.join(' '))
    .filter((a) => !(a in spec.calls!));
  return { rs: all.filter((r) => r.path === 'sudo'), uncaptured };
};
const sudoReadings = async (img: string, set: string): Promise<SwitchPathReading[]> =>
  (await sudoRead(img, set)).rs;
/** Each reading: outcome, whose, cache, `member_list` (the fallback read a member list) and cause —
 *  then the clause letters the readings fire, where any do (C4: the exact read and the fallback
 *  print apart). */
const view = (rs: SwitchPathReading[]): string[] => {
  const letters = switchClausesOf(rs)
    .map((c) => c.clause)
    .join('');
  return [
    ...rs.map((r) =>
      [r.outcome, r.whose, r.cache, r.member_list === true ? 'member_list' : undefined, r.cause]
        .filter((x) => x !== undefined)
        .join(' '),
    ),
    ...(letters !== '' ? [`clauses ${letters}`] : []),
  ];
};
const verdict = (img: string, set: string, name = 'verdict.u-svc'): number =>
  Number(/^exit (\d+)/.exec(fixtureFile(`corpus/${img}/${set}/${name}`))![1]);

describe('#819 Unit A (A2) — T2: a printout two sources print alike reads unknown or yes, never "no"', () => {
  for (const img of IMAGES) {
    for (const set of [...AMBIGUOUS]) {
      it(`${img} ${set}: real sudo exit ${verdict(img, set)}; the split is found and the reading is never "no"`, async () => {
        const listing = parseListing(stdoutOf(`${img}/${set}/sudo.ll.notty80`), versionOf(img));
        const rs = await sudoReadings(img, set);
        // (a) red when the reader takes one of the readings (P2-B's one-item reading, or the B1 cut):
        //     the split is then not found, and a "no" may follow where sudo says yes; (b) prints the
        //     split's cause cut to its kind, and the outcomes.
        expect({
          split: 'unsplit' in listing ? listing.unsplit.map((u) => u.split(':')[0]) : listing,
          no: rs
            .filter((r) => r.outcome !== 'yes' && r.outcome !== 'unknown')
            .map((r) => r.outcome),
        }).toEqual({ split: ['sudo listed a Defaults setting this check cannot split'], no: [] });
      });
    }
  }
});

/** Each verdict scenario's reading, pinned as it runs (verify-first). */
const T3: Record<string, string[]> = {
  b3: ['yes'],
  b4: ['yes'],
  // item 2 (W-UA-L3-17/-18): svc in SVCGRP, the rule `%svcgrp` — read by its groups, as sudo reads them
  'grp-default': ['yes'],
  'grp-nocase': ['not_allowed'],
  'grp-bygid': ['not_allowed'],
  'grp-fedora': ['not_allowed'],
  // #819 Unit A, the capped correction re-pin (the walk's wording item): keep one of them
  'grp-fedora-nogid': [
    'unknown sudo listed a Defaults setting more than once, and does not show which one it applies: match_group_by_gid, !match_group_by_gid (keep one of them; on Fedora and Rocky Linux, change the stock line instead of adding a second)',
  ],
  // a group plugin grants svc a group it is not a Unix member of: group_plugin stays unread
  plugin: [
    'unknown sudo listed a Defaults setting this check does not read: group_plugin="group_file.so /etc/sudo-group"',
  ],
  'plugin-colon': [
    'unknown sudo matches %:plugingrp only through its group plugin, which this check does not read',
  ],
  // item 7 (A6): runas_default under runaspw, looked up as sudo looks it up — the capped correction
  // re-pin (the walk's wording item): "not as proof that no way works"
  'runaspw-nosuchuser': [
    'unknown sudo finds no user nosuchuser and refuses every command (Defaults runaspw); this check reads that as unknown, not as proof that no way works',
  ],
  'runaspw-ROOT': [
    'unknown sudo finds no user ROOT and refuses every command (Defaults runaspw); this check reads that as unknown, not as proof that no way works',
  ],
  'runaspw-hash0': [
    'unknown sudo looks #0 up as a user name, finds none and refuses every command (Defaults runaspw); this check reads that as unknown, not as proof that no way works',
  ],
  // the Unit A correction re-pin (C4): the view now prints the clause letters — (a) svc's password,
  // (b) sudo's ticket
  'runaspw-svc': ['needs_credential svc sudo_timestamp', 'clauses ab'],
  // D7b dropped (W-UA-MA3-01): no Runas_Spec and an unknown runas_default; real sudo refuses all three
  norunas: ['not_allowed'],
  // the Unit A correction (C4): Fedora's stock match_group_by_gid line edited to !match_group_by_gid —
  // svc's groups read by `id -G` decide (the fallback would read the case gap unknown)
  'grp-fedora-edited': ['yes'],
  // (C3) a 45-character host name: every section header wrapped, read as unwrapped
  longhost: ['yes'],
};

describe("#819 Unit A (A2) — T3: each real verdict, read by the check on that scenario's machine", () => {
  for (const img of IMAGES) {
    for (const set of dirs(`${img}/`).filter((s) => s in T3 || AMBIGUOUS.has(s))) {
      it(`${img} ${set}: real sudo -n -u svc exit ${verdict(img, set)}`, async () => {
        const { rs, uncaptured } = await sudoRead(img, set);
        const no = rs.filter((r) => r.outcome !== 'yes' && r.outcome !== 'unknown');
        // (a) red when the check reads "no" where real sudo exited 0, the machine was asked a lookup
        //     the scenario has no capture for (the Unit A correction, C4: counted from the machine,
        //     so a fallback that reads "not allowed" cannot hide it), or the reading — member list
        //     and clauses with it — moves from the one pinned; (b) prints the readings, causes and
        //     each uncaptured argv.
        expect({
          noWhereSudoSaysYes: verdict(img, set) === 0 ? view(no) : [],
          uncaptured,
          ...(set in T3 ? { reading: view(rs) } : {}),
        }).toEqual({
          noWhereSudoSaysYes: [],
          uncaptured: [],
          ...(set in T3 ? { reading: T3[set] } : {}),
        });
      });
    }
  }
});

describe("#819 Unit A, the capped correction (Part 4): Rocky's stock PAM line is read", () => {
  it("Rocky 9's stock `pam_unix.so try_first_pass nullok`: sudo's and su's stacks read, a password rule needs this login's password — not unknown", async () => {
    // Rocky's b3 scenario (sudo 1.9.17p2, its PAM files, nsswitch.conf and lookups), with two edits
    // named here (the cut-capture standard): the scenario's last two Defaults items dropped
    // (`passprompt=Password\,` and `!authenticate`), leaving Rocky's stock Defaults beside its two
    // rules — `(nobody)` NOPASSWD and `(svc)` with a password; and su at /usr/bin/su (Rocky ships it;
    // the corpus lists only the tools the sudo reader asks). Real sudo on rockylinux:9: `sudo -S -u
    // svc` takes this login's password, and refuses a wrong one (plans/issue-627/w/unit-a/c2-ia2/probe).
    const spec = corpusMachine('rockylinux-9', 'b3');
    spec.programs!['/usr/bin/su'] = 0;
    const machine = fixtureMachine(spec);
    const run = machine.run;
    const rs = await measureSwitchPaths({
      probes: {
        ...machine,
        run: async (argv) => {
          const r = await run(argv);
          return argv.join(' ') === 'LC_ALL=C /usr/bin/sudo -n -ll' && 'exit' in r
            ? {
                ...r,
                stdout: r.stdout.replace(', passprompt=Password\\,\n    !authenticate\n', '\n'),
              }
            : r;
        },
      },
      svc: 'svc',
    });
    const lk = lookups(fixtureMachine(spec), 'svc');
    const scans: Record<string, unknown> = {};
    for (const service of ['sudo', 'sudo-i', 'su', 'su-l']) {
      const scan = await scanPam(lk, service);
      scans[service] = 'unknown' in scan ? scan.unknown : { password: scan.password };
    }
    // (a) red when Rocky's stock line is left unread again (each stack reads "a line this check does
    //     not read: auth sufficient pam_unix.so try_first_pass nullok", and the reading unknown: the
    //     strong sentence never prints on stock Rocky); (b) prints each stack's reading and the
    //     readings, their whose and clause letters.
    expect({ scans, readings: view(rs) }).toEqual({
      scans: {
        sudo: { password: true },
        'sudo-i': { password: true },
        su: { password: true },
        'su-l': { password: true },
      },
      readings: [
        'needs_credential this_login sudo_timestamp',
        'needs_credential svc',
        'needs_credential root',
        // (a) once per whose — this login's, svc's, root's — and (b) sudo's ticket
        'clauses aaab',
      ],
    });
  });
});
