// cache-diagnostics-3m.test.ts — caching 3-M piece B3a: `UsageRecord.cache_diagnostics` is closed
// where the record is written, whichever provider wrote it, and an operator's broadcast surface
// shows Anthropic's closed answer but never its id. The real cases: a reason Anthropic adds later; a
// provider module writing its own field; a record read on a surface shared beyond the run's owner.
// Each assertion carries (1) the break that turns it red and (2) what it prints: test values.
import { describe, expect, it } from 'vitest';
import { boundRequestFacts } from './request-facts.js';
import { discloseRecord } from '../utils/disclosure-tables.js';
import { compileDisclosure } from '../utils/redaction.js';
import type { RunRecord } from '../types/run-record.js';

const ID = 'msg_01XFDUDYJgAACzvnptvVoYEL';
const bound = (value: unknown): unknown => {
  const [entry] = boundRequestFacts([{ cache_diagnostics: value }]) as [Record<string, unknown>];
  return Object.hasOwn(entry, 'cache_diagnostics') ? entry['cache_diagnostics'] : 'dropped';
};
const named = (result: unknown): unknown => ({ asked: true, reference_id: ID, result });

describe('caching 3-M B3a — the one normaliser, through boundRequestFacts', () => {
  // A shape the writer makes comes through unchanged. (1) red when one of its arms is refused. (2)
  // prints what came back.
  it.each([
    ['refused', { asked: false, cause: 'rejected' }],
    ['a first request', { asked: true, reference_id: null }],
    ['no divergence', named('no_divergence')],
    ['pending', named('pending')],
    ['not returned', named('not_returned')],
    [
      'a reason with its count',
      named({ type: 'messages_changed', cache_missed_input_tokens: 1200 }),
    ],
    ['a reason with no count', named({ type: 'unavailable' })],
    ['a count of 0', named({ type: 'tools_changed', cache_missed_input_tokens: 0 })],
  ])('kept: %s', (_name, value) => {
    expect(bound(value)).toEqual(value);
  });

  // A value that is partly good loses only what is not. (1) red when the type is stored verbatim, the
  // count is unchecked, or the value is spread in place of rebuilt (the `note` rows). (2) prints what
  // came back.
  it.each([
    ['a reason Realm does not know', named({ type: 'new_reason' }), named({ type: 'unknown' })],
    [
      'a count that is text',
      named({ type: 'model_changed', cache_missed_input_tokens: 'x' }),
      named({ type: 'model_changed' }),
    ],
    [
      'a negative count',
      named({ type: 'model_changed', cache_missed_input_tokens: -1 }),
      named({ type: 'model_changed' }),
    ],
    [
      'a reason with an extra key',
      named({ type: 'system_changed', note: 'provider text' }),
      named({ type: 'system_changed' }),
    ],
    [
      'an extra key on the value',
      { asked: true, reference_id: null, note: 'provider text' },
      { asked: true, reference_id: null },
    ],
  ])('closed: %s', (_name, value, kept) => {
    expect(bound(value)).toEqual(kept);
  });

  // What has no shape is dropped whole, and nothing throws: this runs inside the failure fence, where
  // a throw loses the record. (1) red when the id, `cause`, the word list or the rule that a first
  // request has no `result` is unchecked, or the shape test is removed (the `null` row throws). (2)
  // prints what came back.
  it.each([
    ['an id that fails the check', named('pending'), { reference_id: 'chatcmpl-9fake' }],
    ['asked that is text', { asked: 'yes', reference_id: null }, {}],
    ['an array', [], undefined],
    ['a number', 5, undefined],
    ['null', null, undefined],
    ['another cause', { asked: false, cause: 'off' }, {}],
    ['a first request with a result', { asked: true, reference_id: null, result: 'pending' }, {}],
    ['a named id with no result', { asked: true, reference_id: ID }, {}],
    ['a word off the list', named('made_up'), {}],
    ['a reason whose type is no string', named({ type: 5 }), {}],
  ])('dropped: %s', (_name, value, over) => {
    const given =
      over !== undefined && typeof value === 'object' && value !== null
        ? { ...(value as object), ...over }
        : value;
    expect(bound(given)).toBe('dropped');
  });
});

describe('caching 3-M B3a — what a broadcast surface shows', () => {
  // Real case: a failed drive's requests on a surface shared beyond the run's owner. (1) red when
  // `result` sits under a `nested` row (its word becomes a shape), or `reference_id` is a `fact`, or
  // the whole row is (the id shown). (2) prints the walked field: test values.
  it('words and reasons as they are, the id as its shape, null kept', () => {
    const shown = (value: unknown): Record<string, unknown> => {
      const record = {
        id: 'run-1',
        drive_failures: {
          first_failed_at: '2026-11-09T00:00:00.000Z',
          total: 1,
          entries: [
            {
              at: '2026-11-09T00:00:00.000Z',
              step: 's',
              error_class: 'unknown',
              usage: [{ request_index: 0, cache_diagnostics: value }],
            },
          ],
        },
      };
      const { set } = compileDisclosure([], {
        declared: 'resolved',
        audience: 'broadcast',
        environment: 'swept',
      });
      const walked = discloseRecord(record as unknown as RunRecord, set, 'broadcast').record;
      return walked.drive_failures?.entries[0]?.usage?.[0]?.cache_diagnostics as unknown as Record<
        string,
        unknown
      >;
    };
    const pending = shown(named('pending'));
    const reason = shown(named({ type: 'messages_changed', cache_missed_input_tokens: 1200 }));
    expect({
      pending: pending['result'],
      reason: reason['result'],
      asked: pending['asked'],
      rejected: shown({ asked: false, cause: 'rejected' }),
      first: shown({ asked: true, reference_id: null }),
      idShown: JSON.stringify([pending, reason]).includes(ID),
      idShape: typeof pending['reference_id'],
    }).toEqual({
      pending: 'pending',
      reason: { type: 'messages_changed', cache_missed_input_tokens: 1200 },
      asked: true,
      rejected: { asked: false, cause: 'rejected' },
      first: { asked: true, reference_id: null },
      idShown: false,
      idShape: 'string',
    });
  });
});
