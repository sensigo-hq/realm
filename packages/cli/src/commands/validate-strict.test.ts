// validate --strict + accumulator tests (issue #169). In-process via commander's parseAsync (same
// pattern as validate-retry-timeout-advisory.test.ts) — no subprocess/dist rebuild needed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

describe('validate --strict (issue #169)', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-strict-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('exits 0 and prints normally when --strict is set but there are no warnings', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: clean-wf
name: Clean WF
version: 1
steps:
  step-one:
    description: a step
    execution: auto
`,
      'utf8',
    );

    await validateCommand.parseAsync([wfPath, '--strict'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Valid: clean-wf v1 (1 steps)');
    expect(printed).not.toContain('warning(s)');
  });

  it('exits 1 with a summary line naming the count when --strict is set and warnings are present', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: typo-wf
name: Typo WF
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );

    await expect(
      validateCommand.parseAsync([wfPath, '--strict'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain(
      'Valid: typo-wf v1 (1 steps) — 1 warning(s); failing due to --strict',
    );
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
  });

  it('without --strict, the same warning-bearing workflow exits 0 and still prints the warning', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: typo-wf-lenient
name: Typo WF Lenient
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Valid: typo-wf-lenient v1 (1 steps)');
    expect(printed).not.toContain('warning(s)');
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
  });
});

describe('validate — double-count guard on the two-pass (extensions) branch (issue #169)', () => {
  let proj: string;
  let workflowDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    proj = mkdtempSync(join(tmpdir(), 'realm-validate-double-count-'));
    workflowDir = join(proj, 'workflows', 'wf');
    mkdirSync(join(proj, 'dist'), { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(join(proj, 'dist', 'registry.js'), 'export default {};', 'utf8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('one unknown key on a workflow that declares extensions (two loader passes) is counted/printed exactly once', async () => {
    const wfPath = join(workflowDir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: two-pass-wf
name: Two Pass WF
version: 1
extensions: ../../dist/registry.js
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );

    await validateCommand.parseAsync([wfPath, '--strict'], { from: 'user' }).catch(() => {
      // --strict exits 1 for this fixture; we only care about the count below.
    });

    const warned = warnSpy.mock.calls.map((c) => String(c[0]));
    const unknownKeyWarnings = warned.filter((line) => line.includes("unknown key 'dependson'"));
    expect(unknownKeyWarnings).toHaveLength(1);

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('1 warning(s); failing due to --strict');
  });
});

describe('validate — accumulator honesty: retry advisory + sentinel + unknown key all counted (issue #169)', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-accumulator-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('--strict counts a retry-without-timeout advisory AND an unknown key together (extension-free branch)', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: accumulator-wf
name: Accumulator WF
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
      'utf8',
    );

    await expect(
      validateCommand.parseAsync([wfPath, '--strict'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('2 warning(s); failing due to --strict');
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
    expect(warned).toContain("declares 'retry' but no 'timeout_seconds'");
  });
});
