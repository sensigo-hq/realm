// Issue #524 — the corrected `TOTAL_TIMEOUT_BELOW_ATTEMPT` (W2) render, on the built `validate`
// command. In-process via commander's parseAsync (same pattern as
// validate-retry-timeout-advisory.test.ts — the A3 advisory's own home, not W2's; this is a new
// sibling because no cli/mcp file referenced W2's message before this round).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';

describe('validate — TOTAL_TIMEOUT_BELOW_ATTEMPT (W2) render (issue #524)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-w2-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('an auto step whose cap is at or below its per-attempt timeout renders the corrected text, exit 0', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: w2-render-wf
name: W2 Render
version: 1
steps:
  work:
    description: work
    execution: auto
    timeout_seconds: 100
    retry:
      max_attempts: 3
      total_timeout_seconds: 50
`,
      'utf8',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const warned = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warned).toMatch(/^⚠ /);
    expect(warned).toContain(
      "'retry.total_timeout_seconds: 50' is at or below its per-attempt timeout (100s)",
    );
    expect(warned).toContain('each attempt is bounded by what remains of the cap');
    expect(warned).not.toContain('a retry can never occur before the cap fires'); // the deleted falsity
    expect(logSpy.mock.calls.flat().map(String).join(' ')).toContain('Valid:');
  });

  it('--strict fails the same workflow (a real warning, not a benign notice)', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: w2-render-strict-wf
name: W2 Render Strict
version: 1
steps:
  work:
    description: work
    execution: auto
    timeout_seconds: 100
    retry:
      max_attempts: 3
      total_timeout_seconds: 50
`,
      'utf8',
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);

    await expect(
      validateCommand.parseAsync([wfPath, '--strict'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
