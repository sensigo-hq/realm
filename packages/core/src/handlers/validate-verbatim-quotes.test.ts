import { describe, it, expect } from 'vitest';
import { ValidateVerbatimQuotesHandler } from './validate-verbatim-quotes.js';
import type { StepContext } from '../extensions/step-handler.js';

const handler = new ValidateVerbatimQuotesHandler();

const SOURCE_TEXT = 'The quick brown fox jumps over the lazy dog and the cat sat on the mat.';

function makeContext(
  overrides: Partial<StepContext> & {
    source_step?: string;
    source_field?: string;
    quote_field?: string;
  } = {},
): StepContext {
  const { source_step = 'fetch_document', source_field, quote_field, ...rest } = overrides;
  const config: Record<string, unknown> = { source_step };
  if (source_field !== undefined) config.source_field = source_field;
  if (quote_field !== undefined) config.quote_field = quote_field;
  return {
    run_id: 'test-run',
    run_params: {},
    config,
    resources: {
      fetch_document: { text: SOURCE_TEXT },
    },
    ...rest,
  };
}

describe('ValidateVerbatimQuotesHandler', () => {
  describe('identity', () => {
    it('has id "validate_verbatim_quotes"', () => {
      expect(handler.id).toBe('validate_verbatim_quotes');
    });
  });

  describe('config validation', () => {
    it('throws when config.source_step is missing', async () => {
      const ctx: StepContext = { run_id: 'r', run_params: {}, config: {} };
      await expect(handler.execute({ params: { candidates: [] } }, ctx)).rejects.toThrow(
        'config.source_step is required and must be a string',
      );
    });

    it('throws when config.source_step is not a string', async () => {
      const ctx: StepContext = { run_id: 'r', run_params: {}, config: { source_step: 42 } };
      await expect(handler.execute({ params: { candidates: [] } }, ctx)).rejects.toThrow(
        'config.source_step is required and must be a string',
      );
    });

    it('throws when source text is missing from resources', async () => {
      const ctx: StepContext = {
        run_id: 'r',
        run_params: {},
        config: { source_step: 'missing_step' },
        resources: { fetch_document: { text: SOURCE_TEXT } },
      };
      await expect(handler.execute({ params: { candidates: [] } }, ctx)).rejects.toThrow(
        'source text is missing or not a string',
      );
    });

    it('throws when source text is not a string', async () => {
      const ctx: StepContext = {
        run_id: 'r',
        run_params: {},
        config: { source_step: 'fetch_document' },
        resources: { fetch_document: { text: 12345 } },
      };
      await expect(handler.execute({ params: { candidates: [] } }, ctx)).rejects.toThrow(
        'source text is missing or not a string',
      );
    });
  });

  describe('input validation', () => {
    it('throws when inputs.params.candidates is not an array', async () => {
      const ctx = makeContext();
      await expect(
        handler.execute({ params: { candidates: 'not an array' } }, ctx),
      ).rejects.toThrow('inputs.params.candidates must be an array');
    });
  });

  describe('happy path', () => {
    it('accepts candidates whose quotes appear in the source text', async () => {
      const ctx = makeContext();
      const result = await handler.execute(
        { params: { candidates: [{ verbatim_quote: 'quick brown fox', field_id: 'q1' }] } },
        ctx,
      );
      expect(result.data!.accepted_count).toBe(1);
      expect(result.data!.rejected_count).toBe(0);
    });

    it('rejects candidates whose quotes do not appear in the source text', async () => {
      const ctx = makeContext();
      const result = await handler.execute(
        { params: { candidates: [{ verbatim_quote: 'purple elephant', field_id: 'q1' }] } },
        ctx,
      );
      expect(result.data!.accepted_count).toBe(0);
      expect(result.data!.rejected_count).toBe(1);
    });

    it('returns candidates_found equal to total candidates checked', async () => {
      const ctx = makeContext();
      const result = await handler.execute(
        {
          params: {
            candidates: [
              { verbatim_quote: 'quick brown fox', field_id: 'q1' },
              { verbatim_quote: 'purple elephant', field_id: 'q2' },
            ],
          },
        },
        ctx,
      );
      expect(result.data!.candidates_found).toBe(2);
    });

    it('uses default source_field "text" when not configured', async () => {
      const ctx = makeContext();
      const result = await handler.execute(
        { params: { candidates: [{ verbatim_quote: 'lazy dog' }] } },
        ctx,
      );
      expect(result.data!.accepted_count).toBe(1);
    });

    it('uses default quote_field "verbatim_quote" when not configured', async () => {
      const ctx = makeContext();
      const result = await handler.execute(
        { params: { candidates: [{ verbatim_quote: 'cat sat on the mat' }] } },
        ctx,
      );
      expect(result.data!.accepted_count).toBe(1);
    });

    it('uses custom source_field and quote_field when configured', async () => {
      const ctx: StepContext = {
        run_id: 'r',
        run_params: {},
        config: { source_step: 'fetch_document', source_field: 'content', quote_field: 'excerpt' },
        resources: { fetch_document: { content: 'custom source document text here' } },
      };
      const result = await handler.execute(
        { params: { candidates: [{ excerpt: 'custom source' }] } },
        ctx,
      );
      expect(result.data!.accepted_count).toBe(1);
    });
  });

  describe('wiring diagnostics', () => {
    it('returns candidates_found === 0 when candidates array is empty', async () => {
      const ctx = makeContext();
      const result = await handler.execute({ params: { candidates: [] } }, ctx);
      expect(result.data!.candidates_found).toBe(0);
    });

    it('returns candidates_found === 0 when no candidate has the quote field', async () => {
      const ctx = makeContext();
      const result = await handler.execute(
        { params: { candidates: [{ field_id: 'q1', value: 'some text' }] } },
        ctx,
      );
      // walkField finds no objects with verbatim_quote, so walked is empty
      expect(result.data!.candidates_found).toBe(0);
    });
  });
});
