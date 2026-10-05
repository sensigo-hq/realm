// model-not-found-676.test.ts — issue #676: AnthropicProvider.explainFailure.
//
// Anthropic's 404 for a model it does not offer says only `model: <id>`. The provider recognises
// that one error from its own fields and returns one sentence; everything else gives undefined.
// The body below is the real one, captured on 2026-10-04 (#600 registry C12).
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';

const CAPTURED_BODY =
  '{"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-5"},"request_id":"req_011CfgzxrwYbWHkh1JH7p62o"}';

/** An error shaped as the SDK raises it: `status`, and `error` = the parsed body. */
function apiError(status: number, body: unknown): Error {
  return Object.assign(new Error(`${status} ${JSON.stringify(body)}`), { status, error: body });
}

const SENTENCE =
  'Anthropic offers no model named claude-sonnet-4-5 to this API key. Check the name given to --model; ' +
  'current models are listed at https://platform.claude.com/docs/en/models/overview and retired ones at ' +
  'https://platform.claude.com/docs/en/about-claude/model-deprecations.';

describe('AnthropicProvider.explainFailure (issue #676)', () => {
  const provider = new AnthropicProvider('claude-sonnet-4-5');

  it('the captured 404 body → the sentence, exactly', () => {
    expect(provider.explainFailure(apiError(404, JSON.parse(CAPTURED_BODY)))).toBe(SENTENCE);
  });

  // Controls: each is undefined. They are green before the change only because the method does
  // not exist there; after it, each pins one condition of the match.
  it('control: status 400 with the same body → undefined', () => {
    expect(provider.explainFailure(apiError(400, JSON.parse(CAPTURED_BODY)))).toBeUndefined();
  });

  it('control: 404 with another error.type → undefined', () => {
    const body = JSON.parse(CAPTURED_BODY) as { error: { type: string } };
    body.error.type = 'invalid_request_error';
    expect(provider.explainFailure(apiError(404, body))).toBeUndefined();
  });

  it('control: 404 not_found_error naming another model → undefined', () => {
    const body = JSON.parse(CAPTURED_BODY) as { error: { message: string } };
    body.error.message = 'model: claude-opus-9';
    expect(provider.explainFailure(apiError(404, body))).toBeUndefined();
  });

  it('control: 404 naming claude-sonnet-4-5-20250929 (the prefix case) → undefined', () => {
    const body = JSON.parse(CAPTURED_BODY) as { error: { message: string } };
    body.error.message = 'model: claude-sonnet-4-5-20250929';
    expect(provider.explainFailure(apiError(404, body))).toBeUndefined();
  });

  it("control: a plain Error('model: claude-sonnet-4-5') → undefined", () => {
    expect(provider.explainFailure(new Error('model: claude-sonnet-4-5'))).toBeUndefined();
  });

  it('control: null → undefined', () => {
    expect(provider.explainFailure(null)).toBeUndefined();
  });

  it('control: an object whose error getter throws → undefined', () => {
    const hostile = {
      status: 404,
      get error(): unknown {
        throw new Error('hostile getter');
      },
    };
    expect(provider.explainFailure(hostile)).toBeUndefined();
  });
});
