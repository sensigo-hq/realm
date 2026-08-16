// Loader validation for `structured_output: 'strict'` (issue #236, Deliverable 2 — Phase A).
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromString, loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';

const CLEAN_SCHEMA_YAML = `
id: structured-output-wf
name: Structured Output Workflow
version: 1
steps:
  classify:
    description: Classify the ticket
    execution: agent
    structured_output: strict
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string }
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

describe('yaml-loader — structured_output (issue #236)', () => {
  it('an eligible schema loads clean and preserves structured_output', () => {
    const def = loadWorkflowFromString(CLEAN_SCHEMA_YAML);
    expect(def.steps['classify']!.structured_output).toBe('strict');
  });

  it('rejects structured_output on a non-agent step', () => {
    const yaml = CLEAN_SCHEMA_YAML.replace('execution: agent', 'execution: auto');
    expectMessage(yaml, "'structured_output' is only valid on execution: agent steps");
  });

  it("rejects a value other than the literal 'strict'", () => {
    const yaml = CLEAN_SCHEMA_YAML.replace('structured_output: strict', 'structured_output: yes');
    expectMessage(yaml, "'structured_output' must be the literal string 'strict'");
  });

  it('rejects an ineligible schema (missing additionalProperties) with the remediation inline', () => {
    const yaml = CLEAN_SCHEMA_YAML.replace('      additionalProperties: false\n', '');
    expectMessage(yaml, 'not eligible for this step');
    expectMessage(yaml, 'additionalProperties: false');
  });

  it('rejects a no-schema opt-in (G0)', () => {
    const yaml = `
id: no-schema-wf
name: No Schema
version: 1
steps:
  work:
    description: Work
    execution: agent
    structured_output: strict
`;
    expectMessage(yaml, 'add output_schema');
  });

  it('does NOT reject a caveat-only (eligible_with_caveats) schema — caveats are informational, never a load error', () => {
    const yaml = CLEAN_SCHEMA_YAML.replace(
      'category: { type: string }',
      'category: { type: string, pattern: "^[a-z]+$" }',
    );
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
  });

  // INVERTED by issue #311: the loader used to reject this. Strict on a tools-bearing step is now
  // a supported, meaningful declaration (it constrains TOOL-CALL ARGUMENTS, per tool, assessed at
  // runtime), so Phase A returns a caveat rather than an ineligible verdict — and the loader
  // errors only on ineligible verdicts, which is why it needs no diff of its own. The nudge is
  // delivered on validate's INFO channel; it is deliberately NOT a LoaderWarning, because a new
  // WarningCode would auto-fail `validate --strict`.
  it('ACCEPTS a tools-bearing step (issue #311: strict now targets tool-call arguments) — no throw, and no warning that could fail --strict', () => {
    const yaml = `
id: g6-tools-wf
name: G6 Tools
version: 1
mcp_servers:
  - id: github
    command: npx
    args: ['-y', 'mcp-github']
steps:
  classify:
    description: Classify the ticket
    execution: agent
    structured_output: strict
    tools: ['github:get_pull_request']
    input_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string }
`;
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
    // The `--strict` rail: the acceptance must not smuggle in a LoaderWarning, since `failsStrict`
    // escalates EVERY warning code to an error.
    const { warnings } = loadWorkflowFromStringWithDiagnostics(yaml);
    expect(warnings).toEqual([]);
  });

  it('a step with no structured_output key is entirely unaffected (default-OFF posture)', () => {
    const yaml = CLEAN_SCHEMA_YAML.replace('    structured_output: strict\n', '').replace(
      '      additionalProperties: false\n',
      '',
    );
    // Missing additionalProperties would be a G1 violation IF opted in — but with no
    // structured_output key at all, the eligibility gate never runs.
    expect(() => loadWorkflowFromString(yaml)).not.toThrow();
  });
});
