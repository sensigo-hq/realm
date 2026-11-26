// Fix 1, unit 1 (data paths): an `input_map` path that can never be found is refused when the file
// is checked; one that may be absent is warned; one into data the workflow declares no shape for is
// listed as not checked. These cells drive the loader (`loadWorkflowFromStringWithDiagnostics`)
// and, for the sets the design is keyed on, the resolver itself (`resolveReference`). The command
// cells (validate, register, watch, run) are in the CLI's validate-input-map-paths.test.ts.
//
// Each check names the break that turns it red (`plans/ai-authoring` prompt, acceptance checks).
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import { INPUT_MAP_SURFACE, resolveReference, type PathWorkflow } from './path-resolver.js';

const CODES = new Set(['INPUT_MAP_PATH_UNRESOLVABLE', 'INPUT_MAP_PATH_UNCERTAIN']);

/** The loader's input_map path findings for `yaml`: messages, codes and the not-checked list. */
function findings(yaml: string) {
  const { warnings, notChecked } = loadWorkflowFromStringWithDiagnostics(yaml);
  const ours = warnings.filter((w) => CODES.has(w.code));
  return {
    ours,
    messages: ours.map((w) => w.message),
    codes: ours.map((w) => w.code),
    notChecked,
  };
}

/** The 1-based line of the first line of `yaml` that contains `needle`. */
function lineOf(yaml: string, needle: string): number {
  const index = yaml.split('\n').findIndex((l) => l.includes(needle));
  if (index < 0) throw new Error(`fixture has no line with ${needle}`);
  return index + 1;
}

/** A workflow with these steps (each already indented two spaces) and optional top-level lines. */
function wf(steps: string, top = ''): string {
  return `id: w\nname: W\nversion: 1\n${top}steps:\n${steps}`;
}

/** An agent step `propose` whose answer is closed: `amount_cents` (required) and `note`. */
const PROPOSE = `  propose:
    description: propose a refund
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [amount_cents]
      properties:
        amount_cents: { type: integer }
        note: { type: string }
`;

/** A handler step `refund` after `propose`, reading one path under the key `amount`. */
function reader(path: string, extra = ''): string {
  return `  refund:
    description: send it
    execution: auto
    handler: send_refund
    depends_on: [propose]
${extra}    input_map:
      amount: '${path}'
`;
}

const UNRESOLVABLE = 'INPUT_MAP_PATH_UNRESOLVABLE';
const UNCERTAIN = 'INPUT_MAP_PATH_UNCERTAIN';
/** Row 1/2's sentence, before the fix. */
const NEVER_START =
  "which can never be found: a path starts with 'run.params.' or 'context.resources.<step>.'.";

describe('fix 1, unit 1 — check 2: row 1, a path that starts with neither root', () => {
  const steps = (path: string): string =>
    `  review:
    description: review
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [verdict]
      properties:
        verdict: { type: string }
  refund:
    description: send it
    execution: auto
    handler: send_refund
    depends_on: [review]
    input_map:
      verdict: ${path}
`;

  it("#647's form, `review.verdict` where `review` is a step: refused, the fix under context.resources", () => {
    const yaml = wf(steps('review.verdict'));
    const f = findings(yaml);
    // (1) red when the `<s>.<f>` rewrite is removed: the message ends without "Write it as";
    //     (2) prints both message lists.
    expect(f.messages).toEqual([
      `Step 'refund': input_map 'verdict' reads 'review.verdict', ${NEVER_START} Write it as ` +
        `'context.resources.review.verdict'. (line ${lineOf(yaml, 'verdict: review.verdict')})`,
    ]);
    expect(f.codes).toEqual([UNRESOLVABLE]);
  });

  it('twin: `reveiw.verdict` names no step, so it is refused with no fix', () => {
    const yaml = wf(steps('reveiw.verdict'));
    // (1) red when a fix is guessed for a name that is not a step; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      `Step 'refund': input_map 'verdict' reads 'reveiw.verdict', ${NEVER_START} ` +
        `(line ${lineOf(yaml, 'verdict: reveiw.verdict')})`,
    ]);
  });

  it("GitHub's form, `steps.<s>.output(s).<f>`: refused, the fix under context.resources", () => {
    for (const word of ['output', 'outputs']) {
      const yaml = wf(steps(`steps.review.${word}.verdict`));
      // (1) red when the steps.<s>.output(s) rewrite is removed; (2) prints both lists.
      expect(findings(yaml).messages).toEqual([
        `Step 'refund': input_map 'verdict' reads 'steps.review.${word}.verdict', ${NEVER_START} ` +
          `Write it as 'context.resources.review.verdict'. (line ${lineOf(yaml, 'verdict: steps.')})`,
      ]);
    }
  });
});

