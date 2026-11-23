// on-model-failure-key-g2iib2.test.ts — gap 2, unit (ii-b2), check 8: the step key
// `on_model_failure` at load.
//
// `on_model_failure: fail` lets an agent step fail when its model request fails, so the workflow's
// failure route runs. It decides what happens to a model request, so only an agent step can carry
// it; its one value is `fail` (`default` comes later). The loader refuses the key on any other kind
// of step with the registry's four-clause message, `default` with its own sentence, and any other
// value as `structured_output`'s value is refused. Every assertion carries (a) the break that turns
// it red and (b) what it prints.
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

const WORDS_7 =
  "'on_model_failure' is only valid on execution: agent steps — it decides what happens when the step's model request fails, and no other kind makes one, so here it would decide nothing. Move it to the agent step whose failure it should decide, or remove it. An auto step already fails after its handler's last try.";
const WORDS_8 =
  "Step 's': on_model_failure: 'default' is not available yet: only 'fail' is. With 'fail', a failed model request fails the step; without the key, the drive stops and the run stays open. Write 'fail', or remove the key. 'default' (complete the step with its default answer) comes in a later version.";

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
  ])('refused on a %s step with Words 7', (_kind, steps) => {
    const message = refusalOf(
      ['id: g2iib2-load', 'name: x', 'version: 1', 'steps:', ...steps, ''].join('\n'),
    );
    // (a) red when the kind refusal is removed (the file loads), or its message changes; (b)
    //     prints the loader's message.
    expect(message).toContain(`Step 's': ${WORDS_7}`);
  });

  it("'default' is refused with Words 8", () => {
    // (a) red when the 'default' sentence is removed or changed; (b) prints the message.
    expect(refusalOf(agentWith('default'))).toContain(WORDS_8);
  });

  it('any other value is refused as structured_output’s value is', () => {
    // (a) red when the value check is removed (the file loads); (b) prints the message.
    expect(refusalOf(agentWith('always'))).toContain(
      `Step 's': 'on_model_failure' must be the literal string 'fail' (got "always")`,
    );
  });
});
