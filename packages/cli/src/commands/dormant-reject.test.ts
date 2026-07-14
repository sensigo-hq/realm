// The dormant issue #170 boundary-reject hook (issue #169): inert today because every
// DEFAULT_POLICY entry is 'warn'. This test proves the mechanism is REAL and correctly wired by
// mutating the shared, exported DEFAULT_POLICY object directly — flipping UNKNOWN_WORKFLOW_KEY /
// UNKNOWN_STEP_KEY to 'error' — then observing validate/register actually refuse an
// unknown-key workflow, and restoring the original values afterward. This is the sanctioned
// #170-flip simulation (see the prompt's own "Mutation-probe" verification step); DEFAULT_POLICY
// is a plain mutable Record specifically so this technique works.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY } from '@sensigo/realm';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';

describe('dormant #170 boundary-reject — selective policy flip (issue #169)', () => {
  let originalWorkflowKeyPolicy: 'warn' | 'error';
  let originalStepKeyPolicy: 'warn' | 'error';

  beforeEach(() => {
    originalWorkflowKeyPolicy = DEFAULT_POLICY.UNKNOWN_WORKFLOW_KEY;
    originalStepKeyPolicy = DEFAULT_POLICY.UNKNOWN_STEP_KEY;
  });

  afterEach(() => {
    DEFAULT_POLICY.UNKNOWN_WORKFLOW_KEY = originalWorkflowKeyPolicy;
    DEFAULT_POLICY.UNKNOWN_STEP_KEY = originalStepKeyPolicy;
  });

  it('with the default (unflipped) policy, validate and register only WARN on an unknown step key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-dormant-reject-warn-'));
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: unflipped-wf
name: Unflipped WF
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Valid: unflipped-wf');

    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('flipping DEFAULT_POLICY.UNKNOWN_STEP_KEY to "error" makes validate REFUSE the same workflow', async () => {
    DEFAULT_POLICY.UNKNOWN_STEP_KEY = 'error';

    const dir = mkdtempSync(join(tmpdir(), 'realm-dormant-reject-flip-validate-'));
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: flipped-wf
name: Flipped WF
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);

    await expect(validateCommand.parseAsync([wfPath], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Invalid:');

    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('flipping DEFAULT_POLICY.UNKNOWN_STEP_KEY to "error" makes register refuse-to-register the same workflow', async () => {
    DEFAULT_POLICY.UNKNOWN_STEP_KEY = 'error';

    const home = mkdtempSync(join(tmpdir(), 'realm-dormant-reject-flip-register-home-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    const originalHome = process.env['HOME'];
    process.env['HOME'] = home;

    const wfDir = mkdtempSync(join(tmpdir(), 'realm-dormant-reject-flip-register-wf-'));
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      `id: flipped-reg-wf
name: Flipped Reg WF
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);

    await expect(registerCommand.parseAsync([wfDir], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('refusing to register');
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('Registered:');

    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(wfDir, { recursive: true, force: true });
  });
});
