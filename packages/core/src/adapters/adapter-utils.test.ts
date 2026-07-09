import { describe, it, expect } from 'vitest';
import { parseRetryAfterHeader, redactErrorBody } from './adapter-utils.js';

describe('redactErrorBody', () => {
  it('redacts an email address in a plain-string body', () => {
    const out = redactErrorBody('Error: no user found for jane.doe@example.com');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).not.toContain('jane.doe@example.com');
  });

  it('redacts an email address inside an object body (stringified first)', () => {
    const out = redactErrorBody({ error: 'invalid', email: 'jane.doe@example.com' });
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).not.toContain('jane.doe@example.com');
  });

  it('caps an over-500-char body with the …[truncated] marker', () => {
    const long = 'x'.repeat(600);
    const out = redactErrorBody(long);
    expect(out).toBe(`${'x'.repeat(500)}…[truncated]`);
    expect(out.length).toBe(512);
  });

  it('returns a short plain body intact (no email, under the cap)', () => {
    expect(redactErrorBody('not found')).toBe('not found');
  });

  it('falls back to String(body) if JSON.stringify would throw (circular reference)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => redactErrorBody(circular)).not.toThrow();
  });
});

describe('parseRetryAfterHeader', () => {
  it('returns parsed integer when header is a valid integer string', () => {
    expect(parseRetryAfterHeader('30')).toBe(30);
    expect(parseRetryAfterHeader('0')).toBe(0);
  });

  it('returns fallback when header is null', () => {
    expect(parseRetryAfterHeader(null, 60)).toBe(60);
    expect(parseRetryAfterHeader(null)).toBeUndefined();
  });

  it('parses HTTP-date form in the past — returns 0', () => {
    expect(parseRetryAfterHeader('Mon, 01 Jan 2024 00:00:00 GMT', 30)).toBe(0);
  });

  it('parses HTTP-date form in the future — returns positive seconds', () => {
    const futureDate = new Date(Date.now() + 30000).toUTCString();
    const result = parseRetryAfterHeader(futureDate);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(31);
  });

  it('returns 0 for negative integer (malformed header)', () => {
    expect(parseRetryAfterHeader('-5', 30)).toBe(0);
  });

  it('returns fallback when header is an empty string', () => {
    expect(parseRetryAfterHeader('', 60)).toBe(60);
  });
});
