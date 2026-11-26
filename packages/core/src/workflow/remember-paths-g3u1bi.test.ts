// remember-paths-g3u1bi.test.ts — gap 3, unit 1b-i, checks 1–7 and 9 (core half): every path a
// step's `remember:` block reads, judged when the file loads as an `input_map` path is, and the rule
// that the steps remembering one memory use one set of key names. The commands' half (validate's
// lines, `--json`, `--strict`, register and run) is the CLI's commands/remember-paths-g3u1bi.test.ts.
//
// Every assertion names (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import type { NotCheckedPath } from './input-map-paths.js';

interface Finding {
  code: string;
  severity: string;
  key: string | undefined;
  message: string;
  did_you_mean?: string;
}
interface Judged {
  loads: boolean;
  errors: string[];
  findings: Finding[];
  notChecked: NotCheckedPath[];
}

/** The loader's verdict on `text`: its `errors[]`, its `remember` findings and not-checked paths. */
function judge(text: string): Judged {
  const pick = (warnings: ReadonlyArray<Record<string, unknown>>): Finding[] =>
    warnings
      .filter((w) => String(w['code']).startsWith('REMEMBER_PATH_'))
      .map((w) => ({
        code: String(w['code']),
        severity: String(w['severity']),
        key: w['key'] as string | undefined,
        message: String(w['message']),
        ...(w['did_you_mean'] !== undefined ? { did_you_mean: String(w['did_you_mean']) } : {}),
      }));
  try {
    const r = loadWorkflowFromStringWithDiagnostics(text);
    return {
      loads: true,
      errors: [],
      findings: pick(r.warnings as unknown as Array<Record<string, unknown>>),
      notChecked: r.notChecked.filter((n) => n.surface === 'remember'),
    };
  } catch (err) {
    const e = err as { errors?: string[]; message: string; warnings?: unknown[] };
    return {
      loads: false,
      errors: e.errors ?? [e.message],
      findings: pick((e.warnings ?? []) as Array<Record<string, unknown>>),
      notChecked: [],
    };
  }
}

/** The 1-based line of the first line of `text` that holds `needle`. */
function lineOf(text: string, needle: string): number {
  const i = text.split('\n').findIndex((l) => l.includes(needle));
  if (i === -1) throw new Error(`no line holds ${needle}`);
  return i + 1;
}

const HEAD = [
  'id: wf',
  'name: WF',
  'version: 1',
  'params_schema:',
  '  type: object',
  '  additionalProperties: false',
  '  properties:',
  '    email: { type: string }',
  '  required: [email]',
  'steps:',
];
/** An agent step with a closed answer: `rung` and `items` required, `note` optional. */
const RATE = [
  '  rate:',
  '    description: r',
  '    execution: agent',
  '    output_schema:',
  '      type: object',
  '      additionalProperties: false',
  '      properties:',
  '        rung: { type: integer }',
  '        note: { type: string }',
  '        items: { type: array, items: { type: string } }',
  '      required: [rung, items]',
];
/** A handler step after `rate`, remembering `offers` under the key and value written. */
function writer(key: string, value?: string, name = 'w'): string[] {
  return [
    `  ${name}:`,
    `    description: ${name}`,
    '    execution: auto',
    '    handler: h',
    '    depends_on: [rate]',
    '    remember:',
    '      as: offers',
    `      key: ${key}`,
    ...(value !== undefined ? [`      value: ${value}`] : []),
    '      keep_days: 90',
  ];
}
const wf = (...steps: string[][]): string => [...HEAD, ...steps.flat()].join('\n') + '\n';
const unresolvable = (key: string, message: string, dym?: string): Finding => ({
  code: 'REMEMBER_PATH_UNRESOLVABLE',
  severity: 'error',
  key,
  message,
  ...(dym !== undefined ? { did_you_mean: dym } : {}),
});
const uncertain = (key: string, message: string): Finding => ({
  code: 'REMEMBER_PATH_UNCERTAIN',
  severity: 'warn',
  key,
  message,
});

