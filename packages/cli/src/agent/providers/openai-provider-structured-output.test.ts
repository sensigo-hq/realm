// openai-provider-structured-output.test.ts — issue #313, the WIRE half of OpenAI structured
// output: what `callStepWithMeta` puts on a Chat Completions request, and the status-keyed
// ladder that drops strict.
//
// The SELECTION half (which steps get strict, under which profile, and what evidence records)
// is pinned in run-agent-openai-output.test.ts. All tests mock the openai package.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai-provider.js';

const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

function jsonAnswer(obj: Record<string, unknown>) {
  return { choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) } }] };
}

/** The openai SDK's public APIError contract, as the shared duck-type reads it. */
function apiError(
  status: number,
  message: string,
  extra: { param?: string | null; code?: string | null } = {},
) {
  return Object.assign(new Error(message), { status, ...extra });
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category'],
  properties: { category: { type: 'string' } },
};

/** The request options as they reached the wire on call N. */
function wire(n = 0): Record<string, unknown> {
  return mockCreate.mock.calls[n]![0] as Record<string, unknown>;
}

describe('OpenAIProvider.callStepWithMeta — structured output (issue #313)', () => {
  beforeEach(() => mockCreate.mockReset());

  // -------------------------------------------------------------------------------------------
  // The strict wire body
  // -------------------------------------------------------------------------------------------
  it('sends response_format json_schema with the schema and strict TRUE, exactly', async () => {
    mockCreate.mockResolvedValueOnce(jsonAnswer({ category: 'billing' }));
    const provider = new OpenAIProvider('gpt-4o');

    const { output, meta } = await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
      structuredOutputStrict: true,
    });

    expect(wire(0)['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'realm_step_output', strict: true, schema: SCHEMA },
    });
    expect(output).toEqual({ category: 'billing' });
    // The success-path honesty cell: the override MUST report the meta itself. Returning only
    // `{output}` would let run-agent's synthesis rule mint a false `provider_unsupported` while
    // every wire assertion above still passed.
    expect(meta).toEqual({ requested: true, sent: true });
  });

  it('strict is ALWAYS explicit — never omitted (an omitted flag is silent non-enforcement, not a default)', async () => {
    mockCreate.mockResolvedValueOnce(jsonAnswer({ category: 'billing' }));
    const provider = new OpenAIProvider('gpt-4o');

    await provider.callStepWithMeta('prompt', SCHEMA, undefined, { structuredOutputStrict: true });

    const rf = wire(0)['response_format'] as { json_schema: Record<string, unknown> };
    expect(Object.keys(rf.json_schema)).toContain('strict');
    expect(rf.json_schema['strict']).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // The json_object rail — byte-identical for a non-strict call
  // -------------------------------------------------------------------------------------------
  it('a NON-strict call is byte-identical to callStep: json_object, no json_schema, no meta', async () => {
    mockCreate.mockResolvedValueOnce(jsonAnswer({ category: 'billing' }));
    const provider = new OpenAIProvider('gpt-4o');
    await provider.callStepWithMeta('prompt', SCHEMA, undefined, { structuredOutputStrict: false });
    const viaMeta = wire(0);

    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(jsonAnswer({ category: 'billing' }));
    await provider.callStep('prompt', SCHEMA, undefined);
    const viaCallStep = wire(0);

    expect(viaMeta).toEqual(viaCallStep);
    expect(viaMeta['response_format']).toEqual({ type: 'json_object' });
  });

  it('a compat endpoint sends no response_format at all on the non-strict path', async () => {
    mockCreate.mockResolvedValueOnce(jsonAnswer({ category: 'billing' }));
    const provider = new OpenAIProvider('gpt-4o', 'https://compat.example.com');
    await provider.callStepWithMeta('prompt', SCHEMA, undefined, { structuredOutputStrict: false });
    expect(wire(0)).not.toHaveProperty('response_format');
  });

  // -------------------------------------------------------------------------------------------
  // The ladder — 400 only
  // -------------------------------------------------------------------------------------------
  it('400 on a strict request: drops strict, retries ONCE, and records the verbatim message plus param/code', async () => {
    mockCreate
      .mockRejectedValueOnce(
        apiError(400, "In context=(), 'additionalProperties' is required to be supplied", {
          param: 'response_format',
          code: null,
        }),
      )
      .mockResolvedValueOnce(jsonAnswer({ category: 'billing' }));
    const provider = new OpenAIProvider('gpt-4o');

    const { output, meta } = await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
      structuredOutputStrict: true,
    });

    expect(output).toEqual({ category: 'billing' });
    expect(meta).toEqual({
      requested: true,
      sent: false,
      downgrade_reason: 'api_rejected_schema',
      api_message: "In context=(), 'additionalProperties' is required to be supplied",
      api_param: 'response_format',
      api_code: null, // null is MEANINGFUL and preserved — not dropped
    });
    // Exactly two calls: the strict one, then the unconstrained retry.
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(wire(0)['response_format']).toMatchObject({ type: 'json_schema' });
    expect(wire(1)['response_format']).toEqual({ type: 'json_object' });
  });

  it('the model-unsupported 400 class (param/code both null) is captured as-is — the label imprecision is on record, not hidden', async () => {
    mockCreate
      .mockRejectedValueOnce(
        apiError(400, "'response_format' of type 'json_schema' is not supported with this model", {
          param: null,
          code: null,
        }),
      )
      .mockResolvedValueOnce(jsonAnswer({ category: 'billing' }));
    const provider = new OpenAIProvider('gpt-4o');

    const { meta } = await provider.callStepWithMeta('prompt', SCHEMA, undefined, {
      structuredOutputStrict: true,
    });

    expect(meta?.api_param).toBeNull();
    expect(meta?.api_code).toBeNull();
    // api_message carries the truth the label cannot.
    expect(meta?.api_message).toContain('not supported with this model');
  });

  it('double-400: throws an error CARRYING the meta, so a no-result attempt can still arm sticky', async () => {
    mockCreate
      .mockRejectedValueOnce(apiError(400, 'first', { param: 'response_format' }))
      .mockRejectedValueOnce(apiError(400, 'second failure'));
    const provider = new OpenAIProvider('gpt-4o');

    await expect(
      provider.callStepWithMeta('prompt', SCHEMA, undefined, { structuredOutputStrict: true }),
    ).rejects.toMatchObject({
      message: 'second failure',
      structuredOutput: {
        requested: true,
        sent: false,
        downgrade_reason: 'api_rejected_schema',
        api_message: 'first',
      },
    });
  });

  it('5xx propagates untouched — never a drop, never a retry (the schema is not what failed)', async () => {
    mockCreate.mockRejectedValueOnce(apiError(503, 'service unavailable'));
    const provider = new OpenAIProvider('gpt-4o');

    await expect(
      provider.callStepWithMeta('prompt', SCHEMA, undefined, { structuredOutputStrict: true }),
    ).rejects.toThrow('service unavailable');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('a transport/timeout error (no status) propagates untouched — first-call schema-compile latency must never be recorded as a schema failure', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Request timed out'));
    const provider = new OpenAIProvider('gpt-4o');

    await expect(
      provider.callStepWithMeta('prompt', SCHEMA, undefined, { structuredOutputStrict: true }),
    ).rejects.toThrow('Request timed out');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------------------------
  // Refusal — an L1-class escape, not a transport failure
  // -------------------------------------------------------------------------------------------
  it('a refusal surfaces as an error for the existing validation/reask layer, not as a silent empty answer', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: null, refusal: 'I cannot comply.' } }],
    });
    const provider = new OpenAIProvider('gpt-4o');

    await expect(
      provider.callStepWithMeta('prompt', SCHEMA, undefined, { structuredOutputStrict: true }),
    ).rejects.toThrow('refused');
  });
});