describe('fix 1, unit 1 — check 3: row 2, a root word followed by the wrong word', () => {
  const PARAMS =
    'params_schema:\n  type: object\n  additionalProperties: false\n  properties:\n    order_id: { type: string }\n';

  it('`run.param.order_id`: refused with the row 2 words (no step to derive a fix from)', () => {
    const yaml = wf(PROPOSE + reader('run.param.order_id'), PARAMS);
    // (1) red when the `run.<x>` check is removed: the path is read as run.params' `order_id`,
    //     which is declared, so nothing is found wrong; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      `Step 'refund': input_map 'amount' reads 'run.param.order_id', ${NEVER_START} ` +
        `(line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });

  it('twin, `context.propose.amount_cents`: the root word then a step: refused, with the fix', () => {
    const yaml = wf(PROPOSE + reader('context.propose.amount_cents'));
    // (1) red when the `context.<x>` check is removed (`amount_cents` is then read as a step name)
    //     or when its fix is not derived from what follows the root word; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      `Step 'refund': input_map 'amount' reads 'context.propose.amount_cents', ${NEVER_START} ` +
        `Write it as 'context.resources.propose.amount_cents'. (line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });
});

describe('fix 1, unit 1 — check 4: row 3, a path written with braces', () => {
  const DRAFT = `  draft:
    description: draft
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [text]
      properties:
        text: { type: string }
`;
  const post = (leaf: string): string =>
    `  post:
    description: post
    execution: auto
    handler: post_note
    depends_on: [draft]
    input_map:
      text: '${leaf}'
`;

  it('`{{ context.resources.draft.text }}`: refused, the fix is the path without its braces', () => {
    const yaml = wf(DRAFT + post('{{ context.resources.draft.text }}'));
    // (1) red when the braces are kept in the fix; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      "Step 'post': input_map 'text' is '{{ context.resources.draft.text }}': input_map takes a " +
        'path, not a template, so the braces make it a path that can never be found. Write it as ' +
        `'context.resources.draft.text'. (line ${lineOf(yaml, "text: '")})`,
    ]);
  });

  it('twins: `prefix {{ x }}`, and one template with a filter, are refused with no fix', () => {
    for (const leaf of [
      'prefix {{ context.resources.draft.text }}',
      '{{ context.resources.draft.text | upper }}',
    ]) {
      const yaml = wf(DRAFT + post(leaf));
      // (1) red when a fix is offered for a leaf that is not one plain `{{ x }}`; (2) prints both.
      expect(findings(yaml).messages).toEqual([
        `Step 'post': input_map 'text' is '${leaf}': input_map takes a path, not a template, so ` +
          `the braces make it a path that can never be found. (line ${lineOf(yaml, "text: '")})`,
      ]);
    }
  });
});

