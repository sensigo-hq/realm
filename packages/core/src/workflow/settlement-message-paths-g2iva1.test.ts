// settlement-message-paths-g2iva1.test.ts — gap 2, unit (iv-a1), checks 7 and 8 at the loader:
// `$settlement.<step>.message` in the one closed list of `$settlement` fields, judged may be absent
// with its own reason except where the reader runs only after that step failed, and the note the
// loader returns when a prompt or a gated step's instructions puts the message into its text.
//
// Every assertion carries (a) the break that turns it red and (b) what it prints.
import { describe, expect, it } from 'vitest';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import { PathIndex } from './path-resolver.js';

/**
 * The load's warnings as `code: message` and its notes, and its refusal: a throw, or the findings
 * whose policy is `error` (validate, register and watch refuse those).
 */
function load(yaml: string): { warnings: string[]; notes: string[]; refusal: string | null } {
  try {
    const r = loadWorkflowFromStringWithDiagnostics(yaml);
    const refused = r.warnings.filter((w) => w.severity === 'error');
    return {
      warnings: r.warnings.map((w) => `${w.code}: ${w.message}`),
      notes: r.notes.map((n) => `${n.step}|${n.placement}|${n.reads}|${n.message}`),
      refusal: refused.length > 0 ? refused.map((w) => `${w.code}: ${w.message}`).join('\n') : null,
    };
  } catch (err) {
    return { warnings: [], notes: [], refusal: (err as Error).message };
  }
}

/** `classify` (an auto step), then `reader`, holding `lines`, with `rule` over `deps`. */
const workflow = (
  lines: string[],
  opts: { rule?: string; deps?: string[]; reader?: string[]; extraSteps?: string[] } = {},
): string =>
  [
    'id: g2iva1-paths',
    'name: g2iva1 paths',
    'version: 1',
    'steps:',
    '  classify:',
    '    description: Classify.',
    '    execution: auto',
    '    handler: h',
    ...(opts.extraSteps ?? []),
    '  reader:',
    '    description: Read it.',
    ...(opts.reader ?? ['    execution: auto', '    handler: h']),
    `    depends_on: [${(opts.deps ?? ['classify']).join(', ')}]`,
    ...(opts.rule !== undefined ? [`    trigger_rule: ${opts.rule}`] : []),
    ...lines,
    '',
  ].join('\n');

const PATH = 'context.resources.$settlement.classify.message';
const WHY =
  "'message' is set only when step 'classify' failed, or took its default answer after its model request failed";
const gated = (message: string): string[] => [
  '    trust: human_confirmed',
  '    gate:',
  '      choices: [ok]',
  `      message: ${JSON.stringify(message)}`,
];
const inputMap = ['    input_map:', `      why: ${PATH}`];
const AGENT = ['    execution: agent'];
const promptOf = (text: string): string[] => [`    prompt: ${JSON.stringify(text)}`];
const instructionsOf = (text: string): string[] => [
  ...AGENT,
  ...gated('{{ context.resources.classify | default: "x" }}'),
  `    instructions: ${JSON.stringify(text)}`,
];
const codes = (warnings: string[]): string[] => warnings.map((w) => w.split(':')[0]!);

