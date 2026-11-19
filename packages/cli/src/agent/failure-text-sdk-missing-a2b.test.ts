// Gap 1, unit A2b, check 11 — OpenAI strict's `sdk_missing` (thrown before that method's only `try`,
// CR-AUA2B-01) still carries the call's texts, empty: the drive-failure entry keeps `recorded: true`
// with no requests, never `provider_did_not_report`. Its own file, because the `openai` package must
// fail to load here.
//
// The cell names the break that turns it red (prompts/gap1-a2b-failed-drive-capture.md, check 11)
// and prints the entry's class and field.
import { describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './providers/openai-provider.js';
import { carriedTexts, failureModelTextOf, joinFailedCall } from './providers/model-text.js';
import { buildEntry } from './drive-failure.js';

vi.mock('openai', () => {
  throw new Error('the openai package is not installed (a fake for this cell)');
});

describe('gap 1, unit A2b — OpenAI strict’s sdk_missing', () => {
  it('check 11: the strict path’s sdk_missing carries empty texts, so its entry has recorded: true and no requests', async () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const err = await new OpenAIProvider('gpt-x')
      .callStepWithMeta('a prompt', schema, undefined, { structuredOutputStrict: true })
      .catch((e: unknown) => e);
    // The entry as the provider-call catch builds it (the provider was called).
    const entry = buildEntry(err, 'ask', 'openai', performance.now(), new Date());
    const carried = carriedTexts(err);
    // (1) red when the carrier is attached only inside the method's existing `try` (the error then
    //     carries nothing and the entry says the provider did not report); (2) prints both.
    expect({
      class: entry.error_class,
      carried,
      text: failureModelTextOf(
        carried !== undefined ? joinFailedCall(entry.usage ?? [], carried) : { reported: false },
        true,
      ),
    }).toEqual({
      class: 'sdk_missing',
      carried: { answered: [], unanswered: undefined },
      text: { recorded: true, messages: [], tools: [], requests: [] },
    });
  });
});
