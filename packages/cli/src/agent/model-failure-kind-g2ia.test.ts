// model-failure-kind-g2ia.test.ts — gap 2, unit (i-a): core's `classifyModelFailure`, fed the values
// Realm reads off real SDK errors. Each provider error is built with its SDK's own error class at the
// locked versions (@anthropic-ai/sdk 0.137.0, openai 6.48.0; `APIError.generate` returns the status's
// subclass: `RateLimitError`, `NotFoundError`, …), and read as the CLI reads it today:
// `classifyDriveError` for the class and status, `apiErrorParts` for Anthropic's `error.type`,
// `extractApiErrorFields` for OpenAI's `error.code`, `workspaceRefusal` for a workspace refusal, and
// the error's `headers` for `x-should-retry`, as unit (i-b)'s reader will. OpenAI's `error.type` is
// read off the error itself: no extractor reads it today. Fake keys and messages only.
//
// One cell or more per rule of Behaviour 3, named by its rule; every cell carries the break that
// turns it red (a rule dropped, or moved past another) and prints the facts it gave and the kind.
//
// Provider docs behind the fakes (read 2026-11-20, quoted in the unit's record):
// - Anthropic, https://platform.claude.com/docs/en/api/errors: the body is
//   `{"type":"error","error":{"type":…,"message":…}}`; "400 - invalid_request_error", "401 -
//   authentication_error", "402 - billing_error: There's an issue with your billing or payment
//   information", "403 - permission_error", "404 - not_found_error", "409 - conflict_error", "413 -
//   request_too_large", "429 - rate_limit_error", "500 - api_error", "504 - timeout_error", "529 -
//   overloaded_error".
// - OpenAI, https://developers.openai.com/api/docs/guides/error-codes: the 429 codes
//   `credit_balance_exhausted` ("Your organization has no prepaid credits remaining."),
//   `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`,
//   `organization_usage_limit_exceeded`, and `slow_down` (type `rate_limit_error`); "The broader
//   `error.type` can still be `insufficient_quota`".
import { describe, it, expect } from 'vitest';
import {
  APIError as AnthropicAPIError,
  APIConnectionError,
  APIConnectionTimeoutError,
} from '@anthropic-ai/sdk';
import { APIError as OpenAIAPIError } from 'openai';
import {
  classifyModelFailure,
  WorkflowError,
  type ModelFailureFacts,
  type ModelFailureKind,
} from '@sensigo/realm';
import { classifyDriveError } from './drive-failure.js';
import { apiErrorParts, workspaceRefusal } from './providers/anthropic-provider.js';
import { extractApiErrorFields } from './providers/agent-utils.js';

type Phase = ModelFailureFacts['phase'];

function headers(shouldRetry?: 'true' | 'false'): Headers {
  return new Headers({
    'request-id': 'req_fake_g2ia',
    ...(shouldRetry !== undefined ? { 'x-should-retry': shouldRetry } : {}),
  });
}

/** An Anthropic API error, as the SDK builds it from an answer's status, body and headers. */
function anthropicError(
  status: number,
  type: string,
  message: string,
  shouldRetry?: 'true' | 'false',
): unknown {
  return AnthropicAPIError.generate(
    status,
    { type: 'error', error: { type, message } },
    undefined,
    headers(shouldRetry),
  );
}

/** An OpenAI API error, as the SDK builds it from an answer's status, body and headers. */
function openaiError(
  status: number,
  error: { type: string; code: string | null; message: string },
  shouldRetry?: 'true' | 'false',
): unknown {
  return OpenAIAPIError.generate(
    status,
    { error: { ...error, param: null } },
    undefined,
    headers(shouldRetry),
  );
}

function headerOf(err: unknown): string | null {
  const h = (err as { headers?: unknown } | null)?.headers;
  return h instanceof Headers ? h.get('x-should-retry') : null;
}

function realmCodeOf(err: unknown): string | null {
  return err instanceof WorkflowError ? err.code : null;
}