describe('gap 3 (1b-i), check 1 — a key part that can never be found', () => {
  it('no_step: a step the workflow does not have, with the did-you-mean and the key line', () => {
    const text = wf(RATE, writer('{ email: context.resources.rat.email }'));
    // (a) red when remember paths are not judged (no finding); (b) prints the findings.
    expect(judge(text).findings).toEqual([
      unresolvable(
        'key.email',
        `Step 'w': remember 'offers' key 'email' reads 'context.resources.rat.email', but the workflow has no step 'rat'. Did you mean 'rate'? (line ${lineOf(text, 'key:')})`,
        'rate',
      ),
    ]);
  });

  it("no_field: a field the step's closed answer does not declare", () => {
    const text = wf(RATE, writer('{ email: context.resources.rate.email }'));
    // (a) red when remember paths are not judged; (b) prints the findings.
    expect(judge(text).findings).toEqual([
      unresolvable(
        'key.email',
        `Step 'w': remember 'offers' key 'email' reads 'context.resources.rate.email', but step 'rate' has no field 'email' there, and its schema allows no other fields. (line ${lineOf(text, 'key:')})`,
      ),
    ]);
  });

  it("own_settlement: the step's own $settlement entry, written after the stamp", () => {
    const text = wf(RATE, writer('{ email: context.resources.$settlement.w.failed }'));
    // (a) red when remember paths are not judged, or the surface does not read its own output (the
    //     path is then judged as a later step's); (b) prints the findings.
    expect(judge(text).findings).toEqual([
      unresolvable(
        'key.email',
        `Step 'w': remember 'offers' key 'email' reads 'context.resources.$settlement.w.failed', but a step's own '$settlement' is written after it remembers, so it is never there. (line ${lineOf(text, 'key:')})`,
      ),
    ]);
  });

  it("own_choice: an ungated agent step's own choice its answer does not declare", () => {
    const text = wf([
      '  w:',
      '    description: w',
      '    execution: agent',
      '    output_schema:',
      '      type: object',
      '      properties:',
      '        email: { type: string }',
      '    remember:',
      '      as: offers',
      '      key: { email: context.resources.w.choice }',
      '      keep_days: 90',
    ]);
    // (a) red when remember paths are not judged; (b) prints the findings.
    expect(judge(text).findings).toEqual([
      unresolvable(
        'key.email',
        `Step 'w': remember 'offers' key 'email' reads 'context.resources.w.choice', but step 'w' opens no gate and its answer declares no 'choice'. (line ${lineOf(text, 'key:')})`,
      ),
    ]);
  });
});

describe('gap 3 (1b-i), check 2 — a value leaf that can never be found', () => {
  it('a nested leaf names its key chain, in the words and in the key', () => {
    const text = wf(
      RATE,
      writer('{ email: run.params.email }', '{ offer: { rung: context.resources.rate.rnug } }'),
    );
    // (a) red when only key parts are judged; (b) prints the findings.
    expect(judge(text).findings).toEqual([
      unresolvable(
        'value.offer.rung',
        `Step 'w': remember 'offers' value 'offer.rung' reads 'context.resources.rate.rnug', but step 'rate' has no field 'rnug' there, and its schema allows no other fields. Did you mean 'rung'? (line ${lineOf(text, 'value:')})`,
        'rung',
      ),
    ]);
  });
});

