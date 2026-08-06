// anthropic-provider-structured-output.test.ts — issue #236: callStepWithMeta, the strict
// wire-capture pin, the fallback ladder (400/503), and buildSystemPrompt byte-invariance.
// All tests mock the @anthropic-ai/sdk package — no real API calls are made. The five ladder-mock
// error bodies below are the CAPTURED texts (never invented) — canonical source:
// plans/issue-236/premise-probe-raw.md §"Full captured error bodies", byte-matched verbatim.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, StructuredOutputLadderError } from './anthropic-provider.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

function makeTextResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function makeToolUseResponse(input: Record<string, unknown>) {
  return {
    content: [{ type: 'tool_use' as const, id: 'submit1', name: '__realm_submit__', input }],
  };
}

// The five CAPTURED error bodies (premise-probe-raw.md §Full captured error bodies) — verbatim.
const CAPTURED_400_ADDITIONAL_PROPERTIES =
  "tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false";
const CAPTURED_400_OPTIONAL_CAP =
  'Schemas contains too many optional parameters (25), which would make grammar compilation ' +
  'inefficient. Reduce the number of optional parameters in your tool schemas (limit: 24).';
const CAPTURED_400_KEYWORD =
  "tools.0.custom: For 'integer' type, property 'minimum' is not supported";
const CAPTURED_400_CIRCULAR =
  'tools.0.custom: Invalid schema: Circular reference detected in schema definitions: node -> ' +
  'node. Self-referencing or mutually-referencing definitions are not supported.';
const CAPTURED_503_GRAMMAR = 'Grammar compilation is temporarily unavailable. Please try again.';

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category'],
  properties: { category: { type: 'string' } },
};

