// Input schema validation — validates step input against a declared JSON Schema using Ajv.
import { Ajv } from 'ajv';
import type { JsonSchema } from '../types/workflow-definition.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { TraceEntry } from '../types/run-record.js';

/**
 * Validates input against the step's declared JSON Schema.
 * Throws WorkflowError(VALIDATION_INPUT_SCHEMA) on failure.
 */
export function validateInputSchema(
  input: Record<string, unknown>,
  schema: JsonSchema,
  stepId: string,
): void {
  const ajv = new Ajv();
  const valid = ajv.validate(schema as object, input);
  if (!valid) {
    throw new WorkflowError(`Invalid input for step '${stepId}'`, {
      code: 'VALIDATION_INPUT_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'provide_input',
      retryable: false,
      details: { errors: ajv.errors ?? [] },
      stepId,
    });
  }
}

/**
 * Validates the agent's submitted output against the step's declared JSON Schema.
 * Throws WorkflowError(VALIDATION_OUTPUT_SCHEMA) on failure.
 */
export function validateOutputSchema(
  output: Record<string, unknown>,
  schema: JsonSchema,
  stepId: string,
): void {
  const ajv = new Ajv();
  const valid = ajv.validate(schema as object, output);
  if (!valid) {
    throw new WorkflowError(`Output validation failed for step '${stepId}'`, {
      code: 'VALIDATION_OUTPUT_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'provide_input',
      retryable: false,
      details: { errors: ajv.errors ?? [] },
      stepId,
    });
  }
}

/**
 * issue #224 [audit F3] — the ajv-VERSION type trap. `cli` resolves ajv@6 from the repo root
 * (hoisted; `ErrorObject` is a NAMESPACE member there, `ajv.ErrorObject`, carrying `dataPath`);
 * `core` resolves its OWN ajv@8 (`ErrorObject` is a top-level named export, carrying
 * `instancePath`). A cli file that did `import type { ErrorObject } from 'ajv'` would resolve
 * against the WRONG major version and the wrong shape (or fail to resolve the named export at
 * all). This alias is exported FROM CORE (so it resolves against core's own ajv@8) — `cli` must
 * import `RawValidationError` from `@sensigo/realm`, never `from 'ajv'` directly. Runtime rows are
 * always ajv@8 (this module's own `new Ajv()` calls are the only mint site, both bare, both
 * ajv@8) — this type is a type-resolution fix only, not a runtime behavior change.
 */
export type RawValidationError = import('ajv').ErrorObject;

/** Result of {@link validateAgentSubmission}. */
export interface AgentSubmissionValidation {
  valid: boolean;
  /**
   * Raw (un-whitelisted) Ajv error rows from whichever validator rejected first — empty when
   * `valid` is true. Callers must whitelist these themselves before rendering/logging (core's own
   * `summarizeAjvErrors`, in `observability/failed-attempt-record.ts`, is private and drops fields
   * a caller may need, e.g. `params.allowedValues` — see that module's #224 note).
   */
  rawErrors: RawValidationError[];
}

/**
 * issue #224 — a NON-THROWING validator for the provider's IN-CONVERSATION correction loop
 * (never the engine — see below). PROVIDER-REPLICATE, not a unification: calls the exact same two
 * exported THROWING validators above, SEQUENTIALLY — `validateInputSchema` (when `inputSchema` is
 * given) THEN `validateOutputSchema` (when `outputSchema` is given) — each in its own try/catch,
 * mirroring the engine's Step 2b→2c order and its INPUT-FIRST SHORT-CIRCUIT (an input-schema
 * rejection returns immediately; output_schema is never checked that call, exactly like the
 * engine's own single-increment-per-rejection behavior). Both this function and the engine's Step
 * 2b/2c bottom on the SAME two functions + the same bare `new Ajv()` construction (see
 * `validateInputSchema`/`validateOutputSchema` above) — this is what makes the AJV verdict
 * divergence-proof between the provider's in-conversation check and the engine's drive-time gate,
 * WITHOUT touching or unifying the engine's own Step 2b/2c (issue #220's counting/exhaustion/
 * `last_ajv_errors` telemetry are built on those two separate throwing try-catches and must stay
 * byte-unchanged — see execution-loop.ts's `countRejection`).
 *
 * Mirrors the engine's `_debug` strip (execution-loop.ts:996-1002) before validating either
 * schema: the engine never validates a submission's `_debug` field, so a `_debug`-bearing object
 * that would PASS after stripping must also pass here — otherwise, under
 * `additionalProperties:false`, this function would OVER-REJECT an object the engine would
 * happily accept, burning the shared tool-call budget on a would-succeed step.
 *
 * Returns the RAW error rows only (never a pre-summarized shape) — the caller does its own
 * whitelisting; see `AgentSubmissionValidation.rawErrors`'s own doc for why.
 *
 * **Do NOT construct a fresh `Ajv()` anywhere in this function** (pin (a), the source-text guard)
 * — every verdict must route through `validateInputSchema`/`validateOutputSchema` above.
 */
