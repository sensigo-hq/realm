// register --strict tests (issue #169). registerCommand constructs `new JsonWorkflowStore()`
// with no injectable directory — its default resolves via node:os homedir() at construction
// time (inside the command's own action, not at import time), so pointing $HOME at a temp dir
// before parseAsync isolates it safely (same technique as abandon.test.ts /
// register-description-echo.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCommand } from './register.js';

describe('register --strict (issue #169)', () => {
  let home: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-register-strict-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('registers normally and exits 0 when --strict is set but there are no warnings', async () => {
    const wfDir = mkdtempSync(join(tmpdir(), 'realm-register-strict-wf-'));
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      `id: clean-reg
name: Clean Reg
version: 1
steps:
  step-one:
    description: a step
    execution: auto
`,
      'utf8',
    );

    await registerCommand.parseAsync([wfDir, '--strict'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Registered: clean-reg v1 (1 steps)');
    rmSync(wfDir, { recursive: true, force: true });
  });

  it('refuses to register and exits 1 when --strict is set and a warning is present', async () => {
    const wfDir = mkdtempSync(join(tmpdir(), 'realm-register-strict-wf-'));
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      `id: typo-reg
name: Typo Reg
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );

    await expect(registerCommand.parseAsync([wfDir, '--strict'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errored = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errored).toContain('refusing to register due to --strict');
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('Registered:');
    rmSync(wfDir, { recursive: true, force: true });
  });

  it('without --strict, the same warning-bearing workflow registers and still prints the warning', async () => {
    const wfDir = mkdtempSync(join(tmpdir(), 'realm-register-strict-wf-'));
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      `id: typo-reg-lenient
name: Typo Reg Lenient
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );

    await registerCommand.parseAsync([wfDir], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Registered: typo-reg-lenient v1 (1 steps)');
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
    rmSync(wfDir, { recursive: true, force: true });
  });
});