describe('gap 2 (iv-a1), check 7 — the loader judges $settlement.<s>.message', () => {
  it('a typo (mesage) in a when is refused with its did-you-mean', () => {
    const got = load(workflow(['    when: "$settlement.classify.mesage == \'x\'"']));
    // (a) red when `message` is missing from the closed list (no did-you-mean, or the right
    //     spelling refused); (b) prints the refusal.
    expect(got.refusal ?? '(it loaded)').toContain("Did you mean 'message'?");
  });

  it('a typo in a template is refused with its did-you-mean', () => {
    const got = load(
      workflow(gated('{{ context.resources.$settlement.classify.mesage | default: "x" }}'), {
        rule: 'one_failed',
      }),
    );
    // (a) red as above; (b) prints the refusal.
    expect(got.refusal ?? '(it loaded)').toContain("Did you mean 'message'?");
  });

  it('a gate message without | default, on a reader that can run when classify completed: refused as may be missing, with its reason', () => {
    const got = load(workflow(gated(`{{ ${PATH} }}`)));
    // (a) red when the field is judged found everywhere (the question then fails at run time);
    //     (b) prints the refusal.
    expect(
      {
        refused: got.refusal?.startsWith('TEMPLATE_PATH_NO_DEFAULT') === true,
        why: got.refusal?.includes(WHY) === true,
      },
      got.refusal ?? '(it loaded)',
    ).toEqual({ refused: true, why: true });
  });

  it.each([
    ['one_failed with classify its only dependency', 'one_failed'],
    ['all_failed with classify in its depends_on', 'all_failed'],
  ])(
    'a gate message without | default, on a reader that runs only after classify failed (%s): it loads',
    (_n, rule) => {
      const got = load(workflow(gated(`{{ ${PATH} }}`), { rule }));
      // (a) red when the found-after-failure rule is removed (refused as may be missing); (b)
      //     prints the refusal or the warnings.
      expect({ refusal: got.refusal, warnings: got.warnings }).toEqual({
        refusal: null,
        warnings: [],
      });
    },
  );

  it.each([
    ['prompt', [...AGENT, ...promptOf(`Why: {{ ${PATH} }}`)]],
    ['instructions', instructionsOf(`Why: {{ ${PATH} }}`)],
  ])('a %s without | default warns TEMPLATE_PATH_UNCERTAIN, with its reason', (_n, reader) => {
    const got = load(workflow([], { reader }));
    const ours = got.warnings.filter((w) => w.includes(PATH));
    // (a) red when the reason is another's or the field is judged found; (b) prints the warnings.
    expect(
      { codes: codes(ours), why: ours.length > 0 && ours.every((w) => w.includes(WHY)) },
      got.warnings.join('\n'),
    ).toEqual({ codes: ['TEMPLATE_PATH_UNCERTAIN'], why: true });
  });

  it('a when reading it gets no finding', () => {
    const got = load(workflow(['    when: "$settlement.classify.message == \'x\'"']));
    // (a) red when a when gets the may-be-absent finding; (b) prints the warnings.
    expect({ refusal: got.refusal, warnings: got.warnings }).toEqual({
      refusal: null,
      warnings: [],
    });
  });

  it('an input_map on a reader that can run when classify completed warns INPUT_MAP_PATH_UNCERTAIN, with its reason', () => {
    const got = load(workflow(inputMap));
    // (a) red when the field is judged found everywhere; (b) prints the warnings.
    expect(
      {
        codes: codes(got.warnings),
        why: got.warnings.length > 0 && got.warnings.every((w) => w.includes(WHY)),
      },
      got.warnings.join('\n'),
    ).toEqual({ codes: ['INPUT_MAP_PATH_UNCERTAIN'], why: true });
  });

  it.each([
    ['one_failed, classify its only dependency', 'one_failed'],
    ['all_failed, classify in its depends_on', 'all_failed'],
  ])(
    'an input_map on a reader that runs only after classify failed (%s): no warning, so --strict passes',
    (_n, rule) => {
      const got = load(workflow(inputMap, { rule }));
      // (a) red when the found-after-failure rule is removed (the map warns, --strict fails); (b)
      //     prints the warnings.
      expect({ refusal: got.refusal, warnings: got.warnings }).toEqual({
        refusal: null,
        warnings: [],
      });
    },
  );

  const OTHER = ['  other:', '    description: Other.', '    execution: auto', '    handler: h'];
  it.each([
    ['one_failed over two dependencies', 'one_failed', ['classify', 'other'], OTHER],
    ['all_done over classify alone', 'all_done', ['classify'], []],
  ])('it stays may be absent: %s', (_n, rule, deps, extraSteps) => {
    const got = load(workflow(inputMap, { rule, deps, extraSteps }));
    // (a) red when the rule counts dependencies and ignores the trigger rule, or the reverse; (b)
    //     prints the warnings.
    expect(codes(got.warnings), got.warnings.join('\n')).toEqual(['INPUT_MAP_PATH_UNCERTAIN']);
  });

  it('it stays may be absent: all_failed reading a step upstream of its dependency, not in its depends_on', () => {
    // classify → middle → reader (all_failed over middle); the reader reads classify's message.
    const MIDDLE = [
      '  middle:',
      '    description: Middle.',
      '    execution: auto',
      '    handler: h',
      '    depends_on: [classify]',
    ];
    const got = load(
      workflow(inputMap, { rule: 'all_failed', deps: ['middle'], extraSteps: MIDDLE }),
    );
    // (a) red when the depends_on condition is dropped (judged found); (b) prints the warnings.
    expect(codes(got.warnings), got.warnings.join('\n')).toEqual(['INPUT_MAP_PATH_UNCERTAIN']);
  });
});

