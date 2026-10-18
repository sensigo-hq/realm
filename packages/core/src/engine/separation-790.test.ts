// separation-790.test.ts — #790 (02): core's switch-path vocabulary. `switchPathsCondition` (D13),
// the most-permissive order of 01b #6, and each clause trigger of D11, one cell per clause. Pure:
// readings in, a condition and clauses out.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure:
// readings, outcomes and clause letters only.
import { describe, expect, it } from 'vitest';
import {
  mostPermissive,
  PREVENTS_CONDITIONS,
  SEPARATION_CONDITIONS,
  switchClausesOf,
  switchPathsCondition,
  type SwitchPathReading,
} from './separation.js';

const r = (over: Partial<SwitchPathReading>): SwitchPathReading => ({
  path: 'sudo',
  outcome: 'not_allowed',
  how: 'a read',
  ...over,
});
const words = (x: SwitchPathReading): string => `${x.path}: ${x.outcome}`;
const letters = (rs: SwitchPathReading[]): string[] =>
  switchClausesOf(rs).map((c) => (c.clause === 'a' ? `a:${c.whose}` : c.clause));

describe('#790 — condition 2 from the ways read (D13)', () => {
  it('no way found → measured "no", and it says what was looked for', () => {
    // (a) red when an empty reading list is unknown or yes; (b) prints the condition.
    expect(switchPathsCondition([], words)).toEqual({
      basis: 'measured',
      answer: 'no',
      detail: 'no sudo, su, doas, polkit or ssh way was found on this host',
    });
  });

  it('every way needs a credential or is not allowed → measured "no", each entry listed', () => {
    const c = switchPathsCondition(
      [r({ outcome: 'needs_credential', whose: 'this_login' }), r({ path: 'su' })],
      words,
    );
    // (a) red when a credential reads "yes" or unknown; (b) prints the condition.
    expect(c).toEqual({
      basis: 'measured',
      answer: 'no',
      detail: 'sudo: needs_credential; su: not_allowed',
    });
  });

  it('any "yes" → measured "yes"; any unknown (and no yes) → unknown, with every entry as its cause', () => {
    // (a) red when a yes is outranked, or an unknown reads "no"; (b) prints both conditions.
    expect({
      yes: switchPathsCondition([r({}), r({ path: 'su', outcome: 'yes' })], words),
      unknown: switchPathsCondition([r({ outcome: 'unknown' }), r({ path: 'su' })], words),
    }).toEqual({
      yes: { basis: 'measured', answer: 'yes', detail: 'sudo: not_allowed; su: yes' },
      unknown: { basis: 'unknown', cause: 'sudo: unknown; su: not_allowed' },
    });
  });

  it('01b #6: the order is yes > unknown > needs a credential > not allowed', () => {
    const pair = (a: SwitchPathReading['outcome'], b: SwitchPathReading['outcome']) =>
      mostPermissive([r({ outcome: a }), r({ outcome: b })]);
    // (a) red when a credential outranks an unknown (fail open), or any other pair turns; (b)
    //     prints each pair's winner.
    expect({
      yesUnknown: pair('unknown', 'yes'),
      unknownCredential: pair('needs_credential', 'unknown'),
      credentialNot: pair('not_allowed', 'needs_credential'),
      none: mostPermissive([]),
    }).toEqual({
      yesUnknown: 'yes',
      unknownCredential: 'unknown',
      credentialNot: 'needs_credential',
      none: undefined,
    });
  });

  it('D12 / R18: condition 3 is root_engine, with no docker alias, and it is one of the four prevents conditions', () => {
    // (a) red when the old id stays or comes back beside the new one; (b) prints both lists.
    expect({
      conditions: [...SEPARATION_CONDITIONS],
      prevents: [...PREVENTS_CONDITIONS],
    }).toEqual({
      conditions: [
        'store_reach',
        'become_service_user',
        'root_engine',
        'trust_root_writable',
        'other_answer_host',
        'time_basis',
        'agent_sandbox',
        'economics_writable',
      ],
      prevents: ['store_reach', 'become_service_user', 'root_engine', 'trust_root_writable'],
    });
  });
});

describe('#790 — the clause triggers (D11), each by its own reading', () => {
  it('(a): one clause per whose among the ways that need a credential — never for a person, never for a yes', () => {
    const rs = [
      r({ outcome: 'needs_credential', whose: 'this_login' }),
      r({ path: 'su', outcome: 'needs_credential', whose: 'svc' }),
      r({ outcome: 'needs_credential', whose: 'this_login' }),
      r({ outcome: 'needs_credential', whose: 'root' }),
      r({ path: 'polkit', outcome: 'needs_credential', whose: 'administrator' }),
      r({ path: 'polkit', outcome: 'yes', whose: 'this_login' }),
    ];
    // (a) red when (a) is printed once per reading, or for a reading that is not a credential; (b)
    //     prints the clauses.
    expect(letters(rs)).toEqual(['a:this_login', 'a:svc', 'a:root', 'a:administrator', 'd']);
  });

  it('(b): a reading with a credential cache — and none without', () => {
    // (a) red when a cache does not print (b), or (b) prints with no cache; (b) prints both.
    expect({
      cache: letters([r({ path: 'doas', cache: 'doas_persist' })]),
      none: letters([r({ path: 'doas' })]),
    }).toEqual({ cache: ['b'], none: [] });
  });

  it('(c): classic sudo\'s refusal — a sudo credential with "or not allowed" only', () => {
    // (a) red when (c) prints for any sudo credential, or not for the refusal; (b) prints both.
    expect({
      refusal: letters([r({ outcome: 'needs_credential', or_not_allowed: true })]),
      listed: letters([r({ outcome: 'needs_credential' })]),
    }).toEqual({ refusal: ['c'], listed: [] });
  });

  it('(d): polkit present, whatever it read; never for another way', () => {
    // (a) red when (d) waits for a polkit credential, or prints for sudo; (b) prints both.
    expect({
      polkit: letters([r({ path: 'polkit' })]),
      sudo: letters([r({ path: 'sudo' })]),
    }).toEqual({ polkit: ['d'], sudo: [] });
  });

  it("(e): a way that needs a person's touch or key", () => {
    // (a) red when a person's credential prints no (e), or (a) for it; (b) prints the clauses.
    expect(letters([r({ outcome: 'needs_credential', whose: 'person' })])).toEqual(['e']);
  });

  it('(f): an ssh way', () => {
    // (a) red when an ssh reading prints no (f); (b) prints the clauses.
    expect(letters([r({ path: 'ssh', outcome: 'needs_credential' })])).toEqual(['f']);
  });
});
