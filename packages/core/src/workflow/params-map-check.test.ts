// Fix 1, piece 2b — a webhook's `params_map` checked against `params_schema` when the file loads, on
// the loader (`loadWorkflowFromStringWithDiagnostics`). The command cells (validate's exit, register,
// `realm listen`'s replies, the docs) are in the CLI's validate-params-map.test.ts.
//
// Each cell names the break that turns it red (prompts/ai-authoring-fix1-u2b-params-map.md).
import { describe, it, expect } from 'vitest';
import { WorkflowError } from '../types/workflow-error.js';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';

/** The loader's `params_map` findings for `yaml` (`code [key]: message`). */
function findings(yaml: string): string[] {
  return loadWorkflowFromStringWithDiagnostics(yaml)
    .warnings.filter((w) => w.code.startsWith('PARAMS_MAP_'))
    .map((w) => `${w.code} [${w.key}]: ${w.message}`);
}

/** A load the loader refuses: its errors, and the `params_map` findings riding the refusal. */
function refused(yaml: string): { errors: readonly string[]; findings: string[] } {
  try {
    loadWorkflowFromStringWithDiagnostics(yaml);
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowError);
    const e = err as WorkflowError;
    return {
      errors: e.errors ?? [],
      findings: (e.warnings ?? [])
        .filter((w) => w.code.startsWith('PARAMS_MAP_'))
        .map((w) => `${w.code} [${w.key}]: ${w.message}`),
    };
  }
  throw new Error('expected the loader to refuse the file');
}

/** The 1-based line of the first line of `yaml` that contains `needle`. */
function lineOf(yaml: string, needle: string): number {
  const index = yaml.split('\n').findIndex((l) => l.includes(needle));
  if (index < 0) throw new Error(`fixture has no line with ${needle}`);
  return index + 1;
}

/** A webhook workflow: `map` (the `params_map` lines, indented 4) and `schema` (indented 2). */
function wf(map: string | undefined, schema: string | undefined, triggerExtra = ''): string {
  return (
    `id: w\nname: W\nversion: 1\ntrigger:\n  type: webhook\n  path: /w\n  auth:\n    mode: none\n` +
    triggerExtra +
    (map !== undefined ? `  params_map:\n${map}` : '') +
    (schema !== undefined ? `params_schema:\n${schema}` : '') +
    `steps:\n  s:\n    description: s\n    execution: auto\n`
  );
}

/** A closed `params_schema` declaring `ticket_id` and `source`, with `required` when given. */
const closed = (required?: string): string =>
  `  type: object\n  additionalProperties: false\n` +
  (required !== undefined ? `  required: [${required}]\n` : '') +
  `  properties:\n    ticket_id: { type: string }\n    source: { type: string }\n`;

/** The same, open: no `additionalProperties: false`. */
const OPEN = `  type: object\n  properties:\n    ticket_id: { type: string }\n    source: { type: string }\n`;

const LISTEN =
  'so realm listen answers 400 params_invalid to every request that passes its auth, filter and ' +
  'dedup checks';
const unknown = (k: string, dym: string | undefined, yaml: string): string =>
  `PARAMS_MAP_UNKNOWN_PARAM [${k}]: trigger.params_map.${k}: params_schema has no parameter ` +
  `'${k}' and allows no others, ${LISTEN} and carries this value.` +
  (dym !== undefined ? ` Did you mean '${dym}'?` : '') +
  ` (line ${lineOf(yaml, `    ${k}:`)})`;
const unmapped = (p: string, advice: string, at: string): string =>
  `PARAMS_MAP_REQUIRED_UNMAPPED [${p}]: trigger.params_map: params_schema requires '${p}', but ` +
  `params_map does not fill it, so realm listen starts no run from this trigger: it answers 400 ` +
  `params_invalid to every request that passes its auth, filter and dedup checks. ${advice} ${at}`;
const MAP_IT = (p: string): string =>
  `Map '${p}' to a path in the request, or make it optional in params_schema.`;

