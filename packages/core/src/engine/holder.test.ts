// holder.test.ts — issue #625 (the holder slice, PR-H): the vocabulary and the pure functions in
// `holder.ts`. Every cell is named for the row of the design it pins; each carries (a) the change
// that turns it red and (b) what it prints on failure — a synthetic name or a synthetic token only,
// never a value that could be a credential.
import { describe, it, expect } from 'vitest';
import {
  ACTOR_ABSENT_CAUSES,
  BY_SOURCE_CLASSES,
  CLAIM_PROOF_ABSENT_CAUSES,
  GATE_PROOFS,
  GATE_PROOF_CAUSES,
  NAME_CAP_MARKER,
  NAME_MAX_LENGTH,
  boundStated,
  boundStatedName,
  composeGateClaimSentence,
  composeProgramIdentity,
  describeClaimHolder,
  identityRefusalLine,
  judgeGateProof,
  readAttributed,
  readDrivenBy,
  readGateClaimVerdict,
  readStoredName,
  validateDriver,
  type Attributed,
  type GateClaimVerdict,
} from './holder.js';
import { WorkflowError } from '../types/workflow-error.js';

function thrown(fn: () => unknown): WorkflowError {
  try {
    fn();
  } catch (err) {
    if (err instanceof WorkflowError) return err;
    throw err;
  }
  throw new Error('expected a WorkflowError, nothing was thrown');
}

const ALICE: Attributed = { by: 'alice@host', by_source: 'derived', channel: 'agent' };

describe('the vocabularies — one const each, exactly these members', () => {
  // Red when: a member is added or dropped without this list (and its producing cell) following.
  it('BY_SOURCE_CLASSES', () => {
    expect([...BY_SOURCE_CLASSES]).toEqual(['stated', 'ambient', 'derived']);
  });
  it('ACTOR_ABSENT_CAUSES', () => {
    expect([...ACTOR_ABSENT_CAUSES]).toEqual([
      'holder_not_recorded',
      'pre_lease_claim',
      'no_claim',
      'store_keeps_no_claims',
      'driver_not_recorded',
      'name_unreadable',
      'not_stated',
    ]);
  });
  it('GATE_PROOFS and GATE_PROOF_CAUSES', () => {
    expect([...GATE_PROOFS]).toEqual(['matched', 'absent', 'mismatch', 'unverifiable', 'spent']);
    expect([...GATE_PROOF_CAUSES]).toEqual([
      'no_claim',
      'claim_has_no_token',
      'store_keeps_no_claims',
      'answered',
      'expired',
    ]);
  });
  it('CLAIM_PROOF_ABSENT_CAUSES', () => {
    expect([...CLAIM_PROOF_ABSENT_CAUSES]).toEqual([
      'settled_by_expiry',
      'proof_not_recorded',
      'proof_unreadable',
    ]);
  });
});

describe('boundStated — ONE bound for a stated name', () => {
  it('returns the text unchanged at the bound (200 characters) and for an ordinary name', () => {
    const atBound = 'a'.repeat(NAME_MAX_LENGTH);
    expect(boundStated('by', atBound)).toBe(atBound);
    expect(boundStated('by', 'alice')).toBe('alice');
  });

  it("refuses 201 characters with VALIDATION_ACTOR_INVALID naming the field and the word 'longer than 200 characters'", () => {
    const err = thrown(() => boundStated('by', 'a'.repeat(NAME_MAX_LENGTH + 1), 'responded_by'));
    expect(err.code).toBe('VALIDATION_ACTOR_INVALID');
    expect(err.category).toBe('VALIDATION');
    expect(err.message).toBe('Invalid responded_by: longer than 200 characters.');
    expect(err.details).toEqual({ field: 'responded_by', reason: 'longer than 200 characters' });
  });

  it.each([
    ['a newline', 'a\nb'],
    ['a tab', 'a\tb'],
    ['an ESC', 'a\u001b[2Jb'],
    ['a DEL', 'a\u007fb'],
    ['a C1 control (U+0085)', 'a\u0085b'],
  ])('refuses %s with the word "contains a control character"', (_label, text) => {
    const err = thrown(() => boundStated('by', text));
    expect(err.message).toBe('Invalid by: contains a control character.');
  });

  it("defaults the named field to the kind ('by')", () => {
    expect(thrown(() => boundStated('by', 'a\nb')).details['field']).toBe('by');
  });

  it('boundStatedName also refuses an empty or whitespace-only name with the word "empty"', () => {
    expect(thrown(() => boundStatedName('', '--by')).message).toBe('Invalid --by: empty.');
    expect(thrown(() => boundStatedName('  \t ', '--by')).details['reason']).toBe('empty');
    expect(boundStatedName('alice', '--by')).toBe('alice');
  });

  // Issue #625, PR-H review correction C3: one rule for a name, whatever door it comes through.
  it('C3: boundStatedName removes spaces at either end, bounds the TRIMMED text, and returns it', () => {
    // (a) red when the trim is dropped (the padded name comes back) or the bound is applied to the
    //     raw text (a 200-character name with a space at each end is refused); (b) prints it.
    expect(boundStatedName('  alice  ', '--by')).toBe('alice');
    expect(boundStatedName(` ${'a'.repeat(NAME_MAX_LENGTH)} `, '--by')).toBe(
      'a'.repeat(NAME_MAX_LENGTH),
    );
  });
});