describe('gap 3 (1b-i), check 3 — a path that may be absent, on a key part and on a value leaf', () => {
  it('undeclared_field: a field an open answer does not declare', () => {
    const text = wf(
      [
        '  rate:',
        '    description: r',
        '    execution: agent',
        '    output_schema:',
        '      type: object',
        '      properties:',
        '        rung: { type: integer }',
      ],
      writer('{ email: context.resources.rate.email }', '{ x: context.resources.rate.email }'),
    );
    // (a) red when the consequence clause is input_map's ("the step receives no value…"), or
    //     remember paths are not judged; (b) prints the findings.
    expect(judge(text)).toEqual({
      loads: true,
      errors: [],
      findings: [
        uncertain(
          'key.email',
          `Step 'w': remember 'offers' key 'email' reads 'context.resources.rate.email', which step 'rate' does not declare; when it is absent, the step remembers nothing. (line ${lineOf(text, 'key:')})`,
        ),
        uncertain(
          'value.x',
          `Step 'w': remember 'offers' value 'x' reads 'context.resources.rate.email', which step 'rate' does not declare; when it is absent, the remembered value has no 'x'. (line ${lineOf(text, 'value:')})`,
        ),
      ],
      notChecked: [],
    });
  });

  it('not_a_dependency: a handler step this step does not depend on — not checked, and warned', () => {
    const text = wf(
      ['  c:', '    description: c', '    execution: auto', '    handler: h'],
      [
        '  w:',
        '    description: w',
        '    execution: auto',
        '    handler: h',
        '    remember:',
        '      as: offers',
        '      key: { email: context.resources.c.email }',
        '      value: { x: context.resources.c.x }',
        '      keep_days: 90',
      ],
    );
    // (a) red when the step cause is dropped from not-checked judgements (no warning), the
    //     not-checked entry is lost, or the consequence clause is input_map's; (b) prints them.
    expect(judge(text)).toEqual({
      loads: true,
      errors: [],
      findings: [
        uncertain(
          'key.email',
          `Step 'w': remember 'offers' key 'email' reads step 'c', which this step does not depend on, so it may not have run yet; add 'c' to depends_on if this step needs it. When it is absent, the step remembers nothing. (line ${lineOf(text, 'key:')})`,
        ),
        uncertain(
          'value.x',
          `Step 'w': remember 'offers' value 'x' reads step 'c', which this step does not depend on, so it may not have run yet; add 'c' to depends_on if this step needs it. When it is absent, the remembered value has no 'x'. (line ${lineOf(text, 'value:')})`,
        ),
      ],
      notChecked: [
        {
          surface: 'remember',
          step: 'w',
          key: 'key.email',
          path: 'context.resources.c.email',
          why: 'producer_declares_no_shape',
        },
        {
          surface: 'remember',
          step: 'w',
          key: 'value.x',
          path: 'context.resources.c.x',
          why: 'producer_declares_no_shape',
        },
      ],
    });
  });

  it('optional: a property its schema does not require (one of the grouped causes)', () => {
    const text = wf(
      RATE,
      writer('{ email: context.resources.rate.note }', '{ n: context.resources.rate.note }'),
    );
    // (a) red when the consequence clause is input_map's; (b) prints the findings.
    expect(judge(text).findings).toEqual([
      uncertain(
        'key.email',
        `Step 'w': remember 'offers' key 'email' reads 'context.resources.rate.note', which may be absent when this step remembers ('note' is optional in its schema); when it is absent, the step remembers nothing. (line ${lineOf(text, 'key:')})`,
      ),
      uncertain(
        'value.n',
        `Step 'w': remember 'offers' value 'n' reads 'context.resources.rate.note', which may be absent when this step remembers ('note' is optional in its schema); when it is absent, the remembered value has no 'n'. (line ${lineOf(text, 'value:')})`,
      ),
    ]);
  });
});

describe("gap 3 (1b-i), check 4 — a handler writer's own output (core half)", () => {
  it('is listed as not checked, with no warning', () => {
    const text = wf([
      '  w:',
      '    description: w',
      '    execution: auto',
      '    handler: h',
      '    remember:',
      '      as: offers',
      '      key: { email: context.resources.w.email }',
      '      keep_days: 90',
    ]);
    // (a) red when the writer's own output gets a step cause (a warning), or is not listed; (b)
    //     prints the verdict.
    expect(judge(text)).toEqual({
      loads: true,
      errors: [],
      findings: [],
      notChecked: [
        {
          surface: 'remember',
          step: 'w',
          key: 'key.email',
          path: 'context.resources.w.email',
          why: 'producer_declares_no_shape',
        },
      ],
    });
  });
});

