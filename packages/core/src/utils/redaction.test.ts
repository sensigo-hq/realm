// Unit tests for the shared redaction/bounding primitives (issue #111 extraction).
// redactErrorBody's own behavior-unchanged coverage lives in adapter-utils.test.ts — unmodified
// by this extraction, and still green, which is the proof of byte-identical behavior.
import { describe, it, expect } from 'vitest';
import { scrubEmail, capText, boundResolvedValue, REDACTION_CHAR_CAP } from './redaction.js';

describe('scrubEmail', () => {
  it('replaces an email address with [REDACTED_EMAIL]', () => {
    expect(scrubEmail('contact jane.doe@example.com for help')).toBe(
      'contact [REDACTED_EMAIL] for help',
    );
  });

  it('leaves a string with no email unchanged', () => {
    expect(scrubEmail('no email here')).toBe('no email here');
  });
});

describe('capText', () => {
  it('leaves a short string unchanged', () => {
    expect(capText('short')).toBe('short');
  });

  it('caps an over-limit string and appends the truncation marker', () => {
    const long = 'x'.repeat(600);
    expect(capText(long)).toBe(`${'x'.repeat(REDACTION_CHAR_CAP)}…[truncated]`);
  });
});

describe('boundResolvedValue (issue #111)', () => {
  it('passes null through verbatim', () => {
    expect(boundResolvedValue(null)).toBeNull();
  });

  it('passes undefined through verbatim', () => {
    expect(boundResolvedValue(undefined)).toBeUndefined();
  });

  it('passes booleans through verbatim', () => {
    expect(boundResolvedValue(true)).toBe(true);
    expect(boundResolvedValue(false)).toBe(false);
  });

  it('passes numbers through verbatim (including 0 and negative)', () => {
    expect(boundResolvedValue(0)).toBe(0);
    expect(boundResolvedValue(-5)).toBe(-5);
    expect(boundResolvedValue(3.14)).toBe(3.14);
  });

  it('passes a short string through, scrubbed of email addresses', () => {
    expect(boundResolvedValue('jane.doe@example.com')).toBe('[REDACTED_EMAIL]');
    expect(boundResolvedValue('plain string')).toBe('plain string');
  });

  it('caps a long string and appends the truncation marker, scrubbed', () => {
    const long = 'x'.repeat(600);
    expect(boundResolvedValue(long)).toBe(`${'x'.repeat(REDACTION_CHAR_CAP)}…[truncated]`);
  });

  it('caps a long string containing an email — scrub applies to the capped text', () => {
    const long = `jane.doe@example.com${'x'.repeat(600)}`;
    const result = boundResolvedValue(long) as string;
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).not.toContain('jane.doe@example.com');
    expect(result.endsWith('…[truncated]')).toBe(true);
  });

  it('stringifies, caps, and scrubs an object', () => {
    const result = boundResolvedValue({ email: 'jane.doe@example.com', ok: true }) as string;
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).not.toContain('jane.doe@example.com');
    expect(result).toContain('"ok":true');
  });

  it('stringifies and caps a large array', () => {
    const arr = Array.from({ length: 200 }, (_, i) => i);
    const result = boundResolvedValue(arr) as string;
    expect(result.length).toBeLessThanOrEqual(REDACTION_CHAR_CAP + '…[truncated]'.length);
    expect(result.endsWith('…[truncated]')).toBe(true);
  });

  it('falls back to <unserializable> for a circular object (JSON.stringify throws)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(boundResolvedValue(circular)).toBe('<unserializable>');
  });
});