export function validateAgentSubmission(
  obj: Record<string, unknown>,
  schemas: { inputSchema?: JsonSchema; outputSchema?: JsonSchema },
  stepId: string,
): AgentSubmissionValidation {
  // Mirror execution-loop.ts's _debug strip exactly — never validated, never hashed.
  let effectiveObj = obj;
  if (Object.prototype.hasOwnProperty.call(obj, '_debug')) {
    const { _debug: _omit, ...rest } = obj;
    effectiveObj = rest;
  }

  if (schemas.inputSchema !== undefined) {
    try {
      validateInputSchema(effectiveObj, schemas.inputSchema, stepId);
    } catch (err) {
      return { valid: false, rawErrors: extractRawErrors(err) };
    }
  }
  if (schemas.outputSchema !== undefined) {
    try {
      validateOutputSchema(effectiveObj, schemas.outputSchema, stepId);
    } catch (err) {
      return { valid: false, rawErrors: extractRawErrors(err) };
    }
  }
  return { valid: true, rawErrors: [] };
}

/** Pulls the raw ajv error rows off a caught `WorkflowError`; `[]` for anything else. */
function extractRawErrors(err: unknown): RawValidationError[] {
  if (!(err instanceof WorkflowError)) return [];
  const errors = err.details['errors'];
  return Array.isArray(errors) ? (errors as RawValidationError[]) : [];
}

export interface TraceSchemaWarnResult {
  errorCount: number;
  warning: string;
}

/**
 * Validates canonical trace entries against the step's declared trace_schema.
 *
 * In 'enforce' mode: throws WorkflowError(VALIDATION_TRACE_SCHEMA, agentAction: 'provide_input').
 * In 'warn' mode: returns a result with errorCount and a human-readable warning string.
 * Returns { errorCount: 0, warning: '' } when validation passes in warn mode.
 */
export function validateTraceSchema(
  entries: TraceEntry[],
  schema: JsonSchema,
  stepId: string,
  mode: 'enforce',
): void;
export function validateTraceSchema(
  entries: TraceEntry[],
  schema: JsonSchema,
  stepId: string,
  mode: 'warn',
): TraceSchemaWarnResult;
export function validateTraceSchema(
  entries: TraceEntry[],
  schema: JsonSchema,
  stepId: string,
  mode: 'warn' | 'enforce',
): TraceSchemaWarnResult | void {
  const ajv = new Ajv();
  const valid = ajv.validate(schema as object, entries);
  if (valid) {
    if (mode === 'warn') return { errorCount: 0, warning: '' };
    return;
  }

  if (mode === 'enforce') {
    throw new WorkflowError(`Trace schema validation failed for step '${stepId}'`, {
      code: 'VALIDATION_TRACE_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'provide_input',
      retryable: false,
      details: { errors: ajv.errors ?? [] },
      stepId,
    });
  }

  // warn mode — return error details without throwing
  const errorSummary = (ajv.errors ?? [])
    .map((e) => `${e.instancePath !== '' ? e.instancePath + ' ' : ''}${e.message ?? ''}`.trim())
    .join('; ');
  return {
    errorCount: (ajv.errors ?? []).length,
    warning: `Trace schema violation for step '${stepId}': ${errorSummary}`,
  };
}