describe('piece 2b — check 1: a misspelt name at a closed params_schema', () => {
  it("`tikcet_id: body.id`, `ticket_id` declared (optional): refused, \"Did you mean 'ticket_id'?\" and the key's line", () => {
    const yaml = wf('    tikcet_id: body.id\n    source: body.source\n', closed());
    // (1) red when keys are not judged; (2) prints both.
    expect(findings(yaml)).toEqual([unknown('tikcet_id', 'ticket_id', yaml)]);
  });

  it('the structured channel: scope workflow, key, line, did_you_mean, severity error', () => {
    const yaml = wf('    tikcet_id: body.id\n', closed());
    const w = loadWorkflowFromStringWithDiagnostics(yaml).warnings.find(
      (x) => x.code === 'PARAMS_MAP_UNKNOWN_PARAM',
    );
    // (1) red when the finding loses its key or position; (2) prints it.
    expect({
      severity: w?.severity,
      scope: w?.scope,
      key: w?.key,
      line: w?.line,
      did_you_mean: w?.did_you_mean,
    }).toEqual({
      severity: 'error',
      scope: 'workflow',
      key: 'tikcet_id',
      line: lineOf(yaml, '    tikcet_id:'),
      did_you_mean: 'ticket_id',
    });
  });

  it('twin: the declared name gets no finding', () => {
    // (1) red when a declared name is judged as unknown; (2) prints both.
    expect(findings(wf('    ticket_id: body.id\n', closed()))).toEqual([]);
  });

  it('twin: with `ticket_id` required, both refusals are reported', () => {
    const yaml = wf('    tikcet_id: body.id\n', closed('ticket_id'));
    // (1) red when one of the two is dropped; (2) prints both.
    expect(findings(yaml)).toEqual([
      unknown('tikcet_id', 'ticket_id', yaml),
      unmapped('ticket_id', MAP_IT('ticket_id'), `(line ${lineOf(yaml, '  params_map:')})`),
    ]);
  });

  it('twin: with `ticket_id` already mapped too, `ticket_ids` gets no did-you-mean naming it', () => {
    const yaml = wf('    ticket_id: body.id\n    ticket_ids: body.ids\n', closed());
    // (1) red when the did-you-mean runs over every declared name; (2) prints both.
    expect(findings(yaml)).toEqual([unknown('ticket_ids', undefined, yaml)]);
  });
});

describe('piece 2b — check 2: a required parameter left unfilled', () => {
  it("`params_schema` requires `source`, and `params_map` lacks it: refused, at the params_map key's line", () => {
    const yaml = wf('    ticket_id: body.id\n', closed('source'));
    // (1) red when `required` is not judged; (2) prints both.
    expect(findings(yaml)).toEqual([
      unmapped('source', MAP_IT('source'), `(line ${lineOf(yaml, '  params_map:')})`),
    ]);
  });

  it("twin: no `params_map` at all, with a required parameter: refused, at the trigger's line", () => {
    const yaml = wf(undefined, closed('source'));
    // (1) red when a missing params_map is skipped; (2) prints both.
    expect(findings(yaml)).toEqual([
      unmapped('source', MAP_IT('source'), `(trigger at line ${lineOf(yaml, 'trigger:')})`),
    ]);
  });

  it('twin: every required parameter mapped: no finding', () => {
    // (1) red when a mapped required parameter is refused; (2) prints both.
    expect(findings(wf('    source: body.source\n', closed('source')))).toEqual([]);
  });

  it('a required parameter the closed schema does not declare: the advice to declare it', () => {
    const yaml = wf('    ticket_id: body.id\n', closed('channel'));
    // (1) red when the advice says "Map it", which the closed schema would then refuse; (2) prints both.
    expect(findings(yaml)).toEqual([
      unmapped(
        'channel',
        "Declare 'channel' in params_schema's properties and map it, or remove it from required.",
        `(line ${lineOf(yaml, '  params_map:')})`,
      ),
    ]);
  });
});

describe('piece 2b — check 3: an open params_schema', () => {
  it('an undeclared name near a declared one: the warning with the did-you-mean sentence', () => {
    const yaml = wf('    tikcet_id: body.id\n', OPEN);
    // (1) red when open is treated as closed (a refusal); (2) prints both.
    expect(findings(yaml)).toEqual([
      "PARAMS_MAP_UNDECLARED_PARAM [tikcet_id]: trigger.params_map.tikcet_id: params_schema does not list 'tikcet_id' in its properties. Did you mean 'ticket_id'? As written, 'ticket_id' gets no value from the request. " +
        `(line ${lineOf(yaml, '    tikcet_id:')})`,
    ]);
  });

  it('a name near nothing: the plain warning', () => {
    const yaml = wf('    zzz: body.id\n', OPEN);
    // (1) red when open is treated as closed; (2) prints both.
    expect(findings(yaml)).toEqual([
      "PARAMS_MAP_UNDECLARED_PARAM [zzz]: trigger.params_map.zzz: params_schema does not list 'zzz' in its properties. " +
        `(line ${lineOf(yaml, '    zzz:')})`,
    ]);
  });
});

