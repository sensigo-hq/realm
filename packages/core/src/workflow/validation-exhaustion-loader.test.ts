// Loader validation for issue #220 PR-1: the `validation_exhaustion` step key (agent-only,
// `{ threshold? }` only) and the `$settlement` reserved-name legislation.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromString, loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';

function expectThrows(yaml: string, substring: string): void {
  expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
  try {
    loadWorkflowFromString(yaml);
    throw new Error('expected loadWorkflowFromString to throw');
  } catch (err) {
    expect((err as WorkflowError).message).toContain(substring);
  }
}

describe('yaml-loader — issue #220 PR-1 validation_exhaustion', () => {
  describe('(y) loader rows', () => {
    it('agent-only refusal: validation_exhaustion on an auto step is a hard error', () => {
      expectThrows(
        `
id: vx-auto-wf
name: VX Auto
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    validation_exhaustion:
      threshold: 3
`,
        "'validation_exhaustion' is only valid on execution: agent steps",
      );
    });

    it('agent-only refusal: validation_exhaustion on a guard step is a hard error', () => {
      expectThrows(
        `
id: vx-guard-wf
name: VX Guard
version: 1
steps:
  work:
    description: Work
    execution: guard
    abort_unless: ["work.ok == true"]
    validation_exhaustion:
      threshold: 3
`,
        "'validation_exhaustion' is only valid on execution: agent steps",
      );
    });

    it('threshold range refusal: 0 is rejected', () => {
      expectThrows(
        `
id: vx-zero-wf
name: VX Zero
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion:
      threshold: 0
`,
        "'validation_exhaustion.threshold' must be a positive integer",
      );
    });

    it('threshold range refusal: a negative value is rejected', () => {
      expectThrows(
        `
id: vx-neg-wf
name: VX Negative
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion:
      threshold: -1
`,
        "'validation_exhaustion.threshold' must be a positive integer",
      );
    });

    it('threshold range refusal: a non-integer (1.5) value is rejected', () => {
      expectThrows(
        `
id: vx-frac-wf
name: VX Fractional
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion:
      threshold: 1.5
`,
        "'validation_exhaustion.threshold' must be a positive integer",
      );
    });

    it('threshold: 1 is accepted (documented as disabling in-drive schema-repair)', () => {
      const def = loadWorkflowFromString(`
id: vx-one-wf
name: VX One
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion:
      threshold: 1
`);
      expect(def.steps['draft']?.validation_exhaustion).toEqual({ threshold: 1 });
    });

    it('unknown sub-key warning: mode is not yet supported in PR-1 and draws a warning, never a rejection', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: vx-mode-wf
name: VX Mode
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion:
      mode: fail
`);
      const w = warnings.find((warning) => warning.key === 'mode');
      expect(w).toBeDefined();
      expect(w?.message).toContain('validation_exhaustion');
    });

    it('unknown sub-key warning: default_output is not yet supported in PR-1 and draws a warning, never a rejection', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: vx-default-output-wf
name: VX Default Output
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion:
      default_output: { category: 'x' }
`);
      const w = warnings.find((warning) => warning.key === 'default_output');
      expect(w).toBeDefined();
      expect(w?.message).toContain('validation_exhaustion');
    });

    it('a bare validation_exhaustion: {} (no threshold) is legal — the default applies', () => {
      const def = loadWorkflowFromString(`
id: vx-bare-wf
name: VX Bare
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion: {}
`);
      expect(def.steps['draft']?.validation_exhaustion).toEqual({});
    });
  });

  describe('(cc) reserved-name refusal — the loader half', () => {
    it('$settlement is refused as a step id', () => {
      expectThrows(
        `
id: settlement-name-wf
name: Settlement Name
version: 1
steps:
  $settlement:
    description: Work
    execution: auto
    handler: h
`,
        "Step name '$settlement' is reserved",
      );
    });

    it('run and context remain refused as step ids (pre-existing, unaffected by this change)', () => {
      expectThrows(
        `
id: run-name-wf
name: Run Name
version: 1
steps:
  run:
    description: Work
    execution: auto
    handler: h
`,
        "Step name 'run' is reserved",
      );
    });
  });
});