/** The facts of a failure thrown by Anthropic's provider (or before it), read as the CLI reads them. */
function anthropicFacts(err: unknown, phase: Phase = 'model_request'): ModelFailureFacts {
  const { error_class, last_observed_status } = classifyDriveError(err);
  const { type } = apiErrorParts(err);
  return {
    error_class,
    status: last_observed_status ?? null,
    provider_error_type: typeof type === 'string' ? type : null,
    provider_error_code: null,
    should_retry: headerOf(err),
    workspace_refusal: workspaceRefusal(err, false) !== undefined,
    realm_code: realmCodeOf(err),
    phase,
  };
}

/** The facts of a failure thrown by an OpenAI-shaped provider, read as the CLI reads them. */
function openaiFacts(err: unknown, phase: Phase = 'model_request'): ModelFailureFacts {
  const { error_class, last_observed_status } = classifyDriveError(err);
  const { api_code } = extractApiErrorFields(err);
  const type = (err as { type?: unknown } | null)?.type;
  return {
    error_class,
    status: last_observed_status ?? null,
    provider_error_type: typeof type === 'string' ? type : null,
    provider_error_code: api_code ?? null,
    should_retry: headerOf(err),
    workspace_refusal: false,
    realm_code: realmCodeOf(err),
    phase,
  };
}

function kindIs(facts: ModelFailureFacts, want: ModelFailureKind | null): void {
  // (b) prints the facts and the kind they gave.
  expect({ facts, kind: classifyModelFailure(facts) }).toEqual({ facts, kind: want });
}

const mcpRefusal = (code: 'MCP_TOOL_NOT_FOUND' | 'MCP_TOOL_NAME_COLLISION') =>
  new WorkflowError(`the step names a tool the server does not offer (fake)`, {
    code,
    category: 'ENGINE',
    agentAction: 'stop',
    retryable: false,
  });

