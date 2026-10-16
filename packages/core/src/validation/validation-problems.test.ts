// issue #759 — the composer: ONE list (Ajv's rows, Ajv's order), ONE cap, ONE count, and its two
// renderings (the SENTENCE and the LINES), plus core's reader of a refusal's list on a reply
// (`validationListOf`).
// Every row here comes from core's ONE Ajv construction (`compileSchema`). A failure prints key
// names, counts and booleans only — never a submitted value.
import { describe, it, expect } from 'vitest';
import { compileSchema } from './input-schema.js';
import {
  VALIDATION_PROBLEMS_SHOWN,
  describeValidationProblems,
  renderMore,
  renderProblemsLines,
  renderProblemsSentence,
  validationListOf,
} from './validation-problems.js';
import type { ValidationErrorFacts } from '../types/workflow-error.js';
import type { JsonSchema } from '../types/workflow-definition.js';

/** The rows core's construction reports for `data` against `schema`. */
function rowsOf(schema: JsonSchema, data: unknown): Record<string, unknown>[] {
  const validate = compileSchema(schema);
  expect(validate(data)).toBe(false);
  return (validate.errors ?? []) as unknown as Record<string, unknown>[];
}

/** A schema requiring `n` fields f01…fNN — `{}` breaks exactly `n` rules. */
const requiring = (n: number): JsonSchema => ({
  type: 'object',
  required: Array.from({ length: n }, (_, i) => `f${String(i + 1).padStart(2, '0')}`),
});

/** One answer that breaks four rules of four kinds, at the root and nested. */
const MIXED_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['a'],
  properties: {
    a: { type: 'string' },
    n: { type: 'object', properties: { m: { type: 'number' } }, additionalProperties: false },
  },
  additionalProperties: false,
};
const MIXED_ANSWER = { n: { m: 'x', stray: 1 }, extra: 1 };

