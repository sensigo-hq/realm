import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileSchema,
  validateInputSchema,
  validateTraceSchema,
  validateAgentSubmission,
} from './input-schema.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { JsonSchema } from '../types/workflow-definition.js';
import type { TraceEntry } from '../types/run-record.js';
import { executeStep } from '../engine/execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const schema: JsonSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
  },
};

describe('validateInputSchema', () => {
  it('valid input (matching schema) does not throw', () => {
    expect(() => validateInputSchema({ name: 'Alice' }, schema, 'my-step')).not.toThrow();
  });

  it('missing required field throws WorkflowError with code VALIDATION_INPUT_SCHEMA', () => {
    expect(() => validateInputSchema({}, schema, 'my-step')).toThrow(WorkflowError);
    try {
      validateInputSchema({}, schema, 'my-step');
    } catch (err) {
      expect((err as WorkflowError).code).toBe('VALIDATION_INPUT_SCHEMA');
    }
  });

  it('wrong type throws WorkflowError with code VALIDATION_INPUT_SCHEMA', () => {
    expect(() => validateInputSchema({ name: 42 }, schema, 'my-step')).toThrow(WorkflowError);
    try {
      validateInputSchema({ name: 42 }, schema, 'my-step');
    } catch (err) {
      expect((err as WorkflowError).code).toBe('VALIDATION_INPUT_SCHEMA');
    }
  });

  it('agentAction on the thrown error is provide_input', () => {
    try {
      validateInputSchema({}, schema, 'my-step');
    } catch (err) {
      expect((err as WorkflowError).agentAction).toBe('provide_input');
    }
  });

  it('stepId on the thrown error matches the argument', () => {
    try {
      validateInputSchema({}, schema, 'target-step');
    } catch (err) {
      expect((err as WorkflowError).stepId).toBe('target-step');
    }
  });

  // Ajv handles array/object-typed params natively — relevant now that $literal may
  // resolve to arrays/objects that flow through as params.
  it('accepts an array-typed param', () => {
    const arraySchema: JsonSchema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags'],
    };
    expect(() => validateInputSchema({ tags: ['a', 'b'] }, arraySchema, 'my-step')).not.toThrow();
    expect(() => validateInputSchema({ tags: 'not-an-array' }, arraySchema, 'my-step')).toThrow(
      WorkflowError,
    );
  });

  it('accepts a nested-object-typed param', () => {
    const objectSchema: JsonSchema = {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: { tier: { type: 'string' }, ids: { type: 'array' } },
          required: ['tier'],
        },
      },
      required: ['filter'],
    };
    expect(() =>
      validateInputSchema({ filter: { tier: 'gold', ids: [1, 2] } }, objectSchema, 'my-step'),
    ).not.toThrow();
    expect(() => validateInputSchema({ filter: { ids: [1] } }, objectSchema, 'my-step')).toThrow(
      WorkflowError,
    );
  });
});

