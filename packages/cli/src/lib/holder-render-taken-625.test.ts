// holder-render-taken-625.test.ts — issue #625 PR-2a (decision C22): the ONE phrase for who took a
// step, one cell per member of what `describeClaimHolder` returns, and the D6.1 line around it.
import { describe, it, expect } from 'vitest';
import { takenLine, takenPhrase, UNSHOWABLE_NAME } from './holder-render.js';

describe('#625 PR-2a — takenPhrase, every member', () => {
  it('a readable holder', () => {
    expect(takenPhrase({ holder: { by: 'me@host', by_source: 'derived', channel: 'agent' } })).toBe(
      'taken by me@host (from the OS user, via agent)',
    );
  });
  it('holder_not_recorded', () => {
    expect(takenPhrase({ by: null, absent_cause: 'holder_not_recorded' })).toBe(
      'taken by a program whose name was not recorded',
    );
  });
  it('pre_lease_claim', () => {
    expect(takenPhrase({ by: null, absent_cause: 'pre_lease_claim' })).toBe(
      'taken before program names were recorded',
    );
  });
  it('name_unreadable', () => {
    expect(takenPhrase({ by: null, absent_cause: 'name_unreadable' })).toBe(
      `taken by ${UNSHOWABLE_NAME}`,
    );
    expect(takenPhrase({ by: null, absent_cause: 'name_unreadable' })).toBe(
      'taken by a recorded name that cannot be printed (control characters, or not a name with its source)',
    );
  });
  it('store_keeps_no_claims', () => {
    expect(takenPhrase({ by: null, absent_cause: 'store_keeps_no_claims' })).toBe(
      'taken by another process (this run store keeps no claims)',
    );
  });
  it('no_claim (the claim was gone by the re-read)', () => {
    expect(takenPhrase({ by: null, absent_cause: 'no_claim' })).toBe(
      'taken by another process, whose claim is no longer on the record',
    );
  });
});

describe('#625 PR-2a — takenLine (D6.1)', () => {
  it("with the claim's time, and without it", () => {
    expect(
      takenLine('s', {
        holder: { by: 'me', by_source: 'stated', channel: 'mcp-stdio' },
        since: '2026-10-04T00:00:00.000Z',
      }),
    ).toBe(
      "• Step 's' was taken by me (as stated, via mcp-stdio) at 2026-10-04T00:00:00.000Z; not run here.",
    );
    expect(takenLine('s', { by: null, absent_cause: 'pre_lease_claim' })).toBe(
      "• Step 's' was taken before program names were recorded; not run here.",
    );
  });
});
