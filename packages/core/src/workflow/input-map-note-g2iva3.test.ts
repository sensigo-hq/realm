// input-map-note-g2iva3.test.ts — gap 2, unit (iv-a3), at the loader: the note returned when a
// step's `input_map` hands it a failure message (`context.resources.$settlement.<step>.message`, or
// a shorter path that holds it), by the same rule as the prompt note (`holdsFailureMessages`).
//
// Whatever such a step copies of the message into its output is shown to assistants even under
// `--failure-text hidden`; the note tells the author so. It is never a warning. Validate's cells
// (text, `--json`, `--strict`) are the CLI's commands/validate-notes-g2iva3.test.ts.
//
// Every assertion carries (a) the break that turns it red and (b) what it prints.
import { describe, expect, it } from 'vitest';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';

/** The load's warning codes and its notes as `step|placement|reads|message`. */
function load(yaml: string): { codes: string[]; notes: string[]; refused: boolean } {
  const r = loadWorkflowFromStringWithDiagnostics(yaml);
  return {
    codes: r.warnings.map((w) => w.code),
    notes: r.notes.map((n) => `${n.step}|${n.placement}|${n.reads}|${n.message}`),
    refused: r.warnings.some((w) => w.severity === 'error'),
  };
}

/** `fetch` (an auto step with a handler), then `reader`, holding `lines`. */
const workflow = (lines: string[], opts: { rule?: string; extraSteps?: string[] } = {}): string =>
  [
    'id: g2iva3-notes',
    'name: g2iva3 notes',
    'version: 1',
    'steps:',
    '  fetch:',
    '    description: Fetch.',
    '    execution: auto',
    '    handler: h',
    ...(opts.extraSteps ?? []),
    '  reader:',
    '    description: Read it.',
    '    execution: auto',
    '    handler: h',
    '    depends_on: [fetch]',
    ...(opts.rule !== undefined ? [`    trigger_rule: ${opts.rule}`] : []),
    ...lines,
    '',
  ].join('\n');

const FIELD = 'context.resources.$settlement.fetch.message';
/** Words 1, on step `reader`. */
const NOTE = (reads: string, key: string): string =>
  `reader|input_map|${reads}|Step 'reader' is handed a failure message (\`${reads}\`) in its input_map at '${key}': the text is the failure's own, and whatever the step copies of it into its output is shown to assistants even under --failure-text hidden.`;

describe('gap 2 (iv-a3), behaviour 1 — one note per leaf that holds a failure message', () => {
  it('the field, the whole entry and context.resources: one note each, in the map’s order', () => {
    const got = load(
      workflow(
        [
          '    input_map:',
          `      why: ${FIELD}`,
          '      entry: context.resources.$settlement.fetch',
          '      everything: context.resources',
        ],
        { rule: 'one_failed' },
      ),
    );
    // (a) red when the note is not built for input_map leaves, built for the exact field only, or
    //     not returned on the loader's result; (b) prints the warnings and the notes.
    expect({ codes: got.codes, notes: got.notes }).toEqual({
      codes: [],
      notes: [
        NOTE(FIELD, 'why'),
        NOTE('context.resources.$settlement.fetch', 'entry'),
        NOTE('context.resources', 'everything'),
      ],
    });
  });

  it('a leaf written with spaces around it: `reads` is the path trimmed', () => {
    const got = load(
      workflow(['    input_map:', `      why: "  ${FIELD}  "`], { rule: 'one_failed' }),
    );
    // (a) red when `reads` keeps the spaces; (b) prints the notes.
    expect(got.notes).toEqual([NOTE(FIELD, 'why')]);
  });
});

