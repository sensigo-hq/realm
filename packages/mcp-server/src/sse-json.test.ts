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

  it('round-trips non-ASCII text through JSON.parse', () => {
    const input = { t: 'Uw bestelling é ü' };
    const output = sseJsonStringify(input);
    expect(/[\x80-￿]/g.test(output)).toBe(false);
    expect(JSON.parse(output).t).toBe('Uw bestelling é ü');
  });
});
