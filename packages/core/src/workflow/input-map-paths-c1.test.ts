// Fix 1, unit 1, correction 1 — on the loader: no refusal or warning on a path that finds a value
// (N1, D1, AA-MA4-07), a path check that never stops a load (N3), and trigger-rule words true for
// every rule (AA-MA4-06, F7). The command cells (`--json`'s `not_checked` on a refused file, the
// cycles and the long chain on the built `validate`, the line for a check that failed) are in the
// CLI's validate-input-map-paths.test.ts.
//
// Each cell names the break that turns it red (prompts/ai-authoring-fix1-u1-correction-1.md).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorkflowError } from '../types/workflow-error.js';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import { checkInputMapPaths } from './input-map-paths.js';
import { PathIndex } from './path-resolver.js';

const CODES = new Set(['INPUT_MAP_PATH_UNRESOLVABLE', 'INPUT_MAP_PATH_UNCERTAIN']);

/** The loader's input_map path findings for `yaml`: messages and the not-checked list. */
function findings(yaml: string) {
  const { warnings, notChecked } = loadWorkflowFromStringWithDiagnostics(yaml);
  return { messages: warnings.filter((w) => CODES.has(w.code)).map((w) => w.message), notChecked };
}

/**
 * The messages for `yaml`, once every leaf was judged: none is left not checked, so a leaf the check
 * failed on (`check_failed`, which a "no finding" result would otherwise hide) turns the cell red.
 */
