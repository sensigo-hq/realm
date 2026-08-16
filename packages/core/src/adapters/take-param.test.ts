// take-param.test.ts — issue #287, the shared scalar-param reader.
//
// The semantics that matter most are the NULLISH ones. Unresolved optional input_map paths arrive
// as present-`undefined` as a matter of routine, and `$literal: null` is legal — so a helper that
// threw on nullish would break working workflows while every existing test stayed green. The
// throwing arm is deliberately narrow: present, non-nullish, wrong type.
import { describe, it, expect } from 'vitest';
import { takeParam } from './adapter-utils.js';
import { WorkflowError } from '../types/workflow-error.js';

const CTX = { adapter: 'airtable', operation: 'list_records' };

describe('takeParam (issue #287)', () => {
  it('present with the expected type ⇒ returns the typed value', () => {
    expect(takeParam({ a: 'x' }, 'a', 'string', CTX)).toBe('x');
    expect(takeParam({ a: 5 }, 'a', 'number', CTX)).toBe(5);
    expect(takeParam({ a: false }, 'a', 'boolean', CTX)).toBe(false);
  });

  it('ABSENT ⇒ undefined ("not set"), never a throw', () => {
    expect(takeParam({}, 'a', 'string', CTX)).toBeUndefined();
  });

  it('present-`undefined` ⇒ undefined, never a throw — an unresolved optional path lands here routinely', () => {
    expect(takeParam({ a: undefined }, 'a', 'string', CTX)).toBeUndefined();
  });

  it('present-`null` ⇒ undefined, never a throw — `$literal: null` is legal', () => {
    expect(takeParam({ a: null }, 'a', 'string', CTX)).toBeUndefined();
  });

  it('present but MISTYPED ⇒ throws ADAPTER_VALIDATION_FAILED naming adapter, operation, param, expected and found', () => {
    let caught: unknown;
    try {
      takeParam({ filter_by_formula: { $template: 'x' } }, 'filter_by_formula', 'string', CTX);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowError);
    const err = caught as WorkflowError;
    expect(err.code).toBe('ADAPTER_VALIDATION_FAILED');
    expect(err.agentAction).toBe('report_to_user');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe(
      "adapter 'airtable' operation 'list_records': param 'filter_by_formula' — expected string, found object",
    );
    expect(err.details).toMatchObject({
      adapter: 'airtable',
      operation: 'list_records',
      param: 'filter_by_formula',
      expected: 'string',
      found: 'object',
    });
  });

  it('the found-type is discriminated: array reports "array", not "object"', () => {
    expect(() => takeParam({ a: [1, 2] }, 'a', 'string', CTX)).toThrow('found array');
    expect(() => takeParam({ a: 5 }, 'a', 'string', CTX)).toThrow('found number');
    expect(() => takeParam({ a: 'x' }, 'a', 'number', CTX)).toThrow('found string');
    expect(() => takeParam({ a: true }, 'a', 'string', CTX)).toThrow('found boolean');
  });

  it('carries NO did-you-mean — a type error already names both types (the canon split)', () => {
    try {
      takeParam({ a: 5 }, 'a', 'string', CTX);
    } catch (err) {
      expect((err as Error).message).not.toContain('Did you mean');
    }
  });
});
