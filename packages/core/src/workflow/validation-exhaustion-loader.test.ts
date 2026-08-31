// Loader validation for issue #220: the `validation_exhaustion` step key (agent-only) and the
// `$settlement` reserved-name legislation. PR-1 shipped `{ threshold? }`; PR-2 (this file's
// (y)/(z) additions) extends the rule table with `mode`/`default_output` — the declared,
// load-time-proven fail-open surface.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromString, loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';
import { validateOutputSchema } from '../validation/input-schema.js';
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

    it('mode: fail is a fully-supported value — registers clean, no warning (issue #220 PR-2)', () => {
      const { definition, warnings } = loadWorkflowFromStringWithDiagnostics(`
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
      expect(warnings).toEqual([]);
      expect(definition.steps['draft']?.validation_exhaustion).toEqual({ mode: 'fail' });
    });

    it('an unrecognized validation_exhaustion sub-key still warns UNKNOWN_VALIDATION_EXHAUSTION_KEY (issue #220 PR-2 — replaces the PR-1 mode/default_output reuse)', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: vx-unknown-key-wf
name: VX Unknown Key
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion:
      bogus_key: 1
`);
      const w = warnings.find((warning) => warning.key === 'bogus_key');
      expect(w).toBeDefined();
      expect(w?.code).toBe('UNKNOWN_VALIDATION_EXHAUSTION_KEY');
      expect(w?.severity).toBe('warn');
      expect(w?.message).toContain('validation_exhaustion');
      // (y)/(z): rendered like every warning — `⚠ ` + the message (issue #444).
      expect(renderLoaderWarning(w!)).toMatch(/^⚠ /);
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

  describe('(y) PR-2 fail-open rule-table rows', () => {
    it('mode value refusal: an unrecognized mode value is a hard error (unvalidatable posture)', () => {
      expectThrows(
        `
id: vx-bad-mode-wf
name: VX Bad Mode
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion:
      mode: bogus
`,
        "'validation_exhaustion.mode' must be 'fail' or 'default'",
      );
    });

    it('mode: default without default_output is a hard error (nothing to substitute)', () => {
      expectThrows(
        `
id: vx-default-no-output-wf
name: VX Default No Output
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion:
      mode: default
`,
        "'validation_exhaustion.mode: default' requires 'default_output'",
      );
    });

    it('B5: mode: default + default_output but no output_schema is a hard error (unvalidatable default)', () => {
      expectThrows(
        `
id: vx-default-no-schema-wf
name: VX Default No Schema
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion:
      mode: default
      default_output: { category: 'x' }
`,
        "'validation_exhaustion.default_output' requires the step to declare 'output_schema'",
      );
    });

    it('B10: default_output that FAILS the output_schema is refused at load — VERDICT agreement with validateOutputSchema, not error-shape', () => {
      const schema = {
        type: 'object',
        required: ['category'],
        properties: { category: { type: 'string' } },
      };
      // Same (default_output, output_schema) pair a direct validateOutputSchema call rejects.
      expect(() => validateOutputSchema({ wrong: 1 }, schema, 'draft')).toThrow(WorkflowError);
      expectThrows(
        `
id: vx-b10-fail-wf
name: VX B10 Fail
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    output_schema:
      type: object
      required: [category]
      properties:
        category: { type: string }
    validation_exhaustion:
      mode: default
      default_output: { wrong: 1 }
`,
        "'validation_exhaustion.default_output' does not validate against the step's own 'output_schema'",
      );
    });

    it('B10: default_output that PASSES the output_schema registers clean — same pair validateOutputSchema accepts', () => {
      const schema = {
        type: 'object',
        required: ['category'],
        properties: { category: { type: 'string' } },
      };
      // Same (default_output, output_schema) pair a direct validateOutputSchema call accepts.
      expect(() => validateOutputSchema({ category: 'billing' }, schema, 'draft')).not.toThrow();
      const def = loadWorkflowFromString(`
id: vx-b10-pass-wf
name: VX B10 Pass
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    output_schema:
      type: object
      required: [category]
      properties:
        category: { type: string }
    validation_exhaustion:
      mode: default
      default_output: { category: 'billing' }
`);
      expect(def.steps['draft']?.validation_exhaustion).toEqual({
        mode: 'default',
        default_output: { category: 'billing' },
      });
    });

    it('a structurally malformed output_schema on a mode: default step REFUSES at load (the new refusal population — a raw Ajv compile error, not a WorkflowError)', () => {
      expectThrows(
        `
id: vx-malformed-schema-wf
name: VX Malformed Schema
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    output_schema:
      type: object
      properties:
        category: { type: 12345 }
    validation_exhaustion:
      mode: default
      default_output: { category: 'billing' }
`,
        "'validation_exhaustion.default_output' does not validate against the step's own 'output_schema'",
      );
    });

    it('dead-config WARN: default_output present without mode: default (mode absent) is ignored, never rejected', () => {
      const { definition, warnings } = loadWorkflowFromStringWithDiagnostics(`
id: vx-dead-config-wf
name: VX Dead Config
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion:
      default_output: { category: 'x' }
`);
      expect(definition.steps['draft']?.validation_exhaustion).toEqual({
        default_output: { category: 'x' },
      });
      expect(warnings).toHaveLength(1);
      const w = warnings[0]!;
      expect(w.code).toBe('DEAD_VALIDATION_EXHAUSTION_CONFIG');
      expect(w.severity).toBe('warn');
      expect(w.message).toContain('default_output');
      expect(w.message).toContain('mode: default');
      // issue #444: every code renders `⚠ ` + its message. The hygiene conjunct is on w.message
      // — and this is the strongest of the four, because `w` here is a REAL warning the core
      // loader just minted, not a hand-built fixture. If that mint ever bakes a prefix, this reds.
      expect(renderLoaderWarning(w)).toBe(`⚠ ${w.message}`);
      expect(w.message).not.toMatch(/^⚠/);
    });

    it('dead-config WARN: default_output present with mode: fail (explicit) is also ignored', () => {
      const { warnings } = loadWorkflowFromStringWithDiagnostics(`
id: vx-dead-config-explicit-fail-wf
name: VX Dead Config Explicit Fail
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    validation_exhaustion:
      mode: fail
      default_output: { category: 'x' }
`);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.code).toBe('DEAD_VALIDATION_EXHAUSTION_CONFIG');
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