describe('identityRefusalLine — ONE mint for the refusal every host prints', () => {
  const tooLong = thrown(() => boundStated('by', 'a'.repeat(201)));

  it('an environment variable subject gets the "Unset it" remedy', () => {
    expect(identityRefusalLine('REALM_OPERATOR', tooLong, 'nothing was started')).toBe(
      'REALM_OPERATOR: longer than 200 characters; nothing was started. ' +
        'Unset it or give it a name of at most 200 characters with no control characters.',
    );
  });

  it('an option or argument subject gets the "or leave it out" remedy — never "Unset it"', () => {
    const empty = thrown(() => boundStatedName('', '--by'));
    expect(identityRefusalLine('--by', empty, 'nothing was recorded')).toBe(
      '--by: empty; nothing was recorded. ' +
        'Give a name of at most 200 characters with no control characters, or leave it out.',
    );
    expect(identityRefusalLine('responded_by', tooLong, 'nothing was recorded')).toBe(
      'responded_by: longer than 200 characters; nothing was recorded. ' +
        'Give a name of at most 200 characters with no control characters, or leave it out.',
    );
  });

  it('a non-WorkflowError falls back to its message (never a stack)', () => {
    expect(identityRefusalLine('REALM_OPERATOR', new Error('boom'), 'nothing was started')).toMatch(
      /^REALM_OPERATOR: boom; nothing was started\. /,
    );
  });
});

describe('validateDriver — the five exact texts', () => {
  it('accepts undefined and a well-formed driver', () => {
    expect(() => validateDriver(undefined)).not.toThrow();
    expect(() => validateDriver(ALICE)).not.toThrow();
  });

  it.each([
    ['not an object', 'x', 'Invalid driver: not an object.'],
    [
      'not a string',
      { by: 5, by_source: 'derived', channel: 'agent' },
      'Invalid driver.by: not a non-empty string.',
    ],
    // Issue #625, PR-H review correction C3: blank after trimming is `empty`, as for `--by`.
    ['an empty by', { by: '', by_source: 'derived', channel: 'agent' }, 'Invalid driver.by: empty.'],
    [
      'a blank by',
      { by: '   ', by_source: 'stated', channel: 'x' },
      'Invalid driver.by: empty.',
    ],
    [
      'longer than 200 characters',
      { by: 'a'.repeat(201), by_source: 'derived', channel: 'agent' },
      'Invalid driver.by: longer than 200 characters.',
    ],
    [
      'a control character',
      { by: 'a\nb', by_source: 'derived', channel: 'agent' },
      'Invalid driver.by: contains a control character.',
    ],
    [
      'a source that is not a member',
      { by: 'alice', by_source: 'verified', channel: 'agent' },
      'Invalid driver.by_source: not one of stated, ambient, derived.',
    ],
    [
      'a channel outside [a-z0-9_-]',
      { by: 'alice', by_source: 'derived', channel: 'Agent!' },
      'Invalid driver.channel: not 1–64 characters of [a-z0-9_-].',
    ],
    [
      'a 65-character channel',
      { by: 'alice', by_source: 'derived', channel: 'a'.repeat(65) },
      'Invalid driver.channel: not 1–64 characters of [a-z0-9_-].',
    ],
  ])('refuses %s', (_label, value, message) => {
    const err = thrown(() => validateDriver(value));
    expect(err.code).toBe('VALIDATION_ACTOR_INVALID');
    expect(err.message).toBe(message);
  });
});