describe("piece 2b — check 4: the resolver's closed rule", () => {
  it('`additionalProperties: false` beside `patternProperties` is open: a warning, not a refusal', () => {
    const yaml = wf(
      '    zz: body.id\n',
      "  type: object\n  additionalProperties: false\n  patternProperties:\n    '^x_': { type: string }\n  properties:\n    ticket_id: { type: string }\n",
    );
    // (1) red when closed is tested as `additionalProperties === false` alone; (2) prints both.
    expect(findings(yaml)).toEqual([
      "PARAMS_MAP_UNDECLARED_PARAM [zz]: trigger.params_map.zz: params_schema does not list 'zz' in its properties. " +
        `(line ${lineOf(yaml, '    zz:')})`,
    ]);
  });
});

describe('piece 2b — check 5: nothing to judge, no second finding, one pass', () => {
  it('no `params_schema`: no finding', () => {
    // (1) red when a trigger with no params_schema is judged; (2) prints both.
    expect(findings(wf('    tikcet_id: body.id\n', undefined))).toEqual([]);
  });

  it('a `params_map` the schema refuses (a value that is not text): only that refusal', () => {
    // (1) red when the check judges a params_map the trigger's schema refuses; (2) prints both.
    expect(refused(wf('    tikcet_id: 5\n', closed()))).toEqual({
      errors: ['trigger/params_map/tikcet_id must be string'],
      findings: [],
    });
  });

  it('a trigger whose `result_map` is refused, with a misspelt `params_map` name: both findings', () => {
    const yaml = wf(
      '    tikcet_id: body.id\n',
      closed(),
      '  result_map:\n    approved: context.resources.nope.f\n',
    );
    const r = refused(yaml);
    // (1) red when the check is skipped on any trigger refusal; (2) prints both.
    expect({
      result_map: r.errors.some((e) => e.startsWith('trigger.result_map')),
      findings: r.findings,
    }).toEqual({ result_map: true, findings: [unknown('tikcet_id', 'ticket_id', yaml)] });
  });
});

describe('piece 2b, correction 1 — a `params_map:` with no entries, a closed schema with no `properties`', () => {
  it.each([
    ['its one entry commented out', '  params_map:\n    # ticket_id: body.id\n'],
    ['`params_map: ~`', '  params_map: ~\n'],
  ])('(a) a present-but-null `params_map` (%s): only the schema refusal', (_case, lines) => {
    const yaml =
      `id: w\nname: W\nversion: 1\ntrigger:\n  type: webhook\n  path: /w\n  auth:\n    mode: none\n` +
      lines +
      `params_schema:\n${closed('ticket_id')}steps:\n  s:\n    description: s\n    execution: auto\n`;
    // (1) red when a null `params_map` is read as an empty map (a second, required finding, as on
    //     d7dc655a); (2) prints both.
    expect(refused(yaml)).toEqual({ errors: ['trigger/params_map must be object'], findings: [] });
  });

  it("(b) the walk's fx2/g9: a closed `params_schema` with no `properties` refuses every mapped name", () => {
    const yaml = wf('    ticket_id: body.id\n', '  type: object\n  additionalProperties: false\n');
    // (1) red when an absent `properties` is not judged (Valid, no finding); (2) prints both.
    expect(findings(yaml)).toEqual([unknown('ticket_id', undefined, yaml)]);
  });

  it("(b) twin: `properties: [x]` (not a map) gives only the loader's schema refusal", () => {
    const r = refused(
      wf(
        '    ticket_id: body.id\n',
        '  type: object\n  additionalProperties: false\n  properties: [x]\n',
      ),
    );
    // (1) red when a `properties` that is not a map is judged; (2) prints both.
    expect({
      schema: r.errors.map((e) => e.startsWith("'params_schema' is not a valid JSON Schema")),
      findings: r.findings,
    }).toEqual({ schema: [true], findings: [] });
  });

  it('control: an open `params_schema` with no `properties` is not judged', () => {
    // (1) red when the absent-properties reading spreads to open schemas (a warning per name);
    //     (2) prints both.
    expect(findings(wf('    ticket_id: body.id\n', '  type: object\n'))).toEqual([]);
  });
});
