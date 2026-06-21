// Unit tests for the minimal trigger-schema module in isolation (no YAML loader).
import { describe, it, expect } from 'vitest';
import { Ajv } from 'ajv';
import {
  TRIGGER_JSON_SCHEMA,
  normalizeTriggerFilter,
  validateTriggerStructure,
} from './trigger-schema.js';

const msg = (trigger: unknown) => validateTriggerStructure(trigger).join(' ; ');

describe('TRIGGER_JSON_SCHEMA', () => {
  it('is an object schema requiring type + auth and rejecting unknown top-level keys', () => {
    expect(TRIGGER_JSON_SCHEMA.type).toBe('object');
    expect(TRIGGER_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(TRIGGER_JSON_SCHEMA.required).toEqual(['type', 'auth']);
  });

  it('compiles cleanly under Ajv strict:true', () => {
    expect(() =>
      new Ajv({ allErrors: true, strict: true }).compile(TRIGGER_JSON_SCHEMA),
    ).not.toThrow();
  });
});

describe('normalizeTriggerFilter', () => {
  it('wraps a shorthand condition into { all: [condition] } in place', () => {
    const trigger = { type: 'webhook', filter: { header: 'x', value: 'v' } };
    normalizeTriggerFilter(trigger);
    expect(trigger.filter).toEqual({ all: [{ header: 'x', value: 'v' }] });
  });

  it('is a no-op when filter already has an all key, is absent, or trigger is not an object', () => {
    const all = [{ header: 'x', value: 'v' }];
    const t = { filter: { all } };
    normalizeTriggerFilter(t);
    expect(t.filter).toEqual({ all });
    const noFilter = { type: 'webhook' };
    normalizeTriggerFilter(noFilter);
    expect(noFilter).toEqual({ type: 'webhook' });
    expect(() => normalizeTriggerFilter(null)).not.toThrow();
    expect(() => normalizeTriggerFilter('nope')).not.toThrow();
  });
});

describe('validateTriggerStructure — valid auth modes load', () => {
  const cases: Array<[string, unknown]> = [
    [
      'shared_secret (Gorgias)',
      {
        type: 'webhook',
        auth: { mode: 'shared_secret', header: 'Authorization', secret_from: 'GORGIAS_TOKEN' },
      },
    ],
    ['github', { type: 'webhook', auth: { mode: 'github', secret_from: 'GH' } }],
    ['stripe', { type: 'webhook', auth: { mode: 'stripe', secret_from: 'ST' } }],
    [
      'stripe + max_age_seconds',
      { type: 'webhook', auth: { mode: 'stripe', secret_from: 'ST', max_age_seconds: 300 } },
    ],
    [
      'hmac minimal',
      { type: 'webhook', auth: { mode: 'hmac', secret_from: 'H', header: 'x-sig' } },
    ],
    [
      'hmac with all optionals',
      {
        type: 'webhook',
        auth: {
          mode: 'hmac',
          secret_from: 'H',
          header: 'x-sig',
          algorithm: 'sha512',
          encoding: 'base64',
          timestamp_header: 't',
          max_age_seconds: 60,
        },
      },
    ],
    ['none', { type: 'webhook', auth: { mode: 'none' } }],
    ['dedup:false', { type: 'webhook', auth: { mode: 'none' }, dedup: false }],
    [
      'dedup object at bounds',
      {
        type: 'webhook',
        auth: { mode: 'none' },
        dedup: { id_from: 'body.id', ttl_minutes: 10080, on_missing_id: 'reject' },
      },
    ],
    [
      'filter string value',
      {
        type: 'webhook',
        auth: { mode: 'none' },
        filter: { all: [{ header: 'x-event', value: 'push' }] },
      },
    ],
    [
      'filter array value (path)',
      {
        type: 'webhook',
        auth: { mode: 'none' },
        filter: { all: [{ path: 'body.type', value: ['a', 'b'] }] },
      },
    ],
    [
      'params_map + path',
      {
        type: 'webhook',
        path: '/hooks/gorgias',
        auth: { mode: 'none' },
        params_map: { ticket_id: 'body.id' },
      },
    ],
  ];
  it.each(cases)('%s → loads', (_label, trigger) => {
    expect(validateTriggerStructure(trigger)).toEqual([]);
  });
});

describe('validateTriggerStructure — invalid configs reject with field-named messages', () => {
  it('shared_secret missing header → error', () => {
    expect(msg({ type: 'webhook', auth: { mode: 'shared_secret', secret_from: 'T' } })).toMatch(
      /header/,
    );
  });
  it('shared_secret missing secret_from → error', () => {
    expect(
      msg({ type: 'webhook', auth: { mode: 'shared_secret', header: 'Authorization' } }),
    ).toMatch(/secret_from/);
  });
  it('invalid mode → error', () => {
    expect(msg({ type: 'webhook', auth: { mode: 'paypal', secret_from: 'T' } })).toMatch(/mode/);
  });
  it('auth missing → error', () => {
    expect(msg({ type: 'webhook' })).toMatch(/auth/);
  });
  it('github/stripe/hmac missing secret_from → error', () => {
    expect(msg({ type: 'webhook', auth: { mode: 'github' } })).toMatch(/secret_from/);
    expect(msg({ type: 'webhook', auth: { mode: 'stripe' } })).toMatch(/secret_from/);
    expect(msg({ type: 'webhook', auth: { mode: 'hmac', header: 'x' } })).toMatch(/secret_from/);
  });
  it('hmac missing header → error', () => {
    expect(msg({ type: 'webhook', auth: { mode: 'hmac', secret_from: 'H' } })).toMatch(/header/);
  });
  it('hmac invalid algorithm/encoding → error', () => {
    expect(
      msg({
        type: 'webhook',
        auth: { mode: 'hmac', secret_from: 'H', header: 'x', algorithm: 'sha265' },
      }),
    ).toMatch(/algorithm/);
    expect(
      msg({
        type: 'webhook',
        auth: { mode: 'hmac', secret_from: 'H', header: 'x', encoding: 'hex64' },
      }),
    ).toMatch(/encoding/);
  });
  it('cross-mode field bleed → unknown-property error, no then wrapper', () => {
    const m = msg({
      type: 'webhook',
      auth: { mode: 'github', secret_from: 'G', algorithm: 'sha256' },
    });
    expect(m).toMatch(/unknown property 'algorithm'/);
    expect(m).not.toMatch(/then/);
    expect(
      msg({
        type: 'webhook',
        auth: { mode: 'shared_secret', header: 'A', secret_from: 'T', max_age_seconds: 5 },
      }),
    ).toMatch(/unknown property 'max_age_seconds'/);
  });
  it('dedup missing id_from → error, no const/oneOf noise', () => {
    const m = msg({ type: 'webhook', auth: { mode: 'none' }, dedup: { ttl_minutes: 60 } });
    expect(m).toMatch(/id_from/);
    expect(m).not.toMatch(/equal to constant/);
    expect(m).not.toMatch(/oneOf/);
  });
  it('dedup ttl_minutes out of range (10081) → error', () => {
    expect(
      msg({
        type: 'webhook',
        auth: { mode: 'none' },
        dedup: { id_from: 'body.id', ttl_minutes: 10081 },
      }),
    ).toMatch(/ttl_minutes/);
  });
  it('dedup on_missing_id typo → error', () => {
    expect(
      msg({
        type: 'webhook',
        auth: { mode: 'none' },
        dedup: { id_from: 'body.id', on_missing_id: 'rejcet' },
      }),
    ).toMatch(/on_missing_id/);
  });
  it('filter both header and path → clear XOR message, no cryptic oneOf', () => {
    const m = msg({
      type: 'webhook',
      auth: { mode: 'none' },
      filter: { all: [{ header: 'h', path: 'p', value: 'v' }] },
    });
    expect(m).toMatch(/exactly one of 'header' or 'path'/);
    expect(m).not.toMatch(/schema in oneOf/);
  });
  it('filter empty value / empty-element array → error', () => {
    expect(
      msg({
        type: 'webhook',
        auth: { mode: 'none' },
        filter: { all: [{ header: 'h', value: '' }] },
      }),
    ).toMatch(/value/);
    expect(
      msg({
        type: 'webhook',
        auth: { mode: 'none' },
        filter: { all: [{ header: 'h', value: [''] }] },
      }),
    ).toMatch(/value/);
  });
  it('filter.all over 8 conditions → error', () => {
    const all = Array.from({ length: 9 }, (_u, i) => ({ header: `h${i}`, value: `v${i}` }));
    expect(msg({ type: 'webhook', auth: { mode: 'none' }, filter: { all } })).toMatch(
      /more than 8 items/,
    );
  });
  it('params_map non-string value → error', () => {
    expect(msg({ type: 'webhook', auth: { mode: 'none' }, params_map: { x: 123 } })).toMatch(
      /params_map/,
    );
  });
  it("typo'd top-level key → error", () => {
    expect(msg({ type: 'webhook', auth: { mode: 'none' }, dedpu: false })).toMatch(
      /unknown property 'dedpu'/,
    );
  });

  it('never throws on non-object / null / primitive input', () => {
    expect(() => validateTriggerStructure(null)).not.toThrow();
    expect(() => validateTriggerStructure('nope')).not.toThrow();
    expect(validateTriggerStructure(null).length).toBeGreaterThan(0);
  });

  it('output is de-duplicated (no repeated message line)', () => {
    const errs = validateTriggerStructure({ type: 'webhook', auth: { mode: 'hmac' } });
    expect(errs.length).toBeGreaterThan(0);
    expect(new Set(errs).size).toBe(errs.length);
  });
});
