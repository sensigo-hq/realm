// agent-utils.test.ts — Tests for shared agent utility functions.
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  classBError,
  CLASS_B_NO_TEXT_MARKER,
  buildSystemPrompt,
  sanitizeError,
  serializeToolResult,
  setAdditionalRedactionValues,
  extractJsonObject,
} from './agent-utils.js';

describe('buildSystemPrompt', () => {
  it('returns base prompt when no schema given', () => {
    const result = buildSystemPrompt();
    expect(result).toContain('AI agent executing a step');
    expect(result).toContain('Respond with a JSON object only');
  });

  it('includes schema JSON when schema is provided', () => {
    const schema = { required: ['answer', 'confidence'] };
    const result = buildSystemPrompt(schema);
    expect(result).toContain('AI agent executing a step');
    expect(result).toContain(JSON.stringify(schema));
  });

  it('prepends agent profile instructions before the base prompt', () => {
    const result = buildSystemPrompt(undefined, 'You are a ticket classifier.');
    expect(result).toMatch(/^You are a ticket classifier\./);
    expect(result).toContain('AI agent executing a step');
  });

  it('prepends agent profile and includes schema when both are provided', () => {
    const schema = { required: ['category'] };
    const result = buildSystemPrompt(schema, 'You are a ticket classifier.');
    expect(result).toMatch(/^You are a ticket classifier\./);
    expect(result).toContain('AI agent executing a step');
    expect(result).toContain(JSON.stringify(schema));
  });

  it('structuredToolOffered absent/false → byte-identical to the default (no schema)', () => {
    expect(buildSystemPrompt(undefined, undefined, false)).toBe(buildSystemPrompt());
    expect(buildSystemPrompt(undefined, undefined, undefined)).toBe(buildSystemPrompt());
  });

  it('structuredToolOffered absent/false → byte-identical to the default (with a schema)', () => {
    const schema = { required: ['category'] };
    expect(buildSystemPrompt(schema, 'profile', false)).toBe(buildSystemPrompt(schema, 'profile'));
  });

  it('structuredToolOffered: true mentions the __realm_submit__ tool, not the plain JSON-only line', () => {
    const result = buildSystemPrompt(undefined, undefined, true);
    expect(result).toContain('__realm_submit__');
    expect(result).toContain('AI agent executing a step');
    expect(result).not.toBe(buildSystemPrompt());
  });

  it('structuredToolOffered: true still prepends the agent profile and includes the schema', () => {
    const schema = { required: ['category'] };
    const result = buildSystemPrompt(schema, 'You are a ticket classifier.', true);
    expect(result).toMatch(/^You are a ticket classifier\./);
    expect(result).toContain('__realm_submit__');
    expect(result).toContain(JSON.stringify(schema));
  });
});

describe('manifest-secret redaction (setAdditionalRedactionValues)', () => {
  afterEach(() => {
    setAdditionalRedactionValues([]);
    vi.unstubAllEnvs();
  });

  it('a tool result echoing a manifest-bound secret is masked; empty list is a no-op', () => {
    const secret = 'manifest-secret-value-123';
    expect(serializeToolResult(`token is ${secret}`)).toContain(secret); // not set yet
    setAdditionalRedactionValues(Object.freeze([secret]));
    const out = serializeToolResult({ echoed: `token is ${secret}` });
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(secret);
    setAdditionalRedactionValues([]);
    expect(serializeToolResult(`token is ${secret}`)).toContain(secret); // no-op again
  });

  it('env redaction is unchanged (env values still masked without any additional values)', () => {
    vi.stubEnv('AGENT_UTILS_TEST_SECRET', 'env-secret-value-987');
    expect(sanitizeError('leak env-secret-value-987 here')).toBe('leak [REDACTED] here');
  });

  it('combined pass is LONGEST-FIRST: a short env value inside a longer manifest value leaves no fragments', () => {
    vi.stubEnv('AGENT_UTILS_SHORT', 'abcdef');
    setAdditionalRedactionValues(['abcdef-with-suffix-xyz']);
    const out = sanitizeError('value=abcdef-with-suffix-xyz end');
    expect(out).toBe('value=[REDACTED] end');
    expect(out).not.toContain('with-suffix');
  });
});