function judged(yaml: string): string[] {
  const { messages, notChecked } = findings(yaml);
  expect(notChecked).toEqual([]);
  return messages;
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

/** An agent step `collect` whose closed answer has `field`'s schema (YAML, indented 10 spaces). */
function collect(field: string, schema: string): string {
  return `  collect:
    description: collect
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [${field}]
      properties:
        ${field}:
${schema}`;
}

/** A handler step `ship` after `collect`, reading `path` under the key `first`. */
function ship(path: string): string {
  return `  ship:
    description: ship
    execution: auto
    handler: echo
    depends_on: [collect]
    input_map:
      first: '${path}'
`;
}

/** The may-be-absent sentence for `ship`'s `first` key. */
const absent = (path: string, why: string, yaml: string): string =>
  `Step 'ship': input_map 'first' reads '${path}', which may be absent when this step runs ` +
  `(${why}); the step then receives no value for 'first'. (line ${lineOf(yaml, 'first: ')})`;

describe('correction 1 — check 1: N1, a closed level typed `[array, object]`', () => {
  // The walk's wf/fr1 (AA-WU1-10: the run delivered `{"first":"a"}` for `.items.0`).
  const ITEMS = `          type: [array, object]
          additionalProperties: false
          properties: {}
          items: { type: string }
`;

  it('`….items.0`: no refusal, the list-position warning', () => {
    const yaml = wf(collect('items', ITEMS) + ship('context.resources.collect.items.0'));
    // (1) red when the level's type is ignored, as on 30d9d718 (`.0` refused); (2) prints both.
    expect(judged(yaml)).toEqual([
      absent(
        'context.resources.collect.items.0',
        "'0' is a position in a list that may be shorter",
        yaml,
      ),
    ]);
  });

  it('twin: `….items.sku` can never be found there, so it is refused', () => {
    const yaml = wf(collect('items', ITEMS) + ship('context.resources.collect.items.sku'));
    // (1) red when any segment at a level that can hold a list is let through; (2) prints both.
    expect(judged(yaml)).toEqual([
      "Step 'ship': input_map 'first' reads 'context.resources.collect.items.sku', but step " +
        "'collect' has no field 'sku' there, and its schema allows no other fields. " +
        `(line ${lineOf(yaml, 'first: ')})`,
    ]);
  });

  it('control: a closed nested level typed `[object, null]` still refuses `.0`', () => {
    const yaml = wf(
      collect(
        'data',
        `          type: [object, 'null']
          additionalProperties: false
          properties:
            a: { type: string }
`,
      ) + ship('context.resources.collect.data.0'),
    );
    // (1) red when a level that cannot hold a list is treated as one; (2) prints both.
    expect(judged(yaml)).toEqual([
      "Step 'ship': input_map 'first' reads 'context.resources.collect.data.0', but step " +
        "'collect' has no field '0' there, and its schema allows no other fields. Did you mean " +
        `'a'? (line ${lineOf(yaml, 'first: ')})`,
    ]);
  });
});

describe('correction 1 — check 2: N1, a closed nested level with no `type`', () => {
  // The walk's wf/fr2 (AA-WU1-11: the run delivered `{"first":"x","n":2}`).
  const DATA = `          additionalProperties: false
          properties:
            a: { type: string }
`;

  it('`….data.0`: not refused, the list-position warning', () => {
    const yaml = wf(collect('data', DATA) + ship('context.resources.collect.data.0'));
    // (1) red when the level's type is ignored (`.0` refused); (2) prints both.
    expect(judged(yaml)).toEqual([
      absent(
        'context.resources.collect.data.0',
        "'0' is a position in a list that may be shorter",
        yaml,
      ),
    ]);
  });

  it("`….data.length`: not refused, row 7's words", () => {
    const yaml = wf(collect('data', DATA) + ship('context.resources.collect.data.length'));
    // (1) red when the level's type is ignored (`.length` refused); (2) prints both.
    expect(judged(yaml)).toEqual([
      "Step 'ship': input_map 'first' reads 'context.resources.collect.data.length', which step " +
        "'collect' does not declare; the step receives no value for 'first' unless the output " +
        `happens to carry it. (line ${lineOf(yaml, 'first: ')})`,
    ]);
  });

  it('twin: `….data.b` is refused, "Did you mean \'a\'?"', () => {
    const yaml = wf(collect('data', DATA) + ship('context.resources.collect.data.b'));
    // (1) red when a field miss at such a level is let through; (2) prints both.
    expect(judged(yaml)).toEqual([
      "Step 'ship': input_map 'first' reads 'context.resources.collect.data.b', but step " +
        "'collect' has no field 'b' there, and its schema allows no other fields. Did you mean " +
        `'a'? (line ${lineOf(yaml, 'first: ')})`,
    ]);
  });

  it('second twin: `context.resources.<s>.0` at a closed top level with no `type` is still refused', () => {
    const yaml = wf(
      `  collect:
    description: collect
    execution: agent
    input_schema:
      additionalProperties: false
      required: [a]
      properties:
        a: { type: string }
` + ship('context.resources.collect.0'),
    );
    // (1) red when the list rule is applied at the top of an agent's answer (a warning there);
    //     (2) prints both. `'0'` is one edit from `'a'`, so the loader's rule suggests it.
    expect(judged(yaml)).toEqual([
      "Step 'ship': input_map 'first' reads 'context.resources.collect.0', but step 'collect' " +
        "has no field '0' there, and its schema allows no other fields. Did you mean 'a'? " +
        `(line ${lineOf(yaml, 'first: ')})`,
    ]);
  });

  it("a `params_schema` top level with no `type` follows the rule: `.0` a position, `.length` row 7's param words", () => {
    const PARAMS = `params_schema:
  additionalProperties: false
  properties:
    order_id: { type: string }
`;
    const steps = `  ship:
    description: ship
    execution: auto
    handler: echo
    input_map:
      first: run.params.0
      count: run.params.length
`;
    const yaml = wf(steps, PARAMS);
    // (1) red when the params top level is exempted like an agent's answer (both refused);
    //     (2) prints both.
    expect(judged(yaml)).toEqual([
      "Step 'ship': input_map 'first' reads 'run.params.0', which may be absent when this step " +
        "runs ('0' is a position in a list that may be shorter); the step then receives no value " +
        `for 'first'. (line ${lineOf(yaml, 'first: ')})`,
      "Step 'ship': input_map 'count' reads 'run.params.length', which params_schema does not " +
        "declare; the step receives no value for 'count' unless the run's params carry it. " +
        `(line ${lineOf(yaml, 'count: ')})`,
    ]);
  });
});

/** s0, an agent step whose closed answer declares `f`, then `n` steps, each after the one before. */
function chain(n: number, step: (i: number) => string, last: string): string {
  const out = [
    'id: chain',
    'name: Chain',
    'version: 1',
    'steps:',
    '  s0:',
    '    description: s0',
    '    execution: agent',
    '    input_schema:',
    '      type: object',
    '      additionalProperties: false',
    '      required: [f]',
    '      properties:',
    '        f: { type: string }',
  ];
  for (let i = 1; i <= n; i++) out.push(step(i));
  out.push(last);
  return out.join('\n') + '\n';
}

describe('correction 1 — check 4: N3, a chain of 5,000 handler steps', () => {
  // 10,000 too: a plain recursion per step survives 5,000 steps on Node 24 when its frames are small
  // (AA-IAU1C-08), so the longer chain is the one a per-step recursion cannot pass.
  it.each([5000, 10000])(
    '%i steps: loads, and the last step reading `s0.f` gets its own judgement: no finding, not in not_checked',
    (N) => {
      const yaml = chain(
        N,
        (i) =>
          `  s${i}:\n    description: s${i}\n    execution: auto\n    handler: h\n    depends_on: [s${i - 1}]`,
        `  reader:\n    description: reader\n    execution: auto\n    handler: h\n    depends_on: [s${N}]\n    input_map:\n      v: context.resources.s0.f`,
      );
      // (1) red when the safe-path search calls itself once per step (the leaf turns
      //     `check_failed`, or the load fails); (2) prints both.
      expect(findings(yaml)).toEqual({ messages: [], notChecked: [] });
    },
    120_000,
  );
});

describe('correction 1 — check 4b: N3, a chain of 5,000 bare steps', () => {
  // 10,000 too: the shape walk called once per step survives 5,000 steps here and overflows at
  // 10,000 (AA-IAU1C-08), so the longer chain is the one that catches it.
  it.each([5000, 10000])(
    "%i steps: loads, and a handler reading the last bare step's `f` gets its own judgement: no finding",
    (N) => {
      const yaml = chain(
        N,
        (i) => `  s${i}:\n    description: s${i}\n    execution: auto\n    depends_on: [s${i - 1}]`,
        `  reader:\n    description: reader\n    execution: auto\n    handler: h\n    depends_on: [s${N}]\n    input_map:\n      v: context.resources.s${N}.f`,
      );
      // (1) red when the shape walk calls itself once per step (on 30d9d718 it overflows at 5,000,
      //     AA-AUC1U-06; called once per step here, at 10,000); (2) prints both.
      expect(findings(yaml)).toEqual({ messages: [], notChecked: [] });
    },
    120_000,
  );
});

describe('correction 1 — check 4d: N3, the answers built once for every leaf', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("every leaf of the walk's 1,000-step chain (each step reading s0) is judged over one shared index", () => {
    const N = 999;
    const yaml = chain(
      N,
      (i) =>
        `  s${i}:\n    description: s${i}\n    execution: auto\n    handler: h\n    depends_on: [s${i - 1}]\n    input_map:\n      v: context.resources.s0.f`,
      '',
    );
    const indexes = new Set<PathIndex>();
    const original = PathIndex.prototype.stepCause;
    vi.spyOn(PathIndex.prototype, 'stepCause').mockImplementation(function (
      this: PathIndex,
      reader: string,
      s: string,
      settlement: boolean,
    ) {
      indexes.add(this);
      return original.call(this, reader, s, settlement);
    });
    const started = Date.now();
    const result = findings(yaml);
    // (1) red when each leaf builds a fresh set of answers (999 indexes); (2) prints the count and
    //     the findings.
    expect({ indexes: indexes.size, ...result }).toEqual({
      indexes: 1,
      messages: [],
      notChecked: [],
    });
    // (1) red when the per-leaf work grows with the chain again (65 s on 30d9d718, AA-WU1-15);
    //     (2) prints the time.
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

describe('correction 1 — check 5: N3, a throw while judging never stops a load', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const TWO = wf(`  fetch:
    description: fetch
    execution: auto
    handler: h
  propose:
    description: propose
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [amount_cents]
      properties:
        amount_cents: { type: integer }
  bad:
    description: bad
    execution: auto
    handler: h
    depends_on: [propose]
    input_map:
      x: context.resources.propose.amount_cents
  good:
    description: good
    execution: auto
    handler: h
    depends_on: [fetch]
    input_map:
      y: context.resources.propose.amount_cents
      z: context.resources.fetch.total
`);

  it('a leaf whose judgement throws is `check_failed`; the load succeeds and the other leaves keep their findings', () => {
    // The injection: the shared index's step-cause answer throws for the step 'bad' only.
    const original = PathIndex.prototype.stepCause;
    vi.spyOn(PathIndex.prototype, 'stepCause').mockImplementation(function (
      this: PathIndex,
      reader: string,
      s: string,
      settlement: boolean,
    ) {
      if (reader === 'bad') throw new Error('planted: a bug in the path check');
      return original.call(this, reader, s, settlement);
    });
    // (1) red when there is no catch (the load throws); (2) prints both.
    expect(findings(TWO)).toEqual({
      messages: [
        "Step 'good': input_map 'y' reads step 'propose', which this step does not depend on, so " +
          "it may not have run yet; add 'propose' to depends_on if this step needs it. " +
          `(line ${lineOf(TWO, 'y: ')})`,
      ],
      notChecked: [
        {
          step: 'bad',
          key: 'x',
          path: 'context.resources.propose.amount_cents',
          why: 'check_failed',
        },
        {
          step: 'good',
          key: 'z',
          path: 'context.resources.fetch.total',
          why: 'producer_declares_no_shape',
        },
      ],
    });
  });

  it('a throw while building the shared answers lists every consumed leaf as `check_failed`', () => {
    // The injection: a step whose `depends_on` throws when read. YAML cannot make one, so the
    // checker is called directly, as the loader calls it.
    const propose = {
      description: 'propose',
      execution: 'agent',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: { amount_cents: { type: 'integer' } },
      },
    };
    const broken = {
      description: 'broken',
      execution: 'auto',
      handler: 'h',
      input_map: { a: 'context.resources.propose.amount_cents', b: 'run.params.x' },
      get depends_on(): string[] {
        throw new Error('planted: a bug while building the answers');
      },
    };
    // (1) red when building the answers is not caught (the check throws); (2) prints the result.
    expect(checkInputMapPaths({ steps: { propose, broken } }, () => undefined)).toEqual({
      warnings: [],
      notChecked: [
        {
          step: 'broken',
          key: 'a',
          path: 'context.resources.propose.amount_cents',
          why: 'check_failed',
        },
        { step: 'broken', key: 'b', path: 'run.params.x', why: 'check_failed' },
      ],
    });
  });
});

/** A producer `p` (an agent step with a closed answer declaring `f`) and a reader of `path`. */
function graph(readerDeps: string, rule: string | undefined, path: string, extra = ''): string {
  return wf(`  p:
    description: p
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [f]
      properties:
        f: { type: string }
  q:
    description: q
    execution: auto
    handler: h
${extra}  reader:
    description: reader
    execution: auto
    handler: h
    depends_on: [${readerDeps}]
${rule !== undefined ? `    trigger_rule: ${rule}\n` : ''}    input_map:
      value: ${path}
`);
}

/** Row 9's sentence for the reader's `value` key. */
const row9 = (path: string, why: string, yaml: string): string =>
  `Step 'reader': input_map 'value' reads '${path}', which may be absent when this step runs ` +
  `(${why}); the step then receives no value for 'value'. (line ${lineOf(yaml, 'value: ')})`;

describe('correction 1 — check 6: the trigger-rule words', () => {
  it("a reader with `trigger_rule: none_failed` over `p`, on a field path: 'did not complete'", () => {
    const yaml = graph('p', 'none_failed', 'context.resources.p.f');
    // (1) red with the old words ("failed or was skipped", false under none_failed, AA-MA4-06);
    //     (2) prints both.
    expect(judged(yaml)).toEqual([
      row9(
        'context.resources.p.f',
        "this step's trigger_rule lets it run when 'p' did not complete",
        yaml,
      ),
    ]);
  });
});

describe('correction 1 — check 6b: `one_success` with one dependency', () => {
  it('the producer as its only dependency: no finding', () => {
    const yaml = graph('p', 'one_success', 'context.resources.p.f');
    // (1) red when `one_success` is never counted as safe (it warns, as on 30d9d718);
    //     (2) prints both.
    expect(judged(yaml)).toEqual([]);
  });

  it('twin: with a second dependency it gets the warning', () => {
    const yaml = graph('p, q', 'one_success', 'context.resources.p.f');
    // (1) red when `one_success` is counted as safe whatever its dependencies; (2) prints both.
    expect(judged(yaml)).toEqual([
      row9(
        'context.resources.p.f',
        "this step's trigger_rule lets it run when 'p' did not complete",
        yaml,
      ),
    ]);
  });
});

describe('correction 1 — check 6c: `$settlement` under the rules that run only after a failure (D1)', () => {
  const SETTLED = 'context.resources.$settlement.p.failed';

  it('`all_failed` over `p`, reading `$settlement.p.failed`: no finding', () => {
    // (1) red when the $settlement rule is not applied (it warns, as on 30d9d718); (2) prints both.
    expect(judged(graph('p', 'all_failed', SETTLED))).toEqual([]);
  });

  it('`one_failed` over `p` alone: no finding', () => {
    // (1) red when the $settlement rule is not applied; (2) prints both.
    expect(judged(graph('p', 'one_failed', SETTLED))).toEqual([]);
  });

  it('control: `one_failed` over `p` and `q` warns, `p` may have been skipped', () => {
    const yaml = graph('p, q', 'one_failed', SETTLED);
    // (1) red when `one_failed` counts whatever its dependencies; (2) prints both.
    expect(judged(yaml)).toEqual([
      row9(SETTLED, "this step's trigger_rule lets it run when 'p' did not complete", yaml),
    ]);
  });

  it('twin: the same read under `all_done` warns, with the new words (a skipped step has no entry)', () => {
    const yaml = graph('p', 'all_done', SETTLED);
    // (1) red when `all_done` is counted as safe, or with the old words; (2) prints both.
    expect(judged(yaml)).toEqual([
      row9(SETTLED, "this step's trigger_rule lets it run when 'p' did not complete", yaml),
    ]);
  });

  it('second twin: a field path `context.resources.p.f` under `all_failed` still warns', () => {
    const yaml = graph('p', 'all_failed', 'context.resources.p.f');
    // (1) red when the $settlement rule is applied to a field path; (2) prints both.
    expect(judged(yaml)).toEqual([
      row9(
        'context.resources.p.f',
        "this step's trigger_rule lets it run when 'p' did not complete",
        yaml,
      ),
    ]);
  });

  it('third twin, a step in between: `all_success` over `x`, where `x` has `all_failed` over `p`: no finding', () => {
    // The audit's r2/settle-between (AA-AUC1U-28: on 30d9d718 it warns, naming step 'x''s).
    const yaml = graph(
      'x',
      undefined,
      SETTLED,
      `  x:
    description: x
    execution: auto
    handler: h
    depends_on: [p]
    trigger_rule: all_failed
`,
    );
    // (1) red when the rule is applied only to the reader's own trigger_rule; (2) prints both.
    expect(judged(yaml)).toEqual([]);
  });
});

describe('correction 1 — check 6d: the step a warning names follows the same rule (F7)', () => {
  it("`one_success` over `m` alone, `m` with `none_failed` over `p`: the warning names step 'm''s", () => {
    const yaml = graph(
      'm',
      'one_success',
      'context.resources.p.f',
      `  m:
    description: m
    execution: auto
    handler: h
    depends_on: [p]
    trigger_rule: none_failed
`,
    );
    // (1) red when the naming search keeps testing `all_success` alone (the warning says "this
    //     step's"); (2) prints both.
    expect(judged(yaml)).toEqual([
      row9(
        'context.resources.p.f',
        "step 'm''s trigger_rule lets it run when 'p' did not complete",
        yaml,
      ),
    ]);
  });
});

describe('correction 1 — check 7: a `uses_service` reader', () => {
  it('its map is judged: a path that can never be found in it is refused', () => {
    const yaml = wf(
      `  propose:
    description: propose
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [amount_cents]
      properties:
        amount_cents: { type: integer }
  push:
    description: push
    execution: auto
    uses_service: airtable
    service_method: fetch
    operation: list_records
    depends_on: [propose]
    input_map:
      amount: steps.propose.output.amount_cents
`,
      `services:
  airtable:
    adapter: airtable
    trust: engine_delivered
`,
    );
    // (1) red when the walk skips `uses_service` steps; (2) prints both.
    expect(judged(yaml)).toEqual([
      "Step 'push': input_map 'amount' reads 'steps.propose.output.amount_cents', which can never " +
        "be found: a path starts with 'run.params.' or 'context.resources.<step>.'. Write it as " +
        `'context.resources.propose.amount_cents'. (line ${lineOf(yaml, 'amount: ')})`,
    ]);
  });
});

describe('correction 1 — check 8: one pass beside another refusal', () => {
  it('an unknown `depends_on` and a path that can never be found are both reported by one load', () => {
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
    handler: h
    depends_on: [propose, nowhere]
    input_map:
      amount: steps.propose.output.amount_cents
`);
    let caught: unknown;
    try {
      loadWorkflowFromStringWithDiagnostics(yaml);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowError);
    const err = caught as WorkflowError;
    // (1) red when the path check runs after the loader's error throw (no finding rides the
    //     refusal); (2) prints both lists.
    expect({
      errors: (err.errors ?? []).filter((e) => e.includes('nowhere')).length,
      findings: (err.warnings ?? []).filter((w) => CODES.has(w.code)).map((w) => w.code),
    }).toEqual({ errors: 1, findings: ['INPUT_MAP_PATH_UNRESOLVABLE'] });
  });
});