describe('composeProgramIdentity — precedence, refusals, and what cannot be derived', () => {
  it('stated beats ambient beats derived', () => {
    const all = { stated: 'op', ambient: 'amb', osUser: 'u', osHost: 'h' };
    expect(composeProgramIdentity(all, 'agent')).toEqual({
      driver: { by: 'op', by_source: 'stated', channel: 'agent' },
    });
    expect(composeProgramIdentity({ ambient: 'amb', osUser: 'u', osHost: 'h' }, 'run')).toEqual({
      driver: { by: 'amb', by_source: 'ambient', channel: 'run' },
    });
    expect(composeProgramIdentity({ osUser: 'u', osHost: 'h' }, 'mcp-stdio')).toEqual({
      driver: { by: 'u@h', by_source: 'derived', channel: 'mcp-stdio' },
    });
  });

  it('a stated name that is empty or only whitespace THROWS (never falls through to a derived one)', () => {
    expect(
      thrown(() => composeProgramIdentity({ stated: '', osUser: 'u', osHost: 'h' }, 'agent')).code,
    ).toBe('VALIDATION_ACTOR_INVALID');
    expect(
      thrown(() => composeProgramIdentity({ stated: '   ', osUser: 'u', osHost: 'h' }, 'agent'))
        .details['reason'],
    ).toBe('empty');
  });

  it('a stated name failing the bound THROWS', () => {
    expect(
      thrown(() => composeProgramIdentity({ stated: 'a\nb' }, 'agent')).details['reason'],
    ).toBe('contains a control character');
  });

  it('an ambient name that is empty or whitespace-only is NOT SET — the derived name is used', () => {
    expect(composeProgramIdentity({ ambient: '  ', osUser: 'u', osHost: 'h' }, 'agent')).toEqual({
      driver: { by: 'u@h', by_source: 'derived', channel: 'agent' },
    });
    expect(composeProgramIdentity({ ambient: '', osUser: 'u', osHost: 'h' }, 'agent')).toEqual({
      driver: { by: 'u@h', by_source: 'derived', channel: 'agent' },
    });
  });

  it('C3: an ambient name is stored without the spaces at either end', () => {
    // (a) red when REALM_OPERATOR is stored with its padding; (b) prints the driver.
    expect(composeProgramIdentity({ ambient: ' ops-team ', osUser: 'u', osHost: 'h' }, 'agent')).toEqual({
      driver: { by: 'ops-team', by_source: 'ambient', channel: 'agent' },
    });
  });

  it('an ambient name failing the bound THROWS, naming REALM_OPERATOR', () => {
    const err = thrown(() => composeProgramIdentity({ ambient: 'a'.repeat(201) }, 'agent'));
    expect(err.message).toBe('Invalid REALM_OPERATOR: longer than 200 characters.');
    expect(err.details['field']).toBe('REALM_OPERATOR');
  });

  it('a derived name needs BOTH the user and the host: exactly one missing ⇒ no driver, with the reason', () => {
    expect(composeProgramIdentity({ osHost: 'h' }, 'agent')).toEqual({
      driver: undefined,
      reason: 'the OS user name is not known',
    });
    expect(composeProgramIdentity({ osUser: 'u' }, 'agent')).toEqual({
      driver: undefined,
      reason: 'the host name is not known',
    });
  });

  it('nothing resolving ⇒ { driver: undefined } with NO reason key', () => {
    const out = composeProgramIdentity({}, 'agent');
    expect(out).toEqual({ driver: undefined });
    expect('reason' in out).toBe(false);
  });

  it('a derived pair that fails the bound ⇒ no driver, with a reason (never a throw)', () => {
    const out = composeProgramIdentity(
      { osUser: 'u'.repeat(150), osHost: 'h'.repeat(150) },
      'agent',
    );
    expect(out.driver).toBeUndefined();
    expect('reason' in out && out.reason).toBe(
      'the name made from the OS user and host name longer than 200 characters',
    );
  });

  it.each(['Agent', '', 'a b', 'a'.repeat(65), 'x!'])(
    'a channel outside [a-z0-9_-]{1,64} THROWS (%j)',
    (channel) => {
      expect(
        thrown(() => composeProgramIdentity({ osUser: 'u', osHost: 'h' }, channel)).message,
      ).toBe('Invalid channel: not 1–64 characters of [a-z0-9_-].');
    },
  );
});

