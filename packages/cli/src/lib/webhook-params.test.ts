// Tests for webhook payload helpers.
import { describe, it, expect, vi } from 'vitest';
import type { DedupConfig } from '@sensigo/realm';
import { resolveDotPath, extractParams, extractDedupId } from './webhook-params.js';

describe('resolveDotPath', () => {
  it('simple property body.id', () => {
    expect(resolveDotPath({ body: { id: 'abc' } }, 'body.id')).toBe('abc');
  });
  it('nested body.order.id', () => {
    expect(resolveDotPath({ body: { order: { id: 'o1' } } }, 'body.order.id')).toBe('o1');
  });
  it('array index body.items.0 → first element', () => {
    expect(resolveDotPath({ body: { items: ['first', 'second'] } }, 'body.items.0')).toBe('first');
  });
  it('out-of-bounds index body.items.99 → undefined', () => {
    expect(resolveDotPath({ body: { items: ['first'] } }, 'body.items.99')).toBeUndefined();
  });
  it('numeric segment on object (not array) → property access', () => {
    expect(resolveDotPath({ body: { '0': 'zero' } }, 'body.0')).toBe('zero');
  });
  it('non-existent path → undefined', () => {
    expect(resolveDotPath({ body: { id: 'abc' } }, 'body.missing')).toBeUndefined();
  });
  it('path through null → undefined', () => {
    expect(resolveDotPath({ body: null }, 'body.id')).toBeUndefined();
  });
  it('empty path → returns root object', () => {
    const root = { body: { id: 'abc' } };
    expect(resolveDotPath(root, '')).toBe(root);
  });
});

describe('extractParams', () => {
  const payload = { headers: { 'x-id': 'h1' }, body: { order: { id: 'o1' } } };

  it('single path, value present → { key: value }', () => {
    const logger = { warn: vi.fn() };
    expect(extractParams(payload, { orderId: 'body.order.id' }, logger)).toEqual({ orderId: 'o1' });
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it('single path, value absent → {} and logger.warn called', () => {
    const logger = { warn: vi.fn() };
    expect(extractParams(payload, { orderId: 'body.missing' }, logger)).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith('webhook params: could not resolve path', {
      path: 'body.missing',
    });
  });
  it('multiple paths, some absent → partial record; warn per absent', () => {
    const logger = { warn: vi.fn() };
    const result = extractParams(
      payload,
      { orderId: 'body.order.id', missing: 'body.nope', hid: 'headers.x-id' },
      logger,
    );
    expect(result).toEqual({ orderId: 'o1', hid: 'h1' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('webhook params: could not resolve path', {
      path: 'body.nope',
    });
  });
});

describe('extractDedupId', () => {
  const headers = { 'x-id': 'h1' };

  it('path resolves to string → string', () => {
    const cfg: DedupConfig = { id_from: 'body.id' };
    expect(extractDedupId({ headers, body: { id: 'abc' } }, cfg)).toBe('abc');
  });
  it('path resolves to number → stringified number', () => {
    const cfg: DedupConfig = { id_from: 'body.id' };
    expect(extractDedupId({ headers, body: { id: 12345 } }, cfg)).toBe('12345');
  });
  it('path resolves to undefined → undefined', () => {
    const cfg: DedupConfig = { id_from: 'body.missing' };
    expect(extractDedupId({ headers, body: { id: 'abc' } }, cfg)).toBeUndefined();
  });
  it('path resolves to null → undefined', () => {
    const cfg: DedupConfig = { id_from: 'body.id' };
    expect(extractDedupId({ headers, body: { id: null } }, cfg)).toBeUndefined();
  });
});
