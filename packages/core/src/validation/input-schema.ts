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