describe('readStoredName / readAttributed — the one reader for a stored name', () => {
  it('readStoredName: a string comes back; empty, whitespace, a non-string and a control character do not', () => {
    expect(readStoredName('alice')).toBe('alice');
    expect(readStoredName('')).toBeUndefined();
    expect(readStoredName('   ')).toBeUndefined();
    expect(readStoredName(42)).toBeUndefined();
    expect(readStoredName('a\u001b[2Jb')).toBeUndefined();
  });

  it('an over-long stored name is SHOWN, cut to 200 characters with the house marker — never withheld', () => {
    const shown = readStoredName('a'.repeat(300));
    expect(shown).toBe(`${'a'.repeat(200)}${NAME_CAP_MARKER}`);
    expect(NAME_CAP_MARKER).toBe('…[truncated]');
  });

  it('readAttributed: a well-formed value reads back; every malformed shape is name_unreadable', () => {
    expect(readAttributed(ALICE)).toEqual(ALICE);
    const unreadable = { by: null, absent_cause: 'name_unreadable' };
    for (const bad of [
      null,
      'alice',
      42,
      {},
      { by: 1, by_source: 'derived', channel: 'agent' },
      { by: 'a', by_source: 'verified', channel: 'agent' },
      { by: 'a', by_source: 'derived', channel: 5 },
      { by: 'a\u001b[2Jb', by_source: 'derived', channel: 'agent' },
      { by: 'a', by_source: 'derived', channel: 'ag\nent' },
    ]) {
      expect(readAttributed(bad)).toEqual(unreadable);
    }
  });

  it('readAttributed caps an over-long by AND an over-long channel (shown, not withheld)', () => {
    const read = readAttributed({
      by: 'b'.repeat(300),
      by_source: 'ambient',
      channel: 'c'.repeat(300),
    });
    expect(read).toEqual({
      by: `${'b'.repeat(200)}${NAME_CAP_MARKER}`,
      by_source: 'ambient',
      channel: `${'c'.repeat(200)}${NAME_CAP_MARKER}`,
    });
  });

  it('C3: readAttributed reads a stored BLANK by as name_unreadable — no byte of it is shown', () => {
    // (a) red when a blank by is returned (it would print `taken by     (…)`); (b) prints the read.
    expect(readAttributed({ by: '   ', by_source: 'stated', channel: 'x' })).toEqual({
      by: null,
      absent_cause: 'name_unreadable',
    });
    expect(readAttributed({ by: '', by_source: 'stated', channel: 'x' })).toEqual({
      by: null,
      absent_cause: 'name_unreadable',
    });
    expect(
      describeClaimHolder({ holder: { by: '   ', by_source: 'stated', channel: 'x' } } as never, true),
    ).toEqual({ by: null, absent_cause: 'name_unreadable' });
  });

  it('readDrivenBy: absent ⇒ driver_not_recorded; present ⇒ the same reader', () => {
    expect(readDrivenBy(undefined)).toEqual({ by: null, absent_cause: 'driver_not_recorded' });
    expect(readDrivenBy({})).toEqual({ by: null, absent_cause: 'driver_not_recorded' });
    expect(readDrivenBy({ driven_by: ALICE })).toEqual(ALICE);
    expect(readDrivenBy({ driven_by: 'oops' })).toEqual({
      by: null,
      absent_cause: 'name_unreadable',
    });
  });
});

