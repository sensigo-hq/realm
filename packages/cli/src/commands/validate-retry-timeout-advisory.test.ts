// Issue A3 — validate advisory: an auto step declaring `retry:` but no `timeout_seconds` warns
// (never rejects) that every attempt is bounded by the generous default execution timeout.
// In-process via commander's parseAsync (same pattern as validate-internal-error.test.ts) — no
// subprocess/dist rebuild needed to observe the console.warn output.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';

describe('validate — retry-without-timeout_seconds advisory (issue A3)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-retry-timeout-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('warns when an auto step declares retry but no timeout_seconds', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: retry-no-timeout
name: Retry No Timeout
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
      'utf8',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const warned = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warned).toContain("Step 'step-one'");
    expect(warned).toContain("declares 'retry' but no 'timeout_seconds'");
    expect(warned).toContain('3600'); // DEFAULT_EXECUTION_TIMEOUT_SECONDS
    expect(logSpy.mock.calls.flat().map(String).join(' ')).toContain('Valid:');
  });

  it('does NOT warn when timeout_seconds is explicitly declared alongside retry', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: retry-with-timeout
name: Retry With Timeout
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    timeout_seconds: 30
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
      'utf8',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn with the A3 text on a step with retry but execution: agent (A3 enforcement never applies there) — issue #218 correction: this exact fixture now legitimately draws the UNRELATED RETRY_INERT_NON_AUTO advisory instead, so the negative assertion is narrowed to the A3-specific text rather than "no warnSpy calls at all"', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: agent-retry
name: Agent Retry
version: 1
steps:
  step-one:
    description: a step
    execution: agent
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 10
`,
      'utf8',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const warned = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warned).not.toContain("declares 'retry' but no 'timeout_seconds'");
    // issue #218: the new advisory legitimately fires on this exact fixture (bare retry on a
    // non-auto step) — pinned here so this test keeps testing what it always tested (A3's
    // absence) without silently going vacuous now that warnSpy IS called for an unrelated reason.
    expect(warned).toContain("'retry' is inert on execution: 'agent' steps");
  });

  it('does NOT warn on an auto step with no retry at all', async () => {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: no-retry
name: No Retry
version: 1
steps:
  step-one:
    description: a step
    execution: auto
`,
      'utf8',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
