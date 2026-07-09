// Loader warning for an agent step declaring BOTH input_schema and output_schema (Group A,
// robust-anthropic-provider #Part 6). The submitted output is validated against BOTH schemas
// (execution-loop.ts validateInputSchema + validateOutputSchema) — a divergence between them
// degrades to a confusing recoverable VALIDATION_*_SCHEMA error, so the loader warns (never rejects).
import { describe, it, expect, vi } from 'vitest';
import { loadWorkflowFromString } from './yaml-loader.js';

describe('yaml-loader — both input_schema and output_schema on an agent step (warn-only)', () => {
  it('WARNS (does not reject) when an agent step declares both schemas', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = loadWorkflowFromString(`
id: both-schema-wf
name: Both Schema
version: 1
steps:
  classify:
    description: Classify
    execution: agent
    input_schema:
      type: object
      properties:
        category: { type: string }
      required: [category]
    output_schema:
      type: object
      properties:
        category: { type: string }
      required: [category]
`);
    // Loaded (not rejected), both schemas preserved, but a warning was emitted naming the step.
    expect(def.steps['classify']!.input_schema).toBeDefined();
    expect(def.steps['classify']!.output_schema).toBeDefined();
    const out = warn.mock.calls.flat().join('\n');
    expect(out).toContain('classify');
    expect(out).toContain('input_schema');
    expect(out).toContain('output_schema');
    warn.mockRestore();
  });

  it('does NOT warn when only output_schema is declared', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadWorkflowFromString(`
id: output-only-wf
name: Output Only
version: 1
steps:
  classify:
    description: Classify
    execution: agent
    output_schema:
      type: object
      properties:
        category: { type: string }
      required: [category]
`);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does NOT warn when only input_schema is declared', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadWorkflowFromString(`
id: input-only-wf
name: Input Only
version: 1
steps:
  classify:
    description: Classify
    execution: agent
    input_schema:
      type: object
      properties:
        category: { type: string }
      required: [category]
`);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does NOT warn for a non-agent step (input_schema is valid on other execution types)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadWorkflowFromString(`
id: auto-wf
name: Auto
version: 1
steps:
  work:
    description: Work
    execution: auto
    handler: h
    input_schema:
      type: object
      properties:
        x: { type: string }
`);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