describe('issue #759 — the composer (Part B)', () => {
  it("the two dialects: C37's words for a step answer, the pointer words for a run's params (red: one dialect for both)", () => {
    const rows = rowsOf(MIXED_SCHEMA, MIXED_ANSWER);
    expect({
      c37: describeValidationProblems(rows, 'c37').problems.map((p) => p.clause),
      pointer: describeValidationProblems(rows, 'pointer').problems.map((p) => p.clause),
    }).toEqual({
      c37: [
        "the input must have required property 'a'",
        "'extra' is not allowed",
        "'n.stray' is not allowed",
        "'n.m' must be number",
      ],
      pointer: [
        "(root) must have required property 'a'",
        // #759 correction 1 (C2): an extra property by its own pointer (before: `(root) must NOT
        // have additional properties`, `/n must NOT have additional properties`)
        '/extra is not allowed',
        '/n/stray is not allowed',
        '/n/m must be number',
      ],
    });
  });

  it('an extra property is NAMED, never its value (C42) — in the c37 words and in the pointer words (#759 correction 1, C2; red: the row’s `data` rendered)', () => {
    const data = { stray: 'SUBMITTED-VALUE-C42' };
    // as a verbose row would: the row carries the submitted value
    const rows = rowsOf({ type: 'object', properties: {}, additionalProperties: false }, data).map(
      (row) => ({ ...row, data }),
    );
    const clause = describeValidationProblems(rows, 'c37').problems[0]?.clause;
    const pointer = describeValidationProblems(rows, 'pointer').problems[0]?.clause;
    expect({
      clause,
      valueShown: clause?.includes('SUBMITTED'),
      pointer,
      pointerValueShown: pointer?.includes('SUBMITTED'),
    }).toEqual({
      clause: "'stray' is not allowed",
      valueShown: false,
      pointer: '/stray is not allowed',
      pointerValueShown: false,
    });
  });

  it('the pointer words escape an extra key as a JSON pointer segment, as Ajv escapes instancePath (`/` → `~1`, `~` → `~0`) (#759 correction 1, C2; red: the raw key)', () => {
    const rows = rowsOf(
      { type: 'object', properties: {}, additionalProperties: false },
      { 'a/b': 1, 'c~d': 2 },
    );
    expect(describeValidationProblems(rows, 'pointer').problems.map((p) => p.clause)).toEqual([
      '/a~1b is not allowed',
      '/c~0d is not allowed',
    ]);
  });

  // C42, one cell per keyword kind: the submitted value never reaches a clause or a LINE — even
  // when the row carries it (`data`, as a verbose Ajv row would). The SENTENCE never carries the
  // schema's allowed values; the LINES carry them for `enum` and `const` (the author's, r1.4).
  // Red per kind: render the row's `data` into the clause. `format` is absent by design: core's
  // construction has no formats and strict mode refuses the keyword at compile (F759-AUD-10).
  const V = 'SUBMITTED-VALUE-7Q';
  const kinds: Array<{ kind: string; schema: JsonSchema; data: unknown; lineValues?: string }> = [
    { kind: 'required', schema: { type: 'object', required: ['a'] }, data: { other: V } },
    {
      kind: 'type',
      schema: { type: 'object', properties: { a: { type: 'number' } } },
      data: { a: V },
    },
    {
      kind: 'additionalProperties',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      data: { extra: V },
    },
    {
      kind: 'enum',
      schema: { type: 'object', properties: { a: { enum: ['alpha', 'beta'] } } },
      data: { a: V },
      lineValues: '(allowed values: ["alpha","beta"])',
    },
    {
      kind: 'const',
      schema: { type: 'object', properties: { a: { const: 'gamma' } } },
      data: { a: V },
      lineValues: '(allowed values: ["gamma"])',
    },
    {
      kind: 'pattern',
      schema: { type: 'object', properties: { a: { type: 'string', pattern: '^[0-9]+$' } } },
      data: { a: V },
    },
    {
      kind: 'minLength',
      schema: { type: 'object', properties: { a: { type: 'string', minLength: 40 } } },
      data: { a: V },
    },
    {
      kind: 'maxLength',
      schema: { type: 'object', properties: { a: { type: 'string', maxLength: 3 } } },
      data: { a: V },
    },
    {
      kind: 'minimum',
      schema: { type: 'object', properties: { a: { type: 'number', minimum: 10 } } },
      data: { a: -7429 },
    },
    {
      kind: 'maxItems',
      schema: { type: 'object', properties: { a: { type: 'array', maxItems: 1 } } },
      data: { a: [V, V] },
    },
    {
      kind: 'uniqueItems',
      schema: { type: 'object', properties: { a: { type: 'array', uniqueItems: true } } },
      data: { a: [V, V] },
    },
    {
      // `params.propertyName` IS the submitted key: it reaches no line (rendered through Ajv's
      // message only, which names the rule).
      kind: 'propertyNames',
      schema: { type: 'object', propertyNames: { pattern: '^[a-z]+$' } },
      data: { BadKey: V },
    },
  ];
  for (const { kind, schema, data, lineValues } of kinds) {
    it(`C42 — '${kind}': no submitted value in the sentence or any LINE; allowed values in the LINES only`, () => {
      const submitted = kind === 'minimum' ? '-7429' : V;
      // as a verbose row would: every row carries the submitted value
      const rows = rowsOf(schema, data).map((row) => ({ ...row, data }));
      const result = describeValidationProblems(rows, 'c37');
      const sentence = renderProblemsSentence(result);
      const lines = renderProblemsLines(result.problems, result.more).join('\n');
      expect({
        kind,
        named: result.problems.some((p) => p.keyword === kind),
        valueInSentence: sentence.includes(submitted),
        valueInLines: lines.includes(submitted),
        keyInLines: kind === 'propertyNames' ? lines.includes('BadKey') : false,
        allowedInSentence: sentence.includes('allowed values:'),
        allowedInLines: lineValues === undefined ? false : lines.includes(lineValues),
      }).toEqual({
        kind,
        named: true,
        valueInSentence: false,
        valueInLines: false,
        keyInLines: false,
        allowedInSentence: false,
        allowedInLines: lineValues !== undefined,
      });
    });
  }

  it("the wrapper rule (r1.1): a `not` alone and a `oneOf` alone are problems in their own words; an `anyOf` beside its rules' rows is skipped, and `total` counts what is kept (reds: the unconditional skip; the raw-row count)", () => {
    const not = describeValidationProblems(
      rowsOf({ type: 'object', properties: { x: { not: { type: 'string' } } } }, { x: 's' }),
      'c37',
    );
    const oneOf = describeValidationProblems(
      rowsOf(
        { type: 'object', properties: { x: { oneOf: [{ type: 'string' }, { minLength: 1 }] } } },
        { x: 's' },
      ),
      'c37',
    );
    const anyOfRows = rowsOf(
      { type: 'object', properties: { x: { anyOf: [{ type: 'string' }, { type: 'number' }] } } },
      { x: true },
    );
    const anyOf = describeValidationProblems(anyOfRows, 'c37');
    expect({
      not: not.problems.map((p) => p.clause),
      oneOf: oneOf.problems.map((p) => p.clause),
      anyOfRawRows: anyOfRows.length,
      anyOf: anyOf.problems.map((p) => p.clause),
      anyOfTotal: anyOf.total,
    }).toEqual({
      not: ["'x' must NOT be valid"],
      oneOf: ["'x' must match exactly one schema in oneOf"],
      anyOfRawRows: 3,
      anyOf: ["'x' must be string", "'x' must be number"],
      anyOfTotal: 2,
    });
  });

  it('the cap and the remainder: 13 → ten shown, `; and 3 more`; 10 → no count; 1 → one clause, no `;` (reds: no cap; `and 0 more`; count = shown)', () => {
    const shape = (n: number) => {
      const result = describeValidationProblems(rowsOf(requiring(n), {}), 'c37');
      const sentence = renderProblemsSentence(result);
      return {
        shown: result.shown,
        total: result.total,
        more: result.more,
        clauses: sentence.split('; ').length,
        tail: sentence.split('; ').at(-1)?.startsWith('and ') ? sentence.split('; ').at(-1) : '',
      };
    };
    expect({ thirteen: shape(13), ten: shape(10), one: shape(1) }).toEqual({
      thirteen: { shown: 10, total: 13, more: 3, clauses: 11, tail: 'and 3 more' },
      ten: { shown: 10, total: 10, more: 0, clauses: 10, tail: '' },
      one: { shown: 1, total: 1, more: 0, clauses: 1, tail: '' },
    });
    expect(VALIDATION_PROBLEMS_SHOWN).toBe(10);
  });

  it('the one-order law (r1.10): problem i is row i — never re-sorted, never de-duplicated (reds: sort by path; de-duplicate equal messages)', () => {
    const rows = rowsOf(
      {
        type: 'object',
        properties: { z: { type: 'string' }, a: { type: 'string' }, m: { type: 'string' } },
      },
      { z: 1, a: 1, m: 1 },
    );
    const result = describeValidationProblems(rows, 'c37');
    expect({
      rowPaths: rows.map((r) => r['instancePath']),
      problemPaths: result.problems.map((p) => p.instancePath),
      messages: result.problems.map((p) => p.message),
    }).toEqual({
      rowPaths: ['/z', '/a', '/m'],
      problemPaths: ['/z', '/a', '/m'],
      messages: ['must be string', 'must be string', 'must be string'],
    });
  });

  it('a capped list with its carried count (r1.10): the rows past the cap are counted from the count, never recounted (red: ignore the count → `and 0 more`)', () => {
    const rows = rowsOf(requiring(13), {}).slice(0, VALIDATION_PROBLEMS_SHOWN);
    const result = describeValidationProblems(rows, 'c37', 13);
    expect({ shown: result.shown, total: result.total, more: result.more }).toEqual({
      shown: 10,
      total: 13,
      more: 3,
    });
  });

  it('no usable row → an empty sentence, so the caller keeps its own message alone (red: `and 0 more` or a stray clause)', () => {
    const none = describeValidationProblems([{ keyword: 'required' }, null, 'x'], 'c37');
    expect({
      shown: none.shown,
      total: none.total,
      sentence: renderProblemsSentence(none),
      empty: renderProblemsSentence(describeValidationProblems([], 'pointer')),
    }).toEqual({ shown: 0, total: 0, sentence: '', empty: '' });
  });

  it('`renderMore`: nothing when nothing is left out; `and N more` otherwise', () => {
    expect([renderMore(10, 10), renderMore(3, 10), renderMore(13, 10)]).toEqual([
      '',
      '',
      'and 3 more',
    ]);
  });

  it("the LINES of a record's entries carry no values and end with `and N more` from the record's count (red: a renderer recounting its entries)", () => {
    const lines = renderProblemsLines(
      [
        {
          instancePath: '/a',
          schemaPath: '#/properties/a/enum',
          keyword: 'enum',
          message: 'must be equal to one of the allowed values',
        },
        {
          instancePath: '',
          schemaPath: '#/required',
          keyword: 'required',
          message: "must have required property 'b'",
          missing_property: 'b',
        },
      ],
      11,
    );
    expect(lines).toEqual([
      '- /a: must be equal to one of the allowed values [enum]',
      "- (root): must have required property 'b' [required] (missing property: 'b')",
      'and 11 more',
    ]);
    expect(renderProblemsLines([], 0)).toEqual([]);
  });
});

