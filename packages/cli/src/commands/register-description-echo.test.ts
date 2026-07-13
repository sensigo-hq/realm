// Issue #144 correction: `realm workflow register` echoes workflow-level `description` on the
// line after `Registered: ...` when present, nothing extra when absent (no synthesized default).
// registerCommand constructs `new JsonWorkflowStore()` with no injectable directory — its default
// resolves via node:os homedir() at construction time (inside the command's own action, not at
// import time), so pointing $HOME at a temp dir before parseAsync isolates it safely (same
// technique as abandon.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCommand } from './register.js';

describe('register — description echo (issue #144 correction)', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-register-description-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('prints the description on the line after Registered: when the workflow declares one', async () => {
    const wfDir = mkdtempSync(join(tmpdir(), 'realm-register-description-wf-'));
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      `id: with-description-reg
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

    await registerCommand.parseAsync([wfDir], { from: 'user' });

    const printed = logSpy.mock.calls.map((call) => String(call[0]));
    expect(printed.some((line) => line.startsWith('Registered:'))).toBe(true);
    expect(printed).toContain('  What this workflow is for.');
    rmSync(wfDir, { recursive: true, force: true });
  });

  it('prints nothing extra when the workflow has no description — no synthesized default', async () => {
    const wfDir = mkdtempSync(join(tmpdir(), 'realm-register-description-wf-'));
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      `id: no-description-reg
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

    await registerCommand.parseAsync([wfDir], { from: 'user' });

    const printed = logSpy.mock.calls.map((call) => String(call[0]));
    expect(printed.some((line) => line.startsWith('Registered:'))).toBe(true);
    expect(printed.some((line) => line.startsWith('  '))).toBe(false);
    rmSync(wfDir, { recursive: true, force: true });
  });
});
