import { describe, it, expect } from 'vitest';
import { ValidateFieldMatchHandler } from './validate-field-match.js';
import type { StepContext } from '../extensions/step-handler.js';

const handler = new ValidateFieldMatchHandler();

function makeContext(config: Record<string, unknown>, fieldValue?: unknown): StepContext {
  return {
    run_id: 'test-run',
    run_params: {},
    config,
    // issue #337: `resources` is `Record<...>|undefined` optional (no `| undefined` in its own
    // type) — under exactOptionalPropertyTypes, explicitly assigning `undefined` is a type error
    // distinct from omitting the key. Conditional spread omits it entirely when fieldValue is
    // undefined, matching the #293 precedent — `ctx.resources` reads as `undefined` either way.
    ...(fieldValue !== undefined ? { resources: { some_step: { some_field: fieldValue } } } : {}),
  };
}

function makeDefaultCtx(value: string, modeOverride?: string): StepContext {
  const config: Record<string, unknown> = {
    source_step: 'some_step',
    source_field: 'some_field',
    pattern: 'expected',
  };
  if (modeOverride !== undefined) config.mode = modeOverride;
  return makeContext(config, value);
}

describe('ValidateFieldMatchHandler', () => {
  describe('identity', () => {
    it('has id "validate_field_match"', () => {
      expect(handler.id).toBe('validate_field_match');
    });
  });

  describe('config validation', () => {
    it('throws when config.source_step is missing', async () => {
      const ctx = makeContext({ source_field: 'f', pattern: 'p' });
      await expect(handler.execute({ params: {} }, ctx)).rejects.toThrow(
        'config.source_step is required and must be a string',
      );
    });

    it('throws when config.source_step is not a string', async () => {
      const ctx = makeContext({ source_step: 42, source_field: 'f', pattern: 'p' });
      await expect(handler.execute({ params: {} }, ctx)).rejects.toThrow(
        'config.source_step is required and must be a string',
      );
    });

    it('throws when config.source_field is missing', async () => {
      const ctx = makeContext({ source_step: 's', pattern: 'p' });
      await expect(handler.execute({ params: {} }, ctx)).rejects.toThrow(
        'config.source_field is required and must be a string',
      );
    });

    it('throws when config.source_field is not a string', async () => {
      const ctx = makeContext({ source_step: 's', source_field: true, pattern: 'p' });
      await expect(handler.execute({ params: {} }, ctx)).rejects.toThrow(
        'config.source_field is required and must be a string',
      );
    });

    it('throws when config.pattern is missing', async () => {
      const ctx = makeContext({ source_step: 's', source_field: 'f' });
      await expect(handler.execute({ params: {} }, ctx)).rejects.toThrow(
        'config.pattern is required and must be a string',
      );
    });

    it('throws when config.pattern is not a string', async () => {
      const ctx = makeContext({ source_step: 's', source_field: 'f', pattern: [] });
      await expect(handler.execute({ params: {} }, ctx)).rejects.toThrow(
        'config.pattern is required and must be a string',
      );
    });

    it('throws when config.mode is an unrecognised value', async () => {
      const ctx = makeContext(
        { source_step: 'some_step', source_field: 'some_field', pattern: 'p', mode: 'fuzzy' },
        'hello',
      );
      await expect(handler.execute({ params: {} }, ctx)).rejects.toThrow(
        'config.mode must be "exact", "prefix", or "regex"',
      );
    });

    it('throws when the resolved field value is missing from resources', async () => {
      const ctx: StepContext = {
        run_id: 'r',
        run_params: {},
        config: { source_step: 'missing_step', source_field: 'f', pattern: 'p' },
        resources: { some_step: { some_field: 'hello' } },
      };
      await expect(handler.execute({ params: {} }, ctx)).rejects.toThrow(
        'field value is missing or not a string',
      );
    });

    it('throws when the resolved field value is not a string', async () => {
      const ctx = makeContext(
        { source_step: 'some_step', source_field: 'some_field', pattern: 'p' },
        12345,
      );
      await expect(handler.execute({ params: {} }, ctx)).rejects.toThrow(
        'field value is missing or not a string',
      );
    });
  });

  describe('exact mode (default)', () => {
    it('returns matched: true when value equals pattern exactly', async () => {
      const ctx = makeDefaultCtx('expected');
      const result = await handler.execute({ params: {} }, ctx);
      expect(result.data!.matched).toBe(true);
    });

    it('returns matched: false when value does not equal pattern', async () => {
      const ctx = makeDefaultCtx('not-expected');
      const result = await handler.execute({ params: {} }, ctx);
      expect(result.data!.matched).toBe(false);
    });

    it('defaults to exact mode when config.mode is absent', async () => {
      const ctx = makeDefaultCtx('expected');
      const result = await handler.execute({ params: {} }, ctx);
      expect(result.data!.mode).toBe('exact');
    });

    it('is case-sensitive', async () => {
      const ctx = makeDefaultCtx('Expected');
      const result = await handler.execute({ params: {} }, ctx);
      expect(result.data!.matched).toBe(false);
    });
  });

  describe('prefix mode', () => {
    it('returns matched: true when value starts with pattern', async () => {
      const ctx: StepContext = {
        run_id: 'r',
        run_params: {},
        config: {
          source_step: 'some_step',
          source_field: 'some_field',
          pattern: 'hello',
          mode: 'prefix',
        },
        resources: { some_step: { some_field: 'hello world' } },
      };
      const result = await handler.execute({ params: {} }, ctx);
      expect(result.data!.matched).toBe(true);
    });

    it('returns matched: false when value does not start with pattern', async () => {
      const ctx: StepContext = {
        run_id: 'r',
        run_params: {},
        config: {
          source_step: 'some_step',
          source_field: 'some_field',
          pattern: 'world',
          mode: 'prefix',
        },
        resources: { some_step: { some_field: 'hello world' } },
      };
      const result = await handler.execute({ params: {} }, ctx);
      expect(result.data!.matched).toBe(false);
    });
  });

  describe('regex mode', () => {
    it('returns matched: true when value matches the regex pattern', async () => {
      const ctx: StepContext = {
        run_id: 'r',
        run_params: {},
        config: {
          source_step: 'some_step',
          source_field: 'some_field',
          pattern: '^\\d+$',
          mode: 'regex',
        },
        resources: { some_step: { some_field: '12345' } },
      };
      const result = await handler.execute({ params: {} }, ctx);
      expect(result.data!.matched).toBe(true);
    });

    it('returns matched: false when value does not match the regex pattern', async () => {
      const ctx: StepContext = {
        run_id: 'r',
        run_params: {},
        config: {
          source_step: 'some_step',
          source_field: 'some_field',
          pattern: '^\\d+$',
          mode: 'regex',
        },
        resources: { some_step: { some_field: 'hello' } },
      };
      const result = await handler.execute({ params: {} }, ctx);
      expect(result.data!.matched).toBe(false);
    });

    it('returns matched: false (not throws) when pattern is not a valid regex', async () => {
      const ctx: StepContext = {
        run_id: 'r',
        run_params: {},
        config: {
          source_step: 'some_step',
          source_field: 'some_field',
          pattern: '[invalid',
          mode: 'regex',
        },
        resources: { some_step: { some_field: 'hello' } },
      };
      const result = await handler.execute({ params: {} }, ctx);
      expect(result.data!.matched).toBe(false);
    });
  });

  describe('output shape', () => {
    it('data includes value, pattern, and mode', async () => {
      const ctx: StepContext = {
        run_id: 'r',
        run_params: {},
        config: {
          source_step: 'some_step',
          source_field: 'some_field',
          pattern: 'hello',
          mode: 'prefix',
        },
        resources: { some_step: { some_field: 'hello world' } },
      };
      const result = await handler.execute({ params: {} }, ctx);
      expect(result.data!.value).toBe('hello world');
      expect(result.data!.pattern).toBe('hello');
      expect(result.data!.mode).toBe('prefix');
    });

    it('data.mode reflects the resolved mode (i.e. "exact" when defaulted)', async () => {
      const ctx = makeDefaultCtx('expected');
      const result = await handler.execute({ params: {} }, ctx);
      expect(result.data!.mode).toBe('exact');
    });
  });
});
