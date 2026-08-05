// Loader validation for `execution: finalizer` steps (the workflow-level try/catch/finally).
// Source: yaml-loader.ts — finalizer constraints, on_outcome enum, cross-ref/name/all-finalizer.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromString } from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';

// A valid workflow with one domain step (the "try") and one finalizer.
const VALID_FINALIZER_YAML = `
id: finalizer-wf
name: Finalizer Workflow
version: 1
steps:
  work:
    description: Domain step
    execution: agent
    depends_on: []
  cleanup:
    description: Cleanup finalizer
    execution: finalizer
    on_outcome: always
    handler: do_cleanup
`;

function expectMessage(yaml: string, substring: string): void {
  expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
  try {
    loadWorkflowFromString(yaml);
    throw new Error('expected loadWorkflowFromString to throw');
  } catch (err) {
    expect((err as WorkflowError).message).toContain(substring);
  }
}

describe('yaml-loader — execution: finalizer', () => {
  it('a valid finalizer workflow loads and preserves on_outcome + handler', () => {
    const def = loadWorkflowFromString(VALID_FINALIZER_YAML);
    const cleanup = def.steps['cleanup']!;
    expect(cleanup.execution).toBe('finalizer');
    expect(cleanup.on_outcome).toBe('always');
    expect(cleanup.handler).toBe('do_cleanup');
  });

  it('accepts on_outcome in array (set) form', () => {
    const yaml = VALID_FINALIZER_YAML.replace('on_outcome: always', 'on_outcome: [fail, abort]');
    const def = loadWorkflowFromString(yaml);
    expect(def.steps['cleanup']!.on_outcome).toEqual(['fail', 'abort']);
  });

  // issue #302 (correction): the shipped code was verified by value to accept the new literal,
  // but nothing forced the YAML LOADER's own acceptance — every CWFS test constructed its
  // definition programmatically. Finalizers are YAML-only authoring, so this is the one link a
  // regression re-narrowing VALID_FINALIZER_TRIGGERS would silently break.
  it('accepts on_outcome: completed_with_failed_steps (the new #302 literal)', () => {
    const yaml = VALID_FINALIZER_YAML.replace(
      'on_outcome: always',
      'on_outcome: completed_with_failed_steps',
    );
    const def = loadWorkflowFromString(yaml);
    expect(def.steps['cleanup']!.on_outcome).toBe('completed_with_failed_steps');
  });

  it('accepts on_outcome: [fail, completed_with_failed_steps] — the documented canonical array example', () => {
    const yaml = VALID_FINALIZER_YAML.replace(
      'on_outcome: always',
      'on_outcome: [fail, completed_with_failed_steps]',
    );
    const def = loadWorkflowFromString(yaml);
    expect(def.steps['cleanup']!.on_outcome).toEqual(['fail', 'completed_with_failed_steps']);
  });

  it('control: a genuinely invalid trigger (completed_with_issues) still rejects — the gate itself still has teeth', () => {
    const yaml = VALID_FINALIZER_YAML.replace(
      'on_outcome: always',
      'on_outcome: completed_with_issues',
    );
    expectMessage(yaml, "invalid on_outcome value 'completed_with_issues'");
  });

  it('accepts finalizer with a valid timeout_seconds', () => {
    const yaml = VALID_FINALIZER_YAML.replace(
      'handler: do_cleanup',
      'handler: do_cleanup\n    timeout_seconds: 5',
    );
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
  });

  it('finalizer requires on_outcome', () => {
    const yaml = VALID_FINALIZER_YAML.replace('    on_outcome: always\n', '');
    expectMessage(yaml, "execution: finalizer requires 'on_outcome'");
  });

  it('finalizer requires handler (handler-only in v1)', () => {
    const yaml = VALID_FINALIZER_YAML.replace('    handler: do_cleanup\n', '');
    expectMessage(yaml, "execution: finalizer requires 'handler'");
  });

  it('rejects an unknown on_outcome value by name', () => {
    const yaml = VALID_FINALIZER_YAML.replace('on_outcome: always', 'on_outcome: sometimes');
    expectMessage(yaml, "invalid on_outcome value 'sometimes'");
  });

  it('rejects an unknown on_outcome value inside the array form', () => {
    const yaml = VALID_FINALIZER_YAML.replace(
      'on_outcome: always',
      'on_outcome: [complete, bogus]',
    );
    expectMessage(yaml, "invalid on_outcome value 'bogus'");
  });

  it('rejects an empty on_outcome array', () => {
    const yaml = VALID_FINALIZER_YAML.replace('on_outcome: always', 'on_outcome: []');
    expectMessage(yaml, "'on_outcome' must not be empty");
  });

  // Every prohibited field must produce a targeted per-field error.
  it.each([
    ['depends_on', 'depends_on: [work]'],
    ['trigger_rule', 'trigger_rule: all_done'],
    ['abort_unless', 'abort_unless: ["work.x == 1"]'],
    ['abort_message', 'abort_message: nope'],
    ['output_schema', 'output_schema: {type: object}'],
    ['agent_profile', 'agent_profile: some_profile'],
    ['tools', 'tools: [some_tool]'],
    ['uses_service', 'uses_service: some_service'],
    ['service_method', 'service_method: get'],
    ['operation', 'operation: some_op'],
    ['input_map', 'input_map: {foo: run.params.foo}'],
    ['when', 'when: ["work.x == 1"]'],
    ['retry', 'retry: {max_attempts: 3, backoff: fixed, base_delay_ms: 1}'],
  ])('rejects prohibited field %s on a finalizer', (field, snippet) => {
    const yaml = VALID_FINALIZER_YAML.replace(
      'handler: do_cleanup',
      `handler: do_cleanup\n    ${snippet}`,
    );
    expectMessage(yaml, `'${field}' is not valid on execution: finalizer`);
  });

  it('rejects a human-gate trust on a finalizer (a finalizer must not gate)', () => {
    const yaml = VALID_FINALIZER_YAML.replace(
      'handler: do_cleanup',
      'handler: do_cleanup\n    trust: human_confirmed',
    );
    expectMessage(yaml, 'a finalizer must not gate');
  });

  it('rejects on_outcome on a non-finalizer step', () => {
    const yaml = VALID_FINALIZER_YAML.replace(
      '    execution: agent\n    depends_on: []',
      '    execution: agent\n    depends_on: []\n    on_outcome: complete',
    );
    expectMessage(yaml, "'on_outcome' is only valid on execution: finalizer");
  });

  it('rejects a domain step whose depends_on names a finalizer (would deadlock)', () => {
    const yaml = `
id: dep-on-finalizer-wf
name: Dep On Finalizer
version: 1
steps:
  work:
    description: Domain step
    execution: agent
    depends_on: []
  after:
    description: Depends on a held-out finalizer
    execution: agent
    depends_on: [cleanup]
  cleanup:
    description: Cleanup finalizer
    execution: finalizer
    on_outcome: always
    handler: do_cleanup
`;
    expectMessage(yaml, "depends_on references finalizer step 'cleanup'");
  });

  it('rejects an integer-like step name (would reorder under JS object iteration)', () => {
    const yaml = `
id: int-name-wf
name: Integer Name
version: 1
steps:
  work:
    description: Domain step
    execution: agent
    depends_on: []
  "42":
    description: Integer-like finalizer name
    execution: finalizer
    on_outcome: always
    handler: do_cleanup
`;
    expectMessage(yaml, 'integer-like names reorder');
  });

  it('rejects a workflow of only finalizer steps', () => {
    const yaml = `
id: only-finalizers-wf
name: Only Finalizers
version: 1
steps:
  cleanup:
    description: Cleanup finalizer
    execution: finalizer
    on_outcome: always
    handler: do_cleanup
`;
    expectMessage(yaml, 'at least one non-finalizer step is required');
  });
});
