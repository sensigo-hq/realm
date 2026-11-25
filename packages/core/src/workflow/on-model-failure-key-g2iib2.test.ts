// on-model-failure-key-g2iib2.test.ts — gap 2, unit (ii-b2), check 8: the step key
// `on_model_failure` at load.
//
// `on_model_failure: fail` lets an agent step fail when its model request fails, so the workflow's
// failure route runs. It decides what happens to a model request, so only an agent step can carry
// it; it takes `fail` or (gap 2, unit (iii)) `default`. The loader refuses the key on any other kind
// of step with the registry's four-clause message, `default` without its answer with Words 4, and
// any other value with Words 6. Every assertion carries (a) the break that turns it red and (b) what
// it prints.
import { describe, expect, it } from 'vitest';
import { loadWorkflowFromString } from './yaml-loader.js';

/** The loader's refusal of `yaml`, or `null` when it loads. */
function refusalOf(yaml: string): string | null {
  try {
    loadWorkflowFromString(yaml);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

// Words 7: on a guard or a finalizer it ends after "or remove it." (correction 1); an auto step's
// message adds its last sentence.
const WORDS_7_ELSEWHERE =
  "'on_model_failure' is only valid on execution: agent steps — it decides what happens when the step's model request fails, and no other kind makes one, so here it would decide nothing. Move it to the agent step whose failure it should decide, or remove it.";
const AUTO_TAIL = " An auto step already fails after its handler's last try.";
// Gap 2, unit (iii): 'default' arrived; without its answer it gets Words 4 (its own cells are in
// on-model-failure-default-g2iii.test.ts), and the (ii-b2) "not available yet" sentence is gone.
const WORDS_8_GONE = "on_model_failure: 'default' is not available yet";
const WORDS_4 =
  "Step 's': on_model_failure: 'default' requires 'validation_exhaustion.default_output' (the answer the step takes when its model request fails)";

const agentWith = (value: string) =>
  [
    'id: g2iib2-load',
    'name: g2iib2 load',
    'version: 1',
    'steps:',
    '  s:',
    '    description: Answer.',
    '    execution: agent',
    `    on_model_failure: ${value}`,
    '',
  ].join('\n');

describe('gap 2 (ii-b2), check 8 — on_model_failure at load', () => {
  it('an agent step with on_model_failure: fail loads, and the key is kept', () => {
    // (a) red when the key is refused on an agent step, or dropped; (b) prints the refusal or the step.
    expect(refusalOf(agentWith('fail'))).toBeNull();
    expect(loadWorkflowFromString(agentWith('fail')).steps['s']?.on_model_failure).toBe('fail');
  });

  it.each([
    [
      'auto',
      [
        '  s:',
        '    description: Do it.',
        '    execution: auto',
        '    handler: h',
        '    on_model_failure: fail',
      ],
    ],
    [
      'guard',
      [
        '  s:',
        '    description: Check.',
        '    execution: guard',
        '    abort_unless: run.params.ok == true',
        '    on_model_failure: fail',
      ],
    ],
    [
      'finalizer',
      [
        '  c:',
        '    description: Work.',
        '    execution: auto',
        '    handler: h',
        '  s:',
        '    description: Clean up.',
        '    execution: finalizer',
        '    handler: cleanup',
        '    on_outcome: fail',
        '    on_model_failure: fail',
      ],
    ],
  ])('refused on a %s step with Words 7', (kind, steps) => {
    const message = refusalOf(
      ['id: g2iib2-load', 'name: x', 'version: 1', 'steps:', ...steps, ''].join('\n'),
    );
    // (a) red when the kind refusal is removed (the file loads), or its message changes; (b)
    //     prints the loader's message.
    const tail = message?.slice(message.indexOf(WORDS_7_ELSEWHERE) + WORDS_7_ELSEWHERE.length);
    // (a) red when the guard's or finalizer's message keeps the auto step's last sentence, or the
    //     auto step's loses it; (b) prints the message and what follows the shared part.
    expect({
      shared: message?.includes(`Step 's': ${WORDS_7_ELSEWHERE}`),
      autoTail: tail?.startsWith(AUTO_TAIL),
    }).toEqual({ shared: true, autoTail: kind === 'auto' });
  });

  it("'default' without its answer gets Words 4 (unit (iii)), never the old sentence", () => {
    const got = refusalOf(agentWith('default'));
    // (a) red when the (ii-b2) refusal of 'default' is kept; (b) prints the message.
    expect({ words4: got?.includes(WORDS_4), old: got?.includes(WORDS_8_GONE) }, got ?? '').toEqual(
      {
        words4: true,
        old: false,
      },
    );
  });

  it('any other value is refused, naming both values (unit (iii), Words 6)', () => {
    // (a) red when the value check is removed (the file loads); (b) prints the message.
    expect(refusalOf(agentWith('always'))).toContain(
      `Step 's': 'on_model_failure' must be 'fail' or 'default' (got "always")`,
    );
  });
});
