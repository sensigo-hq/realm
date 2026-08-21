// validate --strict + accumulator tests (issue #169). In-process via commander's parseAsync (same
// pattern as validate-retry-timeout-advisory.test.ts) — no subprocess/dist rebuild needed.
//
// RETIRED ALONGSIDE THIS FILE (issue #170): `dormant-reject.test.ts`. It proved the boundary-reject
// mechanism was real by MUTATING the exported DEFAULT_POLICY in place — flipping the two codes to
// 'error', then restoring them — which was the sanctioned simulation while the flip was dormant.
// The flip has now happened, so that file's "unflipped default only warns" control asserted the
// opposite of reality, and its two flip-simulation cells asserted the default. Both are covered
// here and in register-strict.test.ts by cells that need no shared-module mutation at all, so the
// file went rather than being re-anchored — and the mutation of shared module state went with it.
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
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-strict-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(printed).toContain('Valid: clean-wf v1 (1 steps)');
    expect(printed).not.toContain('warning(s)');
  });

  it('--strict and the DEFAULT policy now agree on an unknown key: the boundary refuses first', async () => {
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
    // ORDERING, and it is the point of this cell post-#170: the policy escalation is checked
    // BEFORE --strict, so an unknown key never reaches the "failing due to --strict" summary any
    // more. The flag is not what refuses this workflow — the default policy is.
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(printed).not.toContain('failing due to --strict');
    const errored = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain('escalated to an error by policy');
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
  });

  it('the refusing boundary does NOT say the key was "ignored" — it was not', async () => {
    // The warning is minted with "— ignored", which is true of the lenient loader and false here.
    // Printed directly above "escalated to an error", it told the author the opposite of what was
    // happening. The did-you-mean fragment — the half that lets them fix it in one edit — stays.
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: ignored-claim-wf
name: Ignored Claim WF
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    dependson: [nothing]
`,
      'utf8',
    );

    await expect(validateCommand.parseAsync([wfPath], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
    expect(warned).not.toContain('ignored');
    expect(warned).toContain('REFUSED below');
    expect(warned).toContain("did you mean 'depends_on'?");
  });

  it('without --strict, an unknown key is now REFUSED by the default policy alone', async () => {
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

    // The #170 flip's headline: no flag, no opt-in, the workflow simply does not validate.
    await expect(validateCommand.parseAsync([wfPath], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(printed).not.toContain('Valid: typo-wf-lenient');
    const errored = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain('escalated to an error by policy');
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
  });
});

describe('validate — double-count guard on the two-pass (extensions) branch (issue #169)', () => {
  let proj: string;
  let workflowDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

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
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
      // This fixture exits 1 either way; we only care about the count below.
    });

    // The cell's purpose is unchanged by #170 — two loader passes must not double-print the same
    // warning. What changed is which line reports the count: the policy escalation refuses before
    // --strict is consulted, so the count is read off the escalation message now.
    const warned: string[] = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const unknownKeyWarnings = warned.filter((line) => line.includes("unknown key 'dependson'"));
    expect(unknownKeyWarnings).toHaveLength(1);

    const errored = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain('Invalid: 1 warning(s) present');
    expect(errored).toContain('escalated to an error by policy');
    // And the refusal is a refusal: no success line is printed alongside it.
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain(
      'Valid: two-pass-wf',
    );
  });
});

describe('validate — accumulator honesty: retry advisory + sentinel + unknown key all counted (issue #169)', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-accumulator-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    // Accumulator honesty is the purpose and it survives: BOTH warnings are counted and both are
    // printed. Post-#170 the count is reported by the escalation message rather than the --strict
    // summary, because the unknown key alone is already an error under the default policy.
    const errored = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain('Invalid: 2 warning(s) present');
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain(
      'Valid: accumulator-wf',
    );
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
    expect(warned).toContain("declares 'retry' but no 'timeout_seconds'");
    // The retry advisory is NOT a flipped code, so its line keeps the lenient wording; only the
    // refused code's "— ignored" is substituted. One render, two different truths.
    expect(warned).toContain('REFUSED below');
  });
});
