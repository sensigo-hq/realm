import { describe, it, expect } from 'vitest';
import { parseRetryAfterHeader } from './adapter-utils.js';

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
