// Unit tests for the trigger-schema module in isolation (no YAML loader).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Ajv } from 'ajv';
import {
  TRIGGER_JSON_SCHEMA,
  normalizeTriggerFilter,
  validateTriggerStructure,
  emitTriggerWarnings,
} from './trigger-schema.js';

describe('TRIGGER_JSON_SCHEMA', () => {
  it('is an object schema that rejects unknown top-level keys', () => {
    expect(TRIGGER_JSON_SCHEMA.type).toBe('object');
    expect(TRIGGER_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(TRIGGER_JSON_SCHEMA.required).toEqual(['type', 'signature']);
  });
});

describe('normalizeTriggerFilter', () => {
  it('wraps a shorthand condition into { all: [condition] } in place', () => {
    const trigger = { type: 'webhook', filter: { header: 'x', value: 'v' } };
    normalizeTriggerFilter(trigger);
    expect(trigger.filter).toEqual({ all: [{ header: 'x', value: 'v' }] });
  });

  it('wraps garbage shorthand too (so it is validated, not laundered)', () => {
    const trigger: { filter: unknown } = { filter: { foo: 'bar' } };
    normalizeTriggerFilter(trigger);
    expect(trigger.filter).toEqual({ all: [{ foo: 'bar' }] });
  });

  it('is a no-op when filter already has an all key', () => {
    const all = [{ header: 'x', value: 'v' }];
    const trigger = { filter: { all } };
    normalizeTriggerFilter(trigger);
    expect(trigger.filter).toEqual({ all });
  });

  it('is a no-op when filter is absent, or trigger is not an object', () => {
    const noFilter = { type: 'webhook' };
    normalizeTriggerFilter(noFilter);
    expect(noFilter).toEqual({ type: 'webhook' });
    expect(() => normalizeTriggerFilter(null)).not.toThrow();
    expect(() => normalizeTriggerFilter('nope')).not.toThrow();
    expect(() => normalizeTriggerFilter([1, 2])).not.toThrow();
  });
});

describe('validateTriggerStructure', () => {
  it('returns [] for a valid trigger', () => {
    expect(
      validateTriggerStructure({
        type: 'webhook',
        signature: { provider: 'github', secret_from: 'X' },
      }),
    ).toEqual([]);
  });

  it('returns field-named errors for missing required signature secret', () => {
    const errs = validateTriggerStructure({ type: 'webhook', signature: { provider: 'github' } });
    expect(errs.join(' ')).toMatch(/secret_from/);
  });

  it('reports both alternatives for shopify with neither secret_from nor secret_map', () => {
    const errs = validateTriggerStructure({ type: 'webhook', signature: { provider: 'shopify' } });
    const joined = errs.join(' ');
    expect(joined).toMatch(/secret_from/);
    expect(joined).toMatch(/secret_map/);
  });

  it('applies the code-only shopify secret_map .myshopify.com suffix check', () => {
    const errs = validateTriggerStructure({
      type: 'webhook',
      signature: {
        provider: 'shopify',
        secret_from_header: 'x-shopify-shop-domain',
        secret_map: { 'store.example.com': 'X' },
      },
    });
    expect(errs.join(' ')).toMatch(/myshopify\.com/);
  });

  it('rejects an empty-array filter value (unsatisfiable allow-list)', () => {
    const errs = validateTriggerStructure({
      type: 'webhook',
      signature: { provider: 'github', secret_from: 'X' },
      filter: { all: [{ header: 'h', value: [] }] },
    });
    expect(errs.join(' ')).toMatch(/value/);
  });

  it('accepts a non-empty string-array filter value', () => {
    const errs = validateTriggerStructure({
      type: 'webhook',
      signature: { provider: 'github', secret_from: 'X' },
      filter: { all: [{ path: 'body.topic', value: ['a', 'b'] }] },
    });
    expect(errs).toEqual([]);
  });

  it('rejects an empty-string filter value', () => {
    const errs = validateTriggerStructure({
      type: 'webhook',
      signature: { provider: 'github', secret_from: 'X' },
      filter: { all: [{ header: 'h', value: '' }] },
    });
    expect(errs.join(' ')).toMatch(/value/);
  });

  it('rejects an array filter value containing an empty element', () => {
    const errs = validateTriggerStructure({
      type: 'webhook',
      signature: { provider: 'github', secret_from: 'X' },
      filter: { all: [{ header: 'h', value: [''] }] },
    });
    expect(errs.join(' ')).toMatch(/value/);
  });

  it('rejects a mixed array filter value with an empty element', () => {
    const errs = validateTriggerStructure({
      type: 'webhook',
      signature: { provider: 'github', secret_from: 'X' },
      filter: { all: [{ header: 'h', value: ['a', ''] }] },
    });
    expect(errs.join(' ')).toMatch(/value/);
  });

  it('accepts a non-empty string filter value (regression guard)', () => {
    const errs = validateTriggerStructure({
      type: 'webhook',
      signature: { provider: 'github', secret_from: 'X' },
      filter: { all: [{ header: 'h', value: 'push' }] },
    });
    expect(errs).toEqual([]);
  });

  it('never throws on non-object / null / primitive input', () => {
    expect(() => validateTriggerStructure(null)).not.toThrow();
    expect(() => validateTriggerStructure('nope')).not.toThrow();
    expect(() => validateTriggerStructure(42)).not.toThrow();
    expect(validateTriggerStructure(null).length).toBeGreaterThan(0);
  });
});

describe('emitTriggerWarnings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns about the default-TTL retry window for shopify (says 10min, not undefined)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    emitTriggerWarnings(
      {
        type: 'webhook',
        signature: { provider: 'shopify', secret_from: 'X' },
        dedup: { id_from: 'b.id' },
      },
      'wf',
    );
    const call = warnSpy.mock.calls.find((a) => String(a[0]).includes('retries for 4320min'));
    expect(call).toBeDefined();
    expect(String(call?.[0])).toContain('10min');
    expect(String(call?.[0])).not.toContain('undefined');
  });

  it('does not warn for dedup:false or absent dedup', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    emitTriggerWarnings(
      { signature: { provider: 'shopify', secret_from: 'X' }, dedup: false },
      'wf',
    );
    emitTriggerWarnings({ signature: { provider: 'github', secret_from: 'X' } }, 'wf');
    const retry = warnSpy.mock.calls.some((a) => String(a[0]).includes('retries for 4320min'));
    expect(retry).toBe(false);
  });

  it('warns for shopify fallback_secret_from and debugs for registration', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    emitTriggerWarnings(
      {
        signature: {
          provider: 'shopify',
          secret_from_header: 'h',
          secret_map: { 's.myshopify.com': 'X' },
          fallback_secret_from: 'FB',
        },
        registration: { provider: 'github' },
      },
      'wf',
    );
    expect(warnSpy.mock.calls.some((a) => String(a[0]).includes('fallback_secret_from'))).toBe(
      true,
    );
    expect(debugSpy.mock.calls.some((a) => String(a[0]).includes('metadata-only'))).toBe(true);
  });
});