describe('gap 2, unit (i-a) — classifyModelFailure on real SDK errors, rule by rule', () => {
  describe('rule 1: an MCP tool refusal is setup, in any phase', () => {
    it('MCP_TOOL_NOT_FOUND tagged mcp_discovery gives setup', () => {
      // (a) red when rule 1 is dropped, or comes after rule 2 (the phase rule gives null).
      kindIs(anthropicFacts(mcpRefusal('MCP_TOOL_NOT_FOUND'), 'mcp_discovery'), 'setup');
    });
    it('MCP_TOOL_NAME_COLLISION in model_request gives setup', () => {
      // (a) red when rule 1 is dropped (nothing else places it: null).
      kindIs(anthropicFacts(mcpRefusal('MCP_TOOL_NAME_COLLISION')), 'setup');
    });
  });

  it('rule 2: a connection error while listing MCP tools is not a model call (null)', () => {
    // (a) red when rule 2 is dropped (rule 8 gives transient).
    const err = new APIConnectionError({ message: 'Connection error.', cause: new Error('fake') });
    kindIs(anthropicFacts(err, 'mcp_discovery'), null);
  });

  describe('rule 3: an answer Realm could not use is permanent, whatever its shape, on all three providers', () => {
    it("Anthropic's ENGINE_STEP_FAILED (a max_tokens cut, a reply still not JSON)", () => {
      // (a) red when rule 3 is dropped (an `other` with ENGINE_STEP_FAILED places nowhere: null).
      const err = new WorkflowError('the reply was cut at max_tokens (fake)', {
        code: 'ENGINE_STEP_FAILED',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
      });
      kindIs(anthropicFacts(err, 'after_response'), 'permanent');
    });
    it("OpenAI's plain Error for a reply still not JSON after the JSON retry", () => {
      // (a) red when rule 3 is dropped (null).
      kindIs(openaiFacts(new Error('reply is not JSON (fake)'), 'after_response'), 'permanent');
    });
    it("the reasoning provider's plain Error for a final extraction with no usable object", () => {
      // (a) red when rule 3 is dropped (null).
      kindIs(
        openaiFacts(new Error('no object in the answer (fake)'), 'after_response'),
        'permanent',
      );
    });
    it('an after_response failure that carries a 503 and x-should-retry: true is still permanent', () => {
      // (a) red when rule 3 comes after rule 5 or rule 8 (transient).
      kindIs(
        anthropicFacts(anthropicError(503, 'api_error', 'fake', 'true'), 'after_response'),
        'permanent',
      );
    });
  });

  it('rule 4: validation_rejected stays on the schema-retry path (null), even with x-should-retry: true and a 429', () => {
    // (a) red when rule 4 is dropped, or comes after rule 5 (transient).
    kindIs(
      {
        error_class: 'validation_rejected',
        status: 429,
        should_retry: 'true',
        phase: 'model_request',
      },
      null,
    );
  });

  describe('rule 5: x-should-retry: true is transient at any status', () => {
    it('a 404 with x-should-retry: true gives transient', () => {
      // (a) red when rule 5 is dropped, or comes after rule 6 (setup).
      kindIs(anthropicFacts(anthropicError(404, 'not_found_error', 'fake', 'true')), 'transient');
    });
    it('an OpenAI 400 with x-should-retry: true gives transient', () => {
      // (a) red when rule 5 is dropped (rule 9 gives permanent).
      kindIs(
        openaiFacts(
          openaiError(400, { type: 'invalid_request_error', code: null, message: 'fake' }, 'true'),
        ),
        'transient',
      );
    });
  });

  describe('rule 6: an operator must fix something first (setup)', () => {
    for (const [status, type] of [
      [401, 'authentication_error'],
      [403, 'permission_error'],
      [404, 'not_found_error'],
    ] as const) {
      it(`Anthropic ${status} ${type}`, () => {
        // (a) red when rule 6 is dropped (rule 10 gives null).
        kindIs(anthropicFacts(anthropicError(status, type, 'fake')), 'setup');
      });
    }
    it('Anthropic 402 billing_error (the documented credit-out)', () => {
      // (a) red when rule 6 is dropped (null).
      kindIs(anthropicFacts(anthropicError(402, 'billing_error', 'fake')), 'setup');
    });
    it('the type billing_error alone, on a 400, gives setup', () => {
      // (a) red when the type set loses billing_error (rule 9 gives permanent).
      kindIs(anthropicFacts(anthropicError(400, 'billing_error', 'fake')), 'setup');
    });
    it("Anthropic's workspace refusal (a 400 naming anthropic-workspace-id), even with x-should-retry: false", () => {
      // (a) red when rule 6 is dropped, or comes after rule 7 (permanent).
      const err = anthropicError(
        400,
        'invalid_request_error',
        'anthropic-workspace-id header is required for this key (fake)',
        'false',
      );
      expect(workspaceRefusal(err, false), 'fixture: the CLI reads it as a refusal').toBe(
        'missing',
      );
      kindIs(anthropicFacts(err), 'setup');
    });
    it('a missing SDK (class sdk_missing)', () => {
      // (a) red when rule 6 is dropped (null).
      kindIs({ error_class: 'sdk_missing', phase: 'model_request' }, 'setup');
    });
    it('a 429 with insufficient_quota gives setup', () => {
      // (a) red when rule 6 is dropped, or comes after rule 8 (transient).
      kindIs(
        openaiFacts(
          openaiError(429, {
            type: 'insufficient_quota',
            code: 'insufficient_quota',
            message: 'fake',
          }),
        ),
        'setup',
      );
    });
    for (const code of [
      'credit_balance_exhausted',
      'organization_spend_limit_exceeded',
      'project_spend_limit_exceeded',
      'organization_usage_limit_exceeded',
    ]) {
      it(`an OpenAI 429 with the code ${code} (Amendment 1)`, () => {
        // (a) red when the code set loses ${code} (rule 8 gives transient).
        kindIs(
          openaiFacts(openaiError(429, { type: 'rate_limit_error', code, message: 'fake' })),
          'setup',
        );
      });
    }
    it('an OpenAI 429 whose type is insufficient_quota, with no code (Amendment 1)', () => {
      // (a) red when the type set loses insufficient_quota (rule 8 gives transient).
      kindIs(
        openaiFacts(openaiError(429, { type: 'insufficient_quota', code: null, message: 'fake' })),
        'setup',
      );
    });
    it("OpenAI's slow_down 429 (type rate_limit_error) stays transient (Amendment 1)", () => {
      // (a) red when slow_down or rate_limit_error joins the used-up sets (setup).
      kindIs(
        openaiFacts(
          openaiError(429, { type: 'rate_limit_error', code: 'slow_down', message: 'fake' }),
        ),
        'transient',
      );
    });
    it("Anthropic's credit-out answered as a 400 invalid_request_error carries neither, and is permanent", () => {
      // (a) red when rule 6 reads the message, or 400 joins its statuses (setup).
      const err = anthropicError(
        400,
        'invalid_request_error',
        'Your credit balance is too low to access the Anthropic API (fake)',
      );
      kindIs(anthropicFacts(err), 'permanent');
    });
  });

  describe('rule 7: x-should-retry: false is permanent at any status', () => {
    it('a 503 with x-should-retry: false gives permanent', () => {
      // (a) red when rule 7 is dropped, or comes after rule 8 (transient).
      kindIs(anthropicFacts(anthropicError(503, 'api_error', 'fake', 'false')), 'permanent');
    });
    it('an OpenAI 429 rate_limit_error with x-should-retry: false gives permanent', () => {
      // (a) red when rule 7 is dropped (transient).
      kindIs(
        openaiFacts(
          openaiError(429, { type: 'rate_limit_error', code: null, message: 'fake' }, 'false'),
        ),
        'permanent',
      );
    });
  });

  describe('rule 8: another try can fix it (transient)', () => {
    for (const [status, type] of [
      [408, 'timeout_error'],
      [409, 'conflict_error'],
      [429, 'rate_limit_error'],
      [500, 'api_error'],
      [504, 'timeout_error'],
      [529, 'overloaded_error'],
    ] as const) {
      it(`Anthropic ${status} ${type}`, () => {
        // (a) red when rule 8 is dropped (null).
        kindIs(anthropicFacts(anthropicError(status, type, 'fake')), 'transient');
      });
    }
    it('a 503 in phase model_request on a later request (a tool turn) gives transient', () => {
      // (a) red when rule 8 is dropped, or the phase rule reads only a step's first request.
      kindIs(
        anthropicFacts(anthropicError(503, 'api_error', 'fake'), 'model_request'),
        'transient',
      );
    });
    it('a lost connection (APIConnectionError)', () => {
      // (a) red when connection_error leaves rule 8's classes (null).
      const err = new APIConnectionError({
        message: 'Connection error.',
        cause: new Error('fake'),
      });
      kindIs(anthropicFacts(err), 'transient');
    });
    it("the SDK's request timeout (APIConnectionTimeoutError)", () => {
      // (a) red when connection_timeout leaves rule 8's classes (null).
      kindIs(anthropicFacts(new APIConnectionTimeoutError({ message: 'fake' })), 'transient');
    });
    it("Realm's cap on the call (aborted_by_budget)", () => {
      // (a) red when aborted_by_budget leaves rule 8's classes (null).
      kindIs({ error_class: 'aborted_by_budget', phase: 'model_request' }, 'transient');
    });
  });

  describe('rule 9: this request will fail the same way again (permanent)', () => {
    for (const [status, type] of [
      [400, 'invalid_request_error'],
      [413, 'request_too_large'],
      [422, 'invalid_request_error'],
    ] as const) {
      it(`Anthropic ${status} ${type}`, () => {
        // (a) red when rule 9 is dropped (null).
        kindIs(anthropicFacts(anthropicError(status, type, 'fake')), 'permanent');
      });
    }
  });

  describe('rule 10: anything else is not placed (null)', () => {
    it('an `other` with no Realm code', () => {
      // (a) red when the last rule gives a kind instead of null.
      kindIs(anthropicFacts(new Error('something else (fake)')), null);
    });
    it('a bare TypeError', () => {
      // (a) red when the last rule gives a kind.
      kindIs(anthropicFacts(new TypeError('x is not a function (fake)')), null);
    });
    it("a module provider's throw with no values", () => {
      // (a) red when the last rule gives a kind.
      kindIs(anthropicFacts({}), null);
    });
    it('a status no rule names (405)', () => {
      // (a) red when the last rule gives a kind.
      kindIs(anthropicFacts(anthropicError(405, 'invalid_request_error', 'fake')), null);
    });
    it('a phase outside the three', () => {
      // (a) red when an unknown phase is read as model_request (transient).
      kindIs(
        {
          error_class: 'api_status',
          status: 503,
          phase: 'somewhere_else' as unknown as Phase,
        },
        null,
      );
    });
  });
});