describe("gap 3 (1b-i), check 5 — a gated writer's own choice is found", () => {
  it('a gated agent writer whose answer declares no choice', () => {
    const text = wf([
      '  w:',
      '    description: w',
      '    execution: agent',
      '    trust: human_confirmed',
      '    output_schema:',
      '      type: object',
      '      additionalProperties: false',
      '      properties:',
      '        email: { type: string }',
      '      required: [email]',
      '    remember:',
      '      as: offers',
      '      key: { email: context.resources.w.email, c: context.resources.w.choice }',
      '      keep_days: 90',
    ]);
    // (a) red when the surface judges its own choice as the approval question's does (refused
    //     own_choice); (b) prints the verdict.
    expect(judge(text)).toEqual({ loads: true, errors: [], findings: [], notChecked: [] });
  });

  it('a gated handler writer', () => {
    const text = wf([
      '  w:',
      '    description: w',
      '    execution: auto',
      '    handler: h',
      '    trust: human_confirmed',
      '    remember:',
      '      as: offers',
      '      key: { c: context.resources.w.choice }',
      '      keep_days: 90',
    ]);
    // (a) red when the surface judges its own choice as the approval question's does (listed as not
    //     checked); (b) prints the verdict.
    expect(judge(text)).toEqual({ loads: true, errors: [], findings: [], notChecked: [] });
  });

  it("a gated writer's own field its answer does not declare is still refused", () => {
    const text = wf([
      '  w:',
      '    description: w',
      '    execution: agent',
      '    trust: human_confirmed',
      '    output_schema:',
      '      type: object',
      '      additionalProperties: false',
      '      properties:',
      '        email: { type: string }',
      '      required: [email]',
      '    remember:',
      '      as: offers',
      '      key: { email: context.resources.w.emial }',
      '      keep_days: 90',
    ]);
    // (a) red when every own field of a gated writer is found, not only `choice`; (b) prints them.
    expect(judge(text).findings).toEqual([
      unresolvable(
        'key.email',
        `Step 'w': remember 'offers' key 'email' reads 'context.resources.w.emial', but step 'w' has no field 'emial' there, and its schema allows no other fields. Did you mean 'email'? (line ${lineOf(text, 'key:')})`,
        'email',
      ),
    ]);
  });
});

describe('gap 3 (1b-i), check 6 — one set of key names per memory', () => {
  const handler = (name: string, key: string, as = 'offers'): string[] => [
    `  ${name}:`,
    `    description: ${name}`,
    '    execution: auto',
    '    handler: h',
    '    remember:',
    `      as: ${as}`,
    `      key: ${key}`,
    '      keep_days: 90',
  ];

  it('two writers of offers with different names are refused, with the words', () => {
    const text = wf(
      handler('a', '{ customer_email: run.params.email }'),
      handler('b', '{ email: run.params.email }'),
    );
    // (a) red when the rule is removed (it loads); (b) prints the errors.
    expect(judge(text).errors).toEqual([
      "Steps that remember 'offers' use different key names: 'a' (customer_email), 'b' (email). Every step that remembers one memory must use the same key names.",
    ]);
  });

  it('the same names in another order load', () => {
    const text = wf(
      handler('a', '{ x: run.params.email, y: run.params.email }'),
      handler('b', '{ y: run.params.email, x: run.params.email }'),
    );
    // (a) red when the names are compared in order (refused); (b) prints the verdict.
    expect(judge(text)).toEqual({ loads: true, errors: [], findings: [], notChecked: [] });
  });

  it("every writer once, in the file's order, its names as written; a memory that agrees is not named", () => {
    const text = wf(
      handler('a', '{ x: run.params.email, y: run.params.email }'),
      handler('n1', '{ k: run.params.email }', 'notes'),
      handler('b', '{ y: run.params.email, x: run.params.email }'),
      handler('n2', '{ k: run.params.email }', 'notes'),
      handler('c', '{ x: run.params.email }'),
    );
    // (a) red when a writer is left out, the order is not the file's, or an agreeing memory is
    //     refused; (b) prints the errors.
    expect(judge(text).errors).toEqual([
      "Steps that remember 'offers' use different key names: 'a' (x, y), 'b' (y, x), 'c' (x). Every step that remembers one memory must use the same key names.",
    ]);
  });
});