describe('extractJsonObject (mandate test 3 — the P1 robust extractor)', () => {
  it('plain JSON object (no fences/preamble) — same as the naive-parse fast path', () => {
    expect(extractJsonObject('{"result":"ok"}')).toEqual({ result: 'ok' });
  });

  it('braces inside a string value do not terminate the object early', () => {
    expect(extractJsonObject('{"a":"}"}')).toEqual({ a: '}' });
  });

  it('an escaped quote inside a string value does not terminate the string early', () => {
    // Runtime text: {"a":"\""}  — a value that is a single literal double-quote character.
    expect(extractJsonObject('{"a":"\\""}')).toEqual({ a: '"' });
  });

  it('an escaped backslash inside a string value is not mistaken for an escaped quote', () => {
    // Runtime text: {"a":"\\"}  — a value that is a single literal backslash character.
    expect(extractJsonObject('{"a":"\\\\"}')).toEqual({ a: '\\' });
  });

  it('strips a ```json fenced code block and parses its content', () => {
    const text = '```json\n{"result":"ok"}\n```';
    expect(extractJsonObject(text)).toEqual({ result: 'ok' });
  });

  it('strips a fenced code block with no language tag', () => {
    const text = '```\n{"result":"ok"}\n```';
    expect(extractJsonObject(text)).toEqual({ result: 'ok' });
  });

  it('finds the object past a preamble (no fences)', () => {
    expect(extractJsonObject('Sure, the result is: {"a":1}')).toEqual({ a: 1 });
  });

  it('finds the object before a postamble', () => {
    expect(extractJsonObject('{"a":1} — that is my final answer.')).toEqual({ a: 1 });
  });

  it('a top-level array is rejected (object-only)', () => {
    expect(extractJsonObject('[1,2,3]')).toBeNull();
  });

  it('prose with no braces at all returns null', () => {
    expect(extractJsonObject('I was unable to determine a final answer.')).toBeNull();
  });

  it('preamble-example-then-answer: prefers the LAST candidate, not the illustrative example', () => {
    const text = 'For example {"a":1}. Answer: {"b":2}';
    expect(extractJsonObject(text)).toEqual({ b: 2 });
  });

  it('preamble-example-then-answer inside a fenced block: still prefers the last candidate', () => {
    const text = '```json\nFor example {"a":1}. Answer: {"b":2}\n```';
    expect(extractJsonObject(text)).toEqual({ b: 2 });
  });

  it('falls back to the raw text when a fenced block contains no usable object', () => {
    const text = '```\nno object in here\n```\nBut the answer is {"c":3}';
    expect(extractJsonObject(text)).toEqual({ c: 3 });
  });
});

// =========================================================================
// issue #345 — classBError: the helper both providers mint through
//
// One helper rather than two hand-rolled copies, because two copies is how one of them drifts.
// These cells drive it directly; the provider files carry the end-to-end mint cells.
// =========================================================================
describe('classBError (issue #345)', () => {
  it('joins multiple text blocks with a newline', () => {
    // The separator is specified, not incidental: two providers mint through this, and a
    // different join would make the same failure read differently depending on which one ran.
    expect(
      classBError({
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
        isError: true,
      }),
    ).toBe('first\nsecond');
  });

  it('skips non-text blocks rather than stringifying them into the error', () => {
    expect(
      classBError({
        content: [
          { type: 'text', text: 'kept' },
          { type: 'image', data: 'x', mimeType: 'image/png' },
        ],
        isError: true,
      }),
    ).toBe('kept');
  });

  it('returns undefined for everything that is not a Class-B result', () => {
    expect(classBError({ content: [{ type: 'text', text: 'ok' }] })).toBeUndefined();
    expect(classBError({ isError: false, content: [] })).toBeUndefined();
    expect(classBError('a bare string result')).toBeUndefined();
    expect(classBError(null)).toBeUndefined();
    expect(classBError(undefined)).toBeUndefined();
    expect(classBError(42)).toBeUndefined();
  });

  it('tolerates a missing or non-array content field', () => {
    expect(classBError({ isError: true })).toBe(CLASS_B_NO_TEXT_MARKER);
    expect(classBError({ isError: true, content: 'not an array' })).toBe(CLASS_B_NO_TEXT_MARKER);
  });

  it('the marker fires on whitespace-only joined text, not just on the empty string', () => {
    // The case that caught a real defect in the first implementation: TWO empty blocks join to
    // '\n', which is length 1 — so a `length === 0` check passed it through and produced an
    // `error` that is truthy and visually nothing. Same invisible failure, different hat.
    expect(classBError({ content: [{ type: 'text', text: '' }], isError: true })).toBe(
      CLASS_B_NO_TEXT_MARKER,
    );
    expect(
      classBError({
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: '' },
        ],
        isError: true,
      }),
    ).toBe(CLASS_B_NO_TEXT_MARKER);
    expect(classBError({ content: [{ type: 'text', text: '   ' }], isError: true })).toBe(
      CLASS_B_NO_TEXT_MARKER,
    );
  });

  it('does NOT trim a real error — only the emptiness question is trimmed', () => {
    expect(
      classBError({ content: [{ type: 'text', text: '  real failure  ' }], isError: true }),
    ).toBe('  real failure  ');
  });
});