describe('fix 1, unit 1 — check 5: row 4, a step the workflow does not have', () => {
  // The suggestion is the loader's one did-you-mean rule (`closestKey`, diagnostics.ts): at most two
  // edits, fewer for a short name. `propsal` is three edits from `propose`, so it gets none (the
  // prompt's example; reality pinned); `propse`, one edit away, gets it.
  it('`context.resources.propse.amount`: refused, "Did you mean \'propose\'?"', () => {
    const yaml = wf(PROPOSE + reader('context.resources.propse.amount'));
    const f = findings(yaml);
    // (1) red when the did-you-mean is not computed; (2) prints both lists.
    expect(f.messages).toEqual([
      "Step 'refund': input_map 'amount' reads 'context.resources.propse.amount', but the " +
        `workflow has no step 'propse'. Did you mean 'propose'? (line ${lineOf(yaml, 'amount: ')})`,
    ]);
    // (1) red when the suggestion is left off the structured channel; (2) prints the warning.
    expect(f.ours[0]!.did_you_mean).toBe('propose');
  });

  it('`context.resources.propsal.amount` (three edits from `propose`): refused, no suggestion', () => {
    const yaml = wf(PROPOSE + reader('context.resources.propsal.amount'));
    // (1) red when the suggestion rule departs from the loader's own; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      "Step 'refund': input_map 'amount' reads 'context.resources.propsal.amount', but the " +
        `workflow has no step 'propsal'. (line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });

  it('twin: a name close to no step gets no suggestion', () => {
    const yaml = wf(PROPOSE + reader('context.resources.zzzz.amount'));
    // (1) red when a far name is "suggested"; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      "Step 'refund': input_map 'amount' reads 'context.resources.zzzz.amount', but the workflow " +
        `has no step 'zzzz'. (line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });
});

describe('fix 1, unit 1 — check 6: row 5 and the closed-level rule', () => {
  /** `propose` with `schema` (the lines under input_schema, indented six spaces). */
  const proposeWith = (schema: string): string =>
    `  propose:
    description: propose a refund
    execution: agent
    input_schema:
${schema}`;
  const ROW7 = (path: string, yaml: string): string =>
    `Step 'refund': input_map 'amount' reads '${path}', which step 'propose' does not declare; ` +
    `the step receives no value for 'amount' unless the output happens to carry it. ` +
    `(line ${lineOf(yaml, 'amount: ')})`;

  it('a closed level without the field: refused, "Did you mean \'amount_cents\'?"', () => {
    const yaml = wf(PROPOSE + reader('context.resources.propose.amount_cent'));
    const f = findings(yaml);
    // (1) red when the refusal is not computed for a closed level, or the did-you-mean is not;
    //     (2) prints both lists.
    expect(f.messages).toEqual([
      "Step 'refund': input_map 'amount' reads 'context.resources.propose.amount_cent', but step " +
        "'propose' has no field 'amount_cent' there, and its schema allows no other fields. " +
        `Did you mean 'amount_cents'? (line ${lineOf(yaml, 'amount: ')})`,
    ]);
    expect(f.codes).toEqual([UNRESOLVABLE]);
  });

  it('twin: the same schema without `additionalProperties: false` is open — row 7, a warning', () => {
    const schema = `      type: object
      required: [amount_cents]
      properties:
        amount_cents: { type: integer }
`;
    const yaml = wf(proposeWith(schema) + reader('context.resources.propose.amount_cent'));
    const f = findings(yaml);
    // (1) red when any schema is treated as closed, or `additionalProperties` is not read;
    //     (2) prints both lists.
    expect(f.messages).toEqual([ROW7('context.resources.propose.amount_cent', yaml)]);
    expect(f.codes).toEqual([UNCERTAIN]);
  });

  it('twin: a closed level that uses `anyOf` is not closed — row 7, a warning', () => {
    const schema = `      type: object
      additionalProperties: false
      properties:
        amount_cents: { type: integer }
      anyOf:
        - required: [amount_cents]
`;
    const yaml = wf(proposeWith(schema) + reader('context.resources.propose.amount_cent'));
    // (1) red when any schema is treated as closed, or the keywords are not read; (2) prints both.
    expect(findings(yaml).messages).toEqual([ROW7('context.resources.propose.amount_cent', yaml)]);
  });

  it('twin: a closed top level whose nested level is open, the miss inside it — row 7', () => {
    const schema = `      type: object
      additionalProperties: false
      required: [address]
      properties:
        address:
          type: object
          required: [zip]
          properties:
            zip: { type: string }
`;
    const yaml = wf(proposeWith(schema) + reader('context.resources.propose.address.zipp'));
    // (1) red when any schema is treated as closed, or the top level's closedness is applied to the
    //     nested level; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([ROW7('context.resources.propose.address.zipp', yaml)]);
  });

  it('control: the nested level closed too, the miss inside it is refused', () => {
    const schema = `      type: object
      additionalProperties: false
      required: [address]
      properties:
        address:
          type: object
          additionalProperties: false
          required: [zip]
          properties:
            zip: { type: string }
`;
    const yaml = wf(proposeWith(schema) + reader('context.resources.propose.address.zipp'));
    // (1) red when a nested closed level is not judged; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      "Step 'refund': input_map 'amount' reads 'context.resources.propose.address.zipp', but step " +
        "'propose' has no field 'zipp' there, and its schema allows no other fields. Did you mean " +
        `'zip'? (line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });

  // The set that keeps a level from being closed, one cell per member. The resolver is driven
  // directly: some members (`dependentSchemas`) are keywords the loader's schema check refuses.
  it.each([
    ['oneOf', { oneOf: [{ required: ['amount_cents'] }] }],
    ['anyOf', { anyOf: [{ required: ['amount_cents'] }] }],
    ['allOf', { allOf: [{ required: ['amount_cents'] }] }],
    ['$ref', { $ref: '#/$defs/x', $defs: { x: {} } }],
    ['patternProperties', { patternProperties: { '^x_': {} } }],
    ['if', { if: { required: ['amount_cents'] } }],
    ['then', { then: { required: ['amount_cents'] } }],
    ['dependentSchemas', { dependentSchemas: { amount_cents: {} } }],
  ])(
    'a closed level that uses %s is not closed: the miss may be absent, never refused',
    (_k, extra) => {
      const workflow: PathWorkflow = {
        steps: {
          propose: {
            execution: 'agent',
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: { amount_cents: { type: 'integer' } },
              ...extra,
            },
          },
          refund: { execution: 'auto', handler: 'h', depends_on: ['propose'] },
        },
      };
      // (1) red when this keyword is dropped from the set; (2) prints the judgement.
      expect(
        resolveReference(
          'context.resources.propose.amount_cent',
          INPUT_MAP_SURFACE,
          'refund',
          workflow,
        ),
      ).toEqual({
        verdict: 'may_be_absent',
        cause: { rule: 'undeclared_field', step: 'propose', didYouMean: 'amount_cents' },
      });
    },
  );
});

describe('fix 1, unit 1 — check 7: row 5, `$settlement`', () => {
  it('`$settlement.propose.failled`: refused, the $settlement words and "Did you mean \'failed\'?"', () => {
    const yaml = wf(PROPOSE + reader('context.resources.$settlement.propose.failled'));
    // (1) red when `$settlement` has no model (it is then judged as a step the workflow lacks) or
    //     its did-you-mean is not computed; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      "Step 'refund': input_map 'amount' reads 'context.resources.$settlement.propose.failled', " +
        "but '$settlement.propose' holds only 'failed', 'settled_by_default', " +
        `'validation_rejections', 'failure_kind' and 'message'. Did you mean 'failed'? (line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });

  // The three fields, written out here rather than read from the module, so a member dropped from
  // the code's set reddens its own cell.
  it.each(['failed', 'settled_by_default', 'validation_rejections'])(
    'twin: `$settlement.propose.%s` is found',
    (field) => {
      const yaml = wf(PROPOSE + reader(`context.resources.$settlement.propose.${field}`));
      // (1) red when `$settlement` has no model (the path is refused as an unknown step) or this
      //     field is dropped from its set; (2) prints both lists.
      expect(findings(yaml).messages).toEqual([]);
    },
  );

  it('`$settlement.<s>` names a step the workflow lacks: row 4 words', () => {
    const yaml = wf(PROPOSE + reader('context.resources.$settlement.propse.failed'));
    // (1) red when `<s>` under $settlement is not judged as a step name; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      "Step 'refund': input_map 'amount' reads 'context.resources.$settlement.propse.failed', but " +
        `the workflow has no step 'propse'. Did you mean 'propose'? (line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });
});

describe('fix 1, unit 1 — check 8: row 6, `run.params` against `params_schema`', () => {
  const closed =
    'params_schema:\n  type: object\n  additionalProperties: false\n  required: [order_id]\n  properties:\n    order_id: { type: string }\n';

  it('`run.params.ordr_id`, a closed params_schema: refused, "Did you mean \'order_id\'?"', () => {
    const yaml = wf(PROPOSE + reader('run.params.ordr_id'), closed);
    // (1) red when params_schema is not read (the path is then not checked); (2) prints both.
    expect(findings(yaml).messages).toEqual([
      "Step 'refund': input_map 'amount' reads 'run.params.ordr_id', but params_schema has no " +
        `parameter 'ordr_id' and allows no others. Did you mean 'order_id'? (line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });

  it('twin: no params_schema at all — not checked, no warning', () => {
    const yaml = wf(PROPOSE + reader('run.params.ordr_id'));
    const f = findings(yaml);
    // (1) red when a path into undeclared params is judged; (2) prints both values.
    expect(f.messages).toEqual([]);
    expect(f.notChecked).toEqual([
      {
        surface: 'input_map',
        step: 'refund',
        key: 'amount',
        path: 'run.params.ordr_id',
        why: 'no_params_schema',
      },
    ]);
  });

  it('twin: an open params_schema without the parameter — row 7, the params words', () => {
    const open = 'params_schema:\n  type: object\n  properties:\n    order_id: { type: string }\n';
    const yaml = wf(PROPOSE + reader('run.params.ordr_id'), open);
    // (1) red when an open params_schema refuses, or the params words change; (2) prints both.
    expect(findings(yaml).messages).toEqual([
      "Step 'refund': input_map 'amount' reads 'run.params.ordr_id', which params_schema does not " +
        "declare; the step receives no value for 'amount' unless the run's params carry it. " +
        `(line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });

  it('twin: a declared parameter that is not required — row 9, "optional in its schema"', () => {
    const optional =
      'params_schema:\n  type: object\n  additionalProperties: false\n  properties:\n    order_id: { type: string }\n';
    const yaml = wf(PROPOSE + reader('run.params.order_id'), optional);
    // (1) red when an optional parameter is not warned, or the `<why>` changes; (2) prints both.
    expect(findings(yaml).messages).toEqual([
      "Step 'refund': input_map 'amount' reads 'run.params.order_id', which may be absent when " +
        "this step runs ('order_id' is optional in its schema); the step then receives no value " +
        `for 'amount'. (line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });
});

describe('fix 1, unit 1 — check 9: row 8, a step that is not a dependency, itself, or later', () => {
  const OTHER = `  other:
    description: other
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [x]
      properties:
        x: { type: string }
`;

  it("a step outside the reader's ancestry: a warning, the row 8 words", () => {
    const yaml = wf(PROPOSE + OTHER + reader('context.resources.other.x'));
    const f = findings(yaml);
    // (1) red when the ancestry is not computed; (2) prints both lists.
    expect(f.messages).toEqual([
      "Step 'refund': input_map 'amount' reads step 'other', which this step does not depend on, " +
        "so it may not have run yet; add 'other' to depends_on if this step needs it. " +
        `(line ${lineOf(yaml, 'amount: ')})`,
    ]);
    // (1) red when the finding refuses rather than warns; (2) prints the codes.
    expect(f.codes).toEqual([UNCERTAIN]);
  });

  it('twin: the step reading its own output gets the row 8b words', () => {
    const yaml = wf(PROPOSE + reader('context.resources.refund.x'));
    // (1) red when the reader itself is not row 8b; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      "Step 'refund': input_map 'amount' reads step 'refund', which runs after this step, so it " +
        `has no output when this step's input is built. (line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });

  it('twin: a step that depends on the reader gets the row 8b words', () => {
    const later = `  notify:
    description: notify
    execution: agent
    depends_on: [refund]
    input_schema:
      type: object
      properties:
        y: { type: string }
`;
    const yaml = wf(PROPOSE + reader('context.resources.notify.y') + later);
    // (1) red when a later step is named "not a dependency"; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      "Step 'refund': input_map 'amount' reads step 'notify', which runs after this step, so it " +
        `has no output when this step's input is built. (line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });
});

describe("fix 1, unit 1 — check 10: row 9, a producer the reader's trigger rules may run without", () => {
  /** An agent step `name` with a closed answer `{ f }`; `extra` lines go under `execution`. */
  const producer = (name: string, extra = ''): string =>
    `  ${name}:
    description: ${name}
    execution: agent
${extra}    input_schema:
      type: object
      additionalProperties: false
      required: [f]
      properties:
        f: { type: string }
`;
  const readerOf = (deps: string, rule?: string): string =>
    `  reader:
    description: reader
    execution: auto
    handler: h
    depends_on: [${deps}]
${rule !== undefined ? `    trigger_rule: ${rule}\n` : ''}    input_map:
      value: context.resources.p.f
`;
  const P = producer('p', "    when: 'run.params.go == true'\n");

  it('a reader with `trigger_rule: none_failed` over a producer with its own `when`: a warning', () => {
    const yaml = wf(P + readerOf('p', 'none_failed'));
    // (1) red when the trigger-rule condition is not applied to the reader; (2) prints both.
    expect(findings(yaml).messages).toEqual([
      "Step 'reader': input_map 'value' reads 'context.resources.p.f', which may be absent when " +
        "this step runs (this step's trigger_rule lets it run when 'p' did not complete); " +
        `the step then receives no value for 'value'. (line ${lineOf(yaml, 'value: ')})`,
    ]);
  });

  it('a step in between with a lenient rule: the warning names it', () => {
    const yaml = wf(
      P + producer('m', '    depends_on: [p]\n    trigger_rule: none_failed\n') + readerOf('m'),
    );
    // (1) red when the nearest lenient step is not named; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      "Step 'reader': input_map 'value' reads 'context.resources.p.f', which may be absent when " +
        "this step runs (step 'm''s trigger_rule lets it run when 'p' did not complete); " +
        `the step then receives no value for 'value'. (line ${lineOf(yaml, 'value: ')})`,
    ]);
  });

  it('twin: `all_success` all the way down — no finding', () => {
    const yaml = wf(P + producer('m', '    depends_on: [p]\n') + readerOf('m'));
    // (1) red when the trigger-rule condition is removed (every skippable producer warned);
    //     (2) prints both lists.
    expect(findings(yaml).messages).toEqual([]);
  });

  it('third twin: a direct `all_success` dependency on `p`, and also a lenient path to it — no finding', () => {
    const yaml = wf(
      P + producer('m', '    depends_on: [p]\n    trigger_rule: none_failed\n') + readerOf('p, m'),
    );
    // (1) red when any lenient path warns (the rule needs one all-`all_success` path, not every
    //     path); (2) prints both lists.
    expect(findings(yaml).messages).toEqual([]);
  });

  it("the producer's own trigger rule does not count: the reader's `all_success` needs it completed", () => {
    // `p` runs under `all_done` after `q`; the reader runs only once `p` is in completed_steps
    // (AA-MA4-01), so p's output exists whatever p's own rule.
    const yaml = wf(
      producer('q') +
        producer('p', '    depends_on: [q]\n    trigger_rule: all_done\n') +
        readerOf('p'),
    );
    // (1) red when the producer's own rule is counted on the path; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([]);
  });
});

describe('fix 1, unit 1 — check 11: row 10, data the workflow declares no shape for', () => {
  it("a field of a handler step's output, the handler having a closed input_schema: not checked, no warning", () => {
    const yaml = wf(`  fetch:
    description: fetch
    execution: auto
    handler: fetch_order
    input_schema:
      type: object
      additionalProperties: false
      properties:
        order_id: { type: string }
  refund:
    description: refund
    execution: auto
    handler: send_refund
    depends_on: [fetch]
    input_map:
      amount: context.resources.fetch.total
`);
    const f = findings(yaml);
    // (1) red when the handler's input_schema (its input) is read as its output: a refusal
    //     appears; (2) prints both values.
    expect(f.messages).toEqual([]);
    expect(f.notChecked).toEqual([
      {
        surface: 'input_map',
        step: 'refund',
        key: 'amount',
        path: 'context.resources.fetch.total',
        why: 'producer_declares_no_shape',
      },
    ]);
  });

  it('an agent step with neither schema, a guard: not checked too', () => {
    const yaml = wf(`  think:
    description: think
    execution: agent
  check:
    description: check
    execution: guard
    depends_on: [think]
    abort_unless: ['think.ok == true']
  refund:
    description: refund
    execution: auto
    handler: send_refund
    depends_on: [think, check]
    input_map:
      a: context.resources.think.x
      b: context.resources.check.y
`);
    const f = findings(yaml);
    // (1) red when a step that declares no shape is judged; (2) prints both values.
    expect(f.messages).toEqual([]);
    expect(f.notChecked.map((n) => `${n.key}:${n.why}`)).toEqual([
      'a:producer_declares_no_shape',
      'b:producer_declares_no_shape',
    ]);
  });
});

describe("fix 1, unit 1 — check 12: a gated step's `choice`", () => {
  it('`context.resources.approve.choice`, approve a handler step with gate trust: found, not in not_checked', () => {
    const yaml = wf(`  approve:
    description: approve
    execution: auto
    handler: ask
    trust: human_confirmed
  refund:
    description: refund
    execution: auto
    handler: send_refund
    depends_on: [approve]
    input_map:
      decision: context.resources.approve.choice
`);
    const f = findings(yaml);
    // (1) red when `choice` is not added to gated shapes (the path is then not checked);
    //     (2) prints both values.
    expect(f.messages).toEqual([]);
    expect(f.notChecked).toEqual([]);
  });

  it('twin: a gated agent step with a closed schema that has no `choice`: `.choice` is found', () => {
    const yaml = wf(`  propose:
    description: propose
    execution: agent
    trust: human_confirmed
    input_schema:
      type: object
      additionalProperties: false
      required: [amount_cents]
      properties:
        amount_cents: { type: integer }
  refund:
    description: refund
    execution: auto
    handler: send_refund
    depends_on: [propose]
    input_map:
      decision: context.resources.propose.choice
`);
    // (1) red when `choice` is not added to gated shapes: the closed schema refuses it;
    //     (2) prints both lists.
    expect(findings(yaml).messages).toEqual([]);
  });

  it('control: the same agent step without gate trust refuses `.choice`', () => {
    const yaml = wf(`  propose:
    description: propose
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [amount_cents]
      properties:
        amount_cents: { type: integer }
  refund:
    description: refund
    execution: auto
    handler: send_refund
    depends_on: [propose]
    input_map:
      decision: context.resources.propose.choice
`);
    // (1) red when `choice` is added to every step, gated or not; (2) prints the codes.
    expect(findings(yaml).codes).toEqual([UNRESOLVABLE]);
  });
});

describe('fix 1, unit 1 — check 13: a bare step records what it did not compute', () => {
  // The worked example's shape (plans/website-049/worked-example/v6/workflow.yaml): `approve` is a
  // bare gated auto step after `draft`, whose closed answer has only `text`.
  const yaml = wf(`  draft:
    description: draft
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [text]
      properties:
        text: { type: string }
  approve:
    description: approve
    execution: auto
    depends_on: [draft]
    trust: human_confirmed
  publish:
    description: publish
    execution: auto
    handler: post_note
    depends_on: [approve]
    input_map:
      summary: context.resources.approve.summary
      text: context.resources.approve.text
      decision: context.resources.approve.choice
`);

  it('`context.resources.approve.summary`: one row 7 warning, never a refusal; `text` and `choice` found', () => {
    const f = findings(yaml);
    // (1) red when the bare step's inherited shape is treated as closed (a refusal); (2) prints
    //     both lists.
    expect(f.messages).toEqual([
      "Step 'publish': input_map 'summary' reads 'context.resources.approve.summary', which step " +
        "'approve' does not declare; the step receives no value for 'summary' unless the output " +
        `happens to carry it. (line ${lineOf(yaml, 'summary: ')})`,
    ]);
    expect(f.codes).toEqual([UNCERTAIN]);
  });
});

describe('fix 1, unit 1 — check 14: the both-schemas exception', () => {
  it('a field only `default_output` and `output_schema` carry: row 9, the default-answer `<why>`', () => {
    const yaml = wf(`  propose:
    description: propose
    execution: agent
    input_schema:
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
      mode: default
      default_output:
        amount_cents: 0
        fallback_reason: the agent could not decide
  refund:
    description: refund
    execution: auto
    handler: send_refund
    depends_on: [propose]
    input_map:
      reason: context.resources.propose.fallback_reason
`);
    // (1) red when the exception is removed: the closed input_schema refuses the path;
    //     (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      "Step 'refund': input_map 'reason' reads 'context.resources.propose.fallback_reason', which " +
        // gap 2, unit (iii), Words 7: the reason covers both ways to the default answer.
        "may be absent when this step runs ('fallback_reason' is only in default_output, which the " +
        'step records only when it takes its default answer); the step then receives no ' +
        `value for 'reason'. (line ${lineOf(yaml, '      reason: ')})`,
    ]);
  });

  it('control: without `mode: default` the same path is refused', () => {
    const yaml = wf(`  propose:
    description: propose
    execution: agent
    input_schema:
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
  refund:
    description: refund
    execution: auto
    handler: send_refund
    depends_on: [propose]
    input_map:
      reason: context.resources.propose.fallback_reason
`);
    // (1) red when the exception applies without `mode: default`; (2) prints the codes.
    expect(findings(yaml).codes).toEqual([UNRESOLVABLE]);
  });
});

describe('fix 1, unit 1 — check 15: arrays', () => {
  const yaml = (path: string): string =>
    wf(`  collect:
    description: collect
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [items]
      properties:
        items:
          type: array
          items:
            type: object
            additionalProperties: false
            required: [sku]
            properties:
              sku: { type: string }
  ship:
    description: ship
    execution: auto
    handler: ship_it
    depends_on: [collect]
    input_map:
      value: ${path}
`);

  it('`items.0.sku` into a closed items object: found, with a warning for the position', () => {
    const y = yaml('context.resources.collect.items.0.sku');
    // (1) red when a list position is not warned, or the index is not stepped into `items`;
    //     (2) prints both lists.
    expect(findings(y).messages).toEqual([
      "Step 'ship': input_map 'value' reads 'context.resources.collect.items.0.sku', which may be " +
        "absent when this step runs ('0' is a position in a list that may be shorter); the step " +
        `then receives no value for 'value'. (line ${lineOf(y, 'value: ')})`,
    ]);
  });

  it('`items.0.skew`: refused, "Did you mean \'sku\'?"', () => {
    const y = yaml('context.resources.collect.items.0.skew');
    // (1) red when a miss inside a closed items object is not refused; (2) prints both lists.
    expect(findings(y).messages).toEqual([
      "Step 'ship': input_map 'value' reads 'context.resources.collect.items.0.skew', but step " +
        "'collect' has no field 'skew' there, and its schema allows no other fields. Did you mean " +
        `'sku'? (line ${lineOf(y, 'value: ')})`,
    ]);
  });

  it('`items.length`: found', () => {
    // (1) red when `length` on a list is judged as a field; (2) prints both lists.
    expect(findings(yaml('context.resources.collect.items.length')).messages).toEqual([]);
  });
});

describe('fix 1, unit 1 — row 9, an optional property of an answer', () => {
  it('a property its schema does not require: "optional in its schema"', () => {
    const yaml = wf(PROPOSE + reader('context.resources.propose.note'));
    // (1) red when an optional property is not warned; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([
      "Step 'refund': input_map 'amount' reads 'context.resources.propose.note', which may be " +
        "absent when this step runs ('note' is optional in its schema); the step then receives no " +
        `value for 'amount'. (line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });
});

describe('fix 1, unit 1 — check 16: every finding in one pass', () => {
  it("rows 1, 4 and 6 on three leaves: three findings, in the map's order", () => {
    const yaml = wf(
      `${PROPOSE}  refund:
    description: send it
    execution: auto
    handler: send_refund
    depends_on: [propose]
    input_map:
      a: steps.propose.output.amount_cents
      b: context.resources.propsal.amount_cents
      c: run.params.ordr_id
`,
      'params_schema:\n  type: object\n  additionalProperties: false\n  properties:\n    order_id: { type: string }\n',
    );
    const f = findings(yaml);
    // (1) red when the check returns at the first finding; (2) prints the keys and codes.
    expect(f.ours.map((w) => `${w.key}:${w.code}`)).toEqual([
      `a:${UNRESOLVABLE}`,
      `b:${UNRESOLVABLE}`,
      `c:${UNRESOLVABLE}`,
    ]);
  });
});

describe('fix 1, unit 1 — what is judged, and what is not', () => {
  it("a bare step's map is inert, so it is not judged (T-18 is its home)", () => {
    const yaml = wf(`${PROPOSE}  hold:
    description: hold
    execution: auto
    depends_on: [propose]
    input_map:
      a: steps.propose.output.amount_cents
`);
    // (1) red when a map no step consumes is judged; (2) prints both lists.
    expect(findings(yaml).messages).toEqual([]);
  });

  it('a `$literal` leaf, a nested map and a whole-object path: only the nested path is judged', () => {
    const yaml = wf(`${PROPOSE}  refund:
    description: send it
    execution: auto
    handler: send_refund
    depends_on: [propose]
    input_map:
      fixed: { $literal: steps.not.a.path }
      whole: context.resources.propose
      params: run.params
      nested:
        amount: steps.propose.output.amount_cents
`);
    const f = findings(yaml);
    // (1) red when a $literal leaf or a whole-object path is judged, or the nested key chain is not
    //     dotted; (2) prints the keys.
    expect(f.ours.map((w) => w.key)).toEqual(['nested.amount']);
    expect(f.messages[0]).toContain(
      "input_map 'nested.amount' reads 'steps.propose.output.amount_cents'",
    );
  });

  it("the structured channel: code, severity, step, key, the key's position", () => {
    const yaml = wf(PROPOSE + reader('context.resources.propsal.amount'));
    const w = findings(yaml).ours[0]!;
    // (1) red when a field is left off the channel validate's --json prints; (2) prints it.
    expect({
      code: w.code,
      severity: w.severity,
      scope: w.scope,
      step: w.step,
      key: w.key,
      line: w.line,
      column: w.column,
    }).toEqual({
      code: UNRESOLVABLE,
      severity: 'error',
      scope: 'step',
      step: 'refund',
      key: 'amount',
      line: lineOf(yaml, 'amount: '),
      column: 7,
    });
  });
});
