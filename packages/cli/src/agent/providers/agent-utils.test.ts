// agent-utils.test.ts — Tests for shared agent utility functions.
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildSystemPrompt,
  sanitizeError,
  serializeToolResult,
  setAdditionalRedactionValues,
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
