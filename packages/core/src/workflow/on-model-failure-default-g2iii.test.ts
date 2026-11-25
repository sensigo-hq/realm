// on-model-failure-default-g2iii.test.ts — gap 2, unit (iii), check 10: `on_model_failure: default`
// at load.
//
// `default` completes an agent step with `validation_exhaustion.default_output` when its model
// request fails for good. So the loader does for it everything it does for `default_output` under
// `validation_exhaustion.mode: default`: the answer is required (Words 4, with or without a
// `validation_exhaustion` block, and one refusal when `mode: default` is set too), the step needs
// `output_schema` and the answer must fit it, a path only the answer holds may be absent (never
// refused), and `default_output` is not dead config. Any other value is refused (Words 6); the key
// stays refused on `auto`, `guard` and `finalizer` steps. Every assertion carries (a) the break that
// turns it red and (b) what it prints.
import { describe, expect, it } from 'vitest';
import { loadWorkflowFromString, loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';

/** The loader's refusal of `yaml`, or `null` when it loads. */
function refusalOf(yaml: string): string | null {
  try {
    loadWorkflowFromString(yaml);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
/** The codes of the loader's warnings for `yaml` (it must load). */
const warningCodes = (yaml: string): string[] =>
  loadWorkflowFromStringWithDiagnostics(yaml).warnings.map((w) => w.code);
const count = (text: string | null, part: string): number =>
  text === null ? 0 : text.split(part).length - 1;

const WORDS_4 =
  "Step 's': on_model_failure: 'default' requires 'validation_exhaustion.default_output' (the answer the step takes when its model request fails)";
const WORDS_5 =
  "Step 's': 'validation_exhaustion.default_output' is ignored without 'mode: default' or 'on_model_failure: default' — set one of them to use it, or remove 'default_output'.";
const words6 = (got: string) =>
  `Step 's': 'on_model_failure' must be 'fail' or 'default' (got ${got})`;
const MODE_DEFAULT_REQUIRES = "'validation_exhaustion.mode: default' requires 'default_output'";
const NEEDS_SCHEMA =
  "Step 's': 'validation_exhaustion.default_output' requires the step to declare 'output_schema' (an undeclared schema makes the default unvalidatable)";
const DOES_NOT_FIT =
  "Step 's': 'validation_exhaustion.default_output' does not validate against the step's own 'output_schema'";

const SCHEMA_LINES = [
  '    output_schema:',
  '      type: object',
  '      required: [route]',
  '      properties:',
  '        route: { type: string }',
];
/** A workflow whose agent step `s` carries `lines` (indented four spaces). */
const workflow = (lines: string[]) =>
  [
    'id: g2iii-load',
    'name: g2iii load',
    'version: 1',
    'steps:',
    '  s:',
    '    description: Answer.',
    '    execution: agent',
    ...lines,
    '',
  ].join('\n');
const KEY = '    on_model_failure: default';
const ANSWER = ['    validation_exhaustion:', '      default_output: { route: human }'];

describe('gap 2 (iii), check 10 — on_model_failure: default at load', () => {
  it('loads on an agent step with its answer and output_schema, and the key is kept', () => {
    const yaml = workflow([KEY, ...SCHEMA_LINES, ...ANSWER]);
    // (a) red when 'default' is refused (the ii-b2 sentence); (b) prints the refusal or the key.
    expect({
      refusal: refusalOf(yaml),
      key: loadWorkflowFromString(yaml).steps['s']?.on_model_failure,
    }).toEqual({ refusal: null, key: 'default' });
  });

  it.each([
    ['no validation_exhaustion block', [KEY, ...SCHEMA_LINES]],
    [
      'a block without default_output',
      [KEY, ...SCHEMA_LINES, '    validation_exhaustion:', '      threshold: 2'],
    ],
  ])('without default_output (%s): Words 4', (_n, lines) => {
    const got = refusalOf(workflow(lines));
    // (a) red when Words 4 fires only inside the block (the no-block row loads), or only without
    //     one (the block row loads); (b) prints the refusal.
    expect({ words4: count(got, WORDS_4) }, got ?? '(it loaded)').toEqual({ words4: 1 });
  });

  it('without default_output, with mode: default too: one refusal, Words 4', () => {
    const got = refusalOf(
      workflow([KEY, ...SCHEMA_LINES, '    validation_exhaustion:', '      mode: default']),
    );
    // (a) red when #220's refusal is printed beside Words 4 (two for one cause); (b) prints it.
    expect(
      { words4: count(got, WORDS_4), modeRefusal: count(got, MODE_DEFAULT_REQUIRES) },
      got ?? '(it loaded)',
    ).toEqual({ words4: 1, modeRefusal: 0 });
  });

  it('with mode: default and no key: #220’s refusal, as before, and no Words 4', () => {
    const got = refusalOf(
      workflow([...SCHEMA_LINES, '    validation_exhaustion:', '      mode: default']),
    );
    // (a) red when the one-refusal rule drops #220's own refusal; (b) prints it.
    expect(
      { words4: count(got, WORDS_4), modeRefusal: count(got, MODE_DEFAULT_REQUIRES) },
      got ?? '(it loaded)',
    ).toEqual({ words4: 0, modeRefusal: 1 });
  });

  it('without output_schema (mode absent): the existing message', () => {
    const got = refusalOf(workflow([KEY, ...ANSWER]));
    // (a) red on the old `mode === 'default'`-only test (the step loads with an unchecked
    //     default); (b) prints the refusal.
    expect(count(got, NEEDS_SCHEMA), got ?? '(it loaded)').toBe(1);
  });

  it('a default_output that does not fit (mode absent): the existing message', () => {
    const got = refusalOf(
      workflow([
        KEY,
        ...SCHEMA_LINES,
        '    validation_exhaustion:',
        '      default_output: { route: 5 }',
      ]),
    );
    // (a) red on the old `mode === 'default'`-only test (it loads); (b) prints the refusal.
    expect(count(got, DOES_NOT_FIT), got ?? '(it loaded)').toBe(1);
  });

  it('no DEAD warning when the key reads default_output; Words 5 with neither trigger', () => {
    const withKey = warningCodes(workflow([KEY, ...SCHEMA_LINES, ...ANSWER]));
    const neither = loadWorkflowFromStringWithDiagnostics(workflow([...SCHEMA_LINES, ...ANSWER]))
      .warnings.filter((w) => w.code === 'DEAD_VALIDATION_EXHAUSTION_CONFIG')
      .map((w) => w.message);
    // (a) red when the DEAD rule ignores the key (it warns under the key too), or keeps the old
    //     sentence; (b) prints both.
    expect({ withKey: withKey.includes('DEAD_VALIDATION_EXHAUSTION_CONFIG'), neither }).toEqual({
      withKey: false,
      neither: [WORDS_5],
    });
  });

  it.each([
    ['retry', '"retry"'],
    ['true', 'true'],
  ])('any other value (%s): Words 6', (value, got) => {
    const refusal = refusalOf(workflow([`    on_model_failure: ${value}`]));
    // (a) red when the value check keeps the literal-'fail' sentence; (b) prints the refusal.
    expect(count(refusal, words6(got)), refusal ?? '(it loaded)').toBe(1);
  });

  it.each([
    ['auto', ['    execution: auto', '    handler: h']],
    ['guard', ['    execution: guard', "    abort_unless: ['true']"]],
    ['finalizer', ['    execution: finalizer', '    handler: h']],
  ])('refused on %s, with no Words 4', (_kind, lines) => {
    const yaml = [
      'id: g2iii-elsewhere',
      'name: g2iii elsewhere',
      'version: 1',
      'steps:',
      '  s:',
      '    description: Do it.',
      ...lines,
      '    on_model_failure: default',
      '',
    ].join('\n');
    const got = refusalOf(yaml);
    // (a) red when the key is admitted on a step that makes no model request, or Words 4 fires on
    //     it; (b) prints the refusal.
    expect(
      {
        refused: count(got, "'on_model_failure' is only valid on execution: agent steps"),
        words4: count(got, "requires 'validation_exhaustion.default_output'"),
      },
      got ?? '(it loaded)',
    ).toEqual({ refused: 1, words4: 0 });
  });
});

// ─── A path only the default answer holds ────────────────────────────────────────────────────────

/** `propose` answers a closed input_schema; `fallback_reason` is only in its output_schema and its
 *  default answer. `refund` reads it. */
const proposeAndRefund = (trigger: string, read: string[]) => `id: w
name: W
version: 1
steps:
  propose:
    description: propose
    execution: agent
${trigger}    input_schema:
      type: object
      additionalProperties: false
      required: [amount_cents]
      properties:
        amount_cents: { type: integer }
    output_schema:
      type: object
      required: [amount_cents]
      properties:
        amount_cents: { type: integer }
        fallback_reason: { type: string }
    validation_exhaustion:
      default_output:
        amount_cents: 0
        fallback_reason: the agent could not decide
  refund:
    description: refund
    execution: auto
    handler: send_refund
    depends_on: [propose]
${read.join('\n')}
`;
const WHY_DEFAULT =
  "'fallback_reason' is only in default_output, which the step records only when it takes its default answer";
const PATH_CODES = new Set([
  'INPUT_MAP_PATH_UNRESOLVABLE',
  'INPUT_MAP_PATH_UNCERTAIN',
  'WHEN_PATH_UNRESOLVABLE',
  'WHEN_PATH_UNCERTAIN',
]);
const pathFindings = (yaml: string) =>
  loadWorkflowFromStringWithDiagnostics(yaml)
    .warnings.filter((w) => PATH_CODES.has(w.code))
    .map((w) => ({ code: w.code, why: w.message.includes(`(${WHY_DEFAULT})`) }));

describe('gap 2 (iii), check 10 — a path only default_output holds, for a step with the key alone', () => {
  it.each([
    [
      'input_map',
      ['    input_map:', '      reason: context.resources.propose.fallback_reason'],
      'INPUT_MAP_PATH_UNCERTAIN',
    ],
    ['when', ['    when: "propose.fallback_reason == \'x\'"'], 'WHEN_PATH_UNCERTAIN'],
  ])('%s: may be absent, with Words 7’s reason; never refused', (_n, read, code) => {
    // (a) red when the answer's shape is read under `mode: default` only (the path is refused as
    //     never found); (b) prints the findings.
    expect(pathFindings(proposeAndRefund('    on_model_failure: default\n', read))).toEqual([
      { code, why: true },
    ]);
  });
});
