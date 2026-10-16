import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
