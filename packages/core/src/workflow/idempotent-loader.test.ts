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

  it('WARNS (does not reject) when idempotent: true cannot enable auto-reclaim in a finalizer-bearing workflow', () => {
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
    // Issue #140 C5 reword: the reclaim function's inertness, not a blanket "idempotent is inert".
    expect(out).toContain('cannot enable auto-reclaim in a finalizer-bearing workflow');
    expect(out).toContain('work');
    warn.mockRestore();
  });

  describe('issue #140 C5 — variant-aware reword of IDEMPOTENT_INERT_IN_FINALIZER', () => {
    it('WITHOUT on_timeout: the message says nothing about the on_timeout gate', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadWorkflowFromString(`
id: idem-wf-no-on-timeout
name: Idem No On Timeout
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
      const out = warn.mock.calls.flat().join('\n');
      expect(out).toContain("'idempotent: true' cannot enable auto-reclaim in a finalizer-bearing");
      expect(out).not.toContain('on_timeout');
      warn.mockRestore();
    });

    it('WITH on_timeout: the message ALSO states the gate role is unaffected — timeout retries remain active', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadWorkflowFromString(`
id: idem-wf-with-on-timeout
name: Idem With On Timeout
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    idempotent: true
    retry:
      max_attempts: 3
      on_timeout: true
  cleanup:
    description: Finalizer
    execution: finalizer
    on_outcome: always
    handler: hc
`);
      const out = warn.mock.calls.flat().join('\n');
      expect(out).toContain("'idempotent: true' cannot enable auto-reclaim in a finalizer-bearing");
      expect(out).toContain(
        "Its 'retry.on_timeout' gate role is unaffected — timeout retries remain active.",
      );
      warn.mockRestore();
    });
  });
});