describe('describeClaimHolder — the FIRST row that applies', () => {
  it('a claim with a holder ⇒ the holder (and since)', () => {
    expect(describeClaimHolder({ holder: ALICE, since: '2026-01-01T00:00:00.000Z' }, true)).toEqual(
      {
        holder: ALICE,
        since: '2026-01-01T00:00:00.000Z',
      },
    );
  });

  it('since with no holder ⇒ holder_not_recorded (since kept)', () => {
    expect(describeClaimHolder({ since: '2026-01-01T00:00:00.000Z' }, true)).toEqual({
      by: null,
      absent_cause: 'holder_not_recorded',
      since: '2026-01-01T00:00:00.000Z',
    });
  });

  it('no since and no holder ⇒ pre_lease_claim', () => {
    expect(describeClaimHolder({}, true)).toEqual({ by: null, absent_cause: 'pre_lease_claim' });
  });

  it('no claim: no_claim when the store keeps claims, store_keeps_no_claims when it keeps none', () => {
    expect(describeClaimHolder(undefined, true)).toEqual({ by: null, absent_cause: 'no_claim' });
    expect(describeClaimHolder(undefined, false)).toEqual({
      by: null,
      absent_cause: 'store_keeps_no_claims',
    });
  });

  it('an unreadable stored holder ⇒ name_unreadable FIRST (before holder_not_recorded), since kept when readable', () => {
    const since = '2026-01-01T00:00:00.000Z';
    expect(
      describeClaimHolder(
        { holder: { by: 'x\u001b[2J', by_source: 'derived', channel: 'agent' } as never, since },
        true,
      ),
    ).toEqual({ by: null, absent_cause: 'name_unreadable', since });
  });
});

describe('judgeGateProof — rows 0–5 in order (never tokensEqual)', () => {
  const claim = { deadline: null, token: 'tok-1' };

  it('row 0: settled before ⇒ spent, whatever else is true', () => {
    expect(
      judgeGateProof({
        claim,
        presented: 'tok-1',
        settledBefore: 'answered',
        storeKeepsClaims: true,
      }),
    ).toEqual({ proof: 'spent', cause: 'answered' });
    expect(
      judgeGateProof({
        claim: undefined,
        presented: undefined,
        settledBefore: 'expired',
        storeKeepsClaims: false,
      }),
    ).toEqual({ proof: 'spent', cause: 'expired' });
  });

  it('row 1: no claim ⇒ unverifiable (no_claim, or store_keeps_no_claims when the store keeps none) — even with NOTHING presented', () => {
    // Red under the absent≡absent hoist (mutant b): `undefined === undefined` would answer `matched`.
    expect(
      judgeGateProof({
        claim: undefined,
        presented: undefined,
        settledBefore: undefined,
        storeKeepsClaims: true,
      }),
    ).toEqual({ proof: 'unverifiable', cause: 'no_claim' });
    expect(
      judgeGateProof({
        claim: undefined,
        presented: 'x',
        settledBefore: undefined,
        storeKeepsClaims: false,
      }),
    ).toEqual({ proof: 'unverifiable', cause: 'store_keeps_no_claims' });
  });

  it('row 2: a claim with no token ⇒ unverifiable claim_has_no_token — even with NOTHING presented', () => {
    expect(
      judgeGateProof({
        claim: { deadline: null },
        presented: undefined,
        settledBefore: undefined,
        storeKeepsClaims: true,
      }),
    ).toEqual({ proof: 'unverifiable', cause: 'claim_has_no_token' });
    expect(
      judgeGateProof({
        claim: { deadline: null },
        presented: 'x',
        settledBefore: undefined,
        storeKeepsClaims: true,
      }),
    ).toEqual({ proof: 'unverifiable', cause: 'claim_has_no_token' });
  });

  it('row 3: a token and none presented ⇒ absent', () => {
    expect(
      judgeGateProof({
        claim,
        presented: undefined,
        settledBefore: undefined,
        storeKeepsClaims: true,
      }),
    ).toEqual({ proof: 'absent' });
  });

  it('row 4: equal ⇒ matched; row 5: different — an EMPTY string included — ⇒ mismatch', () => {
    expect(
      judgeGateProof({
        claim,
        presented: 'tok-1',
        settledBefore: undefined,
        storeKeepsClaims: true,
      }),
    ).toEqual({ proof: 'matched' });
    expect(
      judgeGateProof({
        claim,
        presented: 'tok-2',
        settledBefore: undefined,
        storeKeepsClaims: true,
      }),
    ).toEqual({ proof: 'mismatch' });
    expect(
      judgeGateProof({ claim, presented: '', settledBefore: undefined, storeKeepsClaims: true }),
    ).toEqual({ proof: 'mismatch' });
  });
});

