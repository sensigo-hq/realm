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

  it('returns fallback when header is an HTTP-date string (not supported)', () => {
    expect(parseRetryAfterHeader('Sat, 31 May 2026 12:00:00 GMT', 30)).toBe(30);
  });

  it('returns fallback when header is an empty string', () => {
    expect(parseRetryAfterHeader('', 60)).toBe(60);
  });
});