describe('gap 3 (1b-i), check 7 — a block the loader refuses', () => {
  it('a keep_days error and a key path to no step: both refusals, and no key-names refusal', () => {
    const text = wf(
      [
        '  a:',
        '    description: a',
        '    execution: auto',
        '    handler: h',
        '    remember:',
        '      as: offers',
        '      key: { email: context.resources.nope.email }',
        '      keep_days: 0',
      ],
      [
        '  b:',
        '    description: b',
        '    execution: auto',
        '    handler: h',
        '    remember:',
        '      as: offers',
        '      key: { other: run.params.email }',
        '      keep_days: 90',
      ],
    );
    // (a) red when a refused block is skipped whole (no path finding), or counted toward the
    //     key-names rule (a second error); (b) prints the verdict.
    expect(judge(text)).toEqual({
      loads: false,
      errors: [
        `Step 'a': 'remember.keep_days' is 0; it must be a whole number from 1 to 3650. (line ${lineOf(text, 'remember:')})`,
      ],
      findings: [
        unresolvable(
          'key.email',
          `Step 'a': remember 'offers' key 'email' reads 'context.resources.nope.email', but the workflow has no step 'nope'. (line ${lineOf(text, 'key: { email')})`,
        ),
      ],
      notChecked: [],
    });
  });

  it("a key that is a list gives 1a's refusal alone, with no throw", () => {
    const text = wf([
      '  a:',
      '    description: a',
      '    execution: auto',
      '    handler: h',
      '    remember:',
      '      as: offers',
      '      key: [run.params.email]',
      '      keep_days: 90',
    ]);
    // (a) red when a list key is walked as a map (a finding), or the check throws; (b) prints it.
    expect(judge(text)).toEqual({
      loads: false,
      errors: [
        `Step 'a': 'remember.key' must name at least one part, each a path such as context.resources.<step>.<field>. (line ${lineOf(text, 'remember:')})`,
      ],
      findings: [],
      notChecked: [],
    });
  });

  for (const [form, part] of [
    ['blank', "'   '"],
    ['a number', '5'],
  ] as const) {
    it(`a key part that is ${form} gives 1a's refusal alone`, () => {
      const text = wf([
        '  a:',
        '    description: a',
        '    execution: auto',
        '    handler: h',
        '    remember:',
        '      as: offers',
        `      key: { email: ${part} }`,
        '      keep_days: 90',
      ]);
      // (a) red when a part that is not a path is judged as one (a finding), or the check throws;
      //     (b) prints the verdict.
      expect(judge(text)).toEqual({
        loads: false,
        errors: [
          `Step 'a': 'remember.key' must name at least one part, each a path such as context.resources.<step>.<field>. (line ${lineOf(text, 'remember:')})`,
        ],
        findings: [],
        notChecked: [],
      });
    });
  }

  it("a block with no `as`: its path is still judged, the opening without the memory's name", () => {
    const text = wf([
      '  a:',
      '    description: a',
      '    execution: auto',
      '    handler: h',
      '    remember:',
      '      key: { email: context.resources.nope.email }',
      '      keep_days: 90',
    ]);
    // (a) red when the opening writes a name that is not text (`remember 'undefined'`), or the
    //     block is skipped; (b) prints the verdict.
    expect(judge(text)).toEqual({
      loads: false,
      errors: [`Step 'a': 'remember' needs 'as'. (line ${lineOf(text, 'remember:')})`],
      findings: [
        unresolvable(
          'key.email',
          `Step 'a': remember key 'email' reads 'context.resources.nope.email', but the workflow has no step 'nope'. (line ${lineOf(text, 'key:')})`,
        ),
      ],
      notChecked: [],
    });
  });

  it('a block refused for reading a failure message is left out of the key-names rule; its path is still judged', () => {
    const text = wf(
      ['  c:', '    description: c', '    execution: auto', '    handler: h'],
      [
        '  a:',
        '    description: a',
        '    execution: auto',
        '    handler: h',
        '    depends_on: [c]',
        '    remember:',
        '      as: offers',
        '      key: { email: context.resources.$settlement.c.message }',
        '      keep_days: 90',
      ],
      [
        '  b:',
        '    description: b',
        '    execution: auto',
        '    handler: h',
        '    remember:',
        '      as: offers',
        '      key: { other: run.params.email }',
        '      keep_days: 90',
      ],
    );
    // (a) red when a block the schema accepts but another check refuses is counted toward the
    //     key-names rule (a second error); (b) prints the verdict.
    expect(judge(text)).toEqual({
      loads: false,
      errors: [
        `Step 'a': 'remember' can't read a step's failure message ('context.resources.$settlement.c.message'): a memory outlives the run, and a failure's words can carry anything the failed request echoed back. (line ${lineOf(text, '    remember:')})`,
      ],
      findings: [
        uncertain(
          'key.email',
          `Step 'a': remember 'offers' key 'email' reads 'context.resources.$settlement.c.message', which may be absent when this step remembers ('message' is set only when step 'c' failed, or took its default answer after its model request failed); when it is absent, the step remembers nothing. (line ${lineOf(text, 'key: { email')})`,
        ),
      ],
      notChecked: [],
    });
  });
});