describe('issue #759 — `validationListOf`, the core-side reader of a reply (Part D.2)', () => {
  const rows = [{ keyword: 'required', instancePath: '', message: 'm' }];
  const facts: ValidationErrorFacts = {
    errors: rows as never,
    error_count: 13,
    rejections: 1,
    threshold: 6,
  };
  it('per code: the typed facts for the two validation codes; the untyped bags for exhaustion and the trace; nothing for any other code (red: read `error_details.errors` for a typed code)', () => {
    const typed = (code: 'VALIDATION_INPUT_SCHEMA' | 'VALIDATION_OUTPUT_SCHEMA') =>
      validationListOf({ error_code: code, error: { remedy: [], facts } });
    const seen = {
      input: typed('VALIDATION_INPUT_SCHEMA'),
      output: typed('VALIDATION_OUTPUT_SCHEMA'),
      exhausted: validationListOf({
        error_code: 'VALIDATION_EXHAUSTED',
        error_details: { last_ajv_errors: rows, last_error_count: 13, errors: ['decoy'] },
      }),
      trace: validationListOf({
        error_code: 'VALIDATION_TRACE_SCHEMA',
        error_details: { errors: rows, error_count: 13 },
      }),
      typedWithoutFacts: validationListOf({
        error_code: 'VALIDATION_INPUT_SCHEMA',
        error_details: { errors: rows },
      }),
      other: validationListOf({ error_code: 'STEP_NOT_FOUND', error_details: { errors: rows } }),
    };
    expect(seen).toEqual({
      input: { errors: rows, error_count: 13 },
      output: { errors: rows, error_count: 13 },
      exhausted: { errors: rows, error_count: 13 },
      trace: { errors: rows, error_count: 13 },
      typedWithoutFacts: undefined,
      other: undefined,
    });
  });
});
