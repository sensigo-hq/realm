// issue #759 (Part C): a refusal whose rows name nothing keeps the engine's message ALONE — no
// trailing `: `, no `and 0 more` (today's rule at pending.ts, kept). Core's Ajv always writes a
// message on a row, so no real schema reaches this branch: the validator is replaced here, in its
// own file, by one whose refusal carries a row with no message. A failure prints the refusal.
import { describe, it, expect, vi } from 'vitest';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

vi.mock('../validation/input-schema.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../validation/input-schema.js')>()),
  validateInputSchema: (_input: unknown, _schema: unknown, stepId: string): never => {
    throw new WorkflowError(`Invalid input for step '${stepId}'`, {
      code: 'VALIDATION_INPUT_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'provide_input',
      retryable: false,
      facts: { errors: [{ keyword: 'required' } as never], error_count: 1 },
      stepId,
    });
  },
}));

const { describePending } = await import('./pending.js');

describe('issue #759 — a refusal with no usable row', () => {
  it("keeps the engine's message alone (red: an empty sentence appended — a trailing `: `)", () => {
    const definition = {
      id: 'w',
      name: 'W',
      version: 1,
      steps: {
        x: {
          description: 'X',
          execution: 'auto',
          depends_on: [],
          input_schema: { type: 'object', required: ['a'] },
        },
      },
    } as unknown as WorkflowDefinition;
    const run = {
      id: 'r',
      params: {},
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence: [],
      terminal_state: false,
    } as unknown as RunRecord;
    expect(
      describePending(definition, run, undefined, new Date()).engine_runnable[0]?.refusal,
    ).toBe("Invalid input for step 'x'");
  });
});
