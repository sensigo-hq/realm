// Tests for the realm test command's formatTestResults helper.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

// =================================================================================================
// issue #450 — each loader warning prints exactly once
//
// The CLI loaded the workflow through the PRINTING wrapper, and the fixture runner then loaded
// the same resolved file again — so every warning appeared twice, above a run that then passed.
// The CLI now loads silently, renders once, and hands the definition to the runner.
// =================================================================================================
describe('realm workflow test — one warning, one line (issue #450)', () => {
  let dir: string;
  let fixturesDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const WARNING_WORKFLOW = `id: once-450
name: Once 450
version: 1
frobnicate: true
steps:
  summarise:
    description: summarise
    execution: agent
    retry:
      max_attempts: 2
`;

  const HAPPY_FIXTURE = `name: happy
params: {}
mocks: {}
agent_responses:
  summarise:
    summary: done
expected:
  final_state: completed
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-test-once-'));
    fixturesDir = join(dir, 'fixtures');
    mkdirSync(fixturesDir, { recursive: true });
    writeFileSync(join(fixturesDir, 'happy.yaml'), HAPPY_FIXTURE, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const warnLines = (): string[] =>
    warnSpy.mock.calls.map((c: unknown[]) => String(c[0])) as string[];

  it('C1 each warning line appears exactly once, still worded "— ignored"', async () => {
    writeFileSync(join(dir, 'workflow.yaml'), WARNING_WORKFLOW, 'utf8');

    // `realm workflow test` ALWAYS exits — 0 on success too — so the harness's throwing exit
    // spy fires on the happy path as well. The assertion is the CODE, not the absence of a call.
    await expect(
      testCommand.parseAsync([dir, '-f', fixturesDir], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    const lines = warnLines();
    // BOTH conjuncts are load-bearing, and they catch different mutations. A key-based substring
    // ALSO matches the `— REFUSED below` substituted form, so swapping this print to
    // printLoaderWarnings leaves the COUNT satisfied and reds only on the wording below.
    expect(lines.filter((l: string) => l.includes("unknown key 'frobnicate'"))).toHaveLength(1);
    expect(lines.filter((l: string) => l.includes("'retry' is inert"))).toHaveLength(1);

    // `test` is execution-LENIENT: it proceeds and passes. "REFUSED below" over a passing run
    // would be a false statement about what just happened.
    expect(lines.some((l: string) => l.includes('— ignored'))).toBe(true);
    expect(lines.some((l: string) => l.includes('— REFUSED below'))).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(0); // the fixture passed — the warnings never gate
  }, 20_000);

  it('C4 warnings still print when the extensions load FAILS — placement pin', async () => {
    // The print loop must sit ABOVE the extensions load. The printing wrapper it replaced
    // emitted before extensions loading could throw; a loop moved below would drop every warning
    // on this path, silently.
    writeFileSync(
      join(dir, 'workflow.yaml'),
      `id: once-450-ext
name: Once 450 Ext
version: 1
frobnicate: true
extensions: ./dist/does-not-exist.js
steps:
  summarise:
    description: summarise
    execution: agent
`,
      'utf8',
    );

    await expect(
      testCommand.parseAsync([dir, '-f', fixturesDir], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const lines = warnLines();
    expect(lines.filter((l: string) => l.includes("unknown key 'frobnicate'"))).toHaveLength(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  }, 20_000);

  it('C5 a clean workflow prints no warnings at all', async () => {
    writeFileSync(
      join(dir, 'workflow.yaml'),
      `id: once-450-clean
name: Once 450 Clean
version: 1
steps:
  summarise:
    description: summarise
    execution: agent
`,
      'utf8',
    );

    await expect(
      testCommand.parseAsync([dir, '-f', fixturesDir], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    expect(warnLines().filter((l: string) => l.startsWith('⚠'))).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 20_000);
});