describe('strict-mode compilation', () => {
  it('TRIGGER_JSON_SCHEMA compiles cleanly under Ajv strict:true', () => {
    // The module already compiles it under strict:true at import; this pins it explicitly so
    // any future edit that reintroduces a strictRequired violation fails loudly here.
    expect(() =>
      new Ajv({ allErrors: true, strict: true }).compile(TRIGGER_JSON_SCHEMA),
    ).not.toThrow();
  });
});

describe('valid-form sweep (regression guard — every legitimate config must load)', () => {
  const wf = (signature: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'webhook',
    signature,
    ...extra,
  });

  const cases: Array<[string, unknown]> = [
    ['github minimal', wf({ provider: 'github', secret_from: 'X' })],
    ['stripe minimal', wf({ provider: 'stripe', secret_from: 'X' })],
    [
      'stripe + max_age_seconds',
      wf({ provider: 'stripe', secret_from: 'X', max_age_seconds: 300 }),
    ],
    ['hmac minimal', wf({ provider: 'hmac', secret_from: 'X', header: 'h' })],
    [
      'hmac with all optionals',
      wf({
        provider: 'hmac',
        secret_from: 'X',
        header: 'h',
        algorithm: 'sha512',
        encoding: 'base64',
        timestamp_header: 't',
        max_age_seconds: 60,
      }),
    ],
    ['shopify single-store', wf({ provider: 'shopify', secret_from: 'X' })],
    [
      'shopify multi-tenant',
      wf({ provider: 'shopify', secret_map: { 'a.myshopify.com': 'k' }, secret_from_header: 'h' }),
    ],
    [
      'shopify + fallback_secret_from',
      wf({
        provider: 'shopify',
        secret_map: { 'a.myshopify.com': 'k' },
        secret_from_header: 'h',
        fallback_secret_from: 'F',
      }),
    ],
    ['dedup:false', wf({ provider: 'github', secret_from: 'X' }, { dedup: false })],
    [
      'dedup object',
      wf(
        { provider: 'github', secret_from: 'X' },
        { dedup: { id_from: 'body.id', ttl_minutes: 4320 } },
      ),
    ],
    [
      'filter string value',
      wf(
        { provider: 'github', secret_from: 'X' },
        { filter: { all: [{ header: 'h', value: 'v' }] } },
      ),
    ],
    [
      'filter array value',
      wf(
        { provider: 'github', secret_from: 'X' },
        { filter: { all: [{ path: 'body.t', value: ['a', 'b'] }] } },
      ),
    ],
    [
      'params_map',
      wf({ provider: 'github', secret_from: 'X' }, { params_map: { order_id: 'body.id' } }),
    ],
    [
      'registration github complete',
      wf(
        { provider: 'github', secret_from: 'X' },
        {
          registration: {
            provider: 'github',
            scope: 'repo',
            target: 'o/r',
            events: ['push'],
            api_key_from: 'K',
          },
        },
      ),
    ],
    [
      'registration shopify complete',
      wf(
        { provider: 'github', secret_from: 'X' },
        {
          registration: {
            provider: 'shopify',
            store: 's',
            topics: ['orders/create'],
            api_key_from: 'K',
            api_version: '2024-04',
          },
        },
      ),
    ],
    [
      'registration stripe complete',
      wf(
        { provider: 'github', secret_from: 'X' },
        { registration: { provider: 'stripe', events: ['x'], api_key_from: 'K' } },
      ),
    ],
    ['path set', wf({ provider: 'github', secret_from: 'X' }, { path: '/hooks/gh' })],
    ['minimal trigger (type + signature only)', wf({ provider: 'github', secret_from: 'X' })],
  ];

  it.each(cases)('%s → loads (no errors)', (_label, trigger) => {
    expect(validateTriggerStructure(trigger)).toEqual([]);
  });
});
