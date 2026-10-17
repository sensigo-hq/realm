import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileSchema,
  compileCached,
  compileCapturing,
  validateInputSchema,
  validateOutputSchema,
  validateRunParams,
  validateTraceSchema,
  validateAgentSubmission,
} from './input-schema.js';
import { WorkflowError, type ValidationErrorFacts } from '../types/workflow-error.js';
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
// issue #560 — the run-time checks reuse each authored schema's compiled validator instead of
// compiling it on every check, through the internal `compileCached`; the exported `compileSchema`
// compiles a fresh validator on every call. The cache key is the schema's JSON text when its
// content is exactly JSON; the entry is compiled from its own frozen copy; the capturing path
// (`compileCapturing`, the loader) writes the cache and never reads it; each check clears the
// errors a kept validator holds; the bound is 256 entries and 4 Mi of weight. What a failing cell
// prints: function identities as booleans, verdicts, error counts and instance paths — never a
// value.
// =================================================================================================
describe('issue #560 — the compiled-validator cache', () => {
  it('1. same content, one function: the same object twice, and two JSON-equal objects; different content, different functions', () => {
    const s1: JsonSchema = { type: 'object', properties: { c560a: { type: 'string' } } };
    const s2 = JSON.parse(JSON.stringify(s1)) as JsonSchema;
    // (a) red when every call compiles afresh (the base), or the key confuses two contents; (b)
    //     prints three booleans.
    expect({
      sameObjectTwice: compileCached(s1) === compileCached(s1),
      jsonEqualObjects: compileCached(s1) === compileCached(s2),
      differentContent: compileCached({ type: 'string' }) === compileCached({ type: 'number' }),
    }).toEqual({ sameObjectTwice: true, jsonEqualObjects: true, differentContent: false });
  });

  it('2. the capturing path captures every time — after a silent call put the content in the cache', () => {
    const union = { type: ['string', 'number'], description: 'c560-2' } as unknown as JsonSchema;
    compileCached(union); // silent first: the cache now holds this content
    const capture = () => {
      const lines: string[] = [];
      compileCapturing(union, (line) => lines.push(line));
      return lines.filter((l) => l.includes('strict mode: use allowUnionTypes')).length;
    };
    // (a) red when the capturing path reads the cache (no compile, no line); (b) prints the count
    //     of strict-mode lines each capture held.
    expect([capture(), capture()]).toEqual([1, 1]);
  });

  it('3. admission → run time compiles once: a capturing call, then a silent call on the same content, return one function', () => {
    const block: JsonSchema = { type: 'object', required: ['c560b'] };
    const captured = compileCapturing(block, () => {});
    // (a) red when the capturing compile is not written to the cache (the run time compiles the
    //     same schema a second time); (b) prints a boolean.
    expect(compileCached(JSON.parse(JSON.stringify(block)) as JsonSchema) === captured).toBe(true);
  });

  it('4. a compile that throws is not cached: two calls throw two errors; a valid schema after it is unaffected', () => {
    const bad = { type: 'object', c560NotAKeyword: true } as unknown as JsonSchema;
    const thrown = () => {
      try {
        compileCached(bad);
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
      validAfter: compileCached({ type: 'string', description: 'c560-4' })('ok'),
    }).toEqual({ firstThrew: true, secondThrew: true, sameError: false, validAfter: true });
  });

  // 5a and the 5b cells compile hundreds of schemas (or megabytes of code), each with its own Ajv:
  // under the full suite's load they need more than the default five seconds.
  it(
    '5a. the LRU, by entries: 256 schemas, #1 used again, #257 compiled → #1 kept, #2 evicted',
    { timeout: 60_000 },
    () => {
      const nth = (i: number): JsonSchema => ({ type: 'string', description: `c560-5a-${i}` });
      const first: ValidateFunctionLike[] = [];
      for (let i = 1; i <= 256; i++) first[i] = compileCached(nth(i));
      compileCached(nth(1)); // a hit: #1 becomes the most recent
      compileCached(nth(257));
      // (a) red when the cache does not keep #1–#256 (the base compiles afresh), does not refresh
      //     a hit's recency, or evicts past the bound; (b) prints two booleans.
      expect({
        firstKept: compileCached(nth(1)) === first[1],
        secondEvicted: compileCached(nth(2)) !== first[2],
      }).toEqual({ firstKept: true, secondEvicted: true });
    },
  );

  // The weight's shapes (correction 1). Every entry gets its OWN generated code — a `pattern` varies
  // with `k` — so no entry shares compiled code with another; CONST's code is the same for every k,
  // and its weight is its JSON values.
  const leaf = (k: number): Record<string, unknown> => ({
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `f${i}`,
        { type: 'string', maxLength: 9, pattern: `^a${i}k${k}` },
      ]),
    ),
  });
  const refsToLeaf = (r: number): Record<string, unknown> =>
    Object.fromEntries(
      Array.from({ length: r }, (_, i) => [`r${i}`, { $ref: '#/definitions/leaf' }]),
    );
  /** `r` references to one leaf that holds no `$ref`: Ajv copies its code into the validator `r` times. */
  const inlined = (r: number, k: number): JsonSchema =>
    ({
      definitions: { leaf: leaf(k) },
      type: 'object',
      properties: refsToLeaf(r),
    }) as unknown as JsonSchema;
  /** The `r` references sit in a definition that is itself referenced: Ajv compiles that target as a
   *  separate function, which the root validator's source never shows. */
  const indirect = (r: number, k: number): JsonSchema =>
    ({
      definitions: { leaf: leaf(k), mid: { type: 'object', properties: refsToLeaf(r) } },
      type: 'object',
      properties: { m: { $ref: '#/definitions/mid' } },
    }) as unknown as JsonSchema;
  /** `n` JSON values in a `const`: a short text that holds far more than its characters. */
  const constOf = (n: number, k: number): JsonSchema =>
    ({
      type: 'array',
      description: `c560-${k}`,
      const: Array.from({ length: n }, () => ({})),
    }) as unknown as JsonSchema;

  // Weights measured under `allErrors` (registry 560-IA-C1-05): inlined(60) ≈ 2,336,443;
  // indirect(40) ≈ 1,557,469; inlined(120) ≈ 4,692,126; constOf(50,000) ≈ 1,750,814. The bound is
  // 4 Mi (4,194,304). Each cell asserts the kept entry FIRST: checking an evicted one compiles it
  // again, which evicts in turn.
  it(
    '5b-i. the weight counts the compiled code: two schemas whose code is over 4 Mi together cannot both stay',
    { timeout: 60_000 },
    () => {
      const a = compileCached(inlined(60, 1));
      const b = compileCached(inlined(60, 2));
      // (a) red when the weight counts no compiled code (both stay: their keys are 4,498 characters);
      //     (b) prints two booleans.
      expect({
        secondKept: compileCached(inlined(60, 2)) === b,
        firstEvicted: compileCached(inlined(60, 1)) !== a,
      }).toEqual({ secondKept: true, firstEvicted: true });
    },
  );

  it(
    '5b-ii. the weight counts the sub-validators a reference compiles apart: three indirect schemas cannot all stay',
    { timeout: 60_000 },
    () => {
      const d1 = compileCached(indirect(40, 1));
      const d2 = compileCached(indirect(40, 2));
      const d3 = compileCached(indirect(40, 3));
      // (a) red when the weight counts the root validator's source only (each root is 674
      //     characters, so all three stay); (b) prints three booleans.
      expect({
        thirdKept: compileCached(indirect(40, 3)) === d3,
        secondKept: compileCached(indirect(40, 2)) === d2,
        firstEvicted: compileCached(indirect(40, 1)) !== d1,
      }).toEqual({ thirdKept: true, secondKept: true, firstEvicted: true });
    },
  );

  it(
    '5b-iii. an entry heavier than the whole bound is never cached, and evicts nothing',
    { timeout: 60_000 },
    () => {
      const small = (): JsonSchema => ({ type: 'string', description: 'c560-5b-iii' });
      const s = compileCached(small());
      const h = compileCached(inlined(120, 3));
      // (a) red when the guard is removed (the heavy entry evicts everything, then itself); (b)
      //     prints two booleans.
      expect({
        olderKept: compileCached(small()) === s,
        heavyNeverCached: compileCached(inlined(120, 3)) !== h,
      }).toEqual({ olderKept: true, heavyNeverCached: true });
    },
  );

  it(
    '5b-iv. the weight counts the JSON values: three schemas of 50,000 values cannot all stay',
    { timeout: 60_000 },
    () => {
      const c1 = compileCached(constOf(50_000, 1));
      const c2 = compileCached(constOf(50_000, 2));
      const c3 = compileCached(constOf(50_000, 3));
      // (a) red when the weight counts no JSON values (each key is 150,049 characters, so all three
      //     stay); (b) prints three booleans.
      expect({
        thirdKept: compileCached(constOf(50_000, 3)) === c3,
        secondKept: compileCached(constOf(50_000, 2)) === c2,
        firstEvicted: compileCached(constOf(50_000, 1)) !== c1,
      }).toEqual({ thirdKept: true, secondKept: true, firstEvicted: true });
    },
  );

  it(
    '5b-v. a schema whose text alone is over the bound is compiled from the caller’s object, never copied, never cached',
    { timeout: 60_000 },
    () => {
      const huge: JsonSchema = { type: 'string', description: 'y'.repeat(4 * 1024 * 1024 + 1) };
      // (a) red when such a schema is parsed and frozen like any keyable one (the validator's
      //     schema is then a copy); (b) prints three booleans.
      expect({
        schemaIsCallers: compileCached(huge).schema === huge,
        callersFrozen: Object.isFrozen(huge),
        neverCached: compileCached(huge) !== compileCached(huge),
      }).toEqual({ schemaIsCallers: true, callersFrozen: false, neverCached: true });
      // The pre-check counts what is known before the compile (D5): a key of about 420 K plus
      // 32 × 140,004 JSON values ≈ 4.9 M is over the bound before any code is counted.
      const values = constOf(140_000, 1);
      // (a) `schemaIsCallers` is red when the pre-check reads the text length only (the entry is
      //     then parsed and frozen, and the validator's schema is the copy); `neverCached` has no
      //     single break that turns it red — the weight guard also refuses this entry (registry
      //     560-AUD3-11); (b) prints two booleans.
      expect({
        schemaIsCallers: compileCached(values).schema === values,
        neverCached: compileCached(values) !== compileCached(values),
      }).toEqual({ schemaIsCallers: true, neverCached: true });
    },
  );

  it(
    '5b-vi. the weight counts the key’s characters: three schemas of 1.5 Mi text cannot all stay',
    { timeout: 60_000 },
    () => {
      const text = (tag: string): JsonSchema => ({
        type: 'string',
        description: `${tag}:` + 'x'.repeat(1.5 * 1024 * 1024),
      });
      const t1 = compileCached(text('c560-5b-vi-1'));
      const t2 = compileCached(text('c560-5b-vi-2'));
      const t3 = compileCached(text('c560-5b-vi-3'));
      // (a) red when the weight leaves out the key (each entry's code and values are small, so all
      //     three stay); (b) prints three booleans.
      expect({
        thirdKept: compileCached(text('c560-5b-vi-3')) === t3,
        secondKept: compileCached(text('c560-5b-vi-2')) === t2,
        firstEvicted: compileCached(text('c560-5b-vi-1')) !== t1,
      }).toEqual({ thirdKept: true, secondKept: true, firstEvicted: true });
    },
  );

  it(
    '5b-vii. a refresh subtracts the weight it replaces: a capturing compile of kept content stays kept',
    { timeout: 60_000 },
    () => {
      const a = compileCached(inlined(60, 9));
      const c = compileCapturing(inlined(60, 9), () => {}); // the same content, refreshed
      // (a) red when a refresh does not subtract the entry it replaces (the leftover weight pushes
      //     the total over the bound and evicts the refreshed entry itself); (b) prints two
      //     booleans.
      expect({
        replaced: c !== a,
        refreshedKept: compileCached(inlined(60, 9)) === c,
      }).toEqual({ replaced: true, refreshedKept: true });
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
      const oddFirst = [compileCached(odd())(input), compileCached(json())(input)];
      const jsonFirst = [compileCached(json())(input), compileCached(odd())(input)].reverse();
      const oddCompiledEachTime = compileCached(odd()) !== compileCached(odd());
      return { name, oddFirst, jsonFirst, oddCompiledEachTime };
    });
    // (a) red when the key is `JSON.stringify` plain (the odd schema and its JSON copy share a key,
    //     so the second compiled answers for both), or when an odd schema is kept by any other key
    //     (the same function twice); (b) prints each pair's verdicts in both orders and a boolean.
    expect(verdicts).toEqual([
      {
        name: 'Date',
        oddFirst: [false, true],
        jsonFirst: [false, true],
        oddCompiledEachTime: true,
      },
      {
        name: 'Infinity',
        oddFirst: [false, true],
        jsonFirst: [false, true],
        oddCompiledEachTime: true,
      },
      {
        name: 'Uint8Array',
        oddFirst: [false, true],
        jsonFirst: [false, true],
        oddCompiledEachTime: true,
      },
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
    // The rows live in the refusal's typed facts (#759), as #759's own cells read them.
    const paths = (first?.facts as ValidationErrorFacts | undefined)?.errors.map(
      (e) => e.instancePath,
    );
    // (a) red when the refusal's rows are one array every call shares, refilled on each call; (b)
    //     prints the first refusal's instance paths.
    expect(paths).toEqual(['/a']);
  });

  it('8. the frozen copy: a caller changing its schema after a compile does not change the verdict; an error row cannot change the cache; the caller’s schema stays unfrozen', () => {
    const mine = { enum: [{ c560k: 1 }] } as unknown as JsonSchema;
    const validate = compileCached(mine);
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
    //     follows the caller's change, the error row is the caller's own array, and the validator's
    //     schema is the caller's object; (b) prints four booleans.
    expect({
      stillValid,
      rowFrozen,
      callersSchemaFrozen: Object.isFrozen(mine),
      schemaIsFrozenCopy: validate.schema !== mine && Object.isFrozen(validate.schema),
    }).toEqual({
      stillValid: true,
      rowFrozen: true,
      callersSchemaFrozen: false,
      schemaIsFrozenCopy: true,
    });
  });

  it('9a. the key refuses a function value: the schema compiles from the caller’s object, and Ajv refuses the unknown keyword as before', () => {
    const withFunction = { type: 'string', c560fn: () => 1 } as unknown as JsonSchema;
    let threw = false;
    let unknownKeyword = false;
    try {
      compileCached(withFunction);
    } catch (err) {
      threw = true;
      unknownKeyword = err instanceof Error && err.message.includes('strict mode: unknown keyword');
    }
    // (a) red when the key keeps a function value (JSON drops it, the copy compiles and the schema
    //     is accepted); (b) prints two booleans.
    expect({ threw, unknownKeyword }).toEqual({ threw: true, unknownKeyword: true });
  });

  it('9b. the key refuses a plain object with its own toJSON: the verdict is the caller’s schema’s, compiled each time', () => {
    const disguised: Record<string, unknown> = { type: 'string' };
    Object.defineProperty(disguised, 'toJSON', {
      value: () => ({ type: 'number' }),
      enumerable: false,
    });
    const v1 = compileCached(disguised as JsonSchema);
    const v2 = compileCached(disguised as JsonSchema);
    // (a) red when the key ignores `toJSON` (the key becomes the `toJSON` result: the verdict
    //     flips to `number`, and it is cached); (b) prints two verdicts and a boolean.
    expect({ abcValid: v1('abc'), oneValid: v1(1), twoFunctions: v1 !== v2 }).toEqual({
      abcValid: true,
      oneValid: false,
      twoFunctions: true,
    });
  });

  it('9c. the key refuses a cycle: the compile fails as before, by running out of stack', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic['properties'] = { self: cyclic };
    let isRangeError = false;
    let startsWithMaxCallStack = false;
    try {
      compileCached(cyclic as JsonSchema);
    } catch (err) {
      isRangeError = err instanceof RangeError;
      startsWithMaxCallStack =
        err instanceof Error && err.message.startsWith('Maximum call stack size exceeded');
    }
    // (a) red when the key's failure escapes (`JSON.stringify`'s own error about the circular
    //     structure replaces the compile's); (b) prints two booleans.
    expect({ isRangeError, startsWithMaxCallStack }).toEqual({
      isRangeError: true,
      startsWithMaxCallStack: true,
    });
  });

  /** An input that fails every leaf property of `indirect(40, k)`: 40 × 40 type errors. */
  const failingIndirect = (): Record<string, unknown> => ({
    m: Object.fromEntries(
      Array.from({ length: 40 }, (_, r) => [
        `r${r}`,
        Object.fromEntries(Array.from({ length: 40 }, (_, f) => [`f${f}`, 1])),
      ]),
    ),
  });
  /** The functions besides `v` that `v` keeps: its separately compiled reference targets. */
  const subValidators = (v: ValidateFunctionLike): ValidateFunctionLike[] => [
    ...new Set(
      Object.values(v.schemaEnv.root.refs)
        .map((ref) => (ref as { validate?: unknown } | null)?.validate)
        .filter((f): f is ValidateFunctionLike => typeof f === 'function' && f !== v),
    ),
  ];

  it(
    '10. a kept validator keeps no errors: a refused check clears the validator and its separately compiled reference target, after the refusal took its rows',
    { timeout: 60_000 },
    () => {
      const s = indirect(40, 7);
      const kept = compileCached(s); // the check below reuses this validator
      let refusal: WorkflowError | undefined;
      try {
        validateInputSchema(failingIndirect(), s, 's');
      } catch (err) {
        refusal = err as WorkflowError;
      }
      const v = compileCached(s);
      const subs = subValidators(v);
      // (a) red when `releaseErrors` clears the root only (`subCleared`), when the `finally` is
      //     removed from `validateInputSchema` (`rootCleared`, `subCleared`), or when the errors are
      //     cleared before the facts are read (`refusalKeptRows` — cell 7 too); (b) prints booleans
      //     and the count of reference targets.
      expect({
        hit: v === kept,
        subs: subs.length,
        rootCleared: v.errors === null,
        subCleared: subs.every((f) => f.errors === null),
        refusalKeptRows:
          ((refusal?.facts as ValidationErrorFacts | undefined)?.errors.length ?? 0) > 0,
      }).toEqual({
        hit: true,
        subs: 1,
        rootCleared: true,
        subCleared: true,
        refusalKeptRows: true,
      });
    },
  );

  it(
    '10. the other checks clear it too: output, params, trace in warn mode and in enforce mode',
    { timeout: 60_000 },
    () => {
      const s = indirect(40, 8);
      const v = compileCached(s);
      const clearedAfter = (check: () => unknown): boolean => {
        try {
          check();
        } catch {
          // refused, as each check here is
        }
        return compileCached(s) === v && v.errors === null;
      };
      const entries: TraceEntry[] = [{ seq: 1, event: 'e' }];
      // (a) red when the `finally` is removed from that one check (its validator keeps the
      //     refused call's rows); (b) prints four booleans.
      expect({
        output: clearedAfter(() => validateOutputSchema(failingIndirect(), s, 's')),
        params: clearedAfter(() => validateRunParams(failingIndirect(), s, 'w')),
        traceWarn: clearedAfter(() => validateTraceSchema(entries, s, 's', 'warn')),
        traceEnforce: clearedAfter(() => validateTraceSchema(entries, s, 's', 'enforce')),
      }).toEqual({ output: true, params: true, traceWarn: true, traceEnforce: true });
    },
  );

  it('11. the exported compileSchema is uncached again: a fresh validator per call, from the caller’s object; the internal entry shares', () => {
    const s: JsonSchema = { type: 'object', description: 'c560-11' };
    const a = compileSchema(s);
    const b = compileSchema(s);
    // (a) red when `compileSchema` is routed through the cache (`fresh`, `schemaIsCallers`); (b)
    //     prints three booleans.
    expect({
      fresh: a !== b,
      schemaIsCallers: a.schema === s,
      cachedIsShared: compileCached(s) === compileCached(s),
    }).toEqual({ fresh: true, schemaIsCallers: true, cachedIsShared: true });
  });

  it('12. one inner compile: every entry calls compileInner, and `.compile(` appears only in compileInner and describeSchemaFailure', () => {
    // The #586 witness's reading: comments stripped.
    const stripped = readFileSync(
      fileURLToPath(new URL('./input-schema.ts', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const body = (name: string): string => {
      const start = stripped.search(new RegExp(`function ${name}\\(`));
      return start === -1 ? '' : stripped.slice(start, stripped.indexOf('\n}\n', start));
    };
    const count = (text: string, needle: string): number => text.split(needle).length - 1;
    const entries = ['compileSchema', 'compileCached', 'compileCapturing'];
    // (a) red when an entry compiles directly (`newAjv().compile` in `compileCached`): it then
    //     holds `.compile(` and the file's count no longer equals the two named functions'; (b)
    //     prints booleans and counts.
    expect({
      entriesCallInner: entries.map((n) => body(n).includes('compileInner(')),
      entriesCompileDirectly: entries.map((n) => body(n).includes('.compile(')),
      inInner: count(body('compileInner'), '.compile('),
      inDescribe: count(body('describeSchemaFailure'), '.compile('),
      inFile: count(stripped, '.compile('),
    }).toEqual({
      entriesCallInner: [true, true, true],
      entriesCompileDirectly: [false, false, false],
      inInner: 1,
      inDescribe: 1,
      inFile: 2,
    });
  });
});

type ValidateFunctionLike = ReturnType<typeof compileSchema>;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// issue #759 — a refused answer names every problem: the option (A), the typed facts (C), the
// params sentence (C), the agent verdict's count (D.4(b)) and the trace-schema path (G). Every cell
// runs on core's ONE construction. Failure output names only the fixture's own key names and the
// counts — never a submitted value.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('issue #759 — every problem, capped, with the total', () => {
  /** A schema that requires `n` fields named f01…fNN — `{}` breaks exactly `n` rules. */
  const requiring = (n: number): JsonSchema => ({
    type: 'object',
    required: Array.from({ length: n }, (_, i) => `f${String(i + 1).padStart(2, '0')}`),
  });

  /** The refusal a validator throws, or a failure naming what it returned instead. */
  function refusalOf(fn: () => unknown): WorkflowError {
    try {
      fn();
    } catch (err) {
      if (err instanceof WorkflowError) return err;
      throw err;
    }
    throw new Error('expected a refusal; the validator accepted the answer');
  }

  it('A: nine required fields and `{}` — ONE refusal carries all nine (red: `allErrors` off → 1)', () => {
    const err = refusalOf(() => validateInputSchema({}, requiring(9), 'extract'));
    const facts = err.facts as ValidationErrorFacts;
    expect({ shown: facts.errors.length, total: facts.error_count }).toEqual({
      shown: 9,
      total: 9,
    });
  });

  it('C: the three mints type the facts — rows capped at 10 in Ajv order, the total, and `details` without the list (red: keep `details.errors`; red: uncapped)', () => {
    const mints: Array<[string, () => unknown]> = [
      ['validateInputSchema', () => validateInputSchema({}, requiring(13), 's')],
      ['validateOutputSchema', () => validateOutputSchema({}, requiring(13), 's')],
      ['validateRunParams', () => validateRunParams({}, requiring(13), 'w')],
    ];
    const seen = mints.map(([name, fn]) => {
      const err = refusalOf(fn);
      const facts = err.facts as ValidationErrorFacts;
      return {
        name,
        shown: facts.errors.length,
        total: facts.error_count,
        firstMissing: (facts.errors[0]?.params as { missingProperty?: string }).missingProperty,
        detailsKeys: Object.keys(err.details),
      };
    });
    expect(seen).toEqual(
      mints.map(([name]) => ({
        name,
        shown: 10,
        total: 13,
        firstMissing: 'f01',
        detailsKeys: [],
      })),
    );
  });

  it("C: start_run's params name every problem in the pointer words — the first clause is today's (red: `errors[0]` only)", () => {
    const err = refusalOf(() =>
      validateRunParams(
        { a: 1, b: 'x' },
        { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
        'w',
      ),
    );
    expect(err.message).toBe(
      "Invalid params for workflow 'w': /a must be string; /b must be number",
    );
  });

  it("C2 (#759 correction 1): start_run's params refusal names an extra property by its key (red: the old `(root) must NOT have additional properties`)", () => {
    const err = refusalOf(() =>
      validateRunParams(
        { name: 'n', zzextra: 1 },
        { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
        'w',
      ),
    );
    expect(err.message).toBe("Invalid params for workflow 'w': /zzextra is not allowed");
  });

  it('D.4(b): validateAgentSubmission returns the capped rows and the TOTAL (red: read `details` → no rows)', () => {
    const refused = validateAgentSubmission({}, { outputSchema: requiring(13) }, 's');
    const accepted = validateAgentSubmission({ f01: 1 }, { outputSchema: requiring(1) }, 's');
    expect({
      valid: refused.valid,
      rows: refused.rawErrors.length,
      total: refused.errorCount,
      acceptedTotal: accepted.errorCount,
    }).toEqual({ valid: false, rows: 10, total: 13, acceptedTotal: 0 });
  });

  /** Thirteen trace entries each missing its `event` — thirteen violations of one rule. */
  const thirteenBadEntries = Array.from({ length: 13 }, () => ({}) as unknown as TraceEntry);
  const traceSchema: JsonSchema = {
    type: 'array',
    items: { type: 'object', required: ['event'] },
  };

  it('G: the trace warning names ten violations and `; and 3 more`; its count is the true 13 (red: the uncapped join; red: count 1)', () => {
    const result = validateTraceSchema(thirteenBadEntries, traceSchema, 's', 'warn');
    const clauses = result.warning
      .slice("Trace schema violation for step 's': ".length)
      .split('; ');
    expect({
      count: result.errorCount,
      clauses: clauses.length,
      first: clauses[0],
      last: clauses.at(-1),
    }).toEqual({
      count: 13,
      clauses: 11,
      first: "/0 must have required property 'event'",
      last: 'and 3 more',
    });
  });

  it('G: a ROOT trace violation now reads `(root) <message>` — the pointer words (red: the old bare message)', () => {
    const result = validateTraceSchema(
      [{ event: 'only' } as unknown as TraceEntry],
      { type: 'array', minItems: 2 },
      's',
      'warn',
    );
    expect(result.warning).toBe(
      "Trace schema violation for step 's': (root) must NOT have fewer than 2 items",
    );
  });

  it('C2 (#759 correction 1): a trace entry with two extra keys names both, no repeated clause (red: the old clause, said twice)', () => {
    const result = validateTraceSchema(
      [{ event: 'searched', seq: 1, data: {} } as unknown as TraceEntry],
      {
        type: 'array',
        items: {
          type: 'object',
          properties: { event: { type: 'string' } },
          additionalProperties: false,
        },
      },
      's',
      'warn',
    );
    expect(result.warning).toBe(
      "Trace schema violation for step 's': /0/seq is not allowed; /0/data is not allowed",
    );
  });

  it("G: the trace enforce refusal's untyped bag carries ten rows and the total (red: uncapped)", () => {
    const err = refusalOf(() =>
      validateTraceSchema(thirteenBadEntries, traceSchema, 's', 'enforce'),
    );
    expect({
      code: err.code,
      rows: (err.details['errors'] as unknown[]).length,
      total: err.details['error_count'],
    }).toEqual({ code: 'VALIDATION_TRACE_SCHEMA', rows: 10, total: 13 });
  });

  it('G: through the engine, a warn-mode trace with 13 violations records `validation_errors: 13` and the capped warning (red: the count 1)', async () => {
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-759-trace-')));
    const def = {
      id: 'trace-759',
      name: 'T',
      version: 1,
      steps: {
        s: {
          description: 'S',
          execution: 'agent',
          depends_on: [],
          // each entry the engine records must carry `data`; the agent's thirteen carry none
          trace_schema: { type: 'array', items: { type: 'object', required: ['data'] } },
          trace_validation_mode: 'warn',
        },
      },
    } as unknown as WorkflowDefinition;
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 's',
      input: { done: true },
      dispatcher: async (_n, input) => ({ ...input }),
      trace: Array.from({ length: 13 }, (_, i) => ({ event: `e${i}` })),
    });
    const warning = (envelope.warnings ?? []).find((w) => w.startsWith('Trace schema violation'));
    expect({
      status: envelope.status,
      count: envelope.evidence[0]?.trace_summary?.validation_errors,
      endsWithMore: warning?.endsWith('; and 3 more'),
    }).toEqual({ status: 'ok', count: 13, endsWithMore: true });
  });
});