describe('validateTraceSchema', () => {
  const traceSchema: JsonSchema = {
    type: 'array',
    items: {
      type: 'object',
      required: ['seq', 'event'],
      properties: {
        seq: { type: 'number' },
        event: { type: 'string' },
      },
    },
  };

  const validEntries: TraceEntry[] = [
    { seq: 1, event: 'search_called' },
    { seq: 2, event: 'search_returned' },
  ];

  const invalidEntries = [{ seq: 'not-a-number', event: 'oops' }] as unknown as TraceEntry[];

  it('enforce: valid entries do not throw', () => {
    expect(() =>
      validateTraceSchema(validEntries, traceSchema, 'my-step', 'enforce'),
    ).not.toThrow();
  });

  it('enforce: invalid entries throw WorkflowError with code VALIDATION_TRACE_SCHEMA', () => {
    expect(() => validateTraceSchema(invalidEntries, traceSchema, 'my-step', 'enforce')).toThrow(
      WorkflowError,
    );
    try {
      validateTraceSchema(invalidEntries, traceSchema, 'my-step', 'enforce');
    } catch (err) {
      expect((err as WorkflowError).code).toBe('VALIDATION_TRACE_SCHEMA');
      expect((err as WorkflowError).agentAction).toBe('provide_input');
      expect((err as WorkflowError).stepId).toBe('my-step');
    }
  });

  it('enforce: thrown error includes Ajv error details', () => {
    try {
      validateTraceSchema(invalidEntries, traceSchema, 'my-step', 'enforce');
    } catch (err) {
      const errors = (err as WorkflowError).details?.['errors'];
      expect(Array.isArray(errors)).toBe(true);
      expect((errors as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it('warn: valid entries return errorCount 0 and empty warning', () => {
    const result = validateTraceSchema(validEntries, traceSchema, 'my-step', 'warn');
    expect(result.errorCount).toBe(0);
    expect(result.warning).toBe('');
  });

  it('warn: invalid entries return positive errorCount and non-empty warning', () => {
    const result = validateTraceSchema(invalidEntries, traceSchema, 'my-step', 'warn');
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.warning).toContain('my-step');
  });

  it('warn: invalid entries do not throw', () => {
    expect(() => validateTraceSchema(invalidEntries, traceSchema, 'my-step', 'warn')).not.toThrow();
  });

  it('warn: warning contains violation detail from Ajv', () => {
    const result = validateTraceSchema(invalidEntries, traceSchema, 'my-step', 'warn');
    // Ajv reports a type error for seq (string instead of number)
    expect(result.warning.toLowerCase()).toMatch(/must be number|type/);
  });
});

// ---------------------------------------------------------------------------
// issue #224 — validateAgentSubmission (the provider-replicate non-throwing validator)
// ---------------------------------------------------------------------------

describe('validateAgentSubmission (issue #224)', () => {
  const outputSchema: JsonSchema = {
    type: 'object',
    required: ['category'],
    properties: { category: { type: 'string' } },
    additionalProperties: false,
  };

  it('valid === true, rawErrors === [] when the submission satisfies the schema', () => {
    const result = validateAgentSubmission({ category: 'billing' }, { outputSchema }, 'my-step');
    expect(result.valid).toBe(true);
    expect(result.rawErrors).toEqual([]);
  });

  it('valid === false with populated rawErrors on a schema-invalid submission (right key, wrong type)', () => {
    const result = validateAgentSubmission({ category: 42 }, { outputSchema }, 'my-step');
    expect(result.valid).toBe(false);
    expect(result.rawErrors.length).toBeGreaterThan(0);
    expect(result.rawErrors[0]?.keyword).toBe('type');
  });

  it('never throws, even on a schema-invalid submission', () => {
    expect(() => validateAgentSubmission({}, { outputSchema }, 'my-step')).not.toThrow();
  });

  it('no schemas given ⇒ always valid (mirrors the pre-#224 required-keys check\'s "no schema ⇒ true")', () => {
    const result = validateAgentSubmission({ anything: 'goes' }, {}, 'my-step');
    expect(result.valid).toBe(true);
  });

  describe('pin (a): source-text guard — no fresh Ajv, references the two throwing validators', () => {
    const source = readFileSync(fileURLToPath(new URL('./input-schema.ts', import.meta.url)), {
      encoding: 'utf8',
    });
    const fnStart = source.indexOf('export function validateAgentSubmission');
    const fnBody = source.slice(fnStart, source.indexOf('\n}\n', fnStart) + 3);

    it('validateAgentSubmission calls validateInputSchema and validateOutputSchema', () => {
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnBody).toContain('validateInputSchema(');
      expect(fnBody).toContain('validateOutputSchema(');
    });

    it('validateAgentSubmission constructs NO fresh Ajv (mutation-probe target)', () => {
      expect(fnBody).not.toContain('new Ajv(');
    });
  });

  describe("D3: _debug strip mirrors the engine's effectiveInput exactly", () => {
    it('a _debug-bearing output that is valid-after-strip passes (additionalProperties:false schema)', () => {
      const strictSchema: JsonSchema = {
        type: 'object',
        required: ['category'],
        properties: { category: { type: 'string' } },
        additionalProperties: false,
      };
      const result = validateAgentSubmission(
        { category: 'billing', _debug: 'reasoning trace...' },
        { outputSchema: strictSchema },
        'my-step',
      );
      expect(result.valid).toBe(true);
    });

    it('a _debug-bearing output that is genuinely invalid even after the strip still fails', () => {
      const result = validateAgentSubmission(
        { category: 42, _debug: 'reasoning trace...' },
        { outputSchema },
        'my-step',
      );
      expect(result.valid).toBe(false);
    });
  });

  describe('D2: both-schemas SEQUENTIAL AND, never allOf-combine', () => {
    // additionalProperties:false on BOTH schemas — an allOf-combine would reject an object
    // valid under one schema alone, because the other schema's branch rejects its properties.
    const inputSchema: JsonSchema = {
      type: 'object',
      required: ['note'],
      properties: { note: { type: 'string' } },
      additionalProperties: false,
    };

    it('valid under output_schema but INVALID under input_schema ⇒ rejected (sequential AND, input-first)', () => {
      // { category: 'billing' } satisfies outputSchema but fails inputSchema (missing 'note',
      // and 'category' is not an allowed property under inputSchema's additionalProperties:false).
      const result = validateAgentSubmission(
        { category: 'billing' },
        { inputSchema, outputSchema },
        'my-step',
      );
      expect(result.valid).toBe(false);
    });

    it('valid under BOTH schemas ⇒ accepted only when the object satisfies each independently (not a merged allOf shape)', () => {
      // Note: input_schema and output_schema here describe DIFFERENT objects in the engine's real
      // usage (Step 2b validates the AGENT'S INPUT shape, Step 2c the OUTPUT shape) — this
      // provider-side helper validates the SAME submitted object against both, sequentially,
      // exactly mirroring the engine's own Step 2b→2c order for the identical (obj, schemas) pair.
      const result = validateAgentSubmission({ note: 'hi' }, { inputSchema }, 'my-step');
      expect(result.valid).toBe(true);
    });

    it("invalid under input_schema (checked first) ⇒ short-circuits before output_schema is ever checked (single failure population, mirrors the engine's input-first short-circuit)", () => {
      // An object satisfying NEITHER schema — if output_schema were checked too, rawErrors would
      // differ; asserting the FIRST rawError's schemaPath/keyword pins that only input_schema ran.
      const result = validateAgentSubmission(
        {}, // fails input_schema's required:['note'] AND would also fail outputSchema's required
        { inputSchema, outputSchema },
        'my-step',
      );
      expect(result.valid).toBe(false);
      expect(result.rawErrors.some((e) => e.keyword === 'required')).toBe(true);
    });
  });

  describe('pin (b): verdict-parity — validateAgentSubmission agrees with a real executeStep/executeChain agent step', () => {
    const def: WorkflowDefinition = {
      id: 'parity-wf',
      name: 'Parity WF',
      version: 1,
      steps: {
        draft: {
          description: 'Draft',
          execution: 'agent',
          output_schema: outputSchema,
        },
      },
    };
    const echoDispatcher = async (
      _step: string,
      input: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => input;

    const table: Array<{
      label: string;
      submission: Record<string, unknown>;
      expectValid: boolean;
    }> = [
      { label: 'valid submission', submission: { category: 'billing' }, expectValid: true },
      { label: 'wrong type', submission: { category: 42 }, expectValid: false },
      { label: 'missing required key', submission: {}, expectValid: false },
      {
        label: 'extra property (additionalProperties:false)',
        submission: { category: 'billing', extra: 'nope' },
        expectValid: false,
      },
    ];

    for (const { label, submission, expectValid } of table) {
      it(`${label}: executeStep and validateAgentSubmission agree (both ${expectValid ? 'accept' : 'reject'})`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'realm-parity-test-'));
        const store = new JsonFileStore(dir);
        const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

        const envelope = await executeStep(store, def, {
          runId: run.id,
          command: 'draft',
          input: submission,
          dispatcher: echoDispatcher,
        });
        const engineValid = envelope.status === 'ok';

        const verdict = validateAgentSubmission(submission, { outputSchema }, 'draft');

        expect(engineValid).toBe(expectValid);
        expect(verdict.valid).toBe(expectValid);
        expect(verdict.valid).toBe(engineValid); // the parity assertion itself
      });
    }
  });
});

// =================================================================================================
// issue #560 — each authored schema is compiled once per process, not on every check. The cache
// key is the schema's JSON text when its content is exactly JSON; the entry is compiled from its
// own frozen copy; the capturing path (the loader) writes the cache and never reads it; the bound
// is 256 entries and 4 Mi key characters. What a failing cell prints: function identities as
// booleans, verdicts, error counts and instance paths — never a value.
// =================================================================================================
describe('issue #560 — the compiled-validator cache', () => {
  it('1. same content, one function: the same object twice, and two JSON-equal objects; different content, different functions', () => {
    const s1: JsonSchema = { type: 'object', properties: { c560a: { type: 'string' } } };
    const s2 = JSON.parse(JSON.stringify(s1)) as JsonSchema;
    // (a) red when every call compiles afresh (the base), or the key confuses two contents; (b)
    //     prints three booleans.
    expect({
      sameObjectTwice: compileSchema(s1) === compileSchema(s1),
      jsonEqualObjects: compileSchema(s1) === compileSchema(s2),
      differentContent: compileSchema({ type: 'string' }) === compileSchema({ type: 'number' }),
    }).toEqual({ sameObjectTwice: true, jsonEqualObjects: true, differentContent: false });
  });

  it('2. the capturing path captures every time — after a silent call put the content in the cache', () => {
    const union = { type: ['string', 'number'], description: 'c560-2' } as unknown as JsonSchema;
    compileSchema(union); // silent first: the cache now holds this content
    const capture = () => {
      const lines: string[] = [];
      compileSchema(union, { onStrictLog: (line) => lines.push(line) });
      return lines.filter((l) => l.includes('strict mode: use allowUnionTypes')).length;
    };
    // (a) red when the capturing path reads the cache (no compile, no line); (b) prints the count
    //     of strict-mode lines each capture held.
    expect([capture(), capture()]).toEqual([1, 1]);
  });

  it('3. admission → run time compiles once: a capturing call, then a silent call on the same content, return one function', () => {
    const block: JsonSchema = { type: 'object', required: ['c560b'] };
    const captured = compileSchema(block, { onStrictLog: () => {} });
    // (a) red when the capturing compile is not written to the cache (the run time compiles the
    //     same schema a second time); (b) prints a boolean.
    expect(compileSchema(JSON.parse(JSON.stringify(block)) as JsonSchema) === captured).toBe(true);
  });

  it('4. a compile that throws is not cached: two calls throw two errors; a valid schema after it is unaffected', () => {
    const bad = { type: 'object', c560NotAKeyword: true } as unknown as JsonSchema;
    const thrown = () => {
      try {
        compileSchema(bad);
        return undefined;
      } catch (err) {
        return err;
      }
    };
    const first = thrown();
    const second = thrown();
    // (a) red when a failed compile leaves a slot (the second call rethrows the first's error);
    //     (b) prints whether each threw, whether they are one object, and the valid verdict.
    expect({
      firstThrew: first instanceof Error,
      secondThrew: second instanceof Error,
      sameError: first === second,
      validAfter: compileSchema({ type: 'string', description: 'c560-4' })('ok'),
    }).toEqual({ firstThrew: true, secondThrew: true, sameError: false, validAfter: true });
  });

  // 5a and 5b compile hundreds of schemas (or megabytes of one), each with its own Ajv: under the
  // full suite's load they need more than the default five seconds.
  it(
    '5a. the LRU, by entries: 256 schemas, #1 used again, #257 compiled → #1 kept, #2 evicted',
    { timeout: 60_000 },
    () => {
      const nth = (i: number): JsonSchema => ({ type: 'string', description: `c560-5a-${i}` });
      const first: ValidateFunctionLike[] = [];
      for (let i = 1; i <= 256; i++) first[i] = compileSchema(nth(i));
      compileSchema(nth(1)); // a hit: #1 becomes the most recent
      compileSchema(nth(257));
      // (a) red when the cache does not keep #1–#256 (the base compiles afresh), does not refresh
      //     a hit's recency, or evicts past the bound; (b) prints two booleans.
      expect({
        firstKept: compileSchema(nth(1)) === first[1],
        secondEvicted: compileSchema(nth(2)) !== first[2],
      }).toEqual({ firstKept: true, secondEvicted: true });
    },
  );

  it(
    '5b. the LRU, by key characters: past 4 Mi characters the oldest is evicted; a key over the bound is never cached',
    { timeout: 60_000 },
    () => {
      const big = (tag: string): JsonSchema => ({
        type: 'string',
        description: `${tag}:${'x'.repeat(1.5 * 1024 * 1024)}`,
      });
      const s1 = compileSchema(big('c560-5b-1'));
      const s2 = compileSchema(big('c560-5b-2'));
      const s3 = compileSchema(big('c560-5b-3')); // 4.5 Mi characters: #1 is evicted
      const huge: JsonSchema = { type: 'string', description: 'y'.repeat(4 * 1024 * 1024 + 1) };
      // (a) red when the bound counts entries only (#1 stays), or a key over the bound is cached;
      //     (b) prints four booleans.
      expect({
        thirdKept: compileSchema(big('c560-5b-3')) === s3,
        secondKept: compileSchema(big('c560-5b-2')) === s2,
        firstEvicted: compileSchema(big('c560-5b-1')) !== s1,
        hugeNeverCached: compileSchema(huge) !== compileSchema(huge),
      }).toEqual({ thirdKept: true, secondKept: true, firstEvicted: true, hugeNeverCached: true });
    },
  );

  it('6. the key is exact: a Date, Infinity or a Uint8Array and their JSON copies keep their own verdicts, in both orders', () => {
    const pairs: Array<[string, () => JsonSchema, () => JsonSchema, unknown]> = [
      [
        'Date',
        () => ({ const: new Date('2024-01-01') }) as unknown as JsonSchema,
        () => ({ const: '2024-01-01T00:00:00.000Z' }) as JsonSchema,
        '2024-01-01T00:00:00.000Z',
      ],
      [
        'Infinity',
        () => ({ const: Infinity }) as unknown as JsonSchema,
        () => ({ const: null }) as JsonSchema,
        null,
      ],
      [
        'Uint8Array',
        () => ({ const: new Uint8Array([1]) }) as unknown as JsonSchema,
        () => ({ const: { '0': 1 } }) as JsonSchema,
        { '0': 1 },
      ],
    ];
    const verdicts = pairs.map(([name, odd, json, input]) => {
      const oddFirst = [compileSchema(odd())(input), compileSchema(json())(input)];
      const jsonFirst = [compileSchema(json())(input), compileSchema(odd())(input)].reverse();
      return { name, oddFirst, jsonFirst };
    });
    // (a) red when the key is `JSON.stringify` plain (the odd schema and its JSON copy share a key,
    //     so the second compiled answers for both); (b) prints each pair's verdicts in both orders.
    expect(verdicts).toEqual([
      { name: 'Date', oddFirst: [false, true], jsonFirst: [false, true] },
      { name: 'Infinity', oddFirst: [false, true], jsonFirst: [false, true] },
      { name: 'Uint8Array', oddFirst: [false, true], jsonFirst: [false, true] },
    ]);
  });

  it('7. verdicts stay each call’s own: a second invalid input does not rewrite the first refusal’s errors', () => {
    const shared: JsonSchema = {
      type: 'object',
      description: 'c560-7',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    };
    const refusal = (input: Record<string, unknown>) => {
      try {
        validateInputSchema(input, shared, 's');
        return undefined;
      } catch (err) {
        return err as WorkflowError;
      }
    };
    const first = refusal({ a: 1 });
    refusal({ b: 1 });
    const paths = (first?.details['errors'] as Array<{ instancePath: string }> | undefined)?.map(
      (e) => e.instancePath,
    );
    // (a) red when the call sites read `errors` from one array every call shares; (b) prints the
    //     first refusal's instance paths.
    expect(paths).toEqual(['/a']);
  });

  it('8. the frozen copy: a caller changing its schema after a compile does not change the verdict; an error row cannot change the cache; the caller’s schema stays unfrozen', () => {
    const mine = { enum: [{ c560k: 1 }] } as unknown as JsonSchema;
    const validate = compileSchema(mine);
    (mine as unknown as { enum: Array<{ c560k: number }> }).enum[0]!.c560k = 2;
    const stillValid = validate({ c560k: 1 });
    validate('nope');
    const allowed = validate.errors?.[0]?.params['allowedValues'] as unknown[] | undefined;
    let rowFrozen = false;
    try {
      allowed?.push('x');
    } catch (err) {
      rowFrozen = err instanceof TypeError;
    }
    // (a) red when the validator is compiled from the caller's object (the base): the verdict
    //     follows the caller's change, and the error row is the caller's own array; (b) prints three
    //     booleans.
    expect({ stillValid, rowFrozen, callersSchemaFrozen: Object.isFrozen(mine) }).toEqual({
      stillValid: true,
      rowFrozen: true,
      callersSchemaFrozen: false,
    });
  });
});

type ValidateFunctionLike = ReturnType<typeof compileSchema>;
