import { describe, it, expect } from 'vitest';
import { sseJsonStringify } from './sse-json.js';

describe('sseJsonStringify', () => {
  it('escapes U+0085 (NEXT LINE)', () => {
    const input = { t: '' };
    const output = sseJsonStringify(input);
    expect(output).not.toContain('');
    expect(JSON.parse(output).t).toBe('');
  });

  it('escapes U+2028 (LINE SEPARATOR)', () => {
    const input = { t: ' ' };
    const output = sseJsonStringify(input);
    expect(output).not.toContain(' ');
    expect(JSON.parse(output).t).toBe(' ');
  });

  it('escapes U+2029 (PARAGRAPH SEPARATOR)', () => {
    const input = { t: ' ' };
    const output = sseJsonStringify(input);
    expect(output).not.toContain(' ');
    expect(JSON.parse(output).t).toBe(' ');
  });

  it('leaves pure ASCII content unchanged', () => {
    const input = { msg: 'hello world', n: 42 };
    expect(sseJsonStringify(input)).toBe(JSON.stringify(input, null, 2));
  });

  it('leaves regular non-ASCII chars (accented letters) unescaped', () => {
    const input = { t: 'Uw bestelling é ü' };
    const output = sseJsonStringify(input);
    // Targeted approach: only the 3 splitlines() chars are escaped.
    // Regular non-ASCII (é, ü) must pass through to avoid payload inflation.
    expect(output).toContain('é');
    expect(output).toContain('ü');
    expect(JSON.parse(output).t).toBe('Uw bestelling é ü');
  });
});
