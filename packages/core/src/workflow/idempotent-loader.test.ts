// Loader validation for the `idempotent` advisory hint (issue #101 Phase 2).
// Valid only on execution: auto steps; WARN (not reject) when inert in a finalizer-bearing workflow.
import { describe, it, expect, vi } from 'vitest';
import { loadWorkflowFromString } from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';

function expectMessage(yaml: string, substring: string): void {
  expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
  try {
    loadWorkflowFromString(yaml);
    throw new Error('expected loadWorkflowFromString to throw');
  } catch (err) {
    expect((err as WorkflowError).message).toContain(substring);
  }
}

describe('yaml-loader — idempotent hint (#101 Phase 2)', () => {
  it('accepts idempotent: true on an execution: auto step and preserves it', () => {
    const def = loadWorkflowFromString(`
id: idem-wf
name: Idem
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    idempotent: true
`);
    expect(def.steps['work']!.idempotent).toBe(true);
  });

  it('absent ⇒ idempotent is undefined (defaults false)', () => {
    const def = loadWorkflowFromString(`
id: idem-wf
name: Idem
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
`);
    expect(def.steps['work']!.idempotent).toBeUndefined();
  });

  it('rejects idempotent on an agent step', () => {
    expectMessage(
      `
id: idem-wf
name: Idem
version: 1
steps:
  work:
    description: Work
    execution: agent
    idempotent: true
`,
      "'idempotent' is only valid on execution: auto steps",
    );
  });

  it('rejects idempotent on a guard step', () => {
    expectMessage(
      `
id: idem-wf
name: Idem
version: 1
steps:
  work:
    description: Work
    execution: agent
  gate_check:
    description: Guard
    execution: guard
    depends_on: [work]
    abort_unless: ["work.ok == true"]
    idempotent: true
`,
      "'idempotent' is only valid on execution: auto steps",
    );
  });

  it('rejects idempotent on a finalizer step', () => {
    expectMessage(
      `
id: idem-wf
name: Idem
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
  cleanup:
    description: Finalizer
    execution: finalizer
    on_outcome: always
    handler: hc
    idempotent: true
`,
      "'idempotent' is only valid on execution: auto steps",
    );
  });

  it('WARNS (does not reject) when idempotent: true is inert in a finalizer-bearing workflow', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = loadWorkflowFromString(`
id: idem-wf
name: Idem
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    idempotent: true
  cleanup:
    description: Finalizer
    execution: finalizer
    on_outcome: always
    handler: hc
`);
    // Loaded (not rejected), idempotent preserved, but a warning was emitted.
    expect(def.steps['work']!.idempotent).toBe(true);
    const out = warn.mock.calls.flat().join('\n');
    expect(out).toContain('inert in a finalizer-bearing workflow');
    expect(out).toContain('work');
    warn.mockRestore();
  });
});