describe('AnthropicProvider.callStepWithMeta (issue #236)', () => {
  beforeEach(() => mockCreate.mockReset());

  describe('wire-capture (OPTIONS-OBJECT pin — R-N)', () => {
    it('carries strict: true on the submit tool when opted+eligible', async () => {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      const { output, meta } = await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
        structuredOutputStrict: true,
      });
      expect(output).toEqual({ category: 'billing' });
      expect(mockCreate.mock.calls[0]![0].tools[0]).toMatchObject({
        name: '__realm_submit__',
        strict: true,
      });
      expect(meta).toEqual({ requested: true, sent: true, submission_channel: 'tool' });
    });

    it('does NOT carry strict when not opted (structuredOutputStrict absent/false)', async () => {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      const { meta } = await provider.callStepWithMeta('prompt', SCHEMA);
      expect(mockCreate.mock.calls[0]![0].tools[0]).not.toHaveProperty('strict');
      expect(meta).toBeUndefined();
    });

    it('plain callStep (no meta variant) never sends strict, even with a schema present', async () => {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      await provider.callStep('prompt', SCHEMA);
      expect(mockCreate.mock.calls[0]![0].tools[0]).not.toHaveProperty('strict');
    });
  });

  describe('400 ladder — api_rejected_schema', () => {
    it('drops strict, retries ONCE, discloses api_rejected_schema with the verbatim api_message', async () => {
      mockCreate
        .mockRejectedValueOnce(httpError(400, CAPTURED_400_ADDITIONAL_PROPERTIES))
        .mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      const { output, meta } = await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
        structuredOutputStrict: true,
      });
      expect(output).toEqual({ category: 'billing' });
      expect(meta).toEqual({
        requested: true,
        sent: false,
        downgrade_reason: 'api_rejected_schema',
        api_message: CAPTURED_400_ADDITIONAL_PROPERTIES,
        submission_channel: 'tool',
      });
      expect(mockCreate).toHaveBeenCalledTimes(2);
      // Retry — strict dropped.
      expect(mockCreate.mock.calls[1]![0].tools[0]).not.toHaveProperty('strict');
    });

    it.each([
      ['optional-cap', CAPTURED_400_OPTIONAL_CAP],
      ['keyword', CAPTURED_400_KEYWORD],
      ['circular', CAPTURED_400_CIRCULAR],
    ])('the %s captured 400 body also drives the ladder identically', async (_label, body) => {
      mockCreate
        .mockRejectedValueOnce(httpError(400, body))
        .mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      const { meta } = await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
        structuredOutputStrict: true,
      });
      expect(meta?.downgrade_reason).toBe('api_rejected_schema');
      expect(meta?.api_message).toBe(body);
    });

    it('a ladder failure (the drop-strict retry ALSO fails) throws StructuredOutputLadderError carrying meta + cause + the retry error message', async () => {
      const retryError = new Error('network blip on retry');
      mockCreate
        .mockRejectedValueOnce(httpError(400, CAPTURED_400_ADDITIONAL_PROPERTIES))
        .mockRejectedValueOnce(retryError);
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      await expect(
        provider.callStepWithMeta('prompt', SCHEMA, undefined, {
          structuredOutputStrict: true,
        }),
      ).rejects.toThrow(StructuredOutputLadderError);

      mockCreate.mockReset();
      mockCreate
        .mockRejectedValueOnce(httpError(400, CAPTURED_400_ADDITIONAL_PROPERTIES))
        .mockRejectedValueOnce(retryError);
      try {
        await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
          structuredOutputStrict: true,
        });
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(StructuredOutputLadderError);
        const ladderErr = err as StructuredOutputLadderError;
        expect(ladderErr.message).toBe('network blip on retry'); // adopts the ORIGINAL (retry) message
        expect(ladderErr.cause).toBe(retryError);
        expect(ladderErr.structuredOutput).toEqual({
          requested: true,
          sent: false,
          downgrade_reason: 'api_rejected_schema',
          api_message: CAPTURED_400_ADDITIONAL_PROPERTIES,
        });
      }
    });
  });

  describe('503 ladder — label MATCH vs fallback', () => {
    it('grammar-compilation-unavailable MATCH ⇒ grammar_unavailable', async () => {
      mockCreate
        .mockRejectedValueOnce(httpError(503, CAPTURED_503_GRAMMAR))
        .mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      const { meta } = await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
        structuredOutputStrict: true,
      });
      expect(meta?.downgrade_reason).toBe('grammar_unavailable');
      expect(meta?.api_message).toBe(CAPTURED_503_GRAMMAR);
    });

    it('a non-matching 503 message ⇒ service_unavailable (the fail-safe fallback label) — independence: the match test above still passes unaffected', async () => {
      mockCreate
        .mockRejectedValueOnce(httpError(503, 'Internal server error, please retry.'))
        .mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      const { meta } = await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
        structuredOutputStrict: true,
      });
      expect(meta?.downgrade_reason).toBe('service_unavailable');
    });

    it('NO provider-side retry on 503 before the drop-strict recovery attempt — exactly 2 calls total', async () => {
      mockCreate
        .mockRejectedValueOnce(httpError(503, CAPTURED_503_GRAMMAR))
        .mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
        structuredOutputStrict: true,
      });
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe('the ladder arm keys on status, never on message text', () => {
    it('a non-400/503 error on a strict-carrying request propagates untouched (no ladder engagement)', async () => {
      const genuine = httpError(401, 'invalid api key');
      mockCreate.mockRejectedValueOnce(genuine);
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      await expect(
        provider.callStepWithMeta('prompt', SCHEMA, undefined, {
          structuredOutputStrict: true,
        }),
      ).rejects.toBe(genuine);
      expect(mockCreate).toHaveBeenCalledTimes(1); // no retry attempted
    });

    it('a 400 with NO strict sent at all propagates untouched (arm keys on strict-sent too)', async () => {
      mockCreate.mockRejectedValueOnce(httpError(400, 'some unrelated 400'));
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      // structuredOutputStrict absent — never opted in — the ladder must never engage.
      await expect(provider.callStepWithMeta('prompt', SCHEMA)).rejects.toThrow(
        'some unrelated 400',
      );
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('sticky within one invocation', () => {
    it('once downgraded, the non-JSON-retry leg of the SAME invocation also goes out without strict', async () => {
      mockCreate
        .mockRejectedValueOnce(httpError(400, CAPTURED_400_ADDITIONAL_PROPERTIES)) // 1st attempt, strict
        .mockResolvedValueOnce(makeTextResponse('not json')) // drop-strict retry — non-JSON
        .mockResolvedValueOnce(makeTextResponse('{"category":"billing"}')); // non-JSON-retry leg
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      const { output, meta } = await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
        structuredOutputStrict: true,
      });
      expect(output).toEqual({ category: 'billing' });
      expect(mockCreate).toHaveBeenCalledTimes(3);
      // Neither the drop-strict retry NOR the subsequent non-JSON-retry leg ever re-carries strict.
      expect(mockCreate.mock.calls[1]![0].tools[0]).not.toHaveProperty('strict');
      expect(mockCreate.mock.calls[2]![0].tools[0]).not.toHaveProperty('strict');
      expect(meta?.sent).toBe(false);
      expect(meta?.downgrade_reason).toBe('api_rejected_schema');
    });
  });

  describe('submission_channel — the dodge detector', () => {
    it('"tool" when the model used the submit tool', async () => {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      const { meta } = await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
        structuredOutputStrict: true,
      });
      expect(meta?.submission_channel).toBe('tool');
    });

    it('"text" when the model answered in text (extracted via the P1 fallback)', async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse('{"category":"billing"}'));
      const provider = new AnthropicProvider('claude-sonnet-4-5');
      const { meta } = await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
        structuredOutputStrict: true,
      });
      expect(meta?.submission_channel).toBe('text');
    });
  });

  describe('buildSystemPrompt byte-invariance under strict (design §4, the O8 honesty mechanism)', () => {
    it('the system prompt sent is IDENTICAL whether strict is on or off, for the same inputs', async () => {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
      const providerStrict = new AnthropicProvider('claude-sonnet-4-5');
      await providerStrict.callStepWithMeta('prompt', SCHEMA, undefined, {
        structuredOutputStrict: true,
      });
      const strictSystemPrompt = mockCreate.mock.calls[0]![0].system;

      mockCreate.mockReset();
      mockCreate.mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
      const providerPlain = new AnthropicProvider('claude-sonnet-4-5');
      await providerPlain.callStep('prompt', SCHEMA);
      const plainSystemPrompt = mockCreate.mock.calls[0]![0].system;

      expect(strictSystemPrompt).toBe(plainSystemPrompt);
    });
  });
});
