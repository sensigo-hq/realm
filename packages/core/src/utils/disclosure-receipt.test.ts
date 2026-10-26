// #729 PR-3 (RECORD 01 #7; D1 §3.7; prompt 01 C-4): the receipt's law, one cell per producing
// branch. The receipt is derived at read from the walk's counts. Every value is fake. Each assertion
// names (a) the change that turns it red and (b) what it prints on failure: receipt fields (states,
// causes, counts, field paths and names), never a value.
import { describe, it, expect } from 'vitest';
import {
  buildDisclosureSet,
  compileDisclosure,
  emptyDisclosureSet,
  type DeclaredCause,
  type DisclosureAudience,
} from './redaction.js';
import { discloseByTable, disclosureReceipt } from './disclosure-walk.js';

const ENV_VALUE = 'FAKE-ENV-VALUE-0001';
const DECLARED_VALUE = 'FAKE-DECLARED-0002';
const TEXT = { data: `${ENV_VALUE} ${DECLARED_VALUE} password=FAKE-PW` };

function receiptFor(
  audience: DisclosureAudience,
  declared: Record<string, string>,
  cause?: DeclaredCause,
) {
  const { set } = buildDisclosureSet({
    env: { SOME_ENV: ENV_VALUE },
    declared,
    declaredState:
      cause === undefined || cause === 'no_manifest'
        ? 'resolved'
        : cause === 'manifest_changed'
          ? 'partial'
          : 'unknown',
    ...(cause !== undefined ? { declaredCause: cause } : {}),
    audience,
  });
  return disclosureReceipt(set, discloseByTable(TEXT, { data: 'value' }, set, audience).tally);
}

describe('#729 PR-3 — the receipt', () => {
  it('resolved: declared state, the sweep, hidden by kind, unchecked, unmaskable', () => {
    // (a) red when a count or a state is not carried; (b) prints the receipt.
    expect(receiptFor('agent', { S: DECLARED_VALUE })).toEqual({
      declared: 'resolved',
      environment: 'swept',
      hidden: { declared: 1, environment: 1, pattern: 1 },
      unchecked: 0,
      unmaskable: 0,
      too_deep: 0,
    });
  });

  it('each declared cause is carried: no_manifest, load_failed, embedder_none, manifest_changed', () => {
    for (const [cause, state] of [
      ['no_manifest', 'resolved'],
      ['load_failed', 'unknown'],
      ['embedder_none', 'unknown'],
      ['manifest_changed', 'partial'],
    ] as const) {
      const receipt = receiptFor('agent', {}, cause);
      // (a) red when the cause or state is dropped; (b) prints both.
      expect({ cause, state, got: [receipt.declared, receipt.declared_cause] }).toEqual({
        cause,
        state,
        got: [state, cause],
      });
    }
  });

  it('a host that passes no environment: not swept, cause host_set', () => {
    const { set } = buildDisclosureSet({
      env: undefined,
      declared: {},
      declaredState: 'resolved',
      audience: 'agent',
    });
    const receipt = disclosureReceipt(
      set,
      discloseByTable(TEXT, { data: 'value' }, set, 'agent').tally,
    );
    // (a) red when the sweep is claimed without an environment; (b) prints the two fields.
    expect([receipt.environment, receipt.environment_cause]).toEqual(['not_swept', 'host_set']);
  });

  it('the unmaskable count', () => {
    const receipt = receiptFor('agent', { SHORT: 'ab', OK: DECLARED_VALUE });
    // (a) red when unmaskable is not counted; (b) prints the number.
    expect(receipt.unmaskable).toBe(1);
  });

  it('shaped only on broadcast; names only on private', () => {
    const broadcast = receiptFor('broadcast', { S: DECLARED_VALUE });
    const privateR = receiptFor('private', { S: DECLARED_VALUE });
    const agent = receiptFor('agent', { S: DECLARED_VALUE });
    // (a) red when names reach a shared audience, or shaped fields are not listed; (b) prints the
    //     field lists and names.
    expect(broadcast.shaped).toEqual(['data']);
    expect(broadcast.members).toBeUndefined();
    expect(privateR.members).toEqual(['declared:S']);
    expect(privateR.shaped).toBeUndefined();
    expect([agent.shaped, agent.members]).toEqual([undefined, undefined]);
  });

  it('an empty set reports what it is: unknown, not swept', () => {
    const set = emptyDisclosureSet('agent', 'unknown', 'embedder_none');
    // (a) red when an empty set claims a sweep; (b) prints the receipt.
    expect(disclosureReceipt(set, discloseByTable({}, {}, set, 'agent').tally)).toEqual({
      declared: 'unknown',
      declared_cause: 'embedder_none',
      environment: 'not_swept',
      hidden: { declared: 0, environment: 0, pattern: 0 },
      unchecked: 0,
      unmaskable: 0,
      too_deep: 0,
    });
  });

  it('compileDisclosure takes `environment` explicitly: there is no default (F12, D-8)', () => {
    // (a) red when the option becomes optional with a default again: the `@ts-expect-error` below
    //     is then unused (typecheck:tests), and the set claims a sweep it never did; (b) prints the
    //     set's environment state.
    // @ts-expect-error — `environment` is required
    const set = compileDisclosure([], { declared: 'resolved', audience: 'agent' }).set;
    expect(set.environment).toBe(undefined);
  });
});
