// Loader validation for issue #291: the `gate.timeout_seconds` / `gate.on_expiry` /
// `gate.default_choice` / `gate.reminder_seconds` / `gate.reminder_max` sub-keys — the FIRST
// gate sub-key validation the loader has ever had. Deliverable 1.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromString, loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';
import { renderLoaderWarning } from './diagnostics.js';

function expectThrows(yaml: string, substring: string): void {
  expect(() => loadWorkflowFromString(yaml)).toThrow(WorkflowError);
  try {
    loadWorkflowFromString(yaml);
    throw new Error('expected loadWorkflowFromString to throw');
  } catch (err) {
    expect((err as WorkflowError).message).toContain(substring);
  }
}

function gateWorkflow(gateBlock: string, extra = ''): string {
  return `
id: gate-timeout-wf
name: Gate Timeout Fixture
version: 1
steps:
  approve:
    description: Approve
    execution: auto
    handler: h
    trust: human_confirmed
    gate:
${gateBlock}
${extra}
`;
}

describe('yaml-loader — issue #291 gate.* sub-keys', () => {
  describe('unknown key warning', () => {
    it("warns on a typo'd gate sub-key, never rejects", () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      timeout_secondz: 60'),
      );
      const gateWarning = warnings.find((w) => w.code === 'UNKNOWN_GATE_KEY');
      expect(gateWarning).toBeDefined();
      expect(renderLoaderWarning(gateWarning!)).toContain("unknown key 'timeout_secondz'");
      expect(renderLoaderWarning(gateWarning!)).toContain('did you mean');
    });
  });

  describe('E2 positive-integer checks', () => {
    it('rejects timeout_seconds: 0', () => {
      expectThrows(
        gateWorkflow('      timeout_seconds: 0'),
        "'gate.timeout_seconds' must be a positive integer",
      );
    });
    it('rejects timeout_seconds: -1', () => {
      expectThrows(
        gateWorkflow('      timeout_seconds: -1'),
        "'gate.timeout_seconds' must be a positive integer",
      );
    });
    it('rejects reminder_seconds: 0', () => {
      expectThrows(
        gateWorkflow('      reminder_seconds: 0'),
        "'gate.reminder_seconds' must be a positive integer",
      );
    });
    it('rejects reminder_max: 0', () => {
      expectThrows(
        gateWorkflow(
          '      timeout_seconds: 600\n      reminder_seconds: 60\n      reminder_max: 0',
        ),
        "'gate.reminder_max' must be a positive integer",
      );
    });
  });

  describe('on_expiry enum', () => {
    it('rejects an invalid on_expiry value', () => {
      expectThrows(
        gateWorkflow('      timeout_seconds: 60\n      on_expiry: retry'),
        "'gate.on_expiry' must be 'settle_default' or 'abort'",
      );
    });
    it('accepts on_expiry: abort with no default_choice', () => {
      const def = loadWorkflowFromString(
        gateWorkflow('      timeout_seconds: 60\n      on_expiry: abort'),
      );
      expect(def.steps['approve']!.gate?.on_expiry).toBe('abort');
    });
  });

  describe('default_choice required-iff settle_default (hard error both directions)', () => {
    it('rejects settle_default with no default_choice', () => {
      expectThrows(
        gateWorkflow('      timeout_seconds: 60\n      on_expiry: settle_default'),
        "'gate.on_expiry: settle_default' requires 'gate.default_choice'",
      );
    });
    it('accepts settle_default with a valid default_choice from the builtin fallback set', () => {
      const def = loadWorkflowFromString(
        gateWorkflow(
          '      timeout_seconds: 60\n      on_expiry: settle_default\n      default_choice: approve',
        ),
      );
      expect(def.steps['approve']!.gate?.default_choice).toBe('approve');
    });
    it('rejects a default_choice not in the declared gate.choices set', () => {
      expectThrows(
        gateWorkflow(
          '      choices: [yes, no]\n      timeout_seconds: 60\n      on_expiry: settle_default\n      default_choice: approve',
        ),
        "'gate.default_choice' (\"approve\") is not one of the step's effective choices: yes, no",
      );
    });
    it('accepts a default_choice matching the declared gate.choices set', () => {
      const def = loadWorkflowFromString(
        gateWorkflow(
          '      choices: [yes, no]\n      timeout_seconds: 60\n      on_expiry: settle_default\n      default_choice: yes',
        ),
      );
      expect(def.steps['approve']!.gate?.default_choice).toBe('yes');
    });
    it('validates default_choice against input_schema.properties.choice.enum when gate.choices is absent', () => {
      const def = loadWorkflowFromString(
        gateWorkflow(
          '      timeout_seconds: 60\n      on_expiry: settle_default\n      default_choice: ship',
          `    input_schema:
      type: object
      properties:
        choice:
          type: string
          enum: [ship, hold]
      required: [choice]`,
        ),
      );
      expect(def.steps['approve']!.gate?.default_choice).toBe('ship');
    });
  });

  describe('the two LEGAL cells (must NOT warn or error)', () => {
    it('timeout_seconds WITHOUT on_expiry is LEGAL finding-only mode — no warning at all', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      timeout_seconds: 60'),
      );
      expect(warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG')).toEqual([]);
    });
    it('reminder_seconds WITHOUT timeout_seconds is LEGAL pure-notify mode — no warning at all', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      reminder_seconds: 300'),
      );
      expect(warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG')).toEqual([]);
    });
  });

  describe('dead-config warn cells (never reject)', () => {
    it('warns: on_expiry declared without timeout_seconds', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      on_expiry: abort'),
      );
      const w = warnings.find((x) => x.code === 'DEAD_GATE_CONFIG');
      expect(w?.message).toContain("'gate.on_expiry' is ignored without 'gate.timeout_seconds'");
    });
    it('warns: default_choice with on_expiry: abort', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow(
          '      timeout_seconds: 60\n      on_expiry: abort\n      default_choice: approve',
        ),
      );
      const w = warnings.find((x) => x.code === 'DEAD_GATE_CONFIG');
      expect(w?.message).toContain("'gate.default_choice' is ignored without");
    });
    it('warns: default_choice with no on_expiry at all', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      default_choice: approve'),
      );
      const w = warnings.find((x) => x.code === 'DEAD_GATE_CONFIG');
      expect(w?.message).toContain("'gate.default_choice' is ignored without");
    });
    it('warns [F-A2-5]: reminder_seconds >= timeout_seconds (dead notification)', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      timeout_seconds: 60\n      reminder_seconds: 60'),
      );
      const w = warnings.find((x) => x.code === 'DEAD_GATE_CONFIG');
      expect(w?.message).toContain('the first reminder would never fire before the gate expires');
    });
    it('does NOT warn when reminder_seconds < timeout_seconds', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(
        gateWorkflow('      timeout_seconds: 600\n      reminder_seconds: 60'),
      );
      expect(warnings.filter((w) => w.code === 'DEAD_GATE_CONFIG')).toEqual([]);
    });
  });

  describe('a step with no gate: block at all is unaffected', () => {
    it('no gate warnings or errors on a plain gated step', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: plain-gate-wf
name: Plain Gate
version: 1
steps:
  approve:
    description: Approve
    execution: auto
    handler: h
    trust: human_confirmed
`);
      expect(
        warnings.filter((w) => w.code === 'UNKNOWN_GATE_KEY' || w.code === 'DEAD_GATE_CONFIG'),
      ).toEqual([]);
    });
  });
});
