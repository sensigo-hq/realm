// Issue #144 correction: workflow-level `description` is now a first-class, authorable field —
// `realm workflow validate` echoes it on the line after `Valid: ...` when present, and prints
// nothing extra when absent (no synthesized default). In-process via commander's parseAsync
// (same pattern as validate-retry-timeout-advisory.test.ts) — no subprocess/dist rebuild needed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';

describe('validate — description echo (issue #144 correction)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-description-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prints the description on the line after Valid: when the workflow declares one', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: with-description
name: With Description
description: What this workflow is for.
version: 1
steps:
  step-one:
    description: a step
    execution: auto
`,
      'utf8',
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const printed = logSpy.mock.calls.map((call) => String(call[0]));
    expect(printed.some((line) => line.startsWith('Valid:'))).toBe(true);
    expect(printed).toContain('  What this workflow is for.');
  });

  it('prints nothing extra when the workflow has no description — no synthesized default', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: no-description
name: No Description
version: 1
steps:
  step-one:
    description: a step
    execution: auto
`,
      'utf8',
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const printed = logSpy.mock.calls.map((call) => String(call[0]));
    expect(printed.some((line) => line.startsWith('Valid:'))).toBe(true);
    expect(printed.some((line) => line.startsWith('  '))).toBe(false);
  });
});