describe('gap 3 (1b-i), check 9 — every other sentence, on a key part (Words 2 and 3)', () => {
  const at = (text: string): string => ` (line ${lineOf(text, 'key:')})`;
  const O = "Step 'w': remember 'offers' key 'k'";
  const steps = (path: string): string => wf(RATE, writer(`{ k: '${path}' }`));
  const cells: Array<[string, string, (text: string) => Finding]> = [
    [
      'bad_start',
      steps('steps.rate.output.rung'),
      (t) =>
        unresolvable(
          'key.k',
          `${O} reads 'steps.rate.output.rung', which can never be found: a path starts with 'run.params.' or 'context.resources.<step>.'. Write it as 'context.resources.rate.rung'.${at(t)}`,
        ),
    ],
    [
      'bad_root',
      steps('context.rate.rung'),
      (t) =>
        unresolvable(
          'key.k',
          `${O} reads 'context.rate.rung', which can never be found: a path starts with 'run.params.' or 'context.resources.<step>.'. Write it as 'context.resources.rate.rung'.${at(t)}`,
        ),
    ],
    [
      'template',
      steps('{{ context.resources.rate.rung }}'),
      (t) =>
        unresolvable(
          'key.k',
          `${O} is '{{ context.resources.rate.rung }}': remember takes a path, not a template, so the braces make it a path that can never be found. Write it as 'context.resources.rate.rung'.${at(t)}`,
        ),
    ],
    [
      'no_settlement_field',
      steps('context.resources.$settlement.rate.faild'),
      (t) =>
        unresolvable(
          'key.k',
          `${O} reads 'context.resources.$settlement.rate.faild', but '$settlement.rate' holds only 'failed', 'settled_by_default', 'validation_rejections', 'failure_kind' and 'message'. Did you mean 'failed'?${at(t)}`,
          'failed',
        ),
    ],
    [
      'no_param',
      steps('run.params.emial'),
      (t) =>
        unresolvable(
          'key.k',
          `${O} reads 'run.params.emial', but params_schema has no parameter 'emial' and allows no others. Did you mean 'email'?${at(t)}`,
          'email',
        ),
    ],
    [
      'runs_after',
      wf(RATE, writer("{ k: 'context.resources.later.x' }"), [
        '  later:',
        '    description: l',
        '    execution: auto',
        '    handler: h',
        '    depends_on: [w]',
      ]),
      (t) =>
        uncertain(
          'key.k',
          `${O} reads step 'later', which runs after this step, so it may have no output when this step remembers: the step remembers nothing.${at(t)}`,
        ),
    ],
    [
      'trigger_rule',
      wf(
        RATE,
        ['  other:', '    description: o', '    execution: auto', '    handler: h'],
        writer("{ k: 'context.resources.rate.rung' }").map((l) =>
          l === '    depends_on: [rate]'
            ? '    depends_on: [rate, other]\n    trigger_rule: one_success'
            : l,
        ),
      ),
      (t) =>
        uncertain(
          'key.k',
          `${O} reads 'context.resources.rate.rung', which may be absent when this step remembers (this step's trigger_rule lets it run when 'rate' did not complete); when it is absent, the step remembers nothing.${at(t)}`,
        ),
    ],
    [
      'list_position',
      steps('context.resources.rate.items.0'),
      (t) =>
        uncertain(
          'key.k',
          `${O} reads 'context.resources.rate.items.0', which may be absent when this step remembers ('0' is a position in a list that may be shorter); when it is absent, the step remembers nothing.${at(t)}`,
        ),
    ],
    [
      'model_failure_only',
      steps('context.resources.$settlement.rate.failure_kind'),
      (t) =>
        uncertain(
          'key.k',
          `${O} reads 'context.resources.$settlement.rate.failure_kind', which may be absent when this step remembers ('failure_kind' is set only when step 'rate''s model request failed and the step has on_model_failure); when it is absent, the step remembers nothing.${at(t)}`,
        ),
    ],
    [
      'failure_only',
      steps('context.resources.$settlement.rate.message.x'),
      (t) =>
        uncertain(
          'key.k',
          `${O} reads 'context.resources.$settlement.rate.message.x', which may be absent when this step remembers ('message' is set only when step 'rate' failed, or took its default answer after its model request failed); when it is absent, the step remembers nothing.${at(t)}`,
        ),
    ],
    [
      'default_only',
      wf(
        [
          '  rate:',
          '    description: r',
          '    execution: agent',
          '    input_schema:',
          '      type: object',
          '      additionalProperties: false',
          '      properties:',
          '        rung: { type: integer }',
          '    output_schema:',
          '      type: object',
          '      properties:',
          '        rung: { type: integer }',
          '        x: { type: string }',
          '    validation_exhaustion:',
          '      mode: default',
          "      default_output: { rung: 1, x: 'y' }",
        ],
        writer("{ k: 'context.resources.rate.x' }"),
      ),
      (t) =>
        uncertain(
          'key.k',
          `${O} reads 'context.resources.rate.x', which may be absent when this step remembers ('x' is only in default_output, which the step records only when it takes its default answer); when it is absent, the step remembers nothing.${at(t)}`,
        ),
    ],
  ];
  for (const [cause, text, expected] of cells) {
    it(cause, () => {
      // (a) red when the cause's sentence changes or is lost; (b) prints the findings.
      expect(judge(text).findings).toEqual([expected(text)]);
    });
  }

  it('undeclared_param: an open params_schema that does not declare the parameter', () => {
    const text = wf(RATE, writer('{ k: run.params.other }')).replace(
      '  additionalProperties: false\n  properties:\n    email',
      '  properties:\n    email',
    );
    // (a) red when the sentence changes or is lost; (b) prints the findings.
    expect(judge(text).findings).toEqual([
      uncertain(
        'key.k',
        `${O} reads 'run.params.other', which params_schema does not declare; when it is absent, the step remembers nothing.${at(text)}`,
      ),
    ]);
  });
});
