// issue #236, Deliverable 7 — the structured_output adoption nudge on validate's own INFO
// channel. In-process via commander's parseAsync (validate-retry-timeout-advisory.test.ts's own
// precedent) — no subprocess/dist rebuild needed to observe console.log output.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';

describe('validate — structured_output nudge (issue #236)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-so-nudge-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function write(yaml: string): string {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(wfPath, yaml, 'utf8');
    return wfPath;
  }

  it('a NOT-opted-in ineligible schema prints the exact migration remediation, and does NOT fail --strict', async () => {
    const wfPath = write(`
id: nudge-ineligible
name: Nudge Ineligible
version: 1
steps:
  classify:
    description: classify
    execution: agent
    output_schema:
      type: object
      required: [category]
      properties:
        category: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await validateCommand.parseAsync([wfPath, '--strict'], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain("Step 'classify'");
    expect(logged).toContain('one line short');
    expect(logged).toContain('additionalProperties: false');
    expect(exitSpy).not.toHaveBeenCalled(); // the nudge never affects --strict's exit code
  });

  it('a NOT-opted-in eligible_with_caveats schema prints the caveat remediation', async () => {
    const wfPath = write(`
id: nudge-caveat
name: Nudge Caveat
version: 1
steps:
  classify:
    description: classify
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string, pattern: "^[a-z]+$" }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain("Step 'classify'");
    expect(logged).toContain('eligible for structured_output: strict, with caveat');
  });

  it('an eligible schema with an optional reasoning-like property names the instance', async () => {
    const wfPath = write(`
id: nudge-reasoning
name: Nudge Reasoning
version: 1
steps:
  classify:
    description: classify
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string }
        reasoning: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain("the optional 'reasoning' property looks like a reasoning field");
  });

  it('an already-opted-in step with caveats prints its OWN caveat wording (not the "eligible for" migration framing)', async () => {
    const wfPath = write(`
id: nudge-opted
name: Nudge Opted
version: 1
steps:
  classify:
    description: classify
    execution: agent
    structured_output: strict
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string, pattern: "^[a-z]+$" }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain("Step 'classify': structured_output caveat");
    expect(logged).not.toContain('eligible for structured_output: strict, with caveat');
  });

  it('a fully-required (zero-optional), eligible, NOT-opted-in schema prints the opt-in suggestion — never a bare "eligible"', async () => {
    const wfPath = write(`
id: nudge-bare-eligible
name: Nudge Bare Eligible
version: 1
steps:
  classify:
    description: classify
    execution: agent
    output_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain("add 'structured_output: strict' to opt in");
    // Never a bare standalone "eligible" line with nothing else.
    expect(logged).not.toMatch(/Step 'classify': eligible\.?\s*$/m);
  });

  it('a step with no schema at all is silently skipped (nothing to nudge)', async () => {
    const wfPath = write(`
id: nudge-no-schema
name: Nudge No Schema
version: 1
steps:
  work:
    description: work
    execution: agent
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain('structured_output');
  });

  it('an auto step (non-agent) is never nudged, even with an output_schema-shaped input_schema present', async () => {
    const wfPath = write(`
id: nudge-auto-skip
name: Nudge Auto Skip
version: 1
steps:
  work:
    description: work
    execution: auto
    input_schema:
      type: object
      properties:
        x: { type: string }
`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain('structured_output');
  });
});
