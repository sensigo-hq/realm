// Tests for the realm test command's formatTestResults helper.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatTestResults, testCommand } from './test.js';
import type { TestResult } from '@sensigo/realm-testing';

describe('formatTestResults', () => {
  it('returns exit code 0 when all fixtures pass', () => {
    const results: TestResult[] = [
      { name: 'fixture-a', passed: true },
      { name: 'fixture-b', passed: true },
    ];
    const { exitCode } = formatTestResults(results);
    expect(exitCode).toBe(0);
  });

  it('returns exit code 1 when any fixture fails', () => {
    const results: TestResult[] = [
      { name: 'fixture-a', passed: true },
      { name: 'fixture-b', passed: false, error: 'wrong state' },
    ];
    const { exitCode } = formatTestResults(results);
    expect(exitCode).toBe(1);
  });

  it('includes error message in output line for a failed fixture', () => {
    const results: TestResult[] = [
      { name: 'broken-fixture', passed: false, error: 'Expected completed but got failed' },
    ];
    const { lines } = formatTestResults(results);
    expect(lines[0]).toContain('broken-fixture');
    expect(lines[0]).toContain('Expected completed but got failed');
  });

  it('PASS line contains fixture name for a passing fixture', () => {
    const results: TestResult[] = [{ name: 'good-fixture', passed: true }];
    const { lines } = formatTestResults(results);
    expect(lines[0]).toContain('good-fixture');
    expect(lines[0]).toContain('PASS');
  });
});

// issue #425 — the family split at `realm test`. An `Invalid workflow:` message renders verbatim;
// everything else this catch sees keeps its prefix, which is why the split is a split rather than
// the blanket drop that would have stripped it from every fixture-loading failure too.
describe('test — the loader voice (issue #425)', () => {
  let dir: string;
  let fixturesDir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-test-voice-'));
    // `-f` is a requiredOption: without it Commander refuses before the action ever runs, and
    // the cell would assert against an empty spy.
    fixturesDir = mkdtempSync(join(tmpdir(), 'realm-test-voice-fx-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixturesDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('a loader refusal prints verbatim, with no doubled "invalid"', async () => {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(
      file,
      `id: test-voice
name: Test Voice
version: 1
steps:
  a:
    description: a
    execution: agent
    timeout_seconds: 60
`,
      'utf8',
    );

    await expect(
      testCommand.parseAsync([file, '-f', fixturesDir], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain("Invalid workflow: Step 'a': 'timeout_seconds' is not valid");
    expect(errored).not.toContain('Error: Invalid workflow');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('a NON-loader failure keeps its prefix', async () => {
    await expect(
      testCommand.parseAsync([join(dir, 'no-such-file.yaml'), '-f', fixturesDir], {
        from: 'user',
      }),
    ).rejects.toThrow('process.exit');

    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toMatch(/^Error: /m);
    expect(errored).not.toContain('Invalid workflow');
  });
});