describe('gap 2 (iv-a3), behaviours 2 and 3 — a refused leaf, and a may-be-absent one', () => {
  it('a leaf the loader refuses (a step that does not exist) gets no note', () => {
    const got = load(
      workflow(['    input_map:', '      why: context.resources.$settlement.nostep.message']),
    );
    // (a) red when the refusal condition is removed (the refused leaf gets a note); (b) prints the
    //     refusal flag and the notes.
    expect({ refused: got.refused, codes: got.codes, notes: got.notes }).toEqual({
      refused: true,
      codes: ['INPUT_MAP_PATH_UNRESOLVABLE'],
      notes: [],
    });
  });

  it('a leaf with a may-be-absent warning (the reader can run when fetch completed): the warning and the note', () => {
    const got = load(workflow(['    input_map:', `      why: ${FIELD}`]));
    // (a) red when the note is built only when the leaf has no warning; (b) prints both.
    expect({ codes: got.codes, notes: got.notes }).toEqual({
      codes: ['INPUT_MAP_PATH_UNCERTAIN'],
      notes: [NOTE(FIELD, 'why')],
    });
  });
});

describe('gap 2 (iv-a3), behaviours 4 to 6 — what gets no note, and the key a nested leaf names', () => {
  it.each([
    ['failure_kind', 'context.resources.$settlement.fetch.failure_kind'],
    ['failed', 'context.resources.$settlement.fetch.failed'],
  ])('a leaf reading another $settlement field (%s): no note', (_n, path) => {
    const got = load(workflow(['    input_map:', `      kind: ${path}`], { rule: 'one_failed' }));
    // (a) red when any $settlement path gets the note; (b) prints the notes.
    expect(got.notes).toEqual([]);
  });

  it('a leaf inside a nested map: the key is the chain joined by a dot', () => {
    const got = load(
      workflow(['    input_map:', '      outer:', '        inner:', `          why: ${FIELD}`], {
        rule: 'one_failed',
      }),
    );
    // (a) red when the note names the top-level key only; (b) prints the notes.
    expect(got.notes).toEqual([NOTE(FIELD, 'outer.inner.why')]);
  });

  it('an input_map on a step that does not use it (an auto step with no handler): no note', () => {
    const got = load(
      [
        'id: g2iva3-bare',
        'name: g2iva3 bare',
        'version: 1',
        'steps:',
        '  fetch:',
        '    description: Fetch.',
        '    execution: auto',
        '    handler: h',
        '  hold:',
        '    description: Hold.',
        '    execution: auto',
        '    depends_on: [fetch]',
        '    trigger_rule: one_failed',
        '    input_map:',
        `      why: ${FIELD}`,
        '',
      ].join('\n'),
    );
    // (a) red when a map the step does not consume is walked for notes; (b) prints the notes.
    expect(got.notes).toEqual([]);
  });
});

describe('gap 2 (iv-a3), behaviour 7 — both kinds of note in one file', () => {
  it('the input_map notes come first, step by step, then the prompt notes', () => {
    // `explain` (a prompt note) comes before `reader` in the file; `later` holds a second map.
    const EXPLAIN = [
      '  explain:',
      '    description: Explain.',
      '    execution: agent',
      '    depends_on: [fetch]',
      '    trigger_rule: one_failed',
      `    prompt: "Why: {{ ${FIELD} }}"`,
    ];
    const LATER = [
      '  later:',
      '    description: Later.',
      '    execution: auto',
      '    handler: h',
      '    depends_on: [fetch]',
      '    trigger_rule: one_failed',
      '    input_map:',
      `      again: ${FIELD}`,
    ];
    const yaml = workflow(['    input_map:', `      why: ${FIELD}`, ...LATER], {
      rule: 'one_failed',
      extraSteps: EXPLAIN,
    });
    const got = load(yaml);
    // (a) red when the input_map notes are pushed after the template notes, or out of step order;
    //     (b) prints the notes' step and placement.
    expect(got.notes.map((n) => n.split('|').slice(0, 2).join('|'))).toEqual([
      'reader|input_map',
      'later|input_map',
      'explain|prompt',
    ]);
  });
});