describe('gap 2 (iv-a1), check 8 at the loader — the notes', () => {
  const NOTE = (reads: string, placement: string): string =>
    `reader|${placement}|${reads}|Step 'reader' puts a failure message (\`${reads}\`) into its ${placement}: the text is the failure's own (a provider's, a handler's, an adapter's or Realm's own), so it can carry anything the failed request echoed back.`;

  it.each([
    [
      'a prompt that reads the field',
      [...AGENT, ...promptOf(`Why: {{ ${PATH} | default: "none" }}`)],
      PATH,
      'prompt',
    ],
    [
      'a gated step’s instructions',
      instructionsOf(`Why: {{ ${PATH} | default: "none" }}`),
      PATH,
      'instructions',
    ],
    [
      'a prompt that dumps the whole entry',
      [...AGENT, ...promptOf('All: {{ context.resources.$settlement.classify }}')],
      'context.resources.$settlement.classify',
      'prompt',
    ],
    [
      'a prompt that dumps context',
      [...AGENT, ...promptOf('All: {{ context }}')],
      'context',
      'prompt',
    ],
  ])('%s: one note', (_n, reader, reads, placement) => {
    const got = load(workflow([], { reader }));
    // (a) red when the note is not made, made for the exact path only, or not returned on the
    //     loader's result; (b) prints the notes.
    expect(got.notes).toEqual([NOTE(reads, placement)]);
  });

  it.each([
    ['a gate message', workflow(gated(`{{ ${PATH} }}`), { rule: 'one_failed' })],
    ['an input_map', workflow(inputMap, { rule: 'one_failed' })],
    ['a when', workflow(['    when: "$settlement.classify.message == \'x\'"'])],
    [
      'an ungated step’s instructions',
      workflow([`    instructions: ${JSON.stringify(`Why: {{ ${PATH} }}`)}`], { reader: AGENT }),
    ],
  ])('no note for %s', (_n, yaml) => {
    // (a) red when the note is made for any placement; (b) prints the notes.
    expect(load(yaml).notes).toEqual([]);
  });

  it('no note for a placement the loader refuses (a step name that does not exist)', () => {
    const got = load(
      workflow([], {
        reader: [...AGENT, ...promptOf('{{ context.resources.$settlement.nostep.message }}')],
      }),
    );
    // (a) red when the note is made for a refused placeholder; (b) prints the refusal and notes.
    expect({ refused: got.refusal !== null, notes: got.notes }, got.refusal ?? '').toEqual({
      refused: true,
      notes: [],
    });
  });
});

describe('gap 2 (iv-a1), check 7 — the found-after-failure rule, one cell per condition', () => {
  // On a load, the trigger-rule reach check runs first and already judges the all_done reader and
  // the reader of a step outside its depends_on may be absent; these cells read the rule itself.
  const step = (deps: string[] = [], rule?: string) => ({
    description: 'S.',
    execution: 'auto',
    handler: 'h',
    depends_on: deps,
    ...(rule !== undefined ? { trigger_rule: rule } : {}),
  });
  it.each([
    ['all_failed, classify in its depends_on', ['classify'], 'all_failed', true],
    ['one_failed, classify its only dependency', ['classify'], 'one_failed', true],
    ['one_failed over two dependencies', ['classify', 'other'], 'one_failed', false],
    ['all_done over classify alone', ['classify'], 'all_done', false],
    ['all_success over classify alone', ['classify'], undefined, false],
    ['all_failed over middle, reading classify upstream of it', ['middle'], 'all_failed', false],
  ])('%s', (_n, deps, rule, expected) => {
    const index = new PathIndex({
      steps: {
        classify: step(),
        other: step(),
        middle: step(['classify']),
        reader: step(deps, rule),
      },
    });
    // (a) red when the rule ignores the trigger rule (all_done or all_success counts), counts no
    //     dependencies (one_failed over two counts), or drops the depends_on condition (the
    //     upstream read counts); (b) prints the verdict.
    expect(index.runsOnlyAfterFailureOf('reader', 'classify')).toBe(expected);
  });
});