describe('composeGateClaimSentence — ONE string per verdict, joined to the consequence clause', () => {
  const RECORDED = 'the answer was recorded.';

  it('matched ⇒ none, in either consequence', () => {
    expect(composeGateClaimSentence({ proof: 'matched' }, true, true)).toBeUndefined();
    expect(composeGateClaimSentence({ proof: 'matched' }, false, true)).toBeUndefined();
  });

  it('absent', () => {
    expect(composeGateClaimSentence({ proof: 'absent' }, true, false)).toBe(
      `No claim_token was passed; ${RECORDED} Only the conversation that opened the question has one to pass.`,
    );
    // Issue #625, PR-H review correction C6: not recorded ⇒ the token fact alone.
    expect(composeGateClaimSentence({ proof: 'absent' }, false, false)).toBe(
      'No claim_token was passed.',
    );
  });

  it("mismatch — never 'another program took over'", () => {
    expect(composeGateClaimSentence({ proof: 'mismatch' }, true, true)).toBe(
      `The claim_token passed is not this question's; ${RECORDED}`,
    );
    expect(composeGateClaimSentence({ proof: 'mismatch' }, false, true)).toBe(
      "The claim_token passed is not this question's.",
    );
  });

  it.each([
    [
      { proof: 'unverifiable', cause: 'no_claim' } as GateClaimVerdict,
      'There is no claim to check a claim_token against — the gate step has no claim on this record; ',
      'There is no claim to check a claim_token against — the gate step has no claim on this record.',
    ],
    [
      { proof: 'unverifiable', cause: 'claim_has_no_token' } as GateClaimVerdict,
      "This question's claim carries no token, so the claim_token could not be checked; ",
      "This question's claim carries no token, so the claim_token could not be checked.",
    ],
    [
      { proof: 'unverifiable', cause: 'store_keeps_no_claims' } as GateClaimVerdict,
      'This store keeps no claims, so a claim_token cannot be checked; ',
      'This store keeps no claims, so a claim_token cannot be checked.',
    ],
  ])('unverifiable %j', (verdict, lead, notRecorded) => {
    expect(composeGateClaimSentence(verdict, true, false)).toBe(`${lead}${RECORDED}`);
    expect(composeGateClaimSentence(verdict, false, false)).toBe(notRecorded);
  });

  it('spent: a sentence only when a token was presented; none otherwise', () => {
    expect(composeGateClaimSentence({ proof: 'spent', cause: 'answered' }, true, true)).toBe(
      'The claim_token could not be checked: this question was already settled by an earlier answer.',
    );
    expect(composeGateClaimSentence({ proof: 'spent', cause: 'expired' }, true, true)).toBe(
      'The claim_token could not be checked: this question was already settled by its expiry.',
    );
    expect(
      composeGateClaimSentence({ proof: 'spent', cause: 'answered' }, true, false),
    ).toBeUndefined();
    expect(
      composeGateClaimSentence({ proof: 'spent', cause: 'expired' }, false, false),
    ).toBeUndefined();
  });
});

describe('readGateClaimVerdict — a stored claim_proof read back', () => {
  it('reads every well-formed verdict', () => {
    for (const v of [
      { proof: 'matched' },
      { proof: 'absent' },
      { proof: 'mismatch' },
      { proof: 'unverifiable', cause: 'no_claim' },
      { proof: 'unverifiable', cause: 'claim_has_no_token' },
      { proof: 'unverifiable', cause: 'store_keeps_no_claims' },
      { proof: 'spent', cause: 'answered' },
      { proof: 'spent', cause: 'expired' },
    ] as const) {
      expect(readGateClaimVerdict(v)).toEqual(v);
    }
  });

  it('refuses everything else (not an object, an unknown proof, a cause that does not belong)', () => {
    for (const bad of [
      null,
      'matched',
      {},
      { proof: 'verified' },
      { proof: 'matched', cause: 'x' },
      { proof: 'unverifiable' },
      { proof: 'unverifiable', cause: 'answered' },
      { proof: 'spent', cause: 'no_claim' },
    ]) {
      expect(readGateClaimVerdict(bad)).toBeUndefined();
    }
  });
});
